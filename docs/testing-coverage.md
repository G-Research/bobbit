# Testing Coverage

Per-area notes on what user stories and contracts are covered by which test files. For test architecture and harness APIs, see [testing-strategy.md](testing-strategy.md). For opt-in video capture on top of browser E2E, see [testing-tier-2-5.md](testing-tier-2-5.md).

## Prompt interactions

User stories PI-01 through PI-25 (+ sub-stories) are defined in `userstories/prompt-interactions.md`.

- **Unit fixture tests** — isolated component behavior: file attachments, drag-drop, voice input, model/thinking selectors, context bar, cost display, git status widget, background process pills, abort/focus management. Pattern reference: `tests/message-editor-attach.spec.ts`.
- **Browser E2E** — multi-component flows needing a real server: model persistence, context stats. Pattern reference: `tests/e2e/ui/prompt-stats-e2e.spec.ts`.
- **Spec-framework stories**:
  - `tests/e2e/ui/stories-streaming.spec.ts` — contracts CT-01 (streaming lifecycle) and CT-06 (focus follows intent), including ST-DEDUP-01 (reconnect-mid-stream dedup).
  - `tests/e2e/ui/transcript-fidelity.spec.ts` — generic invariant test asserting live DOM equals post-refresh DOM after a `STREAM_BURST:3` mock burst (counts, ordering, uniqueness). Catches the bug class PRs #436 and #437 fixed (in-flight `message_end` without a string id duplicating into MessageList + StreamingMessageContainer; un-id'd toolResult rows surviving snapshot reconciliation). See [testing-tier-2-5.md — Transcript-fidelity invariant](testing-tier-2-5.md#transcript-fidelity-invariant).
  - `tests/e2e/ui/stories-drafts.spec.ts` — contract CT-02 (draft preservation), 7 stories spanning all 8 contract variations, plus spec graph analysis tests.
- Story definitions registered in `tests/e2e/ui/story-registry.ts` for `tools/spec-check.ts` coverage reporting.

## Sidebar

User stories SB-00 through SB-37 (+ SB-00b) are defined in `userstories/sidebar.md`.

