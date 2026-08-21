/**
 * Auth layer 1: the OAuth 2.1 authorization server Claude talks to.
 *
 * Implements the subset the MCP authorization spec requires — protected
 * resource metadata (RFC 9728), AS metadata (RFC 8414), dynamic client
 * registration (RFC 7591), an authorization endpoint with mandatory PKCE
 * S256, and a form-urlencoded token endpoint with the authorization_code and
 * refresh_token grants.
 *
 * Google is not an authorization server here; it is the identity check that
 * happens *inside* our authorize step. The two layers never share a token.
 */
import type { Env } from "../env.js";
import { baseUrl } from "../env.js";
import { OAuthError } from "../errors.js";
import { jsonNoStore, readFormBody, redirect, textError } from "../http.js";
import { claimAuthorizationCode, saveGoogleRefreshToken } from "../store.js";
import {
  isAllowedRedirectUri,
  registerClient,
  registeredRedirectUris,
  allowedRedirectUris,
} from "./clients.js";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  GoogleAuthError,
  isAllowedGoogleSub,
  readSubFromIdToken,
  type GoogleTokenResponse,
} from "./google.js";
import { isValidCodeChallenge, verifyCodeChallengeS256 } from "./pkce.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  mintAccessToken,
  mintAuthorizationCode,
  mintGoogleState,
  mintRefreshToken,
  newSessionId,
  readAccessToken,
  readAuthorizationCode,
  readGoogleState,
  readRefreshToken,
  SCOPE,
  type AccessTokenPayload,
} from "./tokens.js";

/** Path Google redirects back to after consent. */
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

/** The MCP endpoint, and the canonical resource identifier for RFC 8707. */
export const MCP_PATH = "/mcp";

export function canonicalResource(env: Env, request: Request): string {
  return `${baseUrl(env, request)}${MCP_PATH}`;
}

// --- discovery -------------------------------------------------------------

