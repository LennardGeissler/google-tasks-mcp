/**
 * Auth layer 2: this server against Google.
 *
 * Completely separate from the tokens we issue to Claude. A Google token
 * never leaves this module's callers, and Claude never sees one.
 */
import { b64urlDecode, timingSafeEqual } from "../crypto.js";
import type { Env } from "../env.js";
import { PublicError } from "../errors.js";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** `openid` is what makes Google return an id_token carrying `sub`. */
export const GOOGLE_SCOPES = "openid https://www.googleapis.com/auth/tasks";

/**
 * A failure talking to Google. `needsReauth` means the stored grant is gone
 * for good (revoked, expired, or the OAuth client changed) and the user has
 * to reconnect the connector — retrying will not help.
 */
export class GoogleAuthError extends PublicError {
  readonly needsReauth: boolean;

  constructor(message: string, needsReauth = false) {
    super(message);
    this.name = "GoogleAuthError";
    this.needsReauth = needsReauth;
  }
}

export interface GoogleTokenResponse {
  accessToken: string;
  /** Only present on the initial code exchange, not on refreshes. */
  refreshToken: string | null;
  idToken: string | null;
  expiresInSeconds: number;
}

/** URL of Google's consent screen for our single required scope set. */
export function buildGoogleAuthorizeUrl(
  env: Env,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", state);
  // offline + consent guarantee a refresh token even on repeat authorizations.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

async function postToGoogleToken(body: URLSearchParams): Promise<RawTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  let parsed: RawTokenResponse;
  try {
    parsed = (await response.json()) as RawTokenResponse;
  } catch {
    throw new GoogleAuthError("Google returned an unreadable token response.");
  }

  if (!response.ok) {
    // `error` is a short OAuth code such as invalid_grant — safe to surface,
    // unlike error_description which can echo request contents.
    const code = typeof parsed.error === "string" ? parsed.error : "unknown_error";
    const needsReauth = code === "invalid_grant" || code === "invalid_client";
    throw new GoogleAuthError(`Google rejected the token request (${code}).`, needsReauth);
  }
  return parsed;
}

function toTokenResponse(raw: RawTokenResponse): GoogleTokenResponse {
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new GoogleAuthError("Google's token response contained no access token.");
  }
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
    idToken: typeof raw.id_token === "string" ? raw.id_token : null,
    expiresInSeconds: typeof raw.expires_in === "number" ? raw.expires_in : 3600,
  };
}

/** Exchange the one-time code from Google's redirect for tokens. */
export async function exchangeGoogleCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return toTokenResponse(await postToGoogleToken(body));
}

/** Trade the stored refresh token for a fresh access token. */
export async function refreshGoogleAccessToken(
  env: Env,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  return toTokenResponse(await postToGoogleToken(body));
}

/**
 * Read the `sub` claim out of an id_token.
 *
 * The signature is not verified, and does not need to be: the token was just
 * received over TLS directly from Google's token endpoint in response to our
 * authenticated request. That is the exception OpenID Connect Core 3.1.3.7
 * explicitly allows. This function must never be used on an id_token that
 * arrived by any other route.
 */
export function readSubFromIdToken(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (payloadPart === undefined) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadPart))) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * Placeholder value for ALLOWED_GOOGLE_SUB during first-time setup.
 *
 * There is no way to look up your own Google account id without completing an
 * OAuth flow, so the server offers one: with this sentinel configured, the
 * callback reports the id of whoever just signed in and stores nothing. It is
 * safe for a stranger to hit — they only ever learn their own id — but the
 * server is unusable until a real id is configured.
 */
export const SETUP_SENTINEL = "SETUP";

export function isSetupMode(env: Env): boolean {
  return env.ALLOWED_GOOGLE_SUB.trim() === SETUP_SENTINEL;
}

/**
 * The allowlist. Exactly one Google account may ever use this server; every
 * other identity is refused before any token is stored.
 */
export function isAllowedGoogleSub(env: Env, sub: string | null): boolean {
  if (sub === null || sub.length === 0) return false;
  const allowed = env.ALLOWED_GOOGLE_SUB.trim();
  if (allowed.length === 0) return false;
  // Setup mode grants nobody access, including an account literally named
  // "SETUP".
  if (allowed === SETUP_SENTINEL) return false;
  return timingSafeEqual(sub, allowed);
}
