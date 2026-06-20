# Test Plan — Google account (`google-gemini-cli`) session models

Status: test plan (no production code or tests changed in this document).
Goal: `Google Session Models` — make Google-account-authenticated Gemini (`google-gemini-cli` /
Code Assist) models usable as normal Bobbit agent session models, not just gateway-side helper
models.

This is the output of the test-planning task. It audits the **current** test coverage around the
`google-gemini-cli` provider and specifies the **exact** unit / API / browser / manual tests the
implementation must add or invert to prove the acceptance criteria. File paths and assertions below
are concrete targets for the test-writing follow-up; no code is written here.

> **Convention used below.** Each proposed item is tagged **[INVERT]** (an existing test whose
> assertion must flip once the runtime gains support), **[NEW]** (a brand-new test), or
> **[KEEP]** (an existing guard that must continue to pass unchanged — the isolation invariants).

---

## 0. The contract under test

After Google OAuth (`Settings → Account → Google`) succeeds:

1. `google-gemini-cli/*` Gemini models become **session-selectable** (today they are emitted with
   `sessionSelectable: false` and rejected at every binding choke point).
2. A session bound to such a model can **answer, stream, call tools, receive tool results, and
   continue multi-turn** context.
3. Selection **persists** across reload and server restart with **no fallback** to another model.
4. An expired/invalid Google token **refreshes** or fails with a **clear re-auth** message.
5. The API-key-only `google` (Gemini Developer API) provider and Anthropic/OpenAI models are
   **unaffected** — and the OAuth↔API-key isolation invariant still holds.

The crux for testing: the gate today is enforced in **four places that all funnel through two
helpers** in `src/server/agent/google-code-assist.ts`:

- `isSessionSelectableProvider(provider)` / `isSessionSelectableModelString(modelString)` — backed
  by `NON_SESSION_SELECTABLE_PROVIDERS = { "google-gemini-cli" }`.
- Per-model `sessionSelectable: false` emitted in `src/server/agent/google-code-assist-models.ts`.

Choke points that consume them (each has a test):

| Choke point | Source | Existing test |
|---|---|---|
| Model registry emission | `google-code-assist-models.ts` | `tests/google-code-assist-registry.test.ts` |
| Binding helper (role override / `default.sessionModel` / spawn / picker) | `review-model-override.ts::applyModelString` | `tests/review-model-override.test.ts` |
| WS `set_model` | `src/server/ws/handler.ts` | *(none — gap)* |
| Session-manager fallback (role + `default.sessionModel`) | `session-manager.ts` ~L4941/5016/5050 | *(none — gap)* |
| Selector UI | `src/ui/dialogs/ModelSelector.ts` | `tests/ui-fixtures/model-selector-fixture.spec.ts` |

When the runtime gains real support, the implementation flips the gate. **Every test that pins the
gate-on contract must be inverted in lockstep**, and new tests must prove the runtime actually runs
the model. The drift cross-check in `google-code-assist.test.ts` (`every emitted … model is
sessionSelectable:false AND fails the guard`) is the canary: it will fail the moment the gate flips,
forcing the inversion.

---

## 1. Audit of existing coverage

### 1.1 Unit — pure adapter + registry

- **`tests/google-code-assist.test.ts`**
  - `buildGenerateContentBody` / `extractCodeAssistText` — pure request/response conversion (system
    instruction, project, thinking budget, wrapped-vs-bare candidates, empty payloads).
  - `codeAssistComplete` — single-turn completion via injected `fetch`: posts to `:generateContent`,
    returns text, throws "No Google account credential", surfaces+redacts HTTP error bodies, honours
    `timeoutMs` (aborts, threads `AbortSignal`).
  - `ensureCodeAssistProject` — `loadCodeAssist` happy path + `onboardUser` polling.
  - `hasGoogleCodeAssistCredential` / `getGoogleAccessToken` — fresh token, stale-token last-resort.
  - **session-selectability guard** — `isSessionSelectableProvider/ModelString` return **false** for
    `google-gemini-cli`, **true** for `google`/`anthropic`; drift cross-check vs emitted models.
  - **Coverage gaps:** only **single-turn text**; no streaming, no tool calls/results, no multi-turn
    `contents` array, no token-refresh-on-401 path, no project-env (`GOOGLE_CLOUD_PROJECT`) selection.

