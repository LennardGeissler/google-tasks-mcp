import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedGoogleSub, readSubFromIdToken } from "../src/auth/google.js";
import { authenticate, handleGoogleCallback } from "../src/auth/mcp-oauth.js";
import { CLAUDE_REDIRECT_URI } from "../src/auth/clients.js";
import { mintAccessToken, mintGoogleState, newSessionId } from "../src/auth/tokens.js";
import {
  fakeIdToken,
  installFetch,
  jsonResponse,
  PKCE_CHALLENGE,
  TEST_ALLOWED_SUB,
  TEST_ORIGIN,
  testEnv,
} from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OTHER_SUB = "220000000000000000002";

async function callbackFor(env: ReturnType<typeof testEnv>, sub: string | null) {
  const state = await mintGoogleState(env.TOKEN_SIGNING_KEY, {
    ci: "client-1",
    ru: CLAUDE_REDIRECT_URI,
    cc: PKCE_CHALLENGE,
    cs: "claude-state",
    aud: `${TEST_ORIGIN}/mcp`,
  });

  installFetch(() =>
    jsonResponse({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      id_token: sub === null ? undefined : fakeIdToken(sub),
      expires_in: 3599,
    }),
  );

  return handleGoogleCallback(
    env,
    new Request(`${TEST_ORIGIN}/oauth/google/callback?code=google-code&state=${state}`),
  );
}

describe("isAllowedGoogleSub", () => {
  it("accepts exactly the configured account", () => {
    const env = testEnv();
    expect(isAllowedGoogleSub(env, TEST_ALLOWED_SUB)).toBe(true);
  });

  it("rejects any other account, a missing sub, and an empty allowlist", () => {
    const env = testEnv();
    expect(isAllowedGoogleSub(env, OTHER_SUB)).toBe(false);
    expect(isAllowedGoogleSub(env, "")).toBe(false);
    expect(isAllowedGoogleSub(env, null)).toBe(false);
    expect(isAllowedGoogleSub(testEnv({ ALLOWED_GOOGLE_SUB: "  " }), TEST_ALLOWED_SUB)).toBe(false);
  });

  it("does not accept a sub that merely starts with the allowed value", () => {
    const env = testEnv();
    expect(isAllowedGoogleSub(env, `${TEST_ALLOWED_SUB}9`)).toBe(false);
  });
});

describe("readSubFromIdToken", () => {
  it("extracts the sub claim", () => {
    expect(readSubFromIdToken(fakeIdToken(TEST_ALLOWED_SUB))).toBe(TEST_ALLOWED_SUB);
  });

  it("returns null for anything that is not a three-part JWT", () => {
    expect(readSubFromIdToken("not-a-jwt")).toBeNull();
    expect(readSubFromIdToken("a.b")).toBeNull();
    expect(readSubFromIdToken("a.!!!.c")).toBeNull();
  });
});

describe("Google callback", () => {
  it("issues a code and stores the refresh token for the allowed account", async () => {
    const env = testEnv();
    const response = await callbackFor(env, TEST_ALLOWED_SUB);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT_URI);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("claude-state");
    expect(location.searchParams.get("iss")).toBe(TEST_ORIGIN);
    expect(location.searchParams.get("error")).toBeNull();

    const stored = env.__kv.map.get("google:refresh_token");
    expect(stored).toBeDefined();
    // At rest it must be ciphertext, never the token itself.
    expect(stored?.value).toMatch(/^v1\./);
    expect(stored?.value).not.toContain("google-refresh-token");
  });

  it("refuses a different Google account and stores nothing", async () => {
    const env = testEnv();
    const response = await callbackFor(env, OTHER_SUB);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    expect(env.__kv.map.size).toBe(0);
  });

  it("refuses when Google returns no id_token, so no sub can be checked", async () => {
    const env = testEnv();
    const response = await callbackFor(env, null);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(env.__kv.map.size).toBe(0);
  });

  it("rejects a tampered state without redirecting anywhere", async () => {
    const env = testEnv();
    const response = await handleGoogleCallback(
      env,
      new Request(`${TEST_ORIGIN}/oauth/google/callback?code=x&state=forged.signature`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("bearer token authentication", () => {
  async function tokenFor(env: ReturnType<typeof testEnv>, sub: string, aud: string) {
    return mintAccessToken(env.TOKEN_SIGNING_KEY, {
      ci: "client-1",
      aud,
      sub,
      sid: newSessionId(),
    });
  }

  function mcpRequest(token: string): Request {
    return new Request(`${TEST_ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("accepts a token for the allowed account and this resource", async () => {
    const env = testEnv();
    const token = await tokenFor(env, TEST_ALLOWED_SUB, `${TEST_ORIGIN}/mcp`);
    await expect(authenticate(env, mcpRequest(token))).resolves.toMatchObject({ ok: true });
  });

  it("re-applies the allowlist on every call, not just at login", async () => {
    const env = testEnv();
    const token = await tokenFor(env, OTHER_SUB, `${TEST_ORIGIN}/mcp`);
    const result = await authenticate(env, mcpRequest(token));
    expect(result.ok).toBe(false);
  });

  it("rejects a token minted for a different resource", async () => {
    const env = testEnv();
    const token = await tokenFor(env, TEST_ALLOWED_SUB, "https://elsewhere.example/mcp");
    const result = await authenticate(env, mcpRequest(token));
    expect(result.ok).toBe(false);
  });

  it("rejects a token signed with a different key", async () => {
    const attacker = testEnv({ TOKEN_SIGNING_KEY: "some-other-key" });
    const token = await tokenFor(attacker, TEST_ALLOWED_SUB, `${TEST_ORIGIN}/mcp`);
    const result = await authenticate(testEnv(), mcpRequest(token));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or non-Bearer Authorization header", async () => {
    const env = testEnv();
    await expect(
      authenticate(env, new Request(`${TEST_ORIGIN}/mcp`, { method: "POST" })),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      authenticate(
        env,
        new Request(`${TEST_ORIGIN}/mcp`, {
          method: "POST",
          headers: { authorization: "Basic abc" },
        }),
      ),
    ).resolves.toMatchObject({ ok: false });
  });
});
