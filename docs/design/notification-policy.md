# Notification policy — scope beeps and unread dots to human attention

Status: implemented. Shipped under the goal *Scope notifications to human attention* (branch `goal/scope-noti-bad2ad9b`).

The canonical predicate lives at [`src/app/notification-policy.ts`](../../src/app/notification-policy.ts). Pinning tests: [`tests/notification-policy.spec.ts`](../../tests/notification-policy.spec.ts) (unit, 9-row table) and [`tests/e2e/ui/notification-policy.spec.ts`](../../tests/e2e/ui/notification-policy.spec.ts) (browser E2E).

## 1. User-visible problem

The "agent finished" cue — beep + favicon badge + sidebar unread dot — used to fire on **every** `streaming → idle` transition of a background session, and on every `agent_end` for the active session. With team goals enabled this produced a constant trickle of noise that had nothing to do with the human:

- Each team member (coder, reviewer, tester, …) beeped when its turn ended, even though it was just handing off to the team lead.
- The team lead also beeped when it went idle mid-goal — but a mid-goal idle is usually transient (the lead has just queued the next turn), so the user was being pulled in for nothing.
- The sidebar unread dot drifted in the opposite direction: `hasUnseenActivity` already partially suppressed team agents (only surfacing them when the goal was complete) but disagreed with the other two surfaces.

The fix is **one predicate** that all three surfaces consult: *does this idle session actually need a human?*

## 2. The predicate

`needsHumanAttention(session, goal, allSessions, gateStatusCache)` returns `true` iff a notification is warranted. Three branches, mutually exclusive:

| Session kind | Detection | Notify? |
|---|---|---|
| **Standalone** | No `delegateOf`, no `teamLeadSessionId`, role missing or not a team role | **Yes** — unchanged from before |
| **Team member** | `delegateOf` set, OR `teamLeadSessionId` set, OR (`role` exists, is **not** `"team-lead"`, and the session is bound to a `goalId` / `teamGoalId`) | **Never** — they escalate to their team lead, not to the human |
| **Team lead** (`role === "team-lead"`) | Has a `goalId` or `teamGoalId` | **Only when** (a) `goal.state === "complete"`, OR (b) the lead is **stuck**: no live downstream work and no in-flight verification for the goal |

"Live downstream work" = any other (non-lead, non-delegate) session bound to the same goal whose `status` is in `streaming` / `busy` / `preparing` / `aborting` / `starting`, or whose `isCompacting` flag is set — plus an entry in `state.gateStatusCache` with `verifying: true` for the goal id.

The full 9-row truth table is the source of truth for behaviour and is checked one-to-one by `tests/notification-policy.spec.ts`:

| # | Scenario | Notify? |
|---|---|---|
| 1 | Standalone idle session | yes |
| 2 | Delegate session (`delegateOf` set) | no |
| 3 | Team member: `role: "coder"`, `teamLeadSessionId` set | no |
| 4 | Team member: `role: "reviewer"` in a team goal | no |
| 5 | Team lead idle, sibling coder still streaming | no |
| 6 | Team lead idle, all members idle, no verification | **yes (stuck)** |
| 7 | Team lead idle, verification running for the goal | no |
| 8 | Team lead idle, goal `complete` | yes |
| 9 | Team lead idle, goal `complete`, sibling still streaming | yes (goal-complete wins) |

Row 6 plus row 7 is how "team lead has asked the human a question via `ask_user_choices` and is now waiting" gets covered without needing server-side detection of the pending tool call: an `ask_user_choices` leaves the lead idle with nothing live downstream, which is *by definition* stuck. The predicate stays purely client-side.

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
  if (needsHumanAttention(s, goal, newSessions, state.gateStatusCache)) {
    RemoteAgent.playNotificationBeep();
    showFaviconBadge();
  }
}
```

### 4.2 Active-session `agent_end` — `src/app/remote-agent.ts`

The active session has its own beep path because `agent_end` fires immediately on the WS, with no poll lag. The other `agent_end` housekeeping (streamingMessage cleanup, `pendingToolCalls` reset, per-tag streaming flag clear) is unchanged.

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

- **Unit (`tests/notification-policy.spec.ts`)** — file:// fixture bundling `notification-policy.ts` against a small `__seed` helper. Ten rows: the nine-row design table plus a "team member compacting counts as live downstream work" bonus. Mirrors the structure of `tests/spurious-idle-unread.spec.ts`.
- **Browser E2E (`tests/e2e/ui/notification-policy.spec.ts`)** — three scenarios driving the wiring at the sidebar:
  1. Standalone idle session shows the dot; patching the session to a team member silences it; reverting restores it.
  2. Team lead with a fabricated `complete` goal shows the dot via the `renderTeamLeadRow` path (which uses `data-nav-id="session:<id>"` rather than `data-session-id`); flipping to in-progress + adding a streaming sibling member hides it.
  3. Dot state on reload matches server-side `lastReadAt` from `/api/sessions/:id/mark-read`.
- **`tests/spurious-idle-unread.spec.ts`** — continues to pass unchanged. The new predicate doesn't change what it asserts (the heartbeat must not bump `lastActivity`, which is a separate invariant).

The browser E2E uses three test-only window hooks installed by `src/app/main.ts`: `__bobbitState`, `__bobbitRenderApp`, and `__bobbitExpandedGoals`. They are documented in [docs/testing-strategy.md — Test-only window hooks](../testing-strategy.md#test-only-window-hooks).

## 8. Key files

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
