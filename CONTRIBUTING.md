# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

For security problems, please follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

The test suite needs no credentials: the Google API is mocked throughout and
KV runs in memory. If you want to exercise the real OAuth round trip, the
README describes [testing locally](README.md#testing-locally) with
`wrangler dev` and the MCP Inspector.

## Before opening a pull request

```bash
npm run typecheck && npm test
```

Both must pass; CI runs exactly these two commands. New behaviour needs a
test — the existing suite covers the auth paths closely, and a change that
touches them without a test is hard to review.

## Scope

The server is deliberately **single user**: one Google account, checked against
an allowlist at three points. Multi-tenancy is not a goal, and changes that
loosen the allowlist, add a `plain` PKCE fallback or widen the redirect URI
matching will not be merged.

Good changes: bug fixes, tighter validation, support for newer MCP protocol
revisions, more Tasks API coverage, clearer documentation.

## Style

Match the code around you. A few conventions worth knowing:

* **Comments explain why, not what.** The existing comments record decisions
  and constraints — why tokens are self-verifying, why KV is not read in the
  login path. Keep that bar.
* **Errors never leak internals.** Every outward-facing response goes through
  the single sanitisation point in `src/errors.ts`. Do not bypass it.
* **Never log a secret.** Tokens, codes, query strings and task content stay
  out of the logs. Method names, paths and status codes are fine.

## Commits

Conventional commits, imperative mood, lowercase after the type:

```
feat(auth): setup mode for discovering your own Google account id
fix: make a misconfigured server diagnosable
test: cover token refresh, allowlist, PKCE, rate limits, tools and protocol
```

The subject says what changed; the body says why, if that is not obvious.
