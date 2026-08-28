# google-tasks-mcp

A remote MCP server that exposes Google Tasks as a custom connector in
Claude.ai. Runs on Cloudflare Workers, reachable over Streamable HTTP, and is
locked to **exactly one** Google account.

## Tools

| Tool | Parameters | Annotations |
|---|---|---|
| `list_tasklists` | – | `readOnlyHint` |
| `list_tasks` | `tasklist_id`, `show_completed`, `due_after`, `due_before` | `readOnlyHint` |
| `create_task` | `title`, `notes`, `due`, `tasklist_id` | – |
| `update_task` | `task_id`, `tasklist_id`, `title`, `notes`, `due`, `status` | `idempotentHint` |
| `complete_task` | `task_id`, `tasklist_id` | `idempotentHint` |
| `delete_task` | `task_id`, `tasklist_id` | **`destructiveHint`** |

Dates are always `YYYY-MM-DD`; Google Tasks only stores the date anyway, never
a time. `tasklist_id` is optional everywhere and falls back to the account's
default list.

## Architecture

Two auth layers that share no token:

```
                 Layer 1: MCP auth spec               Layer 2: Google OAuth
Claude.ai  ──────────────────────────────►  Worker  ──────────────────────►  Google
           /authorize /token /register              /oauth/google/callback
           PKCE S256, bearer token                  refresh token in KV (AES-GCM)
```

* **Claude → Worker**: the worker is its own OAuth 2.1 server. Dynamic client
  registration, PKCE S256 (no `plain`), and a token endpoint that takes
  `application/x-www-form-urlencoded`. The tokens are HMAC-signed,
  self-verifying strings — no KV read in the login path, because KV is only
  *eventually consistent* and the code exchange would otherwise fail
  sporadically.
* **Worker → Google**: a plain authorization code flow with
  `access_type=offline`. The refresh token sits in KV encrypted with AES-GCM,
  the access token lives in memory only. On a `401` the client refreshes
  exactly once and retries the call exactly once.

The MCP endpoint speaks **both protocol generations**: the current revision
`2026-07-28` (per-request `_meta`, `server/discover`, mirrored HTTP headers)
and the older `initialize`-based form (`2025-11-25`, `2025-06-18`,
`2025-03-26`). Which revision Claude.ai uses is undocumented; the spec
explicitly allows serving both from the same endpoint.

## Requirements

* Node.js 20+
* A Cloudflare account (the free plan is enough — no Durable Objects)
* A Google account
* `openssl` for generating keys

---

# Setup

The steps build on each other. Order matters: you need the worker URL before
you can configure the Google OAuth client.

## Step 1 — Install dependencies

```bash
npm install
```

## Step 2 — Log in to Cloudflare and create the KV namespace

```bash
npx wrangler login
npx wrangler kv namespace create TASKS_KV
```

The second command prints an ID. Put it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "TASKS_KV"
id = "0123456789abcdef0123456789abcdef"
```

## Step 3 — Deploy once to get the URL

```bash
npx wrangler deploy
```

At the end it prints the public address, something like:

```
https://google-tasks-mcp.<your-subdomain>.workers.dev
```

You will need this URL several times below; it is referred to as `$WORKER`.
The server still answers with `500` at this point, because the secrets are
missing. That is correct: it refuses to start with incomplete configuration.

## Step 4 — Google Cloud project and OAuth client

1. Open [console.cloud.google.com](https://console.cloud.google.com) and
   create a **new project** in the top left, e.g. `tasks-mcp`.
2. **APIs & Services → Library** → search for *Google Tasks API* →
   **Enable**.
3. Open **Google Auth Platform** (formerly *OAuth consent screen*) and start
   the configuration:
   * User type / audience: **External** (with a personal Google account this
     is the only option).
   * App name and support email: your own address.
   * Under **Audience**, add yourself as a **test user**.
4. **Data access → Add scopes** → select the scope
   `https://www.googleapis.com/auth/tasks` and save.
5. **Clients → Create client**:
   * Application type: **Web application**
   * Authorised redirect URIs — add both:
     * `$WORKER/oauth/google/callback`
     * `http://localhost:8787/oauth/google/callback` *(only needed if you want
       to test locally — see below)*
6. Note down the client ID and client secret.

### Important: set the publishing status to "In production"

