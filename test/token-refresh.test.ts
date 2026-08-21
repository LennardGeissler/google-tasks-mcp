import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthError } from "../src/auth/google.js";
import { TasksClient, resetAccessTokenCache } from "../src/google/tasks-client.js";
import { saveGoogleRefreshToken } from "../src/store.js";
import { installFetch, jsonResponse, testEnv, type RecordedCall } from "./helpers.js";

const TOKEN_URL = "oauth2.googleapis.com/token";
const TASKS_URL = "tasks.googleapis.com";

beforeEach(() => {
  resetAccessTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function envWithGrant(overrides: Parameters<typeof testEnv>[0] = {}) {
  const env = testEnv(overrides);
  await saveGoogleRefreshToken(env, "stored-refresh-token");
  return env;
}

/**
 * Routes the Google token endpoint and the Tasks API separately so a test
 * only has to describe how the Tasks API behaves.
 */
function routeGoogle(options: {
  tasksStatuses: number[];
  expiresIn?: number;
  tokenStatus?: number;
  tokenBody?: unknown;
}) {
  let taskCall = 0;
  return installFetch((call: RecordedCall) => {
    if (call.url.includes(TOKEN_URL)) {
      if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
        return jsonResponse(options.tokenBody ?? { error: "invalid_grant" }, options.tokenStatus);
      }
      return jsonResponse({
        access_token: `access-token-${call.body?.length ?? 0}`,
        expires_in: options.expiresIn ?? 3599,
      });
    }
    if (call.url.includes(TASKS_URL)) {
      const status = options.tasksStatuses[taskCall] ?? 200;
      taskCall += 1;
      if (status === 200) return jsonResponse({ items: [{ id: "l1", title: "Inbox" }] });
      return jsonResponse({ error: { message: "denied" } }, status);
    }
    return new Response("unexpected", { status: 500 });
  });
}

describe("Google access token refresh", () => {
  it("exchanges the stored refresh token for an access token before the first call", async () => {
    const env = await envWithGrant();
    const fetchMock = routeGoogle({ tasksStatuses: [200] });

    await new TasksClient(env).listTaskLists();

    const tokenCalls = fetchMock.callsTo(TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const body = new URLSearchParams(tokenCalls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh-token");
    expect(body.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(body.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);

    const apiCall = fetchMock.callsTo(TASKS_URL)[0];
    expect(apiCall?.headers["authorization"]).toMatch(/^Bearer /);
  });

  it("refreshes and retries exactly once when the API answers 401", async () => {
    const env = await envWithGrant();
    const fetchMock = routeGoogle({ tasksStatuses: [401, 200] });

    const lists = await new TasksClient(env).listTaskLists();

    expect(lists).toEqual([{ id: "l1", title: "Inbox" }]);
    expect(fetchMock.callsTo(TASKS_URL)).toHaveLength(2);
    // One token call to start, one forced by the 401.
    expect(fetchMock.callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it("stops after a second 401 and asks the user to reconnect", async () => {
    const env = await envWithGrant();
    const fetchMock = routeGoogle({ tasksStatuses: [401, 401] });

    const error = await new TasksClient(env).listTaskLists().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).needsReauth).toBe(true);
    // Exactly two attempts — no retry loop against Google's token endpoint.
    expect(fetchMock.callsTo(TASKS_URL)).toHaveLength(2);
  });

  it("reuses the cached access token for later calls", async () => {
    const env = await envWithGrant();
    const fetchMock = routeGoogle({ tasksStatuses: [200, 200] });

    const client = new TasksClient(env);
    await client.listTaskLists();
    await client.listTaskLists();

    expect(fetchMock.callsTo(TASKS_URL)).toHaveLength(2);
    expect(fetchMock.callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it("refreshes again once the cached token is inside the expiry skew", async () => {
    const env = await envWithGrant();
    // 30s lifetime is already inside the 60s skew, so it is never reused.
    const fetchMock = routeGoogle({ tasksStatuses: [200, 200], expiresIn: 30 });

    const client = new TasksClient(env);
    await client.listTaskLists();
    await client.listTaskLists();

    expect(fetchMock.callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it("clears the cached token after the grant is rejected", async () => {
    const env = await envWithGrant();
    routeGoogle({ tasksStatuses: [401, 401] });
    await new TasksClient(env).listTaskLists().catch(() => undefined);
    vi.unstubAllGlobals();

    // A fresh, healthy backend must be re-authorised rather than reusing the
    // token that was just rejected.
    const fetchMock = routeGoogle({ tasksStatuses: [200] });
    await new TasksClient(env).listTaskLists();
    expect(fetchMock.callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it("reports invalid_grant from Google as needing reconnection", async () => {
    const env = await envWithGrant();
    routeGoogle({ tasksStatuses: [200], tokenStatus: 400, tokenBody: { error: "invalid_grant" } });

    const error = await new TasksClient(env).listTaskLists().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).needsReauth).toBe(true);
    expect((error as GoogleAuthError).message).toContain("invalid_grant");
  });

  it("asks for a connection when no refresh token is stored at all", async () => {
    const env = testEnv();
    routeGoogle({ tasksStatuses: [200] });

    const error = await new TasksClient(env).listTaskLists().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).needsReauth).toBe(true);
  });

  it("treats a refresh token it can no longer decrypt as no token at all", async () => {
    const env = await envWithGrant();
    const rotated = testEnv({ ENCRYPTION_KEY: "a-different-encryption-key" });
    // Same KV contents, different key.
    rotated.__kv.map.set(
      "google:refresh_token",
      env.__kv.map.get("google:refresh_token") ?? { value: "", expiresAtMs: null },
    );
    routeGoogle({ tasksStatuses: [200] });

    const error = await new TasksClient(rotated).listTaskLists().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as GoogleAuthError).needsReauth).toBe(true);
  });
});
