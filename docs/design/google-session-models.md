# Google account (Code Assist) models as agent session models

Status: **implemented** (was the design-doc gate artifact). The plan below shipped: account
`google-gemini-cli` models are now session-selectable and run through the generated Code Assist
provider extension. For current behavior and operator guidance see
[`docs/google-oauth-models.md`](../google-oauth-models.md). This document is retained as the
design record; every path/function/symbol named below was an exact target for the implementation.

Goal: `Google Session Models` (`google-session-09851872`). Make `google-gemini-cli` (Google account
OAuth / Gemini Code Assist) models selectable and runnable as normal Bobbit agent **session** models,
not just gateway-side helper completions.

Companion / predecessor doc: [`docs/design/google-oauth-model-auth.md`](google-oauth-model-auth.md)
(the OAuth login + gateway-helper-completion design that already shipped). This doc only closes the
**agent-session runtime** gap §4.4(b) left open.

---

## 1. Where we are today (audit)

### 1.1 What already works

- **OAuth + credential storage** (`src/server/auth/oauth.ts`): `google-gemini-cli` is a first-class
  OAuth provider. `auth.json["google-gemini-cli"] = { type:"oauth", access, refresh, expires, email? }`.
  Provider-partitioned status/refresh/logout already exist.
- **Gateway-side Code Assist adapter** (`src/server/agent/google-code-assist.ts`): single-turn
  `codeAssistComplete()` against `cloudcode-pa.googleapis.com/v1internal:generateContent` with a
  Bearer token. Pure, unit-tested helpers: `buildGenerateContentBody()`, `extractCodeAssistText()`,
  `ensureCodeAssistProject()` (loadCodeAssist/onboardUser → projectId, cached + persisted),
  `getGoogleAccessToken()` (reads/refreshes the stored token). Already wired into
  `completeModelText()` (title/name/connection-test helpers) in
  `src/server/agent/model-completion.ts`.
- **Model emission** (`src/server/agent/google-code-assist-models.ts`): when a Google credential is
  present, Gemini ids are re-emitted under provider `google-gemini-cli` with
  `api: "google-code-assist"`, `baseUrl: cloudcode-pa…`, but **`sessionSelectable: false`** plus
  `sessionUnavailableReason` copy.
- **Session-selectability guard** (`google-code-assist.ts`): `NON_SESSION_SELECTABLE_PROVIDERS =
  { "google-gemini-cli" }`, plus `isSessionSelectableProvider()` / `isSessionSelectableModelString()`.
  Enforced at every bind path: WS handler (`src/server/ws/handler.ts:669`), review-model override
  (`review-model-override.ts:109`), and the UI picker (`src/ui/dialogs/ModelSelector.ts:233-237`,
  which renders `sessionSelectable === false` rows disabled).
- **Sandbox credential propagation** (`src/server/agent/host-tokens.ts`): already wired —
  `PROVIDER_TOKENS` has `{ envVar:"GOOGLE_CLOUD_ACCESS_TOKEN", provider:"google-gemini-cli" }`;
  `GOOGLE_GEMINI_CLI_SANDBOX_AUTH_TOKEN_KEYS`; `buildSandboxAgentAuthJson()` emits a sanitized
  `google-gemini-cli` entry when policy allows; `resolveHostTokenValue("GOOGLE_CLOUD_ACCESS_TOKEN")`
  returns the stored access token. `docker-args.ts` mounts the scoped `auth.json` and injects allowed
  tokens as `-e KEY=VALUE`.

### 1.2 The one missing piece

Agent sessions are run by a **separate `pi-coding-agent` process** (local child process, or
`docker exec` inside the sandbox — `rpc-bridge.ts:380-607`). That process drives turns through
`@earendil-works/pi-ai`'s `stream()` / `streamSimple()`, which dispatch on `model.api`:

```js
// pi-ai/dist/stream.js
function resolveApiProvider(api) {
  const provider = getApiProvider(api);
  if (!provider) throw new Error(`No API provider registered for api: ${api}`);
  return provider;
}
```