While the app sits in **Testing**, Google refresh tokens expire after
**7 days** and you would have to reconnect the connector every week. Set the
status to **In production** under **Google Auth Platform → Audience**.

Because `.../auth/tasks` is a sensitive scope, Google shows a warning when you
connect ("Google hasn't verified this app"). Since you are the only user, click
**Advanced → Go to …** there. Verification is not required for personal use.

## Step 5 — Find your own Google account ID

The allowlist checks the `sub` claim of your Google account. There is nowhere
to look it up — so the server tells you itself. Set the placeholder once:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID       # from step 4
npx wrangler secret put GOOGLE_CLIENT_SECRET   # from step 4
npx wrangler secret put TOKEN_SIGNING_KEY      # openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY         # openssl rand -base64 32
npx wrangler secret put ALLOWED_GOOGLE_SUB     # exactly: SETUP
```

Generate the two random keys with:

```bash
openssl rand -base64 32
```

Now open this in a browser:

```
$WORKER/authorize?response_type=code&client_id=setup&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256
```

After the Google sign-in the server shows a plain text page with your account
ID (21 digits). **Nothing is stored** in the process and no token is issued —
in `SETUP` mode the allowlist rejects everyone.

Then set the ID as the real value:

```bash
npx wrangler secret put ALLOWED_GOOGLE_SUB     # the 21-digit number
```

## Step 6 — Check the secrets

```bash
npx wrangler secret list
```

There must be five entries: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ALLOWED_GOOGLE_SUB`, `TOKEN_SIGNING_KEY`, `ENCRYPTION_KEY`.

None of them appears in `wrangler.toml` or in the repository. `.dev.vars` is
excluded via `.gitignore`.

## Step 7 — Deploy

```bash
npm run typecheck && npm test && npx wrangler deploy
```

A quick smoke test:

```bash
curl -s $WORKER/.well-known/oauth-protected-resource | jq
curl -si -X POST $WORKER/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -3
```

The first call must return the metadata document, the second a `401` with a
`WWW-Authenticate` header.

## Step 8 — Add the connector in Claude.ai

1. In Claude.ai go to **Settings → Connectors**.
2. Choose **Add connector**.
3. Enter as the URL:

   ```
   $WORKER/mcp
   ```

4. Claude registers itself, opens the login and sends you to Google. Sign in
   with **the account whose ID you configured in step 5**. Click through the
   unverified-app notice with **Advanced → Go to …**.
5. After consenting you land back in Claude.ai and the connector is connected.

If you accidentally sign in with a different Google account, the flow aborts
with `access_denied` — which is exactly the intent.

## Step 9 — Try it out

Ask Claude something like: *"Which task lists do I have?"* or *"Add a task
'file taxes' due on March 15."*

---

# Testing locally

## wrangler dev

```bash
cp .dev.vars.example .dev.vars      # then fill in real values
npx wrangler dev
```

Runs on `http://localhost:8787` with a local KV emulator. For the OAuth round
trip you additionally need:

* in `wrangler.toml`: `ALLOW_LOCAL_REDIRECT = "true"` (allows the inspector's
  loopback redirect URI)
* in Google Cloud: `http://localhost:8787/oauth/google/callback` as an
  authorised redirect URI (see step 4)

`SERVER_BASE_URL` stays empty; the worker then derives its base URL from the
incoming request.

> Neither relaxation belongs in production. Set `ALLOW_LOCAL_REDIRECT` back to
> `"false"` before the next `wrangler deploy`.

## MCP Inspector

In a second terminal:

```bash
npx @modelcontextprotocol/inspector
```

The inspector opens on `http://localhost:6274`. Set it to:

* **Transport Type**: `Streamable HTTP`
* **URL**: `http://localhost:8787/mcp`

Then hit **Connect**. The inspector discovers the authorization server via
`/.well-known/oauth-protected-resource`, registers itself via DCR, sends you
through the Google login and comes back with a token. After that you can call
`tools/list` under **Tools** and exercise each tool with your own arguments.

It also works without the full OAuth round trip: if you already have an access
token you can talk to it with `curl` directly.

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

---

# Operating it

**Revoke access immediately** — either measure is enough:

```bash
# 1. Invalidate every token we ever issued
npx wrangler secret put TOKEN_SIGNING_KEY     # set a new value

# 2. Delete the stored Google refresh token
npx wrangler kv key delete "google:refresh_token" --binding TASKS_KV --remote
```

