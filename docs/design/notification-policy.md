# Notification policy — scope beeps and unread dots to human attention

Status: implemented. Shipped under the goal *Scope notifications to human attention* (branch `goal/scope-noti-bad2ad9b`); extended under *Human Sign-Off Gates* (branch `goal/human-sign-off-0333f6af`) with the four-rule team-lead disjunction in §2.1.

The canonical predicate lives at [`src/app/notification-policy.ts`](../../src/app/notification-policy.ts). Pinning tests: [`tests/notification-policy.spec.ts`](../../tests/notification-policy.spec.ts) (unit) and [`tests/e2e/ui/notification-policy.spec.ts`](../../tests/e2e/ui/notification-policy.spec.ts) (browser E2E).

Sections 1–8 cover the UI-side predicate (beep / favicon badge / sidebar dot). Section 9 covers a sibling concern on the server side: how often `TeamManager` nudges an idle team-lead session. Both are about *not* spamming whichever consumer (human or team-lead bot) is listening for a turn-finished signal.

## 1. User-visible problem

The "agent finished" cue — beep + favicon badge + sidebar unread dot — used to fire on **every** `streaming → idle` transition of a background session, and on every `agent_end` for the active session. With team goals enabled this produced a constant trickle of noise that had nothing to do with the human:

- Each team member (coder, reviewer, tester, …) beeped when its turn ended, even though it was just handing off to the team lead.
- The team lead also beeped when it went idle mid-goal — but a mid-goal idle is usually transient (the lead has just queued the next turn), so the user was being pulled in for nothing.
- The sidebar unread dot drifted in the opposite direction: `hasUnseenActivity` already partially suppressed team agents (only surfacing them when the goal was complete) but disagreed with the other two surfaces.

The fix is **one policy module** that all notification surfaces consult: *does this idle session actually need a human, and is this a persistent surface or a one-shot idle transition?*

## 2. The predicate

Exported predicates have different read-state and transition semantics:

| Predicate | Read-filterable | Rules covered |
|---|---|---|
| `needsHumanAttention(session, goal, allSessions, gateStatusCache)` | yes | 1, 4 (persistent surfaces only) |
| `needsHumanAttentionOnIdleTransition(session, goal, allSessions, gateStatusCache)` | yes | 1 only |
| `needsImmediateHumanAttention(session, gateStatusCache)` | no (bypass) | 2, 3 (see §2.1) |

Call sites OR the appropriate filterable predicate with `needsImmediateHumanAttention()`. The immediate predicate fires regardless of whether the user has "read" the session, because pending sign-off and errored-and-parked demand attention until the user explicitly acts. `needsHumanAttention()` is wrapped by `hasUnseenActivity()` so persistent rules clear once the user views the session. One-shot streaming→idle beeps use `needsHumanAttentionOnIdleTransition()` so Rule 4 does not beep merely because a team lead has just gone idle to wait for workers or verification.

Three session-kind branches, mutually exclusive:

| Session kind | Detection | Notify? |
|---|---|---|
| **Standalone** | No `delegateOf`, no `teamLeadSessionId`, role missing or not a team role | **Yes** — unchanged from before |
| **Team member** | `delegateOf` set, OR `teamLeadSessionId` set, OR (`role` exists, is **not** `"team-lead"`, and the session is bound to a `goalId` / `teamGoalId`) | **Never** — they escalate to their team lead, not to the human |
| **Team lead** (`role === "team-lead"`) | Has a `goalId` or `teamGoalId` | Per §2.1 four-rule disjunction |

"Live downstream work" (used by rule 4) = any other (non-lead, non-delegate) session bound to the same goal whose `status` is in `streaming` / `busy` / `preparing` / `aborting` / `starting`, or whose `isCompacting` flag is set. In-flight gate verification (`state.gateStatusCache.<goalId>.verifying`) is a separate suppressor on rule 4.

### 2.1 Team-lead disjunction — four rules

A team-lead session surfaces persistent unread state when **any** of the following hold. One-shot polling / active-session beeps use the same policy but intentionally exclude Rule 4, so normal mid-workflow idle waits stay silent.

