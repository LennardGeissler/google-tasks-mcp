/**
 * The /mcp endpoint against both protocol eras: the 2026-07-28 per-request
 * metadata form and the older initialize-based form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { mintAccessToken, newSessionId } from "../src/auth/tokens.js";
import { MODERN_PROTOCOL_VERSION } from "../src/mcp/server.js";
import { resetAccessTokenCache } from "../src/google/tasks-client.js";
import { saveGoogleRefreshToken } from "../src/store.js";
import {
  installFetch,
  jsonResponse,
  TEST_ALLOWED_SUB,
  TEST_ORIGIN,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

let sessionCounter = 0;

beforeEach(() => {
  resetAccessTokenCache();
  sessionCounter += 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function authed(): Promise<{ env: Env; token: string }> {
  const env = testEnv();
  await saveGoogleRefreshToken(env, "stored-refresh-token");
  const token = await mintAccessToken(env.TOKEN_SIGNING_KEY, {
    ci: "client-1",
    aud: `${TEST_ORIGIN}/mcp`,
    sub: TEST_ALLOWED_SUB,
    sid: `session-${sessionCounter}-${newSessionId().slice(0, 8)}`,
  });
  return { env, token };
}

function mockTasksApi(items: unknown[] = []) {
  return installFetch((call: RecordedCall) => {
    if (call.url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "access-token", expires_in: 3599 });
    }
    return jsonResponse({ items });
  });
}

interface RpcOptions {
  headers?: Record<string, string>;
  token?: string | null;
}

async function rpc(
  env: Env,
  body: unknown,
  options: RpcOptions = {},
): Promise<{ status: number; body: Record<string, unknown> | null; response: Response }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.token !== null) headers["authorization"] = `Bearer ${options.token ?? ""}`;

  const response = await worker.fetch(
    new Request(`${TEST_ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>),
    response,
  };
}

/** A well-formed modern request: _meta and the mirrored headers agree. */
function modern(
  method: string,
  params: Record<string, unknown> = {},
): { body: unknown; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params["name"] === "string") {
    headers["mcp-name"] = params["name"];
  }
  return {
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [META_VERSION]: MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    headers,
  };
}

function errorOf(body: Record<string, unknown> | null): Record<string, unknown> {
  return (body?.["error"] ?? {}) as Record<string, unknown>;
}

function resultOf(body: Record<string, unknown> | null): Record<string, unknown> {
  return (body?.["result"] ?? {}) as Record<string, unknown>;
}

describe("authentication on the MCP endpoint", () => {
  it("challenges an unauthenticated request with the resource metadata URL", async () => {
    const env = testEnv();
    const { status, response } = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: null },
    );

    expect(status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      `resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource"`,
    );
  });

  it("rejects GET and DELETE — this transport revision is POST only", async () => {
    const env = testEnv();
    for (const method of ["GET", "DELETE"]) {
      const response = await worker.fetch(
        new Request(`${TEST_ORIGIN}/mcp`, { method }),
        env,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toContain("POST");
    }
  });
});

describe("legacy era (initialize handshake)", () => {
  it("negotiates a protocol version the client asked for", async () => {
    const { env, token } = await authed();
    const { body } = await rpc(
      env,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } },
      },
      { token },
    );

    const result = resultOf(body);
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["serverInfo"]).toMatchObject({ name: "google-tasks-mcp" });
    expect(result["capabilities"]).toMatchObject({ tools: {} });
    // The 2026 envelope must not leak into a legacy response.
    expect(result["resultType"]).toBeUndefined();
  });

  it("falls back to a known version when asked for an unknown one", async () => {
    const { env, token } = await authed();
    const { body } = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      { token },
    );
    expect(resultOf(body)["protocolVersion"]).toBe("2025-06-18");
  });

  it("serves tools/list without any _meta or mirrored headers", async () => {
    const { env, token } = await authed();
    const { body } = await rpc(env, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { token });

    const tools = resultOf(body)["tools"] as { name: string }[];
    expect(tools.map((tool) => tool.name)).toContain("list_tasklists");
    expect(resultOf(body)["resultType"]).toBeUndefined();
  });

  it("answers an unknown method inside a 200, as legacy clients expect", async () => {
    const { env, token } = await authed();
    const { status, body } = await rpc(
      env,
      { jsonrpc: "2.0", id: 3, method: "does/not/exist" },
      { token },
    );
    expect(status).toBe(200);
    expect(errorOf(body)["code"]).toBe(-32601);
  });

  it("accepts notifications with 202 and no body", async () => {
    const { env, token } = await authed();
    const { status, body } = await rpc(
      env,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { token },
    );
    expect(status).toBe(202);
    expect(body).toBeNull();
  });
});