Access can additionally be revoked on Google's side at any time under
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

**If every endpoint returns `500`:**

```bash
npx wrangler tail
```

The log line `configuration_error: missing or empty secret(s): …` names
exactly the missing bindings — names, never values. The outward-facing answer
stays a bare `{"error":"server_error"}`.

> `wrangler secret put` asks for the value **interactively**. Running it
> without a terminal (in an IDE console, a script, an agent) reads an empty
> value and still reports success. The secret then exists but is empty. Either
> run it in a real terminal or pipe the value in:
>
> ```bash
> printf '%s' "$VALUE" | npx wrangler secret put GOOGLE_CLIENT_ID
> ```

**Viewing logs:**

```bash
npx wrangler tail
```

Only the method, path, status code and duration are logged, plus one line per
JSON-RPC request with the protocol era, method and outcome. No tokens, no
query strings (they contain codes and state), no task content.

---

# Security model

What is actively protected:

* **Account allowlist.** The `sub` claim is checked in three places: at the
  Google callback (nothing is stored before that), when the authorization code
  is redeemed, and on every single bearer token.
* **Redirect URI allowlist.** Exact string comparison, no prefixes, no
  wildcards. An unknown redirect URI leads to a 400 page instead of a
  redirect — otherwise the server would be an open redirector.
* **PKCE S256 mandatory.** `plain` is neither offered nor accepted.
* **Audience binding.** A token issued for a different resource is rejected
  (RFC 8707).
* **Refresh token encrypted.** AES-GCM, key from `wrangler secret`. KV holds
  ciphertext only.
* **Per-session rate limit.** 60 calls, of which 20 writes and 5 deletions per
  minute. That is a brake against a model in a loop, not protection against an
  attacker.
* **No stack traces leave the process.** Every response goes through a single
  place that reduces unknown errors to a fixed message.

Deliberate limits — readable in the code, summarised here:

* **Refresh tokens are not revocable.** They are statelessly signed; an issued
  token is valid until it expires (30 days). To shut it off, rotate
  `TOKEN_SIGNING_KEY`.
* **Single use of authorization codes is best effort.** The marker lives in
  KV, which is *eventually consistent* across data centres. A code lives for
  60 seconds and is bound to a PKCE challenge; a replay would additionally
  need the verifier.
* **Rate limit counters are in KV too**, so approximate for the same reason.
  With a single user whose requests land in the same data centre it holds in
  practice.
* **The `id_token` signature is not verified.** The token arrives over TLS
  directly from Google's token endpoint, as the response to our authenticated
  request — exactly the case OpenID Connect Core 3.1.3.7 exempts. The function
  must not be fed from any other source.
* **No `Origin` blocking.** The endpoint authenticates purely via the
  `Authorization` header, never via a cookie. Third-party browser JavaScript
  therefore cannot make an authenticated request on the user's behalf; an
  origin filter would only lock out the inspector.

---

# Project layout

```
src/
  index.ts              router and error collection point
  env.ts                bindings, configuration check
  errors.ts             McpError / ToolExecutionError / OAuthError
  crypto.ts             base64url, HMAC tokens, AES-GCM, timing-safe compare
  store.ts              KV access
  http.ts               response helpers, CORS
  ratelimit.ts          per-session counters
  auth/
    mcp-oauth.ts        layer 1: discovery, /authorize, /token, bearer check
    tokens.ts           signed codes and tokens
    pkce.ts             S256
    clients.ts          DCR, redirect URI allowlist
    google.ts           layer 2: Google OAuth, sub allowlist, setup mode
  google/
    tasks-client.ts     Tasks API v1, 401 → refresh → retry
  mcp/
    server.ts           JSON-RPC, both protocol generations
    tools.ts            tool definitions and annotations
    handlers.ts         tool implementations
test/                   102 unit tests
```

# Tests

```bash
npm test          # once
npm run test:watch
npm run typecheck
```

The Google API is mocked throughout and KV runs in memory. Covered are, among
other things, token refresh including the 401 retry, the allowlist at all
three checkpoints, PKCE against the RFC 7636 test vector, the complete OAuth
round trip through the worker, both protocol generations including header
validation, the rate limits and the tool handlers.

---

# Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
For security issues please follow [SECURITY.md](SECURITY.md) instead of opening
a public issue.

# License

[MIT](LICENSE)