- **`tests/google-code-assist-registry.test.ts`**
  - `isOAuthCapableProvider` includes `google-gemini-cli`, excludes API-key `google`.
  - Emits `google-gemini-cli` Code Assist models only when a credential is present; each is
    `api: "google-code-assist"`, `authenticated: true`, `id` matches `^gemini-`.
  - **Pins gate-on:** every account model is `sessionSelectable: false` with
    `sessionUnavailableReason`.
  - **Isolation [KEEP]:** API-key `google` stays selectable; a generic OAuth token does **not**
    authenticate `google`.

- **`tests/review-model-override.test.ts`**
  - `applyModelString` session-selectability guard rejects `google-gemini-cli/...` before `setModel`
    is called; still binds a normal model. **Pins gate-on.**

- **`tests/sandbox-google-auth.test.ts`** — sandbox `auth.json` propagation (sanitized OAuth fields
  only, never email/profile/scope; policy opt-in via `GOOGLE_CLOUD_ACCESS_TOKEN`; Codex/Google
  isolation; `resolveHostTokenValue` env override). **[KEEP]** — credential propagation is already
  solid and is exactly what a sandboxed session run needs.

- **`tests/oauth-google.test.ts`** — OAuth start/complete/refresh/logout for `google-gemini-cli`.
  **[KEEP]** (token lifecycle).

- **`tests/models-api.test.ts`** — generic registry structure invariants (every model has
  `id/name/provider/contextWindow/...`). **[KEEP]** — new `sessionSelectable` field must not break it.

### 1.2 Browser fixtures (file://)

- **`tests/ui-fixtures/model-selector-fixture.spec.ts`** — a `google-gemini-cli` model renders with
  `data-session-unavailable="true"`, `cursor-not-allowed`, "can't run in agent sessions" tooltip,
  and clicking it does **not** select. **Pins gate-on.**
- **`tests/ui-fixtures/settings-account-tab.spec.ts`** — Google OAuth row: log-in / authenticated /
  reload-persistence / logout, plus the "can't run Gemini through your Google account yet"
  limitation note + API-key cross-link. **Partially pins gate-on** (the limitation copy).

### 1.3 API / E2E

- **`tests/e2e/oauth-google-logout.spec.ts`** — full gateway logout for the canonical provider.
  **[KEEP]**
- **`tests/e2e/models-api.spec.ts`** — `GET /api/models` (aigw discovery). No `google-gemini-cli`
  coverage. **Gap.**

### 1.4 Manual integration (real agents + Docker)

- **`tests/manual-integration/agent-tool-use.spec.ts`** — real agent runs a tool. Pattern to clone.
- **`tests/manual-integration/manual-test-model-seeding.ts`** — seeds `default.sessionModel` from
  `MANUAL_TEST_MODEL`. The seam for a live Google-account run. **No Google coverage today.**

### 1.5 Summary of gaps (what proves the new behaviour)

1. No runtime test that a `google-gemini-cli` model can be **bound** to a session and **run**
   (stream / tools / multi-turn).
2. No WS `set_model` test (accept-now / reject-before contract).
3. No session-manager fallback test for the role + `default.sessionModel` paths.
4. No token-refresh-on-401 unit test for the Code Assist adapter.
5. No browser E2E proving an authenticated Google model is **selectable, binds, persists across
   reload, and survives restart**.
6. No manual/live path for a real Google account.

---

## 2. Proposed tests

### Phase A — Unit (`npm run test:unit`, `node:test`)

#### A1. `tests/google-code-assist.test.ts` — extend (same file)

- **[INVERT] session-selectability guard.** Once the gate flips, change the existing
  `isSessionSelectableProvider(GOOGLE_GEMINI_CLI_PROVIDER)` assertion from `false` → `true`, and the
  `isSessionSelectableModelString("google-gemini-cli/gemini-2.5-pro")` from `false` → `true`. The
  drift cross-check block must invert to assert every emitted model is `sessionSelectable !== false`.
  - If a config flag gates selectability only **when authenticated**, parameterise: with no
    credential the models are not emitted at all (already covered); with a credential they are
    selectable.

- **[NEW] streaming conversion.** A `streamCodeAssist` / generator path must surface incremental
  text. Assert: feeding a sequence of SSE/`streamGenerateContent` chunk payloads yields ordered text
  deltas whose concatenation equals the final assistant text, and a terminal chunk closes the stream.
  - Assertion shape: `assert.deepEqual(collected, ["hel", "lo", " world"])`, final joined `=== "hello world"`.

