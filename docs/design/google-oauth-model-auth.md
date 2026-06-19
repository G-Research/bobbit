# Google OAuth for Gemini models

Status: design (no production code in this change)
Goal: `google-oauth-m-d4c9a4df` — add first-class Google account authentication for Gemini
models alongside the existing Anthropic and OpenAI account login flows.

This document is the authoritative implementation plan. It is the output of the `design-doc`
gate. It deliberately edits **only** `docs/design/google-oauth-model-auth.md`; no `src/`,
tests, package files, or `AGENTS.md` are touched. All file paths/functions named below are the
exact targets for the follow-up implementation task.

---

## 1. Audit of the existing auth pipeline

### 1.1 OAuth handler — `src/server/auth/oauth.ts`

- `export type OAuthProviderId = "anthropic" | "openai-codex"`.
- `normalizeProvider(provider)` maps `undefined|"anthropic" → "anthropic"`, `"openai"|"openai-codex"
  → "openai-codex"`, throws otherwise. **This is the single choke point for provider isolation.**
- Two flow shapes:
  - **Anthropic (native):** PKCE generated server-side (`generatePKCE`), authorize URL built in
    `oauthStart`, code→token exchanged directly in `oauthComplete` against `TOKEN_URL`
    (`https://console.anthropic.com/v1/oauth/token`). Refresh in `refreshOAuthToken()`.
  - **External (pi-ai):** `oauthStartExternal(provider)` calls `getOAuthProvider(provider)` from
    `@earendil-works/pi-ai/oauth` and drives the `OAuthLoginCallbacks` (`onAuth`, `onDeviceCode`,
    `onPrompt`, `onManualCodeInput`, `onSelect`, `onProgress`). Credentials are persisted by
    `storeOAuthCredentials(provider, credentials)`.
- Storage: `globalAuthPath()` → `~/.bobbit/agent/auth.json`, written 0600 via `writeAuthData`,
  which calls `clearOAuthCache()`. Shape per provider key: `{ type: "oauth", access, refresh,
  expires, ... }`. Anthropic bakes a 5-minute safety buffer into `expires`.
- `oauthStatus(provider)` returns only `{ authenticated, expires, provider }` — **never echoes
  token material** ("strict-OAuth contract"). `oauthFlowStatus(flowId, provider)` cross-checks the
  flow's stored provider against the query param to avoid cross-provider status leaks.
- `refreshOAuthToken()` is **Anthropic-only today** (`authData.anthropic`). It only clears
  credentials on definitive auth failures (400/401/403); transient 5xx/429/network errors keep the
  stored credential.
- In-memory `pendingFlows` map (5-min TTL, swept by `ensureFlowCleanupTimer`). Anthropic flows hold
  a `verifier`; external flows hold `submitCode`/`rejectCode`/`loginPromise`/`completed`/`error`.

### 1.2 REST surface — `src/server/server.ts` (`handleApiRoute`)

- `GET  /api/oauth/status?provider=` → `oauthStatus`
- `GET  /api/oauth/flow-status?flowId=&provider=` → `oauthFlowStatus`
- `POST /api/oauth/start` `{ provider }` → `oauthStart`
- `POST /api/oauth/complete` `{ flowId, code }` → `oauthComplete`
- Provider **API keys** (separate from OAuth): `GET /api/provider-keys`, `POST/DELETE
  /api/provider-keys/:provider`. **These write `preferencesStore` under `providerKey.<provider>`,
  NOT `auth.json`.** `POST /api/pi-ai/provider-key-test` → `testProviderApiKey`.

### 1.3 Settings UI — `src/app/settings-page.ts` + `src/app/dialogs.ts`

- System tabs: `SYSTEM_TABS` includes `{ id: "account", label: "Account" }` and `{ id: "models" }`.
- Account tab: `type AccountProviderId = "anthropic" | "openai-codex"`, array `ACCOUNT_PROVIDERS`,
  `loadAccountStatus()`, `handleReauthenticate()`, `renderAccountTab()`. The "Log in /
  Re-authenticate" button calls `openOAuthDialog(provider)`.
