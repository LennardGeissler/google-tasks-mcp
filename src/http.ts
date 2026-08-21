/**
 * Small HTTP helpers shared by the OAuth and MCP endpoints.
 */

/**
 * Permissive CORS.
 *
 * Safe here because every protected endpoint authenticates with an
 * `Authorization` header rather than a cookie: a browser on another origin
 * cannot make an authenticated request on the user's behalf. The MCP
 * Inspector runs in a browser and needs this to read the discovery documents.
 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/** JSON that must never be cached — token and metadata responses. */
export function jsonNoStore(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return json(body, status, {
    "cache-control": "no-store",
    pragma: "no-cache",
    ...extraHeaders,
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

/** A plain-text page for failures we must not redirect (untrusted callback). */
export function textError(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Parse an `application/x-www-form-urlencoded` body.
 * The MCP auth spec requires the token endpoint to accept exactly this.
 */
export async function readFormBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    throw new TypeError("expected application/x-www-form-urlencoded");
  }
  return new URLSearchParams(await request.text());
}
