# Google account (Code Assist) models as agent session models

> **Archived design artifact — implemented and superseded.** This document preserves the
> pre-implementation proposal for historical rationale only. It is not an authoritative description
> of current behavior or an active implementation plan. In particular, references below to
> `sessionSelectable: false`, `NON_SESSION_SELECTABLE_PROVIDERS`, a missing provider/stream/tool/
> multi-turn runtime, Pi `0.79.x`, and tests that pinned the old gate describe the proposal-time
> system. See [Google OAuth & Gemini models](../google-oauth-models.md) for shipped behavior and
> [Pi runtime compatibility](../pi-runtime-compatibility.md) for the current Pi boundary.

**Current implementation:** account-backed `google-gemini-cli` models are session-selectable and run
through Bobbit's generated Code Assist provider extension. Sessions stream responses, call tools,
receive tool results, and preserve multi-turn context. Current v2 coverage pins the adapter and
selectability, generated provider runtime, registry isolation, token endpoint, and model-selector UI
in `tests2/core/google-code-assist*.test.ts`,
`tests2/integration/google-code-assist-token-api.test.ts`, and
`tests2/dom/ui-fixtures/model-selector-fixture.test.ts`.

## Historical proposal (pre-implementation)

Goal `Google Session Models` (`google-session-09851872`) proposed making Google account OAuth /
Gemini Code Assist models selectable and runnable as normal Bobbit agent **session** models, rather
than limiting them to gateway-side helper completions.

Companion / predecessor: [`google-oauth-model-auth.md`](google-oauth-model-auth.md), the earlier OAuth
login and gateway-helper-completion proposal. The retained plan below addressed the agent-session
runtime gap that proposal left open.

---

## 1. Historical audit captured before implementation

### 1.1 What worked before session support

- **OAuth + credential storage** (`src/server/auth/oauth.ts`): `google-gemini-cli` was already a
  first-class OAuth provider. The proposal observed provider-partitioned status, refresh, and logout
  around `auth.json["google-gemini-cli"]`.
- **Gateway-side Code Assist adapter** (`src/server/agent/google-code-assist.ts`): a single-turn
  `codeAssistComplete()` path already called `cloudcode-pa.googleapis.com/v1internal:generateContent`
  with a Bearer token. Its pure helpers handled request bodies, text extraction, project onboarding,
  and token refresh, and `completeModelText()` used it for title, name, and connection-test helpers.
- **Model emission** (`src/server/agent/google-code-assist-models.ts`): when a Google credential was
  present, Gemini ids were re-emitted under provider `google-gemini-cli` with
  `api: "google-code-assist"` and `baseUrl: cloudcode-pa…`, but the proposal-time rows carried
  **`sessionSelectable: false`** and `sessionUnavailableReason`.
- **Session-selectability guard** (`google-code-assist.ts`): the proposal-time
  `NON_SESSION_SELECTABLE_PROVIDERS` contained `"google-gemini-cli"`; its helpers rejected that
  provider at the binding paths, while the UI rendered `sessionSelectable === false` rows disabled.
- **Sandbox credential propagation** (`src/server/agent/host-tokens.ts`): the proposal found the
  `GOOGLE_CLOUD_ACCESS_TOKEN` mapping, sanitized `google-gemini-cli` auth entry, scoped `auth.json`
  mount, and allowed-token environment injection already scaffolded.

### 1.2 Runtime gap at proposal time

Agent sessions ran in a **separate `pi-coding-agent` process**, either as a local child process or
inside the sandbox. That process drove turns through the then-installed `@earendil-works/pi-ai`
`stream()` / `streamSimple()` dispatcher:

```js
// pi-ai/dist/stream.js
function resolveApiProvider(api) {
  const provider = getApiProvider(api);
  if (!provider) throw new Error(`No API provider registered for api: ${api}`);
  return provider;
}
```

The then-installed pi-ai `0.79.x` shipped providers for its built-in APIs, but **not
`google-code-assist`**, and its OAuth registry had no `google-gemini-cli` provider. Binding a
`google-gemini-cli/*` model at that time would therefore have failed on the first turn with *"No API
provider registered for api: google-code-assist"*. That proposal-time runtime gap explained the
historical `sessionSelectable: false` gate.

### 1.3 Historical Pi runtime capabilities verified against installed `0.79.6`

The recommendation depended on the following facts, which were confirmed against the installed
`0.79.6` distribution during design research:

1. **`Api` was an open string type.** The `0.79.6` declaration used
   `export type Api = KnownApi | (string & {})`, so a custom `api: "google-code-assist"` was legal.
2. **pi-ai exposed a public API registry.** The audited distribution exported
   `registerApiProvider`, `getApiProvider`, `unregisterApiProviders`, and `clearApiProviders`.
