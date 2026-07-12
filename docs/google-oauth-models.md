# Google OAuth & Gemini models

Bobbit can authenticate Google for Gemini in two distinct ways. They are intentionally
kept separate so an account login can never be confused with an API key, and so a
Google credential can never accidentally "authenticate" the wrong provider.

| Path | Provider id | Where | Credential | What it powers |
|---|---|---|---|---|
| **Google account OAuth** | `google-gemini-cli` | Settings → Account → Google OAuth | OAuth Bearer token (Code Assist) in `auth.json` | Account-backed Gemini models, usable as **full agent session models** (stream, tools, multi-turn) **and** gateway-side helper completions. |
| **Google AI Studio API key** | `google` | Settings → Models → Provider API Keys | API key in preferences (`providerKey.google`) | The other, independent session-usable Gemini path. |

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

## Account-backed Gemini as agent session models

When a Google account credential is present, the model registry emits account-backed Gemini
models under provider `google-gemini-cli` with `api: "google-code-assist"` (see
`src/server/agent/google-code-assist-models.ts`). They appear in the model selector named
`… (Google account)` and are **session-selectable**: you can bind one to any agent session
exactly like an Anthropic, OpenAI, or API-key Gemini model.

"A Google account credential is present" spans **both** supported Code Assist auth paths
(`hasGoogleCodeAssistSpawnCredential()` in `src/server/agent/google-code-assist.ts`):

- a stored `auth.json` OAuth credential (Settings → Account → Google login), or
- a pre-acquired Bearer token in the gateway env var `GOOGLE_CLOUD_ACCESS_TOKEN`.

Either path counts as a genuine Code Assist credential for the whole surface — `/api/models`
and Settings model exposure, the Settings auth-status row, and spawn-time model pinning
(default, per-role, and persisted `google-gemini-cli/*` selection). One shared credential
helper drives all three so they never disagree. This makes an env-token deployment (no
interactive OAuth login) a first-class way to run account-backed Gemini sessions. The
isolation from the API-key `google` provider is exact and bidirectional: a generic
`GOOGLE_API_KEY`/`GEMINI_API_KEY` never authenticates Code Assist, and
`GOOGLE_CLOUD_ACCESS_TOKEN` never authenticates the API-key `google` (Gemini Developer API)
provider.

The emitted set is a **curated allowlist** (`CODE_ASSIST_ALLOWLIST` in that file), not every
`gemini-*` in pi-ai's `google` catalog. The catalog carries Developer API (AI Studio) ids
that the Code Assist endpoint 404s on with `HTTP 404 Requested entity not found` —
`gemini-2.0-*`, `gemini-3.5-flash`, and the `*-latest` aliases. Those are excluded so they
can never be selected and fail a live session. Membership was confirmed against live Code
Assist probes; update the allowlist when Google adds/removes served models.

A selected `google-gemini-cli/<model>` session can answer, stream output, call tools,
receive tool results, and continue multi-turn context. The selection persists as a
`provider/modelId` preference and is re-pinned on every spawn (including restart, restore,
and respawn), so reloads do not silently fall back to another model.

Unauthenticated Code Assist models are deliberately absent from `/api/models` and from the
agent-side provider's `models[]`. This keeps account-backed Gemini available for late auth
without letting Pi choose `google-gemini-cli/*` as a default before the user has a usable
Google credential.

### How it runs (why there are two Gemini wire paths)

The Code Assist API (`cloudcode-pa.googleapis.com`) is not one of the providers that
`@earendil-works/pi-ai` ships, so the spawned `pi-coding-agent` runtime that drives sessions
has no built-in `google-code-assist` api. Bobbit closes that gap with a **generated provider
extension** rather than by patching the upstream package:

