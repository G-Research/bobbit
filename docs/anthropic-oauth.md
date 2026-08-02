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
exchanging a submitted code, or can be exchanging through its loopback callback, Bobbit retains
the flow and callback-port lease until that exchange settles. This makes `409 ANTHROPIC_OAUTH_BUSY`
a useful retry signal rather than permitting a second login to race the first.

A completed flow is retained for a short acknowledgement window. If the success response was
lost, an explicit cancellation can still remove exactly the credential that flow issued. Bobbit
first fences that result, then restores only the safe predecessor: a credential written by a newer
login, refresh, or explicit logout is never overwritten. If durable cleanup fails, cancellation
returns retryable `OAUTH_CANCEL_RETRY_REQUIRED` and the flow stays blocked until that same
cancellation is retried. Logout is terminal for every in-flight login and prevents a late result
from restoring a logged-out credential.

## Credential storage, locking, and status

Pi reads and writes the gateway's agent `auth.json` through Bobbit's `AtomicCredentialStore`.
The adapter uses Pi's canonical, realpath-resolved `auth.json.lock` namespace, fresh reads, atomic
replacement, and restrictive file modes where supported. It holds the shared lock through a
refresh callback so a competing Pi process re-reads a rotated winner rather than spending the
same refresh token.

The lock is heartbeated before Pi's synchronous stale deadline and honors Pi's longer asynchronous
lease before recovery. A contender may reclaim only an unchanged stale lock: it atomically claims
the observed directory, rechecks its identity and lease, and never removes a replacement or a
renewed owner. A releasing owner applies the same identity check; losing ownership is a failure,
not a successful credential write. These rules preserve rotating credentials across concurrent
gateway activity and restart without inventing a second credential store.

Credentials are partitioned by provider. Anthropic state cannot be read, cancelled, logged out,
or reported through another provider's flow id. `GET /api/oauth/status` returns only provider,
authenticated state, expiry, and permitted display metadata; it never returns access tokens,
refresh tokens, or API keys.

A valid Anthropic OAuth entry must contain an OAuth access token, refresh token, and finite
expiry. Incomplete rows are unauthenticated. A complete expired row is reported as
`authenticated: false`, even when it remains stored and has a refresh token (`stored: true`,
`refreshable: true`). Pi validates that refresh candidate lazily before use; it is not a currently
usable login until that refresh succeeds.

## Rejected OAuth credentials and API-key recovery

A credential is terminally rejected only on evidence that identifies the credential rather than a
model or quota outcome: Pi's refresh `401`, or its token-endpoint `400 invalid_grant`; direct
Anthropic Messages paths treat only `401` for the exact OAuth access value as terminal. Network,
5xx, `429`, generic `400`, and direct `403` failures retain the credential because they can be
transient or resource-specific.

On a terminal rejection, Bobbit compares the credential that was used under the credential lock.
If it is still current, it replaces the provider row with a non-secret `oauth_rejected` tombstone
and writes a provider-scoped durable fence containing only a one-way access-value fingerprint.
Neither the access token nor refresh token remains in the tombstone or fence. The raw tombstone
also stops another Pi host that reads `auth.json` directly from trying to refresh the rejected
credential. A failed fence write remains fail-closed in the running gateway; a corrupt fence
fails closed only for its own provider.

A tombstone reports `authenticated: false`, `stored: true`, `rejected: true`, and
`refreshable: false`. It is therefore visible for provider-scoped logout/cleanup but can never
look like a working account after restart. Rejections compare exact credentials, so an in-flight
failure cannot erase a newly logged-in or rotated replacement.

Anthropic API-key authentication remains independent. Saving an explicit Anthropic provider key
removes only a rejected OAuth tombstone, never a healthy OAuth or API-key row. When an
Anthropic agent is started with an explicit injected key, or with an ambient key for an Anthropic
runtime, Bobbit also makes the same best-effort tombstone cleanup before Pi starts; this lets Pi
use the API-key fallback, which it otherwise suppresses for an unknown raw credential type.
Saved provider keys and supported API-key environment paths can therefore recover service after a
rejected OAuth login without reviving renewable OAuth authority.

Logout deletes only the Anthropic OAuth row or rejection tombstone and clears the OAuth cache. It
does not revoke or modify OAuth/API-key credentials for OpenAI or Google; Anthropic has no
separate revocation call in this lifecycle.

## Direct Anthropic requests and sandboxes

Direct gateway-side Anthropic calls (such as model helpers, titles, and role names) resolve OAuth
access through the same Pi-backed refresh path. Their OAuth request identity is centralized in
the direct-request helper and tracks Pi's current Claude Code identity. API-key requests retain
Anthropic's API-key headers and never inherit OAuth-only identity headers. This avoids drift
between direct paths without treating request identity as an explanation of a model outcome.

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