- **[NEW] tool-call conversion (request).** Extend `buildGenerateContentBody` (or a new
  `buildGenerateContentRequest`) to translate Bobbit/pi tool definitions → Code Assist
  `tools[].functionDeclarations`. Assert names/params/required are mapped and that an empty tool list
  omits `tools` entirely.

- **[NEW] tool-call extraction (response).** A new `extractCodeAssistToolCalls(payload)` must read
  `functionCall` parts: assert `[{ name, args }]` extraction, mixed text+functionCall parts, and
  empty when none.

- **[NEW] tool-result round-trip.** Translating a tool result back into a `functionResponse` part
  for the next turn: assert the `role: "user"`/`functionResponse` shape with `name` + `response`.

- **[NEW] multi-turn `contents`.** Building a request from a multi-message history must emit ordered
  `contents` with correct `role` mapping (`assistant` → `model`, tool result → `functionResponse`).
  Assert the array length and per-entry roles.

- **[NEW] token refresh on 401.** With an injected `fetch` returning `401` once then `200`, and a
  `getToken` stub that returns a refreshed token on the second call, assert the adapter retries with
  the new Bearer and ultimately returns text. Also assert: when refresh yields no token, the error
  message matches `/re-?authenticat|No Google account credential/i` (clear re-auth signal,
  acceptance criterion 4).

- **[NEW] project env override.** With `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` set, assert
  `ensureCodeAssistProject` (or the new resolver) prefers the env project over `loadCodeAssist` and
  does **not** call `onboardUser`. Restore env in `afterEach`.

#### A2. `tests/google-code-assist-registry.test.ts` — invert + extend (same file)

- **[INVERT]** "marks google-gemini-cli account models as not selectable" → assert
  `m.sessionSelectable !== false` (selectable) and that `sessionUnavailableReason` is absent once
  runtime support exists.
- **[KEEP, must still pass]** API-key `google` stays selectable; generic OAuth token does not
  authenticate `google`; `google-gemini-cli` models only emitted when credential present; each is
  `api: "google-code-assist"`, `authenticated: true`.
- **[NEW] both providers coexist.** With **both** a `google-gemini-cli` OAuth credential and
  `GOOGLE_API_KEY` set, assert the registry emits `provider: "google"` (selectable, API-key) **and**
  `provider: "google-gemini-cli"` (selectable, OAuth) as distinct entries — no collision, no dedup
  collapsing them.

#### A3. `tests/review-model-override.test.ts` — invert (same file)

- **[INVERT]** "rejects a not-session-selectable provider" → `applyModelString(rpc,
  "google-gemini-cli/gemini-2.5-pro", …)` now **binds**: assert
  `rpc.setModelCalls` contains `["google-gemini-cli", "gemini-2.5-pro"]` and read-back succeeds.
- **[KEEP]** the read-back-mismatch hard-fail contract (catches a silent fallback to another model —
  directly guards acceptance criterion "no fallback").

#### A4. `tests/google-code-assist-session-bind.test.ts` — NEW file (session-manager fallback)

Covers `session-manager.ts` model resolution (~L4941/5016/5050) which currently **skips**
`google-gemini-cli` for role-model + `default.sessionModel`.

- **[INVERT/NEW]** With `default.sessionModel = "google-gemini-cli/gemini-2.5-pro"` and a credential
  present, assert the resolver **returns** that model (no fallback / no warn-skip).
- **[NEW]** With a role override pinned to a `google-gemini-cli` model, assert it is honoured.
- **[NEW] negative:** with **no** credential, binding still falls back gracefully (model not emitted
  → resolver picks the default) — proves we don't hard-fail an unauthenticated environment.
- Pattern: follow the existing `review-model-override.test.ts` RPC stub (`setModelCalls`,
  `getState`). Use an isolated `BOBBIT_AGENT_DIR` temp `auth.json` per `beforeEach`.

#### A5. `tests/ws-set-model-google.test.ts` — NEW file (WS `set_model` contract)

Today `handler.ts::set_model` rejects with `MODEL_NOT_SESSION_SELECTABLE` for `google-gemini-cli`.