3. **pi-coding-agent exposed a first-class provider-registration extension hook.** Its
   `ExtensionAPI.registerProvider(name, config)` and `unregisterProvider(name)` contracts accepted a
   custom API, URL, key resolver, headers, model list, OAuth implementation, and—critically—a
   **`streamSimple` handler** for custom APIs:
   ```ts
   streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions)
                  => AssistantMessageEventStream;
   ```
   Internally, the audited pi-coding-agent model registry called
   `registerApiProvider({ api, stream: streamSimple, streamSimple }, "provider:<name>")` on the
   agent's **own** pi-ai singleton, and the doc comment notes the call "takes effect immediately…
   safe to call from command handlers or event callbacks." This is the supported, version-stable
   injection point — no monkey-patching of pi-ai dist required.
4. **Extensions were already Bobbit's agent-process injection mechanism**, including in the Docker
   sandbox. The audit found that extension imports resolved against the agent's own `node_modules`,
   allowing the generated provider to use the same `AssistantMessageEventStream` instance as the
   turn loop. Existing task, provider-bridge, and tool-guard extensions supplied precedents.
5. **`models.json` config values were resolved at runtime**, including leading `!command` values,
   while **`baseUrl` was literal**. The lack of environment substitution made a local gateway proxy
   awkward because host and Docker agents needed different addresses.
6. **The audited `AuthStorage.getApiKey()` could not refresh a `google-gemini-cli` OAuth entry**
   because the `0.79.6` OAuth registry returned no provider. The design therefore evaluated an
   extension-supplied OAuth implementation, a fresh-token command, or a spawn-time environment token.

---

## 2. Historical options evaluated

| # | Option | Verdict |
|---|---|---|
| A | **Upgrade / patch `@earendil-works/pi-ai`** to add a first-party `google-code-assist` provider. | **Rejected at design time.** The installed `0.79.6` line had no such provider, so this option would have patched two distribution copies without reaching the prebuilt Docker image. It remained a possible upstream contribution, not the proposed Bobbit mechanism. |
| B | **Bobbit-native pi provider via the supported `pi.registerProvider` extension hook.** A generated pi-coding-agent extension registers `api:"google-code-assist"` with our own `streamSimple` (Code Assist HTTP + Gemini↔pi conversion). | **RECOMMENDED.** Officially supported hook (§1.3.3), runs in both local and Docker sandbox via the existing `--extension` plumbing, no dist patching, full native Gemini fidelity (function calls, thinking, `thoughtSignature`), fixed public `baseUrl` (`cloudcode-pa`) so no local-gateway-URL problem. Reuses the gateway's already-shipped Code Assist pure helpers. |
| C | **Gateway-hosted OpenAI-compatible proxy.** Expose a local `…/v1/chat/completions` endpoint backed by Code Assist; write a `google-gemini-cli` provider into `models.json` with `api:"openai-completions"` pointed at it. | **Rejected as primary.** Two blockers: (1) **`baseUrl` is static in `models.json`** (§1.3.5) but the Bobbit gateway URL differs between local (`127.0.0.1:port`) and Docker (`host.docker.internal`/LAN) — there is no per-host env substitution for `baseUrl`, so a single shared `models.json` can't address both. (2) Lossy OpenAI↔Gemini round-trip drops Gemini `thoughtSignature`, degrading Gemini-3 multi-turn tool use (Bobbit is tool-heavy). Upside (reuses pi-ai's openai client, gateway-only creds) is real but doesn't outweigh the blockers. Kept as the fallback if B's fidelity ever regresses. |
| D | **Gemini CLI backend runtime** (OpenClaw-style CLI-backed session). | **Rejected.** A whole alternate session runtime is far larger than this goal and orthogonal to pi-coding-agent. Not justified. |

**Design-time recommendation: Option B.**

---

## 3. Proposed architecture (Option B)

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

Proposed properties:
- The `streamSimple` handler would be Bobbit code running inside the agent and talking directly to
  the fixed public Code Assist endpoint, avoiding a local-gateway URL and OpenAI translation.
- The agent would request only a fresh Bearer token and project id from an authenticated gateway
  endpoint. Per-request lookup would keep refresh logic gateway-owned and avoid persisting the token
  in the sandbox.

---

## 4. Historical implementation plan (exact proposal-time targets)

### 4.1 Promote the conversion/streaming core in `src/server/agent/google-code-assist.ts`

At design time this file had single-turn pure helpers. The proposal called for extending it while
keeping it dependency-light and free of pi-ai imports so the gateway and embedded extension could
share the implementation:

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
emission shape in pi-ai's Google provider implementation, which was the closest existing reference
and used the identical event types.

