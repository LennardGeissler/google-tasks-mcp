/**
 * Web Crypto helpers: base64url, HMAC-signed payloads (our OAuth codes and
 * access tokens) and AES-GCM at-rest encryption (the Google refresh token).
 *
 * Both key types are derived from a secret string by hashing it to 32 bytes,
 * so operators can use any high-entropy string (`openssl rand -base64 32`)
 * without worrying about encoding.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Length-independent, branch-free comparison of two ASCII strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Hash both sides first so the comparison itself is always fixed-length and
  // the caller does not leak the expected length through an early return.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(digest);
}

/** SHA-256 of `input`, base64url encoded — the PKCE S256 transformation. */
export async function sha256Base64Url(input: string): Promise<string> {
  return b64urlEncode(await sha256(input));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await sha256(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function aesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await sha256(secret), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Sign an arbitrary JSON payload into a compact `<body>.<signature>` string.
 *
 * These are bearer credentials that we mint and only we verify, so a bespoke
 * format is sufficient — and it keeps the token self-contained, which is what
 * lets the token endpoint work without a (eventually consistent) KV read.
 */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a token produced by `signPayload`.
 * Returns null for anything that is malformed, mis-signed or expired.
 */
export async function verifyPayload<T>(secret: string, token: string): Promise<T | null> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  if (!timingSafeEqual(signature, b64urlEncode(new Uint8Array(expected)))) return null;

  try {
    return JSON.parse(decoder.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

/** AES-GCM encrypt; output is `v1.<iv>.<ciphertext>`, both base64url. */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

/** Reverse of `encryptSecret`. Returns null if the blob is not ours. */
export async function decryptSecret(secret: string, blob: string): Promise<string | null> {
  const parts = blob.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, ivPart, ciphertextPart] = parts;
  if (ivPart === undefined || ciphertextPart === undefined) return null;

  try {
    const key = await aesKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivPart) },
      key,
      b64urlDecode(ciphertextPart),
    );
    return decoder.decode(plaintext);
  } catch {
    // Wrong key or tampered ciphertext — indistinguishable on purpose.
    return null;
  }
}

/** A URL-safe random identifier with 256 bits of entropy. */
export function randomId(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