/** RFC 9728: tells the client which authorization server protects /mcp. */
export function protectedResourceMetadata(env: Env, request: Request): Response {
  const issuer = baseUrl(env, request);
  return jsonNoStore({
    resource: canonicalResource(env, request),
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/`,
  });
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(env: Env, request: Request): Response {
  const issuer = baseUrl(env, request);
  return jsonNoStore({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    // S256 only. `plain` is deliberately absent.
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });
}

// --- registration ----------------------------------------------------------

export async function handleRegister(env: Env, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new OAuthError("invalid_client_metadata", "Request body must be JSON.");
  }
  return jsonNoStore(await registerClient(env, body), 201);
}

// --- authorize -------------------------------------------------------------

function redirectWithError(
  redirectUri: string,
  state: string | null,
  issuer: string,
  code: string,
  description: string,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  // RFC 9207: identify ourselves on error responses too.
  target.searchParams.set("iss", issuer);
  if (state !== null) target.searchParams.set("state", state);
  return redirect(target.toString());
}

export async function handleAuthorize(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const issuer = baseUrl(env, request);

  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const state = params.get("state");

  // A bad redirect_uri is the one error we must NOT bounce back to the
  // caller — that is exactly how open redirectors are built.
  if (redirectUri === null || !isAllowedRedirectUri(env, redirectUri)) {
    return textError(
      `Unknown redirect_uri. This server only redirects to: ${allowedRedirectUris(env).join(", ")}`,
      400,
    );
  }
  if (clientId === null || clientId.length === 0) {
    return textError("Missing client_id.", 400);
  }

  // If the client registered with us, hold it to its own redirect URIs.
  const registered = await registeredRedirectUris(env, clientId);
  if (registered !== null && !registered.includes(redirectUri)) {
    return textError("redirect_uri was not registered by this client_id.", 400);
  }

  if (params.get("response_type") !== "code") {
    return redirectWithError(
      redirectUri, state, issuer,
      "unsupported_response_type",
      "Only response_type=code is supported.",
    );
  }

  const codeChallenge = params.get("code_challenge");
  if (codeChallenge === null || !isValidCodeChallenge(codeChallenge)) {
    return redirectWithError(
      redirectUri, state, issuer,
      "invalid_request",
      "A valid PKCE code_challenge is required.",
    );
  }
  if (params.get("code_challenge_method") !== "S256") {
    return redirectWithError(
      redirectUri, state, issuer,
      "invalid_request",
      "code_challenge_method must be S256.",
    );
  }

  const googleState = await mintGoogleState(env.TOKEN_SIGNING_KEY, {
    ci: clientId,
    ru: redirectUri,
    cc: codeChallenge,
    cs: state,
    aud: canonicalResource(env, request),
  });

  return redirect(
    buildGoogleAuthorizeUrl(env, `${issuer}${GOOGLE_CALLBACK_PATH}`, googleState),
  );
}

// --- Google callback -------------------------------------------------------

export async function handleGoogleCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const issuer = baseUrl(env, request);

  const stateParam = url.searchParams.get("state");
  if (stateParam === null) return textError("Missing state.", 400);

  const state = await readGoogleState(env.TOKEN_SIGNING_KEY, stateParam);
  if (state === null) {
    return textError("The sign-in link expired or was tampered with. Please start over.", 400);
  }

  const googleError = url.searchParams.get("error");
  if (googleError !== null) {
    return redirectWithError(
      state.ru, state.cs, issuer,
      "access_denied",
      "Google sign-in was cancelled or denied.",
    );
  }

  const code = url.searchParams.get("code");
  if (code === null) {
    return redirectWithError(state.ru, state.cs, issuer, "invalid_request", "Google returned no code.");
  }

  let tokens: GoogleTokenResponse;
  try {
    tokens = await exchangeGoogleCode(env, code, `${issuer}${GOOGLE_CALLBACK_PATH}`);
  } catch (error) {
    return redirectWithError(
      state.ru, state.cs, issuer,
      "server_error",
      error instanceof GoogleAuthError ? error.message : "Could not reach Google.",
    );
  }

  // The allowlist check. Nothing is persisted before it passes.
  const sub = tokens.idToken === null ? null : readSubFromIdToken(tokens.idToken);
  if (sub === null || !isAllowedGoogleSub(env, sub)) {
    return redirectWithError(
      state.ru, state.cs, issuer,
      "access_denied",
      "This Google account is not authorised to use this server.",
    );
  }

  if (tokens.refreshToken === null) {
    return redirectWithError(
      state.ru, state.cs, issuer,
      "server_error",
      "Google issued no refresh token. Remove this app at myaccount.google.com/permissions and try again.",
    );
  }
  await saveGoogleRefreshToken(env, tokens.refreshToken);

  const authorizationCode = await mintAuthorizationCode(env.TOKEN_SIGNING_KEY, {
    ci: state.ci,
    ru: state.ru,
    cc: state.cc,
    aud: state.aud,
    sub,
    sid: newSessionId(),
  });

  const target = new URL(state.ru);
  target.searchParams.set("code", authorizationCode);
  target.searchParams.set("iss", issuer);
  if (state.cs !== null) target.searchParams.set("state", state.cs);
  return redirect(target.toString());
}

// --- token -----------------------------------------------------------------

function tokenError(code: string, description: string, status = 400): Response {
  return jsonNoStore({ error: code, error_description: description }, status);
}

interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(
  env: Env,
  claims: { ci: string; aud: string; sub: string; sid: string },
): Promise<IssuedTokens> {
  const [accessToken, refreshToken] = await Promise.all([
    mintAccessToken(env.TOKEN_SIGNING_KEY, claims),
    mintRefreshToken(env.TOKEN_SIGNING_KEY, claims),
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: SCOPE,
  };
}

export async function handleToken(env: Env, request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readFormBody(request);
  } catch {
    return tokenError(
      "invalid_request",
      "The token endpoint requires application/x-www-form-urlencoded.",
    );
  }

  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(env, form);
  if (grantType === "refresh_token") return exchangeRefreshToken(env, form);
  return tokenError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token.");
}

async function exchangeAuthorizationCode(env: Env, form: URLSearchParams): Promise<Response> {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");
  const clientId = form.get("client_id");

  if (code === null || verifier === null) {
    return tokenError("invalid_request", "code and code_verifier are required.");
  }

  const payload = await readAuthorizationCode(env.TOKEN_SIGNING_KEY, code);
  if (payload === null) {
    return tokenError("invalid_grant", "The authorization code is invalid or has expired.");
  }
  if (clientId !== null && clientId !== payload.ci) {
    return tokenError("invalid_grant", "The authorization code was issued to another client.");
  }
  if (redirectUri !== null && redirectUri !== payload.ru) {
    return tokenError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (!(await verifyCodeChallengeS256(verifier, payload.cc))) {
    return tokenError("invalid_grant", "PKCE verification failed.");
  }
  // Re-check the allowlist: a code minted before the allowlist changed must
  // not still be redeemable.
  if (!isAllowedGoogleSub(env, payload.sub)) {
    return tokenError("invalid_grant", "This account is no longer authorised.");
  }
  if (!(await claimAuthorizationCode(env, code))) {
    return tokenError("invalid_grant", "This authorization code has already been used.");
  }

  return jsonNoStore(
    await issueTokens(env, {
      ci: payload.ci,
      aud: payload.aud,
      sub: payload.sub,
      sid: payload.sid,
    }),
  );
}

async function exchangeRefreshToken(env: Env, form: URLSearchParams): Promise<Response> {
  const token = form.get("refresh_token");
  const clientId = form.get("client_id");
  if (token === null) return tokenError("invalid_request", "refresh_token is required.");

  const payload = await readRefreshToken(env.TOKEN_SIGNING_KEY, token);
  if (payload === null) {
    return tokenError("invalid_grant", "The refresh token is invalid or has expired.");
  }
  if (clientId !== null && clientId !== payload.ci) {
    return tokenError("invalid_grant", "The refresh token was issued to another client.");
  }
  if (!isAllowedGoogleSub(env, payload.sub)) {
    return tokenError("invalid_grant", "This account is no longer authorised.");
  }

  // Rotate: issueTokens always mints a new refresh token as well.
  return jsonNoStore(
    await issueTokens(env, {
      ci: payload.ci,
      aud: payload.aud,
      sub: payload.sub,
      sid: payload.sid,
    }),
  );
}

// --- resource-server side --------------------------------------------------

export type Authentication =
  | { ok: true; token: AccessTokenPayload }
  | { ok: false; reason: string };

/**
 * Validate the bearer token on an MCP request.
 *
 * Beyond signature and expiry this checks the audience (RFC 8707 — a token
 * minted for a different resource must not work here) and re-applies the
 * Google account allowlist on every single call.
 */
export async function authenticate(env: Env, request: Request): Promise<Authentication> {
  const header = request.headers.get("authorization");
  if (header === null) return { ok: false, reason: "Missing bearer token." };

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null || match[1] === undefined) {
    return { ok: false, reason: "Authorization header must use the Bearer scheme." };
  }

  const payload = await readAccessToken(env.TOKEN_SIGNING_KEY, match[1]);
  if (payload === null) return { ok: false, reason: "The access token is invalid or has expired." };

  if (payload.aud !== canonicalResource(env, request)) {
    return { ok: false, reason: "The access token was issued for a different resource." };
  }
  if (!isAllowedGoogleSub(env, payload.sub)) {
    return { ok: false, reason: "This account is not authorised to use this server." };
  }
  return { ok: true, token: payload };
}

/** The RFC 9728 challenge that tells a client where to start the OAuth flow. */
export function unauthorizedResponse(env: Env, request: Request, reason: string): Response {
  const metadataUrl = `${baseUrl(env, request)}/.well-known/oauth-protected-resource`;
  return jsonNoStore({ error: "invalid_token", error_description: reason }, 401, {
    "www-authenticate":
      `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}", error="invalid_token"`,
  });
}
