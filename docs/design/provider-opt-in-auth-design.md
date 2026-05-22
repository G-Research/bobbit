# Provider Opt-In Auth — Technical Design

Implementation reference: final user/API behavior is documented in [../provider-opt-in-auth.md](../provider-opt-in-auth.md). This file preserves the design context that led to the implementation.

## Goal

Make Anthropic, OpenAI, and Google Gemini direct-cloud access an explicit user choice. Bobbit must not require Anthropic, must not surface cloud-provider auth UX when AI Gateway is configured, and must never auto-select an unauthenticated cloud model.

## Current state from code research

Relevant paths and current behavior:

- `src/app/session-manager.ts::authenticateGateway()` writes gateway URL/token, checks `/api/health`, and currently opens Anthropic OAuth on non-local/non-AI-Gateway connections via `checkOAuthStatus()` + `openOAuthDialog()`.
- `src/app/dialogs.ts::checkOAuthStatus()` and `openOAuthDialog(provider)` default to Anthropic; provider labels only distinguish Anthropic vs OpenAI.
- `src/app/settings-page.ts::renderAccountTab()` has two OAuth rows: `anthropic` and `openai-codex`; no provider enablement state; no Google row.
- `src/server/auth/oauth.ts` supports `OAuthProviderId = "anthropic" | "openai-codex"`; Anthropic is hand-coded PKCE/manual paste; OpenAI uses `@earendil-works/pi-ai/oauth::getOAuthProvider("openai-codex")` and callback polling.
- `src/server/server.ts` exposes:
  - `GET/PUT /api/preferences` with `providerKey.*` filtered from reads.
  - `GET/POST/DELETE /api/provider-keys/:provider` storing `providerKey.<provider>`.
  - `GET /api/models`, `GET /api/image-models`, `POST /api/models/test`, `GET/POST /api/oauth/*`.
- `src/server/agent/model-registry.ts::getAvailableModels()` returns all pi-ai built-in providers when `aigw.exclusive` is false, marks `authenticated` from `providerKey.*`, env vars, or any `auth.json` provider entry, and only hides built-ins when AI Gateway exclusive mode is active.
- `src/server/agent/image-generation.ts` always includes built-in OpenAI + Google image models; `defaultImageModelPref()` is `openai/gpt-image-2`; auth is API-key/Codex-OAuth for OpenAI and API key/host token for Google.
- `@earendil-works/pi-ai@0.74.0` OAuth exports built-ins for Anthropic, GitHub Copilot, and OpenAI Codex only. There is no registered Google OAuth provider. The pi-ai Google provider currently constructs `GoogleGenAI({ apiKey })`; Vertex can use ADC but needs project/location.
- Existing tests to preserve/extend:
  - OAuth: `tests/e2e/oauth-flow-status.spec.ts`, `tests/oauth-complete-empty-code.test.ts`.
  - AI Gateway/model filtering: `tests/e2e/models-api.spec.ts`, `tests/e2e/aigw-*.spec.ts`, `tests/aigw-*.test.ts`.
  - Settings account/UI: `tests/e2e/ui/settings.spec.ts`, `tests/settings-models-tab-redesign.spec.ts`.
  - Image credentials/models: `tests/image-generation-registry.test.ts`, `tests/e2e/image-generation-providers.spec.ts`, `tests/e2e/ui/image-model-picker.spec.ts`.

## Provider taxonomy

Use one user-facing cloud vendor id across UI, status APIs, model filtering, and prompting:

```ts
export type CloudProviderId = "anthropic" | "openai" | "google";
```

Provider-id mapping:

| Vendor | pi-ai/model providers | OAuth provider ids | API key prefs/env |
| --- | --- | --- | --- |
| `anthropic` | `anthropic` | `anthropic` | `providerKey.anthropic`, `ANTHROPIC_API_KEY` |
| `openai` | `openai`, `openai-codex` | `openai-codex` (alias `openai`) | `providerKey.openai`, `providerKey.openai-codex`, `OPENAI_API_KEY` |
| `google` | `google`, `google-gemini-cli` | `google` once supported | `providerKey.google`, `providerKey.google-gemini-cli`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, host token `GEMINI_API_KEY` |