- OAuth dialog: `openOAuthDialog(provider)` in `src/app/dialogs.ts` — `POST /api/oauth/start`,
  opens `data.url` in a tab, polls `flow-status` when `callbackServer === true`, and offers a
  manual "paste the full redirect URL or authorization code" field that posts to
  `/api/oauth/complete`. `providerName` is derived: `openai-codex|openai → "OpenAI"` else
  `"Anthropic"`.
- **Settings drift (goal requirement #9):** the current Models tab (`renderModelsTab`, line ~2004)
  renders only **AI Gateway** + custom-provider config. It contains **no per-provider API-key
  input** — `grep -c "ProviderKeyInput|provider-key" src/app/settings-page.ts` → `0`. The legacy
  per-provider key UI lives in `src/ui/dialogs/ProvidersModelsTab.ts` (uses
  `src/ui/components/ProviderKeyInput.ts` + `/api/provider-keys`) but is **not wired into any
  current settings tab** (`getTabsForScope`). So a user told to "enter a Gemini API key in
  Providers & Models" lands on a screen that no longer exists.

### 1.4 Model registry — `src/server/agent/model-registry.ts`

- `assembleModels(prefs)` pulls pi-ai built-ins (`getProviders()` / `getModels(providerId)`),
  merges OpenAI additions, then AI-Gateway and custom providers.
- Auth detection: `detectProviderAuth(provider, prefs)` → true if `prefs.get("providerKey.<p>")`,
  or `process.env[ENV_MAP[p]]`, or `hasOAuthCredentials(p)` (reads `auth.json`, 10s cache via
  `oauthCache` / `clearOAuthCache`). `ENV_MAP` already contains `google → GOOGLE_API_KEY`,
  `google-gemini-cli → GOOGLE_API_KEY`, `google-vertex → GOOGLE_APPLICATION_CREDENTIALS`.
- `hasOAuthCredentials(provider)` currently returns true if `authData[provider]` exists — so a new
  `auth.json` key is automatically honored once present.
- Gemini ranking already exists in the priority function (`gemini-3.1-pro`, `gemini-2.5-pro`, …).

### 1.5 Runtime completion — `src/server/agent/model-completion.ts`

- `PROVIDER_ENV_KEYS` includes `google: ["GEMINI_API_KEY","GOOGLE_API_KEY"]` and
  `"google-gemini-cli": ["GEMINI_API_KEY","GOOGLE_API_KEY"]`.
- `resolveProviderApiKey(prefs, provider)` precedence: `providerKey.<p>` → env keys →
  `authCredentialForProvider(p)` (with **Anthropic-only** refresh on expiry) → custom provider →
  `models.json`. Returns a single string handed to pi-ai as `options.apiKey`.
- `completeModelText` (gateway-side helpers: title/name/test) calls pi-ai `completeSimple` with
  `{ apiKey }`. pi-ai's `google` provider (`@earendil-works/pi-ai/google`, api
  `google-generative-ai`) constructs `new GoogleGenAI({ apiKey, httpOptions })` — the key is sent
  as `x-goog-api-key` to `https://generativelanguage.googleapis.com/v1beta`. **It has no bearer/
  OAuth code path.** `createClient` does merge `model.headers` + `options.headers`, so a custom
  `Authorization` header can be injected, but that does not change the `generativelanguage`
  endpoint, which does not accept consumer OAuth tokens for `generateContent`.

### 1.6 Sandbox credential propagation

- `src/server/agent/host-tokens.ts`:
  - `PROVIDER_TOKENS` maps provider → sandbox env var. Google entry today: `{ envVar:
    "GEMINI_API_KEY", provider: "google", envKeys: ["GEMINI_API_KEY"] }`.
  - `detectHostTokens(prefs)` / `resolveHostTokenValue(envVar, prefs)` resolve a token value from
    env → `providerKey.<provider>` → `auth.json` (`oauth.access` or `api_key.key`).
  - `buildSandboxAgentAuthJson()` / `ensureSandboxAgentAuthFile()` write a **scoped, sanitized**
    `auth.json` that is bind-mounted read-only into the sandbox. Today it only emits the
    `openai-codex` OAuth/key entry when `includeCodexAuth` policy allows; `sanitizeCodexCredential`
    copies only `{type, access, refresh?, expires?}` (or `{type, key}`), dropping profile metadata.
