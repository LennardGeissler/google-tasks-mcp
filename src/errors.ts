/**
 * Error types and the JSON-RPC / OAuth codes we are allowed to emit.
 *
 * Every message that reaches a client goes through `publicMessage()`: errors
 * derived from PublicError carry text written for the caller, everything else
 * collapses to a fixed string, so no stack trace or internal exception
 * message can escape.
 */

/**
 * Base class for errors whose message was written for the caller and is safe
 * to send back. Anything not derived from this is treated as internal.
 */
export abstract class PublicError extends Error {}

/** JSON-RPC 2.0 plus the MCP-reserved codes (-32020..-32099). */
export const JsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP: HTTP headers disagree with the request body. */
  HeaderMismatch: -32020,
  /** MCP: request needs a client capability that was not declared. */
  MissingRequiredClientCapability: -32021,
  /** MCP: server does not implement the requested protocol revision. */
  UnsupportedProtocolVersion: -32022,
} as const;

/**
 * A protocol-level failure: returned as a JSON-RPC error response, optionally
 * with a non-200 HTTP status as required by the Streamable HTTP transport.
 */
export class McpError extends PublicError {
  readonly code: number;
  readonly httpStatus: number;
  readonly data: unknown;

  constructor(
    code: number,
    message: string,
    options: { httpStatus?: number; data?: unknown } = {},
  ) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 200;
    this.data = options.data;
  }
}

/**
 * A tool failed in a way the model can act on (bad input, Google said no).
 * Reported as a successful JSON-RPC result carrying `isError: true`, per the
 * tools spec, so the model can self-correct instead of seeing a hard error.
 */
export class ToolExecutionError extends PublicError {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** An OAuth endpoint failure, rendered as an RFC 6749 error object. */
export class OAuthError extends PublicError {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, description: string, httpStatus = 400) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * The only text we ever hand back to a client.
 *
 * Errors we raised deliberately carry a message written for the caller.
 * Anything else (a TypeError, a KV outage, a JSON parse blowup) collapses to
 * a fixed string so no internal detail or stack trace escapes.
 */
export function publicMessage(error: unknown): string {
  return error instanceof PublicError ? error.message : "Internal server error.";
}
