# Google Code Assist runtime protocol — archived agent-session research

> **Archived research artifact — implemented and superseded.** This document preserves the
> feasibility audit that preceded Google account session support. It is not an authoritative
> description of current behavior or an active work plan. References below to
> `sessionSelectable: false`, `NON_SESSION_SELECTABLE_PROVIDERS`, missing provider/stream/tool/
> multi-turn support, and the then-installed Pi APIs describe research-time constraints only. See
> [Google OAuth & Gemini models](../google-oauth-models.md) for shipped behavior and
> [Pi runtime compatibility](../pi-runtime-compatibility.md) for the current Pi boundary.

**Current implementation:** account-backed `google-gemini-cli` models are session-selectable through
Bobbit's generated Code Assist provider extension. The extension supplies streaming, tool-call and
tool-result translation, and multi-turn context inside the spawned agent runtime. Current v2
coverage pins the adapter protocol, generated extension, registry/auth isolation, gateway token
endpoint, and selectable model UI in `tests2/core/google-code-assist*.test.ts`,
`tests2/integration/google-code-assist-token-api.test.ts`, and
`tests2/dom/ui-fixtures/model-selector-fixture.test.ts`.

## Historical research context

Goal `Google Session Models` commissioned this protocol and feasibility audit before the runtime was
implemented. The audit identified reusable OAuth and gateway helpers, the missing agent-process
provider, protocol risks, and the extension-based design. Companion artifacts were
[`google-oauth-model-auth.md`](./google-oauth-model-auth.md) and
[`google-oauth-settings-ux.md`](./google-oauth-settings-ux.md).

---

## 0. Research-time findings

- OAuth login, credential refresh, project resolution, and a **single-turn, text-only,
  non-streaming** gateway helper existed before session support.
- Account models were then emitted with `sessionSelectable: false` and rejected by the
  `NON_SESSION_SELECTABLE_PROVIDERS` guard at binding boundaries.
- The spawned `pi-coding-agent` process had no registered `google-code-assist` API, so a direct
  `setModel("google-gemini-cli", …)` could not resolve at research time.
- The audit identified `pi.registerProvider(name, config)` plus a programmatic `streamSimple`
  handler as the lowest-risk way to register Code Assist inside the agent process without forking
  pi-ai.
- The proposal-time adapter lacked streaming, tool calls and results, multi-turn contents, and usage
  mapping. The follow-up implementation supplied those capabilities through Gemini-native
  `functionCall`/`functionResponse` and SSE translation.

---

## 1. OAuth implementation observed during research — `src/server/auth/oauth.ts`

The audit found the OAuth path already implemented and provider-partitioned. Relevant proposal-time
facts were:

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

At research time, the adapter's `tryRefreshGoogleToken()` was already wired to discover this symbol.

---

## 2. Gateway Code Assist adapter observed during research

The audit found a pure, unit-tested, **gateway-side** adapter. At that point it did **not** run inside
the agent; the proposed runtime work would extend and reuse it.

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
- The proposal identified `getGoogleAccessToken` as the single gateway token entry point. Its
  initial sandbox concept expected the token to arrive through the environment (see §9).

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

### 2.4 Request/response conversion — **text-only at research time**

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

### 2.6 Proposal-time consumer — `src/server/agent/model-completion.ts`

At research time, `completeModelText()` branched on
`model.provider === GOOGLE_GEMINI_CLI_PROVIDER` and called `codeAssistComplete(...)` instead of
pi-ai `completeSimple`. This was then the adapter's only consumer and powered title, name, and
connection-test helpers; it was not an agent-session runtime.

---

## 3. Model emission observed during research

- `getGoogleCodeAssistModels()` returned no rows without a Google account credential.
- It derived Gemini metadata from pi-ai's built-in `google` catalog and re-emitted it under provider
  `google-gemini-cli`, API `google-code-assist`, and the Code Assist base URL.
- Every emitted proposal-time model set **`sessionSelectable: false`** and carried
  `sessionUnavailableReason`; authentication metadata was added later by the registry.
- The then-current tests pinned both the per-model flag and the provider binding rejection so the
  two halves of the gate could not drift.

---

## 4. Historical session-selectability gate

The research identified three gate layers that the follow-up implementation needed to change in
lockstep:

1. **Registry emit** — proposal-time account models carried `sessionSelectable: false`.
2. **Provider binding guard** — `NON_SESSION_SELECTABLE_PROVIDERS` contained
   `"google-gemini-cli"`, and the shared helpers rejected its model strings.
3. **Call sites** — WebSocket model binding and session preference resolution consumed that shared
   rejection, while the selector consumed the per-model flag.

The plan retained the separate isolation invariant: Google account OAuth authenticated only
`google-gemini-cli`, never the API-key-only `google` provider. It proposed re-pointing the pinning
tests to the selectable contract after runtime support landed rather than deleting the tests.

---

## 5. Why sessions could not run these models at research time

