/**
 * End-to-end walk through auth layer 1, driving the worker's fetch handler
 * the way Claude would: register, authorize, Google callback, token, refresh.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { CLAUDE_REDIRECT_URI } from "../src/auth/clients.js";
import type { Env } from "../src/env.js";
import {
  fakeIdToken,
  installFetch,
  jsonResponse,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  TEST_ALLOWED_SUB,
  TEST_ORIGIN,
  testEnv,
} from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(env: Env, path: string): Promise<Response> {
  return worker.fetch(new Request(`${TEST_ORIGIN}${path}`), env);
}

function postForm(env: Env, path: string, form: Record<string, string>): Promise<Response> {
  return worker.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
    env,
  );
}

async function registerClient(env: Env): Promise<string> {
  const response = await worker.fetch(
    new Request(`${TEST_ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT_URI],
      }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string; token_endpoint_auth_method: string };
  expect(body.token_endpoint_auth_method).toBe("none");
  return body.client_id;
}

function authorizeUrl(clientId: string, overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
    state: "claude-state",
    resource: `${TEST_ORIGIN}/mcp`,
    ...overrides,
  });
  return `/authorize?${params.toString()}`;
}

/** Runs register -> authorize -> Google callback and returns our code. */
async function obtainAuthorizationCode(env: Env, sub = TEST_ALLOWED_SUB): Promise<string> {
  const clientId = await registerClient(env);

  const authorizeResponse = await get(env, authorizeUrl(clientId));
  expect(authorizeResponse.status).toBe(302);
  const googleUrl = new URL(authorizeResponse.headers.get("location") ?? "");
  expect(googleUrl.host).toBe("accounts.google.com");
  expect(googleUrl.searchParams.get("access_type")).toBe("offline");
  expect(googleUrl.searchParams.get("scope")).toContain(
    "https://www.googleapis.com/auth/tasks",
  );
  const state = googleUrl.searchParams.get("state") ?? "";

  installFetch(() =>
    jsonResponse({
      access_token: "google-access",
      refresh_token: "google-refresh",
      id_token: fakeIdToken(sub),
      expires_in: 3599,
    }),
  );

  const callbackResponse = await get(
    env,
    `/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
  );
  const redirect = new URL(callbackResponse.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();
  return code as string;
}

describe("discovery documents", () => {
  it("advertises this server as its own authorization server", async () => {
    const env = testEnv();
    const response = await get(env, "/.well-known/oauth-protected-resource");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body["resource"]).toBe(`${TEST_ORIGIN}/mcp`);
    expect(body["authorization_servers"]).toEqual([TEST_ORIGIN]);
  });

  it("is also served at the resource-path-suffixed location", async () => {
    const env = testEnv();
    const response = await get(env, "/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
  });

  it("offers S256 only, and no client authentication", async () => {
    const env = testEnv();
    const body = (await (await get(env, "/.well-known/oauth-authorization-server")).json()) as
      Record<string, unknown>;

    expect(body["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(body["token_endpoint_auth_methods_supported"]).toEqual(["none"]);
    expect(body["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
    expect(body["authorization_response_iss_parameter_supported"]).toBe(true);
  });
});

describe("client registration", () => {
  it("refuses redirect URIs that are not on the allowlist", async () => {
    const env = testEnv();
    const response = await worker.fetch(
      new Request(`${TEST_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_redirect_uri");
  });
});

describe("authorize", () => {
  it("refuses an unknown redirect_uri with a page instead of a redirect", async () => {
    const env = testEnv();
    const clientId = await registerClient(env);
    const response = await get(
      env,
      authorizeUrl(clientId, { redirect_uri: "https://evil.example/callback" }),
    );

    expect(response.status).toBe(400);
    // Redirecting here would turn the server into an open redirector.
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects PKCE plain, and a missing challenge, back through the redirect", async () => {
    const env = testEnv();
    const clientId = await registerClient(env);

    for (const overrides of [{ code_challenge_method: "plain" }, { code_challenge: "" }]) {
      const response = await get(env, authorizeUrl(clientId, overrides));
      const location = new URL(response.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("state")).toBe("claude-state");
      expect(location.searchParams.get("iss")).toBe(TEST_ORIGIN);
    }
  });

  it("rejects a response_type other than code", async () => {
    const env = testEnv();
    const clientId = await registerClient(env);
    const response = await get(env, authorizeUrl(clientId, { response_type: "token" }));
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("token endpoint", () => {
  it("exchanges a code with the matching verifier", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);

    const response = await postForm(env, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: PKCE_VERIFIER,
      redirect_uri: CLAUDE_REDIRECT_URI,
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body["token_type"]).toBe("Bearer");
    expect(body["access_token"]).toBeTruthy();
    expect(body["refresh_token"]).toBeTruthy();
    expect(body["expires_in"]).toBe(3600);
  });

  it("requires form encoding, not JSON", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);

    const response = await worker.fetch(
      new Request(`${TEST_ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_request");
  });

  it("rejects a wrong PKCE verifier", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);

    const response = await postForm(env, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: "a".repeat(43),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("invalid_grant");
  });

  it("burns the code after one use", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: PKCE_VERIFIER,
    };

    expect((await postForm(env, "/token", form)).status).toBe(200);
    const replay = await postForm(env, "/token", form);
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error_description: string }).error_description).toContain(
      "already been used",
    );
  });

  it("rejects a redirect_uri that differs from the authorization request", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);

    const response = await postForm(env, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: PKCE_VERIFIER,
      redirect_uri: "https://evil.example/callback",
    });
    expect(response.status).toBe(400);
  });

  it("issues a distinct token pair on the refresh_token grant", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);
    const first = (await (
      await postForm(env, "/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: PKCE_VERIFIER,
      })
    ).json()) as Record<string, string>;

    const refreshed = await postForm(env, "/token", {
      grant_type: "refresh_token",
      refresh_token: first["refresh_token"] ?? "",
    });
    const body = (await refreshed.json()) as Record<string, string>;

    expect(refreshed.status).toBe(200);
    expect(body["access_token"]).toBeTruthy();
    // Distinct credentials even when both are minted within the same second.
    expect(body["access_token"]).not.toBe(first["access_token"]);
    expect(body["refresh_token"]).not.toBe(first["refresh_token"]);
  });

  it("rejects an unknown grant type", async () => {
    const env = testEnv();
    const response = await postForm(env, "/token", { grant_type: "client_credentials" });
    expect((await response.json() as { error: string }).error).toBe("unsupported_grant_type");
  });

  it("refuses to issue tokens once the account is no longer allowlisted", async () => {
    const env = testEnv();
    const code = await obtainAuthorizationCode(env);

    // Same server, allowlist changed between authorization and redemption.
    const locked = testEnv({ ALLOWED_GOOGLE_SUB: "999999999999999999999" });
    locked.__kv.map = env.__kv.map;
    const response = await postForm(locked, "/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: PKCE_VERIFIER,
    });
    expect(response.status).toBe(400);
  });
});

describe("misconfiguration", () => {
  it("fails closed and names the missing secret without printing values", async () => {
    const env = testEnv({ GOOGLE_CLIENT_SECRET: "" });
    const response = await get(env, "/.well-known/oauth-authorization-server");
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toBe("server_error");
  });
});