Out of scope for this vendor toggle: `aigw`, custom/local providers, AWS Bedrock, xAI, Groq, Mistral, OpenRouter, etc. Those keep their current behavior unless an existing provider id maps to one of the three vendors above.

## Durable enablement source of truth

Store enablement in system preferences:

```txt
providerEnabled.anthropic: boolean
providerEnabled.openai: boolean
providerEnabled.google: boolean
```

Rules:

- Missing key means disabled for new installs.
- A one-time migration may set `providerEnabled.<vendor> = true` only for vendors with an existing credential in `auth.json`, `providerKey.*`, or relevant env/host token. This treats pre-existing credentials as prior opt-in and preserves current users; users can immediately opt out.
- Disabling a provider writes `false` and does not delete `auth.json` entries or `providerKey.*` values.
- Removing credentials (`DELETE /api/provider-keys/:provider` or future OAuth disconnect) does not disable the provider; status becomes `enabled without credential`.
- Successful OAuth/API-key setup from settings or the auth gate writes `providerEnabled.<vendor> = true`.
- `GET /api/preferences` may expose `providerEnabled.*` because it is not secret. It must continue filtering `providerKey.*`.

Add a shared server helper, for example `src/server/agent/cloud-provider-auth.ts`:

```ts
export const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
export function cloudVendorForModelProvider(providerId: string): CloudProviderId | undefined;
export function isProviderEnabled(prefs: PreferencesStore, vendor: CloudProviderId): boolean;
export function setProviderEnabled(prefs: PreferencesStore, vendor: CloudProviderId, enabled: boolean): void;
export function getCloudAuthStatus(prefs: PreferencesStore): Promise<CloudAuthStatus>;
export function hasAnyEnabledAuthenticatedCloudProvider(prefs: PreferencesStore): Promise<boolean>;
export function shouldBypassCloudAuthUx(prefs: PreferencesStore): boolean; // true when getAigwUrl(prefs) exists
```

Include `providerEnabled.*` in `model-registry.ts::getPrefsVersion()` so toggles invalidate the 5s model cache.

## Server status API

Add a single non-secret status endpoint in `src/server/server.ts` near preferences/provider-key routes:

### `GET /api/cloud-providers/status`

Response:

```ts
type ProviderStatusValue =
  | "disabled"
  | "enabled_without_credential"
  | "authenticated"
  | "expired"
  | "invalid"
  | "oauth_unavailable"
  | "aigw_bypass";

interface CloudProviderStatus {
  id: "anthropic" | "openai" | "google";
  label: string;
  enabled: boolean;
  configured: boolean;       // credential source exists, even if expired
  authenticated: boolean;    // valid credential usable now
  expired: boolean;
  needsReauth: boolean;      // enabled + configured + expired/invalid/refresh-failed
  status: ProviderStatusValue;
  credentialTypes: Array<"oauth" | "api_key" | "env" | "host_token">;
  oauthSupported: boolean;
  apiKeySupported: boolean;
  expires?: number;
  message?: string;          // redacted, no secrets
}

interface CloudAuthStatus {
  mode: "aigw" | "direct-cloud";
  aigwConfigured: boolean;
  authGateRequired: boolean; // direct-cloud only, no enabled authenticated cloud provider; callers still skip local/custom-only flows
  providers: CloudProviderStatus[];
}
```

Example with AI Gateway configured:

```json
{
  "mode": "aigw",
  "aigwConfigured": true,
  "authGateRequired": false,
  "providers": [
    { "id": "anthropic", "enabled": false, "configured": false, "authenticated": false, "expired": false, "needsReauth": false, "status": "aigw_bypass", "credentialTypes": [], "oauthSupported": true, "apiKeySupported": true }
  ]
}
```

