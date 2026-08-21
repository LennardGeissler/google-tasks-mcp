/**
 * PKCE (RFC 7636). S256 only — `plain` is rejected outright, as OAuth 2.1
 * and the MCP authorization spec require.
 */
import { sha256Base64Url, timingSafeEqual } from "../crypto.js";

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/**
 * True when `verifier` is the S256 pre-image of `challenge`.
 * A malformed verifier fails without hashing.
 */
export async function verifyCodeChallengeS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  return timingSafeEqual(await sha256Base64Url(verifier), challenge);
}
