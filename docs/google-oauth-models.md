# Google OAuth & Gemini models

Bobbit can authenticate Google for Gemini in two distinct ways. They are intentionally
kept separate so an account login can never be confused with an API key, and so a
Google credential can never accidentally "authenticate" the wrong provider.

| Path | Provider id | Where | Credential | What it powers today |
|---|---|---|---|---|
| **Google account OAuth** | `google-gemini-cli` | Settings → Account → Google OAuth | OAuth Bearer token (Code Assist) in `auth.json` | Account-backed Gemini model metadata + gateway-side helper completions. **Not yet selectable for agent sessions.** |
| **Google AI Studio API key** | `google` | Settings → Models → Provider API Keys | API key in preferences (`providerKey.google`) | The always-working, session-usable Gemini path. |

This split is the single most important thing to understand about the feature: it is the
reason there are two "Google" entries in Settings, two provider ids, and two different
wire protocols under the hood.

> **Why two providers?** Consumer Google accounts can only reach Gemini through the
> official **Gemini Code Assist API** (`cloudcode-pa.googleapis.com`), which speaks a
> different protocol (Bearer token, request-wrapping) than the API-key **Gemini Developer
> API** (`generativelanguage.googleapis.com`, `x-goog-api-key`). There is no supported way
> to feed a consumer OAuth token to the API-key provider. So "log in with Google" and
> "paste a Gemini API key" are genuinely different integrations, not two UIs for the same
> thing.

The full rationale, endpoint research, and acceptance-criteria traceability live in the
design artifacts: [`docs/design/google-oauth-model-auth.md`](design/google-oauth-model-auth.md)
(backend/runtime) and [`docs/design/google-oauth-settings-ux.md`](design/google-oauth-settings-ux.md)
(Settings/UX).

---

## Settings → Account: Google OAuth

