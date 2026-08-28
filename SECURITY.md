# Security policy

This project is an OAuth 2.1 authorization server that holds a Google refresh
token. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/LennardGeissler/google-tasks-mcp/security/advisories/new).

Helpful in a report:

* what an attacker can do, and what they need in order to do it
* the affected file or endpoint
* a minimal reproduction, if you have one

You can expect a first reply within a few days. This is a personal project
maintained in spare time, so please allow reasonable time for a fix before
disclosing publicly.

## Scope

In scope — anything that lets a party other than the configured account read
or change tasks, or that leaks credentials:

* bypassing the `sub` allowlist at any of its three checkpoints
* forging or replaying an authorization code, access token or refresh token
* escaping the redirect URI allowlist (open redirect)
* leaking the client secret, signing key, encryption key or the stored Google
  refresh token
* any way to get token or task content into the logs

Out of scope — documented, deliberate design limits, all described in the
[security model](README.md#security-model):

* issued refresh tokens cannot be revoked individually (rotate
  `TOKEN_SIGNING_KEY`)
* single use of authorization codes is best effort, because KV is eventually
  consistent
* rate limit counters are approximate, for the same reason
* the `id_token` signature is not verified — it is read only from a direct,
  authenticated TLS response from Google's token endpoint
* no `Origin` blocking, because the endpoint never authenticates via cookies
* findings that require an already-compromised Cloudflare or Google account

## Deployment note

Every instance of this server is deployed by whoever runs it, with their own
secrets. There is no shared hosted instance, so a fix reaches users only when
they redeploy. Fixes are noted in the release notes.
