/**
 * Test doubles: an in-memory KV namespace, a fully populated Env, and a
 * fetch mock that records what was sent to Google.
 */
import { vi } from "vitest";
import type { Env } from "../src/env.js";

interface StoredValue {
  value: string;
  expiresAtMs: number | null;
}

export interface MemoryKv {
  namespace: KVNamespace;
  map: Map<string, StoredValue>;
}

/** Enough of the KV API for this worker: get, put with TTL, delete. */
export function memoryKv(): MemoryKv {
  const map = new Map<string, StoredValue>();

  const namespace = {
    async get(key: string): Promise<string | null> {
      const entry = map.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void> {
      const ttl = options?.expirationTtl;
      map.set(key, {
        value,
        expiresAtMs: ttl === undefined ? null : Date.now() + ttl * 1000,
      });
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  } as unknown as KVNamespace;

  return { namespace, map };
}

export const TEST_ALLOWED_SUB = "110000000000000000001";
export const TEST_ORIGIN = "https://tasks.example.workers.dev";

export function testEnv(overrides: Partial<Env> = {}): Env & { __kv: MemoryKv } {
  const kv = memoryKv();
  const env: Env = {
    TASKS_KV: kv.namespace,
    ALLOW_LOCAL_REDIRECT: "false",
    SERVER_BASE_URL: TEST_ORIGIN,
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ALLOWED_GOOGLE_SUB: TEST_ALLOWED_SUB,
    TOKEN_SIGNING_KEY: "unit-test-signing-key-not-a-real-secret",
    ENCRYPTION_KEY: "unit-test-encryption-key-not-a-real-secret",
    ...overrides,
  };
  return Object.assign(env, { __kv: kv });
}

export interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

export interface FetchMock {
  calls: RecordedCall[];
  /** Calls to a URL containing this fragment. */
  callsTo(fragment: string): RecordedCall[];
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** Replace global fetch for the duration of a test. */
export function installFetch(responder: Responder): FetchMock {
  const calls: RecordedCall[] = [];

  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    };
    calls.push(call);
    return responder(call);
  });

  return {
    calls,
    callsTo: (fragment: string) => calls.filter((call) => call.url.includes(fragment)),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A Google id_token is only ever read, never verified, so this suffices. */
export function fakeIdToken(sub: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ sub, iss: "https://accounts.google.com" })}.signature`;
}

/** RFC 7636 appendix B test vector. */
export const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
