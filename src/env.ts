/**
 * Bindings available to the Worker.
 *
 * `vars` come from wrangler.toml and are public. Everything under "secrets"
 * is provided by `wrangler secret put` in production and by the git-ignored
 * .dev.vars file locally — never from wrangler.toml.
 */
export interface Env {
  /** KV namespace holding the encrypted Google refresh token + rate counters. */
  TASKS_KV: KVNamespace;

  // --- vars (public, wrangler.toml) ---
  /** "true" additionally allows the MCP Inspector loopback redirect URI. */
  ALLOW_LOCAL_REDIRECT: string;
  /** Optional pinned public origin; empty means "derive from the request". */
  SERVER_BASE_URL: string;

  // --- secrets ---
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** The one Google account (`sub` claim) allowed to use this server. */
  ALLOWED_GOOGLE_SUB: string;
  /** HMAC key for our own authorization codes and access tokens. */
  TOKEN_SIGNING_KEY: string;
  /** AES-GCM key for the Google refresh token at rest in KV. */
  ENCRYPTION_KEY: string;
}

const REQUIRED_SECRETS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_GOOGLE_SUB",
  "TOKEN_SIGNING_KEY",
  "ENCRYPTION_KEY",
] as const satisfies readonly (keyof Env)[];

/**
 * Fails fast with a message that names the missing binding but never prints
 * any value.
 */
export function assertConfigured(env: Env): void {
  const missing = REQUIRED_SECRETS.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Server is misconfigured: missing secret(s) ${missing.join(", ")}`);
  }
}

/** Public origin of this worker, without a trailing slash. */
export function baseUrl(env: Env, request: Request): string {
  const pinned = env.SERVER_BASE_URL.trim();
  if (pinned.length > 0) return pinned.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