- `src/server/agent/docker-args.ts`: mounts the scoped `auth.json` read-only at
  `/home/node/.bobbit/agent/auth.json`; never mounts the full host agent dir. Sandbox credentials
  are also injected as `-e KEY=VALUE` env vars (validated key regex).

### 1.7 pi-ai OAuth capability (verified against installed dist)

`@earendil-works/pi-ai/oauth` exports providers for **Anthropic, GitHub Copilot, OpenAI Codex
only**. `getOAuthProvider(id)` returns `undefined` for `"google"`. There is `registerOAuthProvider`
to add a custom provider implementing `OAuthProviderInterface` (`login`, `refreshToken`,
`getApiKey`, optional `modifyModels`, `usesCallbackServer`). pi-ai runtime providers are `google`
(`google-generative-ai`) and `google-vertex` — **no Code Assist / `cloudcode-pa` provider exists**.

---

## 2. Research: official Google auth surfaces for Gemini

No browser-cookie scraping, no `gemini.google.com` session extraction, no undocumented endpoints.
Three officially-supported surfaces exist; only two are relevant.

### 2.1 Gemini Developer API — `generativelanguage.googleapis.com` (API key, the fallback)

- Primary auth is an **API key** (`x-goog-api-key`), created in Google AI Studio. This is exactly
  what pi-ai's `google` provider already does. **Keep this as the always-working fallback.**
- OAuth 2.0 is supported by this API only for a subset of methods (e.g. tuned-model / semantic-
  retrieval resources) and, for `generateContent`, requires the API enabled on a GCP project with a
  billing/quota project attached. There is **no officially-supported consumer-account OAuth path to
  `generateContent` on `generativelanguage` without a GCP project**. We therefore do **not** claim
  that "log in with Google" makes the `google` (Developer API) provider work; that provider stays
  API-key only.

### 2.2 Gemini Code Assist API — `cloudcode-pa.googleapis.com` (OAuth, the account path)

This is the surface the official **Gemini CLI** uses for "Login with Google" (personal account,
free Code Assist tier). Verified from `google-gemini/gemini-cli`
(`packages/core/src/code_assist/oauth2.ts` and `server.ts`):

- **OAuth client (installed app, public — secret is intentionally non-secret per Google's installed-
  app guidance):**
  - client_id: `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com`
  - client_secret: a public `GOCSPX-…` installed-app secret published in the Gemini CLI source
    (`packages/core/src/code_assist/oauth2.ts`, `OAUTH_CLIENT_SECRET`). Per Google's installed-app
    guidance it is not treated as secret; the implementation should read the literal value from that
    upstream source. (Not pasted here so GitHub push-protection / secret-scanning does not flag the
    design doc.)
- **Scopes:**
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
- **OAuth endpoints (standard Google):**
  - authorize: `https://accounts.google.com/o/oauth2/v2/auth` (PKCE S256, `access_type=offline`,
    `prompt=consent` to guarantee a `refresh_token`)
  - token: `https://oauth2.googleapis.com/token`
  - revoke: `https://oauth2.googleapis.com/revoke`
  - userinfo: `https://www.googleapis.com/oauth2/v3/userinfo`
  - redirect: **loopback** (`http://localhost:<port>/oauth2callback`). OOB is deprecated by Google;
    a loopback redirect on the gateway host is the supported installed-app pattern.
- **Inference endpoints (Bearer access token):** base `https://cloudcode-pa.googleapis.com`, version
  `v1internal`:
  - `:loadCodeAssist` — discover tier + whether onboarding is needed.
  - `:onboardUser` — long-running; resolves the free-tier project the request runs under.
  - `:generateContent` / `:streamGenerateContent` — Code Assist wraps the standard
    `GenerateContent` request/response (the CLI's `toGenerateContentRequest` /
    `fromGenerateContentResponse` converters wrap/unwrap `{ project, request: {...} }`).
  - `:countTokens` (optional).
- **Token response:** `{ access_token, refresh_token?, expires_in, scope, token_type:"Bearer" }`.
  Refresh via `grant_type=refresh_token` at the token endpoint (refresh_token usually not rotated).

### 2.3 Vertex AI — out of scope

`google-vertex` (ADC/service-account, GCP project required) already exists in pi-ai. Not part of the
consumer "log in with Google" story; documented here only so the design does not collide with it.