Example direct-cloud with OpenAI enabled and authenticated:

```json
{
  "mode": "direct-cloud",
  "aigwConfigured": false,
  "authGateRequired": false,
  "providers": [
    { "id": "openai", "label": "OpenAI", "enabled": true, "configured": true, "authenticated": true, "expired": false, "needsReauth": false, "status": "authenticated", "credentialTypes": ["oauth"], "oauthSupported": true, "apiKeySupported": true }
  ]
}
```

### `PUT /api/cloud-providers/:provider`

Request:

```json
{ "enabled": true }
```

Behavior:

- Validate provider is one of `anthropic`, `openai`, `google`; 400 otherwise.
- Write `providerEnabled.<provider>`.
- Invalidate model cache and broadcast `preferences_changed`.
- Do not mutate credentials.

Response:

```json
{ "ok": true, "provider": "openai", "enabled": true }
```

### Provider-key endpoints

Keep existing shapes, but extend `POST /api/provider-keys/:provider` to enable the owning vendor by default after a valid save:

```json
{ "key": "...", "enable": true }
```

- `enable` defaults to `true` for known cloud providers.
- `DELETE /api/provider-keys/:provider` removes only the key.
- Both endpoints must invalidate model caches and broadcast preferences.

## OAuth API changes

Update `src/server/auth/oauth.ts`:

- Widen normalized OAuth provider ids to include aliases while keeping storage stable:

```ts
type OAuthProviderId = "anthropic" | "openai-codex" | "google";
function normalizeProvider(input?: string | null): OAuthProviderId;
```

Alias rules:

```txt
undefined, "anthropic" -> "anthropic"
"openai", "openai-codex" -> "openai-codex"
"google", "gemini", "google-gemini" -> "google"
```

- Preserve existing endpoint wire shapes:
  - `POST /api/oauth/start` request `{ provider: string }` response `{ flowId, url, provider, callbackServer?, instructions? }`.
  - `POST /api/oauth/complete` request `{ flowId, code }` response `{ success, error? }`.
  - `GET /api/oauth/status?provider=` response `{ provider, authenticated, expires?, configured?, needsReauth? }`; no bearer/API key values.
- On successful OAuth completion, also enable the owning cloud provider:
  - `anthropic` -> `providerEnabled.anthropic = true`
  - `openai-codex` -> `providerEnabled.openai = true`
  - `google` -> `providerEnabled.google = true`

Implementation note: `oauth.ts` currently has no access to `preferencesStore`. Either:

1. Pass `preferencesStore` into `oauthStart/oauthComplete/oauthStatus` from `server.ts`; or
2. Keep OAuth storage pure and let `server.ts` enable after successful `oauthComplete` based on returned provider.

Prefer option 2 to avoid coupling auth storage to preferences.

### Token refresh and prompting

Generalize Anthropic-only `refreshOAuthToken()` into provider-scoped helpers:

```ts
export async function refreshOAuthToken(providerInput: string): Promise<string | null>;
export async function refreshConfiguredOAuthProviders(providers: CloudProviderId[]): Promise<Record<CloudProviderId, "ok" | "not_configured" | "expired" | "failed">>;
```

Rules:

- Refresh is attempted only for enabled + configured OAuth providers.
- Disabled providers are skipped, even if expired tokens exist.
- Never prompt from `GET /api/oauth/status` alone; status reports `needsReauth`.
- Do not clear credentials on transient failures. Keep the existing Anthropic behavior of clearing only on definitive 400/401/403 revocation/invalid-token responses.
- Any log/error returned through REST must pass the existing `redactSensitive()` path.

## Google OAuth plan

`@earendil-works/pi-ai@0.74.0` does not register a Google OAuth provider. Implement Google behind Bobbit's OAuth provider abstraction so the rest of the UI/API is provider-agnostic.

Preferred implementation path:

