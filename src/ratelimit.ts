/**
 * Per-session rate limiting.
 *
 * The point is not to stop an attacker — the allowlist does that — but to put
 * a floor under a model that misreads an instruction and starts deleting a
 * task list one call at a time. Deletes get the tightest budget.
 *
 * Counters live in KV, which is eventually consistent, so this is best-effort
 * across Cloudflare locations. For a single user whose traffic lands in one
 * location it is accurate in practice, and being approximate is acceptable
 * for a backstop that only has to catch runaway loops.
 */
import type { Env } from "./env.js";
import { ToolExecutionError } from "./errors.js";

export type RateLimitBucket = "all" | "write" | "delete";

/** Calls allowed per bucket per 60-second window. */
export const LIMITS: Record<RateLimitBucket, number> = {
  all: 60,
  write: 20,
  delete: 5,
};

const WINDOW_SECONDS = 60;

/** KV's minimum TTL is 60s; two windows keeps a counter alive long enough. */
const COUNTER_TTL_SECONDS = WINDOW_SECONDS * 2;

function windowIndex(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
}

function counterKey(sessionId: string, bucket: RateLimitBucket): string {
  return `rl:${sessionId}:${bucket}:${windowIndex()}`;
}

async function bump(env: Env, sessionId: string, bucket: RateLimitBucket): Promise<void> {
  const key = counterKey(sessionId, bucket);
  const current = Number.parseInt((await env.TASKS_KV.get(key)) ?? "0", 10);
  const next = Number.isFinite(current) ? current + 1 : 1;

  if (next > LIMITS[bucket]) {
    throw new ToolExecutionError(
      `Rate limit reached: at most ${LIMITS[bucket]} ${describe(bucket)} per minute. ` +
        `Wait a minute before continuing, and check this is really what the user asked for.`,
    );
  }
  await env.TASKS_KV.put(key, String(next), { expirationTtl: COUNTER_TTL_SECONDS });
}

function describe(bucket: RateLimitBucket): string {
  switch (bucket) {
    case "all":
      return "tool calls";
    case "write":
      return "changes";
    case "delete":
      return "deletions";
  }
}

/**
 * Charge one call against every bucket that applies.
 *
 * Callers pass the most restrictive bucket first: a delete that exceeds the
 * delete budget then throws before it has consumed the write or overall
 * budget as well.
 */
export async function enforceRateLimit(
  env: Env,
  sessionId: string,
  buckets: readonly RateLimitBucket[],
): Promise<void> {
  for (const bucket of buckets) {
    await bump(env, sessionId, bucket);
  }
}