- A self-contained pi-coding-agent extension
  (`src/server/agent/google-code-assist-provider-extension.ts`) registers
  `api: "google-code-assist"` inside the agent runtime via `pi.registerProvider(...)`, with a
  custom `streamSimple` handler that talks directly to
  `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.
- The extension is loaded via the existing `--extension` plumbing for spawned agents so the
  `google-code-assist` API can become available without respawning. Before authentication it
  registers only the API/stream handler, with no `models[]` and no placeholder `apiKey`, so Pi
  cannot pick unauthenticated Code Assist as an implicit/default model. An auth watcher upgrades
  the registration once local OAuth, gateway token access, or `GOOGLE_CLOUD_ACCESS_TOKEN` is
  visible. The same path works for local and Docker-sandboxed sessions.
- The conversion/streaming core lives in `src/server/agent/google-code-assist.ts`
  (`convertContextToCodeAssist`, `codeAssistStream`, `parseCodeAssistStreamChunk`) and carries
  **no `pi-ai` import**, so the gateway and the embedded extension share one tested wire
  implementation. Gemini-native semantics (function calls, thinking, `thoughtSignature`
  replay) are preserved end to end.

This is why "log in with Google" and "paste a Gemini API key" remain genuinely different
integrations: the account path streams through Code Assist with a per-request Bearer token,
while the API-key `google` path uses the Gemini Developer API with `x-goog-api-key`. The full
rationale and the options that were rejected (patching pi-ai, an OpenAI-compatible proxy, a
CLI-backed runtime) are in [`docs/design/google-session-models.md`](design/google-session-models.md).

### Per-request token & project endpoint

The agent runtime does not hold a long-lived Google token. On each request the extension
fetches fresh runtime material from an authenticated gateway endpoint:

```
GET /api/sessions/:id/google-code-assist/token  →  { accessToken, projectId }
```

- `accessToken` comes from `getGoogleAccessToken()` (refreshes the stored OAuth token when
  needed); the OAuth **refresh** token is never returned.
- `projectId` comes from an explicit `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env
  var when set (see below), otherwise from `ensureCodeAssistProject()` which resolves/onboards
  the free-tier project and caches it.
- A definitive auth failure returns `401 { code: "GOOGLE_CODE_ASSIST_REAUTH" }` whose message
  tells the user to re-authenticate via Settings → Account → Google (Gemini) — **not** to add
  an API key. A token that is valid but whose project onboarding failed returns
  `502 { code: "GOOGLE_CODE_ASSIST_PROJECT" }`, so a project problem is never misreported as a
  re-auth requirement.

Keeping refresh on the gateway and fetching per request means a token that expires mid-session
is transparently renewed, and nothing Google-account-scoped has to be persisted inside the
sandbox.

### Project selection (free tier vs. paid Code Assist / GCA)

`ensureCodeAssistProject()` resolves and caches a free-tier project on first use (persisted in
`google-code-assist.json`). To route requests under a specific project — e.g. a paid Code
Assist / Gemini Code Assist subscription billed to a GCP project — set **`GOOGLE_CLOUD_PROJECT`**
or **`GOOGLE_CLOUD_PROJECT_ID`** in the gateway environment. An explicit value wins and skips
the `loadCodeAssist`/`onboardUser` onboarding entirely, mirroring the Gemini CLI's precedence.

### Provider isolation (unchanged)

The `OAUTH_AUTHENTICATED_PROVIDERS` allow-list in `src/server/agent/model-registry.ts`
(`anthropic`, `openai-codex`, `google-gemini-cli`) ensures only genuine OAuth providers are
authenticated via `auth.json`, so a `google-gemini-cli` account token can never make the
API-key-only `google` provider look usable. The two Gemini paths stay fully independent:
removing the account login leaves an API key working, and vice versa.

### Caveats: quota, tier, and account terms

Google account Gemini runs through the **Gemini Code Assist** API using the official Gemini
CLI installed-app OAuth client (see the OAuth client identity note above). Keep these caveats
in mind, which the model-selector / Settings copy also surface:

- This is **not** the AI Studio API path. Throughput is bound by your account's Code Assist
  quota/tier; the free tier can rate-limit. Quota / rate-limit responses (HTTP 429) surface as
  a clear provider error event in the session, not a silent stall.
- It depends on Google's continued allowance of the Gemini CLI client for non-CLI apps. If
  Google ever rejects that, the account row is disabled with a clear message while API-key
  Gemini (provider `google`) stays available — the always-working in-session fallback.
- A locked-down Docker sandbox that cannot reach `cloudcode-pa.googleapis.com` surfaces a
  clear error event; use the API-key `google` provider in that case.

---

## Token & sandbox propagation (high level)

The **primary** runtime credential path for `google-gemini-cli` session models is the
per-request gateway endpoint above — the provider extension fetches a fresh token + project id
over `BOBBIT_GATEWAY_URL` on each request, so refresh stays gateway-side and works the same in
local and Docker sessions.

The env/`auth.json` propagation below is a **fallback** for egress-restricted sandboxes and is
applied through the same partitioned path as the other account providers, but **only when
policy explicitly opts in** (least privilege; default is no Google credential in the sandbox).
This Google rule is stricter than Codex: Codex keeps its legacy permissive fallback when
`sandbox_tokens` is unset, but Google OAuth is never mounted by default.

