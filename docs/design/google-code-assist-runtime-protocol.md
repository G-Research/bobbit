# Google Code Assist runtime protocol — research for agent-session support

Status: **research only** (no production code or tests changed in this document's task).
Goal: `Google Session Models` — make `google-gemini-cli` (Google account / Code Assist OAuth)
Gemini models usable as normal Bobbit **agent session** models, not just gateway-side helper
completions.

This document is the protocol/feasibility audit feeding the implementation task. It captures the
exact wire shapes, endpoints, reusable functions, missing pieces, and protocol risks for wiring
Code Assist into the spawned `pi-coding-agent` runtime. It deliberately edits **only this file**.

Companion design docs (already merged): [`google-oauth-model-auth.md`](./google-oauth-model-auth.md)
(OAuth + helper-completion plan) and [`google-oauth-settings-ux.md`](./google-oauth-settings-ux.md).

---

## 0. TL;DR for the implementer

- The OAuth login, credential storage/refresh, token/project resolution, and a **single-turn,
  text-only, non-streaming** Code Assist completion path **already exist and work** (gateway-side
  helpers only). See §1–§3.
- Models are emitted under provider `google-gemini-cli`, api `google-code-assist`, but hard-gated
  with `sessionSelectable: false` and a provider-level binding guard
  (`NON_SESSION_SELECTABLE_PROVIDERS`). Three layers enforce the gate (registry emit, WS
  `set_model`, session-manager model-pref resolution). See §4.
- The blocker is real: `pi-coding-agent` runs as a **separate subprocess** (host or Docker) and its
  own `ModelsRegistry` only knows pi-ai's built-in apis. There is **no `google-code-assist` api** in
  pi-ai (`getProviders()` confirms), so `setModel("google-gemini-cli", …)` cannot resolve. See §5.
- **Lowest-risk runtime path found:** `pi-coding-agent`'s extension API exposes
  `pi.registerProvider(name, config)` with a programmatic `streamSimple` handler **and** an `oauth`
  block. A Bobbit-generated extension (same mechanism as `tool-guard-extension.ts` /
  `provider-bridge-extension.ts`) can register a `google-code-assist` provider **inside the agent
  process**, supplying a custom stream that speaks the Code Assist wire protocol. This is option B
  realised through the supported extension surface — no pi-ai fork required. See §6 + §7.
- The current adapter does **text only**. Agent sessions require **tool calls/results, streaming,
  multi-turn `contents`, system instruction, and usage reporting** — all missing. The hardest part
  is faithful conversion to/from Gemini `functionCall`/`functionResponse` parts and SSE streaming.
  See §8.

---

## 1. Existing OAuth implementation — `src/server/auth/oauth.ts`

Fully implemented and provider-partitioned. Relevant facts for the runtime:

- **Provider id / aliasing:** `OAuthProviderId = "anthropic" | "openai-codex" | "google-gemini-cli"`.
  `normalizeProvider()` collapses `"google" | "gemini" | "google-gemini-cli" → "google-gemini-cli"`
  at the OAuth boundary only. Plain `google` remains the AI-Studio API-key provider elsewhere.
- **Installed-app client (public, intentionally non-secret):** reuses the official Gemini CLI client.
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are reconstructed from char-code arrays purely to dodge
  secret-scanning; per Google's installed-app guidance the secret is not confidential.
- **Endpoints (constants in the file):**
  - authorize `https://accounts.google.com/o/oauth2/v2/auth` (PKCE S256, `access_type=offline`,
    `prompt=consent`)
  - token `https://oauth2.googleapis.com/token`
  - revoke `https://oauth2.googleapis.com/revoke`
  - userinfo `https://www.googleapis.com/oauth2/v3/userinfo`
  - redirect: **loopback** `http://localhost:<ephemeral>/oauth2callback` (manual-paste path also
    supported for remote gateways).
- **Scopes:** `cloud-platform`, `userinfo.email`, `userinfo.profile` (space-joined `GOOGLE_SCOPES`).
- **Storage:** `auth.json["google-gemini-cli"] = { type:"oauth", access, refresh?, expires, email? }`,
  written 0600 via `writeAuthData()` which calls `clearOAuthCache()`. `expires` carries a baked-in
  5-minute safety buffer (`Date.now()+expires_in*1000 - 5*60*1000`).
- **Status contract:** `oauthStatus("google-gemini-cli")` returns only `{ authenticated, expires,
  provider, email? }` — never token material. `email` is the only non-secret extra.

### 1.1 Refresh behaviour — `refreshGoogleOAuthToken()` (exported)

The runtime's authoritative refresh helper. Semantics:

- Reads `auth.json["google-gemini-cli"]`. If no `refresh` token, returns the stored `access` (or
  `null`).
- **Skips refresh while `Date.now() < cred.expires`** (returns current `access`).
- Else POSTs `grant_type=refresh_token` (form-encoded: `refresh_token`, `client_id`, `client_secret`)
  to `GOOGLE_TOKEN_URL`.
- **On 400/401/403:** deletes the stored entry, rewrites 0600, `clearOAuthCache()`, returns `null`
  (definitive re-auth needed).
- **On 5xx/429/network error:** retains the credential, returns `null` (transient).
- On success: persists `{ access, refresh: new ?? old, expires (with buffer), email? }` and returns
  the new access token. `refresh_token` is usually not rotated by Google.

This is the symbol the adapter's `tryRefreshGoogleToken()` is already wired to discover (see §2.2).

---

## 2. Existing Code Assist adapter — `src/server/agent/google-code-assist.ts`

A pure, unit-tested, **gateway-side** adapter. The runtime work extends/reuses this; it does **not**
yet run inside the agent.

### 2.1 Constants & endpoint shape

- `GOOGLE_GEMINI_CLI_PROVIDER = "google-gemini-cli"`, `GOOGLE_CODE_ASSIST_API = "google-code-assist"`.
- Base `https://cloudcode-pa.googleapis.com`, version `v1internal`.
- URL builder: `codeAssistUrl(method)` → `${BASE}/${v1internal}:${method}` (note the **colon** RPC
  style, e.g. `/v1internal:generateContent`).
- `CLIENT_METADATA = { ideType:"IDE_UNSPECIFIED", platform:"PLATFORM_UNSPECIFIED", pluginType:"GEMINI" }`.

### 2.2 Token sourcing — reusable

- `readGoogleCredential()` — reads `auth.json["google-gemini-cli"]`.
- `hasGoogleCodeAssistCredential()` — true if `access` or `refresh` present (even expired).
- `getGoogleAccessToken()` — returns fresh stored token if `Date.now() < expires`; else attempts
  `tryRefreshGoogleToken()` (dynamic-imports `../auth/oauth.js`, prefers `refreshGoogleOAuthToken()`,
  falls back to `refreshOAuthTokenForProvider("google-gemini-cli")`); last resort hands back a
  possibly-stale token so the API reports the real auth error.
- `getGoogleAccessToken` is the single token entry point the runtime should reuse on the gateway
  side. Inside a sandboxed agent the token instead arrives via env (see §9).

### 2.3 Project resolution — reusable, with caching

- `ensureCodeAssistProject(token, fetchFn?, timeoutMs?)`:
  1. In-memory `cachedProjectId` → return.
  2. Persisted `<agentDir>/google-code-assist.json` `{ projectId }` → cache + return.
  3. `:loadCodeAssist` with `{ metadata: CLIENT_METADATA }` → `cloudaicompanionProject` if onboarded.
  4. Else `:onboardUser` with `{ tierId, cloudaicompanionProject, metadata }`. `tierId` =
     `allowedTiers.find(isDefault).id ?? "free-tier"`. **Long-running op**: polls up to 8× with 1.5s
     sleeps until `op.done === true`, reads `op.response.cloudaicompanionProject` (string or `{id}`).
  5. On resolve: cache in memory + persist to disk.
- `resetCodeAssistProjectCache()` is a test seam.

### 2.4 Request/response conversion — pure, **text-only today**

- `buildGenerateContentBody(args, project?)` →
  ```jsonc
  {
    "model": "<modelId>",
    "project": "<projectId>",          // omitted when undefined
    "request": {
      "contents": [{ "role": "user", "parts": [{ "text": "<userPrompt>" }] }],
      "systemInstruction": { "role": "user", "parts": [{ "text": "<systemPrompt>" }] }, // if present
      "generationConfig": {
        "maxOutputTokens": <n>,        // if maxTokens>0
        "thinkingConfig": { "thinkingBudget": <budget> } // if thinkingLevel set & !off
      }
    }
  }
  ```
  Thinking budget map: `minimal:0, low:4096, medium:8192, high:24576, xhigh:32768`.
- `extractCodeAssistText(payload)` — reads `payload.response.candidates[0].content.parts[].text`
  (Code Assist wraps the standard GenerateContent response under `response`), falls back to a bare
  `candidates` shape, joins+trims text parts.
- **Gaps vs an agent turn:** single user turn only (no multi-turn `contents`), no tool
  declarations, no `functionCall`/`functionResponse` parts, no image parts, no streaming, no usage
  extraction, no `finishReason`/`safetyRatings` handling.

### 2.5 Transport

- `codeAssistPost(method, token, body, fetchFn, timeoutMs?)`: POST with
  `Authorization: Bearer <token>`, `Content-Type: application/json`. Optional timeout **races** the
  fetch against a timer that also `AbortController.abort()`s (deterministic even if the fetch impl
  ignores `signal`). Non-2xx → throws `Code Assist <method> failed: HTTP <status> <redacted body,256>`
  via `redactSensitive`. Invalid JSON → throws.
- `codeAssistComplete(args, deps)`: resolves token (`getToken` default `getGoogleAccessToken`),
  resolves project (`getProject` default `ensureCodeAssistProject`), builds body, posts
  `generateContent`, returns extracted text. Throws a descriptive "No Google account credential…"
  error when no token.
- `FetchLike` is an injectable minimal fetch interface (`{ok,status,text()}`) — the test seam.

### 2.6 Where it is wired today — `src/server/agent/model-completion.ts`

`completeModelText()` branches on `model.provider === GOOGLE_GEMINI_CLI_PROVIDER` and calls
`codeAssistComplete(...)` instead of pi-ai `completeSimple`. `resolveProviderApiKey()` is bypassed
for this provider (it returns a Bearer token, not an API key). **This is the only consumer.** It
powers gateway helpers: title/name generation and the connection test (`testModelPreference`).
`PROVIDER_ENV_KEYS["google-gemini-cli"]` exists but is unused on this branch.

---

## 3. Model emission — `src/server/agent/google-code-assist-models.ts`

- `getGoogleCodeAssistModels()` returns `[]` unless `hasGoogleCodeAssistCredential()`.
- Derives metadata from pi-ai's built-in `google` catalog (`getModels("google")`), filters to
  `gemini-*` (excludes Gemma/Vertex/`customtools`), re-emits under provider `google-gemini-cli`,
  api `google-code-assist`, `baseUrl https://cloudcode-pa.googleapis.com`.
- Every emitted model sets **`sessionSelectable: false`** + `sessionUnavailableReason`
  (`GOOGLE_CODE_ASSIST_SESSION_UNAVAILABLE_REASON`). `authenticated` is set later by the registry's
  `detectProviderAuth`.
- Pinning test `tests/google-code-assist.test.ts` asserts every emitted model is
  `sessionSelectable:false` **and** fails `isSessionSelectableProvider/ModelString` (no drift).

---

## 4. The session-selectability gate — three enforcement layers

To flip Code Assist models on for sessions, the implementer must relax all three **in lockstep**,
guarded by their pinning tests:

1. **Registry emit** — `google-code-assist-models.ts` sets `sessionSelectable:false`. Pinned by
   `tests/google-code-assist.test.ts` and `tests/google-code-assist-registry.test.ts`.
2. **Provider binding guard** — `NON_SESSION_SELECTABLE_PROVIDERS = {"google-gemini-cli"}` in
   `google-code-assist.ts`; `isSessionSelectableProvider()` / `isSessionSelectableModelString()`.
3. **Call sites:**
   - `src/server/ws/handler.ts` `set_model` rejects non-selectable providers
     (`MODEL_NOT_SESSION_SELECTABLE`).
   - `src/server/agent/session-manager.ts` (≈ lines 4943–5050) filters role-model and
     `sessionModel` preferences through `isSessionSelectableModelString()` before spawn/`setModel`.

`isOAuthCapableProvider` in `model-registry.ts` already includes `google-gemini-cli` (so the
credential authenticates the provider) while excluding API-key-only `google` — **do not touch** that
isolation invariant (pinned by `tests/google-code-assist-registry.test.ts`).

> Implementation note: the cleanest cutover is to make `sessionSelectable` *conditional on runtime
> support* (e.g. only `false` until a feature flag / capability is present), rather than a blanket
> delete, so the pinning tests can be re-pointed to assert the new contract instead of removed.

---

## 5. Why sessions can't run these models today (the real blocker)

- `pi-coding-agent` runs as a **separate subprocess**, spawned via `rpc-bridge.ts` (host `node …
  cli.js` or `docker exec … cli.js`). It owns its own `ModelsRegistry`
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js`).
- That registry's models come from pi-ai built-ins (`getModels`/`getProviders`) **plus** custom
  providers parsed from `<agentDir>/models.json`. Confirmed pi-ai `getProviders()` does **not**
  include `google-gemini-cli`/`google-code-assist`; only `google` (`google-generative-ai`) and
  `google-vertex` exist. pi-ai exposes `streamGoogle` / `streamSimpleGoogle` (Developer API) but **no
  `cloudcode-pa` / Code Assist** stream.
- Therefore the gateway registering anything in **its own** process is irrelevant to the agent.
  `rpcClient.setModel("google-gemini-cli", id)` cannot resolve in the agent → fails or silently
  falls back. This is exactly why the gate in §4 exists.

### 5.1 What `models.json` alone can express (and why it's insufficient for option B-native)

pi-coding-agent's `models.json` provider schema (`ProviderConfigSchema`) supports: `name`, `baseUrl`,
`apiKey` (literal / `$ENV` / `!command`), `api` (string discriminator), `headers`, `authHeader`
(adds `Authorization: Bearer <apiKey>`), `compat` (OpenAI-completions / OpenAI-responses /
Anthropic-messages), `models[]`, `modelOverrides`. **`api` must name an api the agent's pi-ai already
knows** (or one registered programmatically). JSON cannot carry a function, so a JSON-only entry
**cannot** introduce the Code Assist wire protocol — it can only point an existing api at a URL. That
makes JSON viable for **option 3** (OpenAI-compatible proxy: `api:"openai-completions"` +
`compat` + `baseUrl` → local proxy) but **not** for a JSON-only native Code Assist provider.

---

## 6. KEY FINDING — programmatic provider registration via the extension API

`pi-coding-agent`'s extension runtime (`dist/core/extensions/types.d.ts`, `runner.js`, `loader.js`)
exposes:

```ts
pi.registerProvider(name: string, config: ProviderConfig): void
pi.unregisterProvider(name: string): void
```

`ProviderConfig` (verified shape):
```ts
interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;                 // literal / $ENV / !command
  api?: Api;                       // discriminator for the registered stream
  streamSimple?: (model, context, options?) => AssistantMessageEventStream; // ← custom wire protocol
  headers?: Record<string,string>;
  authHeader?: boolean;            // add Authorization: Bearer <resolved apiKey>
  models?: ProviderModelConfig[];  // replaces all models for this provider
  oauth?: {
    name: string;
    login(callbacks): Promise<OAuthCredentials>;
    refreshToken(credentials): Promise<OAuthCredentials>;
    getApiKey(credentials): string;
    modifyModels?(models, credentials): Model[];
  };
}
```

Internally `applyProviderConfig` calls pi-ai `registerApiProvider({ api, stream, streamSimple },
"provider:<name>")` and, if `oauth` present, `registerOAuthProvider({...oauth, id:name})`. Validation
(`validateProviderConfig`): `api` is **required** when registering `streamSimple`; `baseUrl` +
(`apiKey` | `oauth`) required when defining `models`.

**Consequence:** a Bobbit-generated extension can register a `google-code-assist` api with a custom
`streamSimple` that speaks the Code Assist protocol — entirely inside the agent process, using the
supported public extension surface. This realises goal option B without forking pi-ai. Registration
"takes effect immediately… safe to call from command handlers or event callbacks" per the docs, so a
post-spawn `setModel` would then resolve.

### 6.1 Two flavours of the extension's `streamSimple`

- **(B-inline)** Implement the full Code Assist HTTP/SSE protocol inside the generated extension
  (self-contained JS, like `provider-bridge-extension.ts`). Needs token + project available to the
  agent process (token via `GOOGLE_CLOUD_ACCESS_TOKEN` env, see §9; project via env or a gateway
  callback). Pros: no extra hop, works in sandbox once env is mounted. Cons: the conversion +
  streaming code must be duplicated as a string-embedded extension and kept in sync with the gateway
  adapter; refresh-on-expiry inside the sandbox is awkward (see §9, §10).
- **(B-proxy / overlaps option 3)** The extension (or a `models.json` entry) points at a
  **gateway-local endpoint**; the gateway owns token/project/refresh and the Code Assist
  translation. The agent speaks either the custom api to the gateway, or plain `openai-completions`
  if the gateway exposes an OpenAI-compatible facade (Hermes' `gemini_cloudcode_adapter.py` is the
  reference for that translation). Pros: single source of truth for protocol + refresh, no secret
  duplication into the sandbox, reuses the existing `aigw`-style local-proxy + per-session-header
  machinery (`aigw-manager.ts`). Cons: needs a per-session authenticated local route reachable from
  the (possibly Docker) agent; streaming must be proxied end-to-end.

**Recommendation for prototyping:** start with **B-proxy** on the host runtime (no Docker), because
it reuses the proven gateway adapter (§2) and `aigw` per-session header injection, and avoids
sandbox token/refresh complexity. Then evaluate B-inline for sandbox parity. Either way the
extension-registration mechanism (§6) is the binding primitive.

---

## 7. Reusable assets (inventory for the implementer)

| Need | Reuse | Location |
|---|---|---|
| OAuth login / loopback / paste | done | `oauth.ts` `oauthStart*`, `oauthComplete`, `exchangeGoogleCode` |
| Token refresh (gateway) | `refreshGoogleOAuthToken()` | `oauth.ts` |
| Fresh token + stale-fallback | `getGoogleAccessToken()` | `google-code-assist.ts` |
| Credential presence | `hasGoogleCodeAssistCredential()` | `google-code-assist.ts` |
| Project onboarding + cache | `ensureCodeAssistProject()` | `google-code-assist.ts` |
| Request body (extend for tools/multi-turn/stream) | `buildGenerateContentBody()` | `google-code-assist.ts` |
| Response text extraction (extend for tool parts) | `extractCodeAssistText()` | `google-code-assist.ts` |
| Bearer POST + timeout/abort + redaction | `codeAssistPost()` | `google-code-assist.ts` |
| Provider/model emit | `getGoogleCodeAssistModels()` | `google-code-assist-models.ts` |
| Sandbox env var + sanitized auth.json + policy | `host-tokens.ts` (`GOOGLE_CLOUD_ACCESS_TOKEN`, `buildSandboxAgentAuthJson`, `resolveSandboxAgentAuthPolicy`) | `host-tokens.ts` |
| In-agent extension generation pattern | `tool-guard-extension.ts`, `provider-bridge-extension.ts` | `src/server/agent/` |
| Local proxy + per-session headers + models.json writing | `aigw-manager.ts` | `src/server/agent/` |
| Error/secret redaction | `redactSensitive` | `src/server/auth/redact.ts` |

---

## 8. Protocol mapping required for a full agent turn

The existing adapter is single-shot text. An agent session needs the following Code Assist
(`cloudcode-pa.googleapis.com/v1internal`) mapping. Code Assist **wraps** the standard Gemini
`GenerateContent` request/response under `{ project, request:{…} }` / `{ response:{…} }`.

### 8.1 Multi-turn contents

Map the agent's message history to `request.contents[]`. Gemini roles are `"user"` and `"model"`
(not `"assistant"`). System prompt → `request.systemInstruction` (role `"user"`, text part) — already
done. Image inputs → `inlineData`/`fileData` parts (only for models whose `input` includes `image`).

### 8.2 Tool declarations

`request.tools = [{ functionDeclarations: [{ name, description, parameters /* JSON-Schema subset */ }] }]`.
Gemini accepts an OpenAPI-ish JSON Schema subset; the agent's tool param schemas must be
down-converted (drop unsupported keywords, e.g. `$ref`, `additionalProperties` quirks, `format`
values Gemini rejects). `request.toolConfig.functionCallingConfig.mode` may be set (`AUTO`/`ANY`/
`NONE`).

### 8.3 Assistant tool calls (response → agent)

A model part is `{ functionCall: { name, args: <object> } }`. Convert to the agent runtime's
tool-call representation. Gemini does **not** supply a stable tool-call id; the runtime must
synthesize ids and correlate by call order/name (the gateway already normalizes several tool-call
shapes — see `src/server/extension-host/contract-adapter.ts`). `finishReason` (`STOP`,
`MAX_TOKENS`, `SAFETY`, `RECITATION`, `MALFORMED_FUNCTION_CALL`) must map to pi stop reasons.

### 8.4 Tool results (agent → model, next turn)

Append a `contents` entry role `"user"` (Gemini convention for tool output) with parts
`{ functionResponse: { name, response: { … } } }`. Name must match the originating `functionCall`.
Multiple parallel calls → multiple `functionResponse` parts.

### 8.5 Streaming — `:streamGenerateContent`

- Endpoint `…/v1internal:streamGenerateContent` (typically `?alt=sse`). Returns **SSE** `data:` lines,
  each a partial wrapped `GenerateContent` chunk; text arrives incrementally in
  `response.candidates[0].content.parts[].text`; `functionCall` parts arrive (often whole) in later
  chunks; usage in a final chunk's `usageMetadata`.
- The custom `streamSimple` must translate these chunks into the agent's
  `AssistantMessageEventStream` events (text deltas, tool-call events, done/usage). pi-ai's
  `AssistantMessageEventStream` and `forwardStream` (seen in `streamGoogle`) are the target shapes.
- `codeAssistPost()` currently buffers `text()`; a streaming variant must read the response body as a
  stream. The injected `FetchLike` interface needs extending (or a separate streaming transport).

### 8.6 Usage / cost

`response.usageMetadata` → `{ promptTokenCount, candidatesTokenCount, totalTokenCount,
thoughtsTokenCount? }`. Map to the cost tracker. Code Assist free tier reports usage but billing is
account-side; `cost` in emitted models is metadata-derived and may be 0.

### 8.7 countTokens (optional)

`:countTokens` exists for pre-flight context sizing; not required for a first cut.

---

## 9. Sandbox credential propagation (already scaffolded)

`host-tokens.ts` already anticipates the sandbox path:

- `PROVIDER_TOKENS` entry: `{ envVar:"GOOGLE_CLOUD_ACCESS_TOKEN", provider:"google-gemini-cli",
  envKeys:["GOOGLE_CLOUD_ACCESS_TOKEN"] }`. `GOOGLE_CLOUD_ACCESS_TOKEN` is the env var the Gemini CLI
  / google-auth honour for a pre-acquired Bearer token, paired with **`GOOGLE_GENAI_USE_GCA=1`**.
- `resolveHostTokenValue("GOOGLE_CLOUD_ACCESS_TOKEN")` returns the stored `oauth.access`
  **synchronously** — comment notes it may be expired and that the **sandbox** refreshes it from the
  refresh token riding along in the sanitized `auth.json`. Gateway-side fresh refresh is the async
  helper's job, not this sync path.
- `buildSandboxAgentAuthJson({ includeGoogleAuth })` / `sanitizeGoogleCredential()` emit only
  `{ type:"oauth", access, refresh?, expires? }` — **never** `email`/profile. Gated behind explicit
  policy: `sandboxTokenPolicyAllowsGoogleAuth()` / `resolveSandboxAgentAuthPolicy().includeGoogleAuth`
  (requires a `GOOGLE_CLOUD_ACCESS_TOKEN` sandbox-token entry; default off — least privilege).
- `docker-args.ts` already mounts the scoped `auth.json` read-only and injects allowed tokens as
  `-e KEY=VALUE`; the Google entry rides those paths with no structural change.

**Open question for the runtime task:** inside the sandbox, who refreshes an expired token? Options:
(a) the registered provider's `oauth.refreshToken` (pi-coding-agent can refresh using the sanitized
`auth.json` refresh token + the public client id/secret); (b) the agent calls back to the gateway
for a fresh token (B-proxy). (a) duplicates the client secret into the sandbox runtime; (b) needs a
reachable authenticated gateway route. Decide explicitly (§10 risk R4).

---

## 10. Protocol & integration risks

- **R1 — pi-ai has no Code Assist api.** Confirmed. Must register at runtime via the extension
  `registerProvider` surface (§6) or proxy through OpenAI-compat (§5.1 / option 3). No JSON-only
  native path.
- **R2 — unofficial-for-third-parties client.** The Gemini CLI installed-app client is reused. If
  Google restricts non-CLI use of that client or the Code Assist scopes, the path breaks. Keep the
  UX caveat copy (`GOOGLE_CODE_ASSIST_SESSION_UNAVAILABLE_REASON` / Account-tab description) and a
  hard fallback to API-key `google`. Preserve the ability to disable the row with a clear message.
- **R3 — `v1internal` is an unstable surface.** `:loadCodeAssist` / `:onboardUser` /
  `:streamGenerateContent` are internal-versioned; response shapes (wrapping under `response`,
  `cloudaicompanionProject` as string vs `{id}`) can change. Centralise conversion; keep it
  unit-tested with recorded fixtures.
- **R4 — token refresh in the sandbox.** See §9 open question. A stale `GOOGLE_CLOUD_ACCESS_TOKEN`
  with no in-sandbox refresh → mid-session 401s. Acceptance criterion requires expired tokens to
  refresh or fail with a clear re-auth message — must be handled on whichever side owns inference.
- **R5 — onboarding latency / quota.** `:onboardUser` is a long-running poll (up to ~12s in the
  current impl). First session bind could stall; project id should be resolved/persisted **before**
  the first turn (reuse `ensureCodeAssistProject`, persist to `google-code-assist.json`). Free-tier
  rate/quota limits will surface as 429/403 — map to a clear user-facing error, not a silent
  fallback.
- **R6 — tool-call id correlation.** Gemini omits stable tool-call ids; parallel calls must be
  correlated by name/order. Mis-correlation corrupts multi-turn tool state. Reuse the gateway's
  existing tool-shape normalization (`contract-adapter.ts`).
- **R7 — schema down-conversion.** Tool JSON-Schemas that Gemini's `functionDeclarations` reject
  (unsupported keywords/formats) cause `MALFORMED_FUNCTION_CALL` or request rejection. Needs a
  sanitiser + tests.
- **R8 — streaming transport.** `FetchLike` is buffer-only (`text()`). Streaming needs a real body
  stream; the injected-fetch test seam must be extended without breaking existing buffered callers.
- **R9 — gate cutover drift.** Three enforcement layers (§4) + their pinning tests must change
  together; a partial relax leaves models pickable but unbindable (or vice-versa). Re-point tests to
  assert the new "selectable once runtime present" contract rather than deleting them.
- **R10 — secret duplication.** B-inline embeds the public client secret + protocol into a
  string-generated extension and pushes the refresh token into the sandbox. B-proxy keeps secrets on
  the gateway. Prefer B-proxy unless sandbox-offline operation is required.

---

## 11. Recommended implementation sequence (for the follow-up task)

1. **Extend the pure adapter** (`google-code-assist.ts`) to support multi-turn `contents`, tool
   declarations, `functionCall`/`functionResponse` conversion, and a streaming variant
   (`buildGenerateContentBody` + new `extractCodeAssistParts` + `streamCodeAssist`). Unit-test with
   recorded fixtures (text, tool-call, tool-result, multi-chunk SSE, usage).
2. **Prototype binding on the host runtime via B-proxy:** gateway exposes a per-session authenticated
   Code Assist route (reuse `aigw`-style header injection); register the provider in the agent via a
   generated extension (`registerProvider` with custom `streamSimple` → gateway route, or
   `openai-completions` + compat if a Hermes-style facade is used). Verify a single-turn answer for
   `google-gemini-cli/gemini-2.5-pro`, then tools + multi-turn.
3. **Wire credential/project propagation** and decide the refresh owner (§9/R4).
4. **Relax the gate** (§4) behind a capability flag; re-point pinning tests.
5. **Sandbox parity** (B-inline or proxy-reachable-from-Docker), `GOOGLE_GENAI_USE_GCA=1` +
   `GOOGLE_CLOUD_ACCESS_TOKEN`, refresh behaviour.
6. **Tests:** browser/API selectability + persistence across reload/restart; manual-integration with
   a real Google account documenting quota/onboarding behaviour.

---

## 12. Out of scope (unchanged from the OAuth design)

No `gemini.google.com` cookie/session scraping; only the official installed-app OAuth client + Code
Assist / Developer APIs. API-key `google` (Gemini Developer API) stays the always-working fallback
and must remain unaffected and provider-isolated. Vertex (`google-vertex`) is not part of the
consumer login story.
