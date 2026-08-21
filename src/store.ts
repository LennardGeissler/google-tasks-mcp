/**
 * Typed KV access.
 *
 * Cloudflare KV is eventually consistent, so nothing on the login critical
 * path may depend on reading back a value we just wrote. Only two kinds of
 * data live here:
 *
 *  - the Google refresh token, written once at connect time under a fixed key
 *    and read minutes-to-months later (consistency is a non-issue);
 *  - best-effort markers and counters (used codes, rate limits) where a lost
 *    write degrades gracefully rather than breaking the flow.
 */
import { decryptSecret, encryptSecret, sha256Base64Url } from "./crypto.js";
import type { Env } from "./env.js";

/** Single-user server: exactly one refresh token, so a constant key. */
const REFRESH_TOKEN_KEY = "google:refresh_token";
const CODE_USED_PREFIX = "oauth:code_used:";

/** Authorization codes live 60s; keep the marker well past that. */
const CODE_MARKER_TTL_SECONDS = 600;

export async function saveGoogleRefreshToken(env: Env, refreshToken: string): Promise<void> {
  const encrypted = await encryptSecret(env.ENCRYPTION_KEY, refreshToken);
  await env.TASKS_KV.put(REFRESH_TOKEN_KEY, encrypted);
}

/**
 * Returns the decrypted refresh token, or null if none is stored or the
 * stored blob cannot be decrypted (e.g. ENCRYPTION_KEY was rotated).
 */
export async function loadGoogleRefreshToken(env: Env): Promise<string | null> {
  const encrypted = await env.TASKS_KV.get(REFRESH_TOKEN_KEY);
  if (encrypted === null) return null;
  return decryptSecret(env.ENCRYPTION_KEY, encrypted);
}

/**
 * Enforce single use of an authorization code.
 *
 * Returns true if this is the first redemption. Best-effort: two redemptions
 * racing in different Cloudflare locations can both win, which is why codes
 * also expire after 60 seconds and are bound to a PKCE challenge — an
 * attacker replaying a code still needs the verifier.
 */
export async function claimAuthorizationCode(env: Env, code: string): Promise<boolean> {
  const key = CODE_USED_PREFIX + (await sha256Base64Url(code));
  const seen = await env.TASKS_KV.get(key);
  if (seen !== null) return false;
  await env.TASKS_KV.put(key, "1", { expirationTtl: CODE_MARKER_TTL_SECONDS });
  return true;
}
