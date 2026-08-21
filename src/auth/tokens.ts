/**
 * The credentials this server mints for Claude (auth layer 1).
 *
 * Every one of them is a self-contained HMAC-signed payload rather than an
 * opaque handle in KV. That is a deliberate choice: KV is eventually
 * consistent, and an authorization code written in one Cloudflare location
 * is not guaranteed to be readable from the location that serves the token
 * request seconds later. Signed tokens verify anywhere, immediately.
 *
 * These tokens never carry Google credentials. They only identify the
 * session; the Google refresh token stays encrypted in KV.
 */
import { randomId, signPayload, verifyPayload } from "../crypto.js";

export const SCOPE = "tasks";

export const CODE_TTL_SECONDS = 60;
export const GOOGLE_STATE_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

interface BasePayload {
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** Round-trips our own authorize request through Google's consent screen. */
export interface GoogleStatePayload extends BasePayload {
  t: "gstate";
  /** Claude's client_id. */
  ci: string;
  /** Claude's redirect_uri, already validated against the allowlist. */
  ru: string;
  /** Claude's PKCE code_challenge (S256). */
  cc: string;
  /** Claude's `state`, echoed back verbatim. Null when it sent none. */
  cs: string | null;
  /** RFC 8707 resource indicator, normalised to our canonical URI. */
  aud: string;
}

/** Handed to Claude's redirect_uri; redeemed once at the token endpoint. */
export interface AuthorizationCodePayload extends BasePayload {
  t: "code";
  ci: string;
  ru: string;
  cc: string;
  aud: string;
  /** Google account this code was issued for; re-checked on every call. */
  sub: string;
  /** Session id, carried into the access token for rate limiting. */
  sid: string;
}

export interface AccessTokenPayload extends BasePayload {
  t: "access";
  ci: string;
  aud: string;
  sub: string;
  sid: string;
  scope: string;
  /** Unique per issuance, so two tokens minted in the same second differ. */
  jti: string;
}

export interface RefreshTokenPayload extends BasePayload {
  t: "refresh";
  ci: string;
  aud: string;
  sub: string;
  sid: string;
  scope: string;
  jti: string;
}

type AnyPayload =
  | GoogleStatePayload
  | AuthorizationCodePayload
  | AccessTokenPayload
  | RefreshTokenPayload;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function newSessionId(): string {
  return randomId();
}

async function mint<T extends AnyPayload>(
  key: string,
  payload: Omit<T, "exp">,
  ttlSeconds: number,
): Promise<string> {
  return signPayload(key, { ...payload, exp: nowSeconds() + ttlSeconds });
}

/**
 * Verify signature, expiry and discriminator in one step.
 * Returns null on any mismatch — callers must not distinguish the reasons.
 */
async function open<T extends AnyPayload>(
  key: string,
  token: string,
  type: T["t"],
): Promise<T | null> {
  const payload = await verifyPayload<T>(key, token);
  if (payload === null) return null;
  if (payload.t !== type) return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds()) return null;
  return payload;
}

export function mintGoogleState(
  key: string,
  payload: Omit<GoogleStatePayload, "exp" | "t">,
): Promise<string> {
  return mint<GoogleStatePayload>(key, { ...payload, t: "gstate" }, GOOGLE_STATE_TTL_SECONDS);
}

export function readGoogleState(key: string, token: string): Promise<GoogleStatePayload | null> {
  return open<GoogleStatePayload>(key, token, "gstate");
}

export function mintAuthorizationCode(
  key: string,
  payload: Omit<AuthorizationCodePayload, "exp" | "t">,
): Promise<string> {
  return mint<AuthorizationCodePayload>(key, { ...payload, t: "code" }, CODE_TTL_SECONDS);
}

export function readAuthorizationCode(
  key: string,
  token: string,
): Promise<AuthorizationCodePayload | null> {
  return open<AuthorizationCodePayload>(key, token, "code");
}

export function mintAccessToken(
  key: string,
  payload: Omit<AccessTokenPayload, "exp" | "t" | "scope" | "jti">,
): Promise<string> {
  return mint<AccessTokenPayload>(
    key,
    { ...payload, t: "access", scope: SCOPE, jti: randomId() },
    ACCESS_TOKEN_TTL_SECONDS,
  );
}

export function readAccessToken(key: string, token: string): Promise<AccessTokenPayload | null> {
  return open<AccessTokenPayload>(key, token, "access");
}

/**
 * Refresh tokens are unique per issuance but not revocable: a stateless
 * server has nowhere to record that an older one was superseded, and putting
 * that record in KV would make sign-in depend on a read-after-write that KV
 * does not guarantee. Every issued refresh token therefore stays usable until
 * it expires. To cut all of them off at once, rotate TOKEN_SIGNING_KEY.
 */
export function mintRefreshToken(
  key: string,
  payload: Omit<RefreshTokenPayload, "exp" | "t" | "scope" | "jti">,
): Promise<string> {
  return mint<RefreshTokenPayload>(
    key,
    { ...payload, t: "refresh", scope: SCOPE, jti: randomId() },
    REFRESH_TOKEN_TTL_SECONDS,
  );
}

export function readRefreshToken(key: string, token: string): Promise<RefreshTokenPayload | null> {
  return open<RefreshTokenPayload>(key, token, "refresh");
}
