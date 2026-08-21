/**
 * Streamable HTTP MCP endpoint, dual-era.
 *
 * Revision 2026-07-28 ("modern") dropped the initialize handshake and
 * protocol-level sessions: every request carries its own `_meta` with the
 * protocol version, and selected body fields are mirrored into HTTP headers
 * that the server must validate. Revisions 2025-11-25 and earlier ("legacy")
 * still open with `initialize`.
 *
 * The spec explicitly allows one endpoint to serve both, and which one
 * Claude.ai speaks is not documented, so this server implements both and
 * picks the era from the shape of the incoming request.
 */
import type { Env } from "../env.js";
import { JsonRpcCode, McpError } from "../errors.js";
import { CORS_HEADERS } from "../http.js";
import type { AccessTokenPayload } from "../auth/tokens.js";
import { callTool, toErrorResult, type ToolResult } from "./handlers.js";
import { TOOLS_BY_NAME, toolListPayload } from "./tools.js";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/** What we answer an `initialize` that asks for something we do not know. */
const PREFERRED_LEGACY_VERSION = "2025-06-18";

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const SERVER_INFO = { name: "google-tasks-mcp", version: "1.0.0" };

const INSTRUCTIONS =
  "Read and manage the user's Google Tasks. Resolve list names to ids with " +
  "list_tasklists before calling the other tools. delete_task is permanent — " +
  "prefer complete_task unless deletion was explicitly requested.";

type Era = "modern" | "legacy";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type RequestId = string | number;

// --- response helpers ------------------------------------------------------

function rpcResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(
  id: RequestId | null,
  code: number,
  message: string,
  options: { status?: number; data?: unknown } = {},
): Response {
  const error: Record<string, unknown> = { code, message };
  if (options.data !== undefined) error["data"] = options.data;
  const body: Record<string, unknown> = { jsonrpc: "2.0", error };
  if (id !== null) body["id"] = id;
  return rpcResponse(body, options.status ?? 200);
}

function resultResponse(id: RequestId, era: Era, result: Record<string, unknown>): Response {
  const payload =
    era === "modern"
      ? { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } }
      : result;
  return rpcResponse({ jsonrpc: "2.0", id, result: payload });
}

/** A notification was accepted; the transport requires 202 with no body. */
function acceptedResponse(): Response {
  return new Response(null, { status: 202, headers: CORS_HEADERS });
}

// --- header mirroring ------------------------------------------------------

/** Undo the `=?base64?...?=` sentinel the transport uses for unsafe values. */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    const binary = atob(value.slice("=?base64?".length, -"?=".length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Modern requests mirror `method`, the protocol version and (for tools/call)
 * the tool name into headers so intermediaries can route without parsing the
 * body. The server must reject any disagreement, otherwise a proxy and this
 * worker could act on different values.
 */
function validateMirroredHeaders(
  request: Request,
  method: string,
  version: string,
  params: Record<string, unknown> | null,
): void {
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion === null) {
    throw new McpError(
      JsonRpcCode.HeaderMismatch,
      "Missing required MCP-Protocol-Version header.",
      { httpStatus: 400 },
    );
  }
  if (headerVersion !== version) {
    throw new McpError(
      JsonRpcCode.HeaderMismatch,
      "MCP-Protocol-Version header does not match the protocol version in the request body.",
      { httpStatus: 400 },
    );
  }

  const headerMethod = request.headers.get("mcp-method");
  if (headerMethod === null) {
    throw new McpError(JsonRpcCode.HeaderMismatch, "Missing required Mcp-Method header.", {
      httpStatus: 400,
    });
  }
  if (headerMethod !== method) {
    throw new McpError(
      JsonRpcCode.HeaderMismatch,
      "Mcp-Method header does not match the method in the request body.",
      { httpStatus: 400 },
    );
  }

  if (method !== "tools/call") return;

  const bodyName = params === null ? undefined : params["name"];
  if (typeof bodyName !== "string") return; // reported later as invalid params
  const headerName = request.headers.get("mcp-name");
  if (headerName === null) {
    throw new McpError(
      JsonRpcCode.HeaderMismatch,
      "Missing required Mcp-Name header for tools/call.",
      { httpStatus: 400 },
    );
  }
  if (decodeHeaderValue(headerName) !== bodyName) {
    throw new McpError(
      JsonRpcCode.HeaderMismatch,
      "Mcp-Name header does not match params.name in the request body.",
      { httpStatus: 400 },
    );
  }
}

// --- method dispatch -------------------------------------------------------

async function dispatch(
  env: Env,
  session: AccessTokenPayload,
  era: Era,
  method: string,
  params: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  switch (method) {
    case "server/discover":
      return {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      };

    case "initialize":
      return handleInitialize(params);

    case "ping":
      return {};

    case "tools/list":
      return { tools: toolListPayload() };

    case "tools/call":
      return callToolMethod(env, session, params);

    // Features we do not offer; answering with empty lists keeps clients that
    // probe for them from treating the server as broken.
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };

    default:
      throw new McpError(JsonRpcCode.MethodNotFound, `Unknown method: ${method}`, {
        // Modern transport wants 404 for an unimplemented RPC; legacy clients
        // expect the error inside a 200.
        httpStatus: era === "modern" ? 404 : 200,
      });
  }
}