- **Env var.** `src/server/agent/host-tokens.ts` maps provider `google-gemini-cli` to the
  sandbox env var `GOOGLE_CLOUD_ACCESS_TOKEN` (the var the Gemini CLI / google-auth honor for
  a pre-acquired Bearer token). This is deliberately distinct from the API-key `google` var
  (`GEMINI_API_KEY`) so the two never collide. Note: `GOOGLE_GENAI_USE_GCA=1` only affects the
  `@google/genai` SDK path; Bobbit's custom provider bypasses that SDK and streams Code Assist
  directly, so it does not depend on that flag.
- **Sanitized sandbox `auth.json`.** When the sandbox-token policy enables the Google entry
  (`sandboxTokenPolicyAllowsGoogleAuth`, key `GOOGLE_CLOUD_ACCESS_TOKEN`), the scoped
  read-only sandbox `auth.json` includes a sanitized `google-gemini-cli` credential
  containing only `{ type: "oauth", access, refresh?, expires? }`. `email`/profile/scope
  metadata is never copied into the sandbox. This mirrors the existing Codex sanitization
  pattern.
- **Freshness.** Gateway-side token resolution refreshes the access token before use; when the
  env/`auth.json` fallback is used, the sandbox carries the refresh token so it can re-mint an
  expired access token itself.

**Safety invariants** (unchanged from the rest of the auth pipeline): tokens are never
logged (error bodies are truncated and redacted), `GET /api/oauth/status` and
`GET /api/provider-keys` never echo `access`/`refresh`/`key` — `email` is the only new
non-secret field a status response may carry, and only because the UI shows the signed-in
account.

---

## Manual runtime verification

Automated tests cover provider partitioning, sanitized status, refresh failure modes, the
OAuth-capable allow-list, sandbox sanitization, the OAuth status/start/flow/complete/logout
routes (mocked Google endpoints), the Code Assist streaming conversion (text/tool/usage/abort
/re-auth), the token endpoint, the session-selectability of account models, and the Settings
UI (Account row + reload persistence, the Models Provider API Keys section, and the stale-path
regression). The following steps require a **real Google account** and are not part of CI; the
session-running steps mirror the manual integration gated by
`MANUAL_TEST_MODEL=google-gemini-cli/…`:

1. **Login round-trip.** Settings → Account → Google OAuth → **Log in**. Complete Google
   consent in the opened tab (or paste the redirect URL/code in remote-gateway setups).
   Confirm the row flips to **Authenticated** with an **Expires** time.
2. **Reload persistence.** Hard-reload Bobbit. The Google row must still show
   **Authenticated** (status is re-fetched from `auth.json`).
3. **Selectable account models.** Open the model selector. Account-backed Gemini models
   (`… (Google account)`) must appear **authenticated and session-selectable** (no disabled
   "Account only" state). Bind one to a session.
4. **Run a session turn.** With `google-gemini-cli/gemini-2.5-pro` (or another listed account
   model) selected, confirm the agent answers, **streams** output, **calls a tool**, receives
   the tool result, and **continues multi-turn** context. Under the hood this reaches
   `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` with a per-request Bearer
   token, resolving/onboarding a free-tier project on first use (cached in
   `google-code-assist.json`).
5. **Restart persistence.** Restart the session (or the gateway). The selected
   `google-gemini-cli/<model>` must be re-pinned with **no fallback** to another provider.
6. **Re-auth failure.** Let the access token expire (or revoke it) and trigger a turn. Confirm
   the session surfaces a clear **re-authenticate via Settings → Account → Google** error
   (`GOOGLE_CODE_ASSIST_REAUTH`) rather than a silent stall, and re-logging-in restores it.
7. **Project selection.** Set `GOOGLE_CLOUD_PROJECT` (or `GOOGLE_CLOUD_PROJECT_ID`) and confirm
   requests route under that project, skipping free-tier onboarding. Note expected quota /
   rate-limit (HTTP 429) behavior on the free tier — it should appear as a provider error.
8. **API-key fallback unchanged.** Add a Google AI Studio key under Settings → Models →
   Provider API Keys and confirm Gemini Developer API (`google`) models remain fully
   session-selectable and complete normally — independent of account login.
9. **Logout isolation.** Log out of Google and confirm `anthropic`, `openai-codex`, and any
   API-key-only `google` credential are untouched, and that no token material appears in any
   response or log.