- `pi-coding-agent` ran as a **separate subprocess** with its own model registry.
- The audited registry combined pi-ai built-ins with custom `models.json` providers, but its pi-ai
  copy did **not** include `google-gemini-cli`, a `google-code-assist` API, or a Code Assist stream.
- Registering a provider only in the gateway process therefore could not affect the agent process.
  At research time, `setModel("google-gemini-cli", id)` could fail or fall back, which was why the
  gate in §4 remained enabled.

### 5.1 What `models.json` alone could express

The proposal-time schema could describe names, URLs, key resolvers, headers, compatibility modes,
and model metadata, but it could not carry a stream function. Its `api` therefore had to name an API
already known to the agent or registered programmatically. A JSON-only entry could point an existing
OpenAI-compatible API at a proxy, but could not introduce the native Code Assist wire protocol.

---

## 6. Historical key finding — programmatic provider registration

The audited pi-coding-agent extension runtime exposed:

```ts
pi.registerProvider(name: string, config: ProviderConfig): void
pi.unregisterProvider(name: string): void
```

The proposal-time `ProviderConfig` shape was:
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

**Design consequence:** a Bobbit-generated extension could register a `google-code-assist` API with
a custom `streamSimple` inside the agent process, using the supported public extension surface rather
than forking pi-ai. The audited immediate-registration semantics meant a later model bind could then
resolve.

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

**Research-time prototyping recommendation:** the audit proposed starting with **B-proxy** on the
host runtime because it would reuse the proven gateway adapter and avoid sandbox token/refresh
complexity, then evaluating B-inline for sandbox parity. Either option used extension registration
as the binding primitive.

---

## 7. Reusable assets identified for the proposed implementation

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

## 8. Protocol mapping proposed for a full agent turn

At research time the adapter was single-shot text. The proposed agent runtime required the following
Code Assist (`cloudcode-pa.googleapis.com/v1internal`) mapping. Code Assist **wraps** the standard
Gemini `GenerateContent` request/response under `{ project, request:{…} }` / `{ response:{…} }`.

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
- At research time, `codeAssistPost()` buffered `text()`. The proposal required a streaming variant
  to read the response body and extend the injected-fetch seam or introduce a separate transport.

### 8.6 Usage / cost

`response.usageMetadata` → `{ promptTokenCount, candidatesTokenCount, totalTokenCount,
thoughtsTokenCount? }`. Map to the cost tracker. Code Assist free tier reports usage but billing is
account-side; `cost` in emitted models is metadata-derived and may be 0.

### 8.7 countTokens (optional)

`:countTokens` exists for pre-flight context sizing; not required for a first cut.

---

## 9. Sandbox credential propagation observed during research

The audit found that `host-tokens.ts` already anticipated the sandbox path:

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

**Open question left by the research:** the follow-up still had to choose between refreshing through
the registered provider inside the sandbox and calling back to the gateway for a fresh token. The
first option duplicated OAuth client material in the sandbox; the second required a reachable,
authenticated gateway route.

---

## 10. Protocol and integration risks assessed during research

- **R1 — audited pi-ai had no Code Assist API.** The proposal therefore required runtime extension
  registration or an OpenAI-compatible proxy; it found no JSON-only native path.
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
- **R5 — onboarding latency / quota.** At research time `:onboardUser` was a long-running poll.
  First session bind could stall; project id should be resolved/persisted **before**
  the first turn (reuse `ensureCodeAssistProject`, persist to `google-code-assist.json`). Free-tier
  rate/quota limits will surface as 429/403 — map to a clear user-facing error, not a silent
  fallback.
- **R6 — tool-call id correlation.** Gemini omits stable tool-call ids; parallel calls must be
  correlated by name/order. Mis-correlation corrupts multi-turn tool state. Reuse the gateway's
  existing tool-shape normalization (`contract-adapter.ts`).
- **R7 — schema down-conversion.** Tool JSON-Schemas that Gemini's `functionDeclarations` reject
  (unsupported keywords/formats) cause `MALFORMED_FUNCTION_CALL` or request rejection. Needs a
  sanitiser + tests.
- **R8 — streaming transport.** The proposal-time `FetchLike` was buffer-only. Streaming required a
  body stream and an expanded injected-fetch seam without breaking buffered callers.
- **R9 — gate cutover drift.** Three enforcement layers (§4) + their pinning tests must change
  together; a partial relax leaves models pickable but unbindable (or vice-versa). Re-point tests to
  assert the new "selectable once runtime present" contract rather than deleting them.
- **R10 — secret duplication.** B-inline embeds the public client secret + protocol into a
  string-generated extension and pushes the refresh token into the sandbox. B-proxy keeps secrets on
  the gateway. Prefer B-proxy unless sandbox-offline operation is required.

---

## 11. Historical recommended implementation sequence

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

## 12. Historical out of scope

No `gemini.google.com` cookie/session scraping; only the official installed-app OAuth client + Code
Assist / Developer APIs. API-key `google` (Gemini Developer API) stays the always-working fallback
and must remain unaffected and provider-isolated. Vertex (`google-vertex`) is not part of the
consumer login story.
