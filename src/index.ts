/**
 * Worker entry point and router.
 *
 * Two auth layers meet here but never mix:
 *   /authorize, /token, /register, /.well-known/*  -> Claude authenticates to us
 *   /oauth/google/callback                          -> we authenticate to Google
 *   /mcp                                            -> bearer-protected MCP endpoint
 */
import type { Env } from "./env.js";
import { assertConfigured } from "./env.js";
import { OAuthError, publicMessage } from "./errors.js";
import { json, jsonNoStore, preflight, textError } from "./http.js";
import {
  authenticate,
  authorizationServerMetadata,
  canonicalResource,
  GOOGLE_CALLBACK_PATH,
  handleAuthorize,
  handleGoogleCallback,
  handleRegister,
  handleToken,
  MCP_PATH,
  protectedResourceMetadata,
  unauthorizedResponse,
} from "./auth/mcp-oauth.js";
import { handleMcpPost, methodNotAllowedResponse } from "./mcp/server.js";

/**
 * RFC 9728 allows the metadata document to sit at the bare path or with the
 * resource's path appended. Clients differ, so both are served.
 */
const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource",
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
];

const AUTHORIZATION_SERVER_PATHS = [
  "/.well-known/oauth-authorization-server",
  `/.well-known/oauth-authorization-server${MCP_PATH}`,
  "/.well-known/openid-configuration",
];

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return preflight();

  if (method === "GET" && PROTECTED_RESOURCE_PATHS.includes(path)) {
    return protectedResourceMetadata(env, request);
  }
  if (method === "GET" && AUTHORIZATION_SERVER_PATHS.includes(path)) {
    return authorizationServerMetadata(env, request);
  }

  if (path === "/register") {
    if (method !== "POST") return textError("Use POST.", 405);
    return handleRegister(env, request);
  }
  if (path === "/authorize") {
    if (method !== "GET") return textError("Use GET.", 405);
    return handleAuthorize(env, request);
  }
  if (path === GOOGLE_CALLBACK_PATH) {
    if (method !== "GET") return textError("Use GET.", 405);
    return handleGoogleCallback(env, request);
  }
  if (path === "/token") {
    if (method !== "POST") return textError("Use POST.", 405);
    return handleToken(env, request);
  }

  if (path === MCP_PATH) {
    if (method !== "POST") return methodNotAllowedResponse();

    const auth = await authenticate(env, request);
    if (!auth.ok) return unauthorizedResponse(env, request, auth.reason);
    return handleMcpPost(env, request, auth.token);
  }

  if (path === "/" && method === "GET") {
    // Deliberately says nothing about configuration or connection state:
    // whether an account is connected is not public information.
    return json({
      name: "google-tasks-mcp",
      mcp_endpoint: canonicalResource(env, request),
    });
  }

  return textError("Not found.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      assertConfigured(env);
      response = await route(request, env);
    } catch (error) {
      if (error instanceof OAuthError) {
        response = jsonNoStore(
          { error: error.code, error_description: publicMessage(error) },
          error.httpStatus,
        );
      } else {
        // The message is fixed; the real error is only ever visible in the
        // Worker's own logs, never in the response.
        console.error("unhandled_error", {
          path: url.pathname,
          name: error instanceof Error ? error.name : "unknown",
        });
        response = jsonNoStore({ error: "server_error" }, 500);
      }
    }

    // Request log: method, path, status, duration. Never tokens, never task
    // content, never query strings (they carry codes and state).
    console.log(
      `${request.method} ${url.pathname} ${response.status} ${Date.now() - startedAt}ms`,
    );
    return response;
  },
} satisfies ExportedHandler<Env>;
