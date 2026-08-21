import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionError } from "../src/errors.js";
import { enforceRateLimit, LIMITS } from "../src/ratelimit.js";
import { testEnv } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const DELETE_BUCKETS = ["delete", "write", "all"] as const;
const WRITE_BUCKETS = ["write", "all"] as const;
const READ_BUCKETS = ["all"] as const;

describe("per-session rate limiting", () => {
  it("allows exactly the configured number of deletions per minute", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.delete; i += 1) {
      await expect(enforceRateLimit(env, "s1", DELETE_BUCKETS)).resolves.toBeUndefined();
    }
    await expect(enforceRateLimit(env, "s1", DELETE_BUCKETS)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("explains which budget ran out", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.delete; i += 1) {
      await enforceRateLimit(env, "s1", DELETE_BUCKETS);
    }
    const error = await enforceRateLimit(env, "s1", DELETE_BUCKETS).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("deletions per minute");
  });

  it("does not charge the write budget for a deletion it already refused", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.delete + 3; i += 1) {
      await enforceRateLimit(env, "s1", DELETE_BUCKETS).catch(() => undefined);
    }

    const writeCounter = [...env.__kv.map.entries()].find(([key]) => key.includes(":write:"));
    expect(Number(writeCounter?.[1].value)).toBe(LIMITS.delete);
  });

  it("still allows non-destructive writes after the delete budget is gone", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.delete + 1; i += 1) {
      await enforceRateLimit(env, "s1", DELETE_BUCKETS).catch(() => undefined);
    }
    await expect(enforceRateLimit(env, "s1", WRITE_BUCKETS)).resolves.toBeUndefined();
  });

  it("caps writes and overall calls independently", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.write; i += 1) {
      await enforceRateLimit(env, "s1", WRITE_BUCKETS);
    }
    await expect(enforceRateLimit(env, "s1", WRITE_BUCKETS)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    // Reads have their own, larger budget and are unaffected.
    await expect(enforceRateLimit(env, "s1", READ_BUCKETS)).resolves.toBeUndefined();
  });

  it("caps the overall number of calls", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.all; i += 1) {
      await enforceRateLimit(env, "s1", READ_BUCKETS);
    }
    await expect(enforceRateLimit(env, "s1", READ_BUCKETS)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("keeps sessions independent", async () => {
    const env = testEnv();
    for (let i = 0; i < LIMITS.delete; i += 1) {
      await enforceRateLimit(env, "s1", DELETE_BUCKETS);
    }
    await expect(enforceRateLimit(env, "s2", DELETE_BUCKETS)).resolves.toBeUndefined();
  });

  it("recovers in the next minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T10:00:00.000Z"));

    const env = testEnv();
    for (let i = 0; i < LIMITS.delete; i += 1) {
      await enforceRateLimit(env, "s1", DELETE_BUCKETS);
    }
    await expect(enforceRateLimit(env, "s1", DELETE_BUCKETS)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );

    vi.setSystemTime(new Date("2026-08-21T10:01:00.000Z"));
    await expect(enforceRateLimit(env, "s1", DELETE_BUCKETS)).resolves.toBeUndefined();
  });
});