pi-ai 0.79.x ships api providers for `anthropic-messages`, `openai-completions`, `openai-responses`,
`openai-codex-responses`, `azure-openai-responses`, `mistral-conversations`, `bedrock-converse-stream`,
`google-generative-ai`, `google-vertex` — **but not `google-code-assist`**, and its `./oauth`
registry has no `google-gemini-cli` provider (`getOAuthProvider("google-gemini-cli") → undefined`).
So binding a `google-gemini-cli/*` model to a session would make the agent throw *"No API provider
registered for api: google-code-assist"* on the first turn. That is exactly why the models are
emitted `sessionSelectable: false` today. Closing this gap is the whole job.

### 1.3 pi runtime capabilities verified against the installed dist (0.79.6)

These are the load-bearing facts the recommendation depends on; all confirmed by reading
`node_modules/@earendil-works/{pi-ai,pi-coding-agent}/dist`:

1. **`Api` is an open string type.** `pi-ai/dist/types.d.ts`: `export type Api = KnownApi | (string & {})`.
   A custom `api: "google-code-assist"` is legal end-to-end.
2. **pi-ai exposes a public api-registry.** `registerApiProvider({ api, stream, streamSimple }, sourceId?)`,
   `getApiProvider`, `unregisterApiProviders`, `clearApiProviders` (`pi-ai/dist/api-registry.d.ts`).
3. **pi-coding-agent exposes a first-class extension hook to register providers.**
   `ExtensionAPI.registerProvider(name, config: ProviderConfig)` and `unregisterProvider(name)`
   (`pi-coding-agent/dist/core/extensions/types.d.ts:946,960`). `ProviderConfig` accepts a custom
   `api`, `baseUrl`, `apiKey` (literal / `$ENV` / `${ENV}` / leading `!command`), `headers`,
   `authHeader`, a `models[]` list, an **`oauth`** provider impl (`login`/`refreshToken`/`getApiKey`/
   `modifyModels`), and — critically — a **`streamSimple` handler** for custom APIs:
   ```ts
   streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions)
                  => AssistantMessageEventStream;
   ```
   Internally (`pi-coding-agent/dist/core/model-registry.js:721-740`) this calls
   `registerApiProvider({ api, stream: streamSimple, streamSimple }, "provider:<name>")` on the
   agent's **own** pi-ai singleton, and the doc comment notes the call "takes effect immediately…
   safe to call from command handlers or event callbacks." This is the supported, version-stable
   injection point — no monkey-patching of pi-ai dist required.
4. **Extensions are already how Bobbit injects code into the agent process**, and they run in the
   Docker sandbox too. Bobbit extensions import `@earendil-works/pi-coding-agent` /
   `@sinclair/typebox` and are loaded via `--extension <path>` (`rpc-bridge.ts`,
   `session-setup.ts:404-424`, `session-manager.ts:1736-1810`). The agent resolves those imports
   against its own `node_modules`, so an extension can also import
   `createAssistantMessageEventStream` from `@earendil-works/pi-ai` and get the **same**
   `AssistantMessageEventStream` class the turn loop consumes (same module instance → instanceof
   holds). Existing precedents: `defaults/tools/tasks/extension.ts`,
   `src/server/agent/provider-bridge-extension.ts` (generated, gateway-callback), tool-guard.
5. **models.json config values are resolved at runtime**, including a leading `!command`
   (`pi-coding-agent/dist/core/resolve-config-value.*`, used for the existing aigw
   `x-opencode-session` header). `apiKey` supports `$ENV`/`!cmd`. **`baseUrl` is taken literally**
   (not run through `resolveConfigValue`) — important: a models.json `baseUrl` cannot be an env
   placeholder, which is why a "point the agent at a local gateway proxy" design is awkward (see
   §3 option C).
6. **pi-coding-agent's `AuthStorage.getApiKey()` cannot refresh a `google-gemini-cli` oauth entry**
   on its own, because `getOAuthProvider("google-gemini-cli")` is `undefined` in the agent's pi-ai
   (`pi-coding-agent/dist/core/auth-storage` → "Unknown OAuth provider, can't get API key"). So
   token freshness for the agent must come from either (a) a `ProviderConfig.oauth` impl we supply
   via the extension, or (b) an `apiKey: "!command"` that fetches a fresh token, or (c) an env var
   we refresh at spawn. We use (b)+(a) — see §4.4.

---

## 2. Options evaluated