Notes:
- `models[]` must stay in sync with `getGoogleCodeAssistModels()`. Factor the id/metadata list into a
  shared pure function (e.g. `codeAssistModelDescriptors()` in `google-code-assist-models.ts`) used by
  both the registry emitter and the extension generator, and add a pinning test that they match
  (mirroring the proposal-time `NON_SESSION_SELECTABLE_PROVIDERS` ↔ per-model lockstep test).
- The proposal chose to fetch the token **inside `streamSimple`** rather than through
  `apiKey`/`!command`, so one request would return a fresh token and project id while keeping refresh
  gateway-side and avoiding persisted Google account material in the sandbox. It proposed the
  placeholder `apiKey:"none"` only to satisfy the then-current provider validation contract.

### 4.4 Wire the extension into spawn — `session-setup.ts` + `session-manager.ts`

- In the same session setup and manager paths that appended the provider-bridge and tool-guard
  extensions, conditionally append
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

The proposal deferred the gate flip until the runtime and manual-integration spike passed. It then
called for:

- removing `"google-gemini-cli"` from `NON_SESSION_SELECTABLE_PROVIDERS`, or making
  `isSessionSelectableProvider` always true if that left the set empty;
- setting emitted models to `sessionSelectable: true` and removing `sessionUnavailableReason`; and
- leaving the UI, WebSocket, and review-override consumers unchanged because they already respected
  the shared flag and guard.

### 4.6 Proposed persistence and restore behavior

The proposal expected the selected `provider/modelId` preference to be pinned at each spawn through
`--model google-gemini-cli/<id>`. Re-registering the extension on restore and respawn would then bind
the persisted model again rather than silently falling back.

---

## 5. Proposed cross-cutting behaviors

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
  override in the active `<agentDir>/google-code-assist.json`) when present, so paid Code Assist / GCA
  subscriptions route under the user's chosen project.

---

## 6. Risks and mitigations assessed during design

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Extension import-resolution / `instanceof` identity** — the extension's `@earendil-works/pi-ai` must resolve to the *same* copy the turn loop uses, or `createAssistantMessageEventStream()` produces a foreign class. | Medium | Validate in a one-shot manual-integration spike (real Docker session, one Gemini turn) **before** §4.5 flips the flag. Existing extensions import `@earendil-works/pi-coding-agent` and work in the sandbox, and `registerProvider`'s internal `registerApiProvider` runs on the agent's own singleton (§1.3.3), so this is expected to hold; the spike de-risks it. Fallback: have the extension obtain the stream factory from the `pi` SDK surface rather than a direct pi-ai import if identity ever drifts. |
| pi-coding-agent `ProviderConfig`/`registerProvider` API changes across pi upgrades. | Low–Med | It's a public, documented extension API (less volatile than dist internals). Pin behavior with a manual-integration test; the budget/contract tests already guard pi version bumps. |
| Code Assist wire format drift (`v1internal`). | Low | Same endpoint Gemini CLI uses and that `codeAssistComplete` already targets in production; conversion is centralized in `google-code-assist.ts` and unit-tested. |
| Token expiry mid-session. | Low | Token fetched per request from the gateway endpoint, which refreshes; no long-lived token in the agent. |
| Docker egress to `cloudcode-pa.googleapis.com` blocked by a locked-down sandbox. | Low | Surface as a clear `error` event; API-key `google` provider remains the always-working in-session Gemini path. Document in the limitation copy. |
| ToS / account-risk of the Gemini-CLI installed-app client. | — | Unchanged from the shipped OAuth design; keep the existing caution copy. This goal adds no new Google surface — same Code Assist API, now consumed by sessions. |

---

## 7. Proposed test hooks (retained for traceability)

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

## 8. Historical acceptance-criteria traceability

| Goal AC | Covered by |
|---|---|
| Authenticated Google account Gemini models selectable in the session picker | §4.5 (flip `sessionSelectable`) + browser E2E |
| Session can answer, stream, call tools, receive results, multi-turn | §4.1/§4.3 streaming + tool conversion; §5 |
| Restart/reload preserves the selected Google model without fallback | §4.6 |
| Expired token refreshes or fails with a clear re-auth message | §4.2 token endpoint refresh; §5 error handling |
| `google` API-key models remain separate and unaffected | Distinct provider/api/endpoint; no edits to the `google` path (§1.1, §2 option C rejected) |
| Tests pin that authenticated-but-unusable models no longer appear disabled | §7 unit + browser E2E once runtime exists (§4.5) |

## 9. Historical out of scope

- Upstreaming a `cloudcode-pa` provider to pi-ai (Option A) — possible later contribution.
- The OpenAI-compatible proxy (Option C) — documented fallback only.
- Vertex AI (`google-vertex`) and `gemini.google.com` web-cookie scraping (explicitly avoided).