| # | Rule | Predicate | Bypass read filter? | Notes |
|---|---|---|---|---|
| 1 | Goal complete | `needsHumanAttention` | no | Team is done; surface so the user can review / merge. Clears once the user views the session. |
| 2 | Goal has ≥ 1 `human-signoff` step in `awaitingHuman` state | `needsImmediateHumanAttention` | **yes** | Sign-off requests demand attention until resolved. See [design/human-signoff-gates.md](human-signoff-gates.md). |
| 3 | `session.lastTurnErrored === true` AND `consecutiveErrorTurns ≥ MAX_CONSECUTIVE_ERROR_TURNS` (3) | `needsImmediateHumanAttention` | **yes** | Canonical "human action required" state — messages parked in `promptQueue` awaiting explicit Retry. See [docs/internals.md](../internals.md) for the server-side parking mechanic. |
| 4 | Idle stuck (debounced) | `needsHumanAttention` | no | Lead is idle AND `Date.now() - session.lastActivity ≥ STUCK_IDLE_THRESHOLD_MS` (10s) AND none of: a live sibling, an in-flight verification, an awaiting sign-off. |

Rule 4 explicitly suppresses on `cache.awaitingHumanSignoff` so it doesn't double-count with rule 2.

#### Why rule 4 is debounced

Pre-debounce, a delegate's status briefly clears between handoffs (one delegate ends; the next has not yet emitted `streaming`). For that sub-second window no sibling looks "live", and the predicate fired a transient dot every time the team progressed. The 10-second threshold eliminates this spawn-handoff race; genuine "team lead is stuck" cases (no handoff arrives at all) trip the dot a full beat later — acceptable trade.

#### Why `ask_user_choices` doesn't need a special case

When the agent posts an `ask_user_choices` widget, that's new transcript activity — the standard unread path fires the dot. Once the user reads the session, they've consciously seen the question and chosen to leave it pending; no further nag. Rule 4's read-state filter and the normal `lastActivity` mechanics handle this correctly without any special predicate.

#### Why rule 2 needed extra plumbing

The sign-off bit lives on `state.gateStatusCache.<goalId>.awaitingHumanSignoff`, denormalised from `awaitingSignoffCount > 0`. Two pieces had to line up:

- **Server.** `GET /api/goals/:id/gates?view=summary` uses the shared gate-status summary builder to stamp `awaitingSignoffCount` per gate plus a goal-wide total from active verifications. The bare `/gates` endpoint does **not** include the count.
- **Client.** `refreshGateStatusCache` in `src/app/api.ts` fetches the `?view=summary` shape. `src/app/gate-status-events.ts` centralizes the WS/custom event types that refresh the cache when a sign-off parks, resolves, or completes.

Without both, rule 2 stays dormant. Pinned by the widget/sign-off E2E coverage.

Full design and implementation details: [design/human-signoff-gates.md](human-signoff-gates.md).

## 3. Why one shared predicate

The three notification surfaces used to each carry their own filter:

| Surface | Where | Pre-fix filter |
|---|---|---|
| Polling beep | `src/app/api.ts`, `streaming → idle` for background sessions | `isSubAgent = !!delegateOf \|\| (!!role && role !== "lead")` — **note the string `"lead"`, which is wrong**: the actual lead role is `"team-lead"`, so team leads were accidentally muted |
| Active-session beep | `src/app/remote-agent.ts::agent_end` | None — beeped on every active-session `agent_end` |
| Sidebar unread dot | `src/app/render-helpers.ts::hasUnseenActivity` | Suppressed team agents until the goal was `complete`, then surfaced **both** lead and members |

Three filters, three slightly different rules, drifting independently. The new predicate is the only place these decisions are made; all three call sites consult it. The `"lead"` vs `"team-lead"` typo disappears as a side effect — the string is gone.

## 4. Call sites

All three call sites follow the same shape: resolve the session's goal (if any), then ask the predicate.

### 4.1 Polling beep — `src/app/api.ts`

The session-list poll compares previous status against current status. When a non-active background session goes `streaming → idle`, it consults the predicate:

```ts
if (prev === "streaming" && s.status === "idle" && s.id !== activeId) {
  const goalId = s.teamGoalId || s.goalId;
  const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
  if (needsHumanAttentionOnIdleTransition(s, goal, newSessions, state.gateStatusCache)
      || needsImmediateHumanAttention(s, state.gateStatusCache)) {
    RemoteAgent.playNotificationBeep();
    showFaviconBadge();
  }
}
```

### 4.2 Active-session `agent_end` — `src/app/remote-agent.ts`