The Account tab lists OAuth providers as parallel rows (Anthropic, OpenAI, Google). The
Google row uses canonical provider id `google-gemini-cli` and reuses the same row, status
card, dialog, re-auth, and logout machinery as the other providers — see
[`docs/rest-api.md` → OAuth](rest-api.md#oauth) for the endpoint contract.

What login does:

1. **Start** (`POST /api/oauth/start { provider: "google-gemini-cli" }`) launches Google's
   standard installed-app OAuth flow against `accounts.google.com/o/oauth2/v2/auth` with
   PKCE (S256), `access_type=offline`, and `prompt=consent` (to guarantee a refresh token).
   The redirect target is a **loopback** callback server the gateway opens on
   `http://localhost:<ephemeral-port>/oauth2callback`.
2. **Complete** happens automatically when the browser hits the loopback callback, or via
   the dialog's manual paste field (paste the full redirect URL or the `code#state` value)
   for remote-gateway setups where the browser cannot reach the gateway loopback.
3. **Store** writes a sanitized entry to `auth.json["google-gemini-cli"]` of the form
   `{ type: "oauth", access, refresh, expires, email? }`. `email` is non-secret display
   metadata from the userinfo endpoint; tokens are never returned by any `/status` response.

**Scopes requested** (the minimum the Code Assist flow needs):

- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

**OAuth client identity.** Bobbit reuses the official **Gemini CLI** installed-app OAuth
client (the same Google-supported "Login with Google" client the CLI ships) rather than a
Bobbit-owned GCP client. Installed-app client secrets are public by Google's own guidance.
This is a deliberate, documented choice: third-party brand/scope approval for Code Assist is
not guaranteed, so if Google ever rejects use of that client by non-CLI apps, the Google
account row must be disabled with a clear message while API-key Gemini stays available.

**Reload persistence.** Credentials live only server-side in `auth.json`; the browser holds
no token. On Settings open, the Account tab re-fetches
`GET /api/oauth/status?provider=google-gemini-cli`, so an authenticated account shows
**Authenticated** after a full reload with no extra work. Expired tokens render **Expired**
and the button reads **Re-authenticate**, identical to the other providers.

**Refresh.** `refreshGoogleOAuthToken()` (in `src/server/auth/oauth.ts`) exchanges the
stored refresh token at `oauth2.googleapis.com/token` when the access token is missing or
expired. It mirrors the Anthropic refresh policy: clear the stored credential only on
definitive auth failures (400/401/403); keep it on transient 5xx/429/network errors. The
existing no-arg Anthropic `refreshOAuthToken()` API is untouched, so Anthropic/OpenAI
behavior is unchanged.

**Logout.** `POST /api/oauth/logout { provider }` (handler `oauthLogout`) revokes the token
at `oauth2.googleapis.com/revoke` where possible, deletes **only** that provider's
`auth.json` entry, clears the OAuth cache, and returns `{ success, provider }` with no token
material. It is provider-partitioned: logging out `google-gemini-cli` never touches
`anthropic`, `openai-codex`, or the API-key-only `google` credential.

### Provider isolation

`normalizeProvider()` is the single mapping authority. It accepts inbound aliases `google`
and `gemini` at OAuth request boundaries and collapses them to the canonical
`google-gemini-cli`, but those aliases are **never** used as storage keys. Combined with the
`flowId` + provider cross-check in `oauthFlowStatus`, this guarantees Google flows and
credentials cannot collide with the Anthropic/OpenAI flows or with the API-key `google`
entry.

---

## Settings → Models: Provider API Keys (the fallback)

The current Settings → Models tab now renders a **Provider API Keys** section
(`data-testid="provider-keys-section"`) below Default Models, reusing the existing
`<provider-key-input>` component and the `/api/provider-keys` endpoints. It offers keys for
Google (AI Studio / Gemini Developer API, provider `google`), Anthropic, and OpenAI.

This fixes a prior **Settings drift**: the model-selector tooltip used to send users to a
"Settings → Providers" screen that no longer existed, and there was no per-provider API-key
entry anywhere in current Settings. The tooltip now points at Settings → Account / Settings →
Models, and the API-key entry point exists where users are sent. A browser E2E pins this so
the drift cannot reappear.

Use the API key path when you are **not** using account login — e.g. Google AI Studio users.
This is the guaranteed, session-usable Gemini path and remains fully selectable for agent
sessions.

---

## Current limitation: account-backed Gemini is account-only

When a Google account credential is present, the model registry emits account-backed Gemini
models under provider `google-gemini-cli` with `api: "google-code-assist"` (see
`src/server/agent/google-code-assist-models.ts`). These models show in the selector as
**authenticated** but are emitted with **`sessionSelectable: false`** and a clear reason:

> Signed in, but Google account (Code Assist) models can't run in agent sessions yet — the
> agent runtime has no Code Assist provider. For Gemini in sessions, add a Google AI Studio
> API key (provider "google") under Settings → Models.

**Why:** the Code Assist adapter (`codeAssistComplete`) is wired only into **server-side**
helper completions (`completeModelText` — used for title/name/connection-test). The
pi-coding-agent runtime that powers agent **sessions** has no `google-gemini-cli` provider
and no `google-code-assist` api, so binding such a model to a session would silently fall
back or hard-fail. To prevent that, `google-gemini-cli` is server-side-gated as a
non-session-selectable provider (`isSessionSelectableProvider` /
`NON_SESSION_SELECTABLE_PROVIDERS` in `src/server/agent/google-code-assist.ts`): no path
(browser picker, role override, `default.sessionModel` preference, API write, or a restored
config) may bind it to a session. A pinning test cross-checks the per-model flag and the
provider-level guard so they cannot drift.

Until agent-side Code Assist support exists, **session-usable Gemini requires a Google AI
Studio API key** (provider `google`). The Account-tab note and the model-selector copy both
say this explicitly, satisfying the goal constraint that an unusable subscription path must
be surfaced clearly rather than implied to work.

The `OAUTH_AUTHENTICATED_PROVIDERS` allow-list in `src/server/agent/model-registry.ts`
(`anthropic`, `openai-codex`, `google-gemini-cli`) ensures only genuine OAuth providers are
authenticated via `auth.json`, so a `google-gemini-cli` account token can never make the
API-key-only `google` provider look usable.

---

## Token & sandbox propagation (high level)

Spawned/sandboxed agent sessions receive Google credentials through the same partitioned
credential-propagation path as the other account providers, but **only when policy opts in**
(least privilege; default is no Google credential in the sandbox):

- **Env var.** `src/server/agent/host-tokens.ts` maps provider `google-gemini-cli` to the
  sandbox env var `GOOGLE_CLOUD_ACCESS_TOKEN` (the var the Gemini CLI / google-auth honor for
  a pre-acquired Bearer token, paired with `GOOGLE_GENAI_USE_GCA=1`). This is deliberately
  distinct from the API-key `google` var (`GEMINI_API_KEY`) so the two never collide.
- **Sanitized sandbox `auth.json`.** When the sandbox-token policy enables the Google entry
  (`sandboxTokenPolicyAllowsGoogleAuth`, key `GOOGLE_CLOUD_ACCESS_TOKEN`), the scoped
  read-only sandbox `auth.json` includes a sanitized `google-gemini-cli` credential
  containing only `{ type: "oauth", access, refresh?, expires? }`. `email`/profile/scope
  metadata is never copied into the sandbox. This mirrors the existing Codex sanitization
  pattern.
- **Freshness.** Gateway-side token resolution refreshes the access token before use; the
  sandbox carries the refresh token so it can re-mint an expired access token itself.

**Safety invariants** (unchanged from the rest of the auth pipeline): tokens are never
logged (error bodies are truncated and redacted), `GET /api/oauth/status` and
`GET /api/provider-keys` never echo `access`/`refresh`/`key` — `email` is the only new
non-secret field a status response may carry, and only because the UI shows the signed-in
account.

---

## Manual runtime verification

Automated tests cover provider partitioning, sanitized status, refresh failure modes, the
OAuth-capable allow-list, sandbox sanitization, the OAuth status/start/flow/complete/logout
routes (mocked Google endpoints), and the Settings UI (Account row + reload persistence,
the Models Provider API Keys section, and the stale-path regression). The following steps
require a **real Google account** and are not part of CI:

1. **Login round-trip.** Settings → Account → Google OAuth → **Log in**. Complete Google
   consent in the opened tab (or paste the redirect URL/code in remote-gateway setups).
   Confirm the row flips to **Authenticated** with an **Expires** time.
2. **Reload persistence.** Hard-reload Bobbit. The Google row must still show
   **Authenticated** (status is re-fetched from `auth.json`).
3. **Account-only model state.** Open the model selector. Account-backed Gemini models
   (`… (Google account)`) must appear **authenticated but not session-selectable**, with the
   "can't run in agent sessions yet" reason. Confirm none can be bound to a session.
4. **Server-side Code Assist completion (where supported).** Where a server-side helper
   completion routes through `google-gemini-cli`, confirm it reaches
   `cloudcode-pa.googleapis.com/v1internal` with a Bearer token, resolving/onboarding a free-
   tier project on first use (cached in `google-code-assist.json`). On unsupported accounts,
   confirm the limitation messaging is shown rather than a silent failure.
5. **API-key fallback unchanged.** Add a Google AI Studio key under Settings → Models →
   Provider API Keys and confirm Gemini Developer API (`google`) models remain fully
   session-selectable and complete normally — independent of account login.
6. **Logout isolation.** Log out of Google and confirm `anthropic`, `openai-codex`, and any
   API-key-only `google` credential are untouched, and that no token material appears in any
   response or log.