1. Add `src/server/auth/google-oauth.ts` implementing the same start/complete/refresh interface used by `oauthStartExternal()`.
2. Use Google OAuth installed-app/loopback PKCE flow where a Bobbit Google OAuth client id/secret is available. The flow should request only the documented Gemini OAuth scopes:
   - `https://www.googleapis.com/auth/generative-language.retriever`
   - Add `https://www.googleapis.com/auth/cloud-platform` only when using Vertex/ADC mode.
3. Store credentials in `auth.json` under `google`:

```json
{
  "google": {
    "type": "oauth",
    "access": "<redacted>",
    "refresh": "<redacted>",
    "expires": 1760000000000,
    "scopes": ["https://www.googleapis.com/auth/generative-language.retriever"]
  }
}
```

4. For runtime use:
   - If pi-ai gains a Google OAuth provider or bearer/ADC support for the `google` provider, delegate to it.
   - Until then, mark `oauthSupported: false` or `oauth_unavailable` unless a verified local implementation can convert stored OAuth credentials into a runtime path used by `pi-coding-agent`.
   - API-key support remains fully supported for Google via `providerKey.google`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and host token `GEMINI_API_KEY`.

Fallback/limitation behavior:

- The Google row remains visible in direct-cloud settings with API-key actions.
- The auth gate may show Google OAuth as disabled with copy: `Google sign-in is unavailable in this build; use a Gemini API key.`
- Tests should pin `oauthSupported:false` when the library/local provider is unavailable, so the UI never offers a dead OAuth button.

## Settings UI

Update `src/app/settings-page.ts::renderAccountTab()` into a Cloud Providers section.

Provider rows:

- Anthropic, OpenAI, Google Gemini.
- Toggle: enabled/disabled. `@change` calls `PUT /api/cloud-providers/:provider`.
- Status badge from `GET /api/cloud-providers/status`:
  - `Disabled`
  - `Enabled — no credential`
  - `Authenticated`
  - `Expired — re-authenticate`
  - `Invalid — re-authenticate or replace key`
  - `OAuth unavailable — API key only` for Google fallback builds
- Actions:
  - `Sign in`/`Re-authenticate` for OAuth-supported providers.
  - `Add API key`/`Replace API key` for API-key-supported providers.
  - `Remove credential` removes only the stored credential, not the enabled toggle.

AI Gateway bypass in settings:

- If `GET /api/cloud-providers/status` returns `mode: "aigw"`, do not render provider login/key/reminder actions.
- Show a neutral message: `AI Gateway is configured. Bobbit will use gateway models and will not prompt for Anthropic, OpenAI, or Google credentials.`
- The provider enablement preferences may still be shown in a collapsed/disabled area or hidden; no auth buttons should be visible.

State changes:

- Replace `AccountProviderId = "anthropic" | "openai-codex"` with `CloudProviderId`.
- Replace per-row `gatewayFetch(/api/oauth/status)` calls with one `GET /api/cloud-providers/status`.
- Update `handleReauthenticate(provider)` to map vendor to OAuth id:
  - Anthropic -> `openOAuthDialog("anthropic")`
  - OpenAI -> `openOAuthDialog("openai-codex")`
  - Google -> `openOAuthDialog("google")` only when `oauthSupported`.
- Keep the existing single `accountReauthing` gate so concurrent OAuth flows cannot clobber `pendingFlows`.

## Direct-cloud auth gate modal

Add a modal helper in `src/app/dialogs.ts`:

```ts
export async function ensureDirectCloudAuthReady(opts: {
  reason: "create-session" | "start-goal" | "start-team" | "send-message" | "image-generation";
  continuationLabel?: string;
}): Promise<boolean>;
```

Algorithm:

1. `GET /api/cloud-providers/status`.
2. If `mode === "aigw"`, return `true`.
3. If the pending flow has an explicit local/custom/aigw model, return `true`; local/custom provider behavior is unchanged.
4. If `authGateRequired === false`, return `true`.
5. Render `openDirectCloudAuthGate(status, opts)`.
6. User selects one or more vendors and an auth method per vendor.
7. For each selected vendor:
   - OAuth path: call `openOAuthDialog(oauthProviderId)`; on success the server enables the vendor.
   - API-key path: render/save through `ProviderKeyInput` or a gate-local key input; POST `/api/provider-keys/:provider` with `{ key, enable: true }`.