The active session has its own beep path because `agent_end` fires immediately on the WS, with no poll lag. It uses `needsHumanAttentionOnIdleTransition()` plus the immediate predicate, matching the polling beep and excluding Rule 4's idle-stuck branch. The other `agent_end` housekeeping (streamingMessage cleanup, `pendingToolCalls` reset, per-tag streaming flag clear) is unchanged.

There is one defensive fallback: if the session is not yet in `state.gatewaySessions` (the brief window before the next list poll lands), the code falls back to beeping. This preserves the standalone "turn finished" cue and never *silently swallows* it — the failure mode is at worst "an extra beep" rather than "missed the only one".

### 4.3 Sidebar unread dot — `src/app/render-helpers.ts::hasUnseenActivity`

The dot predicate keeps its two existing early-returns:

- `status === streaming || busy` → false (active sessions don't show unread).
- `activeSessionId() === session.id` → false (the currently-viewed session is never unseen).

The team-goal filter is then replaced by a call to `needsHumanAttention`. Behaviour change: team members never pulse; team lead pulses only when the goal is complete or the lead is stuck. The `lastActivity > lastReadAt` comparison (with the in-memory `_readMirror` for immediate feedback before the server round-trips) is unchanged.

## 5. Risk and regression vectors

- **`hasUnseenActivity` is read widely.** Sidebar pulse animation, row sort, and `passesSidebarFilters` all consume it. The behaviour change (members never pulse, lead pulses only when complete or stuck) is intentional, covered by the unit table plus the browser E2E.
- **Standalone behaviour must not change.** Row 1 of the unit table and the standalone-row half of the E2E pin this. The active-session `agent_end` fallback ensures the standalone "turn finished" beep is never accidentally dropped even when the session list cache hasn't caught up yet.
- **Polling beep and `agent_end` beep are not redundant.** `agent_end` fires immediately for the active session. The poll catches background sessions and runs at 5s cadence. Both must consult the same predicate so the user sees consistent behaviour regardless of which session is focused.
- **Goal state is supplied by the client.** The predicate reads `goal.state`; if the client cache is stale (goal completed server-side but `/api/goals` hasn't refreshed), notifications fire on the next poll instead. Acceptable — at worst it's 5s late, never wrong.

## 6. Out of scope

- Server-side detection of pending `ask_user_choices` tool_use. The "stuck" branch already covers it — a lead idle with no live downstream work is stuck by definition, whether the cause is a question, a waiting verification, or just a planning lull.
- Sound design. Reuse the existing beep / favicon badge plumbing in `RemoteAgent.playNotificationBeep()` and `showFaviconBadge()` — only the call sites change.
- New user settings. The existing "Play agent finish sound" toggle on the preferences page still gates the audio.
- Mobile / push notifications.

## 7. Pinning tests

- **Unit (`tests/notification-policy.spec.ts`)** — file:// fixture bundling `notification-policy.ts` against a small `__seed` helper. Covers the standalone / delegate / team-member branches plus the full team-lead disjunction matrix: rules 1–4 in isolation, rule 4's debounce (lead idle for less than `STUCK_IDLE_THRESHOLD_MS` stays silent), rule 4's suppressors (live sibling, `verifying`, `awaitingHumanSignoff` each individually — false), the rule 2 / 3 read-filter bypass, and the idle-transition split that suppresses Rule 4 beeps while preserving complete/sign-off notifications. Mirrors the structure of `tests/spurious-idle-unread.spec.ts`.
- **Browser E2E (`tests/e2e/ui/notification-policy.spec.ts`)** — three scenarios driving the wiring at the sidebar:
  1. Standalone idle session shows the dot; patching the session to a team member silences it; reverting restores it.
  2. Team lead with a fabricated `complete` goal shows the dot via the `renderTeamLeadRow` path (which uses `data-nav-id="session:<id>"` rather than `data-session-id`); flipping to in-progress + adding a streaming sibling member hides it.
  3. Dot state on reload matches server-side `lastReadAt` from `/api/sessions/:id/mark-read`.
- **`tests/spurious-idle-unread.spec.ts`** — continues to pass unchanged. The new predicate doesn't change what it asserts (the heartbeat must not bump `lastActivity`, which is a separate invariant).

The browser E2E uses three test-only window hooks installed by `src/app/main.ts`: `__bobbitState`, `__bobbitRenderApp`, and `__bobbitExpandedGoals`. They are documented in [docs/testing-strategy.md — Test-only window hooks](../testing-strategy.md#test-only-window-hooks).

## 9. Team-lead idle-nudge backoff

A sibling notification mechanism on the server side: when a team-lead session goes idle mid-goal, `TeamManager` periodically prompts ("nudges") it to check in on workers or wrap up. That cadence has its own correctness problem and its own fix.

Tests: [`tests/team-manager-idle-nudge-backoff.test.ts`](../../tests/team-manager-idle-nudge-backoff.test.ts). Diagnostic entry: [docs/debugging.md — Auto-nudge cadence never escapes base delay](../debugging.md#auto-nudge-cadence-never-escapes-base-delay).

### Reset-driven rearm

Completing a team clears its idle timers and removes the team-lead event subscription, while deliberately preserving the team record and lead session. If a human later resets a gate, an active completed goal has concrete work again, so the reset lifecycle changes it to `in-progress` and rearms that same runtime. The rearm replaces the lead subscription, clears completion-era nudge timestamps and counters, and starts the ordinary base-delay no-workers/workers timers when the lead is idle. It never creates or replaces a team or session.

Rearm succeeds only after the old unsubscribe callback has completed and the new event subscription has been installed. A callback failure returns a retryable `TEAM_REOPEN_FAILED` while the project-scoped reset intent remains durable; the next matching reset request retries from clean runtime state. The failed attempt does not seed watchdog timestamps, timers, or the success marker, so retry cannot duplicate a subscription or timer.

This rearm is idempotent until the team completes again. An exact reset retry cannot stack subscriptions, timers, or prompts. Archived, shelved, and paused goals reject reset with `409`, so a watchdog cannot accidentally reverse deliberate operator dormancy. If the completed team was explicitly torn down, reset still reopens the goal and gates but treats the missing runtime as authoritative: it creates no lead or timer and there is nothing to nudge until the operator starts a team. Once a runtime is reopened, the normal suppressors still apply: an active verification, in-flight child, non-idle lead, or pending nudge prevents premature delivery.

`completeTeam` also closes the race in the other direction. It validates required gates before worker dismissal, then validates them again after all asynchronous dismissals and immediately before persisting `complete`. If a reset interleaves during dismissal, completion aborts and rearms the lead at base delay rather than overwriting the new pending work with a completed state.

The immediate gate-reset notice and later recovery nudge are separate signals. A live lead receives the reset notice only when the request reopened the goal or changed at least one gate; the notice includes the lifecycle outcome. A no-op or retained-intent retry sends no duplicate notice. If the reopened lead remains idle, normal no-workers, workers-idle, and stuck-sweep policy may nudge it later; after restart, an unresolved `pending` gate also qualifies a restored team for the one-shot boot-resume nudge. See [Cold-restart re-prompt recovery](../cold-restart-reprompt.md) and [Goals, Workflows & Tasks — Reset-driven goal reopening](../goals-workflows-tasks.md#reset-driven-goal-reopening).

### 9.1 The bug

`TeamManager` runs two parallel idle-nudge schedulers keyed by goal id:

- **Workers nudge** (`scheduleWorkersNudge` in `src/server/agent/team-manager.ts`) — fires when the lead is idle while workers are still active. Base delay `IDLE_NUDGE_DELAY_MS = 10m`.
- **No-workers nudge** (`scheduleNoWorkersNudge` in the same file) — fires when the lead is idle with zero active workers. Base delay `NO_WORKERS_NUDGE_DELAY_MS = 5m`.

Both are supposed to back off exponentially (`base * 2^count`) up to a 12h cap. They didn't. The pre-fix reset rule was "the lead did something productive ⇒ reset counter", and detected "did something" by listening for `agent_start` on the lead's RPC client in `subscribeTeamLeadEvents`. But `agent_start` *also* fires when the lead is replying to its own auto-nudge — even a one-token "still waiting". The loop:

1. Lead idle → nudge sent at base delay (5m / 10m).
2. Lead's RPC client starts streaming the reply → `agent_start` → counter reset to 0.
3. Lead's turn ends → `agent_end` → fresh nudge scheduled at base delay.
4. Repeat forever.

An overnight unattended goal therefore absorbed one nudge every 5 or 10 minutes regardless of the configured cap. The exponential ceiling was dead code.

### 9.2 The fix: prompt provenance

The missing discrimination is "the lead is replying to its own nudge" vs "the lead got fresh external input" — both manifest as `agent_start`. So every prompt now carries a provenance tag.

`SessionManager.enqueuePrompt` and `SessionManager.deliverLiveSteer` (in `src/server/agent/session-manager.ts`) accept an `opts.source: PromptSource` option. The most recent value is persisted on `SessionInfo.lastPromptSource`. `TeamManager.subscribeTeamLeadEvents` reads it on the lead's `agent_start` and decides whether to reset the backoff counters.

| `PromptSource` | Set by | Resets counters? |
|---|---|---|
| `"user"` *(default)* | UI / WS handler, REST callers — every existing caller without an explicit `source` | **yes** |
| `"system"` | reserved | **yes** |
| `"auto-nudge"` | `TeamManager.scheduleWorkersNudge`, `scheduleNoWorkersNudge`, `notifyTeamLead` | no |
| `"task-notification"` | `TeamManager.notifyTeamLeadOfTaskCompletion` | no |
| `"verification"` | `VerificationHarness` team-lead notifier wired in `src/server/server.ts::setTeamLeadNotifier` callback | no |
| `"agent"` | reserved | no |

On the lead's `agent_start`:

- `"user"` or `"system"` ⇒ `clearIdleNudgeTimer(goalId)` — full reset: both counter maps cleared, both timers cancelled. Next `agent_end` schedules at base delay.
- Anything else ⇒ cancel any pending timers but **preserve** `idleNudgeCount` / `noWorkersNudgeCount`. Next `agent_end` schedules at the next exponential step.

The `"user"` default means existing callers that never set `source` keep current semantics — a human typing into the team-lead chat still resets the counters, exactly as expected. The new tag is opt-in for the small set of internal call sites that are bobbit talking to itself.

### 9.3 No-workers nudge is now exponential too

Pre-fix, the no-workers path was a flat `setInterval(5min)` with no counter. It is now a `scheduleNoWorkersNudge` setTimeout chain that mirrors `scheduleWorkersNudge`: each fire computes the next delay as `NO_WORKERS_NUDGE_DELAY_MS * 2^count` capped at `MAX_NO_WORKERS_NUDGE_DELAY_MS = 12h`, and increments the counter only on actual send. The callback aborts cleanly — without incrementing, without rescheduling itself — if a worker has appeared in the meantime, since the workers-nudge path owns that case from then on.

Concrete cadence under unattended overnight (no human input, no productive lead activity):

- **No workers**: 5m, 15m, 35m, 75m, 155m, 315m, 635m, 12h, 12h, … — ≤9 nudges in 24h.
- **Workers active, none streaming beyond `LONG_STREAMING_THRESHOLD_MS`**: 10m, 30m, 70m, 150m, 12h, … — ≤6 nudges in 24h.

The first nudge of a fresh idle period still arrives at the base delay, so genuinely abandoned goals aren't silently ignored.

## 9b. Worker-idle nudge debounce

A second server-side notification mechanism, distinct from §9. When a **team member (worker)** session finishes a turn (`agent_end`), `TeamManager` tells the team lead so it can reassign work: a steer like *"Agent &lt;id&gt; (&lt;role&gt;) has finished with no assigned tasks."* That nudge is correct when the worker is genuinely done — but `agent_end` also fires on transient blips.

Tests: [`tests/team-manager-worker-idle-debounce.test.ts`](../../tests/team-manager-worker-idle-debounce.test.ts). The behaviour change also rippled into [`tests/team-manager-reviewer-resume.test.ts`](../../tests/team-manager-reviewer-resume.test.ts) and the E2E [`tests/e2e/gate-verification-resume.spec.ts`](../../tests/e2e/gate-verification-resume.spec.ts), which were adapted to wait out (or shrink) the new debounce window.

### 9b.1 The problem

A worker whose tool call errors momentarily — e.g. a flaky network call — emits `agent_end` and then resumes (`agent_start`) a moment later. The worker was never actually done; it just blipped. Pre-fix, `TeamManager` called `notifyTeamLead(...)` **immediately** on every `agent_end`, so each blip steered the team lead needlessly. Over a long-running goal these transient nudges add up to real churn: the lead keeps getting pulled in to "check tasks and decide next steps" for a worker that is still busy.

The pre-existing 30s repeat-debounce inside `notifyTeamLead` (§9b.3) didn't help here, because it only suppresses *repeat* nudges for the same worker — the **first** nudge of each blip still fired instantly.

### 9b.2 The fix: 5s debounce, cancelled on resume

On worker `agent_end`, `TeamManager` no longer calls `notifyTeamLead` directly. Instead it schedules the call after a short debounce and cancels it if the worker comes back:

- A shared per-worker-session timer map `pendingIdleNotify` (keyed by worker `sessionId`) holds at most one pending timer per worker. On `agent_end` the code clears any existing timer for that session, then `setTimeout`s a new one for `WORKER_IDLE_NUDGE_DEBOUNCE_MS = 5_000` that fires `notifyTeamLead`. Clear-before-set guarantees a worker never accumulates two pending timers.
- On worker `agent_start` (the worker resumed), the pending timer is cleared and deleted — **no** nudge fires. A blip shorter than 5s is therefore invisible to the team lead.
- A worker that emits `agent_end` and stays idle past 5s fires exactly one nudge (then subject to §9b.3).

Both worker-event subscription sites now route through a single `subscribeWorkerEvents(...)` helper in `src/server/agent/team-manager.ts`: the live `spawnRole` path and the boot re-subscribe path in `resubscribeTeamEvents()`. Previously each site attached its own `agent_end → notifyTeamLead` listener; consolidating them means the debounce (and the `agent_start` cancellation) is defined once and can't drift between the two paths.

This deliberately mirrors the **team-lead idle-nudge pattern** (`subscribeTeamLeadEvents`, §9): `agent_end` starts a one-shot timer, `agent_start` clears it. Reusing the proven shape keeps the two mechanisms easy to reason about together.

**Cleanup on worker removal.** When a worker is torn down (`dismissRole`), its pending timer is cleared and deleted alongside the existing `lastNotifyTime` cleanup. This prevents a nudge from firing against a removed/terminated session and avoids leaking timers.

### 9b.3 Relationship to the 30s repeat-debounce

The 5s debounce is **separate from and sits in front of** the pre-existing 30s repeat-debounce inside `notifyTeamLead` — do not conflate them:

| Debounce | Where | Keyed by | Purpose |
|---|---|---|---|
| **5s idle debounce** *(new)* | `subscribeWorkerEvents` → `pendingIdleNotify` timer | worker `sessionId` | Swallow transient `agent_end` blips; cancelled by `agent_start`. |
| **30s repeat-debounce** *(unchanged)* | inside `notifyTeamLead` → `lastNotifyTime` | worker `sessionId` | Suppress *repeat* nudges for the same worker within 30s of the last delivered one. |

A worker `agent_end` first waits out the 5s timer; only if it survives (no resume) does `notifyTeamLead` run, where the 30s `lastNotifyTime` check and the reviewer-session guard apply exactly as before. Neither the 30s window nor the reviewer guard changed.

### 9b.4 Test-only debounce override

The 5s duration is also exposed as an overridable instance field `workerIdleNudgeDebounceMs`, defaulting to the static `WORKER_IDLE_NUDGE_DEBOUNCE_MS`. This exists purely so in-process tests can shrink the window to a negligible value and assert deterministically via fast polling instead of waiting out a real 5s timer. Production never reassigns it.

## 10. Key files

| File | Role |
|---|---|
| `src/app/notification-policy.ts` | The shared predicate. Pure function, no DOM, no fetches. Edit here — do **not** re-implement at a call site. |
| `src/app/api.ts` | Polling beep call site (`streaming → idle` for background sessions). |
| `src/app/remote-agent.ts` | Active-session `agent_end` call site. |
| `src/app/render-helpers.ts` | `hasUnseenActivity` — sidebar unread dot call site. |
| `src/app/main.ts` | Exposes the test-only window hooks (`__bobbitState`, `__bobbitRenderApp`, `__bobbitExpandedGoals`). |
| `tests/notification-policy.spec.ts` | Unit pin — 9-row truth table + bonus. |
| `tests/e2e/ui/notification-policy.spec.ts` | Browser E2E — sidebar wiring + reload persistence. |
| `tests/spurious-idle-unread.spec.ts` | Independent invariant — the 15s status heartbeat must not bump `lastActivity` and therefore must not produce spurious dots. Unchanged by this work. |
| `src/server/agent/team-manager.ts` | Server-side idle nudges (§9, §9b): `subscribeTeamLeadEvents`, `subscribeWorkerEvents`, `pendingIdleNotify`, `WORKER_IDLE_NUDGE_DEBOUNCE_MS`, `notifyTeamLead`, `dismissRole`. |
| `tests/team-manager-worker-idle-debounce.test.ts` | Unit pin for the 5s worker-idle debounce (§9b): blip-within-window suppressed, idle-past-window delivered, cleared on removal. |