### 2.4 Consequence / honest constraint

The consumer Google-account credential is a **Bearer OAuth token usable only against the Code Assist
API**, which is a *different wire protocol and endpoint* from the API-key Gemini Developer API.
There is no supported way to feed a consumer OAuth token to pi-ai's existing `google` provider. So
"Gemini usable without an API key" requires a **Code Assist-compatible runtime** (§4), not merely a
new credential. This constraint must be surfaced in the UI/docs (goal constraint: "If consumer
Gemini subscription cannot be used via an official model API, surface that clearly").

---

## 3. Design overview

- **New OAuth provider id: `google-gemini-cli`** (kebab, matches the id already present in
  `ENV_MAP` and `PROVIDER_ENV_KEYS`). It is the **OAuth/Code-Assist** account provider.
- **`google` stays the API-key Gemini Developer API provider** (fallback). Provider isolation: the
  two never share a flow id or an `auth.json` key.
- `auth.json` gains a `"google-gemini-cli"` entry: `{ type:"oauth", access, refresh, expires,
  email? }`. `email` is non-secret display metadata (from userinfo); tokens are never returned by
  any `/status` response.
- The account row, status, refresh, and sandbox propagation reuse the existing partitioned plumbing.
- The runtime is implemented **natively in Bobbit** (option B below), not via pi-ai, because pi-ai
  ships no Code Assist provider and we should not block on an upstream change.

Provider-id decision (recorded so it is not re-litigated): native Bobbit flow in `oauth.ts` rather
than a pi-ai `registerOAuthProvider` custom provider — the Anthropic path is already native, the
loopback+manual-paste UX is gateway-specific, and it avoids coupling login to an upstream provider
registry. pi-ai's `registerOAuthProvider` remains available if we later want agent-session parity
through pi-ai (§4.3).

---

## 4. Implementation plan (exact files / functions)

### 4.1 OAuth flow — `src/server/auth/oauth.ts`

1. Extend the union: `export type OAuthProviderId = "anthropic" | "openai-codex" |
   "google-gemini-cli"`. Add label `"google-gemini-cli": "Google"` to `OAUTH_PROVIDER_LABELS`.
2. `normalizeProvider`: map `"google" | "google-gemini-cli" | "gemini"` → `"google-gemini-cli"`.
   (Accept `"google"` as an alias from the UI but store under the canonical id.)
3. Add Google constants near the Anthropic block:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_URL`
   (`https://accounts.google.com/o/oauth2/v2/auth`), `GOOGLE_TOKEN_URL`
   (`https://oauth2.googleapis.com/token`), `GOOGLE_REVOKE_URL`, `GOOGLE_USERINFO_URL`,
   `GOOGLE_SCOPES` (the three §2.2 scopes, space-joined).
4. New pending-flow variant `PendingGoogleOAuth { provider:"google-gemini-cli"; verifier; state;
   redirectUri; server?: http.Server; createdAt }`; add to the `PendingOAuth` union and to
   `cleanupExpiredFlows` (close the loopback server on expiry).
5. `oauthStart`: when provider is `google-gemini-cli`, call new `oauthStartGoogle()`:
   - Start a **loopback callback server** on `127.0.0.1:0` (ephemeral port) bound to path
     `/oauth2callback`. `redirect_uri = http://localhost:<port>/oauth2callback`.
   - Generate PKCE (`generatePKCE`) + random `state`.
   - Build authorize URL with `client_id, response_type=code, redirect_uri, scope, state,
     code_challenge, code_challenge_method=S256, access_type=offline, prompt=consent`.
   - Return `{ flowId, url, provider, callbackServer: true }` (so the dialog auto-polls). The
     loopback handler, on receiving `?code=&state=`, validates `state`, calls the shared
     `exchangeGoogleCode()` then redirects the browser to a success page and marks the flow
     complete; on error sets `flow.error`.
   - Keep the manual-paste path working: `oauthComplete(flowId, code)` for a Google flow accepts a
     pasted authorization code **or** a full redirect URL (parse `code`+`state`), then calls
     `exchangeGoogleCode()`. This mirrors the existing dialog affordance and makes remote-gateway
     setups (where the user's browser cannot reach the gateway loopback) still work.
6. `exchangeGoogleCode(flow, code, state)` (shared by loopback + paste): POST to `GOOGLE_TOKEN_URL`
   with `grant_type=authorization_code, code, client_id, client_secret, redirect_uri, code_verifier`.
   On success, optionally GET `GOOGLE_USERINFO_URL` for `email`. Persist via
   `storeOAuthCredentials("google-gemini-cli", { access, refresh, expires: Date.now()+expires_in*1000
   - 5*60*1000, email })`. Truncate error bodies (reuse the 256-char cap), and `redactSensitive` any
   logged string.
7. `oauthStatus("google-gemini-cli")`: already generic — works once `normalizeProvider` accepts the
   id; returns `{ authenticated, expires, provider }` only. Add `email` to the returned shape **only
   if** we decide to show the signed-in account; it is non-secret. Tokens stay omitted.
8. `oauthFlowStatus`: generic; the provider cross-check already guards isolation.
9. **Generalize refresh**: rename/extend `refreshOAuthToken()` to take a provider, or add
   `refreshGoogleToken()`. For `google-gemini-cli`: skip if `Date.now() < expires`; else POST
   `grant_type=refresh_token, refresh_token, client_id, client_secret` to `GOOGLE_TOKEN_URL`; on
   400/401/403 delete the stored entry; on 5xx/429/network keep it (mirror Anthropic's policy).
   Persist new `{access, refresh: new ?? old, expires}` and `clearOAuthCache()`.

### 4.2 Settings Account row — `src/app/settings-page.ts`

1. `type AccountProviderId = "anthropic" | "openai-codex" | "google-gemini-cli"`.
2. Append to `ACCOUNT_PROVIDERS`:
   ```
   { id: "google-gemini-cli", title: "Google (Gemini)",
     description: "OAuth credentials for Gemini via the Google Code Assist API (personal Google
       account). Used by agent sessions for Gemini models. For Google AI Studio API keys, use
       Settings → Models → API keys.",
     authenticatedLabel: "Authenticated" }
   ```
   `loadAccountStatus`, `handleReauthenticate`, `renderAccountTab` are already provider-generic and
   need no further change.
3. `src/app/dialogs.ts`: extend `providerName` derivation in `openOAuthDialog` so
   `google-gemini-cli|google|gemini → "Google"`. The rest of the dialog (start/poll/paste) is
   provider-agnostic.

### 4.3 Runtime: making Gemini usable from the OAuth credential

Two consumers exist; both need the Code Assist path because pi-ai's `google` provider is API-key only.

**(a) Gateway-side helper completions** (title/name/connection-test in
`src/server/agent/model-completion.ts`): add a small Code Assist adapter
`src/server/agent/google-code-assist.ts`:
   - `getGoogleAccessToken(prefs)` → reuse `refreshGoogleToken()` to return a fresh Bearer token.
   - `ensureCodeAssistProject(token)` → cached `loadCodeAssist`/`onboardUser` result (projectId);
     persist the resolved projectId in `models.json`/preferences to avoid re-onboarding.
   - `codeAssistGenerate({ model, systemPrompt, messages, maxTokens, token, projectId })` →
     POST `https://cloudcode-pa.googleapis.com/v1internal:generateContent` (or
     `:streamGenerateContent`) with `Authorization: Bearer <token>` and the Code-Assist-wrapped
     body `{ model, project, request: { contents, systemInstruction, generationConfig } }`; unwrap
     `response.response.candidates[...]` back to text.
   - In `completeModelText`, branch on `model.provider === "google-gemini-cli"` to use this adapter
     instead of pi-ai `completeSimple`. `resolveProviderApiKey` is bypassed for this provider (it
     returns a Bearer token, not an API key).

**(b) Agent sessions** (pi-coding-agent inside the sandbox, which uses pi-ai): pi-ai has no Code
Assist provider, so there are two viable options — the design recommends option (i) and lists (ii)
as the upstream-parity alternative:
   - **(i) Register a Bobbit custom pi-ai provider** at startup via `registerOAuthProvider({ id:
     "google-gemini-cli", login, refreshToken, getApiKey, usesCallbackServer:true })` **plus** a
     runtime stream function for api `"google-code-assist"` registered with pi-ai, pointing
     `baseUrl` at `cloudcode-pa.googleapis.com/v1internal` and sending the Bearer token via
     `httpOptions.headers.Authorization`. The model-registry would emit `google-gemini-cli` models
     with `api: "google-code-assist"`.
   - **(ii) Upstream:** contribute a `cloudcode-pa` provider to `@earendil-works/pi-ai`. Cleaner
     long-term; out of this goal's control. Until then, ship (i) or scope agent-session Gemini to
     API-key `google`.

The follow-up implementation task should treat §4.1/§4.2/§4.5 (auth, UI, fallback) as **must-ship**,
and §4.3 runtime as the substantive engineering item, implemented as (a) for gateway helpers first,
then (b)(i) for agent sessions. If (b)(i) proves too large for one iteration, the UI copy from §4.2
already tells the user the credential targets the Code Assist API, and API-key `google` remains the
working inference path — acceptance criterion "API-key Google auth remains possible and discoverable"
is still met.

### 4.4 Model registry / auth detection — `src/server/agent/model-registry.ts`

- `ENV_MAP` already has `google-gemini-cli`. `detectProviderAuth("google-gemini-cli", prefs)` will
  return true once `auth.json["google-gemini-cli"]` exists (via `hasOAuthCredentials`). Confirm
  `hasOAuthCredentials` treats a `{type:"oauth"}` entry whose `access` may be expired correctly —
  for the **selector** we want "authenticated = credential present" (expired is still "logged in,
  needs refresh"), matching how Anthropic behaves. No change needed beyond emitting the models.
- Emit `google-gemini-cli` Gemini models: either map the same Gemini ids as the `google` provider
  under provider `google-gemini-cli` with `api:"google-code-assist"` (for path (b)(i)), or, in the
  fallback-only iteration, surface them through provider `google` (API key) unchanged. Gemini
  ranking in the priority function already covers the ids.

### 4.5 API-key fallback discoverability (Settings drift fix) — `src/app/settings-page.ts`

- Add a **"Model provider API keys"** section to `renderModelsTab()` (the live Models tab), reusing
  the legacy component `src/ui/components/ProviderKeyInput.ts` and the existing `/api/provider-keys`
  endpoints. Include at minimum Anthropic, OpenAI, **Google (`google`, Gemini Developer API key)**,
  xAI, Groq, Mistral, OpenRouter — i.e. salvage the rows from `src/ui/dialogs/ProvidersModelsTab.ts`
  into the current tab so the entry point exists where users are sent.
- Add an explicit helper line distinguishing the two Google options:
  - "**Google account (Gemini)**" → Settings → Account → Google (OAuth / Code Assist).
  - "**Google AI Studio API key**" → this Models tab field (provider `google`).
- Either delete `src/ui/dialogs/ProvidersModelsTab.ts` (dead) or repoint it; do not leave two
  competing UIs. Update any docs/onboarding copy that references a "Providers & Models" screen.

### 4.6 Sandbox credential propagation — `src/server/agent/host-tokens.ts` (+ `docker-args.ts`)

- Add a `PROVIDER_TOKENS` entry for the OAuth provider so detection/resolution see it:
  `{ envVar: "GOOGLE_CLOUD_ACCESS_TOKEN", label: "Google (Gemini Code Assist OAuth)", provider:
  "google-gemini-cli", envKeys: ["GOOGLE_CLOUD_ACCESS_TOKEN"] }`. (`GOOGLE_CLOUD_ACCESS_TOKEN` is
  the env var the Gemini CLI / google-auth honor for a pre-acquired Bearer token, paired with
  `GOOGLE_GENAI_USE_GCA=1`.)
- `resolveHostTokenValue("GOOGLE_CLOUD_ACCESS_TOKEN", prefs)`: return a **freshly refreshed** access
  token (call `refreshGoogleToken()`), not the possibly-expired stored value.
- Extend the sanitized sandbox `auth.json` builder (`buildSandboxAgentAuthJson` /
  `sanitizeCodexCredential` pattern) to optionally include a sanitized `google-gemini-cli` entry
  `{type:"oauth", access, refresh?, expires?}` when a sandbox-token policy entry enables it — mirror
  `sandboxTokenPolicyAllowsCodexAuth` with a `GOOGLE_*` allow-set. Never copy `email`/profile fields
  into the sandbox file. Default remains an empty object unless policy opts in (provider isolation +
  least privilege preserved).
- `docker-args.ts` needs no structural change: it already mounts the scoped `auth.json` and injects
  allowed sandbox tokens as env vars; the new entry rides those existing paths.

### 4.7 Logging / safety invariants (must hold)

- Reuse `redactSensitive` for every Google log line and error body; truncate provider error bodies
  (256-char cap already in `oauthComplete`).
- `/api/oauth/status` and `/api/provider-keys` (GET) must never include `access`/`refresh`/`key`.
  `email` is the only new non-secret field permitted in a status response, and only if shown in UI.
- Provider isolation: `google-gemini-cli` flow ids live in the same `pendingFlows` map but
  `oauthFlowStatus`'s provider cross-check prevents cross-provider reads; `normalizeProvider` is the
  only mapping authority; `auth.json` key is dedicated and never shared with `google`/`anthropic`/
  `openai-codex`.

---

## 5. Test plan (for the tester / follow-up tasks — not written in this change)

Unit (node, `tests/*.test.ts`):
- `normalizeProvider` accepts `google`/`google-gemini-cli`/`gemini` → canonical id; rejects unknown.
- `oauthStatus("google-gemini-cli")` never returns `access`/`refresh`; returns `{authenticated,
  expires}` for present/expired/absent credentials.
- `exchangeGoogleCode` / refresh: mock `fetch` — success persists sanitized `{type:"oauth",access,
  refresh,expires}`; 400/401/403 clears, 5xx/429 retains. Assert `auth.json` chmod 0600.
- Provider isolation: a Google flow id queried with `provider=anthropic` → `flow not found`.
- `host-tokens`: `resolveHostTokenValue("GOOGLE_CLOUD_ACCESS_TOKEN")` returns refreshed token;
  `buildSandboxAgentAuthJson` includes the Google entry only when policy allows and emits only
  sanitized fields (no `email`).
- `detectProviderAuth("google-gemini-cli")` true when `auth.json` entry present.

API E2E (`tests/e2e/*.spec.ts`):
- `POST /api/oauth/start {provider:"google-gemini-cli"}` returns a flow id + `accounts.google.com`
  authorize URL with the three scopes, `code_challenge`, `access_type=offline` (mock outbound).
- `flow-status`/`complete` happy + error paths with mocked Google token endpoint.

Browser E2E (`tests/e2e/ui/settings.spec.ts` pattern):
- Account tab shows three providers incl. "Google (Gemini)"; clicking "Log in" opens the OAuth
  dialog (stub `/api/oauth/*`); status flips to Authenticated; **persists across reload**.
- Models tab now renders a Google AI Studio API-key field; entering/removing a key round-trips via
  `/api/provider-keys` and persists across reload. **Regression test for goal AC #5** — assert the
  API-key entry point is present in the current Settings (guards the drift from re-appearing).

Manual integration (`tests/manual-integration/`, gate-exempt): real Google account → Account login →
reload persists → a Gemini model is selectable and (when §4.3 runtime lands) returns a completion
via Code Assist without an API key; document the exact steps + the project/onboarding behavior.

---

## 6. Acceptance-criteria traceability

| Goal AC | Covered by |
|---|---|
| Login Google, reload, still authenticated | §4.1 storage + §4.2 row + browser E2E persistence |
| Gemini usable without API key (where supported) | §4.3 Code Assist runtime; §2.4 honest constraint surfaced in §4.2 copy |
| Anthropic/OpenAI OAuth unchanged | §4.1 additive `normalizeProvider`/union; no edits to their branches |
| API-key Google remains possible + discoverable | §4.5 Models-tab key field + §2.1 fallback |
| Regression test for missing settings path | §5 browser E2E asserting the API-key entry exists |

## 7. Out of scope / explicitly avoided

- No `gemini.google.com` cookie/session scraping, no browser-profile extraction, no undocumented
  endpoints (goal constraint). Only the official installed-app OAuth client + Code Assist /
  Developer APIs are used.
- Vertex AI (`google-vertex`) integration beyond not colliding with it.
- Shipping the pi-ai upstream Code Assist provider (§4.3 b-ii) — tracked as a follow-up.
