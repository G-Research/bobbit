# Auto-Nudge Recovery for Errored Team Leads

## Context

Team goals have several server-side paths that wake an idle team lead when work may be stuck:

- workers-active idle checks;
- no-workers idle checks;
- worker-idle notifications after a child agent finishes;
- the stuck-team watchdog for fully idle teams.

All of these paths can produce an `[AUTO-NUDGE]` prompt. That is useful when the lead is simply idle, but harmful when the lead is already stopped on an errored turn: a new nudge appends another transcript card behind the visible error instead of resolving the failed turn.

## Retry before auto-nudge

`TeamManager` now checks the target session before sending an auto-nudge. If the team lead is `idle` and `lastTurnErrored` is true, the nudge path treats the error state as already requiring retry handling and does not enqueue or steer a fresh `[AUTO-NUDGE]` message.

For retryable errored idle sessions, `TeamManager` recovers through the same path as the automatic retry scheduler and the UI Retry affordance:

```ts
retryLastPrompt(sessionId, { auto: true })
```

Using `retryLastPrompt` keeps continuation safety centralized in `SessionManager`. If the failed turn already ran tools, retry resumes the interrupted work instead of replaying side effects; if the prompt failed before the agent started, recovered queue rows are consumed by the retry path rather than duplicated.

## Suppression cases

The team nudge path suppresses duplicate transcript cards in these cases:

- **Retry pending** — if `pendingAutoRetryTimer` is set, `SessionManager` already owns the scheduled retry. Team nudges do not start another retry and do not add `[AUTO-NUDGE]` cards.
- **Retry in progress / pending lead turn** — `nudgePending` blocks later timer ticks while recovery is being handled, so repeated watchdog passes do not stack new nudges.
- **Unknown, non-retryable, or exhausted errors** — if the error is unclassified, matches a non-retryable classifier, or has exhausted the bounded retry budget, team nudges are suppressed and the explicit UI Retry button remains the human-action path.

Provider backoff errors use the existing unbounded provider-overload policy. Other retryable transient/generic errors share the bounded retry budget used by auto-retry; after the budget is exhausted, the lead remains on the error with manual Retry available.

## Accounting

A retry attempt is not counted as a successful auto-nudge. Successful nudge counters and “Sent nudge” logs advance only when an auto-nudge delivery actually starts or is accepted as a lead turn. If recovery is suppressed, pending, parked, or fails before `agent_start`, the no-start accounting path preserves backoff semantics and avoids misleading transcript/log churn.

This preserves the distinction between two outcomes:

- the agent actually started processing an auto-nudge; and
- the team manager merely observed an errored idle session and delegated recovery to retry handling.

## Related docs and tests

- [Auto-Retry](../auto-retry.md) describes retry classification, scheduling, and UI events.
- [Notification Policy](notification-policy.md#9-team-lead-idle-nudge-backoff) describes team-lead idle nudge cadence and prompt provenance.
- `tests/team-manager-idle-nudge-backoff.test.ts` covers retry-before-nudge, suppression for unknown/non-retryable errors, and duplicate-card prevention while auto-retry is pending.
- `tests/team-manager.test.ts` covers worker-idle notification recovery for errored idle team leads.