8. Refresh `/api/cloud-providers/status`.
9. Resolve `true` only if at least one enabled provider is authenticated.
10. Cancel resolves `false` and the caller must not start cloud-backed work.

Continuation semantics:

```ts
if (!(await ensureDirectCloudAuthReady({ reason: "create-session" }))) return;
await createTheSession();
```

The modal does not own the original action callback; this avoids double-submit races. Callers continue only after the promise resolves `true`.

Hook all user-facing cloud-backed starts before the network call that creates or starts work:

- `src/app/session-manager.ts::createAndConnectSession()` and reattempt helpers before `POST /api/sessions`.
- `src/app/dialogs.ts::showGoalDialog()` and project/scaffolding assistant creation before `POST /api/sessions`.
- `src/app/role-manager-page.ts` and `src/app/tool-manager-page.ts` assistant session creation.
- `src/app/sidebar.ts::createStaffAssistantSession()`.
- `src/app/api.ts::startTeam()` before `POST /api/goals/:goalId/team/start`.
- `src/ui/components/AgentInterface.ts` send path should not show legacy per-provider API-key prompts for disabled providers; for active direct-cloud sessions it should call `ensureDirectCloudAuthReady({ reason: "send-message" })` when server status says no usable provider.

Server-side enforcement:

- Add a guard before server creates cloud-backed sessions/team agents. If the effective model maps to Anthropic/OpenAI/Google, or the effective model is unresolved and pi-agent could fall back to a cloud default, and direct-cloud mode has no enabled authenticated cloud provider, return:

```json
HTTP 409
{
  "code": "cloud_auth_required",
  "error": "Choose at least one cloud provider to connect before starting cloud-backed work.",
  "status": { /* CloudAuthStatus */ }
}
```

- Do not apply this guard when `getAigwUrl(preferencesStore)` exists.
- Do not apply it to preview/local-only/custom-provider flows that are known not to start a cloud LLM. If a flow cannot be proven local-only and no explicit local/custom model is selected, guard it.

## AI Gateway bypass

Single rule: `getAigwUrl(preferencesStore)` means Bobbit is in AI Gateway mode for cloud auth UX.

Effects:

- `src/app/session-manager.ts::authenticateGateway()` must remove the Anthropic-specific OAuth check. It should authenticate to Bobbit only, set state, and continue.
- `GET /api/cloud-providers/status` returns `mode: "aigw"`, `authGateRequired:false`, and provider rows with `status:"aigw_bypass"` or omits rows from UI.
- `ensureDirectCloudAuthReady()` returns `true` without opening a modal.
- No expired-token reminders or OAuth refresh prompts for Anthropic/OpenAI/Google.
- `model-registry.ts` keeps existing `aigw.exclusive` behavior: gateway models are shown by default, built-ins only when `aigw.exclusive === false`. If built-ins are shown alongside gateway, provider enablement still filters Anthropic/OpenAI/Google model providers, but no auth modal is shown because gateway mode bypasses auth UX.

## Model registry and selectors

### Text models

Update `src/server/agent/model-registry.ts`:

- Add provider enablement filtering before pushing built-in provider models:

```ts
const vendor = cloudVendorForModelProvider(providerId);
if (vendor && !isProviderEnabled(prefs, vendor)) continue;
```

- Mark `authenticated` only when the vendor is enabled and a valid credential source exists.
- Include `providerEnabled.*` and credential-status cache keys in `getPrefsVersion()`.
- Add exported helpers:

```ts
export async function getSelectableModels(prefs: PreferencesStore): Promise<ApiModel[]>;
export async function pickDefaultSessionModel(prefs: PreferencesStore): Promise<string | undefined>;
export function modelPrefIsUsable(prefs: PreferencesStore, pref: string): Promise<boolean>;
```

