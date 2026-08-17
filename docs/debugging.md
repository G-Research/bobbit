# Bobbit — Debugging Guide

Scannable checklists for common issues. Each entry: symptom → where to look → key detail.

## Dev UI stays grey after a source edit or pull

- **Symptom**: after a TypeScript edit, `git pull`, or checkout, Vite reloads but the inline grey shell remains for tens of seconds. A proxy `ECONNABORTED` / `ECONNRESET` may appear during navigation.
- **Cause**: Bobbit's large eager browser graph took one request per source module under Vite's unbundled dev server. Client timing showed `modules-evaluated` at 46.95 s while WebSocket auth plus a 1.1 MB transcript snapshot completed in the following 0.56 s; the gateway was not the bottleneck.
- **Fix**: development enables Vite's bundled dev mode (`experimental.bundledDev`) so Rolldown serves a small set of in-memory chunks and performs incremental HMR. A separate-port proof reduced a warm full reload to 597 ms. Production keeps the normal mount-aware build configuration. Tailwind source detection is explicitly limited to `src/`, `index.html`, and mini-lit so agent edits to tests and documentation do not queue CSS regeneration. Tailwind 4.3.3 needs the narrow `tailwindcssWithBundledDevGuard` compatibility shim from its merged upstream fix; remove that shim after upgrading to a release containing tailwindlabs/tailwindcss#20379.
- **Repeatable profile**: run `npm run profile:hmr` for an isolated bundled-Vite + Chromium loop that leaves the working tree and live HMR channel untouched. Use `--clients <count> --exercise-lazy` to stress multiple connected clients and lazy route growth. Compare the retained `.bobbit-qa/vite-hmr-results/latest.json` rather than timestamps from manual edits.
- **Residual long-lived slowdown**: if the isolated profile remains near its baseline while the live server takes tens of seconds, close stale Bobbit tabs and restart Vite. Bundled dev uses Rolldown's own accumulating watcher/cache and computes updates per connected HMR client; Vite's `server.watch.ignored` does not constrain that internal watcher yet. Repeated identical HMR log lines usually indicate multiple clients, not multiple filesystem events.
- **Mobile stuck on “Bundling in progress”**: the fallback page depends on Vite's HMR WebSocket and does not poll for bundle readiness. A DNS-mounted client used to receive HTTP 400 because Vite allowed the mesh IP but not the configured deSEC hostname. `vite.config.ts` now reads only that public hostname into `server.allowedHosts`; a client already stranded with an old WebSocket token needs one manual refresh after the fix.
- **Vite exits with `ERR_SERVER_ALREADY_LISTEN`**: bundled dev can race two slow `vite.config.ts` restart cycles and call `listen()` twice. All development launchers run Vite through `scripts/dev-vite.mjs`, which restarts an unexpected process exit with bounded backoff. It stops after repeated rapid failures so a persistent configuration error remains visible instead of looping forever.
- **Service worker**: a production worker must never control Vite. In dev, `main.ts` unregisters the exact mounted worker and clears only that mount's Bobbit caches.
- **Diagnostic**: enable Settings → Debug and inspect the latest `boot-timing.jsonl`. A long delay before `modules-evaluated` is Vite/browser loading; a delay after `ws-open` belongs to auth or snapshot recovery. Bundled dev requests `/assets/*.js`, not hundreds of `/src/**/*.ts` modules. Confirm `[boot]` / `[harness]` lifecycle logs before treating a proxy disconnect as a gateway restart.
- **Pinning test**: `tests2/core/vite-bundled-dev.test.ts`.

## Project Settings save returns `PROJECT_CONFIG_LOAD_FAILED` or `PROJECT_CONFIG_PERSIST_FAILED`