- **Unit fixture tests** — rendering logic: session hierarchy, time formatting, unseen activity, goal badges, PR status, setup indicators, empty states, sandbox indicators, role picker, staff rendering, mobile behavior, keyboard shortcuts.
- **Browser E2E** — multi-component flows: project collapse, goal team navigation, session switching, session create/rename/terminate, search filtering, archived toggle, sidebar collapse, goal actions.
- **Per-project Archived subsections** — `tests/e2e/ui/sidebar-archived-per-project.spec.ts` (4 tests): per-project rendering with no global block; per-project collapse state persists across reload; search surfaces archived items in the correct project subsection; global See Archived toggle hides all per-project subsections at once. Uses per-test isolation — `beforeEach`/`afterEach` spin up fresh projects + archived goals with unique suffixes; `localStorage` (`bobbit-show-archived`, `bobbit-archived-collapsed-projects`) is cleared via `addInitScript` before each `openApp` so retries pass `--repeat-each=5` cleanly.
- **Mobile archived filtering + matched-term highlighting** — `tests/e2e/ui/sidebar-mobile-archived-search.spec.ts` (filter at 375×667, `<strong>` wrapper for matches) and `tests/render-highlighted-text.spec.ts` (empty query, single/multiple matches, case-insensitive, regex-special chars).
  - **Goal-group Show Busy / Show Read filters** — `tests/sidebar-goal-group-filters.html` + `tests/sidebar-goal-group-filters.spec.ts` (15 file:// fixture cases) and `tests/e2e/ui/sidebar-goal-group-filters.spec.ts` (3 browser E2E cases). Pin the contract that `renderGoalGroup` calls `passesSidebarFilters` for every child row: Show Busy / Show Read apply uniformly to team lead, team children, and plain goal sessions; non-empty `state.searchQuery` bypasses filters; the active session is always exempt; team-lead is sticky (re-inserted at its natural position when any child still passes) and the goal header always renders even when the filtered child list is empty. Browser E2E covers reload persistence via `localStorage` (`bobbit-show-read`).
- **Shared helpers** — `src/app/render-helpers.ts` exports `filterArchivedGoalsByQuery`, `filterArchivedSessionsByQuery`, `renderHighlightedText`, used by both `renderSidebar` (`src/app/sidebar.ts`) and `renderMobileLanding` (`src/app/render.ts`).
- **Mobile per-project Archived subsections** — `tests/e2e/ui/sidebar-mobile-archived-per-project.spec.ts` (4 tests at 375×667, mirrors desktop file). Mobile and desktop share `renderProjectArchivedSection` in `src/app/render-helpers.ts` (+ `bucketArchivedByProject` for mobile; desktop keeps its inline bucketing loop in `sidebar.ts` which additionally emits `console.warn` for orphaned items). Mobile hides the "Load more archived…" pagination buttons while `state.searchQuery` is active; desktop retains global pagination.
- **Spec-framework stories**:
  - `tests/e2e/ui/stories-sidebar.spec.ts` — CT-03 (sidebar highlights), CT-04 (live status).
  - `tests/e2e/ui/stories-navigation.spec.ts` — CT-13 (URL routing & keyboard shortcuts).
- Pattern references: `tests/sidebar-hierarchy.spec.ts` (unit), `tests/e2e/ui/sidebar-navigation.spec.ts` (E2E).

## Sessions & resilience

User stories defined in `userstories/sessions.md`, `userstories/resilience.md`, and the session subset of `userstories/projects.md`.

- `tests/e2e/ui/stories-sessions.spec.ts` — S-01 through S-12 (create, switch, draft isolation, delete, rapid switching, worktree, rename, persistence, messaging).
- `tests/e2e/ui/stories-resilience.spec.ts` — RE-01 through RE-08, all running under standard `npm run test:e2e` via the in-process crash/restart harness (`gateway.crash()` / `gateway.restart()` in `tests/e2e/gateway-harness.ts`, wired into `event.server_crash` / `event.server_restart` in `spec-framework.ts`). RE-05 (Docker sandbox container recovery) auto-skips when Docker isn't reachable via `isDockerAvailable()` from `tests/e2e/test-utils/docker.ts`. See [testing-strategy.md → Writing crash/restart E2E tests](testing-strategy.md#writing-crashrestart-e2e-tests).
- `tests/e2e/ui/stories-projects.spec.ts` — PR-01/PR-04/PR-09/PR-10 (project organization).
- All stories registered in `tests/e2e/ui/story-registry.ts`; `tools/spec-check.ts` reports per-contract variation coverage (CT-05 at 75%, CT-16 at 100%).
- **Framework extensions** in `tests/e2e/ui/spec-framework.ts`: `ProjectHandle` entity handle; `SpecContext.createTestSession(name, opts)` accepting `opts.cwd` (worktree-backed) and `opts.goalId` (goal-scoped); `SpecContext.create_session_via_ui()` and `rename_session()` for sidebar-driven flows; `event.disconnect()` to force a WebSocket close; `event.server_crash()` / `event.server_restart()` which bounce the in-process gateway via the worker-scoped `gateway` fixture (re-binds the same port, reuses `bobbitDir`).

## Provider opt-in auth

Covers the behavior documented in [provider-opt-in-auth.md](provider-opt-in-auth.md): per-vendor enablement, direct-cloud auth gate, AI Gateway bypass, credential preservation/removal, Google OAuth fallback, model filtering, and no unauthenticated cloud auto-select.

- **API E2E** — `tests/e2e/provider-opt-in-api.spec.ts`: status redaction, enablement persistence, provider-key removal without disabling, disabled providers hidden from `/api/models`, direct-cloud session creation `409 cloud_auth_required`, AI Gateway `aigw_bypass`, host/env-managed credentials, invalid credential recovery, and image-provider auth-failure marking.
- **Browser E2E** — `tests/e2e/ui/settings.spec.ts`: Settings → System → Account provider rows for Anthropic/OpenAI/Google, persistence across reload, cleanup/undo, credential removal copy, default-model reset on disable, and AI Gateway suppression of connect/API-key actions.
- **Browser E2E** — `tests/e2e/ui/provider-auth-gate.spec.ts`: auth gate cancel safety, Google API-key fallback, Anthropic/OpenAI manual OAuth fallback, status-refresh fail-closed, and AI Gateway bypass.
- **OAuth/API E2E** — `tests/e2e/oauth-flow-status.spec.ts` and `tests/e2e/ui/authenticate-gateway-oauth-regression.spec.ts`: provider-isolated OAuth flows, callback completion enabling provider preferences, Google OAuth 501/API-key guidance, and gateway authentication not starting Anthropic OAuth.
- **Unit tests** — `tests/image-generation-registry.test.ts` and `tests/get-image-model-for-session.test.ts`: provider-aware image registry, aliases, authenticated-only defaults, and persisted image-model fallback when a provider is disabled or unauthenticated.

## Tail-chat / scroll pin

User-facing contract: "if I am at the bottom when content arrives, I stay at the bottom" across streaming bursts, tool-result expansion, session navigate, image/iframe reflows, and user-scroll-up release.

- **Outcome-only helpers** — `tests/e2e/ui/tail-chat-helpers.ts` exports `expectLatestMessagePinned` (reads `getBoundingClientRect()` of the latest message vs the scroll container) and `disableScrollAnchoring` (cascades `overflow-anchor: none` so Chromium ≡ Safari inside the test). Tests assert only on these helpers and on `expect(locator).toBeVisible()` — never on private fields like `_stickToBottom` or `_programmaticEchoes`.
- **Browser E2E specs** — `tests/e2e/ui/tail-chat-real-stream.spec.ts` (canonical realistic streaming pattern), `tail-chat-tool-expand.spec.ts`, `tail-chat-rapid-stream.spec.ts`, `tail-chat-session-navigate.spec.ts`, `tail-chat-user-scroll-up.spec.ts`, `tail-chat-image-reflow.spec.ts`, `tail-chat-jump-button-false-positive.spec.ts` (asserts the Jump-to-bottom button stays hidden while we're at the tail during a streaming burst — guards against the post-PR-#468 false-positive regression), `tail-chat-near-bottom-relock.spec.ts` (user wheels up ~30 px within the 70 px near-bottom band, then content grows — assert auto-relock fires without a Jump click), `tail-chat-tool-expand-reflow.spec.ts` (toggle a long bash tool-result expander and assert the pin survives the resulting reflow). Each test drives real preconditions (`STREAM_BURST:N`, `STAY_BUSY:Nms`, trusted `page.mouse.wheel`) and opts into Tier 2.5 video capture so failures are reviewable visually under `RECORDSCREEN=1`.
- **Sensitivity-verified** — each rewritten test is known to fail when its corresponding production path is neutered (near-bottom band, gesture-freshness gate, jump-button recompute on bail paths, RO `delta>0`). Matrix documented in [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).
- **Production invariant** — `agent-interface .overflow-y-auto` ships with inline `overflow-anchor: none` so Chromium and Safari/iOS PWA execute the same JS pin path; CI on Chromium catches what Safari users would otherwise see in production. Contract in [docs/internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant).
- **Lower-tier scroll specs** — unit-level coverage of the scroll lock primitives lives in `tests/agent-interface-scroll.spec.ts` (zero-delta vibration), `tests/agent-interface-scroll-hardening.spec.ts` (echo ring, sub-pixel rounding), `tests/scroll-anchor-shrink.spec.ts`, `tests/collapse-scroll-bugs.spec.ts`, `tests/mobile-scroll-keyboard.spec.ts`, `tests/e2e/ui/jump-to-bottom.spec.ts`.

## Agent tool-use canary (two layers)

Two complementary tests pin the agent's tool-call wiring after the pi 0.70+ `--tools` semantics drift that motivated commit `fdfee7c5`. Together they catch a future pi upgrade that silently strips Bobbit extension or MCP meta-tools from the agent's allowlist — the original regression class.

### Layer 1 — unit contract pin (`npm run test:unit`)

- **File**: `tests/tool-activation-contract.test.ts`. Runs in seconds; no LLM, no Docker.
- **What it pins**: the exact `{ args, env }` shape `computeToolActivationArgs()` (in `src/server/agent/tool-activation.ts`) emits for a representative role config — `--no-builtin-tools`, `--no-extensions`, `--extension <…>/defaults/tools/_builtins/extension.ts` for the re-registered file builtins, plus `env.BOBBIT_BUILTIN_TOOLS` as the sorted, comma-joined builtin list. Asserts the broken pre-fix `--tools` flag is **not** present.
- **Why a unit test**: the integration canary below is the end-to-end proof but takes minutes and needs a real LLM. The contract test makes a flag-semantics regression fail CI in seconds on every commit, so the integration canary only has to catch genuinely new failure modes.

### Layer 2 — manual-integration canary (`npm run test:manual`)

- **File**: `tests/manual-integration/agent-tool-use.spec.ts`. Real LLM + Docker sandbox.
- **Why it exists**: an earlier upgrade of the upstream `@earendil-works/pi-*` packages silently broke all agent tool use; no test in the unit / API / browser layers exercised a real LLM-driven agent calling tools end-to-end, so the regression escaped the whole suite. This spec is the canary that fails fast on the next pi bump if the tool-call wiring breaks again.
- **What it covers**: seven scenarios, each in its own fresh sandboxed session — builtin `bash`, the `defaults/tools/filesystem/edit` MCP tool, the `defaults/tools/filesystem/find` MCP tool, mid-tool steer/interrupt (long-running bash, then pivot), a tool error path (`edit` on a missing file), a Bobbit extension tool (`web_fetch` against the gateway's own `/api/health`), and an MCP meta-tool (`mcp_describe` against the playwright MCP server). Together they exercise the three categories that matter for the `--tools` regression class: pi builtins, Bobbit extension tools, and MCP-backed tools.
- **Tool-name-specific assertions**: every tool-card wrapper in the UI carries `data-tool-name="<name>"` (single attribute on the shared wrapper in `src/ui/components/Messages.ts`). Spec helpers `countToolCardsByName(page, name, ...substrings)` and `assertNoOtherToolCards(page, exceptName, ...substrings)` query by that attribute, so a substitute tool — e.g. the LLM falling back to `write` + `read` when `bash` is stripped — does **not** pass the assertion. The previous substring-only check reported all-green on the broken pi precisely because the substitute cards still contained the prompt's sentinel text.
- **Sentinel-based positive assertions**: each scenario instructs the agent to emit a unique sentinel (`HELLO_<nonce>`, `DONE`, `COUNT=3`, `PIVOT_ACK`, `EDIT_FAILED:`, `HEALTH_OK_<nonce>`, `MCP_OPS_<nonce>=<n>`) and asserts it appears in the rendered transcript or on disk. Assertions are deliberately on observable user-facing behavior rather than on internal session logs or pi-ai event shapes, so the test stays valid across pi-internal refactors.
- **Runtime budget**: ~5 min inside the existing `npm run test:manual` envelope; scenarios run serially in fresh sessions to keep each one independent and the failure signal narrow.
- **Gate on pi upgrades**: this spec must be green on the currently pinned pi line **before** any `@earendil-works/pi-*` version bump, and must stay green after. If it regresses after a bump, the bump is the bug — adapt Bobbit to pi's new API rather than relaxing the spec.

### Adding a new tool category to the canary

When a new tool category appears (e.g. a new MCP meta-tool, a new Bobbit extension family, a new pi builtin) and the existing seven scenarios don't already exercise it, add one representative scenario inside the existing `test.describe.serial("Agent tool use", ...)`:

1. Pick one representative tool from the category — one is enough; the unit contract pins the flag-level shape for the rest.
2. Prompt the agent to name the tool explicitly and emit a unique sentinel observable in the UI DOM or on disk (no log scraping).
3. Positive: `countToolCardsByName(page, "<tool>", ...substrings)` ≥ 1, and the sentinel appears in the transcript.
4. Negative: `assertNoOtherToolCards(page, "<tool>", ...substrings)` — a substitute that produces the same visible side-effect must not pass.
5. Use a fresh sandboxed session per scenario so failures don't cross-contaminate.

Do **not** add a scenario per individual tool — the unit contract test is the canary's complement and pins the rest of the surface.

## Sidebar child auto-loading

Ensures visible sidebar entries always have their children loaded.

- **API tests** — `tests/e2e/sidebar-child-loading.spec.ts`, `tests/e2e/archived-session-merge.spec.ts`: verify server-side BFS enrichment covers `teamGoalId`, `teamLeadSessionId`, `delegateOf` chains; archived-goals response includes affiliated sessions.
- **Browser E2E** — `tests/e2e/ui/sidebar-child-loading.spec.ts`: expanding a goal always shows its children including archived team members and delegates.

## Provider overload / transient error auto-retry

Covers `maybeAutoRetryTransient`, `nextBackoffDelay`, and the two-policy model described in [docs/auto-retry.md](auto-retry.md).

- **`tests/backoff-delay.test.ts`** (unit) — pins `nextBackoffDelay` in isolation: doubling sequence, cap enforcement at `maxMs` before and after jitter, jitter bounds (±20%), finite output for very large attempt counts.
- **`tests/auto-retry-policy.test.ts`** (unit) — pins the end-to-end policy decision tree using the same exported building blocks (`isTransientReviewError`, `isProviderBackoffError`, `nextBackoffDelay`) the manager calls: overload/rate-limit retries indefinitely past the 3-attempt bounded cap; HTTP 429/529 phrasings classified as provider-backoff; non-provider transient errors stop after attempt 3; non-transient errors produce no retry.
- **`tests/queue-dispatch.spec.ts`** (unit, session-manager simulation) — pins `pendingAutoRetryTimer` teardown on explicit retry; explicit retry resets `transientRetryAttempts` while auto retry preserves it; provider-overload errors bypass the 3-attempt non-provider cap.