- **[INVERT]** With a credential present, `set_model {provider:"google-gemini-cli", modelId:"gemini-2.5-pro"}`
  calls `rpcClient.setModel`, persists via `persistSessionModel`, and emits **no**
  `MODEL_NOT_SESSION_SELECTABLE` error.
- **[KEEP]** a genuinely unknown/unrunnable provider still errors.
- **[NEW]** `set_model` failure (rpc throws) still surfaces `SET_MODEL_FAILED` (no silent swallow).
- If a focused WS-handler unit harness does not exist, place these as API E2E in Phase B instead
  (see B2) and keep this file as a thin logic test over an extracted `isSessionSelectableProvider`
  branch.

### Phase B — API / E2E (`npm run test:e2e`, in-process harness)

#### B1. `tests/e2e/models-api-google-account.spec.ts` — NEW

- Seed an isolated `auth.json` with a `google-gemini-cli` OAuth credential (future-dated `expires`)
  via the e2e isolated state dir (never the real `.bobbit`).
- `GET /api/models`: assert ≥1 model with `provider === "google-gemini-cli"`,
  `api === "google-code-assist"`, `authenticated === true`, and **`sessionSelectable !== false`**.
- Assert a `provider === "google"` API-key model is present and selectable **only** when
  `GOOGLE_API_KEY` is set, and that the two providers never collapse.
- Negative: without the credential, no `google-gemini-cli` models appear.

#### B2. `tests/e2e/set-model-google-ws.spec.ts` — NEW (mirror `set-image-model-ws.spec.ts`)

- Open a session, send WS `set_model` for `google-gemini-cli/gemini-2.5-pro`, assert the session
  state reflects the bound model and **no** error frame with `code: "MODEL_NOT_SESSION_SELECTABLE"`.
- Reconnect / re-fetch session state: assert the model **persists** (acceptance criterion 3, reload
  half).
- Negative control: a non-selectable provider (if any remain) still yields the error frame.

### Phase C — Browser E2E (`tests/e2e/ui/*.spec.ts`)

#### C1. `tests/e2e/ui/google-account-model-select.spec.ts` — NEW

Full user-facing flow (AGENTS.md mandates a browser E2E for every user-facing feature: navigation,
happy path, persistence across reload, cleanup). Stub `/api/models` + `/api/oauth/status` so no real
Google account is needed.

- **Navigation/visibility:** with Google authenticated, open the model selector; the
  `google-gemini-cli` Gemini row renders **enabled** (no `cursor-not-allowed`, no
  `data-session-unavailable="true"`).
- **Happy path (select):** click the row → assert it becomes the selected session model
  (`provider/id === "google-gemini-cli/gemini-2.5-pro"`).
- **Persistence across reload:** reload the page; assert the selected model is still bound (re-fetch
  path, no fallback to a different model).
- **Isolation:** the API-key `google` Gemini row is still present and selectable in the same list.

#### C2. `tests/ui-fixtures/model-selector-fixture.spec.ts` — INVERT/extend (same file)

- **[INVERT]** Add a sibling case: a `google-gemini-cli` model with `sessionSelectable: true`
  (omitted) renders **enabled** and **is** selectable on click. Keep the existing disabled-case as a
  regression for *any* model that still legitimately carries `sessionSelectable: false` (the field
  contract must keep working generically).

#### C3. `tests/ui-fixtures/settings-account-tab.spec.ts` — update copy assertion (same file)

- **[INVERT]** The "can't run Gemini through your Google account yet" / "official model API"
  limitation note must change once sessions can run Google models. Update the assertion to match the
  new copy (e.g. a caution about account-risk/terms rather than "not usable"). Keep the API-key
  cross-link assertion.

### Phase D — Manual integration (`npm run test:manual`, gate-exempt, real LLM + Docker)

#### D1. `tests/manual-integration/google-account-session.spec.ts` — NEW

Live proof against a real Google account (skipped unless explicitly enabled). Gate on an env flag so
CI never requires a Google account:

- Skip the whole describe unless `MANUAL_TEST_MODEL` starts with `google-gemini-cli/` **and** a
  Google OAuth credential exists (reuse `seedManualTestModelPreferences`).
- **Answer + stream:** prompt "Reply with the single word READY"; assert streamed assistant output
  contains `READY` and arrives incrementally (>1 delta or a streaming event observed).
