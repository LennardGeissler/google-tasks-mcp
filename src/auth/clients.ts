/**
 * Client registration and the redirect-URI allowlist.
 *
 * For a single-user server the redirect URI is the security boundary that
 * matters: an authorization code can only ever be delivered to an address on
 * this list, so a rogue client cannot have one sent to itself. Client ids are
 * therefore not a secret and not stored — they are signed records that carry
 * their own redirect URIs.
 */
import { signPayload, verifyPayload } from "../crypto.js";
import type { Env } from "../env.js";
import { OAuthError } from "../errors.js";

/** Where Claude.ai receives the authorization code. */
export const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** MCP Inspector's loopback callback, only when ALLOW_LOCAL_REDIRECT is on. */
const LOCAL_REDIRECT_URIS = [
  "http://localhost:6274/oauth/callback",
  "http://127.0.0.1:6274/oauth/callback",
];

interface ClientRecord {
  t: "client";
  /** Redirect URIs this client registered, intersected with the allowlist. */
  ru: string[];
  exp: number;
}

export function allowedRedirectUris(env: Env): string[] {
  const allowed = [CLAUDE_REDIRECT_URI];
  if (env.ALLOW_LOCAL_REDIRECT === "true") allowed.push(...LOCAL_REDIRECT_URIS);
  return allowed;
}

/** Exact string match — no prefix matching, no wildcards, no normalisation. */
export function isAllowedRedirectUri(env: Env, redirectUri: string): boolean {
  return allowedRedirectUris(env).includes(redirectUri);
}

/**
 * Resolve `client_id` back to its registered redirect URIs.
 *
 * Unknown / unsigned ids are not an error: the allowlist above already
 * constrains where codes can go, and clients registered against an earlier
 * TOKEN_SIGNING_KEY should not be locked out of re-authorizing.
 */
export async function registeredRedirectUris(env: Env, clientId: string): Promise<string[] | null> {
  const record = await verifyPayload<ClientRecord>(env.TOKEN_SIGNING_KEY, clientId);
  if (record === null || record.t !== "client") return null;
  if (!Array.isArray(record.ru)) return null;
  return record.ru;
}

interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Public client only: we issue no client_secret, so `token_endpoint_auth_method`
 * is "none" and PKCE carries the proof-of-possession.
 */
export async function registerClient(
  env: Env,
  body: unknown,
): Promise<Record<string, unknown>> {
  const request = (body ?? {}) as RegistrationRequest;
  const requested = request.redirect_uris;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array.");
  }

  const accepted = requested.filter(
    (uri): uri is string => typeof uri === "string" && isAllowedRedirectUri(env, uri),
  );
  if (accepted.length === 0) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `None of the requested redirect_uris is allowed. Allowed: ${allowedRedirectUris(env).join(", ")}`,
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const clientId = await signPayload(env.TOKEN_SIGNING_KEY, {
    t: "client",
    ru: accepted,
    exp: issuedAt + 60 * 60 * 24 * 365,
  } satisfies ClientRecord);

  const clientName =
    typeof request.client_name === "string" ? request.client_name : "MCP client";

  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: accepted,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "tasks",
  };
}
