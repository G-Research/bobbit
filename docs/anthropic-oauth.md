# Anthropic OAuth

Bobbit exposes Anthropic account login in Settings → Account, but it does not own a
second copy of Claude's OAuth protocol. The maintained Pi runtime owns the authorization
parameters, scope set, loopback callback, callback validation, token exchange, and refresh
contract. Bobbit owns the browser interaction, provider isolation, persistence adapter, and
credential-handling policy around that contract.

This separation matters because a copied authorization URL or token exchange silently drifts
when Claude Code/Pi changes. The REST route shapes are documented in [REST API — OAuth](rest-api.md#oauth).

## Login lifecycle

`POST /api/oauth/start` for `provider: "anthropic"` creates Pi's `Models` service with a
Pi-compatible credential store and calls its public `Models.login("anthropic", "oauth",
interaction)` API. Bobbit presents Pi's `auth_url` notification unchanged and reports that a
callback server is active. Pi's current flow uses its loopback callback and exchanges tokens at
`https://platform.claude.com/v1/oauth/token`. Its current scope set is:

- `org:create_api_key`
- `user:profile`
- `user:inference`
- `user:sessions:claude_code`
- `user:mcp_servers`
- `user:file_upload`

These values are Pi contract details, not Bobbit defaults: update the Pi adapter and its
contract tests together when upstream changes them.

The browser may complete Pi's callback directly. The existing manual-complete route remains for
remote browser/gateway arrangements: a submitted code, query string, or redirect URL is passed
to Pi, which validates callback state before exchange. Bobbit must not parse state, construct a
replacement authorization URL, or exchange an Anthropic authorization code itself.

Only one Anthropic flow can be active in a gateway process because Pi uses a fixed callback-port
contract. A conflicting start returns retryable `409 ANTHROPIC_OAUTH_BUSY`. Cancel the in-flight
Anthropic login (or wait for it to settle) and retry; a flow for another provider does not occupy
this lease.

Flows expire after five minutes. Cancellation aborts Pi's interaction and is provider-scoped.
Before a code is submitted, cancellation immediately releases the flow. If Pi is already
exchanging a submitted code, Bobbit retains the flow and callback-port lease until that exchange
settles. This prevents a retry from racing the prior exchange, and prevents a cancelled flow from
leaving its own credential behind.

## Credential storage and status

Pi reads and writes the gateway's agent `auth.json` through Bobbit's `AtomicCredentialStore`.
The adapter uses Pi's lock namespace, fresh reads, atomic replacement, restrictive file modes
where supported, and stale-lock reclamation that verifies lock ownership before removal. Those
properties preserve rotating credentials across concurrent gateway activity and gateway restart
without inventing a second credential store.

Credentials are partitioned by provider. Anthropic state cannot be read, cancelled, logged out,
or reported through another provider's flow id. `GET /api/oauth/status` returns only provider,
authenticated state, expiry, and permitted display metadata; it never returns access tokens,
refresh tokens, or API keys.

A valid Anthropic OAuth entry must contain an OAuth access token, refresh token, and finite
expiry. Incomplete rows are unauthenticated. A complete expired row is reported as
`authenticated: false`, even when it remains stored and has a refresh token (`stored: true`,
`refreshable: true`). Pi validates that refresh candidate lazily before use; it is not a currently
usable login until that refresh succeeds. On a definitive refresh rejection (HTTP 400, 401, or
403), Bobbit clears only the exact credential snapshot Pi attempted. Network, 5xx, and 429
failures retain it so a transient outage does not sign the user out. A direct Anthropic request
that definitively rejects the specific OAuth access credential likewise removes only that matching
entry, so status never continues to claim that rejected credential works.

Logout deletes only `auth.json["anthropic"]` and clears the OAuth cache. It does not revoke or
modify OAuth/API-key credentials for OpenAI or Google; Anthropic has no separate revocation call
in this lifecycle.

## Direct Anthropic requests and sandboxes

Direct gateway-side Anthropic calls (such as model helpers, titles, and role names) resolve OAuth
access through the same Pi-backed refresh path. Their OAuth request identity is centralized in
the direct-request helper and tracks Pi's current Claude Code identity. API-key requests retain
Anthropic's API-key headers and never inherit OAuth-only identity headers. This avoids drift
between direct paths without treating request identity as an explanation of a model outcome.

API-key authentication remains independent: configured provider keys and supported API-key
environment paths continue to work without an OAuth credential.

A Docker sandbox does not receive renewable host Anthropic authority by default. A project must
explicitly opt in to a current OAuth access-token handoff, and Bobbit refreshes it on the gateway
before creating the minimal sandbox credential. The sandbox receives only the current,
non-renewable OAuth access/expiry entry — never the host refresh token or profile metadata. An
explicit project Anthropic credential takes precedence over any host OAuth handoff.

## Logging and failure semantics

Callback codes, provider payloads, access tokens, refresh tokens, and API keys are never output
by status routes, logs, fixtures, or documentation. The browser receives the one-time OAuth URL
needed to start its own flow, but it is not logged. OAuth progress and error messages are redacted
before logging; externally visible failures are sanitized to actionable lifecycle messages.

Model failures retain their provider meaning. A model-specific `404`, an authentication `401` or
`403`, and rate/quota/spend-limit `429` are distinct outcomes. A `429` is not evidence that a
model is available, and a `404` is not evidence that OAuth or request identity caused the
outcome.

## Deferred live A/B investigation

This integration establishes contract conformance and mocked outcome classification; it does not
claim a live entitlement result for any Anthropic model. The companion **Anthropic OAuth A/B
Probe** owns fresh-credential testing that isolates scope, credential provenance, and request
headers, then probes three models before and after restart. Until that controlled provider-
dependent work is performed, differences between model results must remain uncertainty rather
than an attribution to Bobbit, Pi, OAuth scopes, or Claude Code identity.

## Related references

- [REST API — OAuth](rest-api.md#oauth)
- [Pi runtime compatibility](pi-runtime-compatibility.md)
- [Google OAuth & Gemini models](google-oauth-models.md)
- [Debugging — Pi OAuth adapter](debugging.md#pi-oauth-adapter-breaks-after-a-pi-upgrade)
