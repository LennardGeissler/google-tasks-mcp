import { describe, expect, it } from "vitest";
import {
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyCodeChallengeS256,
} from "../src/auth/pkce.js";
import { PKCE_CHALLENGE, PKCE_VERIFIER } from "./helpers.js";

describe("PKCE S256", () => {
  it("accepts the RFC 7636 test vector", async () => {
    await expect(verifyCodeChallengeS256(PKCE_VERIFIER, PKCE_CHALLENGE)).resolves.toBe(true);
  });

  it("rejects a verifier that does not hash to the challenge", async () => {
    const wrong = PKCE_VERIFIER.replace(/^d/, "e");
    await expect(verifyCodeChallengeS256(wrong, PKCE_CHALLENGE)).resolves.toBe(false);
  });

  it("rejects verifiers outside the 43..128 character range", () => {
    expect(isValidCodeVerifier("tooshort")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
  });

  it("rejects verifiers with characters outside the unreserved set", () => {
    expect(isValidCodeVerifier(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}/`)).toBe(false);
  });

  it("rejects a malformed challenge without hashing", async () => {
    expect(isValidCodeChallenge("short")).toBe(false);
    await expect(verifyCodeChallengeS256(PKCE_VERIFIER, "short")).resolves.toBe(false);
  });
});
