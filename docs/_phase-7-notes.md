# Phase 7 — restart resilience: handoff notes

These bullets are inputs for Phase 8 (Documentation), which folds them into
`AGENTS.md` and `docs/debugging.md`. **Do not copy this file into AGENTS.md
verbatim** — Phase 8 will reword to fit the existing voice and dedupe with
already-present entries.

Lessons 4.5 and 4.17 are already merged to master and are NOT in scope for
this phase.

## Debugging keyword index entries (one per Lesson)

- **Phantom gate failure after gateway restart, every step output reads "Step
  was running but had no session ID — cannot resume after restart"** —
  Lesson 4.6. Restart-interrupt suppression. `_resumeOneVerification` consults
  `shouldSuppressRestartInterrupt` from `verification-logic.ts`; when every
  failed step matches `RESTART_INTERRUPT_MARKERS` (or is an empty-output
  llm-review/agent-qa step), the gate is left `pending` rather than `failed`
  and the team-lead receives a benign "interrupted by restart, please
  re-signal" notification. Real failures still mark the gate failed —
  predicate is conjunctive.

- **Resumed reviewer goes idle without calling `verification_result` after a
  restart, "Agent did not call verification_result after server restart and
  reminder"** — Lesson 4.7. The string is now in `TRANSIENT_ERROR_PATTERNS`
  so the resume path's transient-detection branch promotes recovery to
  `_rerunLlmReviewStep`, which rebuilds the kickoff with full context.

- **Live-path reviewer emits its verdict as chat-text and ends turn instead
  of calling `verification_result`** — Lesson 4.8. `buildContextRichReminder`
  in `verification-harness.ts` re-attaches the original kickoff after a
  STOP-prefixed header. Wired into both LLM-review and agent-QA live paths;
  resume path keeps the legacy terse reminder (no kickoff to rebuild).

- **WS-acked prompt never reaches the agent after restart, throws "Agent
  process not running" inside enqueuePrompt** — Lesson 4.9.
  `SessionManager._dispatchPromptWithReviveOnDeadBridge` checks
  `rpcClient.running` at the two new-prompt sites in `enqueuePrompt`
  (error-recovery branch + idle+empty branch); if false, calls
  `restartAgent`, re-resolves the SessionInfo, and dispatches on the fresh
  bridge. Steady-state retry/drain paths stay loud — only the new-prompt
  sites auto-revive.

- **"Restart Agent" button keeps re-throwing on a session that has neither
  an `agentSessionFile` nor a `role`** — Lesson 4.10. `restartAgent` now
  detects this shape, archives the row (`store.update(id, {archived: true,
  archivedAt: Date.now()})`), and throws a structured error with
  `code: "SESSION_UNRECOVERABLE_ARCHIVED"` so the UI can present an
  actionable error instead of opaquely re-emitting "Agent process not
  running" on every click.