- **Tool call + result + continuation:** drive the `agent-tool-use.spec.ts` scenario (e.g. a `bash`
  echo or `read` tool) using the Google model; assert the agent issues a tool call, receives the
  result, and produces a correct multi-turn follow-up answer (acceptance criterion 2).
- **Restart persistence:** restart the gateway (pattern from `restart-minimal.spec.ts`); assert the
  session is restored **still bound to** the Google model with no fallback (acceptance criterion 3).
- **Quota/expiry behaviour:** document (and, where feasible, assert) that an expired token yields the
  clear re-auth error rather than a silent hang.

#### D2. Sandbox credential propagation (manual)

- Extend or add a manual case asserting a **sandboxed** session with the Google model picks up the
  sanitized `auth.json` (`GOOGLE_CLOUD_ACCESS_TOKEN`, `GOOGLE_GENAI_USE_GCA=1` if used) and can run.
  The sanitization unit guarantees are already in `tests/sandbox-google-auth.test.ts` **[KEEP]**;
  this proves the end-to-end runtime read inside Docker.

---

## 3. Isolation invariants that MUST keep passing (regression guard)

These are the "do not break `google` API-key or Anthropic/OpenAI" acceptance criteria. None should
change when the gate flips; if any breaks, the implementation regressed isolation:

- `tests/google-code-assist-registry.test.ts`: API-key `google` selectable; generic OAuth token does
  not authenticate `google`.
- `tests/sandbox-google-auth.test.ts`: Codex/Google sandbox-auth isolation, sanitized fields only.
- `tests/oauth-google.test.ts` + `tests/e2e/oauth-google-logout.spec.ts`: provider-partitioned OAuth
  lifecycle (logging out Google never touches `anthropic`/`openai-codex`/API-key `google`).
- `tests/models-api.test.ts`: generic model structure (new `sessionSelectable` field optional, must
  not break existing models).

A dedicated **[NEW]** assertion (A2 "both providers coexist") makes the separation explicit: an
OAuth credential and an API key authenticate two **distinct** providers simultaneously.

---

## 4. Phase mapping & invariants

| Test file | Phase | Type pin (`tests/test-phase-invariant.test.ts`) |
|---|---|---|
| `google-code-assist.test.ts` (extend) | unit·node | `*.test.ts` |
| `google-code-assist-registry.test.ts` (invert) | unit·node | `*.test.ts` |
| `review-model-override.test.ts` (invert) | unit·node | `*.test.ts` |
| `google-code-assist-session-bind.test.ts` (new) | unit·node | `*.test.ts` |
| `ws-set-model-google.test.ts` (new) | unit·node | `*.test.ts` |
| `model-selector-fixture.spec.ts` (invert) | unit·browser (file://) | `*.spec.ts` |
| `settings-account-tab.spec.ts` (update) | unit·browser (file://) | `*.spec.ts` |
| `models-api-google-account.spec.ts` (new) | API E2E | `tests/e2e/*.spec.ts` |
| `set-model-google-ws.spec.ts` (new) | API E2E | `tests/e2e/*.spec.ts` |
| `google-account-model-select.spec.ts` (new) | browser E2E | `tests/e2e/ui/*.spec.ts` |
| `google-account-session.spec.ts` (new) | manual | `tests/manual-integration/*.spec.ts` |

All temp credentials/`auth.json` go in per-test `mkdtempSync` dirs under `BOBBIT_AGENT_DIR`/the e2e
isolated state dir and are removed in `afterEach`/`afterAll` — never the real `.bobbit/`. No test
may commit credentials or leave artifacts in the repo.

---

## 5. Sequencing for the implementer

1. Land the runtime adapter (streaming + tools + multi-turn + refresh) → **Phase A1** new conversion
   tests can be written first and TDD'd against the pure helpers (no network).
2. Flip the gate → invert A1/A2/A3 guard assertions + C2/C3 fixtures **in the same commit** so the
   drift cross-check stays green.
3. Add session-bind + WS tests (A4/A5/B2) → proves binding/persistence at the server boundary.
4. Add browser E2E (C1) → proves the user-facing select+reload path with stubbed APIs.
5. Add manual D1/D2 → live proof against a real account, gated behind an env flag so CI is unaffected.

The single most important new assertion is the **read-back-no-fallback** check (A3 [KEEP], B2, D1
restart): it is what distinguishes "selectable" from "actually runs and stays bound", which is the
real acceptance bar for this goal.