describe("modern era (2026-07-28)", () => {
  it("implements server/discover", async () => {
    const { env, token } = await authed();
    const { body } = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
      { token },
    );

    const result = resultOf(body);
    expect(result["resultType"]).toBe("complete");
    expect(result["supportedVersions"]).toContain(MODERN_PROTOCOL_VERSION);
    expect(result["capabilities"]).toMatchObject({ tools: {} });
  });

  it("wraps results with resultType and serverInfo", async () => {
    const { env, token } = await authed();
    const { body: request, headers } = modern("tools/list");
    const { body } = await rpc(env, request, { token, headers });

    const result = resultOf(body);
    expect(result["resultType"]).toBe("complete");
    expect((result["_meta"] as Record<string, unknown>)[META_SERVER_INFO]).toMatchObject({
      name: "google-tasks-mcp",
    });
  });

  it("rejects a version it does not implement and lists what it does", async () => {
    const { env, token } = await authed();
    const { body: request, headers } = modern("tools/list");
    const body = request as { params: { _meta: Record<string, unknown> } };
    body.params._meta[META_VERSION] = "1900-01-01";

    const outcome = await rpc(env, request, {
      token,
      headers: { ...headers, "mcp-protocol-version": "1900-01-01" },
    });

    expect(outcome.status).toBe(400);
    expect(errorOf(outcome.body)["code"]).toBe(-32022);
    const data = errorOf(outcome.body)["data"] as { supported: string[] };
    expect(data.supported).toContain(MODERN_PROTOCOL_VERSION);
  });

  it("returns 404 with -32601 for an unimplemented method", async () => {
    const { env, token } = await authed();
    const { body: request, headers } = modern("does/not/exist");
    const outcome = await rpc(env, request, { token, headers });

    expect(outcome.status).toBe(404);
    expect(errorOf(outcome.body)["code"]).toBe(-32601);
  });

  describe("mirrored header validation", () => {
    it("rejects a missing MCP-Protocol-Version header", async () => {
      const { env, token } = await authed();
      const { body: request, headers } = modern("tools/list");
      delete headers["mcp-protocol-version"];

      const outcome = await rpc(env, request, { token, headers });
      expect(outcome.status).toBe(400);
      expect(errorOf(outcome.body)["code"]).toBe(-32020);
    });

    it("rejects a header that disagrees with the body", async () => {
      const { env, token } = await authed();
      const { body: request, headers } = modern("tools/list");
      const outcome = await rpc(env, request, {
        token,
        headers: { ...headers, "mcp-method": "tools/call" },
      });

      expect(outcome.status).toBe(400);
      expect(errorOf(outcome.body)["code"]).toBe(-32020);
    });

    it("rejects a tools/call whose Mcp-Name does not match params.name", async () => {
      const { env, token } = await authed();
      mockTasksApi();
      const { body: request, headers } = modern("tools/call", {
        name: "list_tasklists",
        arguments: {},
      });

      const outcome = await rpc(env, request, {
        token,
        headers: { ...headers, "mcp-name": "delete_task" },
      });
      expect(outcome.status).toBe(400);
      expect(errorOf(outcome.body)["code"]).toBe(-32020);
    });

    it("accepts a base64-sentinel encoded Mcp-Name", async () => {
      const { env, token } = await authed();
      mockTasksApi([{ id: "l1", title: "Inbox" }]);
      const { body: request, headers } = modern("tools/call", {
        name: "list_tasklists",
        arguments: {},
      });
      const encoded = `=?base64?${Buffer.from("list_tasklists").toString("base64")}?=`;

      const outcome = await rpc(env, request, {
        token,
        headers: { ...headers, "mcp-name": encoded },
      });
      expect(outcome.status).toBe(200);
      expect(resultOf(outcome.body)["isError"]).toBe(false);
    });
  });
});

describe("tools/call results", () => {
  it("returns content and structuredContent for a successful call", async () => {
    const { env, token } = await authed();
    mockTasksApi([{ id: "l1", title: "Inbox" }]);

    const { body } = await rpc(
      env,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_tasklists", arguments: {} },
      },
      { token },
    );

    const result = resultOf(body);
    expect(result["isError"]).toBe(false);
    expect(result["structuredContent"]).toEqual({ tasklists: [{ id: "l1", title: "Inbox" }] });
    expect((result["content"] as { type: string }[])[0]?.type).toBe("text");
  });

  it("reports a tool failure as isError, not as a JSON-RPC error", async () => {
    const { env, token } = await authed();
    mockTasksApi();

    const { status, body } = await rpc(
      env,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_task", arguments: {} },
      },
      { token },
    );

    expect(status).toBe(200);
    expect(body?.["error"]).toBeUndefined();
    expect(resultOf(body)["isError"]).toBe(true);
  });

  it("treats an unknown tool as a protocol error", async () => {
    const { env, token } = await authed();
    const { body } = await rpc(
      env,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
      { token },
    );
    expect(errorOf(body)["code"]).toBe(-32602);
  });

  it("never returns a stack trace when something unexpected breaks", async () => {
    const { env, token } = await authed();
    installFetch(() => {
      throw new TypeError("network exploded at line 42");
    });

    const { body } = await rpc(
      env,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_tasklists", arguments: {} },
      },
      { token },
    );

    const text = JSON.stringify(body);
    expect(text).not.toContain("line 42");
    expect(text).not.toContain("TypeError");
    expect(resultOf(body)["isError"]).toBe(true);
  });
});

describe("malformed requests", () => {
  it("rejects a body that is not JSON", async () => {
    const { env, token } = await authed();
    const response = await worker.fetch(
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{not json",
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("rejects JSON-RPC batches", async () => {
    const { env, token } = await authed();
    const { status, body } = await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "ping" }], { token });
    expect(status).toBe(400);
    expect(errorOf(body)["code"]).toBe(-32600);
  });

  it("rejects a message without a method", async () => {
    const { env, token } = await authed();
    const { status, body } = await rpc(env, { jsonrpc: "2.0", id: 1 }, { token });
    expect(status).toBe(400);
    expect(errorOf(body)["code"]).toBe(-32600);
  });
});