- **Endless restart loop on boot ("server crashed boot, harness restarted in
  1s, ...")** — Lesson 4.11. Three-part fix:
  - **Crash-loop guard** in `harness.ts`: tracks `consecutiveQuickCrashes`
    and `lastLaunchAt`; quick-crash threshold is `HEALTHY_UPTIME_MS` (10s);
    after `CRASH_LOOP_THRESHOLD` (5) consecutive quick crashes the harness
    stops auto-restarting and logs "Run `npm run restart-server` to resume
    after fixing the root cause". A manual restart trigger clears the
    counter.
  - **Orphan team-store cleanup** in `TeamManager.restoreTeams`: walks every
    persisted team entry across every project context FIRST and drops
    entries whose `goalId` is not present in the owning project's goal
    store. Logs `Cleaned N orphan team entries on boot.` Runs BEFORE the
    zombie-reviewer sweep so the sweep doesn't try to operate on
    already-dropped entries.
  - **Zombie-reviewer sweep error guard** in
    `TeamManager.resubscribeTeamEvents`: defensively unregisters reviewer
    agents whose underlying session is gone; the
    `unregisterReviewerSession` call is wrapped in try/catch with
    `console.error` + continue-on-error semantics.

- **Sessionless in-progress goal stranded after multiple restarts, no team
  agents and no team-lead** — Lesson 4.12. New private helper
  `TeamManager._bootRespawnSessionlessGoals` runs at the END of
  `resubscribeTeamEvents`. Walks every non-archived goal in
  `state: in-progress, setupStatus: ready, team: true` whose `goalId` has
  no entry in `this.teams` and respawns a fresh team-lead via `startTeam`.
  Each respawn is wrapped in try/catch.

- **Parent team-lead idle for hours despite a paused child being its only
  "in-flight" descendant** — Lesson 4.13. Pure helper
  `src/server/agent/team-manager-helpers.ts::anyInFlightChild`. Treats
  `paused === true` as NOT in-flight. Mixed-progress preserved: a paused
  sibling alongside an active one still counts as in-flight via the active
  one. Phase 1 wires the `paused` field through `createGoal` /
  `goal_pause` / `goal_resume`; the field declaration on `PersistedGoal`
  is shared between Phase 1 and Phase 7.

- **Resumed reviewer terminated ~46ms after restart, before reminder is
  acted on** — Lesson 4.15. `SessionManager.waitForStreaming(sessionId,
  timeoutMs = 10_000)` is a sibling of `waitForIdle`; resolves on
  `agent_start`. Wired into all four reminder sites in
  `verification-harness.ts` (three direct calls + one inline mirror in
  the legacy direct-RpcBridge path). Already on master — Phase 7 adds
  pin-tests so it can't silently regress.

- **Reviewer session triggers spurious "Agent finished" team-lead nudge after
  restart** — Lesson 4.16. `TeamAgent.kind` and
  `PersistedTeamEntry.agents[].kind` carry `"worker" | "reviewer"`. Skip
  guard in `resubscribeTeamEvents` is `kind === "reviewer" || agent.role
  === "reviewer"` so pre-kind persisted records are still skipped.
  `restoreTeams` lazy-migrates `kind` to `"worker"` when the field is
  absent. Already on master — Phase 7 adds pin-tests.

## Recipes entries

- **Add a restart-interrupt marker** → append to `RESTART_INTERRUPT_MARKERS`
  in `src/server/agent/verification-logic.ts`. The list is consumed by
  `isRestartInterruptedStep` and `shouldSuppressRestartInterrupt`. Update
  `tests/restart-interrupt-suppression.test.ts` to pin the new marker.

- **Add a verification reminder site (live path)** → use
  `buildContextRichReminder(originalKickoff)` from
  `src/server/agent/verification-harness.ts` (NOT the legacy terse
  `VERIFICATION_RESULT_REMINDER`). After dispatching the reminder, await
  `SessionManager.waitForStreaming(sessionId, 10_000).catch(() => {})`
  before racing `verification_result` against `waitForIdle`.

- **Add a new-prompt site that may target a restored session** → route
  through `SessionManager._dispatchPromptWithReviveOnDeadBridge` instead of
  calling `session.rpcClient.prompt()` directly. The helper checks
  `rpcClient.running`, calls `restartAgent` if dead, and re-resolves the
  SessionInfo before dispatching. Steady-state retry/drain paths must NOT
  use this helper — they should fail loudly so a real bridge death
  surfaces in logs.

- **Detect / handle an unrecoverable zombie session** → `restartAgent`
  archives the row and throws `code: "SESSION_UNRECOVERABLE_ARCHIVED"` for
  rows with neither an `agentSessionFile` nor a `role`. Surface this code
  to the user with an actionable message.

- **Boot-respawn a sessionless in-progress goal** → already happens
  automatically via `_bootRespawnSessionlessGoals` in
  `resubscribeTeamEvents`. Do not poll-loop or write a custom recovery
  scheduler.

- **Skip in-flight check for paused children** → use
  `anyInFlightChild(parentGoalId, goals)` from
  `src/server/agent/team-manager-helpers.ts`. The helper already encodes
  the `paused === true` exclusion + the mixed-progress rule.