Selection rules:

1. If saved `default.sessionModel` points to `aigw` and AI Gateway exists, allow it.
2. If saved model maps to disabled provider, treat as unavailable.
3. If saved model maps to enabled provider but not authenticated, do not auto-select it; auth gate must run first.
4. If direct-cloud has at least one enabled authenticated provider and no saved model, pick the best-ranked authenticated enabled model from `/api/models` by `modelRecencyRank()`.
5. If no enabled authenticated provider, return `undefined` and let the auth gate block session creation before pi-agent can fall back to an Anthropic default.

Update `src/server/agent/session-manager.ts`:

- `resolveInitialModel()`, `tryAutoSelectModel()`, and review/naming fallback paths must use the new usability helpers.
- Do not pass a disabled or unauthenticated direct-cloud model to pi-coding-agent via `--model` or `setModel`.
- Existing AI Gateway fallback remains unchanged.

Update `src/ui/dialogs/ModelSelector.ts`:

- Hide disabled providers because `/api/models` no longer returns them.
- Enabled but unauthenticated models may be shown locked, but clicking them must either:
  - call the auth gate for that vendor, then select after success; or
  - be disabled with a `Connect in Settings > Account` affordance.
- Do not let a locked unauthenticated model become a default preference silently.

### Image models

Update `src/server/agent/image-generation.ts`:

- Filter built-in `OPENAI_IMAGE_MODELS` by `providerEnabled.openai`.
- Filter built-in `GEMINI_IMAGE_MODELS` by `providerEnabled.google`.
- Do not default to `openai/gpt-image-2` when OpenAI is disabled or unauthenticated.
- Replace call sites that need a default with a new helper:

```ts
export function pickDefaultImageModelPref(prefs: PreferencesStore): string | undefined;
```

Rules:

- Saved `default.imageModel` is usable only when provider is enabled and authenticated, or custom provider has its own key.
- Otherwise choose first enabled authenticated image model by preference order OpenAI -> Google -> custom, or return `undefined`.
- `generateImage()` throws `No authenticated image generation provider configured` instead of falling back to OpenAI when no usable model exists.
- `src/server/server.ts::POST /api/image-generation/generate` should return `409 cloud_auth_required` in direct-cloud mode when image generation would require a disabled/unauthenticated cloud provider.

## Token prompting rules

A provider can prompt for login/reauth only when all are true:

1. AI Gateway is not configured.
2. `providerEnabled.<vendor> === true`.
3. A credential has been configured for that vendor (`configured === true`).
4. The credential is expired, invalid, or refresh failed (`needsReauth === true`).

Consequences:

- Gateway connect never opens Anthropic OAuth solely because Anthropic is unauthenticated.
- Disabled providers never produce token reminders.
- Never-configured providers never produce token-cycle reminders; they only appear in the explicit direct-cloud auth gate/settings rows.
- If no enabled provider has a valid credential, use the auth gate, not a provider-specific reauth prompt.
- API-key invalidity is only known after validation/request failure; record a redacted invalid marker such as `providerCredentialInvalid.<vendor> = true` only after a definitive 401/403 from that provider, and clear it on key replacement/OAuth success.

## Data flows

### First direct-cloud session with no credentials

1. User clicks New Session.
2. `ensureDirectCloudAuthReady({ reason: "create-session" })` fetches status.
3. Server returns `authGateRequired:true`.
4. Modal lets user select Anthropic/OpenAI/Google and OAuth/API-key methods.
5. User authenticates OpenAI.
6. `oauthComplete()` stores `auth.json["openai-codex"]`; `server.ts` enables `providerEnabled.openai`.
7. Modal refreshes status; OpenAI is `authenticated`.
8. Original New Session flow proceeds and server creates the session.
9. `tryAutoSelectModel()` chooses an enabled authenticated OpenAI model or the saved usable default.

### Cancel auth gate