function handleInitialize(params: Record<string, unknown> | null): Record<string, unknown> {
  const requested = params === null ? undefined : params["protocolVersion"];
  const negotiated =
    typeof requested === "string" &&
    (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PREFERRED_LEGACY_VERSION;

  return {
    protocolVersion: negotiated,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function callToolMethod(
  env: Env,
  session: AccessTokenPayload,
  params: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const name = params === null ? undefined : params["name"];
  if (typeof name !== "string") {
    throw new McpError(JsonRpcCode.InvalidParams, "tools/call requires a string params.name.");
  }
  // An unknown tool is a protocol error, not something the model can retry.
  if (!TOOLS_BY_NAME.has(name)) {
    throw new McpError(JsonRpcCode.InvalidParams, `Unknown tool: ${name}`);
  }

  let outcome: ToolResult;
  try {
    outcome = await callTool(
      { env, sessionId: session.sid },
      name,
      params === null ? undefined : params["arguments"],
    );
  } catch (error) {
    outcome = toErrorResult(error);
  }

  const result: Record<string, unknown> = { content: outcome.content };
  if (outcome.structuredContent !== undefined) {
    result["structuredContent"] = outcome.structuredContent;
  }
  result["isError"] = outcome.isError ?? false;
  return result;
}

// --- entry point -----------------------------------------------------------

/**
 * Handle one POST to the MCP endpoint. The caller has already authenticated
 * the bearer token and passes the session it belongs to.
 */
export async function handleMcpPost(
  env: Env,
  request: Request,
  session: AccessTokenPayload,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(null, JsonRpcCode.ParseError, "Request body is not valid JSON.", {
      status: 400,
    });
  }

  if (Array.isArray(body)) {
    return errorResponse(null, JsonRpcCode.InvalidRequest, "JSON-RPC batching is not supported.", {
      status: 400,
    });
  }
  if (typeof body !== "object" || body === null) {
    return errorResponse(null, JsonRpcCode.InvalidRequest, "Request body must be a JSON object.", {
      status: 400,
    });
  }

  const message = body as JsonRpcMessage;
  const method = message.method;
  if (typeof method !== "string") {
    return errorResponse(null, JsonRpcCode.InvalidRequest, "Missing JSON-RPC method.", {
      status: 400,
    });
  }

  const params =
    typeof message.params === "object" && message.params !== null && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : null;

  const rawId = message.id;
  const id: RequestId | null =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : null;

  // Notifications get no response body at all.
  if (id === null) return acceptedResponse();

  const meta =
    params !== null && typeof params["_meta"] === "object" && params["_meta"] !== null
      ? (params["_meta"] as Record<string, unknown>)
      : null;
  const metaVersion = meta === null ? undefined : meta[META_PROTOCOL_VERSION];

  try {
    const era = detectEra(method, metaVersion);

    if (era === "modern") {
      const version = typeof metaVersion === "string" ? metaVersion : MODERN_PROTOCOL_VERSION;
      if (version !== MODERN_PROTOCOL_VERSION) {
        throw new McpError(
          JsonRpcCode.UnsupportedProtocolVersion,
          "Unsupported protocol version",
          {
            httpStatus: 400,
            data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version },
          },
        );
      }
      // A bare server/discover probe carries no _meta; there is nothing to
      // mirror, so header validation only applies once the client declares
      // its version in the body.
      if (typeof metaVersion === "string") {
        validateMirroredHeaders(request, method, version, params);
      }
    }

    return resultResponse(id, era, await dispatch(env, session, era, method, params));
  } catch (error) {
    if (error instanceof McpError) {
      return errorResponse(id, error.code, error.message, {
        status: error.httpStatus,
        data: error.data,
      });
    }
    return errorResponse(id, JsonRpcCode.InternalError, "Internal server error.");
  }
}

/**
 * Which protocol era this request belongs to.
 *
 * `initialize` is legacy by definition, `server/discover` is modern by
 * definition, and everything else is decided by whether the client declared a
 * protocol version in `_meta`.
 */
function detectEra(method: string, metaVersion: unknown): Era {
  if (method === "initialize") return "legacy";
  if (method === "server/discover") return "modern";
  return typeof metaVersion === "string" ? "modern" : "legacy";
}

/** GET and DELETE are not part of this transport revision. */
export function methodNotAllowedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: JsonRpcCode.InvalidRequest, message: "Use POST for the MCP endpoint." },
    }),
    {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "POST, OPTIONS",
        ...CORS_HEADERS,
      },
    },
  );
}