| # | Option | Verdict |
|---|---|---|
| A | **Upgrade / patch `@earendil-works/pi-ai`** to add a first-party `google-code-assist` provider. | **Rejected (now).** 0.79.6 has no such provider and none on the published surface; we'd be patching dist (like `pi-ai-bedrock-headers-patch.ts`). A dist patch must be re-applied to *two* copies (top-level + `pi-coding-agent/node_modules/@earendil-works/pi-ai`) and, crucially, **does not reach the Docker sandbox image** (prebuilt). Brittle across upgrades. Keep as a possible upstream contribution, not the mechanism. |
| B | **Bobbit-native pi provider via the supported `pi.registerProvider` extension hook.** A generated pi-coding-agent extension registers `api:"google-code-assist"` with our own `streamSimple` (Code Assist HTTP + Gemini↔pi conversion). | **RECOMMENDED.** Officially supported hook (§1.3.3), runs in both local and Docker sandbox via the existing `--extension` plumbing, no dist patching, full native Gemini fidelity (function calls, thinking, `thoughtSignature`), fixed public `baseUrl` (`cloudcode-pa`) so no local-gateway-URL problem. Reuses the gateway's already-shipped Code Assist pure helpers. |
| C | **Gateway-hosted OpenAI-compatible proxy.** Expose a local `…/v1/chat/completions` endpoint backed by Code Assist; write a `google-gemini-cli` provider into `models.json` with `api:"openai-completions"` pointed at it. | **Rejected as primary.** Two blockers: (1) **`baseUrl` is static in `models.json`** (§1.3.5) but the Bobbit gateway URL differs between local (`127.0.0.1:port`) and Docker (`host.docker.internal`/LAN) — there is no per-host env substitution for `baseUrl`, so a single shared `models.json` can't address both. (2) Lossy OpenAI↔Gemini round-trip drops Gemini `thoughtSignature`, degrading Gemini-3 multi-turn tool use (Bobbit is tool-heavy). Upside (reuses pi-ai's openai client, gateway-only creds) is real but doesn't outweigh the blockers. Kept as the fallback if B's fidelity ever regresses. |
| D | **Gemini CLI backend runtime** (OpenClaw-style CLI-backed session). | **Rejected.** A whole alternate session runtime is far larger than this goal and orthogonal to pi-coding-agent. Not justified. |

**Recommendation: Option B.**

---

## 3. Recommended architecture (Option B)

```
┌────────────────────────── Bobbit gateway (host) ──────────────────────────┐
│ model-registry  ──emits──>  google-gemini-cli models (sessionSelectable:true)│
│ session-setup   ──writes/mounts──>  google-code-assist provider extension    │
│ NEW route: GET /api/sessions/:id/google-code-assist/token                    │
│   └─ getGoogleAccessToken() (refresh) + ensureCodeAssistProject()            │
└───────────────▲───────────────────────────────────────────────▲────────────┘
                │ fresh Bearer + projectId (per request, over BOBBIT_GATEWAY_URL)
                │                                                 │
┌───────────────┴──────────── pi-coding-agent process ───────────┴────────────┐
│ extension default(pi):                                                       │
│   pi.registerProvider("google-gemini-cli", {                                 │
│     api: "google-code-assist", baseUrl: cloudcode-pa/v1internal,             │
│     apiKey: "!<fetch fresh token from gateway>",  // or env, see §4.4         │
│     streamSimple: codeAssistStreamSimple, models: [...] })                   │
│                                                                              │
│ turn loop → pi-ai stream() → getApiProvider("google-code-assist")            │
│   → codeAssistStreamSimple(model, context, options)                          │
│       convert pi Context → Code Assist body (multi-turn, tools, system)      │
│       POST cloudcode-pa …:streamGenerateContent?alt=sse (Bearer)             │
│       parse Gemini SSE → emit pi AssistantMessageEvent stream                │
└──────────────────────────────────────────────────────────────────────────────┘
```

Key properties:
- The `streamSimple` handler is **our code**, running in the agent, talking **directly** to the
  fixed public Code Assist endpoint. No local-gateway `baseUrl` problem, no OpenAI round-trip.
- The **only** thing the agent needs from the gateway at runtime is a **fresh Bearer token +
  projectId**. That is fetched per request from a new authenticated gateway endpoint (same callback
  pattern as `provider-bridge-extension.ts`), which keeps refresh logic single-sourced on the
  gateway and solves mid-session token expiry. The token never has to be persisted in the sandbox.