1. User starts cloud-backed work.
2. Gate opens.
3. User cancels.
4. Promise resolves `false`.
5. Caller does not call `POST /api/sessions`, `POST /team/start`, or `prompt()`.
6. No cloud LLM process starts.

### AI Gateway configured

1. `authenticateGateway()` checks `/api/health` and sees `aigw:true`.
2. No cloud status/OAuth prompt is requested.
3. Settings Account tab shows bypass copy, no provider auth buttons.
4. Model registry returns gateway models by default under `aigw.exclusive`.

## Acceptance-test mapping

| Acceptance criterion | Tests to add/update |
| --- | --- |
| Enable/disable Anthropic/OpenAI/Google, persistence, cleanup/undo | Browser E2E in `tests/e2e/ui/settings.spec.ts`: navigate to `#/settings/system/account`, toggle each `providerEnabled.*`, reload, assert status/toggle, toggle back; verify `/api/preferences` has booleans and no secrets. |
| Direct-cloud no valid credentials shows modal and continuation resumes | Browser E2E new `tests/e2e/ui/provider-auth-gate.spec.ts`: clear provider prefs/keys, no AI Gateway, click New Session or Start Goal, assert modal, select stubbed provider, simulate OAuth/API-key success, assert original flow creates/connects session. |
| Cancel leaves safe non-authenticated state | Same spec: cancel gate, assert no `POST /api/sessions`/`POST /team/start`, no new session in sidebar. |
| AI Gateway never shows cloud opt-in/auth/expired prompts | API E2E in `tests/e2e/aigw-api.spec.ts` or `models-api.spec.ts`: configure AI Gateway and expired `auth.json`; `GET /api/cloud-providers/status` returns `mode:"aigw"`; browser E2E asserts no OAuth modal/account buttons. |
| Gateway connect no longer opens Anthropic OAuth | Browser/fixture test for `authenticateGateway()` with non-local health `{ localhost:false, aigw:false }` and `oauth/status` unauthenticated: assert no `POST /api/oauth/start` during connect; gate occurs only when starting work. |
| Expired-token prompts scoped to enabled configured providers | Unit/API test for `getCloudAuthStatus()`: expired Anthropic + disabled Anthropic -> `needsReauth:false`; enabled never-configured Google -> `needsReauth:false`; enabled expired OpenAI -> `needsReauth:true`. |
| Disabled providers not auto-selected/not available authenticated | Unit test for `model-registry.ts`: set `providerEnabled.anthropic=false` with Anthropic key; `/api/models` omits `anthropic`; `pickDefaultSessionModel()` does not return Anthropic. Browser model selector fixture asserts disabled providers absent. |
| No unauthenticated cloud model auto-select | Unit/API test: no AI Gateway, enabled providers without credentials -> `pickDefaultSessionModel()` undefined and `POST /api/sessions` returns 409 `cloud_auth_required`. |
| OAuth dialog automatic callback and manual fallback for Anthropic/OpenAI/Google where supported | Extend `tests/e2e/oauth-flow-status.spec.ts` and add fixture tests around `openOAuthDialog()`: Anthropic manual code; OpenAI callback polling; Google row disabled when `oauthSupported:false` or full Google provider when implemented. |
| No secret leak | Existing provider-key preference filtering tests plus new `GET /api/cloud-providers/status` assertions that no `access`, `refresh`, `key`, or bearer-shaped values appear. |
| Image model filtering | Extend `tests/image-generation-registry.test.ts`: OpenAI/Google built-ins hidden when disabled; no `openai/gpt-image-2` fallback when disabled/unauthenticated; API-key save enables provider. |

## Rollout notes

- Keep all new status APIs additive; existing `/api/oauth/*` and `/api/provider-keys/*` callers continue to work.
- Prefer central helpers over scattering preference reads. The source of truth is `providerEnabled.<vendor>` plus credential status from `cloud-provider-auth.ts`.
- Do not delete credentials during migration or disable toggles.
- Every REST status path must be redacted by construction: booleans, timestamps, types, and messages only.