- **Symptom**: `PUT /api/projects/:id/config` or `PUT /api/project-config` returns 409 `PROJECT_CONFIG_LOAD_FAILED`, or 500 `PROJECT_CONFIG_PERSIST_FAILED`, instead of `{ ok: true }`.
- **Cause**: 409 means the existing `project.yaml` was unreadable, malformed, or not a mapping and the store refuses to overwrite it. 500 means its atomic temporary-file write or rename could not be completed.
- **Repair**: for 409, preserve the file, repair its YAML or filesystem access, then explicitly call `ProjectConfigStore.reload()` in a server integration or restart the gateway before retrying. For 500, verify the config directory is writable and retry. Do not retry settings writes against a 409 without first repairing and successfully reloading the file.
- **Safety checks**: failed publication keeps the old target bytes and committed getters; only the failing call's sibling temporary file is cleaned. Project-scoped sandbox-token value updates are staged until configuration publication succeeds, so the old secret values also remain in effect on a config-publication failure.
- **Secret persistence failure**: 500 `SANDBOX_SECRET_PERSIST_FAILED` means `project.yaml` was already published but its secret-value update failed. The published value-free token descriptors remain; `SecretsStore` bytes and getters retain their prior values. Fix state-directory permissions and retry the request; this two-file sequence cannot roll back the published descriptor.
- **Response safety**: persistence responses deliberately exclude YAML contents, token values, and raw filesystem errors. See [Project Config](rest-api.md#project-config) and [Durable publication and repair](internals.md#durable-publication-and-repair).

## Child scheduler stopped work or shows a recovery action

- **Symptom**: a child or root dashboard shows **Scheduler recovery**, a Plan
  node has a retry action, or logs contain a terminal child-start failure / root
  retry circuit-breaker message. This is an intentional bounded stop: it keeps
  a failing child from starving the gateway or disappearing silently.
- **First look**: open the affected root or child dashboard and read the
  recovery reason. The record is persisted and broadcast, so it remains visible
  across reloads and restart. A child record identifies a terminal start failure
  or exhausted transient retries; a root record identifies an immediate
  re-drive storm contained for that root only.
- **Repair**: resolve the stated prerequisite, then use **Scheduler recovery:
  retry**. Resume paused work; let dependency integration clear unresolved
  dependencies; enable or reopen work when applicable. The dashboard indicates
  that retry is unavailable while the goal is paused, blocked, complete, or
  shelved, and the route rejects it until that condition is resolved. It goes
  through the scheduler and therefore preserves root concurrency limits.
- **Do not use retry as a lifecycle bypass**: a paused child with tracked
  scheduler intent wakes on resume. Dependency-blocked work is re-requested
  when its final dependency integrates. Resume does not create starts for
  children configured for manual start, torn-down teams, unresolved dependencies, or children
  behind a still-paused ancestor.
- **Expected automatic repair**: an already-live non-terminated team lead is
  adopted by the scheduled start. A stale terminated lead is torn down and gets
  exactly one retry; failure after that is surfaced as an operator action.
  Transient setup/worktree failures back off on real timers for no more than
  eight start attempts before surfacing the same action.
- **If the root breaker reappears**: capture the scheduler error record and
  inspect the failing child/start adapter. The breaker is inline because an
  event-loop-starving microtask loop cannot rely on a timer watchdog; it counts
  only unproductive immediate re-drives, not normal scheduling volume. Delayed
  retries are retained and the record clears after progress or a later
  scheduler entry outside the breaker window.
- **Reference**: [Nested sub-goals — Bounded scheduled-start recovery](nested-goals.md#bounded-scheduled-start-recovery) and [Scheduled child-start recovery](rest-api.md#scheduled-child-start-recovery).

## Resource update returns `400` for request body fields

- **Symptom**: a finite-shape resource update returns `400` with `Unknown request body field` and one or more field names instead of `{ ok: true }`.
- **Cause**: the body includes a key outside that route's documented update contract. The server lists every offending key and applies none of the body, so an accidental field cannot create a false-success no-op.
- **Repair**: remove the unsupported fields or use the owning route. For goal policy fields (`subgoalsAllowed`, `maxNestingDepth`, `divergencePolicy`, `maxConcurrentChildren`), use `PATCH /api/goals/:id/policy`; its existing operator versus orchestration authorization still applies. `team` remains accepted by goal `PUT` clients for compatibility, but cannot disable always-on team mode. `repoPath`, `prUrl`, and immutable staff `sandboxed` are not update fields and must be omitted.
- **Reference**: [Goals](rest-api.md#goals) and [Staff Agents](rest-api.md#staff-agents).

## Unit `node-logic` runner timed out with no assertion failure

- **Symptom**: the `unit:` gate fails with `[run-unit] node-logic timed out after 1050000ms`; `browser-fixtures` passed; no test reported an assertion failure. The retained tail shows whatever printed last, not the culprit file.
- **Cause**: a single test/hook (or a leaked handle) never settles, so node's run never completes and `--test-force-exit` never fires; the wrapper then kills the runner at its own timeout without naming the offending file.
- **Fix**: `scripts/run-unit.mjs` passes `--test-timeout` (default 120s; `BOBBIT_UNIT_NODE_TEST_TIMEOUT_MS`) so a hung test/hook fails fast and node names it + file + line, well before the wrapper/gate timeout; and it pairs the `tap` reporter with `tests/helpers/hung-test-reporter.mjs`, whose on-disk heartbeat lets the wrapper's timeout path print `HUNG FILE: <path>` for files still in flight (the leaked-handle backstop). Diagnostics rendering is `scripts/lib/unit-heartbeat.mjs`.
- **First look**: the failure tail now contains either `test timed out after <n>ms` (with `test at <file>:<line>`) or `[run-unit] HUNG FILE: <path>`. Do not just raise the timeout — read the named file/test.
- **Pinning tests**: `tests/run-unit-wrapper.test.ts`, `tests/hung-test-reporter.test.ts`, `tests/run-unit-heartbeat-diagnostics.test.ts`, `tests/run-unit-hung-test-integration.test.ts`.

## Tier-1 credential-lock test consumes its file budget

- **Symptom**: `anthropic-oauth-credential-store.test.ts` passes on a retry or exceeds its per-file budget, usually in the tests that hold a Bobbit or Pi lock while fake timers are active.
- **Cause**: the lock owner has a repeating heartbeat interval. `vi.runAllTimersAsync()` drains every due timer, including newly scheduled heartbeats and retries, so it is not a finite way to wait for a contender. It can turn an assertion about a 10-second heartbeat or 30-second stale-owner compatibility contract into an unbounded fake-timer race.
- **Correct synchronization**: expose promises from the owner/contender callbacks and await the lifecycle point being asserted. Advance fake time only to the named contract boundary or the maximum retry interval, then await the contender's observable start promise. After releasing a lock, do not use a timer drain as a proxy for the contender having progressed. This preserves the 10-second synchronous heartbeat, 30-second asynchronous stale-owner protection, and post-release acquisition assertions without relying on elapsed wall time.
- **Diagnostic**: inspect the two lock-contention cases in `tests2/core/anthropic-oauth-credential-store.test.ts`. A newly added `runAllTimersAsync()` in either release path is a regression; `tests2/core/unit-flake-source-contract-repro.test.ts` pins that prohibition.
- **Retry-free checks**:

  ```bash
  npm run test:unit -- --retry=0 tests2/core/anthropic-oauth-credential-store.test.ts
  npm run test:unit -- --retry=0 tests2/core/unit-flake-source-contract-repro.test.ts
  ```

## Tier-1 sandbox-status test invokes Docker or leaks between gateways

- **Symptom**: `sandbox.test.ts` intermittently consumes its file budget, most visibly on Windows; status requests may wait for a real Docker invocation despite the integration gateway's command fence.
- **Cause**: `/api/sandbox-status` resolved Docker through the real or mutable server-global `CommandRunner` instead of the runner injected for that gateway request. The bypass can invoke host Docker and lets one gateway's runner selection affect another's tests.
- **Correct propagation**: the request handler receives the gateway's injected `CommandRunner` and must pass that exact runner to `checkDockerAvailability()`. The integration harness's fenced runner then rejects Docker deterministically, allowing the status route to return its normal unavailable shape without external Docker state. Do not replace this with a Docker-dependent test, a broad mock, or a longer timeout.
- **Diagnostic**: trace the `commandRunner` argument from gateway creation through `handleApiRoute()` to the sandbox-status call. The route must not reference `serverCommandRunner`; `tests2/core/unit-flake-source-contract-repro.test.ts` statically guards both requirements.
- **Retry-free checks**:

  ```bash
  npm run test:unit -- --retry=0 tests2/integration/sandbox.test.ts
  npm run test:unit -- --retry=0 tests2/core/unit-flake-source-contract-repro.test.ts
  ```

## Verification step stuck in `running`

- **Symptom**: a `command`-type verification step (e.g. `npm run test:e2e`) stays in `running` long past its configured `timeout`. `ps` shows orphaned `npm`/`playwright`/Chromium descendants of the gateway.
- **Cause**: Node's `child_process.spawn(..., { timeout })` and direct `process.kill(child.pid, sig)` only target the immediate child shell, not its descendants. The shell dies; everything it spawned keeps running. The harness's `child.on("close")` races against orphans holding stdio open.
- **Fix (tree-kill)**: command-step spawns use `src/server/agent/spawn-tree.ts`, which owns a detached POSIX group with an exact sentinel or a Windows `KILL_ON_JOB_CLOSE` Job assigned before the payload resumes. Live cleanup uses that spawn-time authority; recovered cleanup revalidates exact sentinel/Job evidence and never targets a historical PID or group number. SIGTERM is sent first, then SIGKILL escalates after the configured grace period. The helper owns the timeout timer — never re-add `spawn({ timeout })`; see [Exact process ownership for command verification](verification-restart.md).
- **Three integration points**: (1) live per-step timeout waits for spawn-time ownership; (2) cancellation and restart recovery persist intent before exact cleanup, then wait for payload and transport settlement; (3) gateway shutdown reaps non-surviving tracked children while restart-surviving work is resumed from durable state on the next boot.
- **Confirm a kill**: use retained verification output and the settled historical signal or gate detail, not a historical PID or cleanup-only active record, to establish the outcome. A timeout/cancel terminal result is published only after the owned tree is settled; Docker additionally requires payload cleanup before host `docker exec` transport cleanup.
- **Pinning tests**: `tests2/core/verification-harness-timeout.test.ts` (unit), `tests/e2e/verification-timeout.spec.ts` (E2E), `tests2/core/verification-command-restart-lifecycle.test.ts` (restart cleanup).

## Failed gate has missing or compact logs

- **Symptom**: a failed command verification shows only a short tail in `gate_status`, a notification, or default `gate_inspect`, and the original `test-results` / `playwright-report` directory is gone.
- **Expected behavior**: compact surfaces intentionally stay small. Before rerunning the suite, call `gate_inspect(section="verification", step="<failed step>", mode="grep"|"slice"|"tail"|"full")` so the snapshot can read retained stdout/stderr and Playwright-style artifacts from Bobbit state.
- **Where to look**: `steps[].diagnostics.outputSource`, `diagnostics.logs.*.{bytes,truncated,truncationReason}`, and `diagnostics.artifacts.files` in an explicit verification inspect response. Retained files live under the state `gate-diagnostics` tree and are removed when the owning goal is archived or deleted.
- **Limits/security**: stdout and stderr are capped independently at 20 MiB; `mode="full"` still has response/tool-result caps. Artifact copying rejects symlinked roots and descendants, so missing artifacts may mean Playwright did not write them or the path was unsafe to copy.
- **Reference**: [Retained gate diagnostics](gate-diagnostics.md).
- **Pinning tests**: `tests/e2e/gate-inspect-slicing.spec.ts`, `tests/gate-verification-snapshot.test.ts`, `tests/gate-diagnostics.test.ts`, `tests/gate-diagnostics-cleanup.test.ts`, `tests/e2e/gate-diagnostics-cleanup.spec.ts`.

## Command verification interrupted by gateway restart

- **Symptom**: after a gateway restart during a `command` verification step, the gate stays `pending` or the step shows `status: "waiting"` with text saying no durable command verdict was obtained. Older builds showed a fabricated failure such as `Verification command process died during gateway restart before producing an exit code`.
- **Expected behavior**: pending/retryable is correct when no durable verdict or exact cleanup authority exists. A valid host-authored result can be finalized only after its payload and transport cleanup settle. If a supported host command remains live, Bobbit reattaches only after its current identity matches durable evidence; Docker recovery instead requires its host-persisted witness and Engine attestation.
- **Where to look**: inspect retained step output first with `gate_inspect(section="verification", step="<name>", mode="tail"|"grep"|"slice")`. After cleanup settles, inspect the historical signal or gate detail for its durable outcome; do not rerun until you have checked the retained diagnostics.
- **Cleanup**: timeout/cancel recovery persists intent until exact cleanup settles. An unsafe/pending reason means Bobbit refused to signal an unverified or reused identity; investigate the ownership evidence and Docker Engine availability instead of manually killing a recorded numeric PID.
- **Reference**: [Exact process ownership for command verification](verification-restart.md) and [Verification cancellation lifecycle](verification-cancellation.md).
- **Pinning tests**: `tests2/core/verification-command-restart-lifecycle.test.ts`, `tests2/core/verification-command-restart-regression.test.ts`, `tests2/core/verification-harness-restart.test.ts`.

## Gate verification stuck on a `human-signoff` step

- **Symptom**: a gate's verification stays in `running` indefinitely; one of its steps is `type: human-signoff`. The chat-header `<goal-status-widget>` should be pulsing its primary-colour exclamation icon between the goal icon and gate counter, and **Start Review** in the widget or eligible active gate card should open or focus one sign-off review primary with Approve / Reject controls. Sign-off content is a one-file review, so no duplicate secondary file row should appear. Or: the review pane submits but never resolves the step.
- **Architecture**: the harness parks on a deferred resolver keyed by `${signalId}::${stepName}` in `VerificationHarness.pendingSignoffs`. The user resolves it via the review pane, which POSTs to `/api/goals/:id/gates/:gateId/signoff`. The `awaitingHuman` bit on the step record is the source of truth; `gate_verification_awaiting_human` is broadcast on park and `gate_verification_step_complete` on resolve. Full design: [docs/design/human-signoff-gates.md](design/human-signoff-gates.md); review behavior: [docs/review-pane-signoff.md — Review hierarchy and identity](review-pane-signoff.md#review-hierarchy-and-identity).
- **Diagnostic chain**:
  1. `curl /api/goals/:id/verifications/active` — confirm the step shows `awaitingHuman: true` and the substituted `humanPrompt` / `humanLabel` are non-empty.
  2. If the active record is missing entirely, inspect `gate.signals[]` history: a cancelled signal records `verification.status: "cancelled"` and its durable cause; otherwise the step may have completed under a different signal id. See [Verification cancellation lifecycle](verification-cancellation.md).
  3. Widget not pulsing despite `awaitingHuman: true` on the API? The sign-off cache bit (`state.gateStatusCache.<goalId>.awaitingHumanSignoff`) didn't reach the widget. Two pieces must line up: (a) the summary endpoint includes `awaitingSignoffCount`; (b) `src/app/gate-status-events.ts` classifies the park/resolve events so mounted session, widget, and dashboard paths refresh `state.gateStatusCache`.
  4. Approve / Reject POSTs return 409 `step is no longer awaiting human input`? The step was already resolved (idempotent surface) or cancelled. Inspect the latest signal's `verification.status` and named `verification.steps[]` status rather than inferring failure from `passed: false`.
  5. Approve / Reject POSTs return 403 for a sandboxed sub-agent? Expected — `sandbox-guard` blocks `/signoff` so an agent inside its own sandbox cannot self-approve a gating step.
- **After a server restart**: the resume path re-broadcasts `gate_verification_awaiting_human` from `_resumeOneVerification`, re-creates the resolver in `pendingSignoffs`, and `await`s. The persisted `humanPrompt` / `humanLabel` survive intact. If a pending sign-off is missing after restart, check `active-verifications.json` for the entry and confirm `step.awaitingHuman === true` survived the persistence round-trip.
- **Test bypass**: only `BOBBIT_HUMAN_SIGNOFF_SKIP=1` auto-passes `human-signoff` steps. There is **no** fallback to `BOBBIT_LLM_REVIEW_SKIP` — a "human" gate must not share a bypass with `agent-qa` / `llm-review`, or the global E2E harness would silently auto-approve every human gate. With `BOBBIT_HUMAN_SIGNOFF_SKIP` unset or `=0`, the step parks awaiting a real human decision.
- **Pinning tests**: `tests/e2e/human-signoff.spec.ts` (REST end-to-end), `tests/e2e/ui/goal-status-widget.spec.ts` (browser).

## Ready-to-merge fails with "Refusing unsafe git push"

- **Symptom**: a command verification step fails before running and its output starts with `[verification] Refusing unsafe git push in verification command`.
- **Cause**: the workflow contains a push that could update the protected base/primary branch from a goal/session branch. Common examples are `git push origin {{branch}}`, `git push` with no refspec, `git push --all`, or `git push origin {{branch}}:refs/heads/{{baseBranch}}`.
- **Fix**: publish the work branch with an explicit destination refspec: `git push origin {{branch}}:refs/heads/{{branch}}`. The Ready-to-Merge template should keep the follow-up `git ls-remote --heads origin {{branch}} | grep -q .` check.
- **Where to look**: custom workflow command steps in `project.yaml::workflows.*.gates.*.verify[].run`; runtime guard in `verification-harness.ts::validateVerificationPushSafety`; authoring guidance in [goals-workflows-tasks.md](goals-workflows-tasks.md#gate-verification-baselines).
- **Pinning tests**: `tests2/core/verification-push-guard.test.ts` and `tests2/core/goal-push-safety-regression.test.ts`.

## Agent pushed commits to a branch whose PR was already merged

- **Symptom**: an agent (regular session or team-lead) keeps pushing new commits to a branch whose PR is already closed/merged. The commits never appear on the primary branch — they are **orphaned**, because a merged PR is closed and re-pushing its head ref does nothing useful.
- **Why it bites**: squash- and rebase-merges are the common case here, and a plain ancestor check (`git merge-base --is-ancestor`) does **not** catch them — the squashed commit on the primary branch has a different SHA, so the original branch is never a literal ancestor. You must ask GitHub about the PR's state, not just inspect local history.
- **Detection (run before pushing or opening/updating a PR)**:
  - **Primary — `gh`**: `gh pr list --head <branch> --state all` — a `MERGED` (or `CLOSED`) entry means the branch is done. Catches squash/rebase merges. Bobbit is GitHub-centric, so `gh` is normally present.
  - **Fallback (only if `gh` is unavailable)**: detect the primary branch (`git symbolic-ref refs/remotes/origin/HEAD` — never assume `master`/`main`), then `git fetch origin <primary> && git merge-base --is-ancestor <branch> origin/<primary>` (exit 0 ⇒ already merged). Misses squash/rebase-merges, hence fallback only.
- **Recovery**: do NOT push more commits to the merged branch. Create a fresh branch off `origin/<primary>`, move the new work onto it, push that, and open a **new** PR.
- **Where the guidance lives** (keep these consistent if you touch one): the `## Pull requests` procedure in `defaults/system-prompt.md` (every session); the Ready-to-Merge step in `defaults/roles/team-lead.yaml` (goal-branch push); the re-attempt context in `src/server/agent/goal-assistant.ts` (new work goes on the fresh branch the re-attempt goal creates, never the old merged branch).
- **Pinning test**: `tests/system-prompt-merged-branch.test.ts` asserts the system-prompt `## Pull requests` section keeps the concrete detection commands and fresh-branch recovery wording, so it can't rot back into a vague one-liner.

## Streaming performance (UI sluggishness)

- **Architecture**: `StreamingMessageContainer` owns rendering during streaming via `setMessage()` with `requestAnimationFrame` batching. `AgentInterface` must NOT call `this.requestUpdate()` in the `message_update` event handler — only the streaming container updates on each token.
- **If the UI feels sluggish during streaming**: check `AgentInterface.setupSessionSubscription()` — the `message_update` case should only update the streaming container, not trigger a full `AgentInterface` re-render.
- **Markdown content throttle**: `AssistantMessage._getThrottledContent()` limits `<markdown-block>` `.content` updates to ~4x/sec (250ms) during streaming. This prevents `MarkdownBlock.render()` — which runs `marked.parse()` on the full text, reconfigures parser extensions, and does regex-heavy HTML escaping — from executing on every rAF frame. Without this throttle, HTML-heavy streaming responses cause main-thread jank because each `marked.parse()` call grows more expensive as content accumulates. The throttle uses the same pattern as `WriteRenderer._getThrottledCode()`: snapshot the content on first call, start a 250ms cooldown timer, and return the snapshot until the timer expires. A 20-character prefix check detects message identity changes (e.g. the element is reused for a different message) and resets the throttle immediately. When `isStreaming` flips to false, the timer is cleared in `render()` so the final content is always rendered accurately.
- **Text appears laggy or stale during streaming?** The 250ms throttle means visible text trails the actual streamed content by up to 250ms — this is intentional and barely perceptible. If text appears significantly more stale than that, check: (1) `_contentThrottleTimer` is being cleared when `isStreaming` becomes false, (2) the prefix-based identity reset in `_getThrottledContent()` is firing correctly when switching between messages, (3) no additional throttle or debounce has been added upstream in `StreamingMessageContainer`.
- **toolResultsById memoization**: `AgentInterface._getToolResultsById()` caches the tool-results Map to avoid creating a new reference on every render, which would cause `MessageList` to re-render unnecessarily.
- **content-visibility CSS**: `message-list > .flex > *` uses `content-visibility: auto` to skip layout/paint for off-screen messages in long conversations.
- State-transition events (`message_start`, `message_end`, `agent_start`, `agent_end`, `turn_start`, `turn_end`) still call `requestUpdate()` — only `message_update` (the hot path) is excluded.

## Pill strip layout (bash_bg pills + git-status-widget)

The pill strip above the composer (`AgentInterface._renderPillStrip`, `_measurePillOverflow`) has two viewport-conditional layout modes plus a width cache. Each piece pins a different invariant:

- **Symptom**: pills wrap onto a second row in desktop / landscape mode.
  - Content layer should be `flex-nowrap` when `_isNarrow === false`. Check `getComputedStyle([data-pill-content]).flexWrap` in DevTools.
  - Strip CSS `max-width` should resolve to `parent.clientWidth - 128`. The algorithm in `_measurePillOverflow` uses `parent.clientWidth - 128 - 2`; the two values must stay in lockstep. If you change one, change both.
  - Pinned by `tests/e2e/ui/pill-overflow-promotion.spec.ts → 'wide mode: strip stays on a single row even with many pills'`.

- **Symptom**: pills wrap onto 3+ rows in mobile / portrait mode.
  - Content layer should be `flex-wrap` when `_isNarrow === true`, strip `max-width: 75%`, algorithm budget `parent.clientWidth * 0.75 * 1.85`.
  - The 1.85 factor (not 2.0) buys back worst-case-slack: flex-wrap wraps whole items, so on cusp cases (e.g. three items at 60 % of row width each) a flat `* 2` budget can authorise content that overflows to a third row.
  - Pinned by `tests/e2e/ui/pill-overflow-promotion.spec.ts → 'narrow mode: strip never wraps to more than 2 rows'` (asserts `[data-pill-strip].offsetHeight ≤ 2 × 22px + gap`).

- **Symptom**: hidden pills inside the "more" popover refuse to promote back into the strip when visible pills are dismissed (the original B-A1 regression).
  - Root cause was twofold: (a) `_pillWidths` cache used `pillEl.parentElement.offsetWidth`, which for popover pills was the shared `.pill-more-popover` container, not the individual pill; (b) the popover's `flex flex-col` defaulted to `align-items: stretch`, so every pill inside got cross-axis-stretched to the popover content-box width.
  - Fix on both sides: cache reads `(pillEl as HTMLElement).offsetWidth` (custom element's own width), AND the popover uses `flex flex-col items-start` so individual pills keep intrinsic widths.
  - Pinned by `tests/e2e/ui/pill-overflow-promotion.spec.ts → 'narrow mode: hidden pills promote back into the strip after visible pills are dismissed'` (and the wide-mode equivalent in the same file).

- **Symptom**: the "X more" pill label wraps to two lines (e.g. "4" / "more") on a narrow viewport.
  - The inner button needs `whitespace-nowrap`; the outer relative wrapper needs `flex-shrink: 0` so a wide git-status-widget can't squeeze it.
  - Pinned by `tests/e2e/ui/pill-overflow-promotion.spec.ts → "'X more' pill label stays on a single line"`.

- **Sprite reserve**: the strip reserves `8rem` (128 px) on the left of the input container in wide mode so the bobbit sprite that bleeds down from the message area has clearance. The 25 % left reserve in narrow mode is the equivalent for mobile. Changing the sprite size or position needs a matching CSS + algorithm update.

- **Width cache lifecycle**: `_pillWidths` is a `Map<id, px>` filled by every measure pass from `pillStrip.querySelectorAll('bg-process-pill')`. Entries for IDs that disappear from `bgProcesses` are pruned each pass; the map is fully cleared on `bgProcesses.length === 0`. Never-measured pills (e.g. just spawned, no paint yet) use `DEFAULT_PILL_WIDTH = 100` until first measure replaces it. Width cache contamination is the most likely root cause of "pills won't promote / wrap weirdly" reports — inspect `_pillWidths` in DevTools.

## Composer ArrowUp recalls history one press too early / ArrowDown leaves history early

- **Symptom**: in the message composer, ArrowUp replaces the draft with the previous message while the caret still has lines above it. For example, type `Hello`, put the caret at offset 0, press Shift+Enter twice, then ArrowUp twice: the second press must move the caret to the blank first line, not recall history. The ArrowDown mirror is browsing history from the penultimate row and advancing or exiting history instead of moving down. Both can depend on width, font, and offset.
- **Where the logic lives**: `MessageEditor._isCursorOnVisualTopRow` / `_isCursorOnVisualBottomRow` in `src/ui/components/MessageEditor.ts`, both using `_measureCaretRowGeometry` with `_charRowTop` / `_charRectTop` as the rect primitive and `_firstWrapBoundary` for soft-wrap detection. The history state machine (`_historyIndex`, `_savedDraft`) is not implicated; diagnose the geometry predicate first.
- **Likely causes**: (1) a prefix-height measurement was reintroduced — a trailing newline creates no line box in `white-space: pre-wrap`, so measuring `value.slice(0, pos)` reads column 0 of line N as row N−1; (2) measured text was modified with a marker `<span>` or `\u200b` sentinel — splitting a text node or adding a line-break opportunity can move Chromium's `break-word` point; (3) an exact soft-wrap boundary was treated as a definite row — its before/after readings must agree before history may act.
- **Performance symptom**: a main-thread freeze on ArrowUp/ArrowDown with a large draft means a structural short-circuit or `_firstWrapBoundary`'s bounded prefix window was replaced by whole-value layout.
- **Verify**: `npx playwright test --config playwright-v2.config.ts --project=browser-v2 tests2/browser/fixtures/message-editor-arrows-real.spec.ts --reporter=line`. `tests2/dom/message-editor-arrows.test.ts` is an arithmetic model only: happy-dom has no layout engine and cannot expose browser geometry bugs.
- **Contract and rationale**: [Composer caret-row invariant](internals.md#composer-caret-row-invariant).

## Large file writes / large session history frames

- **System unresponsive during large writes?** The truncation system in `truncateLargeToolContent()` should strip content above `LARGE_CONTENT_THRESHOLD` (32KB) before `emitSessionEvent()` pushes to the EventBuffer and broadcasts. Check the `rpcClient.onEvent` subscription paths in `session-manager.ts`; they should call `truncateLargeToolContent(event)` and then `emitSessionEvent(session, truncated)`.
- **Reconnect or reload sends a huge history frame?** `get_messages` / attach hydration must call `truncateLargeToolContentInMessages()` before sending snapshots. It covers large tool text, preview snapshots, marker-less toolResult text blocks, and `verification_result.summary` / `verification_result.report_html` so reviewer reports do not replay as multi-MB WS frames.
- **Full content not loading in UI?** Both the generic **Load full content** action and a truncated preview reopen use `GET /api/sessions/:id/tool-content/by-tool-call/:toolCallId/:blockIndex`; preview adds `?expected=preview-snapshot`. Do not reconstruct a runtime message position from the rendered transcript: client-only compaction placeholders can make that position diverge. Check that the session's `.jsonl` still contains the tool call and requested block. `transcript_tool_call_unavailable` or `transcript_block_unavailable` means the transcript content is gone; `snapshot_block_mismatch` means the requested preview block was not a valid snapshot marker. The positional endpoint remains only for legacy-compatible callers. See [Tool-content identity resolution](rest-api.md#tool-content-identity-resolution).
- **Truncation happening for small files?** Threshold is `LARGE_CONTENT_THRESHOLD` (32KB) in `truncate-large-content.ts`. Only string content in text blocks, `toolCall`/`arguments`, and `tool_use`/`input` is checked; non-string payloads are passed through.
- **Search indexing memory spike?** `extractTextFromMessage()` should also handle truncated content gracefully — it receives the original event via `handleAgentLifecycle()`, not the truncated one. If indexing large content causes issues, the search extraction path may need its own truncation.
- **Preview artifact was evicted?** A v3 artifact-backed preview may return 404 during artifact restore after its owning session is purged or artifact cleanup runs. The widget disables with **Artifact evicted — rerun preview_open**; rerun `preview_open` to create a new immutable artifact. This is distinct from transcript-unavailable and snapshot-mismatch lazy-load errors above.
- See [docs/internals.md — Large content truncation](internals.md#large-content-truncation) for the full architecture.

## Duplicate messages

- All transcript mutations now go through the unified reducer in `src/app/message-reducer.ts`. Streaming-preview duplicate suppression is render-time: `AgentInterface.renderMessages` filters any message whose `id === streamingMessage?.id`.
- `MessageList` renders `state.messages` (completed); `StreamingMessageContainer` renders `state.streamMessage` (in-progress) — they must never overlap.
- Tool-call messages stay in streaming until the next message starts.
- See [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant) for the single-sort-key contract.

## Blob stuck idle while streaming (zzz visible with stop button)

- **Symptom**: chat blob shows the desaturated idle sprite with floating `zzz` while the agent is actively streaming (stop button visible, tool calls running). Stays wrong until the next `isStreaming` transition. Most reproducible by sending a new message immediately after the previous turn ends.
- **Root cause**: orphan `setTimeout` in `src/ui/components/StreamingMessageContainer.ts` exit/compaction paths writing `_blobState = 'idle'` after `isStreaming` flipped back to `true`. The entry path tracked its timer in `_entryTimer` and cleared it; exit/compaction timers were untracked.
- **Invariant**: every timer that writes `_blobState` must be stored in a field, cleared on any transition back to `active`/`entering`, and its callback must re-check `this.isStreaming` and the expected source state before writing.
- **Pinning test**: `tests/streaming-blob-state.spec.ts` — drives `isStreaming` false→true within the exit window and asserts the blob ends up `active`, not `idle`. Must fail on pre-fix master.

## Assistant reply generated + persisted but never reaches an attached client after the session hibernated/woke

- **Symptom**: a session goes idle/hibernated (chat blob shows the sleep `z` marker), the user sends a follow-up, the server **runs the turn and persists the assistant reply to the agent `.jsonl`** (`lastTurnErrored:false`, transcript grows), but the already-attached browser tab never renders the reply — even after reload — and the session re-hibernates. The user cannot tell "ignored" from "answered but not delivered".
- **Root cause (doc-04 F2e — dormant-revive split-brain)**: `addClient()`'s terminated-session branch used to call `restoreSession()` with no per-session mutex. The dormant entry stayed in the map for the whole restore window, so a second attach/revive — or a follow-up prompt — could start *another* full restore. Each `restoreSession()` builds a fresh `SessionInfo` with empty `clients` and a fresh `EventBuffer`, then replaces the map entry at the end. Client A ends up attached to the loser `SessionInfo`; the running bridge and `enqueuePrompt()`/`emitSessionEvent()` only ever touch the canonical (map) object, so client A's socket never receives the assistant `message_end`. The adjacent F7 leg: a prompt sent during the revive window queued on the stale object and was never drained. Full analysis: [docs/design/comms-stack/missing-live-messages-rootcause.md](design/comms-stack/missing-live-messages-rootcause.md).
- **Fix (CS-R2 subset — restore coordinator)**: all restore/respawn entry points now coalesce through a per-session coordinator so at most one restore is ever in flight, and only the current-generation canonical `SessionInfo` may broadcast/dispatch/mutate the queue. Key symbols in `src/server/agent/session-manager.ts`: `_restoreCoordinators` + `lifecycleGeneration` (the mutex + monotonic generation); `_coalesceRestore`/`_restoreSessionCoalesced` (join-or-start); `_fenceReplacedSession` (neutralises the replaced object — terminated, clients cleared, auto-retry cancelled, stale generation stamped); `_sessionWriterIsCurrent` (the no-op guard that `drainQueue`/`recoverPromptDispatch`/the auto-retry timer check); the `enqueuePrompt` revive-window join (a dormant/fenced/restore-in-flight prompt joins the coalesced restore and dispatches against the canonical object); and the single post-restore drain in `_restoreSessionCoalesced`. Contract: [docs/design/comms-stack/missing-live-messages-rootcause.md#implemented-fix--restore-coordinator-contract](design/comms-stack/missing-live-messages-rootcause.md#implemented-fix--restore-coordinator-contract).
- **If seen again**: confirm every restore-like caller routes through `_coalesceRestore`/`_restoreSessionCoalesced` (a stray direct `restoreSession()`/`_respawnAgentInPlace()` call re-opens the split-brain window), and confirm the four old-object writers still gate on `_sessionWriterIsCurrent` / the captured `lifecycleGeneration`. A client attached to a `lifecycleFenced` object is the tell.
- **Pinning tests**: `tests/missing-live-messages-repro.test.ts` (real `SessionManager`: concurrent dormant `addClient` revives join one restore and every attached client gets the post-revive frame; stale-generation writers no-op without bumping status or dispatching), `tests/e2e/ui/dormant-revive-live-reply.spec.ts` (browser: attach → hibernate → send → reply renders live with no reload).

## Streaming dedup / reorder

- **Symptoms**: during live streaming (not reload-replay), assistant or toolResult messages appear twice, or parallel tool results appear in the wrong order. Most often observed right after a mid-turn WS reconnect (dev-server restart, tab sleep/resume, flaky network) or during rapid parallel tool-call bursts.
- **Root cause in one line**: transport-level snapshot-vs-live race. See [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) for the architecture and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md) for the full reasoning.
- **On the wire**: every `{type:"event"}` frame must carry a numeric `seq` and `ts`. Inspect frames in DevTools → Network → WS. If `seq` is missing, the server is pre-fix or the frame didn’t go through `emitSessionEvent()` in `src/server/agent/session-manager.ts` — check for any stray `eventBuffer.push()` + `broadcast()` pair that bypasses the helper.
- **Client state**: `RemoteAgent._highestSeq` should advance monotonically; `_pendingEvents` should stay empty except during a brief out-of-order window. A persistently non-empty `_pendingEvents` means frames are arriving with a gap the server never closes — usually the `resume`/`resume_gap` handshake is broken.
- **Reconnect path**: after `auth_ok`, the client flushes queued `prompt`, `steer`, and `retry` frames before requesting resume or a snapshot. The outbox is FIFO; a failed send keeps the current item and unsent suffix for the next socket. The server must call `EventBuffer.canResumeFrom(fromSeq)` before `since(fromSeq)` and replay only a contiguous retained suffix.
- **Why `resume_gap` occurs**: the default buffer is bounded by both 1,000 events and 2 MiB of estimated serialized UTF-8. Count eviction, byte eviction, an oversized or unserializable event, or an intentionally unretained `pushFrame()` sequence can move the safe resume floor or create a hole. Replay can also fall back when the retained tail exceeds the replay budget or the socket cannot drain. The client must recover through `get_messages`; a partial suffix is not safe.
- **What to inspect**: compare `EventBuffer.size`, `retainedBytes`, `maxBytes`, and `lastSeq` with the client's `fromSeq`. `retainedBytes <= maxBytes` does not by itself prove resume safety: an unretained sequence can leave a hole inside the sequence space. Confirm `canResumeFrom(fromSeq)` succeeds before examining `since(fromSeq)`.
- **Focused coverage**: `tests2/core/event-buffer.test.ts` pins count/byte eviction, retained-byte accounting, oversized events, and `pushFrame()` holes. `tests2/dom/remote-agent-seq-dedup.test.ts`, `remote-agent-seq-overflow.test.ts`, and `remote-agent-sequence-hole.test.ts` cover client ordering and fallback; `tests2/dom/remote-agent-outbox.test.ts` covers FIFO preservation across reconnect send races.

## WebSocket bufferedAmount overflow / reconnect storm

- **Symptoms**: logs show `[ws] bufferedAmount=... > ... threshold; deferring terminate decision 10ms`, followed by `confirmed overflow after 10ms drain attempt` and browser reconnects. Vite may also log `read ECONNRESET`; treat that as a proxy symptom unless gateway boot logs show a real restart.
- **Read the payload diagnostics first**: overflow logs include `outerType`, `innerType`, serialized `bytes`, `recipient`, and optional `context`. `outerType=event innerType=message_update` points at session event/history truncation; `innerType=gate_verification_step_output` or `gate_verification_step_complete` points at verification WS output; `recipient=goal-session` / `goal-viewer context=goalId=...` points at goal-level fanout rather than one chat socket.
- **If `bytes` is large**: confirm the relevant sanitizer runs before send. Session events/history should pass through `truncateLargeToolContent()` / `truncateLargeToolContentInMessages()`; verification WS events should pass through `sanitizeVerificationWsEvent()` before `broadcastToGoal()`.
- **If `bytes` is small but `bufferedAmount` grows**: look for bursts multiplied by recipients. Goal broadcasts fan out to every matching goal session plus subscribed viewer sockets; verification output should be bounded per frame, but many fast frames can still expose a slow or dead client.
- **Reconnect loop after overflow**: inspect the `resume` path. Replay is capped by a byte budget and waits for drain; if the missed tail is too large or the socket is already backed up, the server sends `resume_gap` and the client must fetch `get_messages`. A loop usually means the client is not accepting `resume_gap`, the history snapshot is not being truncated, or a new live burst immediately re-fills the socket.
- **Extra diagnostics**: enable `BOBBIT_CPU_DIAG=1` (optionally `BOBBIT_CPU_DIAG_JSONL=<path>`) to record `session-manager:broadcast`, `server:broadcastToGoal`, and `ws-handler:resume` counters: frame count, recipients, bytes, skipped clients, replayed frames, and gaps.
- **Pinning coverage**: `tests2/core/ws-overflow-guard.test.ts` covers deferred terminate decisions, payload diagnostics, and resume byte-budget fallback. `tests2/core/truncate-large-content.test.ts` covers bounded session event/history payloads, including `verification_result` reports. `tests2/core/gate-verification-snapshot.test.ts` covers bounded verification WS output.

## Verification log duplicated Nx

- **Symptoms**: each line in the live verification output (`<verification-output-modal>` and `<gate-verification-live>`) appears multiple times. The multiplier matches the number of session WebSockets the current tab has open for that goal (3× with three sessions, 6× with six), with **+1 extra** when the goal dashboard is mounted, and **+1 more** if a `__viewer__` connection is active. Reopening the output modal mid-stream used to also re-print the bootstrap prefix.
- **Why**: every session in the UI owns its own `RemoteAgent`/WS, and the server's `broadcastToGoal` fan-out delivers each `gate_verification_*` payload to all of them. Pre-fix, each `RemoteAgent` (and the dashboard's viewer WS) called `document.dispatchEvent(new CustomEvent("gate-verification-event", …))` independently, so the document-level listeners in the modal and live renderer each appended one chunk per dispatch.
- **Where the dedupe lives**: `src/app/verification-event-bus.ts` exports `dispatchVerificationEvent(msg)`. All dispatch sites (`src/app/remote-agent.ts`, `src/app/goal-dashboard.ts`) funnel through it. The bus dedupes by composite key `(eventType, signalId, stepIndex, seq)` using a bounded `Set<string>` (~5000 entries with FIFO/LRU eviction so long-running sessions don't grow it unboundedly).
- **Server-stamped seq**: every `gate_verification_*` event now carries a monotonic `seq: number` assigned in `src/server/agent/verification-harness.ts` (added to the additive `seq` field on the message in `src/server/ws/protocol.ts`). When `seq` is missing (older server), the bus falls back to hashing the payload contents (`stream`/`text`/`status`…) which collapses identical fan-out copies but is best-effort.
- **Listener hygiene**: `src/ui/components/VerificationOutputModal.ts` and `src/ui/tools/renderers/GateVerificationLive.ts` register their `document.addEventListener` calls via an `AbortController`; teardown (`disconnectedCallback`, Lit re-render) calls `controller.abort()`, so listeners can't leak across mount cycles and re-fire on stale closures.
- **Bootstrap/live overlap**: when `VerificationOutputModal` opens with non-empty `initialOutput`, it records the highest `seq` already covered by the bootstrap and discards live events with `seq` ≤ that high-water mark. `_fetchBootstrapOutput` is also skipped when `initialOutput` is already populated, eliminating the prior "prefix shown twice" race.
- **Quick checks when triaging**: in DevTools, set a breakpoint inside `dispatchVerificationEvent` and confirm the `seen` set rejects N−1 of every N copies. If the bus is being bypassed, search for direct `document.dispatchEvent(new CustomEvent("gate-verification-event"…))` calls — the bus is the only legitimate dispatcher. If frames have no `seq`, server-side `verification-harness.ts` is on a pre-fix build.
- **Repro test**: `tests2/browser/fixtures/verification-dedup.spec.ts` is a Playwright file:// fixture that dispatches the same event 6× and asserts a single rendered occurrence on each component.
- **Architecture deep-dive**: [docs/internals.md — Verification event dedupe](internals.md#verification-event-dedupe). Parallel pattern (different event family) for the live agent stream: [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

## Session permanently fails with `unexpected tool_use_id`

- **Signature**: Anthropic returns `messages.<n>.content.<n>: unexpected tool_use_id ...`, followed by text explaining that a `tool_result` needs a corresponding `tool_use` in the previous assistant message. This is a poisoned-history error, not a transient provider failure: because every later request replays the same persisted history, ordinary follow-ups used to fail permanently with the same HTTP 400.
- **Cause and upstream status**: this is a historical upstream Pi race, not a regression introduced by Bobbit's Pi `0.81.1` upgrade. Pi commit [`ff5148e7`](https://github.com/badlogic/pi-mono/commit/ff5148e7cc7dc330fcc61b2619de43feb21022c0) introduced async handler-before-append ordering in `0.52.10` on 2026-02-12: `AgentSession._handleAgentEvent` awaited extension message handlers before appending, while listener invocations were not serialized. A later tool result could therefore reach disk before—or survive an interruption without—the assistant message that introduced its call ID. Bobbit first adopted an affected line at `@mariozechner/pi-coding-agent@0.57.1` on 2026-03-13. Upstream fixed the race on 2026-03-02 in [`dfc779faab24478fd4f6c608d78efe760a51160a`](https://github.com/badlogic/pi-mono/commit/dfc779faab24478fd4f6c608d78efe760a51160a), tracked by [`badlogic/pi-mono#1717`](https://github.com/badlogic/pi-mono/issues/1717), and the installed Earendil `0.81.1` runtime includes that serialized handling. Existing malformed transcripts still need repair, and force-abort, process exit, or gateway restart can expose an incomplete turn even after the race fix. Bobbit does not write Pi conversation rows, so the boundary sanitizer remains the compatibility guard.
- **Automatic boundary guard**: immediately before every `switch_session`, Bobbit runs the active-branch sanitizer for cold restore/revive, refresh/restart/in-place respawn (including role and sandbox recovery), the separate force-abort recovery path, and synchronous or worktree setup for continue-archived/fork. The same guard runs for host and sandbox sessions; sandbox container paths are translated to their host bind mount before the guarded write.
- **What is repaired**: only message-level `toolResult` records on Pi's active projected conversation branch are removed when their non-empty ID is absent from the immediately preceding assistant result run. Consecutive, missing-ID, mismatched, duplicate, and old-assistant results are invalid. Pi `0.81.1` compaction `retainedTail` messages participate in that projected order at their owning checkpoint. An embedded orphan is filtered by its `retainedTail` array index: the sanitizer rewrites only the owning compaction line, preserving every valid retained message and every other structural or unknown additive compaction field. Valid single or parallel call/result pairs, errored results, interrupted assistants whose calls have not returned, synthetic compaction pairs, metadata, and inactive-branch message content remain intact. Valid transcripts remain byte-identical; unrelated line ordering and trailing-newline shape are retained. When a removed top-level row was a parent, surviving descendants—including an inactive branch sharing that ancestor—receive only the minimum parent-link bypass needed to keep the Pi tree navigable. Repeating the sanitizer is a no-op. See [Pi runtime compatibility — Conservative active-branch repair](pi-runtime-compatibility.md#conservative-active-branch-repair) for the projection and structural-preservation contract.
- **User recovery**: click **Retry** or send a normal follow-up. Bobbit sanitizes and respawns the agent in place before dispatching once; it does not create a replacement Bobbit session. The session ID, selected model/thinking state, prompt queue, accepted prompt envelopes, visible valid history, and current user intent are preserved. Retry replays the original prompt when no tools ran, or uses the existing continuation instruction after a mid-tool failure to avoid repeating side effects. A follow-up sends the new intent without a generic error prefix and ahead of older parked prompts. REST/tool-driven session prompts use the same recovery path.
- **Bounded behavior**: recovery is user-driven, single-flight, and limited to one sanitize/respawn/redrive for the poisoned turn. Duplicate Retry actions join the same recovery. No automatic retry timer is armed, and a repeated ordering error is surfaced instead of entering a respawn loop. A repair count of zero may still cause one respawn because the disk transcript can already be clean while the old Pi process retains poisoned in-memory history.
- **Operator checks**:
  1. Confirm the complete error has the indexed message/content path, `unexpected tool_use_id`, and the corresponding previous `tool_use` explanation. Generic 400s do not enter this recovery.
  2. Look for `[session-manager] Poisoned-history repair session=<id> boundary=<retry|follow-up> repairedRecords=<count> sandboxed=<bool> project=<id>`. This diagnostic intentionally contains no tool IDs, payloads, transcript text, credentials, or provider request body.
  3. If recovery cannot write, inspect adjacent `[transcript-sanitizer]` refusal/failure warnings. Transcript mutation is allowed only for a regular `.jsonl` strictly inside a trusted agent-sessions root. Traversal, directory/final-component symlinks, non-regular files, and a path swapped between validation and write are rejected; the write is revalidated and uses `O_NOFOLLOW` where available. Exact legacy persisted files outside trusted roots may be read for compatibility but are never sanitizer write targets.
  4. For a sandbox session, verify the persisted path is in the correct realm: container paths must resolve through the sessions bind mount, while an already host-absolute path must remain a host path. Bobbit fails closed rather than switching realms or rewriting an arbitrary host file.
  5. If the same error remains after one user action, retain the session and transcript, capture the content-free recovery/refusal diagnostics, and inspect the persisted path/realm and Pi package version. Do not repeatedly Retry—the loop is intentionally bounded.

- **Reference and coverage**: [Pi runtime compatibility — Orphan tool-result persistence and recovery](pi-runtime-compatibility.md#orphan-tool-result-persistence-and-recovery); `tests2/core/transcript-orphan-tool-results.test.ts`, `tests2/core/orphan-tool-result-recovery.test.ts`, `tests2/core/orphan-tool-result-rehydration-boundaries.test.ts`, and `tests2/browser/e2e/orphan-tool-result-recovery.journey.spec.ts`.

## Session connection issues

- **Symptom: “Gateway is starting. Retrying automatically…”** — this is an intentional pre-auth `SERVER_STARTING` WebSocket frame while the gateway restores durable state. The browser retries with the server hint plus bounded backoff. Check boot logs; do not raise the client connect timeout or repeatedly recreate the session. HTTP surfaces concurrently return `503` + `Retry-After: 1`. See [Gateway readiness and retry](websocket-protocol.md#gateway-readiness-and-retry).
- **Symptom: `Connection timed out` with no readiness frame** — auth normally sends `auth_ok` promptly after session lookup. Under load, first inspect `[event-loop-lag]` warnings and their operation label. Search runs in a worker and must not be a gateway-loop label; a `search:*` persistence metric comes from the worker. Capture `BOBBIT_CPU_DIAG=1` (optionally `BOBBIT_CPU_DIAG_JSONL=<path>`) for timings. A persistent timeout without a lag warning can instead be proxy, transport, or authentication routing.
- **Symptom: 503 `search-unavailable` during session/search load** — `backpressure`, `degraded`, or `worker-backoff` means the search worker cannot safely provide complete results. It is not a session-worktree failure. Let recovery rebuild run; if it persists, check state-directory permissions and use Settings → Maintenance → Search Index → Rebuild Index. See [Search worker troubleshooting](search-worker-persistence.md#troubleshooting).
- Session creation logic lives in `session-setup.ts` (pipeline steps + executors) and `session-manager.ts` (thin wrappers).
- `executePlan()` runs the full pipeline synchronously for normal/delegate sessions; `executeWorktreeAsync()` is asynchronous for worktree sessions and immediately returns `status: "preparing"`.
- `handleSetupFailure()` owns cleanup on pipeline errors; `subscribeToEvents()` is the shared event subscription path.
- `connectToSession()` creates `ChatPanel` before `remote.connect()`; model and WebSocket connect in parallel. `switchGeneration` / `isStale()` fences rapid switches, connect failure clears `state.chatPanel`, and `get_state` synchronizes model/thinking values on connect and reconnect.

## Session/goal refresh not updating

- Both stores track a `generation` counter; clients pass `?since=N` to skip unchanged data
- Check `sessionsGeneration` and `goalsGeneration` in `state.ts`
- Server returns `{ changed: false }` when generation matches

## Gate status stale

- Server truth: `/api/goals/:id/gates?view=summary` is built by `src/server/gate-status-summary.ts` from `GateStore` plus `VerificationHarness` active verifications. It owns `passed`, `total`, `verifying`, `verifyingCount`, `awaitingSignoffCount`, `awaitingHumanSignoff`, `runningGateIds`, and each gate's `effectiveStatus`.
- Client cache: `src/app/api.ts` fetches that summary into `state.gateStatusCache`; `src/app/gate-status-events.ts` centralizes the gate lifecycle events that schedule targeted refreshes and the custom cache-updated/sign-off-resolved events used inside a browser tab.
- Surfaces: sidebar badges and the `GoalStatusWidget` pill read `state.gateStatusCache`; the widget popover refreshes full gates plus active verifications for row detail; the dashboard refreshes full gate details/active verifications but uses the shared summary for counts and running overlays in rows and pipeline nodes.
- If surfaces disagree, first compare the summary endpoint with `state.gateStatusCache` in the page. A stale cache usually means a missed `shouldRefreshGateStatusForEvent()` path; a wrong endpoint response points to `buildGateStatusSummary()` or active verification cleanup.
- Regression coverage: `tests/gate-status-summary.test.ts`, `tests/e2e/gate-status-summary.spec.ts`, `tests/e2e/ui/gate-status-cross-surface.spec.ts`, and the sign-off/reset cases in `tests/e2e/ui/goal-status-widget.spec.ts`.

## Context bar / model state

After a server restart, the context bar may show wrong info (e.g. 200k instead of 1M) or nothing at all. This happens because the agent process's `getState()` RPC may fail or return incomplete data before the process is fully ready.

- **Server-side fallback**: `sendFallbackModelState()` reads persisted `modelProvider`/`modelId` and calls `resolveModelStateMeta()` (last exact assembled row → exact direct Pi row → unavailable). It never fabricates family metadata. When exact composed metadata is temporarily unavailable, only identity-matching live fields may be preserved; absent fields stay absent. This keeps reconnect/`get_state` from changing context, modalities, reasoning, or advertised thinking tiers. See [Per-model thinking-level capabilities](thinking-levels.md#live-state-metadata).
- **Client-side retry**: `remote-agent.ts` retries `get_state` after 3s on reconnect if `contextWindow` is still 0.
- **Default contextWindow is 0**: Before the server provides real data, `contextWindow` starts at 0 (not 200k), so the context bar shows nothing rather than a misleading value.
- If context bar still shows wrong info after restart, check that `modelProvider` and `modelId` are persisted in `<project-root>/.bobbit/state/sessions.json` for the affected session.
- `SessionManager.getPersistedSession(id)` exposes persisted session data used by the fallback mechanism.

## Restored session requires a model

**Symptom:** after a restart, an existing session shows **Choose a model to continue** and the unavailable `provider/model` tuple. History remains readable, but sending is blocked with `MODEL_SELECTION_REQUIRED`.

This is an expected recovery condition, not a generic terminated-session or retry-on-restart failure. Cold restore found the complete persisted tuple authoritatively absent from the current session-selectable catalog, so Bobbit kept the session processless rather than letting Pi choose a fallback. Reloading or attaching another client does not repeat the doomed start.

### Diagnose catalog authority

1. Inspect the session detail or list response for `condition: { code: "MODEL_SELECTION_REQUIRED", provider, modelId }`. The same tuple should remain in the persisted session record, and `restoreError` should not classify it as a generic restore failure.
2. Check `GET /api/models` for that exact provider and model ID. A missing row, or one marked non-session-selectable, cannot activate a text session. If the row has returned since cold restore, it can be selected again through the picker; Bobbit does not clear the condition merely because a later catalog read changed.
3. For AIGW, distinguish omission from outage. A successful discovery, including an empty or fully filtered catalog, is authoritative. If discovery throws, `/api/models` may use either a matching marked publication from `models.json` or the current process's last exact discovery snapshot for the unchanged normalized gateway URL when the target is absent or the marked block cannot supply rows. The snapshot does not survive a gateway restart. A valid unmarked target remains authoritative through Pi composition and is never bypassed; malformed or ambiguous targets fail closed. `GET /api/aigw/status` may show no live models without clearing either eligible retention source from `/api/models`. See [AI Gateway routing — Transient discovery outages](ai-gateway-routing.md#transient-discovery-outages).

### Recover safely

Use **Choose replacement model** and select any currently session-selectable model. The old model may be selected if it has returned to the catalog. Bobbit starts a replacement pinned to the exact choice, restores the transcript, clamps thinking for that model, verifies runtime model state, then persists the new tuple and clears the condition.

Do not use Retry, restart, or manual edits to `sessions.json` as a substitute for the picker. Prompt, steer, retry, thinking-level, and restart actions remain fenced while selection is required. Browser sends retain their text and attachment drafts; REST and tool-driven prompt delivery returns HTTP `409` with `MODEL_SELECTION_REQUIRED` before accepting work. Any already persisted prompts stay parked until verified recovery releases the existing session lifecycle.

For an ordinary retryable activation failure reported as `MODEL_SELECTION_RECOVERY_FAILED`, the error says to choose another available model or retry. The old tuple, transcript, clients, and condition should remain intact. Confirm that the selected row is still present and session-selectable, its provider credentials and endpoint work, the persisted transcript is readable, and the state directory is writable. Then retry or choose another model.

The same error code has one fail-closed exception. If its sanitized message says **The original conversation transcript could not be restored** and **Do not retry model selection**, a provisional restore may have changed the transcript and Bobbit could not verify rollback to the original bytes. The old unavailable tuple and `MODEL_SELECTION_REQUIRED` condition remain authoritative, but transcript integrity is not guaranteed. Do not choose another model or continue the session. Ask an administrator to inspect the server logs and restore the transcript from a trusted source before continuing. Server diagnostics and the client message sanitize credential-shaped values; do not copy secrets into logs while investigating.

Unexpected Pi startup, a substituted tuple, repeated restore attempts on attachment, or a cleared condition before the replacement becomes durable indicates a recovery-boundary regression. Changed transcript bytes are also a regression after an ordinary retryable failure, but are the reason for the explicit fail-closed rollback message above. Inspect the model-selection recovery path in the session manager and the explicit condition projections in session list/detail and WebSocket state; do not repair it by broadening fallback behavior.

## Duplicate `model_change` event at session startup

A normal Bobbit-owned spawn binds one exact provider/model/effective-thinking tuple before the first prompt. A duplicate startup `model_change`, or a first state frame with a different tuple, means that spawn-time pin did not apply.

- Confirm the spawn site routes through `resolveBridgeOptions` in `src/server/agent/session-setup.ts` (normal create) or the equivalent pre-resolve in session restore/replacement, verification setup, and continue-archived paths. The resulting bridge options must carry both `initialModel` and the clamped `initialThinkingLevel`.
- Confirm `buildAgentArgs` in `src/server/agent/rpc-bridge.ts` splits `initialModel` at only the first slash and emits separate `--provider <provider> --model <modelId> --thinking <effectiveLevel>` arguments. Dotted Bedrock profiles and model IDs containing further slashes remain entirely in `<modelId>`.
- If the requested provider/model is absent from the current session-selectable catalog—including the deferred exact provider `kimi-coding`—the Bobbit-owned setup path must fail with the actionable unavailable-model error before spawning. It must not omit the tuple, delegate selection to Pi's default, or fall through to a hidden provider.
- Inspect the fully assembled raw arguments, not only the early `initialModel`. `resolveEffectivePiSelection` applies Pi's last-value-wins rules, and `finalizeSpawnOptions` must validate that effective tuple against the exact target-realm catalog. The final args must contain one canonical provider/model/thinking tuple with no remaining raw selection flags.
- Confirm post-spawn helpers pass `skipSetModel: true` when `session.spawnPinnedModel` matches. The flag still performs the `getState()` read-back and exact tuple verification; it elides only the redundant `setModel` RPC and its `model_change` echo.
- During a transient AIGW discovery failure, an exact selectable tuple may come from a matching marked publication or the current process's last exact snapshot for the unchanged configured URL when the target is absent or the marked block cannot supply rows. The in-memory snapshot does not survive restart. Unmarked user targets are never bypassed, malformed targets fail closed, and a successful empty or omitting discovery replaces the snapshot instead of merging stale rows.

Coverage lives in `tests2/core/rpc-bridge-spawn-args.test.ts` and the focused model-selection, restore, and spawn-boundary canaries. See [docs/internals.md — Spawn-time model pinning](internals.md#spawn-time-model-pinning).

## Archived session footer shows placeholder model

Loading an archived session shows `claude-opus-4-6` (the client-side placeholder) instead of the real persisted model.

- The fix is `buildArchivedStateData(archived, sessionManager, sessionId)` in `src/server/ws/handler.ts`, called on the archived auth-ok branch after `session_title`. If the helper isn't being invoked, the client never receives a `state` frame on first connect and the placeholder persists.
- Verify `archived.modelProvider` / `archived.modelId` are present in the session-store row — the helper omits `data.model` when either is missing, leaving the footer empty.
- The same helper backs the legacy `get_state` handler, so the reconnect path is automatically consistent.
- The client placeholder seed in `src/app/remote-agent.ts` is a known leftover and out of scope — the footer is correct as long as the server-side push lands.
- E2E coverage: `tests/e2e/ui/archived-session-model.spec.ts` (uses `window.__bobbitState` and `data-testid="footer-model-id"`).

See [docs/internals.md — Archived-session state push on auth](internals.md#archived-session-state-push-on-auth).

## Archived proposal draft missing after continue / resubmit

User opens an archived assistant session, expects to see a "Resubmit `<type>` proposal" button on the footer or a draft carried over by `POST /api/sessions/:id/continue`, and gets nothing.

- **Resubmit button missing**: the footer shows only "Continue in New Session". Check `GET /api/sessions/:id/proposals` directly — if `proposals` is empty, no draft exists on disk. Most likely cause: the draft was deleted at archive time by an older `session-manager.ts::terminateSession` that has not been updated. The current code defers proposal-drafts cleanup to `purgeOneSession` (7-day purge); the `terminateSession` path must skip the directory. If the endpoint is missing from the server entirely, the client falls back to the no-draft footer silently — verify the `^/api/sessions/([^/]+)/proposals$` route is registered.
- **Continue returned 422 for an assistant session**: the `assistantType` guard was re-introduced. The current handler only blocks `goalId` / `delegateOf` / `teamGoalId`; assistant sessions are accepted and the response echoes `assistantType`.
- **Continued session has no draft**: server logs surface `[continue-archived] proposal-dir copy failed (non-fatal): …` when `copyProposalDirIfPresent` (in `src/server/agent/continue-archived.ts`) throws. The copy is intentionally non-fatal so the underlying `.jsonl` continue still succeeds; check disk permissions on `<stateDir>/proposal-drafts/`. Also confirm `cleanupFailedContinue` did not run prematurely — it nukes both the cloned `.jsonl` and the cloned proposal-drafts directory.
- **Toast "DELETE /api/sessions/<id> returned 404" on resubmit**: the `isSessionArchived` guard in `src/app/render.ts` is missing or bypassed. The submit handlers in the goal / project / role / tool / staff proposal panels must short-circuit the post-accept session teardown when the parent is already in `state.archivedSessions`.
- E2E coverage: `tests/e2e/ui/archived-proposal-resubmit.spec.ts` (Path A + Path B + reload persistence + no-draft fallback), `tests/e2e/continue-archived-assistant.spec.ts` (server-side clone happy paths + cross-realm rejection regression).

See [docs/archived-proposal-reopen.md](archived-proposal-reopen.md) for the full design and where each piece lives.

## Session persistence

- Check `<project-root>/.bobbit/state/sessions.json` (per-project, not centralized)
- Initial persist happens via `persistOnce()` in `session-setup.ts` — a single `store.put()` with all structural fields at creation time
- `persistSessionMetadata()` only calls `store.update()` (never `store.put()`) — updates `agentSessionFile` once the agent reports it
- `persistSessionMetadata()` retries 3 times with backoff (500ms, 1s, 2s) on failure
- `sandboxed` is a typed field on `SessionInfo` (no `(session as any)._sandboxed` hack)
- `restoreSessions()` in `session-manager.ts` skips sessions with missing `.jsonl` files
- Generic failed restores create dormant entries that may revive on client connect. A `MODEL_SELECTION_REQUIRED` dormant entry is the exception: it attaches without another restore attempt and requires model selection; see [Restored session requires a model](#restored-session-requires-a-model).
- **Forked session restore fails with `Stored session working directory does not exist` after source cleanup**: the fork clone kept stale source cwd metadata. `POST /api/sessions/:id/fork` must pass source cwd/worktree candidates as `preExistingAgentSessionOldCwds`, like Continue-Archived, so only top-level runtime cwd metadata is rebased before `switch_session`; message content mentioning old paths stays byte-identical. Pinned by `tests/e2e/sidebar-actions-server.spec.ts`.
- **Restart worktree boundary** — graceful shutdown locally drains only unclaimed ready entries still held by each live `WorktreePool`; successful claims and persisted session/goal worktrees survive. The gateway starts `stop()` on every pool before draining any, with a 15-second bound per stop and drain. Tracked failed-claim cleanup is local-only and joins that stop barrier. A pool failure or timeout is logged and teardown continues, so entries may leak safely. Boot never adopts, repairs, or automatically deletes a discovered leftover by branch/path shape; it remains a **Needs attention** diagnostic. Maintenance cleanup is available only when an exact archived-session repository/path/non-empty-branch record authorizes it; otherwise use Git directly after verifying ownership.

## Staff inbox tools missing after restart / `[INBOX]` completion silently fails

- **Symptoms**: a staff agent woken by `[INBOX]` reports `Tool inbox_complete not found` / `Tool inbox_list not found`; `GET /api/sessions/:id` returns a body with no `staffId` field; the REST fallback `POST /api/staff/:staffId/inbox/:entryId/complete` returns `403 Forbidden: session does not belong to this staff`. Inbox entries stay pending forever and re-fire on every trigger.
- **Root cause**: the three inbox tools in `defaults/tools/inbox/extension.ts` are gated by `BOBBIT_STAFF_ID` in the agent process env. That env var is set from `PersistedSession.staffId` on every (re)spawn (`session-manager.ts::restoreSession` → `bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId`). Pre-fix, `StaffManager` mutated `session.staffId = id` only in memory, so the field never reached disk and was undefined after any respawn / compaction / server restart.
- **Quick diagnostic**: `jq '.sessions[] | select(.title == "<staff name>") | {id, staffId, cwd}' .bobbit/state/sessions.json` — if `staffId` is null/missing on a session whose `title` matches a staff `name`, you've hit the bug.
- **Resolution path**: should auto-heal on next server restart via `src/server/agent/staff-backfill.ts`. A loud warn log will appear: `[staff-backfill] backfilling staffId="..." for session=...`. If it doesn't fire, check that the session's `title` exactly matches a staff `name` AND its `worktreePath` (or `cwd`) matches the staff's `worktreePath`. The backfill is conservative and refuses title-only matches.
- **Spawn-path wires** (must all be present for new sessions to persist correctly):
  - `session-manager.ts::createSession` opts → both plan builders carry `staffId: opts?.staffId,`.
  - `staff-manager.ts` passes `staffId: id` (and `staffId` on the scheduled-wake path) to both `createSession` call sites.
  - `session-setup.ts::persistOnce` writes `staffId: plan.staffId` into `PersistedSession`.
  - `session-manager.ts::restoreSession` reads `ps.staffId` and sets `bridgeOptions.env.BOBBIT_STAFF_ID`.
- **Pinning test**: `tests/staff-session-staffid-persistence.test.ts` covers spawn-path forwarding, `SessionStore` round-trip, backfill idempotency, and source-level guards for the read/write field.

## `system-prompt.md` not customised

- Resolver: `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` returns the user override at `<bobbitConfigDir>/system-prompt.md` only if that file exists, otherwise falls back to the shipped `dist/server/defaults/system-prompt.md`.
- The file is **no longer scaffolded on startup**. A fresh install has no `.bobbit/config/system-prompt.md` and runs entirely on the shipped default — expected behaviour.
- To customise: click "Customise system prompt" in Settings → General (or `POST /api/system-prompt/customise`). This copies the current default into `.bobbit/config/system-prompt.md` once; the user is then expected to edit that file.
- After editing the user override, restart the server (path is resolved at startup and passed to agents — see [dev-workflow.md](dev-workflow.md)).
- `isSetupComplete()` (in `src/server/setup-status.ts`) treats the *existence* of `.bobbit/config/system-prompt.md` as the customisation signal — there is no longer a trim-compare against the default template.

## Reliable prompt and steer delivery

- **Session status values**: `idle`, `streaming`, `preparing`, `dormant`, `terminated`, and `aborting`. `aborting` appears immediately after Stop while graceful abort or replacement owns the turn. Accepted outbox rows must remain visible during it.
- **First capture occurrence identity, not text.** Inspect the queue pill's `data-intent-id`, `data-delivery-state`, and `data-target-turn`, then compare that ID across `queue_update` / `delivery_outbox`, `intent_update`, and correlated user events carrying `deliveryIntentId`. Identical text is expected to have different IDs.
- **Row disappeared after Send or Steer?** A socket write and Pi RPC acknowledgement are not settlement. Before server admission, the exact row should exist in IndexedDB's `delivery-intents` store. After admission, it should exist in the server outbox projection until the correlated Pi user start is reduced into chat. Missing from one newer full projection is not by itself settlement; check whether the correlated transcript frame followed on the same socket.
- **Repeated message after reconnect or a second tab?** Verify every resend uses the original `intentId` and server admission returns the existing projection/tombstone. In the transcript, count `deliveryIntentId`, not text. Check the client terminal-ID fence rejected a late queued projection and that the server prompt-author sidecar contains only one exact attempt settlement.
- **`Sending…` never advances?** Locate the matching in-flight ledger record and `attemptId`. Delayed RPC acknowledgement is valid if the Pi user start eventually arrives. A definite `{ success:false }` must produce retryable `failed`; a thrown/transport-ambiguous call must produce non-retryable `uncertain`, not an automatic redrive.
- **`Adding to chat…` remains after a user row appeared?** The client must insert the correlated `message_start` row and settle its outbox carrier by `deliveryIntentId` in one update. Check that server author enrichment propagated both `deliveryIntentId` and `deliveryAttemptId`, and that the reducer did not use raw-text matching.
- **`Awaiting delivery confirmation` after Stop or restart?** This is fail-closed ambiguity: Pi may have seen the occurrence. Retry is intentionally disabled. Retain the row while checking for a late exact user start or terminal sidecar evidence; Dismiss records cancellation but does not assert the model never saw it.
- **Definite failure cannot Retry?** `retry_intent` is accepted only for a `failed` row whose `retryable` flag is not false and which has no active in-flight attempt. Retry keeps `intentId` and creates a later `attemptId`. A stale tab cannot Retry a non-retryable or cancelled projection.
- **Stop lost queued work?** Work that never left `PromptQueue` must remain visible and continuation rows retarget to `next-turn` with `continuation-aborted`. Dispatched ambiguous attempts remain uncertain. Only an explicit proven-no-start recovery may restore one exact attempt; running reconciliation twice must not create another row.
- **Compaction input reached Pi before end?** Check `session.isCompacting`, `_reliableCompactionId`, and `_reliableCompactionReason`. Every direct, steer, retry, queue-drain, promotion, and tool-end dispatch path must honor the fence. `finishCompactionAndRelease()` is the sole idempotent release owner.
- **Safe lifecycle logs.** Search for `intent dispatch restored`, `intent dispatch failed`, `intent delivery did not settle`, and—when `BOBBIT_DEBUG=1`—`[reliable-turn]`. Those lines keep session/intent/attempt IDs, generation/epoch, state, reason, and bounded outcome. General `BOBBIT_DEBUG` also emits a pre-existing truncated prompt preview, so use it only in a trusted environment and exclude that line from shared diagnostics.
- **Coverage**: `tests2/core/reliable-intent-{queue,attempt}.test.ts`, `reliable-compaction-release.test.ts`, `tests2/integration/reliable-intent-recovery.test.ts`, and `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts`.
- **Draft lost on rapid session switch?** The client awaits any in-flight `_pendingSave` promise before loading the draft for the new session. If drafts are still lost, check that `_flushDraft()` is returning its save promise and that `_setupPromptDraftHandlers()` awaits it.
- **Draft not restoring after session switch?** Draft restore uses a `requestAnimationFrame` retry loop (up to 5 frames) to survive Lit re-renders that reset the editor value. If the draft still doesn't appear, check that the rAF `reapply` callback is firing (add a `console.log` inside it) and that `_draftSessionId` hasn't been nulled by a concurrent session switch.
- **`bash_bg wait` not returning after a dispatched steer?** Browser, REST, tool, and automatic steers have server-owned occurrence identity and interrupt the wait only immediately before their actual Pi RPC. The wait should resolve with `{ aborted: true }`; the background process remains alive. A steer queued behind compaction, Stop, replacement, or the `agent_settled` fence does not interrupt yet. An interrupted wait is neither Pi receipt nor settlement; the occurrence still needs its correlated Pi and sidecar evidence. Coverage: `tests2/core/bg-process-manager.test.ts` and `tests2/integration/bg-wait-steer-abort.test.ts`.
- See [prompt-queue.md](prompt-queue.md) for the lifecycle and Stop/recovery contract.

## Session wedged after errored turn

- **First classify the idle state**: a cancellation-shaped terminal drains through the normal queue boundary and clears `lastTurnErrored`; `auto_retry_pending` means a retry timer is armed and queued work waits for it; a genuine error with queued work but no timer emits `manual_retry_required`, so use **Retry** after fixing the cause. Only the last case belongs to this diagnostic; see [Errored turns](prompt-queue.md#errored-turns).
- **Symptom**: a genuine error left `session.lastTurnErrored=true`, and the next prompt or steer never seems to dispatch — the agent sits silent and the sender (user or team lead) thinks their message was dropped.
- **Expected behaviour**: a fresh prompt or steer should **implicitly unstick** the session. `SessionManager.enqueuePrompt` and `SessionManager.deliverLiveSteer` (`src/server/agent/session-manager.ts`) check `session.lastTurnErrored`; if set and `session.consecutiveErrorTurns < MAX_CONSECUTIVE_ERROR_TURNS` (= 3), they clear the error flag, cancel any `pendingAutoRetryTimer`, prepend a short `[SYSTEM: previous turn failed with: …. Your previous turn was interrupted. Pick up where you left off — re-check state first and avoid redoing completed work.]` stub, and dispatch the new message. The failed turn is **not** retried — the incoming message is the new authoritative intent.
- **Why a cap?** Without one, a persistently broken upstream (quota exhausted, auth revoked, content filter) would be re-triggered on every incoming nudge. `consecutiveErrorTurns` tracks genuine errors: cancellation reconciliation resets it to 0, as do a successful `message_end` and successful explicit retry. At the cap (3) messages park in `promptQueue` and a `[session-manager] Session … has N consecutive errors; parking incoming prompt. Human action required…` line is logged. Parked items drain once the underlying issue is fixed and the user clicks Retry.
- **Explicit UI Retry always works**. `retryLastPrompt` bypasses the cap and resets `consecutiveErrorTurns` to 0 on success — a deliberate human action shouldn't erode the budget.
- **Still seeing messages disappear?** Check:
  1. `[session-manager] Session … implicit unstick from enqueuePrompt (consecutiveErrorTurns=…)` or `… from deliverLiveSteer` log lines — if missing, the call didn't reach the helper. Steers must route through `SessionManager.deliverLiveSteer()` (see the abort/steer section above).
  2. `consecutiveErrorTurns` on the session info — if it's ≥ 3, the cap is parking. Click Retry or fix the upstream.
  3. Team-lead nudges to an errored worker: no longer suppressed in `team-manager.ts` (the old `if (teamLeadSession.lastTurnErrored) return;` guard was removed). SessionManager is now the single source of truth for error-state policy.
- **Related**: auto-retry (`transientRetryAttempts`, `maybeAutoRetryTransient`) handles provider backoff, JSON/network transients, and retryable generic unexpected/internal/system errors. See [docs/auto-retry.md](auto-retry.md) for the full policy. The implicit-unstick path is the structural fallback when auto-retry does not apply or has exhausted its bounded budget.

## Auto-retryable error: session appears frozen with no retry banner

- **Symptom**: turn ended with `overloaded_error`, `rate_limit_error`, `HTTP 429/529`, or a sanitized message such as `The system encountered an unexpected error`; session is `idle` but the UI shows no retry banner and nothing happens.
- **Expected behaviour**: `maybeAutoRetryTransient` schedules auto-retry and broadcasts `auto_retry_pending`. Provider overload uses long capped exponential backoff; generic unexpected errors use the bounded 1 s / 5 s / 60 s policy.
- **Diagnosis**:
  1. Check server logs for `[session-manager] Session … hit provider overload/rate-limit`, `… turn failed transiently`, or `… retryable generic error`. If none appear, the classifier did not match or a non-retryable exclusion matched first.
  2. Check `session.pendingAutoRetryTimer` is set (non-null). If the timer fired but the retry itself failed again, look for `[session-manager] Auto-retry failed for session` in the log.
  3. Banner missing despite `auto_retry_pending` being broadcast? Check `state.autoRetryPending` in `remote-agent.ts` — the `case "auto_retry_pending"` handler must have run. If it did, verify `AgentInterface` re-renders on `auto_retry_pending` events (see `AgentInterface._handleEvent`).
- See [docs/auto-retry.md](auto-retry.md) for the full policy, cancellation triggers, non-retryable exclusions, and test coverage.

## "Setting up worktree…" banner missing on a brand-new session / preparing UX absent

- **Symptom**: user creates a new session before the worktree pool has filled (typical on cold boot). The chat panel mounts but no "Setting up worktree…" banner appears, the message editor stays enabled, the user types and clicks send, and the message lands silently in the prompt queue. The system-prompt viewer shows the project root as `cwd`, not a worktree path — confirming the session is still preparing while the UI claims it's ready.
- **Why this happens (two compounding bugs)**:
  1. **Version-gate dropped the first frame.** The server creates new sessions with `statusVersion: 0` and immediately broadcasts `session_status: "preparing"`. The client tracks `_lastStatusVersion` on `RemoteAgent` and ignores any frame whose version is `<= _lastStatusVersion`. Pre-fix `_lastStatusVersion` initialised to `0`, so the very first frame failed the `0 <= 0` gate and `_state.status` was never written. The server-stamped baseline from `case "state"` *did* set the status correctly on attach, but only on the next reload — not on the live new-session path where `state` arrives with the same `statusVersion: 0` it raced.
  2. **`requestUpdate()` was too narrow.** Even when `_state.status` flipped correctly, the UI didn't repaint. `RemoteAgent.onStatusChange` (in `src/app/session-manager.ts`) only called `agentInterface.requestUpdate()` for `"aborting"` and `"idle"`; `"preparing"` and `"starting"` fell through to the global `renderApp()` debounce. Lit's reference-equality short-circuit then refused to re-render the freshly-mounted `<agent-interface>` because `state` was the same object — the status mutation lived inside it. Net effect: even with bug 1 fixed, the banner wouldn't show on the new session.
- **Fix invariants** (do not regress):
  - `_lastStatusVersion` initialises to `-1` (uninitialised sentinel). The version-gate semantics for subsequent frames are unchanged — only the bootstrap is loosened.
  - `RemoteAgent.onStatusChange` calls `agentInterface.requestUpdate()` for `preparing` / `starting` / `aborting` / `idle`. Do not narrow this list back to aborting/idle. The Lit reference-equality issue applies to *every* status change because `_state` is the same object.
  - `case "session_status"` remains the sole client writer of `_state.status` (plus `case "state"` on attach and `reset()` on navigate, per [unify-session-status.md](design/unify-session-status.md)). The fix did not introduce a new writer.
- **How to diagnose if it regresses**:
  1. In DevTools → Network → WS, watch the inbound frames after creating a new session. There should be exactly one `session_status` frame with `status: "preparing"` and `statusVersion: 0`, followed later by another with `idle`.
  2. Add a `console.log` at the top of `case "session_status"` in `src/app/remote-agent.ts`. If the preparing frame arrives but the log fires only once (for `idle`), the version gate is wrong — inspect `_lastStatusVersion` initial value.
  3. If the log fires twice but the banner never paints, the `onStatusChange` re-render branch is the culprit. Confirm `agentInterface` is non-null at the call site (the new chat panel may finish its first paint *after* the frame; the `requestUpdate` call is a no-op then, but the next render pass picks up `state.isPreparing` correctly — no race in practice).
  4. Reload during preparing. The server replays current status on `auth_ok` (`src/server/ws/handler.ts`). If the banner still appears, the live-path bug is the regression; if it doesn't, the replay path also broke — inspect the `auth_ok` write path.
- **Regression test**: `tests/e2e/ui/preparing-ux.spec.ts` (browser E2E). It artificially extends the preparing window so the banner is observable, asserts visibility + editor disabled, then asserts both clear once the session goes idle.

## Staff/session creation in a poly-repo fails with `git worktree add ... fatal: not a git repository`, or staff silently gets no worktree

- **Symptom**: creating a **staff** member (or session) in a **poly-repo** project — root is *not* a git repo, but contains git sub-repos registered as components with `repo != "."` — fails with a raw `Command failed: git worktree add -b ...` / `fatal: not a git repository`, or the staff agent silently lands with no worktree while a regular session for the same project gets one.
- **Root cause**: worktree-capability resolution had diverged across the three creation paths. The staff path required **every** declared repo (including a non-git `.` container) to pass `isGitRepo`, so a poly-repo either bailed to unsupported or ran `git worktree add` against the non-git container root.
- **Fix / where to look**: capability is now decided by the single source of truth `src/server/agent/worktree-support.ts::resolveWorktreeSupport(components, projectRoot, cwd)`, used identically by the session (`server.ts` `POST /api/sessions`), staff (`staff-manager.ts::projectSupportsWorktree`), and goal (`goal-manager.ts::createGoal`) paths. `createWorktreeSet` (`src/server/skills/git.ts`) keeps only component dirs that are git repo **roots** (via `isGitRepoRoot`, which distinguishes "is a repo root" from "inside a repo" — avoiding the nested-parent false positive), skipping the non-git container, data-only and missing dirs; if none remain it returns an empty set and callers fall back to no-worktree instead of throwing. Full rationale in [docs/design/multi-repo-components.md §4.4–4.5](design/multi-repo-components.md).

## Compaction

- **Accepted input dispatched before compaction end** — inspect `session.isCompacting`, `_reliableCompactionId`, and the latest delivery outbox projection. Admission must persist and display the row, but direct prompt/steer, promotion, retry, drain, and tool-end paths must make zero Pi calls until `finishCompactionAndRelease()` releases the eligible lane.
- **Queue drained twice or stayed stranded** — the Pi end event and manual-RPC fallback must share the same `compactionId`. The bounded finished-ID fence makes the second finisher a no-op. On continuing threshold/overflow or `willRetry:true`, only continuation steers release; next-turn prompts wait for final `agent_end`.
- **Failed compaction injected a steer into the interrupted turn** — automatic failure shapes include `success:false`, `error`, `errorMessage`, or a missing required result. The finisher must classify these as failed and defer continuation release to a later safe turn boundary.
- **Truncated assistant tail remains after overflow retry** — find the first `message_end(stopReason:"length")` and its `assistantStreamId`. Overflow `compaction_end(willRetry:true)` must emit exactly one `assistant_stream_invalidated` before release/retry output. The reducer clears only that stream ID; a fresh snapshot must not restore it. Do not deduplicate by text.
- Check `_isCompacting` and `_usageStaleAfterCompaction` in `remote-agent.ts`. The summary placeholder/result is reducer-owned.
- **Card disappears after navigate-away or reload** — check that `mergeCompactionSidecarIntoMessages` runs for `get_messages` and `refreshAfterCompaction`. Sidecar file: `<stateDir>/compaction-sidecar/<sessionId>.jsonl`. See [Compaction history](compaction-history.md).
- Coverage: `tests2/core/reliable-compaction-release.test.ts`, `pi-installed-contract.test.ts`, `assistant-stream-session-broadcast.test.ts`, and the compaction cases in `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts`.

## Goal creation fails with `Workflow not found: general`

**Symptom:** Clicking Accept on a goal proposal (from +New Goal or the goal assistant) returns 400 with `Workflow not found: general`, or — for a project whose store is empty — with the `NO_WORKFLOWS_MSG` body.

- `"general"` is no longer a built-in default. Workflows are project-scoped; a project may have any set of ids, or none at all. If a stale code path is still sending `workflowId="general"`, the pinning test [`tests2/core/no-general-workflow-default.test.ts`](../tests2/core/no-general-workflow-default.test.ts) should have caught it — re-run `npm run test:unit` and look for the failing scan of `src/server/agent/` or `src/app/`.
- The resolution rule (`POST /api/goals` plus `GoalManager.createGoal`): inline `workflow` body → explicit `workflowId` → first workflow in `workflowStore.getAll()` (insertion order) → `NO_WORKFLOWS_MSG`. The UI mirrors this — `_selectedWorkflowId` / `_proposalWorkflowId` in `src/app/proposal-panels.ts` are seeded from the first cached workflow once `fetchWorkflows` resolves, never from a literal id.
- If the project genuinely has zero workflows, the user must run the project assistant first unless the current proposal carries a valid `inlineWorkflow` snapshot. The goal preview panel renders an empty-workflows banner only when neither project workflows nor an inline workflow option are available (see next entry). If the banner does not render but `createGoal` still fails with `NO_WORKFLOWS_MSG`, the workflow cache for the linked project is stale or the `wfState` derivation is mis-computing — grep `src/app/proposal-panels.ts` for `_workflowCacheByProject` and the `wfState` switch.
- Full convention: [docs/goals-workflows-tasks.md — Default workflow resolution](goals-workflows-tasks.md#default-workflow-resolution).

## Goal accept dismisses the assistant before showing the error

**Symptom:** Clicking Accept on a goal-assistant proposal that fails server-side (workflow missing, project not registered, etc.) closes the assistant panel, clears the chat, and lands the user on the landing page with only a toast as feedback. The session, draft, and conversation are gone.

- Fix lives in `src/app/render.ts` in **both** accept handlers (the goal-preview panel handler and the `propose_goal` proposal-toast handler). `createGoal()` must be awaited **before** any destructive teardown — disconnecting the remote agent, clearing the active view, deleting the draft, removing `gateway.sessionId`, and navigating away all live in the success branch only.
- On failure the standard `showConnectionError("Failed to create goal", …)` toast surfaces the server's error message; the assistant, chat, `gatewaySessions` entry, and form state remain so the user can retry or ask the assistant to revise. Re-attempt sessions (with `reattemptGoalId`) share the same handler and are covered by the same guarantee.
- Regression test: [`tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts`](../tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts) — stubs a 400 from `POST /api/goals` and asserts the assistant panel, chat, and `gateway.sessionId` survive.
- Full convention: [docs/goals-workflows-tasks.md — `createGoal` failure preserves the assistant](goals-workflows-tasks.md#creategoal-failure-preserves-the-assistant).

## Goal form has no workflow dropdown / empty-workflows banner missing

**Symptom:** The goal preview panel shows no workflow `<select>` and no empty-workflows banner — either the dropdown is missing on a project that has workflows, or the banner is missing on a project that has none.

- Derivation lives in `src/app/proposal-panels.ts` — search for `wfState` (computed by `workflowStateFor`) and its `"loading" | "empty" | "ready"` states. While `"loading"`, the panel renders a skeleton to prevent banner flicker; `"empty"` renders the banner + disabled Accept unless a valid `inlineWorkflow` supplies a bespoke option; `"ready"` renders the dropdown.
- If a project with workflows shows the banner: the per-project workflow cache (`_workflowCacheByProject`) was not populated. Confirm `ensureWorkflowsLoaded(projectId)` is being called when the linked project changes and that the fetch resolved (DevTools → Network → `GET /api/workflows?projectId=…`). The cache is keyed by `projectId`, so switching projects without re-resolving the cache is the usual culprit.
- If a project with zero workflows shows neither the banner nor the dropdown: `wfState` is stuck in `"loading"`. Check for a fetch error suppressed without clearing the loading flag.
- The banner's **Open Project Assistant** button calls `createProjectAssistantSession(linked.rootPath, false, { projectId, existingProjectName })` from `src/app/dialogs.ts`. If the button does nothing, verify `linked` resolves to the project record (not just an id).
- Regression test: [`tests/e2e/ui/goal-empty-workflows-banner.spec.ts`](../tests/e2e/ui/goal-empty-workflows-banner.spec.ts).
- Full convention: [docs/goals-workflows-tasks.md — Goal creation in a zero-workflow project](goals-workflows-tasks.md#goal-creation-in-a-zero-workflow-project).

## Closed proposal tab reappears after navigation / reload / reconnect

**Symptom:** A current proposal tab (`goal`, `project`, `role`, `tool`, or `staff`) is closed by the tab X, Dismiss, Create/Accept, or registered-project Apply Changes. After navigating away/back, reloading, reconnecting, or rehydrating, the same proposal tab reappears without the user clicking Open Proposal, Resubmit Proposal, or another explicit reopen action.

**First check the server workspace.** Query `GET /api/sessions/:id/side-panel-workspace`. A closed proposal must be absent from `tabs`; it is not enough for the client to hide it locally. If `proposal:<type>` is still present after close, the close path failed to commit the workspace delete. Inspect the tab close handler plus the proposal-specific close path that was used (`Dismiss`, accept/save, or registered-project apply).

**If the workspace is correct but the tab renders anyway**, the UI is deriving tabs from content/cache state. Rendered side-panel tabs must come from the server workspace, not from `state.activeProposals`, draft files, legacy `previewPanelTab` mirrors, localStorage, or transcript rescans. `state.activeProposals[type]` is content only.

**If rehydrate resurrects it**, the proposal source gate is wrong. `proposal_update {source:"rehydrate"}` and `GET /api/sessions/:id/proposals` hydrate content slots only. They may refresh an already-open tab, but must not create or focus `proposal:<type>`.

**If `edit_proposal` resurrects it**, treat it the same way: `/proposal/:type/edit` is content-only. It writes the draft, bumps the content rev, and broadcasts `source:"edit"`; it must not open the workspace tab.

**Expected reopen paths:** fresh `propose_*` output (`seed`), explicit snapshot `restore`, legacy live proposal discovery, Open Proposal / Resubmit Proposal renderers, and historical revision open buttons may create or focus proposal tabs. Those are user- or tool-explicit opens, not cache-derived rehydrates.

See [docs/side-panel-workspace.md — Proposal lifecycle](side-panel-workspace.md#proposal-lifecycle) and [docs/internals.md — Panel routing and tabs](internals.md#panel-routing-and-tabs).

## Re-attempt project binding

**Symptom:** In a re-attempt assistant session, clicking "Create Goal" on the assistant's `propose_goal` panel fails with the toast `"No project selected for this goal — The assistant session is not linked to a project. Dismiss this proposal and start a new goal from the + New Goal button."` The proposal panel has no project picker of its own, so the user is stuck. The session itself carries the inherited `projectId` server-side (populated from `reattemptGoalId`), but the UI guard at `goalProposalPanel()` only ever consulted `state.previewProjectId`, which is owned by the **+ New Goal** picker (`goalPreviewPanel`) and is never set in re-attempt flows.

**Fix location:** `src/app/render.ts::goalProposalPanel()` *and* `src/app/render.ts::goalPreviewPanel()`. The same populate-block lives in both: at panel-render time, when `state.previewProjectId` is empty, derive it in this order and write it back into state:

1. **Active session's `projectId`** — the server already populates this on re-attempt sessions from the original goal's project.
2. **Original goal's `projectId` via `reattemptGoalId`** — fallback if the session hasn't picked up its `projectId` yet. Look up the goal in `state.goals` (a flat array containing both live and archived goals — there is no separate `state.archivedGoals` top-level property).
3. **`cwd`-match against registered `project.rootPath`s** — if the proposal frontmatter carries a `cwd` (the assistant's `propose_goal({ cwd })`), match it case-insensitively with normalised slashes against each entry of `state.projects`.

The existing guard remains as a last-line safety net for genuinely unbindable proposals. The same fix is applied to `goalPreviewPanel()` (the + New Goal picker) so direct entry into that panel from re-attempt / assistant context also binds the project — both panels share the resolution chain to keep behaviour symmetric.

**Diagnostic order when this regresses:**

1. Confirm `currentSession.projectId` is set server-side (`GET /api/sessions/:id` or check the WS `state` frame). For re-attempt sessions, this should be inherited from the original goal — if it's missing, the regression is server-side in the re-attempt session-creation path (`buildReattemptContext()`), not in the panel.
2. Confirm the project still exists in `state.projects` (UI-side). If the project was removed after the original goal was archived, no fallback can recover it — the toast is correct.
3. Check the populate-block in `goalProposalPanel()` / `goalPreviewPanel()` actually ran. It short-circuits when `state.previewProjectId` is already set, so a stale value from an earlier + New Goal interaction in the same tab can mask this path. Trigger via session navigation or a page reload.
4. For `cwd`-only resolution, normalise both sides before comparing: lowercase + replace `\\` with `/` + strip trailing slash. Windows worktrees compose paths with backslashes; registered `rootPath` may use either separator. A direct `===` compare will silently miss.

**Server-side note:** `POST /api/goals` already accepts `projectId` *or* resolves a project from `cwd` via `resolveProjectForRequest`. The bug was purely UI-layer — the server was always willing to bind. Don't add server-side fallbacks here.

**Regression test:** `tests/e2e/ui/goal-reattempt-project-binding.spec.ts` (browser E2E) — opens a re-attempt assistant against a project-bound goal, emits `propose_goal`, clicks Create, asserts the new goal is created with the inherited `projectId` and no toast fires.

## Render performance

- `renderApp()` debounced via `requestAnimationFrame` — multiple calls collapse
- For synchronous DOM updates, use `renderAppSync()`

## Sidebar / landing list blanks to "Loading…" every ~5s (or flashes on first load)

- **Symptom**: the left sidebar (and the mobile landing list) periodically replaces the whole projects/goals/sessions list with a centered "Loading…" placeholder and then repopulates. Most visible on first load; for some users it recurs every ~5s while idle.
- **Root cause**: `refreshSessions()` (`src/app/api.ts`) decided "this is an initial load — show the spinner" via `state.gatewaySessions.length === 0`. List length is the wrong proxy for "never fetched": any user whose live-session list is legitimately empty (projects/goals present but no live sessions, or no projects at all) keeps `length === 0` true forever, so every 5s poll tick re-entered initial-load and re-blanked the list.
- **Fix**: the decision lives in the pure helper `isInitialSessionsLoad` (`src/app/session-load-state.ts`), keyed off whether a fetch has ever *completed* rather than list emptiness — `state.sessionsGeneration` is `-1` until the first successful fetch and `>= 0` thereafter, so `isInitialSessionsLoad` returns `sessionsGeneration < 0 && !sessionsError`. After the first fetch the spinner never re-appears on background polls. The error term keeps the spinner suppressed while an error is on screen; `retryLoadSessions()` (`src/app/api.ts`) clears `sessionsError` before re-fetching so the Retry button shows the one-time spinner again after an initial-load failure. The helper is dependency-free (no `renderApp`/DOM import) so it can be unit-tested in node.
- **Pinning test**: `tests/sidebar-loading-flash.test.ts` — proves a second poll tick with an empty `gatewaySessions` list does not re-enter initial-load once `sessionsGeneration >= 0`, while genuine first load and post-error retry still show the spinner.

## Toolbar / sidebar buttons missing shortcut hints in `title`

- **Symptom**: hovering a toolbar or sidebar button on a freshly-booted app shows a bare label (e.g. `New goal`, `Terminate session`, `Collapse preview`) instead of the labelled-with-shortcut form (`New goal (Alt+G)`, etc.). A second render — any WS event, sessions poll, hash change, or user input — fixes it. Under heavy parallel e2e load this race accounted for the largest single category of toolbar-locator flakes.
- **Root cause**: `initApp()` in `src/app/main.ts` calls `renderApp()` early to mount the UI shell. At that point no shortcut has been registered yet, so every `${shortcutHint(id)}` interpolation in templates evaluates to `""` and Lit stamps the bare title. Shortcut registration (`registerShortcut(...)` calls plus `await loadSavedBindings(); startListening();`) runs further down `initApp()`, but pre-fix no `renderApp()` followed it — the stale titles stayed in the DOM until something else triggered a re-render.
- **Fix**: a single `renderApp()` call in `initApp()` immediately after `loadSavedBindings()` / `startListening()` and the `document.body.dataset.shortcutsReady = "1"` marker. Lit diffs and only restamps the changed `title` attributes, so the extra pass is cheap. Search the file for the `Refresh ${shortcutHint(...)} evaluations` comment if you need to find the exact line.
- **Do not remove it.** The call looks redundant next to the early `renderApp()` at the top of `initApp()` — it is not. The early render happens **before** shortcut registration; this one happens **after**, and is the only render guaranteed to see the registered bindings.
- **Pinning test**: `tests/shortcut-hint-titles-render.spec.ts` (with fixture `tests/fixtures/shortcut-hint-titles-render-entry.ts`). It simulates the boot order — first render with no shortcuts, then registration, then second render — and asserts the second render stamps the title with the `(Alt+G)` suffix. Deleting the post-registration `renderApp()` call must fail this test.
- **Related flake cleanup**: this race was "flake category A" in the PR 600 investigation — ~10 e2e tests (`api-error-modal`, `goal-accept-failure-keeps-assistant`, `goal-creation`, `goal-form-tooltips`, `proposal-inline-comments`, `proposal-tools`, `stories-goal-routing`) that waited on `button[title='New goal (Alt+G)']`. Other flake categories (createSession 201→400 server race, tail-chat scroll drift, cold-start timeouts) are independent.

## iOS PWA relaunch shows a blank grey screen

- **Symptom**: relaunching the installed standalone PWA on iOS comes up as a blank dark-grey screen (the manifest `background_color` `#2b2d2b`) with no UI. The only manual workaround is to kill the app from the app switcher and relaunch. Does **not** reproduce in a normal browser tab or the dev server.
- **Cause**: iOS froze or killed the WebKit process while the PWA was backgrounded, then restored a dead/frozen page snapshot — the JS event loop, render loop, and WebSocket are all dead, so the page is stuck painting only the background color. This is distinct from a dead-socket-on-a-live-page (which the `visibilitychange` resync handles).
- **Where the fix lives**: `src/app/pwa-lifecycle.ts` (wired from `main.ts`, with an inline boot watchdog in `index.html`) force-reloads a dead/frozen standalone PWA via three layered, standalone-gated mechanisms: persisted `pageshow` → reload; a resume-staleness watchdog using one generation-guarded liveness frame plus one delayed probe; and an inline boot watchdog if `#app` never paints. The reload funnel retains the `sessionStorage` cooldown (`bobbit-pwa-reload-at`).
- **Expected callback budget**: installing recovery on a visible standalone page schedules no lifecycle rAF or probe timer. One resume schedules at most one liveness frame and one probe callback, after which no recurring lifecycle work remains. If callbacks appear continuously, look for accidental recursion around `onResume()` rather than adding another heartbeat.
- **Do not conflate** with the live-page WebSocket resync (`_onVisibilityChange` in `remote-agent.ts` + `visibilitychange` in `main.ts`) — that recovers a LIVE page; this recovers a DEAD one. The two are disjoint; don't add a reload path for the live case here.
- **Full design**: [docs/pwa-lifecycle-recovery.md](pwa-lifecycle-recovery.md).
- **Tests**: `tests2/dom/pwa-lifecycle.test.ts` pins the pure decision and exact fake-rAF/timer budgets, including competing generations and stalled long-suspend reload. `tests2/browser/fixtures/pwa-lifecycle.spec.ts` pins persisted restore, cooldown across a real reload, event targets, standalone gating, quick resume, and boot-watchdog clearing. Retain manual quick and greater-than-30-minute suspend/freeze/kill relaunch verification on a real installed iOS PWA.

## Bobbit canvas eyes wake on every display frame

- **Expected behavior**: `startCanvasEyeAnimation()` reads the matching CSS `Animation` only at discrete `EyeFrame` boundaries. Current busy and idle sequences wake about 1.5 and 1.1 times per second, respectively; a sleeping one-frame sequence draws once and schedules nothing. The scheduler itself requests no rAF.
- **If wakeups track the display refresh rate**: check that the renderer has not regained a recursive rAF/tick loop. Each wake must re-read live WAAPI active time (`currentTime` minus effect delay), normalize cycle wrap, paint only a changed gaze/blink key, and arm one bounded timeout for the next boundary.
- **If pixels drift or freeze**: verify negative animation delay is included, hidden state clears the pending timeout, visible state resynchronizes immediately, and `animationstart`/`animationcancel` invalidate a cancelled or replaced cached Animation. Do not fix eye phase by moving body/accessory transforms into JS; those animations remain compositor-driven.
- **Tests and architecture**: `tests2/browser/fixtures/canvas-eye-getanimations.spec.ts` pins boundary pixels, wrap, negative delay, wakeup counts, visibility, replacement, cleanup, archived/static zero work, and live CSS body motion. See [Bobbit Iconography & Animation System](bobbit-sprites.md#canvas-eye-scheduling-contract).

## Scroll snap-back / vibration / tail-chat lost / false-positive Jump button

- **Symptom (master pre-fix)**: in a streaming session, the chat stops following the bottom mid-stream, and/or the Jump-to-bottom pill appears even when scrollTop is already at the bottom. Both regressions also reproduce on iOS PWA.
- **Root cause in one line**: post-PR-#468 the JS pin path (`_stickToBottom` flag + `_programmaticEchoes` ring + `_pinIfSticking`) became the single contract (CSS `overflow-anchor: none` retained), but it lacked resize-vs-scroll disambiguation, a near-bottom relock band, an overscroll clamp, and a paint-vs-RO race defense — all of which Chromium's deleted `overflow-anchor: auto` had been silently masking.
- **Where the fix lives**: `src/ui/components/AgentInterface.ts` — the scroll-lock subsystem is now a vanilla-TS port of [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom). Two-flag intent model (`_isAtBottom` + `_escapedFromLock`); `STICK_TO_BOTTOM_OFFSET_PX = 70` near-bottom band (auto-relock when user scrolls back within 70 px of bottom); `_resizeDifference` records RO delta and the deferred scroll handler (`setTimeout(0)`) bails when non-zero; `_ignoreScrollToTop` single-value latch replaces the echo ring; capture-phase `_imageLoadHandler` covers the paint-vs-RO race for async image/iframe decode; `scrollToBottom({ animate })` provides a Promise-returning spring path used by jump-click. User-intent listeners (wheel/touchstart/keydown) are the only synchronous writers of `_escapedFromLock = true; _isAtBottom = false`. `_stickToBottom` and `_programmaticEchoes` survive as compat shims routing to the new model.
- **Invariant**: see [docs/internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant) for the full state inventory and contract. Do NOT re-introduce the deleted defenses listed there — `_wasAtBottomAtLastUserScroll`, the `_settleWindowActive`/`_settleWindowDeadline` settle window, `_suppressJumpUntilTs`, geometry-based intent flips in the scroll handler, the `_programmaticEchoes` ring buffer as primary echo mechanism, the 10 px stickiness tail, or the "single source of truth" `_stickToBottom`-only model. Each was masking a race introduced by an earlier layer; reaching for one means the bug is elsewhere. `_imageLoadHandler` is NOT in the do-NOT-re-add list — it was restored.
- **Repro tests**: 9 tail-chat E2E specs in `tests/e2e/ui/tail-chat-*.spec.ts`. Notably `tail-chat-jump-button-false-positive.spec.ts` is the deterministic reproducer for the false-positive Jump button; `tail-chat-near-bottom-relock.spec.ts` covers the 70 px auto-relock band; `tail-chat-tool-expand-reflow.spec.ts` covers `<details>` toggle reflow; `tail-chat-image-reflow.spec.ts` covers the paint-vs-RO race that motivates `_imageLoadHandler`. All tests are outcome-only (`getBoundingClientRect()` + computed style) — never assert on private fields. The full sensitivity matrix mapping each defense to the test that fails when neutered lives in [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).

## Stale messages trailing after newer ones on session navigate

- **Symptom**: switching to a session via the sidebar shows older messages (often a synthetic compaction marker or a stale permission card) appended *after* the latest server-persisted messages. A hard reload fixes it; the bug is client-side merge order.
- **Root cause in one line**: pre-reducer, multiple bucket assignments (`_state.messages = snapshot` followed by unconditional pushes from independent buckets) placed entries after newer snapshot messages.
- **Where the fix lives**: the unified reducer in `src/app/message-reducer.ts`. Snapshot rows are stamped with `_order = SNAPSHOT_ORDER_FLOOR + i` (negative integers — strictly less than any live `seq`); live events get their server-stamped positive `seq`. The reducer sorts the combined array by `(_order, _insertionTick)`. The `snapshot` action is authoritative for any id it contains: client-side rows whose id appears in the snapshot are dropped, and a `"Context compacted"` text-prefix fallback drops the synthetic compaction marker when the server has its own.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant). The server snapshot is authoritative for any id it contains; reducer-side optimistic / synthetic / permission rows only fill in gaps.
- **Repro test**: `tests/message-reducer.test.ts` — pure unit tests of the reducer. Scenarios 4, 5, 10, 12 exercise the snapshot-merge invariant directly.

## Plain-text messages duplicated on new-tab open

- **Symptom**: opening Bobbit in a second browser tab in the same browser context causes the **original** tab's currently-viewed live session to render plain-text assistant replies 2-3x. Each subsequent tab open / focus return adds another copy. Refresh fixes it until the next visibility tick. Tool-call / tool-result rows are unaffected — only plain-text rows duplicate.
- **Root cause in one line**: the snapshot survivor filter in `src/app/message-reducer.ts` deduplicated by `id` / `toolCallId` / inner `toolCall.id` only; id-less or id-mismatched live `message_end` plain-text rows passed through alongside the snapshot's regenerated-id copy, and the `visibilitychange` handler in `src/app/remote-agent.ts::_onVisibilityChange` re-ran `requestMessages()` on every tab-focus tick.
- **Where the fix lives**: defence in depth across two files. `src/app/message-reducer.ts` adds a fourth survivor-filter equivalence tier for plain-text rows keyed on `(role, normalisedText)` via the new `isPlainTextRow` and `normaliseText` helpers (skipped for `toolResult` rows — see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant)). `src/app/remote-agent.ts` adds `_hadDisconnectSinceLastSnapshot` (set true on `ws.onclose`, cleared after every successful snapshot apply); `_onVisibilityChange` now skips `requestMessages()` when the WS stayed connected AND `state.messages.length > 0`. `get_state` still fires on every visibility tick.
- **Diagnostic chain**:
  1. **Which tab shows the dup — original or new?** Original = this bug. New tab = a different bug (the new tab's reducer state is empty when its first snapshot lands, so it cannot produce duplicates this way; investigate elsewhere).
  2. **Does it persist across refresh?** Refresh resets the reducer to `initialState()`, so the first post-refresh snapshot has nothing to merge against and the bug disappears — it only re-appears if a new visibility tick fires (e.g. opening yet another tab). If the dup survives a refresh with no further tab activity, this is **not** the new-tab bug.
  3. **Is the visibility short-circuit firing?** Add a `console.log` at the top of `_onVisibilityChange` after the `needsResync` computation; expected: `needsResync === false` on every tick after the first successful snapshot, until the WS drops. If `_hadDisconnectSinceLastSnapshot` reads `true` on a session that's been idle and connected, look for an unexpected `ws.onclose` — reconnect storms re-arm the flag legitimately.
  4. **Does `extractText(m)` return non-empty for the live row?** The plain-text dedup tier skips rows whose normalised text is empty (so an empty placeholder live row can't collide with a snapshot row's text). If the live row is empty, no dedup happens and the dup is a different bug.
  5. **Is the live row plain text and server-origin?** Confirm `m._origin === "server"` and `isPlainTextRow(m) === true` (no `toolCall` content, role is not `toolResult`). Tool-bearing rows go through tiers 2/3 of the survivor filter, not tier 4.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant). The survivor filter has four tiers; do not extend tier 4 (plain-text) to `toolResult` rows — that re-opens the related bash_bg.wait dup bug. Closely-related entry: the [bash_bg.wait toolResult / toolCall-bearing assistant card duplicated after snapshot replay](../AGENTS.md) entry in AGENTS.md (same survivor filter, tiers 2 and 3).
- **Repro test**: `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts` (canonical regression — opens the same session in multiple browser contexts and asserts message count is identical and stable).

## Out-of-order proposal / `ask_user_choices` widgets

- **Symptom**: a `propose_*` proposal panel or an `ask_user_choices` card renders in the wrong position in the transcript, vanishes after appearing briefly, or only shows up after a manual page refresh. Strongly correlated with rapid bursts of widget-bearing assistant turns and with WS reconnects mid-burst. The classic pre-reducer failure mode ("Mode A"): a widget-bearing assistant message landed in the single mutable `_deferredAssistantMessage` slot waiting for a future event to flush it, and a second deferred message silently overwrote the first.
- **Root cause in one line**: pre-reducer the client had eight overlapping ordering mechanisms with no shared key; widget-bearing turns took the deferred-slot path which had no second-arrival protection. The fix collapses all eight into the pure reducer in `src/app/message-reducer.ts` with a single `(_order, _insertionTick)` sort key; widgets are ordinary `live-event` actions stamped with the server `seq`, no special slot.
- **Where the fix lives**: `src/app/message-reducer.ts` (pure `reduce(state, action)`); `src/app/remote-agent.ts` is a thin dispatcher; server-side `src/server/agent/event-buffer.ts::pushFrame` stamps `seq` on live frames including `tool_permission_needed`, and `src/server/ws/handler.ts` stamps `_order = SNAPSHOT_ORDER_FLOOR + i` on `messages` snapshot rows so every snapshot order is strictly less than every live `seq`.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant) and the design record [docs/design/unified-message-ordering-reducer.md](design/unified-message-ordering-reducer.md). The thirteen reducer actions are the only legitimate transcript-mutating paths.
- **Repro test**: `tests/message-reducer.test.ts` — scenario 8 ("proposal-tool burst": two consecutive `propose_*` assistant turns + matching toolResult, both widgets present in correct order, no overwrite) and scenario 9 (`ask_user_choices` envelope routes to the correct toolUseId). Browser-level: `ST-DEDUP-02` / `ST-DEDUP-03` / `ST-DEDUP-04` in `tests/e2e/ui/stories-streaming.spec.ts`.
- **If the symptom is back**: grep `src/app/` for `_deferredAssistantMessage`, `_liveEventMessages`, `_pendingPermissionCards`, `_compactionSyntheticMessages`, `flushDeferredMessage` — anything other than zero hits means a regression has reintroduced one of the deleted mechanisms. Then verify every `state.messages` write in `remote-agent.ts` goes through `apply(action)` — a stray direct `push` / `splice` / `=` will desynchronise the sort key.

## Proposal panel button enabled mid-stream / scroll resets on delta

- **Symptom**: while a `propose_goal` (or any `propose_*`) tool call is being delta-streamed, (a) the Create / Apply / Save button is clickable and submitting yields a goal with truncated content; (b) the spec preview or edit-mode `<textarea>` snaps `scrollTop` back to the top on each delta; (c) the textarea caret/selection resets every time the agent appends a paragraph.
- **Root cause in one line**: the proposal panel re-renders on every streamed delta and Lit's `.value=` rewrite of the textarea + the markdown-block parent `<div>` resets `scrollTop` and selection on each commit; with no streaming flag the submit button has no reason to disable.
- **Where the fix lives**: `src/app/follow-tail.ts` owns the scroll/selection lock (5px tail, programmatic-scroll echo filter, user-intent listeners, WeakMap-keyed state). `src/app/state.ts` owns `proposalStreamingByTag` and `isProposalStreaming(tag)`. `src/app/remote-agent.ts` (`_checkToolProposals`) is the sole writer, with bulk-clear on `agent_end` / `reset()`. `src/app/render.ts` reads the flag, OR-merges it into the submit `disabled`, renders `streamingBadge()` + `STREAMING_BORDER`, and schedules `reconcileFollowTail` via `queueMicrotask` after each panel render.
- **Invariant**: see [docs/internals.md — Proposal panel scroll lock invariant](internals.md#proposal-panel-scroll-lock-invariant) and [docs/internals.md — Proposal streaming flag](internals.md#proposal-streaming-flag). Do not introduce timer-based intent heuristics; do not widen the 5px tail; do not write to a panel's `scrollTop` or `setSelectionRange` outside `reconcileFollowTail`.
- **Repro / debug**: if the badge / disabled state is stuck on after a turn finishes, the `agent_end` bulk-clear in `RemoteAgent` didn't fire — verify the agent emitted `agent_end` (not just an unclean disconnect) and that `reset()` runs on session switch. If scroll snaps back only on first delta after panel mount, the WeakMap entry is being created with `lastScrollHeight = el.scrollHeight` while content is still 0 — confirm the panel function calls `queueMicrotask(() => reconcileFollowTail(ref.value))` and not a synchronous call.

## Goal-assistant proposal panel shows stale content after revision / never appears off-screen

- **Symptoms (two failure modes, one root cause)**: in a **goal-assistant** ("+ New Goal") session — **(A)** the agent revises an already-proposed goal (a 2nd+ `propose_goal`, or `edit_proposal type=goal`) but the panel keeps showing the *older* content and only updates after the user clicks **"Open proposal"** on the newest tool card; **(B)** the agent emits `propose_goal` while the user is viewing a *different* session, and on return to the goal-assistant session the panel is empty (and frequently stays empty across reconnect / reload). The non-assistant goal panel (used outside the "+ New Goal" flow) is unaffected — only the assistant surface fails.
- **The two-store model (the one fact that explains both)**: a goal proposal lives in **two parallel client stores**, and the goal-assistant panel reads the wrong one.
  - **Unified typed slot** `state.activeProposals.goal.fields` — written by **every** path: the `propose_*` tool-use scan, the server `proposal_update` WS frames (`seed` / `edit` / `rehydrate` / `restore`), and the REST rehydrate. The non-assistant goal panel renders from this slot.
  - **Legacy form-mirror** `state.previewTitle` / `state.previewSpec` / `state.previewCwd` — the goal-**assistant** panel (`goalPreviewPanel`) renders from these. Historically they were written **only** by the legacy `onGoalProposal` callback, which fires solely from the `propose_*` tool-use scan.
  - **The bug class**: every path that updated only the slot — `edit_proposal` frames (no `propose_*` tool, so the tool scan never runs), dedup-skipped replays, and all three off-screen rehydrate paths — left the assistant panel's form-mirror stale or empty. Clicking "Open proposal" worked because that handler re-invokes the legacy callback, doing exactly the form-mirror write the WS-push path omitted.
- **Where the fix lives** (client-only): `src/app/session-manager.ts` plus the new pure module `src/app/proposal-update-policy.ts`.
  - **Form-mirror gap closure**: the unified `remote.onProposal` now mirrors the merged goal fields into `previewTitle` / `previewSpec` / `previewCwd` whenever `type === "goal" && state.assistantType === "goal"`, respecting the `*Edited` user-edit flags so an in-progress user edit is never clobbered, and persists via `saveGoalDraft`. This makes `onProposal` the single writer of the form-mirror for the assistant, so `edit`/rehydrate/replay paths update the panel too. The legacy `onGoalProposal` callback is intentionally kept (it still owns goal-title summarisation) and is now idempotent with the mirror.
  - **Both return paths reconcile through one helper**: `reconcileGoalSlotIntoFormMirror(sessionId)` copies the rehydrated slot into the form-mirror. The slow/boot draft-restore path **and** the fast-path switch-back both call it. The fast path awaits `Promise.allSettled([rehydrate, restoreGoalDraft])` first so the rehydrated slot always wins over a stale/empty client draft regardless of which promise settled first — previously these ran fire-and-forget with no ordering, so `restoreGoalDraft` could blank the form-mirror after rehydrate populated the slot.
  - **`goalDraft.restore` must never delete the current session's slot**: an off-screen proposal saves no client draft (the callbacks early-return while the panel is inactive), so the on-disk draft is empty. The restore path now only deletes a slot left over from a *different* session — never a freshly rehydrated current-session slot.
- **Invariant — server-stamped rev is the source of truth for CONTENT, not just the rev number**: the apply-vs-drop decision is delegated to the pure `shouldApplyProposalUpdate(...)` policy in `src/app/proposal-update-policy.ts`. The rule across all event sources:
  - **With a server rev** (`proposal_update {rev}` from seed/edit/rehydrate): apply iff `serverRev >= prevRev`. A strictly-older server rev is a stale out-of-order broadcast (e.g. an older rehydrate/seed racing in after a newer stamped edit) → **drop** so it can't regress edited content while the rev stays high.
  - **Without a server rev** (in-memory `propose_*` tool-use / transcript rescan): apply iff first-emit **or** live streaming partial **or** `prevRev === 0`. A non-streaming rescan once a server rev exists carries the *original* tool-use fields and is stale by `message_end` (the seed/edit already applied identical-or-newer content) → **drop**. This is what stops a fresh-context transcript replay or out-of-order rehydrate from regressing edited content.
  - The `nextRev` clamp (`Math.max(serverRev, prevRev)`) keeps the slot rev strictly non-decreasing, so the "Open proposal" live-vs-historical decision can't be corrupted by a transient lower rev.
- **Why off-screen restore is safe**: the dismissal short-circuit (`isProposalDismissedTyped` / `bobbit-goal-proposal-dismissed-<sessionId>`) only fires on a fingerprint-identical previously-dismissed proposal, so a never-seen off-screen proposal is not suppressed; and the async `activeSessionId()` re-checks inside the rehydrate only abort when the user switched away again.
- **Repro tests**: unit `tests/proposal-update-policy.test.ts` (pins the pure policy — the out-of-order server-rev race can't be reproduced deterministically in a browser); browser E2Es `tests/e2e/ui/goal-proposal-revision-autoupdate.spec.ts` (Mode A: 2nd `propose_goal` + `edit_proposal type=goal` auto-update with no click) and `tests/e2e/ui/goal-proposal-offscreen-return.spec.ts` (Mode B: off-screen proposal visible on fast-path switch-back, slow-path reconnect, and reload). Mock-agent triggers live in `tests/e2e/mock-agent-core.mjs`.
- **Don't regress**: the other proposal types (project/role/tool/staff) share the unified `onProposal` path but render their *own* form-mirrors via their legacy `onXProposal` callbacks — they have the **same latent pattern** and are an out-of-scope follow-up (see [docs/design/goal-proposal-panel-fix-analysis.md](design/goal-proposal-panel-fix-analysis.md) §6). Keep the dismissal short-circuit, rehydrate-on-attach, and fast-path switch-back restore intact.
- **Full root-cause analysis**: [docs/design/goal-proposal-panel-fix-analysis.md](design/goal-proposal-panel-fix-analysis.md).

## Background process pills (BgProcessPill / AgentInterface)

- **Dropdown renders via portal**: `BgProcessPill` appends its log dropdown to `document.body` instead of rendering it inline. This is necessary because the "More" overflow popover uses `backdrop-filter: blur()`, which creates a new CSS containing block — `position: fixed` children behave like `position: absolute` and `mask-image` clips them. If the dropdown appears mispositioned or clipped inside a popover, check that the portal is working (the `#bg-process-dropdown` element should be a direct child of `document.body`, not nested inside the pill or popover).
- **Dismiss for popover pills skips animation**: Pills inside the "More" popover lack the animation wrapper that visible pills have. `_handlePillDismiss` in `AgentInterface` detects hidden (popover) pills and calls `onBgProcessDismiss()` directly instead of waiting for a `pill-fade-out` animation. If dismiss stops working for popover pills, check that the hidden-set detection still matches the overflow logic in `_renderPillStrip()`.
- **Exited duration keeps growing**: exited process snapshots must include numeric `BgProcessInfo.endTime`; the UI renders `endTime - startTime`, while legacy missing/null `endTime` renders `—` rather than `Date.now() - startTime`. See [docs/internals.md — Background process runtime snapshots](internals.md#background-process-runtime-snapshots).
- **Pill shows "exit status unknown" (amber) after restart**: the process hit the unrecoverable reconciliation path on restore — `processPid` gone with no status file, the pidfile nonce mismatched (pid reuse), the log file was missing, or (docker) the container was recreated/removed with no mirrored status snapshot. This is the *correct, documented* fallback — the gateway never fabricates an exit code, and the retained output is still shown. Distinguish it from `killed` (`terminalReason="killed"`, a known user kill). See [docs/bg-process-persistence.md — Restore reconciliation](bg-process-persistence.md#restore-reconciliation--the-three-cases).
- **bg-process logs/state not surviving restart**: check `<stateDir>/bg-processes.json` (the `BgProcessStore` index) and the per-process files under `<stateDir>/bg-processes/<sessionId>/` (`<bgId>.log` projection + `<bgId>.status`). On a clean shutdown `ProjectContext.close()` flushes `bgProcessStore`; restore runs from `BgProcessManager.restoreSession()` inside `SessionManager.restoreSessions()`. If records are missing, verify the store provider is wired (`SessionManager.getBgProcessStore(projectId)` → `ProjectContext.bgProcessStore`) and the session's `containerId` re-resolves before restore. See [docs/bg-process-persistence.md](bg-process-persistence.md).
- **Chatty bg-process stops streaming after restart**: the spool was copytruncated below the persisted read offset, so a stale-offset read missed the retained tail. The fix is the offset-rebase rule (`size < offset` → reset offset to 0 and read the bounded spool from the start) applied on every tail tick and at restore; the projection's full-rewrite means re-fed bytes persist no duplicates. If it stalls, check `PollTailer`/`DockerTailer` rebase + `onOffsetReset`. See [docs/bg-process-persistence.md — Bounded on-disk growth](bg-process-persistence.md#bounded-on-disk-growth).

## Goal and task persistence

- Production state is in per-project `.bobbit/state/goals.sqlite` and `tasks.sqlite`; `goals.json` and `tasks.json` are legacy migration inputs or retained backups, not live production authorities. A marked SQLite database ignores an untracked live JSON file.
- Stop the gateway and copy the complete state directory before inspection. Open the copy read-only; check `PRAGMA quick_check`, `PRAGMA user_version`, the store metadata, row counts, and row/payload `id` agreement. Do not clear metadata or rename retired JSON back into place. See [Goal and task store SQLite persistence — Operational inspection and recovery precautions](design/goal-task-store-sqlite-persistence.md#operational-inspection-and-recovery-precautions).
- **Startup fails while retiring `goals.json` or `tasks.json`:** preserve the source, any `.sqlite-retired[.N]` link, and the database. Remove the external lock or permission problem and restart. Durable retirement intent makes startup retry the rename without re-importing changed source bytes.
- **Startup rejects legacy or `.pre-migration` JSON:** the complete eligible source is validated before import, so preserve its bytes and fix it only while stopped. Duplicate IDs, malformed known fields, and non-finite numbers fail closed. A newly created empty SQLite schema may remain, but no rows or authority marker committed.
- **Startup rejects an authoritative row or identity mismatch:** preserve the whole state directory and escalate to offline recovery. Constructor failure closes native handles, but the store intentionally refuses to guess whether corrupt or unmarked rows are authoritative.
- **A deleted goal or its old tasks reappear:** check `.deletion-tombstones.json` under the `goals.json` namespace. Goal recovery filters tombstoned goal IDs; task recovery uses the same goal tombstones to skip recovery-only tasks. Existing authoritative rows and live migration inputs retain precedence. See [Deletion tombstones and ordering](design/goal-task-store-sqlite-persistence.md#deletion-tombstones-and-ordering).
- **State directory cannot be renamed or removed on Windows:** await gateway or `ProjectContextManager` shutdown. Context close attempts GoalStore, TaskStore, and GateStore close even when a sibling reports a durability error; bypassing that barrier can leave native handles open.

## Gates

- State in `GateStore` (`.bobbit/state/gates.sqlite`). Legacy `gates.json` and recovery `gates.json.pre-migration` are fully validated, imported transactionally, then moved to collision-safe `.sqlite-retired` / `.pre-migration-recovered` backups by atomic no-replace link followed by source unlink. A source still present after either retirement step fails is retried from durable intent; prior and concurrently-created backups are never overwritten. Do not edit, delete, or copy it over SQLite. Stop the gateway and inspect a complete state-directory copy read-only. See [Gate store SQLite persistence — Operational inspection and recovery precautions](design/gate-store-sqlite-persistence.md#operational-inspection-and-recovery-precautions).
- Check dependencies via `GET /api/goals/:id/gates`
- **Reviewer flags "branch doesn't match design" on a pre-implementation gate?** That is the classic stale-baseline false positive. Pre-implementation gates (`content: true` with no `depends_on` — e.g. design-doc, issue-analysis) are classified by `isPreImplementationGate()` in `src/server/agent/verification-logic.ts` and the harness must strip all `git diff` / `git log` instructions from the review prompt for them. If a reviewer is still citing branch diffs, check that (1) the role YAML's preamble contains the `{{REVIEW_CONTEXT}}` placeholder (reviewer, architect, spec-auditor), (2) `buildReviewPrompt()` in `src/server/agent/verification-harness.ts` is substituting the pre-impl notice, and (3) no user-override role YAML has re-introduced hardcoded diff commands. Implementation-gate reviewers diff against `origin/<primary>...HEAD` — never local `<primary>`, which can be stale. Full convention: [docs/goals-workflows-tasks.md — Gate verification baselines](goals-workflows-tasks.md#gate-verification-baselines).
- **Verification output modal empty?** The modal has two data sources for step output:
  1. **API bootstrap** — on open, the modal (and its parent) reads accumulated output from `GET /api/goals/:id/verifications/active`. The chat widget (`GateVerificationLive`) seeds its `_stepOutputs` Map from the API in `_fetchAndReconcile()`, and falls back to `this.steps[index]?.output` in `_openModal()`. The dashboard reads `step.liveOutput || step.output`. The modal itself calls `_fetchBootstrapOutput()` as a one-time fetch when `initialOutput` is empty.
  2. **Live WS streaming** — the `/ws/viewer` WebSocket delivers `gate_verification_step_output` events in real-time. Events are dispatched as `gate-verification-event` CustomEvents on `document`; the `VerificationOutputModal` subscribes to these and appends chunks.
  
  If the modal shows "Waiting for output…": first check the API endpoint returns step output (`curl /api/goals/:id/verifications/active` — look for non-empty `output` in the steps array). If the API has output but the modal is empty, the parent component may not be passing it through — verify the fallback chain. If neither source has output, the verification command may not have produced any stdout/stderr yet. For live streaming issues, check that the `/ws/viewer` WS connection is active (browser DevTools → Network → WS tab). The connection opens on dashboard mount and closes on navigation away; it auto-reconnects after 3s on unexpected close. If the modal shows a truncation marker or `textTruncated` / `outputTruncated` is present in WS frames, the live stream is intentionally bounded; use `gate_inspect(section="verification", mode="tail"|"grep"|"slice"|"full")` for retained full output.
- **Ready-to-Merge step says `Skipped — unresolved template variable {{baseBranch}}`:** this is a safety bug, not a successful optional skip. `{{baseBranch}}` is a built-in resolved from the owning project's configured `base_ref` to a bare branch (`origin/master` → `master`), falling back to detected primary when unset. Required Ready-to-Merge checks that use `{{branch}}`, `{{baseBranch}}`, or `{{master}}` must execute or fail loudly, never skip/pass because a built-in stayed unresolved.
- **Verify-step runs wrong project's commands** (e.g. `npm run check` on a .NET goal, or bobbit's defaults for a ReqLess goal): command steps should use structural `{ component, command }` references, resolved from the goal's owning project's `ProjectConfigStore` via `resolveProjectConfigStore(goalId)` in `src/server/agent/verification-harness.ts`. `{{project.*}}` is unsupported in verification `run:` strings and retry prompts. If a step runs with the wrong project's commands, confirm the harness was constructed with `projectContextManager` (non-test wiring always passes it), then look for `[verification] Goal "<id>" not found in any project context` warnings in the server log — that means PCM has no context for the goal and the harness fell back to the server-level singleton.
- **Sandboxed verification commands**: For sandboxed goals, `command` verification steps run inside the project's container via `docker exec`. If command steps show unexpected results (e.g. missing files, stale code), check: (1) is the goal sandboxed (`goal.sandboxed`)? (2) is the project container still running (`docker ps --filter label=bobbit-project=<projectId>`)? If the container is unavailable, the harness falls back to host execution — which won't have the team's commits. Look for "no project container found" warnings in the verification output.
- **Session "view" links**: Verification step and delegate session links navigate in-place via `location.hash` (no new tab). If clicking "view" does nothing, check for JavaScript errors in the console — the click handler sets `location.hash = '#/session/<id>'`.

## Git diff viewer not showing diffs

1. Widget needs `sessionId` or `goalId` + `token`
2. Path sanitization rejects `..` and absolute paths
3. Git command has 5s timeout, 500KB response cap
4. Dropdown renders into portal (`document.body`) — not clipped by overflow
5. `_currentDiffFile` guard prevents stale responses

## Remote Git or PR status is stale / external calls are too frequent

The server-owned coordinator is the only authority for automatic remote-ref and PR fast-state reads. A stale response should retain last-good data, age, and a safe `offline`, `auth`, `rate_limited`, or `unavailable` category; clients must not compensate with their own `git fetch` or `gh` call. See [Remote-state coordinator](remote-state-coordinator.md#troubleshooting) for the identity, budget, redaction, and failure contract.

- **Stale immediately after a Git action?** Mutation invalidation retains the repository's 30-second automatic-attempt budget. Use explicit refresh when immediate revalidation is required.
- **Many REST requests but uncertain external volume?** Temporarily set `BOBBIT_DEBUG=1`, then inspect `[remote-state]` telemetry and count `started` by `source` and one-way `record` digest; `fresh`, `joined`, `coalesced`, `budget`, and `backoff` do not represent additional external calls. Normal logs emit only actual failures. Remove debug mode after diagnosis. Explicit actions and deferred lifecycle/verification paths are outside the automatic budget.
- **Last-good data vanished after a transient failure?** The completion snapshot must keep the previous `data` and `refreshedAt`, set `stale: true`, increase `ageMs`, and expose only the safe error category. A cold record is the exception: it has no `data` or `refreshedAt` to retain.
- **Session, dashboard, or sidebar disagree?** Confirm one addressed `remote_state_snapshot` completion reached each authorized consumer and was applied directly. A completion handler that starts another read defeats the fanout contract. Sibling worktrees share fetched refs but must recompute local dirty/untracked state independently.
- **Staff Git trigger missed a remote change?** A stale or failed repository snapshot intentionally suppresses comparison and firing. Check the coordinator outcome and configured ref; do not fall back to commit-subject text.
- **Need more error detail?** Do not log remotes, paths, refs, stderr, raw GitHub responses, or exception text. Diagnose from the safe category and host-scoped Git/`gh` configuration so credentials and private repository data stay outside logs and broadcasts.

## Git status widget disappears / stays loading

Widget hides **only** when the server explicitly confirms "not a git repository". Every other failure (500, timeout, abort, network error) must leave the widget visible in either a skeleton or last-known-good state. Remote freshness is covered by [Remote-state coordinator](remote-state-coordinator.md); local status architecture is in [docs/internals.md — Git status cache & client resilience](internals.md#git-status-cache--client-resilience), with full widget design in [docs/design/git-status-widget-reliability.md](design/git-status-widget-reliability.md).

- **Widget gone entirely after a transient fetch failure?** Check `gitRepoKnown` on the `AgentInterface` (session) or the module-level `gitRepoKnown` in `goal-dashboard.ts`. It is `'yes' | 'no' | 'unknown'` and defaults to `'unknown'` on session connect / dashboard load. Only an HTTP 400 with body `{ error: "Not a git repository" }` flips it to `'no'`. The render gate is `gitRepoKnown !== 'no'` — if the widget is missing while `'unknown'` or `'yes'`, the gate has been short-circuited somewhere.
- **Stuck in "Checking git…" skeleton?** The skeleton renders while `loading && !branch`. Retry lives in `refreshGitStatusForSession` (`src/app/session-manager.ts`): 4 attempts at [0, 500, 2000, 5000]ms. `gitStatusLoading` stays `true` across **all** retries and is cleared only in the final `finally`. If loading never clears, something is resolving attempt 4 without hitting that finally (check console for "git-status refresh failed after retries").
- **Retries not firing / only one attempt visible in network tab?** The retry loop aborts if `activeSessionId() !== sessionId`. Rapid session switches tear down the previous controller — this is correct. Also verify the `GitStatusResult` coming out of `fetchGitStatus`: only `kind: 'error'` retries; `kind: 'not-a-repo'` short-circuits to `'no'`.
- **30s safety poll never ticks?** Gated on all of: `document.visibilityState === 'visible'`, `activeSessionId() === sessionId`, `gitRepoKnown !== 'no'`. A 10s coalesce window via `gitStatusLastRefreshAt` skips the tick if an event-driven refresh fired recently — this is intentional. On `visibilitychange → visible` an immediate snapshot request fires without waiting for the next 30s boundary; the server coordinator still decides whether an external refresh is eligible.
- **Remote work branch reappears after a status refresh?** This is a lifecycle regression. `GET /api/sessions/:id/git-status` and the goal equivalent must be read-only: connection, idle, reconnect, dropdown/full refresh, visibility refresh, and polling may inspect refs but never push. `ahead`, `hasUpstream`, branch shape, and `base_ref` are reporting/baseline inputs, not publication signals. Check that the route contains no publisher call or fire-and-forget Git side effect; coverage lives in `tests2/core/git-status-local-only-policy.test.ts` and `tests2/core/session-git-status-publication-policy.test.ts`.
- **Server returning the same value for rapid-fire requests?** Distinguish the two caches. Remote metadata (`stale`, `refreshedAt`, `ageMs`, `lastError`) is governed by the canonical coordinator and its call budget. Worktree-local status is governed by `batchGitStatus`'s 2000ms TTL, keyed by `${containerId ?? 'host'}::${cwd}::${summary|untracked}`; concurrent callers share its in-flight promise, successful results are briefly reused, and errors are not cached. Local mutation routes invalidate this cache, while remote invalidation follows the coordinator contract.
- **Dropdown opens but untracked files never appear?** Default / poll refreshes must stay summary-only (`git status --porcelain=v1 -uno`) for speed. `GitStatusWidget._toggle` fires `git-status-dropdown-open` (bubbles, composed), and both session chrome (`session-manager.ts`) and dashboard (`goal-dashboard.ts`) must handle it with one `?intent=visible&untracked=1` request (`-uall`). The visibility intent joins fresh or in-flight remote work; the explicit footer refresh is the forced path. Check that the response carries `untrackedIncluded: true`. Summary and untracked responses use separate cache keys, so both can coexist without server cache cross-contamination.
- **Untracked files appear, then disappear while the dropdown stays open?** A late summary-only response is overwriting untracked-aware state. Client invariant: while the current state has `untrackedIncluded: true`, later summary-only payloads must not hide existing `?` files; merge/preserve them or ignore the stale shrink. Check `withUntrackedStatusPreserved` / `mergeStatusFilesPreservingUntracked` in both `session-manager.ts` and `goal-dashboard.ts`. Pinned by `tests/e2e/ui/git-status-untracked-race.spec.ts`.
- **`partial: true` on every response?** Phase A (fast metadata: branch, upstream, master/main verify, porcelain) and Phase B (ahead/behind counts) each have a 3s per-call timeout. If Phase B counts time out the response carries `partial: true`; the client renders a yellow warning dot and the dropdown offers "Re-scan" which triggers `?untracked=1`. Persistent partials usually mean a huge repo or a held git lock.
- **Server-side retries firing repeatedly / `runBatchGitStatusCount` higher than expected?** There are no in-server retries any more. Each `batchGitStatus` call increments `runBatchGitStatusCount` exactly once — a single `execFile` attempt per git invocation, 3s timeout, fast-fail. Resilience lives in the client (`git-status-refresh.ts`, 4 attempts at [0, 500, 2000, 5000]ms). Host path uses parallel `execFile` via `src/server/skills/git-status-native.ts` (no Git Bash); container path uses a single batched `docker exec sh -c`. If you see persistent server failures, look for a genuine git or Docker problem — don't reintroduce server-side retry.
- **Test-only spawn hook**: `__setGitStatusFake(fn)` / `__clearGitStatusFake()` replace `runBatchGitStatus`'s git-spawn path with a deterministic function, and `__getGitStatusInvocationCount()` / `__resetGitStatusInvocationCount()` expose the real-invocation counter used by coalesce tests. These exist because under CI load the real `git status` spawn becomes flaky (EAGAIN / ENFILE / Windows ENOENT races) and makes retry / coalesce assertions non-deterministic. Production code never touches them.
- **Multi-repo session shows only a branch name / no aggregate or per-repo sections?** A true polyrepo session's `cwd` is the non-git branch *container*, so `batchGitStatus(cwd)` returns null and there is no root result to render. In multi-repo mode (`session.repoWorktrees.length > 1`) the `/api/sessions/:id/git-status` handler treats that as non-fatal and **synthesizes** the aggregate from the per-repo results (branch/primary from the first repo; summed ahead/behind/aheadOfPrimary/behindPrimary/insertions/deletions; `clean` = AND across repos). If the pill shows only the branch, check that `repoWorktrees` actually has >1 entry and that per-repo `batchGitStatus` calls aren't all failing (each is swallowed individually). Full design in [docs/design/multi-repo-components.md §13](design/multi-repo-components.md#13-session-git-status--git-diff-parity-addendum-2026-06).

## Git status widget pill clicks do nothing / dropdown wedged after re-renders

Widget is visible with branch data, but clicking the pill is a silent no-op (no console error, no network traffic, no portal in `document.body`). Only F5 / Ctrl+Shift+R restores it. Architecture in [docs/design/git-status-widget-reliability.md §14 — Dropdown lifecycle hardening](design/git-status-widget-reliability.md#14-dropdown-lifecycle-hardening).

The bug is a stale-state race between three fields on `GitStatusWidget` (`src/ui/components/GitStatusWidget.ts`): `expanded`, `_closing`, and the portaled `_dropdownEl` (the `#git-status-dropdown` div appended to `document.body`). The historical state machine only cleared `expanded` / `_closing` from the `animationend` listener attached to the portal — and per the CSS Animations spec, removing an animating node from the document fires `animationcancel`, not `animationend`. `AgentInterface` re-render churn (streaming, ResizeObserver, `DeferredBlock` / IntersectionObserver) can briefly flip the outer pill-strip render gate (`bgProcesses.length > 0 || gitRepoKnown !== 'no'`), which disconnects and reconnects the widget mid-close. The portal is yanked, `animationend` never fires, and the instance sticks in `expanded=true` with `_dropdownEl=null` forever.

- **Click is a no-op, no `#git-status-dropdown` in body?** Read `expanded` / `_closing` straight off the Lit instance: `document.querySelector('git-status-widget').expanded` / `._closing`. `true` + no portal = wedged. The fix makes `_toggle` self-healing: portal presence (`_dropdownEl?.isConnected`) is the source of truth, not the boolean. A click with state-says-open-but-no-portal rebuilds the portal instead of entering the close branch.
- **`disconnectedCallback` running mid-close?** The widget now resets `expanded = false` and `_closing = false` synchronously alongside `_removeDropdown()`, and bumps a `_closeToken` counter to invalidate the in-flight `animationend` listener so a stale `reset()` from a previous close can't clobber state on the reconnected instance. The `animationcancel` event is also handled now (mirrors `animationend`) as belt-and-braces for `prefers-reduced-motion` and animation-property races.
- **Dropdown opens but `git-status-dropdown-open` fires N times / untracked refetches stack?** `session-manager.ts` used to attach an anonymous listener on every `connectToSession`, with no matching `removeEventListener`. Cached session switch-backs piled them up (one extra refetch per past connect, plus a memory leak). The listener is now stored on the agent interface as `__gitStatusDropdownOpenHandler` and `removeEventListener`'d before the new one is wired. Pinned by `tests/session-manager-git-dropdown-listener.test.ts` (static source assertion — fails if anyone reverts to anonymous closures).
- **Reproducing locally?** The Lit instance only runs `disconnectedCallback` when its host is actually removed from the DOM. The plain-JS replica fixture used by `git-status-interactions.spec.ts` does not exercise this — use `tests/git-status-widget-wedge.spec.ts` instead. It mounts the real widget via the `git-status-widget-states` bundle, opens the dropdown, starts the close animation, and either disconnects+reconnects the host, externally removes the portal, or dispatches `animationcancel`, then asserts the next click reopens. All three scenarios must reopen the dropdown and clear the `git-dropdown-closing` class.
- **Skeleton state should still be inert.** `_toggle` early-returns when `loading && !branch` — the wedge fix preserves this. Outside-click (`document` capture-phase listener) and Escape still close via the normal animated path.

## PR walkthrough pane blank/unresponsive after `ready` (hunkSignature TypeError)

> **Note (current model):** the PR-walkthrough viewer is now a built-in first-party pack (`market-packs/pr-walkthrough/`, panel `lib/panel.js`) reached at `#/ext/pr-walkthrough`; the bespoke `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` component and `tests/e2e/ui/pr-walkthrough-panel.spec.ts` referenced below were **deleted**. The header-coercion guards described here apply to the shared synthesis module `src/shared/pr-walkthrough/yaml-to-cards.ts` and the pack panel; the pinning E2E is now `tests/e2e/ui/pr-walkthrough-pack.spec.ts`. The historical detail is retained for the regression rationale. See [docs/design/pr-walkthrough-pack-deletion.md](design/pr-walkthrough-pack-deletion.md).

- **Symptom**: launching a walkthrough (Git Status Widget → Pull Request → **Walkthrough**) reaches `ready` and starts rendering diff cards, then the pane goes blank and nothing is interactive. Console shows `Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'match')` at `hunkSignature` → `sectionSignature` → `renderInlineHunk`/`renderSplitHunk` → `renderDiffBlock`.
- **Two-part root cause**: (1) **UI fragility** — `hunkSignature(header)` called `header.match(...)` and threw when `header` was `undefined`; with no per-block error boundary, the single throw unwound the whole synchronous Lit `render()` and the component committed nothing, blanking the entire pane for one malformed hunk. (2) **Contract violation** — a hunk reached the UI with `header === undefined` even though `PrWalkthroughHunk.header` is typed required `string`. The header-less hunk came from the bundle-reconstruction path (`diffBlockFromBundleFile`, mirrored by the writer `bundleHunkFromDiffHunk`), which copied `header` verbatim from re-read bundle JSON with no coercion; the duplicated `isDiffBlock` guards never validated hunk `header`, so it rode a file-level/audit block all the way to the browser. Full analysis: [docs/design/pr-walkthrough-hunk-header-fix.md](design/pr-walkthrough-hunk-header-fix.md).
- **Where the fix lives**: renderer defensiveness now lives in the shared synthesis module `src/shared/pr-walkthrough/yaml-to-cards.ts` and the pack viewer panel `market-packs/pr-walkthrough/lib/panel.js` — a non-string hunk `header` is coerced to `""` instead of being dereferenced, and each diff block renders through a `try/catch` error boundary that emits a local fallback (`data-testid="pr-walkthrough-diff-block-error"`) so one bad block degrades locally instead of blanking the pane. Producer contract in `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts` — `diffBlockFromBundleFile` and `bundleHunkFromDiffHunk` coerce `header` to a string, and the `isDiffBlock` guards (`walkthrough-analysis-bundle.ts`, `walkthrough-yaml-schema.ts`, `routes.ts`) require every hunk to be a record with a string `header`. *(Historical: the same `hunkSignature` / `sectionSignature` / `renderDiffBlockSafe` guards originally lived in the deleted `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`.)*
- **Invariant**: `PrWalkthroughHunk.header` stays required `string` — the type was **not** weakened to `string | undefined`. The producer must honor the contract (coerce at the reconstruction/ingestion boundary) **and** the UI must additionally be defensive (guard + per-block error boundary). Don't relax the type or remove the error boundary to "simplify".
- **Pinning tests**: `tests/pr-walkthrough-bundle-hunk-header.test.ts` (server unit — reconstructed hunks always carry a string `header`). NOTE: the historical browser case lived in the now-deleted `tests/e2e/ui/pr-walkthrough-panel.spec.ts`; the current pack viewer is exercised by `tests/e2e/ui/pr-walkthrough-pack.spec.ts`, and the header-coercion guards now live in the shared synthesis module `src/shared/pr-walkthrough/yaml-to-cards.ts` + the pack panel (`market-packs/pr-walkthrough/lib/panel.js`).

## Lifecycle of finished `pr-walkthrough` reviewer children

- **Behaviour (current, by design)**: a PR-walkthrough reviewer is a `childKind: "host-agents"` child minted via `host.agents.spawn`. On submit it is intentionally **NOT** auto-dismissed — the launch-UX correction removed the submit-time `orchestrationCore.dismiss` reap **and** the `childTerminal`/`terminalAt` stamp. A post-submit reviewer stays a live, selectable session, flips its pane to the rendered cards, and **survives a gateway restart** like any normal session (restart survival is a locked requirement).
- **How it is reaped**: only the **generic** `OrchestrationCore` rule — `shouldReapChildOnBoot` reaps a child whose parent (owner) session is gone/archived; archiving/terminating the owner cascade-reaps the reviewer like any other `host.agents` child. The generic `childTerminal` field still exists for other callers, but the PR-walkthrough submit path **does not set it**, so a live post-submit reviewer is never boot-reaped by a terminal marker.
- **Terminating extras**: because every click spawns a *fresh* reviewer (no target dedup), multiple reviewers can accumulate for one PR. The user terminates any they no longer need via the standard session terminate/dismiss control; terminating discards the session (the walkthrough is cheap to re-run, not preserved elsewhere). They are not "leaks" — they persist by design until owner-gone or explicit termination. See [docs/pr-walkthrough-panel.md](pr-walkthrough-panel.md), [docs/orchestration.md — Restart survival / Archive cascade-reap](orchestration.md#restart-survival), and [docs/design/pr-walkthrough-launch-ux.md](design/pr-walkthrough-launch-ux.md).
- **Pinning tests**: `tests/orchestration-core.test.ts` / `tests/host-agents-scope.test.ts` (generic owner-gone reap, cascade-reap, terminated-child-reapable) and `tests/e2e/pr-walkthrough-host-agents.spec.ts` (submit never dismisses the reviewer; the reviewer stays live + selectable and survives a simulated restart; user-terminate dismisses it).

## Sandbox sessions

- `GET /api/sandbox-status` for Docker availability
- Worktree sessions now correctly call `applySandboxWiring()` via the pipeline (previously `_setupWorktreeAndLaunchAgent()` skipped sandbox wiring)
- `sessions.json` has `sandboxed: boolean`
- Container can't reach internet? Check: (1) `docker network inspect bobbit-sandbox-net` shows the network exists, (2) container is attached to it (`docker inspect <container>` → Networks), (3) host firewall isn't blocking Docker bridge traffic
- Container can't reach gateway? Check: (1) `--add-host=host.docker.internal:host-gateway` is in the Docker args, (2) `BOBBIT_GATEWAY_URL` matches real address
- Auth failing? Check `BOBBIT_TOKEN` is scoped token from `SandboxTokenStore`
- Sessions not surviving restart? Session logs are bind-mounted from the host (`.bobbit/state/`), so they survive container death. Check `sessions.json` has the session entry and the `.jsonl` file exists on host disk.
- Delegates failing? Parent needs `sandboxed: true` + sandbox still configured in `project.yaml`

## Project container

- `docker ps --filter label=bobbit-project=<projectId>` to find the project's container
- Container not starting? Check `docker logs <containerId>` for init sequence errors (clone, npm ci, build)
- Container not reconnecting after restart? The gateway finds containers by label on startup — verify the label matches with `docker inspect <containerId>` → Labels
- Named volume lost (Docker Desktop reset)? The container will re-clone from remote and re-run npm ci on next init. Work that was intentionally pushed can be recovered from the remote; scoped local-only sub-agent work exists only in the lost volume.
- Container worktrees missing after recreation? Verify the `bobbit-worktrees-<projectId>` volume exists (`docker volume ls`). This volume is the default durability layer for `/workspace-wt` across container recreation.

## Container death & recovery

When a sandbox container is killed or removed, sessions auto-recover. Use this checklist when recovery doesn't work as expected.

- **Health monitor not detecting death?** Check `[project-sandbox]` log lines. The monitor polls every 20s via `docker inspect`. If `_status` is `"starting"` (container never initialized), the monitor skips checks — verify `initForProject()` completed successfully.
- **Recovery failing repeatedly?** After a failed `init()`, the health monitor retries on the next poll cycle (every 20s). Check Docker daemon is running and the image exists (`docker images bobbit-agent`). Look for `[project-sandbox] Health check recovery failed` in logs.
- **Sessions stuck in `terminated`?** The `process_exit` → `terminated` transition is immediate, but auto-recovery depends on the health monitor detecting the container death and `SandboxManager` propagating the `container-recovered` event. Check: (1) `subscribeSandboxRecovery()` was called during startup (look for the wiring in `server.ts`), (2) `SandboxManager.onContainerRecovered` has listeners, (3) `recoverSandboxSessions()` is not throwing (check `[session-manager] Sandbox recovery failed` in logs).
- **Sessions archived instead of recovered?** The 3-tier worktree recovery failed: worktree doesn't exist on the volume, `git worktree repair` didn't help, and local-only `createWorktree` from the persisted branch also failed. Check: (1) the session has a persisted `branch` value in `sessions.json`, (2) the local branch/ref still exists in the sandbox clone, and (3) the named volume `bobbit-worktrees-<projectId>` survived the container death (`docker volume ls`). Recovery may fetch refs but never pushes the persisted branch.
- **Deleted remote branch reappears during recovery?** This is a no-publication boundary violation. Repair, restore, sandbox recovery, and recreate-from-persisted-branch paths must preserve the local branch without recreating its remote counterpart. Reproduce with a local bare origin and inspect the lifecycle command log for a non-delete `git push`; `tests2/core/git-lifecycle-no-publication-real-git.test.ts` pins creation, pool reuse, multi-repo, recovery, configured `base_ref`, and child-merge cases.
- **WebSocket clients not seeing recovery?** `recoverSandboxSessions()` saves connected WebSocket clients before session deletion and re-attaches them after restore. If clients aren't getting the `session_status: idle` broadcast, check that `ws.readyState === 1` (OPEN) at re-attach time — long-dead containers may have caused the browser to close the connection.
- **Recovery timing**: Expect ~20-40s from container death to session recovery (one health check interval + container recreation + worktree verification + agent process spawn). The `process_exit` → `terminated` UI transition is immediate.
- **Key log prefixes**: `[project-sandbox]` for health monitor and container lifecycle, `[session-manager]` for session recovery and worktree repair, `[sandbox-manager]` for event propagation between subsystems.
- **Testing container recovery**: Kill the container with `docker rm -f <containerId>` and watch server logs. Sessions should transition: `idle` → `terminated` (process_exit) → `idle` (auto-recovery). Run recovery E2E tests: `npx playwright test --config playwright-e2e.config.ts --project=api sandbox-recovery`.

## Search index

FlexSearch-backed lexical search (pure-JS, BM25-style ranking). A lazily started worker owns each project's index. Its durable mirror is `<project-root>/.bobbit/state/search.flex/index/__docs__.json` (atomic snapshot) plus `__docs__.journal` (append-only mutations); the in-memory FlexSearch index is derived lazily and is never persisted. No native binaries, model downloads, or runtime network calls. See [Semantic search](internals.md#semantic-search) for the current architecture and [Search worker and persistence](search-worker-persistence.md) for operations; [Portable Search](design/portable-search.md) is historical rationale.

- **Never delete the mirror or its directory to recover search.** Use **Settings → Maintenance → Search Index → Rebuild Index**, or `POST /api/search/rebuild` with `{ "projectId": "<id>" }`. It returns `202` and rebuilds from authoritative stores and session transcripts; the maintenance panel receives `index:*` progress events.
- Metadata compatibility changes (`engine`, engine version, schema, or content-policy version), a corrupt/missing mirror, or worker recovery schedule an authoritative rebuild. Search remains explicitly unavailable until it can return complete results.
- Legacy FlexSearch export bundles/per-key files, interrupted cache temporary files, and old `search.lance`/native artifacts are disposable. The worker removes them on its next start while preserving the snapshot and journal.
- `ProjectContextManager.searchAll()` aggregates results across all project indexes.
- Purged sessions still showing? `purgeOneSession()` must call `SearchService.removeMessagesForSession` + `removeSession`. Alternatively run the orphaned-index-rows maintenance scan (Settings → Maintenance → Search Index) to clean up rows whose parent entity is gone.
- **Search result click does nothing / ghost results appearing?** `ProjectContextManager.searchAll()` post-filters hits whose project/goal/session/staff no longer exists and fires opportunistic index cleanup; if stale rows persist, check that (1) `projectRegistry`/`sessionManager` were injected into `ProjectContextManager` at boot (see `server.ts`), (2) `matchedOn` is being set by `toSearchResult()` in `flex-store.ts` — `message` rows with `matchedOn === "metadata"` are dropped as phantom matches, (3) client-side stale-click races dispatch the `search-result-stale` window event (from `connectToSession({ onMissing: "toast" })`, `goal-dashboard.ts`, `staff-page.ts`) rather than the blocking `showConnectionError` modal — missing toast means the origin-tag flag wasn't passed. See [docs/internals.md — Orphan filtering & stale-click safety net](internals.md#orphan-filtering--stale-click-safety-net) and [docs/internals.md — Grouped search results & stale-click toast](internals.md#grouped-search-results--stale-click-toast).

### Search unavailable (red dot)

`GET /api/search` returns **503** with `{ error: "search-unavailable", reason, state }` rather than returning a partial corpus. `reason` distinguishes `initializing`, `closed`, `backpressure`, `degraded`, and `worker-backoff`; `state` remains the public service lifecycle (`initializing`, `ready`, `disabled`, or `closed`). A busy worker, recovery rebuild, or restart backoff is a search-service condition, not a session/worktree failure.

Wait for automatic recovery for a transient `backpressure`, `degraded`, or `worker-backoff` response. If it persists, check `[search]` logs and state-directory permissions, then run **Rebuild Index**. Do not retry ingestion synchronously and do not remove `__docs__.json` or `__docs__.journal`; the rebuild is the safe source-backed recovery path.

### Journal/snapshot write error during E2E teardown

A mirror journal or snapshot write error such as `ENOENT` while a test removes `.bobbit/state/search.flex/` is a close-ordering regression, not generic filesystem contention. `ProjectContext.close()` must drain queued search mutations and worker close before a project/test cleanup removes its state directory. Inspect `[search]` and event-loop diagnostics; an error from an open worker is a real persistence failure, while legacy export/cache artifacts are safe for the worker to remove on its next start. See [Close and teardown ordering](internals.md#close-and-teardown-ordering).

### Stats and rebuild progress

- `GET /api/search/stats?projectId=<id>` returns `{ state, engine, engineVersion, rowCountsBySource, datasetBytes, lastRebuildAt, degraded, unavailableReason }`. **400** means `projectId` is missing; **404** means it is not registered. Stats reports degradation rather than returning partial search results.
- `state: "ready"` does not mean a worker or derived index is already resident: both start lazily. Use `degraded` and `unavailableReason` to diagnose worker recovery; use `index:progress`, `index:complete`, and `index:error` events to observe an authoritative rebuild. There is no public `rebuilding` service state.
- Zero row counts after a completed rebuild mean the worker received an empty source set. Verify the project's goal/session/staff stores and session `.jsonl` transcripts; do not treat an empty derived index or deleted legacy cache as proof that the mirror should be removed.

### Performance

- FlexSearch posting lists are built in the worker during mutation or the first query after restart. The gateway event loop must only forward structured payloads; it must not serialize, query, or persist search documents.
- A first query can be slower while the worker derives the index from the compact mirror, but it must either complete with the full corpus or return the explicit 503 above. `datasetBytes` measures the mirror directory, not an exported posting-list cache. Use worker persistence metrics and event-loop-lag diagnostics when measuring a corpus; do not rely on a fixed p95 target or legacy export size.
- Staff not appearing in search? Confirm the staff mutation reaches `SearchService.indexStaff`, then use the maintenance panel's progress/error events and a source-backed rebuild if necessary. A full rebuild includes staff, goals, sessions, and message transcripts; search state is `"ready"`, `"disabled"`, `"initializing"`, or `"closed"`, never `"rebuilding"`.
- Sidebar filter not working? Live sessions/goals/staff and already-loaded archived rows are filtered client-side by case-insensitive substring matching on goal titles, session titles/roles, and staff names. Archived full-corpus lookup is debounced and uses `GET /api/sessions?include=archived&q=<query>` plus `GET /api/goals?archived=true&q=<query>` when archived is visible or auto-opened. Check `handleSidebarSearchInput()` / `renderArchivedSearchControls()` in `src/app/sidebar.ts`, archived search fetches in `src/app/api.ts`, and [docs/sidebar-archived-search.md](sidebar-archived-search.md).
- Show Busy / Show Read filters not applying to a session? Filtering is centralised in `passesSidebarFilters` (`src/app/render-helpers.ts`) and applied at four sites: ungrouped sessions (desktop `sidebar.ts`, mobile `render.ts`), delegate children (`renderSessionRow`, `renderArchivedDelegates` — both in `render-helpers.ts`), and goal-grouped sessions (`renderGoalGroup` in `render-helpers.ts`). All four use `bypassFilters = !!state.searchQuery.trim()`. Active session is always exempt. Goal headers always render. Team-lead is sticky — if it would be filtered out but a child passes, it is re-inserted at its natural position to host the child. If a new sidebar render site is added it must also call `passesSidebarFilters`, or the bug returns; the pinning tests live in `tests/sidebar-goal-group-filters.spec.ts` and `tests/e2e/ui/sidebar-goal-group-filters.spec.ts`.
- Mobile sidebar showing every archived goal when a query is typed? `renderMobileLanding` in `src/app/render.ts` must route archived goals through `filterArchivedGoalsByQuery` and standalone archived sessions through `filterArchivedSessionsByQuery` (both in `src/app/render-helpers.ts`) — the same helpers desktop's `renderSidebar` uses. If mobile skips the filter, every archived goal leaks through regardless of the query.
- Matched substring not bolded in the sidebar? Goal titles, session titles/roles, and staff names render through `renderHighlightedText(text, state.searchQuery)` in `render-helpers.ts`. Empty/null query → plain text; non-empty query wraps every case-insensitive occurrence in `<strong class="font-semibold">`. Regex special chars in the query are escaped. If highlighting breaks layout, check that the wrapper stays inline and that the span does not introduce whitespace.
- Full search page (`#/search`) is the sole consumer of the FTS API (`GET /api/search`) — sidebar archived lookup uses the archived list endpoints with `q`, not the FTS index.
- Archived section not auto-opening on search? Check `_archivedBySearch` / `_ensureArchivedForSearch` in `src/app/sidebar.ts` — they distinguish search-triggered expansion from manual clicks and schedule the debounced archived `q` lookup.

## Sidebar child loading

Visibility is inherited — if a sidebar entry is visible (live, search match, or loaded via "See archived" + paging), all its children must be loaded. Three parent→child relationships are covered:

1. **Goal → sessions**: `teamGoalId` or `goalId` match
2. **Team lead → team members**: `teamLeadSessionId` match (coders, reviewers, QA agents)
3. **Session → delegates**: `delegateOf` chains (recursive)

Debugging checklist:
- Expanding a live goal shows no children? Check the server BFS enrichment in `GET /api/sessions` — it should seed from live goal IDs and walk `teamGoalId`/`goalId`, not just `delegateOf`
- Archived team members missing? The BFS must also walk `teamLeadSessionId` relationships from live session IDs
- Expanding an archived goal shows nothing? Check `GET /api/goals?archived=true` returns an `archivedSessions` field with affiliated sessions and their delegate chains
- Children appear briefly then vanish? The client must merge (not replace) archived sessions — check `fetchArchivedSessionsPaginated()` uses additive merge on first page, not `state.archivedSessions = []`
- Edge case: goal loaded via "Load more goals" has no children? The on-demand fallback in `renderGoalGroup` should fire a one-shot fetch to `GET /api/goals/:id/team/agents?include=archived`. Check the `_goalChildrenFetched` guard Set isn't stale — it's cleared by `clearGoalChildrenFetchedCache()` when toggling archived off

## Paginated archives

- Cursor based on `archivedAt` timestamp
- Missing items? Check `archivedAt` is set (older items may lack it)
- Count mismatch? Verify total from paginated response metadata
- Archived delegates disappearing on "Show Archived" toggle? The `?include=archived` path returns `archivedDelegates` via BFS enrichment — if they're missing, check that the server is running the child BFS on the archived response and the client is merging them into `state.archivedSessions`
- Per-project Archived subsections not persisting their collapsed state? Each project's Archived subsection defaults to expanded; explicit choices persist in `localStorage["bobbit-sidebar-tree-state:v1"]` under `project-archived` tree keys. The global `bobbit-show-archived` toggle controls visibility for all per-project subsections at once and is separate from disclosure state
- Per-project Archived subsection empty for a project you expected to have items? Check in order: (1) `state.showArchived` is true (global toggle on) — if false, **every** project's subsection is suppressed; (2) the relevant normal archive page or active `q` search page has populated `state.archivedSessions` / `state.goals` with the archived items; (3) each item's `projectId` resolves to a registered project — items missing `projectId` or pointing at an unregistered project fall back to the first project's archived bucket with a `console.warn("[sidebar] archived goal/session missing projectId, using default", id)`. If a user reports "my archived items moved to the wrong project", that console warning is the signal.
- "Load more archived" button missing or in the wrong place? With no active search query, normal archive pagination buttons are rendered **once** below the project list, not per project, when `state.showArchived` is on and `state.archivedGoalsHasMore` / `state.archivedSessionsHasMore` is true. With an active query, those unfiltered buttons are replaced by query-aware controls from `renderArchivedSearchControls()` — "Load more matching archived goals..." / "Load more matching archived sessions..." — driven by `state.archivedSearch*HasMore` and the archived `q` endpoints.

## Slash skill expansion

- Skills show in autocomplete but don't expand? The autocomplete API (`/api/slash-skills`) must receive the session's `projectId` so it resolves skills from the correct project's `config_directories`. Verify `AgentInterface.projectId` is set from session data in `session-manager.ts`
- Check server logs for `[ws-handler] Slash skill "<name>" not found for session <id> (cwd=<cwd>)` — this warning fires when a `/skill-name` pattern matches but `getSlashSkill()` returns undefined, indicating a project context mismatch or missing skill file
- In multi-project setups, each project's `config_directories` controls which skills are discovered. A skill defined in project B's config directory won't appear for sessions in project A
- Skill visible on the Skills page but missing from a session's `/` autocomplete (or vice-versa)? The two surfaces must resolve against the same scope. The Skills page follows the active project's scope by default and only latches when the user picks a scope in the selector; confirm the selected scope matches the session's project. Both `/api/slash-skills` and `/api/slash-skills/details` resolve against the config store their `projectId`/`cwd` select, so a mismatch there is the classic cause. Pointed a custom directory at a Claude plugin root and see nothing? The skills nest at `<plugin>/skills/<name>/SKILL.md` — `scanSkillDir` now handles that (see [features.md → Skills](features.md#skills)). See [internals.md → Config scan directories](internals.md#config-scan-directories) for the parity model.

## Skill references not loading

Symptom: a multi-file skill (with `references/`, `scripts/`, or `assets/`) activates, but the agent never reads the referenced files — or reports "file not found" when it tries.

1. **Was the activation header emitted?** Inspect the model-facing `expanded` content for the skill — for `/name` invocations, look in the sidecar at `<stateDir>/skill-sidecar/<sessionId>.jsonl`; for autonomous activations, hit `POST /api/sessions/:id/activate-skill` and check the response. The first non-blank lines should be:
   ```
   <!-- skill-activation-header -->
   Skill root: <path>
   Available resources: ...
   <!-- /skill-activation-header -->
   ```
   Missing header = `buildActivationHeader()` returned `""`. Check: skill is loaded from a directory (not a legacy `.claude/commands/*.md` single file), `filePath` is not `"(built-in)"`, the file basename is `SKILL.md`, and the skill is not `source: "legacy"`.
2. **Resource manifest empty?** If header shows only `Skill root:` with no `Available resources:` line, the skill has no `references/`, `scripts/`, or `assets/` subdirectory at one level deep — `buildSkillResourceManifest()` returned `null`. Confirm those dirs exist on disk under the skill root.
3. **Path reachable from CWD?** The agent reads files using the relative paths in the manifest, resolved against the skill root in the header. If the agent's working directory differs (e.g. it `cd`'d elsewhere), it must use the absolute `Skill root` path. Check the agent isn't dropping the header from the prompt before reasoning.
4. **Sandbox case — degraded header?** If the header reads `Skill root: (not visible inside sandbox — ...)` with no resource list, this is the sandbox limitation: built-in (`defaults/skills/`) and personal (`~/.claude/skills/`) skill roots are not mounted into the Docker container. Project-local skills under `<project>/.claude/skills/` work. Workaround: copy the skill into the project tree. See [docs/internals.md — Sandbox skill visibility](internals.md#sandbox-skill-visibility).
5. **Truncated manifest?** If the skill has hundreds of files, the manifest is capped at 2 KB and ends with `(N more files)`. The agent only sees the alphabetically-first chunk; it must use absolute `<skill-root>/references/...` paths and discover others via `ls`.

Key files: `src/server/skills/skill-manifest.ts` (`buildSkillResourceManifest`, `buildActivationHeader`, `ACTIVATION_HEADER_STRIP_RE`), `src/server/skills/resolve-skill-expansions.ts` (user invocation injection), `src/server/server.ts` activate-skill handler (autonomous injection), `src/ui/components/SkillChip.ts` (header strip for chip body).

See [docs/internals.md — Skill resource manifest (Level-3 progressive disclosure)](internals.md#skill-resource-manifest-level-3-progressive-disclosure).

## Skill chip not rendering

Symptom: user types `/mockup foo`, but the chat bubble shows the fully expanded skill body instead of the literal text + a chip. Or the chip vanishes after sending and only reappears after a reload.

Walk the data path in order:

1. **Sidecar present?** Check `<stateDir>/skill-sidecar/<sessionId>.jsonl` exists and contains an entry with the expected `modelText` / `originalText` / `skillExpansions`. No file = `appendSkillSidecarEntry()` failed silently (look for `[skill-sidecar]` warnings) or `initSkillSidecarDir()` was never called at server bootstrap. No matching entry = the WS handler called `enqueuePrompt` without first calling `resolveSkillExpansions()`.
2. **Live WS user-message envelope carrying `skillExpansions`?** Open DevTools → Network → WS and inspect the user-message echo frame. It must include the `skillExpansions` array. Bug we hit during the Skill UX goal: `src/server/ws/handler.ts` resolved expansions and persisted the sidecar but stripped `skillExpansions` from the broadcast envelope, so chips only appeared after reload (when sidecar replay rehydrated them). If the live frame is missing the field, fix the handler echo — don't rely on reload as a workaround.
3. **`<skill-chip>` custom element registered?** In DevTools → Console run `customElements.get('skill-chip')`. If `undefined`, the import in `src/ui/index.ts` is missing or the bundle didn't pick up `src/ui/components/SkillChip.ts`. The chip renders as raw text in this case.
4. **Old session?** Sessions started before this feature have no sidecar and no `skillExpansions` on persisted user messages. They render the legacy fully-expanded text as plain markdown by design — not a bug.

See [docs/internals.md — Skill chip rendering & autonomous activation](internals.md#skill-chip-rendering--autonomous-activation) for the full architecture and [docs/design/skill-ux-and-autonomous-activation.md](design/skill-ux-and-autonomous-activation.md) for the design rationale (model-prompt byte-equality, snapshot-at-invocation, backward compat).

## `activate_skill` returns "name is required" / failures invisible in UI

Symptom: the model calls `activate_skill` autonomously and the tool result is `activate_skill failed: name is required` every time, while the chat UI shows only a benign "Activating /name…" header (no error). User-typed `/name` slash invocations still work, because they resolve through the WS handler's expansion logic — a different path that never touches this tool. Two distinct defects, both confirmed in practice:

1. **Extension dropped the params (wrong `execute()` argument).** pi's `ToolDefinition.execute` contract is `execute(toolCallId, params, signal, onUpdate, ctx)` — the tool-call id string is **first**, the validated params are **second**. The skills extension declared a single parameter and read `input.name`/`input.args`, so `input` was actually the id string and both fields were `undefined`. `JSON.stringify({ name: undefined, args: "" })` drops the `undefined` key, so the gateway received `{"args":""}`, `POST /api/sessions/:id/activate-skill` set `skillName = ""`, and returned 400 `name is required`. Deterministic, independent of sandbox/network. Fix: read params from the second argument — `async execute(_toolCallId, input: { name, args? })` — matching every other `defaults/tools/*` extension. Pinned by `tests/activate-skill-extension.test.ts`, which invokes the real registered tool with pi's `(toolCallId, params)` convention and asserts the captured request body carries both `name` and `args`. (`tests/e2e/activate-skill.spec.ts` did NOT catch this — it hits the REST endpoint directly, bypassing `execute()`.)

2. **Renderer hid the failure behind `result.isError`.** `ActivateSkillRenderer` only surfaced failure text when `result.isError` was truthy. But pi's agent-loop hardcodes `isError: false` for any tool whose `execute()` *returns* (rather than throws), so the extension's returned `{ isError: true }` never reaches the renderer. With no `skillExpansion` and a falsy flag, the renderer fell through to the benign "Activating…" header and discarded `result.content[0].text` (which held `activate_skill failed: …`). Fix: when there is no `skillExpansion`, surface the result's text content as a visible error (red header + message) regardless of the flag. Pinned by `tests/activate-skill-renderer.spec.ts`.

Lesson for extension authors: never read tool params from the first `execute()` argument, and never gate UI error display on `isError` for tools that signal failure by *returning* an error result. See [docs/internals.md — Skill chip rendering & autonomous activation](internals.md#skill-chip-rendering--autonomous-activation).

## OpenRouter sessions stuck after provider-auth failure

- **Symptom**: OpenRouter appears authenticated in Settings/Models, but a direct or team agent reports `No API key found for openrouter`, remains shown as streaming, or accumulates queued prompts that never drain.
- **Cause**: pre-fix direct/non-sandbox `RpcBridge` spawns did not receive `providerKey.openrouter` as `OPENROUTER_API_KEY`, even though model auth detection treated the Settings key as valid. Provider-auth dispatch failures also left stale streaming state in persisted sessions.
- **Fixed behavior**: Settings-saved provider keys are bridged into direct/non-sandbox agent env (`providerKey.openrouter` → `OPENROUTER_API_KEY`, plus the other built-in API-key providers). Sandboxed agents are unchanged: provider env vars still require an enabled `sandbox_tokens` entry. Missing/invalid provider credentials now transition the session to idle, keep the rejected prompt recoverable at the front of the queue, and surface a provider-auth banner with **Fix API key**, **Retry**, **Switch provider**, and **Abort/respawn** actions. Raw key material is redacted from client frames, EventBuffer, logs, and session metadata.
- **Operator recovery for existing stuck sessions**:
  1. Deploy/restart onto a build that contains the host provider key bridge.
  2. Confirm Settings → Models has a valid OpenRouter key, or switch the affected session/team agent to a known-working provider. For sandboxed agents, also confirm project `sandbox_tokens` explicitly enables `OPENROUTER_API_KEY` if OpenRouter should be available inside Docker.
  3. For each affected direct/team session, use the banner's **Abort/respawn** action (or the session/team abort API) so the subprocess restarts with fresh env. If the session is already idle with a provider-auth banner, fixing/switching credentials and pressing **Retry** is enough.
  4. Retry the queued prompt. The queue row should be consumed and `wasStreaming` should remain `false` unless a new turn is actively running.
- **Where to look**: `src/server/agent/host-tokens.ts::mergeHostAgentProviderEnv`, `session-setup.ts::_resolveBridgeOptions`, `session-manager.ts::surfaceProviderAuthFailure`, `src/ui/components/AgentInterface.ts::renderProviderAuthRequired`, and [internals.md — Host agent provider key bridge](internals.md#host-agent-provider-key-bridge).
- **Pinning tests**: `tests/openrouter-key-bridge-repro.test.ts`, `tests/spawn-env.test.ts`, `tests/remote-agent-outbox.spec.ts`.

## Multi-project / per-project state

- Normal-project state lives in `<project-root>/.bobbit/state/`; Headquarters state aliases `bobbitStateDir()` because it represents the server workspace.
- `ProjectContextManager` manages all `ProjectContext` instances and routes store access.
- Project registry at `<bobbitStateDir>/projects.json` — check the file exists and is valid JSON.
- **Headquarters startup.** Startup should ensure a visible project with `id: "headquarters"`, `kind: "headquarters"`, root `getProjectRoot()`, and display name `Headquarters`. A fresh server should allow a Quick Session without Add Project. If `GET /api/projects` is empty, check whether `showHeadquartersInProjectLists` is `false`; explicit `GET /api/projects/headquarters` should still work.
- **No implicit normal project.** Bobbit never auto-registers an arbitrary user repo as a normal project. For normal project work, `POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` still need an explicit project id or a `cwd` inside a registered project's `rootPath`. Headquarters satisfies that contract with `projectId: "headquarters"`.
- **Synthetic `system` project carve-out.** At startup the server registers a hidden synthetic project (id `system`, anchored at `<bobbitStateDir>/system-project/`, `hidden: true`) via `registerSystemProject()`. It does **not** appear in `GET /api/projects` and is invisible to `state.projects`, but remains a valid compatibility `projectId` for server-scope role/tool assistant sessions. Staff assistants are excluded and must resolve a visible project such as Headquarters. See [internals.md — Synthetic system project](internals.md#synthetic-system-project) and [rest-api.md — `POST /api/sessions` assistantType carve-outs](rest-api.md#post-apisessions--assistanttype-carve-outs).
- **Diagnosing a user-visible 400 "projectId required":**
  1. Was the request a `POST /api/sessions` with `assistantType ∈ {role, tool}` and no `projectId`? It should anchor at `system`; a 400 here means the server-scope carve-out regressed. If `assistantType` is `staff`, the 400 is expected unless the request includes a visible project such as `headquarters` or project-contained `cwd`.
  2. Was the request from a system-scope tool assistant relying on `cwd` only? It must carry `projectId: "system"` in the POST body — `cwd`-only resolution will not match hidden projects.
  3. Was the request from the splash **Quick Session** button on a fresh server? It should post `projectId: "headquarters"`; a 400 means Headquarters resolution or the hidden-Headquarters fallback regressed.
  4. Confirm both special projects are registered by inspecting `<bobbitStateDir>/projects.json`; only Headquarters should be visible through `/api/projects` by default.
- `GET /api/projects` to list visible projects; `GET /api/projects/headquarters` to check Headquarters even when hidden.
- Sessions/goals not appearing? Check `projectId` field matches the expected project. For Headquarters, verify the server state dir's `sessions.json` and `goals.sqlite`; for normal projects, verify that project's state files. Inspect SQLite only on a stopped, complete state-directory copy.
- Sidebar not grouping? Project folder rows are always shown for visible projects — check `state.projects`, the Headquarters visibility preference, and `renderProjectHeader()`.
- Project registration failing? `rootPath` must be absolute and exist on disk; duplicate normal paths are rejected. The server workspace is already represented by Headquarters and cannot be added again.
- Search not filtering by project? Verify `?projectId=` query param is passed; each project context, including Headquarters, has its own `search.flex/` index under its state dir.
- Config not cascading? Check builtin, Headquarters/server, and normal project `.bobbit/config/` directories. `projectId=headquarters` should resolve as server scope for non-workflow roles/tools/policies/skills, while workflows remain project-scoped.
- **State migration**: On first startup after upgrade, central JSON state is distributed to per-project dirs. GoalStore, TaskStore, and GateStore then validate and import their own legacy/recovery sources into separate SQLite databases before retiring the JSON collision-safely. Headquarters keeps central state in place during distribution and stamps the migration marker instead of renaming its own files away. Check `.migrated-to-per-project`, store authority/retirement metadata, and `.headquarters-project-id-migrated` when diagnosing old server-root project promotion.
- **Deleted staff/session/goal reappears after restart**: the boot migration's backup-only recovery (`routeLegacyProjectStoreFile` in `state-migration.ts`) resurrects a record present in a `.pre-headquarters-id-migration` backup but absent from the live store — `staff.json` reverts byte-for-byte to its pre-delete size and any triggers reactivate. Fixed by durable **deletion tombstones** (`deletion-tombstones.ts`, file `<stateDir>/.deletion-tombstones.json`) recorded by store `remove()`; the recovery loop skips tombstoned keys (see `diagnostics.tombstonedSkipped`). If it recurs, confirm the tombstone file exists and contains the id, that the same-root repair is marker-guarded (`.headquarters-dir-migrated` → no-op on second boot), and that spent backups were retired to `.pre-headquarters-id-migration-recovered`. See [docs/headquarters.md — Deletion tombstones](headquarters.md#deletion-tombstones-why-deleted-staffsessionsgoals-stay-deleted).
- **Model defaults missing after BOBBIT_DIR change**: `migrateLegacyHeadquartersDirectory` skips the legacy copy when `BOBBIT_DIR`/`BOBBIT_PI_DIR` is set, so `default.*Model` / `default.*ThinkingLevel` preference keys would be lost when pointing to a fresh dir. `seedModelDefaultsFromLegacy` runs after the main migration and non-destructively seeds those 7 keys from `<serverRunDir>/.bobbit/state/preferences.json` into the new Headquarters state dir. If settings are still missing, confirm the legacy file exists at that path and check `[migration]` log output on startup. See [docs/headquarters.md — Model-default preference seeding](headquarters.md#model-default-preference-seeding).
- **Store routing bugs**: All store access must go through `ProjectContextManager` — direct `this.store` calls bypass per-project routing. `SessionManager` uses `resolveStoreForSession()` / `resolveStoreForId()` to find the correct per-project `SessionStore`
- **Known limitations**: `active-verifications.json` stays in the central state dir (transient operational state).

## Project proposal panel doesn't reflect the latest `propose_project` call

- **Symptom**: an agent calls `propose_project` a second time in the same session (e.g. after the user steers component naming), but the right-hand panel still shows the previous components or workflows. Components/Workflows tabs are stale; the Diff tab may show no diff or the wrong diff.
- **Diagnostic order**:
  1. **Bug A — JSON-string coercion**: confirm the `propose_project` tool extension is not stringifying `components` / `workflows` into the legacy flat field map. They must arrive at `onProjectProposal` as structured arrays/objects, not as JSON strings rendered into a legacy `Input` row.
  2. **Bug B — `onFieldInput` clobber**: confirm `onFieldInput` in `src/app/render.ts::projectProposalPanel` early-returns for `key === "components"` and `key === "workflows"`. Without that guard, a stray keystroke on a hidden Input row overwrites the structured side-table with a string.
  3. **Bug C — missing shallow-merge**: confirm `onProjectProposal` in `src/app/session-manager.ts` shallow-merges the new payload over the previous one and re-attaches `components` / `workflows` from the prior proposal when missing in the incoming partial. A wholesale replace drops one of the structured tables on every streaming delta. The shallow-merge also runs **per component**: when both prev and incoming have `components`, entries are matched by `name` and missing `commands` / `config` on the incoming entry are carried over from the prev entry. Without this, a partial re-emit (e.g. agent emits `components: [{name: "web", commands: {...}}]` to update commands only) clobbers the previous `config` map on `web`.
- **Verify**: open the Components tab, trigger a `propose_project` that adds a new component, then watch for the new `component-card-${name}` testid to appear without dismissing/reopening the panel. Same drill on the Workflows tab with `workflow-card-${id}`.
- **Architecture**: see [docs/internals.md — Project-proposal panel structure](internals.md#project-proposal-panel-structure) for the live-update guarantee and the three-view layout (Components / Workflows / Diff + legacy fields block).

## Monorepo subprojects not detected

- **Symptom**: project assistant doesn't suggest per-component workflows for a clearly-monorepo project (pnpm/npm workspaces, Nx, Turbo, Lerna, Cargo, Go workspace, Gradle multi-module), or `POST /api/projects/scan` returns an empty `monorepo` field.
- **Diagnostic order**:
  1. Confirm the workspace manifest is one `monorepo-scan.ts` recognises: `pnpm-workspace.yaml`, `package.json` with a `workspaces` array, `nx.json`, `turbo.json`, `lerna.json`, `Cargo.toml` with `[workspace]`, `go.work`, or Gradle `settings.gradle[.kts]` containing `include(...)`. Anything else falls through to single-repo detection.
  2. Confirm the manifest is at the project's `rootPath`, not nested below it. The scanner is one level deep — it does not recurse into the workspaces themselves.
  3. If a project legitimately has more than 30 workspace packages, output is capped at `MAX_CANDIDATES = 30` (alphabetical truncation marker emitted). The assistant still gets a representative slice; the user can add the rest manually.
- **Architecture**: see `src/server/agent/monorepo-scan.ts` and [docs/internals.md — Project-proposal panel structure](internals.md#project-proposal-panel-structure) (Monorepo subproject scan).

## Add-project: Continue after Archive tries to auto-import / opens stale project instead of assistant

- **Symptom**: user clicks "Archive existing .bobbit/" in the add-project preflight panel, archive succeeds, then clicking Continue auto-imports a (now empty) project instead of opening the project assistant. Same symptom for any "ghost `.bobbit/`" directory (empty, half-extracted archive, crashed install, manually-created stub).
- **Cause**: `POST /api/projects/detect` decides `hasBobbit` from the on-disk marker `<path>/.bobbit/config/project.yaml`, NOT from the mere presence of a `.bobbit/` directory entry. The archive flow re-scaffolds empty `.bobbit/config/` and `.bobbit/state/` after moving content aside (see `src/server/agent/bobbit-archive.ts`), so `.bobbit/` always exists post-archive but `project.yaml` does not — detection must return `hasBobbit: false` and the UI must fall through to the assistant branch in `src/app/dialogs.ts::doContinue`.
- **Diagnostic order**:
  1. `GET /api/projects/detect` for the candidate path — confirm `hasBobbit` matches existence of `<path>/.bobbit/config/project.yaml`. If `hasBobbit: true` with no `project.yaml`, the server check has regressed (see `src/server/server.ts` `/api/projects/detect` handler).
  2. The preflight `bobbit.existing` row is a separate concern ("is there content to archive?") and must keep firing whenever `.bobbit/` has content — do NOT collapse the two checks. See [add-project-preflight.md](add-project-preflight.md).
  3. Browser E2E: `tests/e2e/ui/add-project-post-archive.spec.ts` pins the archive → Continue → assistant flow.
- **Truth table** (`.bobbit/` shape → expected route):
  - absent → assistant
  - empty, or only empty `config/` + `state/` (post-archive shape) → assistant
  - contains `config/project.yaml` → auto-import
- **Architecture**: see [docs/internals.md — Project assistant](internals.md#project-assistant) for the detection marker rationale and the auto-import vs assistant routing.

## Legacy JSON-string project.yaml field rejected

- **Symptom**: `PUT /api/projects/:id/config` (or `/api/project-config`) returns 400 in one of two situations:
  1. Setting `config_directories` or `sandbox_tokens` with a JSON-encoded string instead of a structured array of mappings.
  2. Setting any of the seven legacy top-level QA keys: `qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`.
- **Cause**:
  - `config_directories` / `sandbox_tokens` are native YAML on disk and structured on the wire end-to-end. Sending a JSON-encoded string (e.g. `"[{\"path\":...}]"`) is rejected to prevent regression to the old encoding.
  - The seven `qa_*` keys no longer live at the top level. They have moved onto each component's opaque `config:` map (`components[<name>].config[<key>]`), and `qa_env` has been removed entirely — agents inline env vars directly into `qa_start_command`. The wire-level rejection forwards a migration message pointing at the new location.
- **Fix**:
  - For `config_directories` / `sandbox_tokens`: send structured payloads (arrays of mappings). The settings UI, `propose_project`, and `acceptProjectProposal` already do this; only hand-rolled API callers should hit the 400.
  - For QA keys: PUT a `components` array with the `qa_*` keys nested under the relevant component's `config:` map. Inline env vars (formerly `qa_env`) directly into `qa_start_command` itself, single-quoted with `'\''` escapes for embedded quotes.
- **On-disk legacy form is still tolerated**: `ProjectConfigStore` parses legacy JSON-string and quoted-numeric values for `config_directories` / `sandbox_tokens` transparently via `getConfigDirectories()` / `getSandboxTokens()` and rewrites the file in native form on the next save. The first-boot migration in `state-migration/migrate-project-yaml.ts` moves any top-level `qa_*` keys it finds onto the relevant component's `config:` map (inlining `qa_env` into `qa_start_command`) and deletes the originals. Only the wire format is strict. See [docs/internals.md — Native-YAML project.yaml fields](internals.md#native-yaml-projectyaml-fields) and [Multi-repo & components](internals.md#multi-repo--components).

## Empty `verification.steps[]` after `gate_signal`

- **Symptom**: `POST /api/goals/:id/gates/:gateId/signal` returns a populated `steps[]` array, but for ~15-30 s afterwards `GET /api/goals/:id/gates/:gateId` (or any other read of the gate-store signal) returns `latestSignal.verification.steps: []`. Dashboard's workflow-progress indicator renders no in-flight chips during that window. Reproducible with any multi-step gate — worst on the `implementation` gate (8+ steps with build / typecheck / unit / e2e / llm-reviews).
- **Cause**: pre-fix the REST handler wrote `signal.verification.steps = []`, called `gateStore.recordSignal(signal)`, then fire-and-forget invoked `verifyGateSignal()` which built the `ActiveVerification` entry several `await`s later (gate-store lookups, workflow resolution, `ProjectConfigStore` reads). Anything reading the gate-store or `/api/goals/:id/verifications/active` between the two writes saw an empty step list.
- **Fix**: step enumeration is now synchronous via `VerificationHarness.beginVerification(signal, gate)`. The REST handler calls it before `recordSignal` and writes the returned `GateSignalStep[]` into `signal.verification.steps` atomically with the gate-store write. `verifyGateSignal` reuses the pre-seeded active entry instead of re-creating one (so `startedAt` isn't re-stamped and `gate_verification_started` isn't re-broadcast). `cancelStaleVerifications` runs **before** `beginVerification` so it doesn't observe and tear down the new entry. See [docs/gate-signal-step-enumeration.md](gate-signal-step-enumeration.md) for the full design.
- **If it recurs**: (1) confirm `beginVerification` is called before `recordSignal` in the `gate_signal` handler in `server.ts` — any future call site that signals a gate must follow `cancelStaleVerifications` → `beginVerification` → `recordSignal` order; (2) confirm `verifyGateSignal` is reading the pre-seeded `activeVerifications` entry rather than constructing a fresh one when called from the REST path (a fresh build re-stamps `startedAt` and re-broadcasts `gate_verification_started`, breaking WS ordering); (3) confirm `GateSignalStep.status` is set on the seeded rows so the dashboard renderer (`goal-dashboard.ts`) renders them as `running`/`waiting` rather than as failed (with `passed: false` and no `status`, the renderer fell back to a failed-X icon).
- **Pinning tests**: `tests/gate-signal-step-enumeration.test.ts` (unit — immediate gate-store read after signal); `tests/e2e/gate-signal-progress.spec.ts` (API E2E — POST response vs summary vs inspect vs active endpoints all match within one scheduler tick); `tests/e2e/ui/verification-progress-indicator.spec.ts` (browser E2E — chips render immediately and survive reload from persisted state alone).

## Gate re-signal cancellation

- A re-signal durably cancels the old generation before it seeds the new one. Old finalization updates only that historical signal and cannot overwrite the newer generation or gate state.
- **Cancellation requested/pending is not terminal.** The manual response includes `outcome: "cancelled"`, `cause: "manual"`, `signalId`, and `pending`. When `pending: true`, wait for exact cleanup, then inspect signal history or gate detail for the terminal record rather than using `/verifications/active` as a cleanup ledger.
- **Terminal cancellation** has the same response fields with `pending: false`. With no running verification, the idempotent response is `{ "cancelled": false, "message": "No running verification to cancel" }`.
- For cancellation causes, restart recovery, and generation safety, see [Verification cancellation lifecycle](verification-cancellation.md).

## Reviewer busy contention during `llm-review` or `agent-qa`

- **Symptom**: a review or QA step reports the exact bridge message `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` This is infrastructure contention, not a reviewer finding and not an instruction to manually re-run the gate.
- **Expected behavior**: the harness admits every verifier prompt as one durable `verifierOwned` row with Pi's atomic `followUp` mode, then waits for that row's receipt. A busy reviewer is queued or recovered with bounded, cancellable retry; a same-session recovery preserves its transcript and title. A raw busy rejection at the defensive boundary is classified as verifier infrastructure contention rather than a terminal content failure.
- **Where to look**: grep `[verification][verifier-dispatch]` and correlate the full lifecycle tuple: `goal`, `gate`, `signal`, `step`, `reviewerSession`, `verifier`, `prompt`, `attempt`, `dispatchBudgetMs`, `mode`, `decision`, and `row`. A warm dispatch budget is 60 seconds; a cold dispatch budget is derived as 215 seconds from readiness, first-prompt acknowledgement, and handoff margin. Logs intentionally omit prompt/provider payloads.
- **Cancellation fence**: a cancellation or re-signal cancels the pending receipt's exact row and fences the old `(goal, gate, signal)` generation. A late old-generation verdict must not add a duplicate turn or replace the newer signal's result. If the row or result survives that fence, inspect the matching `row` and `decision=cancelled-generation` records before changing retry policy.
- **Reference and coverage**: [Verifier Recovery](llm-review-recovery.md#verifier-prompt-dispatch-and-contention), especially its source-attribution versus ownership distinction. Focused lifecycle coverage belongs with the verifier recovery and concurrent-gate regression tests, not user-facing retry flows.

## HTTP 409 `Verification already in progress` after gateway restart

- **Symptom**: after a gateway restart, `POST /api/goals/:id/gates/:gateId/signal` on the same commit returns `409 { error: "Verification already in progress for this commit", existingSignalId: ... }` even though the UI shows the prior command verification as pending or failed.
- **Cause class**: duplicate detection still sees an active verification for that signal. A valid active entry means either a same-process command is genuinely live, a reviewer session is live, or command timeout/cancel cleanup is still pending. A stale entry from a previous gateway lifetime must not lock the gate.
- **Fix**: command liveness for duplicate detection is bounded to the current harness lifetime (`bootEpoch` + live PID). Restart recovery then either finalizes from the durable exit file, leaves no-verdict interruptions pending/retryable, or keeps durable kill intent only until verified cleanup completes. Completed or unrecoverable entries are removed from memory and `active-verifications.json` in `resumeInterruptedVerifications()`.
- **If it recurs**: grep server stdout for `[api] Rejecting gate_signal as duplicate` and inspect `active-verifications.json`. A stale `bootEpoch` with no pending `killRequestedAt` means resume cleanup did not run. A current entry with `killRequestedAt` / `killUnsafeReason` means Bobbit is intentionally preserving cleanup state until it can verify the command tree is gone. See [Exact process ownership for command verification](verification-restart.md).
- **Pinning tests**: `tests2/core/verification-harness-restart.test.ts`, `tests2/core/verification-command-restart-lifecycle.test.ts`, `tests/e2e/verification-restart-resignal.spec.ts`.

## Gate marked `failed` after gateway restart with a "Resume Error" step

- **Symptom**: a restart during `llm-review` or `agent-qa` leaves a failed `Resume Error` step, or a restart interruption is shown as a product failure.
- **Expected behavior**: a restart-no-verdict is a durable `gateway-restart-recovery` cancellation and leaves the current gate eligible/pending. A real recovered command or reviewer verdict may still pass or fail. A genuine non-restart resume error is also a terminal failure, but its signal and gate publication wait for reviewer, host, Docker, and sign-off cleanup.
- **Diagnostic**: inspect the active record and signal history for `restartInterrupted`, `reviewerCleanupPending`, and `pendingTerminalIntent`. `_hasUnmarkedTerminalResumeFailure` distinguishes a real failed sibling from a marked no-verdict interruption; `shouldSuppressExplicitRestartInterrupt` suppresses only an all-interrupted aggregate. Do not classify either case by summary or command-output text.
- **If recovery is incomplete**: retained `reviewerCleanupPending` identifies the exact reviewer session that must be cleaned up after restart. If enough durable rows determine the aggregate, recovery stages that terminal intent. Otherwise it cleans retained ownership and resumes; missing goal, gate, workflow, or signal context keeps the active record for a later retry instead of fabricating a result.
- **Reference**: [Verification cancellation lifecycle](verification-cancellation.md#restart-and-recovery) and [Verifier Recovery](llm-review-recovery.md).

## Boot-recovery re-prompt times out / `[gateway] Unhandled rejection: Command timed out: prompt`

- **Symptom**: on gateway restart (especially with several sessions restoring in parallel), the startup log shows any of: `[gateway] Unhandled rejection: Error: Command timed out: prompt`; `[session-manager] Failed to re-prompt interrupted session <id>: Error: Command timed out: prompt`; `[session-manager] direct prompt dispatch failed for <id> (...); re-enqueueing 1 row(s) at front`. A mid-turn session or an idle team-lead with outstanding work then fails to resume after the restart.
- **Cause**: a freshly-revived agent is *cold* (model init + MCP extension load, 30–90 s to first respond, worse under parallel restore). Both generic boot-recovery paths — the mid-turn re-prompt in `SessionManager.restoreSession` and the `TeamManager` boot-resume nudge (`_bootResumeIdleTeamLeads`) — prompted with the default **30 s** RPC timeout and *without* waiting for readiness, so the cold prompt reliably timed out. The boot-resume nudge additionally called `enqueuePrompt` without awaiting its **async drain**, so the drain's cold-start rejection escaped as a process-level `[gateway] Unhandled rejection`. A lead that was both mid-turn and had open work was also prompted twice, racing two prompts at one cold agent.
- **Fix**: both paths dispatch through the shared `RpcBridge.promptWhenReady(text, images?, opts?)` helper (exported `COLD_REPROMPT_READY_TIMEOUT_MS=90_000` / `COLD_REPROMPT_PROMPT_TIMEOUT_MS=120_000`), which awaits `waitForReady` then `prompt` with a generous timeout. `enqueuePrompt` gained a `coldStart?: boolean` option threaded into `dispatchDirectPrompt`; the nudge passes `coldStart: true` and is dispatched via `_dispatchBootResumeNudge`, which `await`s the drain inside a `try/catch` so the rejection is caught/logged, never escaping. The double-prompt race is closed by `SessionManager._bootRepromptedSessions` (exposed via `wasBootReprompted(id)`, cleared on `agent_start`): the boot-resume nudge skips any lead the mid-turn re-prompt already covered. Full design in [docs/cold-restart-reprompt.md](cold-restart-reprompt.md).
- **If it recurs**: confirm both recovery paths still funnel through `promptWhenReady` (not a bare `prompt()`), that the boot-resume dispatch is awaited inside `_dispatchBootResumeNudge`'s `try/catch`, and that `wasBootReprompted` is consulted before nudging. A re-appeared `[gateway] Unhandled rejection` on boot means an `enqueuePrompt` call lost its `await`/catch again.
- **Pinning test**: `tests/cold-restart-reprompt.test.ts` (readiness wait + generous timeout on the mid-turn re-prompt; no escaped unhandled rejection from the nudge drain; single re-prompt for a session that is both mid-turn and a lead with work).

## Phased verification

- Steps are grouped by `phase` (integer, default 0) and phases execute sequentially in ascending order
- Within each phase, steps run concurrently by default, including command steps
- Use different `phase` values when command checks require explicit ordering
- Component-linked `command: unit` steps default to a 1200s timeout when `timeout` is omitted; other command steps default to 300s
- If any step in a phase fails, remaining phases are skipped (status: `"skipped"`)
- Skipped steps carry `skipped: true` on `GateSignalStep`, persisted in the gate's SQLite payload — this lets the UI show the correct dash icon after reload (without it, skipped steps would appear as passed or failed based on the `passed` field alone)
- `gate_verification_phase_started` WebSocket event fires before each phase
- Step events include `phase` field; skipped steps show `"Skipped — earlier phase failed"`
- Check `ActiveVerification.currentPhase` via `GET /api/goals/:goalId/verifications/active`
- If LLM reviews run when they shouldn't: verify `phase: 1` is set on `llm-review` steps in the workflow YAML

## Verification artifacts

- `llm-review` steps store full output as `text/markdown` artifacts on `GateSignalStep.artifact`
- Artifacts are capped at 10 MB; content truncated if exceeded
- Dashboard shows markdown artifacts in collapsible "Full Review" sections; HTML artifacts via "View Report" button
- If artifacts are missing: check that the `llm-review` step completed (not skipped/cancelled)
- Artifact data persists in the gate's SQLite payload alongside step results

## QA screenshot token bloat

- Symptom: QA session burns millions of cache-read tokens / dollars of cost, often killed by the context ceiling before it can submit a verdict.
- Root cause (pre-fix): `browser_screenshot(includeBase64: true)` returned the full `data:image/png;base64,...` URI as a text content block. It stayed in the transcript and was re-cached on every subsequent turn.
- Quick check: open the QA session's transcript and inspect a `browser_screenshot` tool result. Post-fix results contain `[screenshot_file]<absolute-path>[/screenshot_file]`. If you still see `[screenshot_base64]data:image/...[/screenshot_base64]`, the browser tool extension is stale — rebuild and restart the server.
- Spilled files live under `<session-cwd>/.bobbit-qa/screenshots/`. The directory is gitignored and deleted on session shutdown. If stale dirs remain after a crash, they are safe to `rm -rf`.
- Reports referencing screenshots via `<img src="file://...">` are inlined to base64 by the server when the agent submits via `report_html_file` (20 MB cumulative cap, session-cwd-scoped). See [qa-testing.md — Screenshots in QA reports](qa-testing.md#screenshots-in-qa-reports).

## Worktree-pool errors at startup on a fresh install / `pool/_pool-*` branches in an unrelated repo

- **Symptom**: brand-new bobbit install with no user projects registered emits `[worktree-pool]` errors at startup, or `pool/_pool-*` branches and worktrees appear inside an unrelated git repo (e.g. a bobbit source clone, or whichever directory you happened to `cd` into before launching bobbit). Reproduces only when the bobbit state dir is itself nested inside some ancestor git work tree.
- **Root cause**: at startup the server registers a hidden synthetic project (id `system`, anchored at `<bobbitStateDir>/system-project/`) as a persistence anchor for system-scope tool-assistant sessions. The boot worktree sweeper and pool-init loops used to iterate **every** `ProjectContext` via `ProjectContextManager.all()`, including the hidden one. The pool's `isGitRepo(repoPath)` gate shells out to `git rev-parse --is-inside-work-tree`, which walks **up** the directory tree — so when `<bobbitStateDir>/system-project/` is nested inside any ancestor `.git`, the gate passes and the pool starts allocating `pool/_pool-*` branches and worktrees in the unrelated host repo.
- **Fix**: `ProjectContextManager.visible()` skips `hidden: true` contexts. Worktree sweeper, pool init, goal-manager pool-resolver wiring, unified worktree maintenance cleanup, and the `/api/sessions` + `/api/goals` listing aggregations all iterate `visible()` instead of `all()`. Callers that legitimately need the hidden system project (session/goal lookup by id, MCP discovery, system-scope tool authoring resolution) keep using `all()`. Pinned by `tests/system-project-pool-leak.test.ts`.
- **Diagnostic checks**:
  1. `git -C <bobbit-state-dir> rev-parse --show-toplevel` — if it prints any path, the state dir is inside a host git repo and the pre-fix bug would trigger.
  2. `git -C <host-repo> branch --list 'pool/_pool-*'` and `git -C <host-repo> worktree list` reveal leftovers. Bobbit deliberately reports discovered entries rather than adopting or deleting them. Verify ownership yourself before using `git worktree remove` and deleting the local branch.
  3. New worktree/pool/sweeper iteration must use `visible()`. If you add a new boot-time iteration over `ProjectContextManager` and reach for `all()` reflexively, you will reintroduce this bug — see [internals.md — Iteration contract: `visible()` vs `all()`](internals.md#synthetic-system-project).

## Slow first-session preparing window on cold boot

- **Symptom**: the first session created after `npm run dev:harness` (or any fresh server start) sits in `preparing` for tens of seconds to minutes; subsequent sessions in the same server lifetime are fast. Server stdout shows `[worktree-setup] bobbit: ok` only after a long delay; until that line, every new session falls through to the cold-path `createWorktree` + per-component `runComponentSetups()` (e.g. `npm ci`).
- **Why this happens (pre-fix)**: `runBootBackgroundTasks()` in `src/server/server.ts` awaited the orphan-worktree sweeper across **all** registered projects sequentially before starting **any** pool init. With even a handful of stale session worktrees on disk the sweeper invoked multiple `git worktree list` / `git worktree repair` calls per repo, each with 10–15 s timeouts (especially slow on Windows). Pool init for project N didn't begin until projects 1…N−1 had finished sweeping, so the pool was empty for the entire window — every new session paid the full cold-path cost.
- **What changed**: sweeper and pool init now run concurrently via `Promise.all`. Per-project pool init is also parallelised across projects. Boot timing is logged with the `[boot]` prefix:
  - `[boot] sweeper start`
  - `[boot] sweeper done in Xms`
  - `[boot] pool ready: project=Y in Zms`
  - `[boot] background tasks complete in Wms`
  Reading these lines lets you attribute the wait empirically (sweeper vs per-project pool fill vs `npm ci`).
- **Why parallelising sweeper + pool init is safe**: the sweeper is diagnostic-only for discovered orphans, and pool initialization has no startup `reclaimOrphaned()` flow. It mutates only entries created and held by the current `WorktreePool` instance, so neither side adopts or removes a worktree discovered from branch/path shape. If either startup path gains discovered-worktree mutation, reassess concurrency and ownership proof first.
- **How to diagnose**:
  1. Read the `[boot]` lines in server stdout (or `.bobbit/state/server.log` if redirected). Sweeper time and per-project pool time are reported separately. If `[boot] sweeper done` is the dominant cost, the sweeper itself needs follow-up work (per-project parallelism inside it; parallel per-repo `git worktree list`). If `[boot] pool ready: project=X in Yms` dominates, the cost is in the pool fill (`createWorktree` + setup hook).
  2. Confirm pool fill actually started before the sweeper finished by comparing timestamps on `[boot] sweeper start` vs the first `[worktree-pool] _fill` log line.
  3. If the dev server is being smoke-tested against a clean checkout and you want to skip the pool entirely (e.g. CI), set `BOBBIT_SKIP_WORKTREE_POOL=1`. Sessions then always take the cold path — useful as a baseline measurement.
- **Mitigations not yet applied (follow-up candidates)**: per-project parallelism *inside* the sweeper itself; parallel per-repo `git worktree list` invocations; pre-warming `node_modules` outside the per-session window so the cold path is cheap.
- **Test-only knob**: a deterministic preparing-window extension hook exists in `src/server/agent/session-setup.ts` for the regression E2E (`tests/e2e/ui/preparing-ux.spec.ts`). It is intentionally undocumented in user-facing material; do not surface it as a tuning option.

## Worktree setup hook not running

Symptoms: a freshly-claimed pool worktree has an empty `node_modules/`; the team lead's first `npm run check` / `npm test` fails with `Cannot find module ...`; staff agents wake without dependencies installed; multi-repo worktrees missing per-component artifacts.

Root cause class: a consumer reads the migrated-away top-level `worktree_setup_command` key from `project.yaml` instead of `components[*].worktreeSetupCommand`. Three call sites historically had this bug (`server.ts`, `staff-manager.ts`, `git.ts::readWorktreeSetupCommand`); they now route through `runComponentSetups()` from `src/server/skills/worktree-setup.ts`.

**Verify the fix is in place:**

1. Tail server logs for a pool fill and confirm the line `[worktree-pool] running setup for components: <names>` appears whenever at least one component declares `worktreeSetupCommand`. Absence of the log on a project that *should* have setup means the components resolver returned an empty list — check `projectConfigStore.getComponents()` is wired in `initWorktreePoolForProject`.
2. Confirm `components[*].worktree_setup_command` is set on the **right component** in `.bobbit/config/project.yaml`. The legacy top-level key is migrated by `state-migration/migrate-project-yaml.ts` and must not appear in current files. If you see both, the migration didn't run — delete the top-level key by hand or trigger the migration.
3. Run the regression-guard tests: `npm run test:unit -- worktree-pool` and `npm run test:unit -- worktree-setup-fallback`. The first greps `src/` for `.get("worktree_setup_command")` and fails if any file outside `migrate-project-yaml.ts` reads the legacy top-level key. The second fails if any caller passes a `setupCommand` argument to `createWorktree` / `createWorktreeSet` or references the deleted `setupWorktreeDeps` helper.
4. For staff: confirm `StaffManager.refreshWorktree()` calls `runComponentSetups()` on wake (non-sandboxed staff only). Sandboxed staff skip host-side refresh — setup runs inside the container via the same helper.
5. For session-setup fallback (pool empty, single-repo): `session-setup.ts::executeWorktreeAsync` calls `createWorktree` and then invokes `runComponentSetups()` against `projectConfigStore.getComponents()`, so each component's hook runs at `<wt>/<repo>/<relativePath>/`. If the wrong component's hook runs first, reorder them in `project.yaml`.
6. For single-repo goal worktrees on the non-pool fallback: `goal-manager.ts::setupWorktree` calls `runComponentSetups()` after `createWorktree` succeeds, mirroring the multi-repo branch. If the hook silently no-ops, confirm the call site has not been refactored back to a no-arg `createWorktree`.

Why this regressed silently before: the pool, staff, and session-setup all called `setupWorktreeDeps(undefined)` (or its equivalent) and that function's no-op-on-empty contract treated "undefined command" as "no setup configured" rather than "misconfigured caller". The legacy `setupCommand` parameter on `createWorktree` / `createWorktreeSet` and the `setupWorktreeDeps` helper have since been removed; `runComponentSetups()` from `src/server/skills/worktree-setup.ts` is now the only path. The loud log line and the two regression-guard unit tests make any recurrence visible. See [internals.md — Per-component `worktree_setup_command`](internals.md#session-worktrees) for the data flow.

## Worktree setup hook ran at wrong cwd

Symptom: `worktree_setup_command` runs but at the wrong directory — typically the worktree root instead of `<wt>/<component.repo>/<component.relativePath>/`. A `pwd > /tmp/setup-cwd` probe in the hook shows the branch container, and dependencies land in the wrong place (e.g. `node_modules/` at the worktree root for a component with `relative_path: app`).

Root cause class: a caller passes the hook through the legacy `setupCommand` parameter of `createWorktree` / `createWorktreeSet` (which used `worktreePath` as cwd and ignored `relativePath`) instead of routing through `runComponentSetups()` (which resolves cwd via `componentRoot()`).

**Verify and fix:**

1. The legacy `setupCommand` parameter and the `setupWorktreeDeps` helper have been removed from `src/server/skills/git.ts`. If a recent change reintroduced either, `tests/worktree-setup-fallback.test.ts` will fail — run `npm run test:unit -- worktree-setup-fallback`.
2. The only correct cwd resolver is `componentRoot()` inside `src/server/skills/worktree-setup.ts::runComponentSetups`. Every worktree-creation site (pool `_fill()`, staff wake refresh, both `goal-manager.ts::setupWorktree` branches, and `session-setup.ts::executeWorktreeAsync`) must call `runComponentSetups()` *after* `createWorktree` / `createWorktreeSet` returns — never as a `createWorktree` argument.
3. The two fallback paths historically affected were `session-setup.ts::executeWorktreeAsync` (single-repo non-pool) and `goal-manager.ts::setupWorktree` (single-repo non-pool); both now match the multi-repo path. If you see the symptom, the most likely cause is a fresh call site that bypassed `runComponentSetups()`.

See [internals.md — Per-component `worktree_setup_command`](internals.md#session-worktrees) for the full call-site table.

## Tool-guard extension ParseError (new sessions crash)

- Symptom: every new session for a role with at least one `never`-policy tool fails to start with a TypeScript `ParseError` from the generated tool-guard extension.
- Root cause: the generator in `src/server/agent/tool-guard-extension.ts` builds its extension source as a template literal. Using `\"` inside the outer backticks silently collapses to an empty string, producing broken output like `"" + toolName + ""`. Use single quotes for string literals emitted into the template; do not try to escape double quotes inside a backtick-wrapped generator.
- Regression guard: `tests/tool-guard-extension.test.ts` transpiles and dynamically imports the generated source across all four policy-input variants (allow-only, ask-only, never-only, mixed). Any parse-level quoting slip fails that spec.

## Leaked remote branches

Symptom: `origin` accumulates `session/*`, `goal/*`, `goal/<id8>/<role>-*` (team-member; legacy `goal-goal-*-<role>-*` from before the `pithier-te` rename), or `staff-*` branches that should have been cleaned up when their owning session/goal/staff was archived.

**Diagnose:**

```bash
# Count leaked branches by class.
git ls-remote origin | grep -E '^[a-f0-9]+\s+refs/heads/(session|goal|staff)' | wc -l
git ls-remote origin | grep -oE 'refs/heads/(session|goal|staff)[^[:space:]]*' | sort -u
```

**Checklist:**

1. Confirm `BOBBIT_TEST_NO_PUSH` is **unset** in the production env. Every push-delete is gated by `shouldSkipRemotePush()` in `src/server/skills/git.ts`; if the env var leaks into a real server (e.g. inherited from a test runner) all cleanup silently no-ops.
2. For per-role goal branches (`goal/<goalId8>/<role>-<short4>`, or legacy `goal-goal-<slug>-<id>-<role>-<short>` from before the `pithier-te` rename — the same cleanup path handles both because it consumes the branch names as opaque strings): verify the DELETE `/api/goals/:id` handler in `src/server/server.ts` snapshots `agentBranches` into a `string[]` **before** calling `teamManager.teardownTeam(id)`. Teardown's `dismissRole` mutates `entry.agents` in place — reading the entry afterwards sees an empty array.
3. For `session/*` branches: verify `session-manager.ts::terminateSession` invokes `eagerDeleteRemoteSessionBranch` from `src/server/agent/session-eager-branch-delete.ts` for non-delegate sessions. The helper requires the branch to be fully merged into `origin/<primary>` (via `git merge-base --is-ancestor`); unmerged branches defer to the 7-day `purgeOneSession` worktree cleanup.
4. For `staff-*` branches: `cleanupWorktree(..., deleteBranch=true)` in `skills/git.ts` already push-deletes. If a staff branch leaks, check that `staff-manager.ts` is actually calling `cleanupWorktree` with `deleteBranch=true` on dismiss.
5. Pre-existing backlog (predates the fix): drain with a one-shot script. Out of scope for the runtime cleanup contract.

Full design + bug archaeology in [docs/design/orphan-remote-branch-cleanup.md](design/orphan-remote-branch-cleanup.md). Architecture summary: [docs/internals.md — Remote branch cleanup](internals.md#remote-branch-cleanup).

## Agent directory settings

Symptom: Settings → Maintenance shows a saved pending directory, but sessions, auth, or model metadata still use the old path.

Checklist:

1. Check `GET /api/agent-dir`. `activePath` is the startup-pinned directory for this process; `nextStart.dir` is only effective after restart.
2. If `activeSource` is `BOBBIT_AGENT_DIR`, the env override wins over the persisted setting. Remove the env var and restart to use the saved path. `PI_CODING_AGENT_DIR` is not a Bobbit startup override.
3. If validation returns `INSIDE_WORKTREE`, choose a path outside the git worktree or use the exact default `<projectRoot>/.bobbit/agent/`. Relative paths are resolved against `<projectRoot>` before this check.
4. Settings **Copy data** copies only the allowlist from a configured active/historical source to the pending destination and skips existing files unless overwrite is selected. It does not auto-source `~/.pi/agent`; a skipped `auth.json` or `models.json` usually means the destination already had one.
5. Sandboxed sessions after an agent-dir change require container recreation because Docker bind mounts are immutable. `ProjectSandbox` detects stale active sessions/model mounts and recreates the project container; look for `[project-sandbox] ... stale agent-dir mounts` if a sandbox still sees old transcripts.

See [Configurable agent directory](configurable-agent-directory.md).

## AI Gateway publication leaves `models.json` unchanged

Symptom: configure, refresh, or startup discovers models but does not update the AIGW block, or reports that publication was refused.

Check `providers.aigw` in the active agent directory:

- Bobbit may insert an absent block or refresh one marked with `"x-bobbit-managed": {"kind":"aigw-publication","version":1}`.
- An unmarked block is user-owned, including historical generated-looking output. Bobbit does not adopt, rewrite, or remove it. While configured, `/api/models` uses Pi's exact composition of that target realm rather than bypassing it with discovery.
- Malformed JSONC, duplicate `providers`/`providers.aigw` keys, or duplicate managed fields is ambiguous and fails closed. The file and new preference remain unchanged.
- Valid JSONC comments and unknown fields are supported. Localized refresh edits only managed values and preserves unrelated bytes.

If the log instead reports an unreachable gateway, discovery failed before publication. Check `/api/models`, not only `/api/aigw/status`: the status route is a fresh live-discovery view and may report `models: []` without clearing the session catalog. `/api/models` may use a durable marked publication whose normalized URL matches the saved URL. When the target is absent or a marked target cannot supply rows, it may instead use the current process's last exact discovery snapshot for that unchanged URL; this fallback is in memory only and disappears on restart. An unmarked user target is composed by Pi and never bypassed, while malformed or ambiguous targets remain unavailable. A successful discovery, including an empty or fully filtered result, replaces the snapshot and never merges omitted rows back.

`BOBBIT_SKIP_AIGW_DISCOVERY=1` skips only startup discovery. It still applies Bedrock environment variables and leaves the current `models.json` active.

See [AI Gateway routing — Publication ownership](ai-gateway-routing.md#publication-ownership-caches-and-containers).

## Review/naming model mismatch under AI Gateway

Symptom: An AI Gateway is configured with `default.sessionModel` and `default.reviewModel` set to different models, but reviewer/QA sub-sessions run on the session model (or the naming path silently fails to generate a title).

Troubleshooting checklist:

1. Is `default.reviewModel` set in Settings → Models?
2. Does the pref resolve? Open Settings → Models; if the row shows a red "Unavailable" badge, the stored pref does not match any current `/api/models` entry. Click Clear and re-pick.
3. Does the Test button succeed for that row? Failure reveals whether the gateway rejects the model id (drift / wrong provider prefix).
4. If Test passes but reviewers still abort: check the goal dashboard gate verification output — `applyReviewModelOverrides` (`src/server/agent/review-model-override.ts`) logs at `console.error` with the pref, normalized id, and the mismatched model id the agent actually reports.
5. For naming-model issues under an AI Gateway: confirm the gateway exposes at least one Claude model (any tier); otherwise title generation falls back to direct `api.anthropic.com` (see `pickFallbackAigwNamingModel` in `title-generator.ts`).

## Role model override not applied

Symptom: a role has been customized with a `model` (and/or `thinkingLevel`) on the **Model** tab, but sessions running under that role still bind to `default.sessionModel` (or, for verification reviewers, to `default.reviewModel`).

Troubleshooting checklist:

1. **Role YAML actually has the field.** Open the role's YAML on disk (`.bobbit/config/roles/<name>.yaml`, or the project-scoped equivalent under the project's config directory) and confirm a line like `model: "anthropic/claude-opus-4-1"` is present. If the field is absent, the UI Save likely sent an empty string — which is intentionally omitted from YAML — and you'll need to re-pick a model and Save again.
2. **Cascade resolves what you expect.** A project-level role override replaces the *entire* server role record. If you set `model` only at the server level but a project-level YAML for the same role exists without `model`, the project record wins and the model is `undefined`. `GET /api/roles?projectId=<id>` shows the resolved role and its `origin` / `overrides` chain.
3. **`applyModelString` succeeded.** Model failures are loud: look for `[session-manager] Role model "..." failed for <sessionId>` (regular sessions) or `[verification] Role model "..." failed for <sessionId>` (reviewer/QA) in the gateway log. The same red "Unavailable" pill that Settings → Models shows applies here — click the per-row Test button on the role's Model tab to confirm the gateway exposes that model id.
4. **Per-session override didn't win.** If a user picked a model in the composer for that session, or if a programmatic caller passed `skipAutoModel: true` (e.g. delegate sessions with an explicit model arg), the role layer is intentionally bypassed. Check `RemoteAgent.setModel` calls in the session log and the `skipAutoModel` flag on the originating dispatch.
5. **Reviewer/QA steps only:** confirm the verification harness has the `configCascade` wired in. Without it, the harness falls back to `roleStore.get(role.name)` which sees only server-level overrides — a project-level role override would silently be ignored. This is a wiring bug at the `VerificationHarness` constructor site, not a role-config bug.
6. **Thinking level mismatch is non-fatal.** Unlike model failures, an unsupported `thinkingLevel` only logs a `console.warn` and falls through to the global default. If thinking is not being applied, grep the log for `Role thinking level "..." failed`.
7. **Spawned worker / team-lead / staff session ignores the role override entirely** (binds straight to `default.sessionModel`, no "Role model ... failed" log line — the resolver never even sees the role id). `SessionSetupPlan` carries two parallel fields naming the same role: `role` (used historically) and `roleName` (used by `team-manager.spawnRole`, `startTeam` for the team lead, and `staff-manager`). `_resolveBridgeOptions` in `src/server/agent/session-setup.ts` falls back to `plan.role ?? plan.roleName` so callers that set only one of them still get role-keyed pinning; the same fallback mirrors onto `session.role` so the post-spawn `tryAutoSelectModel` safety net keys off the right id. If you see this symptom on a new spawn path, the most likely cause is a caller that sets neither field — add `roleName` at the call site rather than re-introducing the fallback elsewhere. Pinned by `tests/session-setup-role-override.test.ts`.

For current behavior, see [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides), [Thinking-level metadata authority](thinking-levels.md#metadata-authority), and [Spawn-time model pinning](internals.md#spawn-time-model-pinning). The [original per-role override design](design/per-role-model-overrides.md) is historical background only, not current mechanics.

## Reviewer session triggers spurious "Agent finished" team-lead nudge after restart

Symptom: the team lead session receives `team_agent_finished` / "Agent ... has finished" steers naming an `llm-review-*` (or QA) sub-session. Reviewer sessions are owned by the verification harness and must never nudge the team lead — every such steer is a bug. The symptom is **restart-specific**: it does not appear during the normal in-process verification run.

Root cause: `TeamManager.registerReviewerSession()` persists the reviewer into `entry.agents` (in `team-state.json`) so that mid-verification restarts can recover the link between gate step and session. Pre-fix there was no field distinguishing reviewer agents from worker agents on the persisted record. After restart, `resubscribeTeamEvents()` walked `entry.agents` and re-attached the `agent_end → notifyTeamLead()` listener to every entry, including reviewers. The live (pre-restart) code path subscribes only to `tool_execution_end`, so the bug is invisible until the server is bounced mid-verification.

Fix: a `kind: "worker" | "reviewer"` discriminator on `TeamAgent` and `PersistedTeamEntry`.

- `registerReviewerSession()` writes `kind: "reviewer"`; regular `dispatchToRole`/spawn paths write `kind: "worker"`.
- `resubscribeTeamEvents()` skips agents with `kind === "reviewer"` (or, defensively, `role === "reviewer"`).
- `notifyTeamLead()` has the same defensive guard so even a stray subscription cannot fire.
- Older `team-state.json` entries written before the field existed default to `"worker"` on load; the `role === "reviewer"` fallback in both guard sites catches reviewers whose `kind` did not survive the persisted-shape migration.

Diagnose:

1. Confirm the team lead session is the recipient (the steer text is `"Agent <id> has finished"`).
2. Look up the named sub-session — if its id starts with `llm-review-` or it appears under a gate's `sessionId`, it is reviewer-owned and the steer should never have been delivered.
3. Inspect `<stateDir>/team-state.json`: every reviewer entry must have `kind: "reviewer"`. If it shows `kind: "worker"` (or no `kind` at all) for a reviewer, the registration path skipped the discriminator — check `registerReviewerSession()` was the entry point, not a generic `addAgent`.
4. Restart the server and replay: pre-fix the steer fires within milliseconds of the agent's `agent_end`; post-fix it never fires.

Key files: `src/server/agent/team-manager.ts` (`registerReviewerSession`, `resubscribeTeamEvents`, `notifyTeamLead`), `src/server/agent/team-store.ts` (`PersistedTeamEntry.agents[].kind`). Regression test: `tests/team-manager-reviewer-resume.test.ts`. See [docs/internals.md — Reviewer kind & restart resume](internals.md#reviewer-kind--restart-resume).

## Resumed reviewer terminated ~46ms after server restart, before reminder is acted on

Symptom: after a server restart mid-verification, one or more reviewer steps fail with `"Agent did not call verification_result after server restart and reminder."` Inspecting the gate signal shows the reviewer session was archived within tens of milliseconds of `lastActivity`, far too fast for the agent to have read and replied to the reminder prompt.

Root cause: the resume path dispatches a reminder prompt and races the resulting `verification_result` against `SessionManager.waitForIdle(sessionId, ...)`. `waitForIdle` resolves **synchronously** when `session.status === "idle"`. After a restart the resumed session is idle by definition; `rpcClient.prompt()` is fire-and-forget on the RPC channel and does not transition the session to `streaming` synchronously. So the race resolved as `idle` instantly, the harness declared failure, and the `finally` block terminated the session before the agent ever saw the reminder.

The live (non-resume) reviewer path had the same code shape but was not affected in practice because the kickoff prompt had already pushed the session into `streaming` long before the race began.

Fix: a sibling helper `SessionManager.waitForStreaming(sessionId, timeoutMs = 10_000)` mirrors `waitForIdle` but resolves on `agent_start` (or rejects on `process_exit` / timeout). Every reminder site now awaits `waitForStreaming(...).catch(() => {})` between the prompt dispatch and the existing `waitForIdle` race. A 10s window is generous — a healthy agent acknowledges within ~100ms — and on timeout the code falls through to the original `waitForIdle` race, so a genuinely unresponsive agent still fails as before.

The four reminder sites (all in `src/server/agent/verification-harness.ts`):

1. `_tryResumeFromSession` — restart-resume reminder. The original repro.
2. `runLlmReviewViaSession` — live llm-review reminder; symmetric for consistency, even though the bug is not reachable via the kickoff race.
3. QA-tester reminder.
4. Legacy direct-`RpcBridge` reminder (no `SessionManager` available — uses an inline `agent_start` listener with the same 10s timeout shape).

If you add a fifth reminder site, you must apply the same pre-race wait or you will reintroduce the bug.

Diagnose:

1. Compare the reviewer session's `lastActivity` and archive timestamp in the session log. A delta under ~1s for a step that failed with the reminder error string is the fingerprint.
2. Confirm the build includes `waitForStreaming` — grep `src/server/agent/session-manager.ts` for the symbol.
3. Confirm all four reminder sites await it. The regression-guard test (`tests2/core/verification-reminder-race.test.ts`) mocks a session that flips from idle to streaming after 50ms and asserts `_tryResumeFromSession` does not terminate within the first second.

Key files: `src/server/agent/session-manager.ts` (`waitForStreaming`), `src/server/agent/verification-harness.ts` (the four reminder sites). Tests: `tests2/core/verification-reminder-race.test.ts`, API E2E `tests/e2e/gate-verification-resume.spec.ts`. See [docs/internals.md — Reminder race after restart-resume](internals.md#reminder-race-after-restart-resume).

## Reviewer transcript "resets" / verdict lost / reviewer SIGTERM storm during `llm-review` retries

Symptom: while an `llm-review` gate is verifying, the reviewer's displayed name suddenly changes (a fresh `generateTeamName`) while its `/session/<id>` URL stays the same — ~10 minutes of review work (sometimes a completed pass) is gone. Related reports: "I saw a pass but it never materialised at the server level" (verdict lost) and repeated `Agent process exited (signal SIGTERM)` across reviewer ids (SIGTERM storm).

Three distinct bugs, all in the reviewer session lifecycle:

1. **Transcript reset** — the bounded step-retry loop reused one pre-generated `stepSessionId` across every attempt, and `createSession` keys sessions by id, so a retry built a new agent in place and overwrote the prior transcript. Fix: mint a **fresh** `llm-review-<uuid>` per from-scratch attempt; only attempt 1 keeps the broadcast id. A `createSession` guard (`[session-manager][session-id-clobber]`) now refuses to clobber a live session id unless `allowSessionReuse` (resume path) is set.
2. **Verdict lost (404 drop)** — teardown deleted the pending resolver *before* terminating the session, so a `verification_result` POST landing during teardown hit an empty `pendingResults` map and was 404-dropped. Fix: terminate first, delete resolver second, and a `capturingResolver` honors a late verdict (`hardFailureNoResult` + `capturedVerdict`) instead of dropping it.
3. **Premature SIGTERM** — a single under-graced reminder terminated a reviewer that had finished its review but not yet emitted the tool call. Fix: up to `MAX_REVIEWER_REMINDERS` in-session nudges, each with a fair `waitForStreaming` + late-verdict settle window.

Diagnose: grep the gateway log for `[verification][reviewer-lifecycle]` (attempt/retry lineage, reminder count, termination reason, POST accept vs 404-drop) and `[session-manager][session-id-clobber]`.

**Red herring:** the reported log opens with a boot sequence and repeats `read ECONNRESET — gateway likely restarting`. Under `npm run dev:harness` this is usually the **vite dev-proxy** logging a transient disconnect during HMR/reconnect, *not* an actual gateway crash-loop; it does not by itself indicate the reviewer bugs above. Confirm a real restart via the gateway's own `[boot]` lines and process lifetime before blaming restart-resume. If a genuine crash-loop is present, each restart re-drives cold reviewers via `resumeInterruptedVerifications` — see the two entries above.

Key files: `src/server/agent/verification-harness.ts` (`runLlmReviewViaSession`, bounded retry loop in `verifyGateSignal`), `src/server/agent/session-manager.ts` (`createSession` clobber guard). Tests: `tests2/core/verification-harness-review-reliability.test.ts`, `tests2/core/session-id-clobber-guard.test.ts`. Full detail: [docs/llm-review-recovery.md — Reviewer session lifecycle](llm-review-recovery.md#session-lifecycle-and-transcript-preservation).

## MCP server unavailable / partial outage

Failed MCP servers stay in `error` state but don't break the agent. Look for the stub meta extension at `<stateDir>/mcp-extensions/[<hash>/]<server>.ts` whose `execute` returns `MCP server '<name>' is unavailable: <reason>`. Per-call timeouts: 10 s on `tools/list`, 30 s on `tools/call` (constants in `src/server/mcp/mcp-manager.ts`). Schema-validation drops malformed ops via `isValidOperationSchema` from `src/server/mcp/mcp-meta.ts` — sibling ops on the same server stay usable.

## MCP per-op `never` policy not enforced

Two-layer enforcement:
- **Layer A (model-facing)**: meta-tool aggregation collapses N×M ops into one `mcp_<server>` tool, so per-op grants flow through `mcpPolicyPrefix` regex which matches BOTH `mcp__pw__snap` and `mcp_pw`.
- **Layer B (server-side)**: `POST /api/internal/mcp-call` calls `resolveGrantPolicy(tool, …)` before `mcpManager.callTool` and returns 403 on `never`.

If a per-op policy isn't taking effect, check both layers.

## MCP server dropdown reads "Allow (default)" but agent is denied

Historical bug, fixed on `master`. `defaults/tool-group-policies.yaml` used to ship `mcp__playwright: never` and `mcp__nano-banana: never` as builtin denials. The Tools page can't render cascade origin, so the dropdown showed "Allow (default)" while the guard actually blocked every call. Removed in commit `5e633d40` ("MCP policy parity: drop builtin denials so default is allow"). MCP groups now default to `allow` like every other tool group — see [internals.md — MCP groups default to `allow`](internals.md#mcp-groups-default-to-allow).

If you still see this on an old build, upgrade — or check `.bobbit/config/tool-group-policies.yaml` for an explicit user override that shadows the (now-empty) builtin layer. Per-role denials (e.g. `qa-tester` blocking `mcp__playwright`) are intentional and live in role YAML, not group policy.

## Tools page "MCP" section missing or empty

`GET /api/mcp-servers` returns the structured list (`{name,status,toolCount,tools[]}`). `src/app/tool-manager-page.ts::renderMcpSection()` filters them out of normal group rendering and shows one row per server in a dedicated MCP section. Empty section means `getMcpManager()` returned no configs — check the `discoverServers()` cascade in `src/server/mcp/mcp-manager.ts`.

## MCP group changed from `never`, but refreshed agent still cannot use it

`Refresh agent` should recompute normal role-derived allowed tools from the current role/group/MCP policy cascade. If the `mcp_<server>` meta-tool is still absent after changing `mcp__<server>` from `never` to `ask` or `allow`, check `SessionManager.recomputeAllowedToolsForRestart()` and `restoreSession()` in `src/server/agent/session-manager.ts`: normal sessions must not carry the stale live `session.allowedTools` cache as `_overrideAllowedTools`. Persisted session allow-lists, `session-only` grants, and unconsumed `one-time` grants are the exceptions. Regression coverage: `tests/e2e/mcp-tool-permission.spec.ts`.

If the meta-tool remains blocked only for one role, inspect that role's `toolPolicies`. Role-level `mcp__<server>: never` intentionally wins over group defaults.

## Auto-nudge flooding

Symptom: team-lead receives many `team_agent_finished` steers in quick succession. Cause: missing dedup. The `nudgePending` guard in `TeamManager` coalesces concurrent nudges into one delivery; if a regression removes it, a flood returns. Reviewer / QA sub-sessions are additionally filtered by `kind: "reviewer"` in `resubscribeTeamEvents()` and `notifyTeamLead()` — they must never nudge the team lead.

## Auto-nudge cadence never escapes base delay

Symptom: an unattended team-lead session receives idle nudges roughly every 5 or 10 minutes overnight, regardless of the documented 12h exponential-backoff cap.

Cause: pre-fix `TeamManager.subscribeTeamLeadEvents` treated every `agent_start` on the lead's RPC client as "the lead did something productive" and reset the backoff counter. But `agent_start` also fires when the lead is replying to its own auto-nudge — so the counter reset on every cycle and the exponential ceiling was dead code.

Fix: prompts now carry a `PromptSource` (declared in `src/server/agent/session-manager.ts`, persisted as `SessionInfo.lastPromptSource`). Only `"user"` / `"system"` sources reset `idleNudgeCount` / `noWorkersNudgeCount` on the next `agent_start`; `"auto-nudge"` / `"task-notification"` / `"verification"` preserve them so `scheduleWorkersNudge` / `scheduleNoWorkersNudge` keep stepping up. See [docs/design/notification-policy.md — Team-lead idle-nudge backoff](design/notification-policy.md#9-team-lead-idle-nudge-backoff) for the full mechanism. Pinning test: `tests/team-manager-idle-nudge-backoff.test.ts`.

## `bash_bg wait` not interrupted by steer

A browser, REST, tool, or automatic steer aborts an in-flight `bash_bg wait` only immediately before its actual Pi RPC. The background process is **not** killed; only the wait call resolves with `{ aborted: true }`. A steer fenced behind compaction, Stop, replacement, or `agent_settled` does not interrupt the wait. Diagnose:
1. The source-identified steer reaches `SessionManager.deliverLiveSteer()` / `_dispatchSteer()`, which invokes `bgProcessManager.abortAllWaits(sessionId)` immediately before `rpcClient.steer()`.
2. The wait registry on `BgProcessManager` — `registerWait`/`unregisterWait` from `/bg-processes/:pid/wait`; `abortAllWaits()` iterates the set.
3. `terminateSession` also calls `abortAllWaits()` before `cleanup()` so terminating sessions never leak hung wait handlers.

Wait interruption is neither Pi receipt nor settlement; correlate the occurrence with its Pi row and sidecar before treating it as delivered. Tests: `tests/bg-process-manager.test.ts`, `tests/e2e/bg-wait-steer-abort.spec.ts`.

## `bash_bg wait` returns `fetch failed` on long-running processes

- **Symptom**: an agent calls `bash_bg wait` on a background process that runs for ≥~300 s and the tool throws `Error: fetch failed` (an undici `TypeError`) instead of returning an exit result or `{ timedOut: true }`. The errored tool result corrupts the agent turn and the UI can behave erratically afterwards. Monitoring the same process via `bash_bg logs` (short fetches) never fails — only the `wait` long-poll holds one connection open long enough to trip.
- **Cause**: the bg-process wait endpoint `GET /api/sessions/:id/bg-processes/:pid/wait` (`src/server/server.ts`) used to write **no bytes** to the socket until `BgProcessManager.waitForExit` resolved. The HTTP client (undici, in `defaults/tools/shell/extension.ts::api()`) enforces a default `headersTimeout` of ~300 s; with no head flushed before that elapsed it aborted the request and the tool saw `fetch failed`. The default wait timeout is also 300 s, so the collision is deterministic at the 300 s boundary — the bug only fires once a process runs ~300 s **and** is monitored via `wait`. Latent since the bg-wait endpoint shipped (it never inherited the heartbeat the session `/wait` endpoint already had); not a recent regression.
- **Fix**: the response logic was extracted into `src/server/agent/bg-wait-response.ts::streamBgWaitResponse`, which mirrors the session `/wait` endpoint — it flushes a `Transfer-Encoding: chunked` 200 head and writes a heartbeat `\n` on each `heartbeatMs` tick (default 60 s) while the wait is pending, then `res.end(JSON.stringify(result))`. The heartbeat keeps the connection alive well inside undici's ~300 s timeout, so the long-poll survives the full configurable wait timeout. Header flush is **lazy** (driven by the first 60 s tick) so a genuine `404` for an unknown pid — where `waitForExit` returns `null` synchronously before any tick — is preserved.
- **Where to look**: `streamBgWaitResponse` (the fix site) and the `/bg-processes/:pid/wait` handler in `server.ts`; the heartbeat pattern it mirrors is the session `/wait` endpoint (also `server.ts`). See [docs/internals.md — Long-poll heartbeat (chunked keep-alive)](internals.md#long-poll-heartbeat-chunked-keep-alive).
- **Regression test**: `tests/bg-wait-response.test.ts` — drives `streamBgWaitResponse` with a tiny injected `heartbeatMs` and asserts the head flushes, a heartbeat byte is written on tick, the terminal JSON payload still parses, and the unknown-pid path still emits a real `404`. It pins the *mechanism* in milliseconds — there is deliberately no wall-clock-bound test that waits near 300 s.

## Streaming dedup / reorder (events carry seq+ts)

Events carry `seq`+`ts`; on reconnect the client sends `{type:"resume", fromSeq}`. See [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md) for the protocol and dedup ring.

## WS overflow guard

`decideOverflowAction` in `src/server/ws/ws-overflow-guard.ts` decides drop / coalesce / disconnect when the per-session WS write buffer is over budget. Transient spikes are tolerated via a deferred re-check before disconnecting.

## Continue-Archived button missing

Only renders when (a) the session is archived, (b) it has no `goalId`, (c) it has no `delegateOf`, AND (d) the project is still registered. If the button is absent, check those four predicates against the session record.

## Continued session missing earlier transcript

`POST /api/sessions/:archivedId/continue` clones the source `.jsonl` losslessly. If the new session is missing earlier history, confirm the cloned `.jsonl` actually exists at the new `agentSessionFile` path. Worktree-backed sources are rebased onto the worktree-cwd slug-dir in `executeWorktreeAsync` — a missing rebase is the usual cause.

## Stale draft resurrection

`SessionStore.setDraft()` rejects writes with an older `gen` than the latest persisted draft. If a stale draft seems to revive after a newer save, check the `gen` monotonicity in the store.

## Proposal panel empty after reload

`proposal_update` events that arrive before the proposal panel UI binds its handler are buffered in `_bufferedProposalEvents` inside `src/app/remote-agent.ts` (getter/setter on the handler property). Rehydrate-on-attach can race ahead of UI wiring; the buffer is the entry point for diagnosis.

## Inline-comment annotations on goal/role/staff proposals

Ephemeral in-memory backend `proposalBackend` in `src/ui/components/review/proposal-annotations.ts`, keyed by `(sessionId, "proposal:<type>")`. Cleared by:
- `proposal_update` body-diff hook in `src/app/session-manager.ts` (`extractProposalBody` + `clearProposalAnnotations`).
- Dismiss / `proposal_cleared`.
- Reload (never persisted).

The `commentable: true` flag on `GoalFormConfig` is set ONLY at the goal-proposal-panel call site (`goalPreviewPanel()`), not the goal-dashboard reuse, so dashboard markdown stays read-only.

## "Send feedback" button missing on a proposal panel

Only renders when annotation count > 0 AND the proposal is not streaming (`isProposalStreaming("<tag>_proposal")` false). Badge has the same gating in Preview mode.

## "Open proposal" on old card destroys later edits

Each `propose_*` tool result carries a `__proposal_rev_v1__:<n>` marker. Clicking "Open proposal" on a stale card with a lower revision intentionally falls back to legacy archived-session behaviour rather than overwriting the live draft. If you see destruction of later edits, check the marker is being parsed.

## Proposal panel doesn't update after `edit_proposal`

Check the WS `proposal_update` frame fired by the `edit_proposal` handler and the structured error code (`not_found`, `no_match`, `multiple_matches`, `empty_replacement`). A failed `edit_proposal` does NOT mutate the on-disk draft. For the **goal-assistant** panel specifically (where `edit_proposal type=goal` updated the slot but left the panel stale), see [Goal-assistant proposal panel shows stale content after revision / never appears off-screen](#goal-assistant-proposal-panel-shows-stale-content-after-revision--never-appears-off-screen) — that is a form-mirror gap, not a missing frame.

## Image generation failure

`POST /api/image-generation/generate` returns `400` for malformed input and `500 { error }` for provider-side failures. It must never return `502` or `503` — those indicate a regression in the route handler.

## Goal `prUrl` removed

**Symptom:** an agent or external script PUTs `{prUrl: "..."}` to `/api/goals/:id` and the field doesn't appear on the next `GET`.

**Resolution:** `Goal.prUrl` remains removed, and `PUT /api/goals/:id` returns `400` naming `prUrl`; callers must omit it. Live goal, session, and sidebar PR status is owned by the [remote-state coordinator](remote-state-coordinator.md). Read live goal status from `GET /api/goals/:id/pr-status` using the [snapshot envelope and absence semantics](rest-api.md#coordinated-remote-state-status), not directly from the durable cache.

**Re-attempt context missing PR URL:** a successful goal-associated PR snapshot is projected into `PrStatusStore` (`src/server/agent/pr-status-store.ts`) so historical and re-attempt contexts retain the last-known URL across restarts. `buildReattemptContext(goal, prStatusStore)` in `src/server/agent/goal-assistant.ts` reads `prStatusStore.get(goal.id)?.url`. If the `**PR URL:**` line is absent, check that `<stateDir>/pr-status-cache.json` has an entry for the original goal id; do not treat the store as live freshness authority.

The team-lead role no longer PUTs `prUrl` after `gh pr create` (the curl-PUT step was removed from `defaults/roles/team-lead.yaml`). Live surfaces consume coordinator snapshots; `PrStatusStore` remains the durable compatibility projection for historical and re-attempt use.

## Header toast vs proposal toast testid collision

The session-header toast (e.g. "Link copied" from the Copy-link button) uses `showHeaderToast()` and `data-testid="header-toast"`. The proposal-panel toast uses `showProposalToast()` and `data-testid="proposal-toast"`. Launcher progress uses a third, **persistent** surface (`data-testid="launcher-feedback"`, driven by the `bobbit-launcher-feedback` event) that reuses `.review-toast` layout but must NOT auto-fade — `pending` persists until the launch resolves and `error` persists until the user clicks `data-testid="launcher-feedback-dismiss"`. All three are separate state slots / `<div class="review-toast">` instances in `src/app/render.ts` — do NOT collapse them onto a shared testid; E2E selectors in `tests/e2e/ui/copy-session-link.spec.ts` and `tests/e2e/ui/proposal-inline-comments.spec.ts` (plus the launcher-feedback specs) would alias. See [docs/extension-host-authoring.md § launcher feedback](extension-host-authoring.md) for the three-kind contract.

## Transcript access errors

Cross-project reads are allowed for `read_session`, `GET /api/sessions/:id/transcript`, and `GET /api/sessions/:id/transcript/before-compaction` when the authenticated caller can reach the target session on the same gateway; the `x-bobbit-session-id` header no longer gates transcript access by matching `projectId`. Structured transcript-reader errors are `session_not_found`, `transcript_unavailable`, `invalid_regex`, and `invalid_params`; before-compaction history also has `compaction_not_found` and may surface `internal_error`. Files: `src/server/agent/transcript-reader.ts`, `defaults/tools/agent/read_session.yaml` + `extension.ts`.

## Mobile annotation popover doesn't open after tapping "Add comment"

`_onMobileAddComment` in `src/ui/components/review/ReviewDocument.ts` must set `_popoverReferenceRect` from the current selection range before mounting the bottom-sheet popover; the `updated()` reaction keys off that field. Symptom after the singleton refactor was an empty render because the rect stayed `null`.

## Tier 2.5 report missing / ffmpeg failed

The HTML video-capture report is only emitted when `RECORDSCREEN=1`. If ffmpeg is missing, set `FFMPEG_PATH` or install ffmpeg system-wide. See [docs/testing-tier-2-5.md](testing-tier-2-5.md).

## OAuth callback never completes

If the popup window closes without the UI advancing, poll `GET /api/oauth/flow-status?flowId=&provider=` directly to see whether the server received the callback. Files: `src/server/auth/oauth.ts`; REST: `/api/oauth/*`.

## Agent silently substitutes file tools when prompted for bash / web / MCP

- **Symptom**: the agent is asked to run a `bash` command, a Bobbit extension tool (`web_fetch`, `bash_bg`, `team_delegate`, …), or an MCP meta-tool (`mcp_describe`, …) and instead reaches for `write` / `read` / `edit` to fake the same visible side-effect. No error surfaces; the UI shows file-tool cards rather than the requested tool. Most often appears immediately after a `@earendil-works/pi-*` upgrade.
- **Root cause in one line**: pi's `--tools <list>` allowlist semantics drifted across an upgrade (0.70+ began treating the list as an allowlist over both builtins **and** extensions), so the allowlist silently stripped every Bobbit extension and MCP-backed tool from the agent's available set. The LLM then substituted whichever still-allowlisted file builtin could approximate the request.
- **Fix already landed**: commit `fdfee7c5` switched the activation contract to `--no-builtin-tools` + `--no-extensions` + an explicit `--extension <…>/defaults/tools/_builtins/extension.ts` re-register shim, with `env.BOBBIT_BUILTIN_TOOLS` carrying the sorted list of pi file-builtins to re-register. `computeToolActivationArgs()` in `src/server/agent/tool-activation.ts` is the single source of truth.
- **Diagnostic order**:
  1. Run `npm run test:unit` and look at `tests/tool-activation-contract.test.ts`. If it fails, the flag contract has regressed at unit speed — fix `computeToolActivationArgs()` before anything else.
  2. If the unit pin is green but real agents still substitute, run `npm run test:manual` against `tests/manual-integration/agent-tool-use.spec.ts`. The seven scenarios cover pi builtins, a Bobbit extension (`web_fetch`), and an MCP meta-tool (`mcp_describe`); a failing scenario tells you exactly which tool category is being stripped.
  3. In the failing scenario, inspect the rendered tool cards: every wrapper carries `data-tool-name="<name>"`. If the named tool's card is missing while a file-tool card with the same sentinel text is present, that is the substitution signature.
- **If the symptom returns after another pi bump**: adapt Bobbit's activation contract to whatever the new pi line expects — do **not** relax either canary. See [testing-coverage.md — Agent tool-use canary](testing-coverage.md#agent-tool-use-canary-two-layers).

## Pi OAuth adapter breaks after a Pi upgrade

- **Symptom**: `npm run check` reports missing OAuth runtime exports, or an Anthropic/OpenAI Codex OAuth start route fails or never advances after a Pi upgrade.
- **Root cause**: `@earendil-works/pi-ai/oauth` is type-only; the old provider lookup and callback constants are not a runtime contract. Anthropic and Codex both use Pi's public models service and `AuthInteraction`. Anthropic additionally delegates its maintained authorization URL, scopes, loopback callback/state validation, token exchange, and refresh lifecycle to Pi rather than retaining a Bobbit PKCE implementation.
- **Rule**: use `builtinModels()` from `@earendil-works/pi-ai/providers/all`, import `AuthInteraction` and credential types from the server-safe Pi root, and call `models.login(provider, "oauth", interaction)` through `src/server/auth/oauth.ts::oauthStartPi`. Anthropic constructs Pi models with Bobbit's Pi-compatible credential-store adapter; Codex keeps its returned-credential persistence path. Map `auth_url` and device-code notifications to the one-shot `{ url, instructions }` response, manual prompts to the pending-code promise, and selection prompts as described below.
- **Security invariant**: retain flow expiry, provider checks, cancellation, and `callbackServer: true`. Anthropic cancellation must retain its callback-port lease while Pi is exchanging a submitted code, then remove only a credential written by that cancelled flow. Credential writes use the locked adapter and cache invalidation. Redact progress, device instructions, and failures before logging; never log raw codes, credentials, or provider payloads.
- **Reference**: [Anthropic OAuth](anthropic-oauth.md) and [Pi runtime compatibility — OpenAI Codex OAuth migration](pi-runtime-compatibility.md#openai-codex-oauth-migration).
- **Pinning tests**: `tests2/core/anthropic-oauth-adapter.test.ts` covers Pi's Anthropic contract, cancellation, contention, and redaction. `tests2/core/oauth-external-callbacks.test.ts` covers Codex interaction mapping, credential persistence, cancellation, and log redaction.

## OpenAI Codex OAuth login returns 500 / "OAuth provider requested a selection Bobbit does not support yet"

- **Symptom**: initiating OpenAI Codex login fails because the Pi `AuthInteraction` asks Bobbit to select between browser and device-code login.
- **Cause**: Bobbit has no generic OAuth selection UI, while the Codex flow can present more than one login method.
- **Fix/behaviour**: the `AuthInteraction.prompt` handler in `src/server/auth/oauth.ts::oauthStartPi` is deterministic: (1) auto-pick a sole option; (2) for multiple options, prefer the exact option id `browser`; (3) fall back to a case-insensitive `browser` match in the option id or label; (4) reject any unrecognised multi-option prompt loudly. Do not depend on a Pi callback constant, and never auto-select device code. Browser login and text/manual-code prompts continue through Bobbit's callback-server and code-submission flow.
- **Pinning test**: `tests2/core/oauth-external-callbacks.test.ts` asserts exact-id and heuristic browser preference, single-option selection, and explicit rejection of unsupported prompts.

## 60+ TSchema errors / typebox flavor mismatch after pi upgrade

- **Symptom**: after bumping `@earendil-works/pi-ai` (or any `@earendil-works/pi-*` package that re-exports schema helpers), `npm run check` floods with structurally-incompatible-type errors against `TSchema`, `TObject`, `TProperties`, `Static<...>`, etc. Errors typically point at a file that mixes `Type.Object(...)` / `Static<typeof X>` with a pi-ai-returning helper like `StringEnum` or a tool whose `parameters` schema is consumed by pi-ai.
- **Root cause**: pi-ai 0.73+ re-exports `Type` and `Static` from typebox **v1**. Bobbit also has a direct dependency on `@sinclair/typebox` v0.34. The two packages publish structurally-different `TSchema` types, so a value built with `@sinclair/typebox`'s `Type.Object(...)` is no longer assignable to a slot that pi-ai expects to be a v1 `TObject`, even though the runtime JSON shape is identical.
- **Rule**: in any file that combines pi-ai schema helpers (or hands a schema to a pi-ai-typed slot) with `Type.Object(...)` / `Static<typeof X>`, use one typebox flavor consistently. Server-side pi interop can import the schema helpers from `@earendil-works/pi-ai`; browser runtime paths should prefer direct `typebox` imports plus pi-ai type-only imports so the bare pi-ai index stays out of UI chunks.
- **Reference**: `src/ui/tools/artifacts/artifacts.ts` is the browser-side example — runtime schema helpers come from `typebox` / local helpers, while `Static` and `ToolCall` stay type-only from pi-ai.
- **Diagnosis tip**: if the error count is large (dozens to hundreds) and all variants of `TSchema is not assignable to TSchema` originate from the same module, you're looking at a flavor mismatch, not a real type bug. Pick one schema flavor in that file and re-run `npm run check` before changing any schema definitions.

## Browser build fails or pulls Node shims after Pi 0.81.1 import changes

- **Symptom**: Vite warns about `node:fs` / Node shims from UI code, or `npm run check` / browser tests fail after changing `src/app/pi-ai-lazy.ts` imports during a Pi upgrade.
- **Rule**: browser runtime code must not import runtime values from the bare `@earendil-works/pi-ai` package. With Pi `0.81.1`, first-message streaming imports belong under package-exported `@earendil-works/pi-ai/api/*` subpaths, while provider catalog/key-test flows stay behind `/api/pi-ai/*` server routes. Erased root type imports remain safe.
- **Pinning test**: `tests2/core/pi-ai-browser-boundary.test.ts`. See [Pi runtime compatibility](pi-runtime-compatibility.md#browser-safe-pi-ai-boundary).

## Session goes idle or drains queued prompts during Pi internal retry

- **Symptom**: after a transient provider failure, the session briefly becomes idle, queued prompts dispatch early, or one-time tool grants are revoked while Pi is still retrying the same turn.
- **Cause**: Pi `0.81.1` emits retryable `agent_end` events with `willRetry: true`; those are not final turn boundaries.
- **Fix**: `SessionManager` must ignore `agent_end.willRetry === true` for idle transition, queue drain, one-time grant revocation, and `waitForIdle()` resolution. Only the final non-retry `agent_end` completes the Bobbit turn.
- **Pinning test**: `tests2/core/pi-rpc-agent-end-retry.test.ts`. See [Pi runtime compatibility](pi-runtime-compatibility.md#retry-and-lifecycle-boundaries).

## Bundle-size assertion fails

`tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json` to find the entry chunk and enforces three budgets: entry ≤ 250 kB gzipped, any non-worker chunk ≤ 200 kB gzipped, and no non-worker chunk > 600 kB raw (the raw guard pins Vite's `chunkSizeWarningLimit: 600`). Ensure `dist/ui/.vite/manifest.json` exists (`npm run build:ui` first — the test is skipped when `dist/ui` is absent); sizes are read directly from `dist/ui/assets/`. The `pdf.worker.min-*.mjs` chunk is whitelisted. Run the build-then-assert in one shot with `npm run test:bundle`. **Raw-guard regression?** The usual cause is the app-shell SCC or an eager seam such as `app-review` growing back past 600 kB raw — split stable app seams or cycle-free leaf modules into named eager chunks via `manualChunks` rather than raising the budget. Profile with [docs/perf/bundle-profile.md](perf/bundle-profile.md); see the bundle-shrink history in [docs/design/ui-bundle-size-reduction.md](design/ui-bundle-size-reduction.md) → [shrink-initial-bundle.md](design/shrink-initial-bundle.md) → [shrink-main-ui-manualchunks.md](design/shrink-main-ui-manualchunks.md).

## `detectPrimaryBranch` warnings in E2E output

- **Symptom**: E2E output repeatedly prints `[git] detectPrimaryBranch(...): could not detect primary branch; defaulting to "master"` for intentionally minimal temp repos, non-git temp roots, or temp worktree paths with no origin/primary refs.
- **Expected behavior**: those test-shaped fallback paths are quiet and return `"master"`; origin-backed repos with enough remote/config evidence still warn once per cwd so production misconfiguration remains visible.
- **Pinning test**: `tests/clean-build-warnings-regression.test.ts` covers quiet minimal/temp fallback paths and the once-only origin-backed diagnostic.

## Markdown not rendering in chat / proposal panel

`<markdown-block>` is lazy-loaded via `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts`. Any consumer that emits `<markdown-block>` must call it in `connectedCallback()`, the constructor, or first `render()`. Symptom of forgetting: markdown shows as raw text until something else triggers the load. Lit upgrades the custom element asynchronously when the chunk lands. Do not import upstream MarkdownBlock directly; the helper loads Bobbit's safe renderer. See [internals.md — Markdown rendering invariant](internals.md#markdown-rendering-invariant).

## Page chunk fails to load on first navigation

`lazyPage()` in `src/app/render.ts` returns `loadingPlaceholder()` while the dynamic `import()` resolves, then caches the module and calls `renderApp()`. If the chunk 404s, the placeholder sticks. Check Network panel for the failed `dist/ui/assets/<page>-*.js` and verify the chunk name in the `lazyPage()` call matches a manifest entry.

## Lazy tool renderer placeholder sticks

Symptom: a `preview_open` (or other lazy-loaded tool: `gate_inspect`, `verification_result`, `extract_document`, `javascript_repl`, `read_session`) widget renders as the card-shaped placeholder — header icon + tool name + a disabled "Loading…" button — and never swaps in the real renderer. The Open / Inspect / etc. button never appears even after the lazy chunk should have landed.

Likely causes:

1. A `<tool-message>` or `<tool-group>` instance didn't receive the `bobbit-tool-renderer-loaded` event (`TOOL_RENDERER_LOADED_EVENT` in `src/ui/tools/renderer-registry.ts`). Most often because the listener wasn't attached — the consumer must register it in `connectedCallback()` and remove it in `disconnectedCallback()`. Any new rendering surface that calls `renderTool()` directly needs the same listener wiring.
2. The loader threw and the failure was swallowed. The registry installs a `makeLoadFailureRenderer` fallback that paints an error card ("Renderer failed to load — refresh to retry"), so an indefinite spinner means the failure path itself is broken — most likely `startLoad()` didn't dispatch the event on the rejection branch.

Fix path:

- Confirm `startLoad()` in `src/ui/tools/renderer-registry.ts` dispatches `TOOL_RENDERER_LOADED_EVENT` on **both** success and failure branches with `detail: { toolName }` on `document`.
- Confirm `<tool-message>` (`src/ui/components/Messages.ts`) and `<tool-group>` (`src/ui/components/ToolGroup.ts`) add the listener in `connectedCallback`, filter on `e.detail.toolName` matching this instance's tool, and call `requestUpdate()`.
- Check the browser console for `[tool-registry] failed to lazy-load renderer for "<name>"` — if present, the loader itself rejected and the fallback card should now be visible.

## QA screenshot token bloat

The QA extension must emit `[screenshot_file]<path>[/screenshot_file]` markers, not `[screenshot_base64]…`. Inline base64 blows the model context budget. Check the extension under the QA tool group.

## Stale project-proposal panel after `propose_project`

`onProjectProposal` shallow-merges the incoming proposal into the panel state. If a field disappears or stays stale, verify the merge isn't replacing the whole object and check the `proposal_update` envelope shape.

## `lastActivity` reads "just now" after restart

**Fingerprint:** several otherwise unrelated sessions acquire identical or tightly clustered `lastActivity` values during gateway boot. Compare the in-memory row with its persisted `lastActivity` and `lastReadAt`. If read state remains intact but activity jumps during restore, replay was attributed as new work. A second fingerprint is a rejected prompt or steer that changes activity, disappears from its recovery queue, or lets later replay continue advancing activity.

Trace the attempt transaction in the shared session-activity attributor. Begin must be side-effect free. Only a positive RPC acknowledgement or an exact, trusted, unambiguous terminal user `message_end` correlated by the manager may commit; rejection must cancel that exact attempt without releasing restore quarantine. A trusted terminal echo can precede a negative acknowledgement and still win. The generic activity classifier must exclude user and user-with-attachments updates and ends; assistant messages, tools, and a final non-retryable `agent_end` remain generic visible activity only after quarantine opens. Replacement must invalidate old-bridge tokens before replay begins.

For same-text retries, inspect author-correlation state without logging prompt bodies. Cancelled attempts and restored settled-keyless occurrences share a digest-only ambiguity fence capped at 256 records and 64 KiB. An unrepresentable record or exceeded bound makes the ambiguity state sticky. Explicit zero-row restored author-sidecar hydration must do the same because the compatibility result can mean missing, wholly corrupt, future-version, legacy, or genuinely empty input. In that fail-closed state, raw same-text events cannot accept a current attempt before acknowledgement; positive RPC acknowledgement remains authoritative. Do not infer partial completeness: the reader exposes no completeness state when at least one row survives.

Treat user `message_update` as correlation and projection progress only. It must never commit prompt activity, release quarantine, settle author correlation, or retire queue/steer recovery; a later positive acknowledgement may commit the prompt transaction exactly once. Only an exact trusted terminal user `message_end` may commit through manager correlation and settle recovery before that acknowledgement. An ambiguous terminal projection remains buffered for positive acknowledgement, while a negative acknowledgement leaves the attempt recoverable.

Instrument `SessionStore.update()` in a focused test. Restore-only traffic and rejected attempts must produce no `lastActivity` or `lastReadAt` patch. Accepted activity must write a value greater than both previous activity and read time, including with a fixed same-millisecond clock. For mark-read failures, confirm the endpoint does not return `{ ok: true }` until the async store flush resolves; a flush rejection must surface as an error while routine activity writes remain debounced.

Run the core restore-activity tests for quarantine, rejection/ack races, replacement, and durability; the message-author dispatch tests for keyed/keyless ambiguity, digest bounds, overflow, and update/end semantics; and the direct-prompt lifecycle tests for queue and steer recovery. Finish with the browser restart journey for the graceful stop/start and real unread indicator. Do not fix this class with a delay, a `switch_session` completion flag, raw-text retention, or a client-side unread exception. See [Read/unread state](internals.md#readunread-state) for the full contract.

## Sidebar shows spurious "now ●" (unread dot) on idle sessions

Symptom: idle sessions in the sidebar repeatedly flip to "now" with an unread dot, roughly every ~15s, even though no agent activity has occurred. The state self-heals within ~5s (next `/api/sessions` poll) but recurs on the next status heartbeat.

Cause: a client-side writer is mutating `lastActivity` in response to `session_status` WS frames. The server is the sole authoritative writer of `lastActivity` - `updateLocalSessionStatus()` in `src/app/api.ts` must update `status` only. See [internals.md - Client must not mutate `lastActivity`](internals.md#client-must-not-mutate-lastactivity). Pinned by `tests/spurious-idle-unread.spec.ts`.

## Symlinked project root rejected with `code: symlink_root`

`POST /api/projects` returns HTTP 400 `{ error, code: "symlink_root", rootPath, canonical }` when the supplied `rootPath` differs from `realpathSync(rootPath)`. The add-project dialog handles this transparently: it catches `SymlinkRootError` from `src/app/api.ts`, shows a confirm modal (`data-testid="symlink-confirm"`), and re-submits with `body.acceptCanonical: true` on accept. CLI/scripted callers must either pre-resolve the path themselves or include `acceptCanonical: true` in the body. The throw originates in `detectSymlinkRoot()` / `SymlinkProjectRootError` in `src/server/agent/project-registry.ts`. `registerProvisional()` and `registerSystemProject()` auto-accept canonical and never surface this error. See [internals.md — Symlinked project rootPath handling](internals.md#symlinked-project-rootpath-handling).

## `findByCwd` returns undefined for a project-root alias

Should not happen post-fix. `ProjectRegistry.findByCwd()` applies the shared project-path identity to both the registered `rootPath` and the incoming `cwd`: native paths resolve their longest existing prefix, while foreign POSIX/Windows dialects stay lexical. It then uses a component-aware containment check, so a macOS `/var` ↔ `/private/var` alias is valid but a sibling prefix is not. If lookup fails, verify the root and cwd use the intended dialect and that the existing ancestor is readable; uncertain filesystem case evidence deliberately preserves spelling rather than guessing. `getByPath()` uses the same identity, so a proven safe alias cannot create a duplicate project. See [internals.md — Project root identity and symlinked roots](internals.md#symlinked-project-rootpath-handling).

## Modal shows only "Failed: 400" with no description

Symptom: triggering an action (e.g. create goal) produces a modal whose body is just "Failed: 400" or "Failed to create goal: 400" — no description, no code, no stack.

Diagnosis: a client call site is dropping the structured server error body. Both halves must be applied together — fixing only one half drops the structured info.

Reference pattern, using the shared helpers in `src/app/error-helpers.ts`:

- Throw side: `if (!res.ok) throw await errorFromResponse(res, "Failed to …");` — parses `{ error, code, stack }` off the JSON body and attaches `code`/`stack` to the `Error`. Falls back to `Failed: <status>` on a non-JSON body.
- Catch side: `showConnectionError(title, e.message, errorDetails(e));` — extracts `{ message, code?, stack? }` from any caught value (Error, custom subclass with `.code`, or non-Error) without throwing.

Server side: confirm the handler whose response surfaced is using `jsonError(status, err, extra?)` (in `src/server/server.ts`) for caught exceptions, not literal `json({ error: String(err) }, ...)` or `json({ error: err.message }, ...)`. Validation responses with literal strings (e.g. `"Missing title"`) intentionally stay as `json({ error: "..." }, ...)` — they have no useful stack.

The `<error-details>` component (`src/ui/components/ErrorDetails.ts`) renders message + optional code + collapsible stack disclosure when both halves are wired. Background polling sites (e.g. `refreshSessions()`) are intentionally silent and do NOT surface a modal.

Pinned by `tests/error-modal-call-sites.test.ts` (enumerates every modal call site that must forward `{ code, stack }`) and `tests/error-helpers.test.ts` (helper contract). Add new modal call sites to the former; do not add a new `showConnectionError(...)` without forwarding `errorDetails(err)`.

## Wildcard bind appears in an auto-open or advertised gateway URL

- **Symptoms**: under `./run --host 0.0.0.0 --port <port> --no-tls`, the console's `Listening` field reports `http://0.0.0.0:<port>` as expected, but the browser, an agent, or an extension tries to connect to that literal wildcard and fails. The IPv6 equivalent uses `::`.
- **Why**: `0.0.0.0` and `::` are wildcard *listen* addresses. They tell the kernel to accept connections on every interface, but they are not portable *connect* peers; macOS and BSD reject `connect()` to `0.0.0.0`.
- **Expected split**: only the `Listening` field retains the bind address. The advertised peer URL, tokenized UI/auto-open URL, and persisted `state/gateway-url` use a connectable loopback: `0.0.0.0` maps to `127.0.0.1`, while `::` and `[::]` map to `[::1]`. They retain the actual bound port and configured base path. Because wildcard binds are non-loopback, the UI/auto-open URL includes the enforced real token; the persisted peer base does not.
- **Where the fix lives**: `loopbackForBind` owns wildcard translation, and `buildStartupUrls` uses its result for `peerUrl`, `uiUrl`, and `openUrl` while leaving `listenUrl` truthful. The gateway's bound callback persists `peerUrl` before sessions resume.
- **Quick checks**: `cat .bobbit/state/gateway-url` and the browser auto-open target should never use `0.0.0.0` or `[::]` as the URL host; an IPv6 wildcard bind must become `[::1]` in connect targets. If either literal wildcard remains, a startup path bypassed `buildStartupUrls` or `loopbackForBind`. Coverage: `tests2/core/cli-loopback-for-bind.test.ts` and `tests2/core/base-path-cli.test.ts`.
- **Reference**: [Networking — Advertised and selected gateway URLs](networking.md#advertised-and-selected-gateway-urls).

## Trigger fired but staff didn't wake

- **Symptom**: a cron / git trigger fires (visible in `lastFired` / `lastSeenSha` advancing) but the staff session never produces a new turn. Pre-inbox, the trigger silently dropped while the session was `streaming`/`starting`; that path is gone (`POST /api/staff/:id/wake` deleted, `TriggerEngine.wakingInProgress` field removed). Triggers now always enqueue.
- **First check**: `cat <projectStateDir>/inbox/<staffId>.json` — if a pending entry is there, the trigger ran fine; the question is why the nudger hasn't delivered it.
- **WS sanity**: an `inbox.entry.added` frame should hit every connected client within ~50 ms of the enqueue. Missing means `InboxManager.broadcastToAll` isn't wired, or the trigger engine errored before calling `enqueue` (check server logs for `[trigger-engine] Failed to enqueue inbox entry`).
- **Nudger gating**: `InboxNudger.tickOne` skips when (a) `staff.state !== "active"`, (b) `staff.currentSessionId` is unset, (c) `session.status !== "idle"`, (d) `nudgePending` is already set for that staff, or (e) the pending list is empty. The tick is 15 s, so worst-case latency on the idle→nudge edge is ~15 s + compact time (when `contextPolicy === "compact"`).
- **Stuck `nudgePending`**: cleared in `InboxNudger.onAgentStart(sessionId)` via the session-manager hook. If the agent never enters `streaming` (e.g. provider error before the first token), the flag stays set and silences re-nudges until the next successful turn or server restart. Catch in `applyPolicyThenNudge` clears it on thrown exceptions but not on `enqueuePrompt` silently parking the prompt.
- See [docs/staff-inbox.md](staff-inbox.md) for the full lifecycle.

## Staff context-policy save bounces back

- **Symptom**: changing the Context Policy radio on the staff edit page and clicking Save shows the new value briefly, then the form re-renders with the old value.
- **Fix shipped in the staff-inbox release**: `PUT /api/staff/:id` now forwards `contextPolicy` (`"preserve"` \| `"compact"`) through to `StaffStore.update`. Pre-fix builds dropped it on the allow-list.
- **If seen again**: check `server.ts` `PUT /api/staff/:id` handler still threads `body.contextPolicy` into the update payload; `staff-store.ts` `update()` normalises any other value to `"compact"`. The radio binding is in `src/app/staff-page.ts` (`editContextPolicy` field).

## "text field in the ContentBlock … is blank" (image/attachment-only prompt)

- **Symptom**: sending a prompt with only an image/attachment and no typed text fails with `Validation error: the text field in the ContentBlock at messages … is blank.` The session then stays broken — even retries that include text re-fail with the same error.
- **Cause**: the model API rejects a user message whose `ContentBlock` has a blank `text` field (next to an image, or standalone). The blank block was committed to the agent's `.jsonl` transcript, so every later turn replayed it. See [docs/image-attachment-only-prompts.md](image-attachment-only-prompts.md) for the full design.
- **Source-prevention fix**: `synthesizeAttachmentText` (`rpc-bridge.ts`) substitutes the synthetic body `ATTACHMENT_ONLY_TEXT` (`"Attachments:"`) when text is blank/whitespace AND an image/attachment is present. Applied at the dispatch boundary in `SessionManager.enqueuePrompt` so direct/queued/recovery/retry paths all inherit valid text; backstopped in `RpcBridge.prompt` for the image case.
- **Recovery fix (already-broken sessions)**: `isBlankContentBlockError` detects the poison; the transcript sanitizer (`transcript-sanitizer.ts`) rewrites blank-text user messages to `"Attachments:"` at the rehydration boundary (it never touches `tool_result` user messages and hardens the write path against symlink/traversal); `_recoverBlankTextPoison` respawns the live agent so it rehydrates from the clean transcript.
- **Pinning tests**: `tests/synthesize-attachment-text.test.ts`, `tests/image-only-prompt-dispatch.test.ts`, `tests/image-only-prompt-unstick-recovery.test.ts`, `tests/transcript-sanitizer.test.ts`.