---

## 4. Implementation plan (exact files / functions)

### 4.1 Promote the conversion/streaming core in `src/server/agent/google-code-assist.ts`

Today this file has single-turn pure helpers. Extend it (keep it dependency-light and unit-testable;
**no pi-ai import** so it can be shared verbatim by the gateway and embedded into the extension):

1. `convertContextToCodeAssist(args)` — generalize `buildGenerateContentBody()` to **multi-turn +
   tools**. Input: an array of normalized messages (`{role:"user"|"assistant"|"tool", text?,
   toolCalls?, toolResults?, images?}`) + `systemPrompt` + `tools` (JSON-schema function decls) +
   `generationConfig` (maxTokens, thinkingConfig from `THINKING_BUDGET`). Output: the Code Assist
   request `{ model, project?, request: { contents, systemInstruction?, tools?, toolConfig?,
   generationConfig? } }`. Mapping rules (mirror pi-ai's `google-shared` semantics, which we cannot
   import — it is not in pi-ai's `exports` map):
   - user text → `{ role:"user", parts:[{text}] }`; images → `{ inlineData:{ mimeType, data } }`.
   - assistant text → `{ role:"model", parts:[{text}] }`; assistant tool calls →
     `parts:[{ functionCall:{ name, args } , thoughtSignature? }]` (preserve `thoughtSignature`
     verbatim when present — required for Gemini-3 thinking replay).
   - tool results → `{ role:"user", parts:[{ functionResponse:{ name, response } }] }`.
   - tools → `{ functionDeclarations:[{ name, description, parametersJsonSchema }] }`.
2. `parseCodeAssistStreamChunk(json)` — pure: given one decoded SSE `data:` object (Code Assist
   wraps the standard `GenerateContent` response under `response`), return a normalized delta
   `{ textDelta?, thinkingDelta?, toolCall?, thoughtSignature?, finishReason?, usage? }`. Reuse the
   `response.candidates[0].content.parts[]` walk from `extractCodeAssistText()`; detect thinking via
   `part.thought === true`; map `usageMetadata → {input,output,...}`; map Gemini `finishReason →
   pi StopReason` ("STOP"→"stop","MAX_TOKENS"→"length", function-call→"toolUse", else "error").
3. `codeAssistStream(args, deps)` — async generator that POSTs to
   `…/v1internal:streamGenerateContent?alt=sse` with `Authorization: Bearer <token>`, reads the SSE
   body line-by-line, yields parsed chunks. Honors `args.signal` (AbortSignal) and `args.timeoutMs`
   (reuse the abort+race pattern already in `codeAssistPost`). This is the streaming sibling of the
   existing single-shot `codeAssistComplete()`; refactor `codeAssistComplete` to optionally delegate
   so there is one wire implementation.
4. Keep `ensureCodeAssistProject`, `getGoogleAccessToken`, `hasGoogleCodeAssistCredential`,
   `isSessionSelectableProvider`, `GOOGLE_CODE_ASSIST_API`, `GOOGLE_GEMINI_CLI_PROVIDER`.

Unit tests (tester-owned) cover #1–#2 as pure functions and #3 against a `fetchFn`/SSE stub.

### 4.2 New gateway token endpoint — `src/server/server.ts` (`handleApiRoute`)

Add `GET /api/sessions/:id/google-code-assist/token`:
- Authn: same per-session auth the other `/api/sessions/:id/...` routes use (Bearer = gateway token
  or the session secret in `BOBBIT_SESSION_SECRET`; reuse the existing session-route auth guard).
- Body: `{ token: <fresh Bearer>, project: <projectId>, expiresAt }`. Implementation:
  `getGoogleAccessToken()` (refreshes via the OAuth backend helper) then
  `ensureCodeAssistProject(token)`. On no-credential → `401 { error: "google-not-authenticated" }`.
- **Never** logs/returns the refresh token; truncate+`redactSensitive` on errors (existing helpers).
- Caching: the endpoint is cheap (token+project both cached); no extra cache needed.

This mirrors `provider-bridge-extension.ts`'s `POST /api/sessions/:id/provider-hooks/...` callback
pattern (read `BOBBIT_GATEWAY_URL`+`BOBBIT_TOKEN`, `NODE_EXTRA_CA_CERTS` already pins the local CA).

### 4.3 Generated provider extension — new `src/server/agent/google-code-assist-extension.ts`

Model this file on `provider-bridge-extension.ts` (a `generate…Extension(sessionId): string`
returning self-contained TS, plus a content-addressed `write…Extension(sessionId): string` writing
under `.bobbit/state/google-code-assist/<hash>/provider.ts` and returning the path). The generated
extension:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// + inlined pure helpers from §4.1 (convertContextToCodeAssist, parseCodeAssistStreamChunk)
//   emitted into the generated string so the extension is self-contained in the sandbox.

export default function (pi: ExtensionAPI) {
  const sessionId = "<injected>";
  // read BOBBIT_GATEWAY_URL/BOBBIT_TOKEN (env → .bobbit/state files), like the bridge.
  async function fetchToken() { /* GET /api/sessions/:id/google-code-assist/token */ }

  function codeAssistStreamSimple(model, context, options) {
    const stream = createAssistantMessageEventStream();
    (async () => {
      try {
        const { token, project } = await fetchToken();
        const body = convertContextToCodeAssist({ model: model.id, project, context, options });
        stream.push({ type: "start", partial });
        for await (const chunk of codeAssistStream({ body, token, signal: options?.signal,
                                                      timeoutMs: options?.timeoutMs })) {
          // push text_start/text_delta/text_end, thinking_*, toolcall_* per pi protocol
        }
        stream.push({ type: "done", reason, message });   // stop | length | toolUse
      } catch (err) {
        stream.push({ type: "error", reason: aborted?"aborted":"error", error });
      }
    })();
    return stream;
  }

  pi.registerProvider("google-gemini-cli", {
    name: "Google (Gemini, account)",
    api: "google-code-assist",
    baseUrl: "https://cloudcode-pa.googleapis.com/v1internal",
    apiKey: "none",                 // token is fetched in streamSimple, not via apiKey
    streamSimple: codeAssistStreamSimple,
    models: [ /* the same ids/metadata getGoogleCodeAssistModels() emits */ ],
  });
}
```

Event-protocol contract the handler must satisfy (`pi-ai/dist/types.d.ts` `AssistantMessageEvent`):
emit `start`, then per content block `*_start`/`*_delta`/`*_end` (text / thinking / toolcall),
terminate with exactly one `done` (`reason ∈ {stop,length,toolUse}`) **or** `error`
(`reason ∈ {aborted,error}` with `errorMessage`). The `partial`/`message` carry the accumulating
`AssistantMessage` (`content: (TextContent|ThinkingContent|ToolCall)[]`, `api`, `usage`). Mirror the
emission shape in `pi-ai/dist/providers/google.js` (lines ~41–212) — it is the closest existing
reference and uses the identical event types.

Notes:
- `models[]` must stay in sync with `getGoogleCodeAssistModels()`. Factor the id/metadata list into a
  shared pure function (e.g. `codeAssistModelDescriptors()` in `google-code-assist-models.ts`) used by
  both the registry emitter and the extension generator, and add a pinning test that they match
  (mirrors the existing `NON_SESSION_SELECTABLE_PROVIDERS` ↔ per-model lockstep test).
- Token strategy decision: we fetch the token **inside `streamSimple`** (not via `apiKey`/`!command`)
  so a single network call yields both a fresh token *and* the projectId, refresh stays gateway-side,
  and nothing Google-account-scoped is persisted in the sandbox. The `apiKey:"none"` keeps
  pi-coding-agent's `validateProviderConfig` happy (it requires `apiKey` or `oauth` when models are
  defined). Optionally also pass an `oauth` impl so `/login` works inside a bare pi session, but the
  Bobbit session path does not need it.

### 4.4 Wire the extension into spawn — `session-setup.ts` + `session-manager.ts`

- In the same place the provider-bridge / tool-guard extensions are appended
  (`session-setup.ts:680-701`, `session-manager.ts:1775-1810`), conditionally append
  `--extension <writeGoogleCodeAssistExtension(sessionId)>` **iff** `hasGoogleCodeAssistCredential()`.
  Gate on credential presence so non-Google users pay zero overhead (mirrors the bridge's
  `hasProviderBridgeHooks` gate).
- The extension reaches the gateway via the env the bridge already relies on
  (`BOBBIT_GATEWAY_URL`/`BOBBIT_TOKEN` + `NODE_EXTRA_CA_CERTS`); no new env plumbing for local
  sessions. For Docker sessions the same env is exported and the gateway URL is sandbox-reachable
  (the bridge already POSTs to it). The extension file rides the existing tool/extension mount path.
- **Belt-and-braces for offline/egress-restricted sandboxes:** the existing
  `GOOGLE_CLOUD_ACCESS_TOKEN` env + sanitized sandbox `auth.json` (§1.1) can remain as a fallback
  token source inside `fetchToken()` (env first, gateway callback second) — but the gateway callback
  is the primary path because it refreshes. `GOOGLE_GENAI_USE_GCA=1` is **not** needed for our
  custom provider (it only affects the `@google/genai` SDK path, which we bypass).

### 4.5 Flip session-selectability — `google-code-assist.ts` + `google-code-assist-models.ts`

Only after §4.1–4.4 land and the manual-integration spike (§6) is green:
- Remove `"google-gemini-cli"` from `NON_SESSION_SELECTABLE_PROVIDERS` (or delete the set and make
  `isSessionSelectableProvider` always-true if it becomes empty — keep the exported function for the
  WS/review-override call sites so they need no change).
- In `getGoogleCodeAssistModels()`: set `sessionSelectable: true` and drop
  `sessionUnavailableReason` (and update `GOOGLE_CODE_ASSIST_SESSION_UNAVAILABLE_REASON` usage / the
  test that pins it). The ModelSelector then renders them as normal selectable rows.
- No change needed in `ModelSelector.ts`, `ws/handler.ts`, or `review-model-override.ts` — they read
  the flag/guard and will simply start allowing the provider.

### 4.6 Persistence / restore

No new work: the selected model is persisted as the `provider/modelId` preference and pinned at spawn
via `--model google-gemini-cli/<id>` (`rpc-bridge.ts:221`, `session-setup.ts:380-395`). Because the
extension re-registers the provider every spawn (including restore/respawn), a restored session
re-binds cleanly. The acceptance criterion "restart/reload preserves the model without fallback" is
met as long as §4.5's `sessionSelectable` stays true (a fallback only triggers when a pinned model is
absent/unselectable).

---

## 5. Cross-cutting behaviors

- **Streaming**: native SSE from `:streamGenerateContent?alt=sse` → pi event stream (§4.3). Partial
  text/thinking/tool-call deltas surface in the UI exactly like other providers.
- **Tool calls / results / multi-turn**: handled by `convertContextToCodeAssist` (functionCall /
  functionResponse parts, functionDeclarations) — see §4.1. `thoughtSignature` is preserved across
  turns for Gemini-3 thinking models (the main reason to prefer native over the OpenAI proxy).
- **System prompt**: `request.systemInstruction` (already in `buildGenerateContentBody`).
- **Abort / timeout**: `streamSimple` receives `options.signal` and `options.timeoutMs`; thread both
  into `codeAssistStream` using the existing abort+`Promise.race` pattern in `codeAssistPost`.
  Emit a terminal `error` event with `reason:"aborted"` when the signal fires.
- **Usage / cost**: map Gemini `usageMetadata` (`promptTokenCount`/`candidatesTokenCount`/
  `thoughtsTokenCount`/`cachedContentTokenCount`) into the pi `Usage` shape on the final
  `AssistantMessage`; per-token `cost` comes from the model descriptor (already carried, may be 0 for
  the free tier). Bobbit's existing cost-tracker consumes pi usage unchanged.
- **Errors / re-auth**: HTTP 401/403 from Code Assist or a `401 google-not-authenticated` from the
  token endpoint → terminal `error` event whose message tells the user to re-authenticate via
  Settings → Account → Google. `loadCodeAssist`/`onboardUser` failures surface verbatim (truncated,
  redacted). Quota/rate-limit (429) bubbles up as an error event with the provider message.
- **Project selection / paid tiers**: `ensureCodeAssistProject` already resolves and caches the
  free-tier project; honor `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env (and a persisted
  override in `~/.bobbit/agent/google-code-assist.json`) when present, so paid Code Assist / GCA
  subscriptions route under the user's chosen project.

---

## 6. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Extension import-resolution / `instanceof` identity** — the extension's `@earendil-works/pi-ai` must resolve to the *same* copy the turn loop uses, or `createAssistantMessageEventStream()` produces a foreign class. | Medium | Validate in a one-shot manual-integration spike (real Docker session, one Gemini turn) **before** §4.5 flips the flag. Existing extensions import `@earendil-works/pi-coding-agent` and work in the sandbox, and `registerProvider`'s internal `registerApiProvider` runs on the agent's own singleton (§1.3.3), so this is expected to hold; the spike de-risks it. Fallback: have the extension obtain the stream factory from the `pi` SDK surface rather than a direct pi-ai import if identity ever drifts. |
| pi-coding-agent `ProviderConfig`/`registerProvider` API changes across pi upgrades. | Low–Med | It's a public, documented extension API (less volatile than dist internals). Pin behavior with a manual-integration test; the budget/contract tests already guard pi version bumps. |
| Code Assist wire format drift (`v1internal`). | Low | Same endpoint Gemini CLI uses and that `codeAssistComplete` already targets in production; conversion is centralized in `google-code-assist.ts` and unit-tested. |
| Token expiry mid-session. | Low | Token fetched per request from the gateway endpoint, which refreshes; no long-lived token in the agent. |
| Docker egress to `cloudcode-pa.googleapis.com` blocked by a locked-down sandbox. | Low | Surface as a clear `error` event; API-key `google` provider remains the always-working in-session Gemini path. Document in the limitation copy. |
| ToS / account-risk of the Gemini-CLI installed-app client. | — | Unchanged from the shipped OAuth design; keep the existing caution copy. This goal adds no new Google surface — same Code Assist API, now consumed by sessions. |

---

## 7. Test hooks (authoritative plan owned by the tester; listed for traceability)

- **Unit (node)**: `convertContextToCodeAssist` (multi-turn, tools, images, system, thinking,
  `thoughtSignature` passthrough); `parseCodeAssistStreamChunk` (text/thinking/toolcall/usage/finish
  mapping); `codeAssistStream` against an SSE `fetchFn` stub incl. abort/timeout; model-descriptor
  lockstep test (registry emitter ↔ extension `models[]`).
- **Unit (node)**: `isSessionSelectableProvider("google-gemini-cli") === true` after the flip; the
  reason-string pin is removed/updated.
- **API E2E**: `GET /api/sessions/:id/google-code-assist/token` returns `{token,project}` for an
  authenticated account (mock outbound), `401 google-not-authenticated` otherwise, and never echoes
  the refresh token.
- **Browser E2E** (`tests/e2e/ui/settings.spec.ts` / model-selector pattern): with a stubbed Google
  credential, `google-gemini-cli` Gemini rows are **enabled** in the session model selector;
  selecting one persists across reload (guards the `sessionSelectable` regression).
- **Manual integration** (`tests/manual-integration/`, gate-exempt): real Google account → select
  `google-gemini-cli/gemini-2.5-pro` → a session answers, streams, calls a tool, receives the result,
  continues multi-turn; document quota/rate-limit behavior and the project/onboarding path. This is
  also the §6 import-identity spike.

---

## 8. Acceptance-criteria traceability

| Goal AC | Covered by |
|---|---|
| Authenticated Google account Gemini models selectable in the session picker | §4.5 (flip `sessionSelectable`) + browser E2E |
| Session can answer, stream, call tools, receive results, multi-turn | §4.1/§4.3 streaming + tool conversion; §5 |
| Restart/reload preserves the selected Google model without fallback | §4.6 |
| Expired token refreshes or fails with a clear re-auth message | §4.2 token endpoint refresh; §5 error handling |
| `google` API-key models remain separate and unaffected | Distinct provider/api/endpoint; no edits to the `google` path (§1.1, §2 option C rejected) |
| Tests pin that authenticated-but-unusable models no longer appear disabled | §7 unit + browser E2E once runtime exists (§4.5) |

## 9. Out of scope

- Upstreaming a `cloudcode-pa` provider to pi-ai (Option A) — possible later contribution.
- The OpenAI-compatible proxy (Option C) — documented fallback only.
- Vertex AI (`google-vertex`) and `gemini.google.com` web-cookie scraping (explicitly avoided).
</content>
</invoke>
