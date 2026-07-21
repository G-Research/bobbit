# Cold-restart re-prompt recovery

When the gateway restarts, it restores every persisted session and revives its
agent process. Two boot-recovery mechanisms then re-prompt restored sessions so
work resumes without operator intervention:

1. **Mid-turn re-prompt** — a session that was *streaming* (mid-turn) when the
   gateway died is told to continue from where it left off.
2. **Boot-resume nudge** — an idle team-lead that still has concrete
   outstanding work (an unresolved workflow gate or an open task) is nudged to
   pick that work back up, rather than sitting idle until the stuck-sweep tick.

This document covers the shared readiness/timeout plumbing both paths use, the
`coldStart` enqueue option, and the coordination that stops them double-prompting
the same agent. For the verification-harness reviewer-resume path — which is a
third consumer of the same helper — see
[verification-restart.md](verification-restart.md) and
[internals.md — Cold-reviewer resume](internals.md#cold-reviewer-resume-readiness-wait--restart-interrupt-routing).

## The cold-agent problem

A freshly-revived agent is **cold**: it has to initialise the model and load its
MCP extensions before it can answer anything. This routinely takes **30–90 s** to
first respond, and it gets worse when several sessions restore in parallel
(e.g. 5-way concurrent restore competing for CPU and the model backend).

The RPC `prompt()` call defaults to a **30 s** timeout (the generic `sendCommand`
default). So a boot-recovery prompt fired naively at a cold agent has two failure
modes:

- It **prompts before the agent is ready**, with no `waitForReady()` gate.
- It uses the **30 s default timeout**, which a cold agent reliably blows past.

The result is `Command timed out: prompt`, and the recovery prompt never lands —
exactly the work the recovery path was meant to resume is lost.

The verification harness had already been hardened against this for reviewer
resume (wait-for-ready + a generous timeout). The two *generic* session-restore
paths had not, so they kept timing out on boot — increasingly visible as recent
work raised the volume of parallel cold restores.

## The shared helper: `RpcBridge.promptWhenReady`

Rather than have each recovery path re-implement the wait-for-ready + generous-
timeout dance (and drift), the logic lives in one place:

```ts
// src/server/agent/rpc-bridge.ts
export const COLD_REPROMPT_READY_TIMEOUT_MS = 90_000;   // wait this long for the agent to wake
export const COLD_REPROMPT_PROMPT_TIMEOUT_MS = 120_000; // then allow this long for the prompt

async promptWhenReady(text, images?, opts?): Promise<any> {
  await this.waitForReady(opts?.readyTimeoutMs ?? COLD_REPROMPT_READY_TIMEOUT_MS);
  return this.prompt(text, images, opts?.promptTimeoutMs ?? COLD_REPROMPT_PROMPT_TIMEOUT_MS);
}
```

`waitForReady` polls the agent with short `get_state` pings until one succeeds
(or the ready timeout is hit), so the prompt is only sent once the agent can
actually answer. The prompt itself then gets a generous timeout, well above the
worst-case cold-start latency. The two `COLD_REPROMPT_*` constants are exported so
all consumers share the same budget and a future tuning change touches one place.

Three boot-recovery paths use this helper:

| Path | Where | Trigger |
|---|---|---|
| Mid-turn re-prompt | `SessionManager.restoreSession` | session was `wasStreaming` at shutdown |
| Boot-resume nudge | `TeamManager._bootResumeIdleTeamLeads` → `_dispatchBootResumeNudge` | idle team-lead with outstanding work |
| Reviewer resume | `VerificationHarness._tryResumeFromSession` | interrupted `llm-review` / `agent-qa` gate |

## Mid-turn re-prompt path

`SessionManager.shutdown` snapshots restart re-drive need before killing agent
processes. The durable field is still named `wasStreaming`, but it now means
"this session was active/busy enough to need restart re-drive": idle and
terminated sessions are false; active states such as streaming, preparing,
aborting, and fresh starting are true. During a restore-startup window,
`sessionNeedsRestartRedrive()` keeps the pre-restore persisted bit authoritative
so a quick second shutdown does not turn a previously idle restored session into a
false interrupted-turn prompt.

`SessionManager.restoreSession` then re-prompts interrupted interactive sessions
with a "the server restarted, continue where you left off" system message. It
dispatches through `rpcClient.promptWhenReady(...)` (fire-and-forget with a
`.catch()` so a failure is logged and never throws), so a cold agent is woken
before the prompt is sent and the prompt itself gets the generous timeout.

`nonInteractive` reviewer / QA sessions are **excluded** here — they are re-driven
exclusively by the verification harness (`resumeInterruptedVerifications` →
`_tryResumeFromSession`), and firing the mid-turn nudge too would race two prompts
at the same cold reviewer. The `wasStreaming` flag is still cleared so it does not
leak across restarts.

## Boot-resume nudge path

`TeamManager._bootResumeIdleTeamLeads` runs on boot, after teams are
re-subscribed. It only iterates restored active teams from the team store; it does
not start a new lead for a sessionless goal. For each restored team whose lead is
idle and has concrete outstanding work (and which is not paused / complete /
shelved / archived / already nudge-pending), it dispatches a `[BOOT-RESUME]`
nudge so progress resumes without waiting for the stuck-sweep tick.

Outstanding workflow work means any gate not in `passed` or `bypassed`, plus
tasks in `todo` or `in-progress`. Counting all unresolved gate states matters for
reset recovery: a human reset normally produces `pending` gates, even when every
task was already complete. A completed active goal is persisted as `in-progress`
by the reset path, so that pending gate makes its restored lead eligible. Paused,
shelved, archived, and still-complete goals remain excluded even if they contain
pending data; restart must not override explicit operator dormancy.

The nudge is dispatched via `SessionManager.enqueuePrompt(sessionId, msg,
{ isSteered: true, coldStart: true })`. The `coldStart: true` option threads down
to `dispatchDirectPrompt`, which then dispatches through `promptWhenReady` instead
of a bare `prompt()` — so the nudge actually lands on a cold lead.

### Why the nudge was an unhandled rejection

`enqueuePrompt` drains **asynchronously**: for an idle lead with an empty queue it
awaits `dispatchDirectPrompt` → the RPC prompt, deep inside the drain. The
original boot-resume code called `enqueuePrompt(...)` *without awaiting it*; its
`try/catch` only guarded the synchronous enqueue, not the async drain. When the
drain's cold-start prompt rejected, the rejection had no owner and escaped to the
process as `[gateway] Unhandled rejection: Error: Command timed out: prompt`.

The fix routes dispatch through `_dispatchBootResumeNudge`, which `await`s
`enqueuePrompt` inside a `try/catch`:

```ts
private async _dispatchBootResumeNudge(sessionId, msg, goalId): Promise<void> {
  try {
    await this.sessionManager.enqueuePrompt(sessionId, msg, { isSteered: true, coldStart: true });
  } catch (err) {
    console.error(`[team-manager] Boot-resume nudge failed for goal=${goalId}:`, err);
  }
}
```

The caller invokes it as `void this._dispatchBootResumeNudge(...)` — fire-and-forget
is fine now because the helper *owns* the drain's promise. Combined with
`coldStart`, the common case no longer rejects at all; if it still does (agent
gone), the rejection is caught and logged here, never escaping as a gateway-level
unhandled rejection.

### Durable reset replay and idempotence

Gate reset uses a project-scoped write-ahead intent because goal lifecycle and
gate status are persisted separately. On project-context construction, reset
recovery runs after both stores load but before team restoration and this
boot-resume scan. It idempotently applies the phases in safe order — reopen the
goal, reset the selected and dependent gates, then clear the intent — whether the
previous process stopped after intent, goal, gate, or finalization persistence.
The scan therefore never observes a crash-produced `complete` goal with pending
reset work. A persistence failure keeps the intent for a later boot; an explicit
archived, shelved, or paused state wins and prevents replay from resuming work.

When a completed team record still exists, normal team restoration re-subscribes
its existing lead and the persisted `in-progress` state plus pending gate make
that idle lead eligible for one boot-resume prompt. A live reset also rearms that
same runtime at most once. Transient unsubscribe or event-subscription callback
failure is retryable: the API retains the durable intent, returns a retryable
`TEAM_REOPEN_FAILED`, and the next matching reset request retries rearm without
stacking subscriptions or timers.

If the operator explicitly tore down the completed team before reset, reopening
is still valid but there is no runtime to restore. Reset does not create a lead,
team, subscription, timer, or boot-resume target; starting a new team remains an
explicit action.

Boot recovery still applies its normal duplicate guards: active verification,
pending nudge delivery, in-flight children, or an existing mid-turn boot
re-prompt suppress a second prompt. A retained reset request resumed after a
runtime/finalization error also suppresses duplicate reset broadcasts and lead
notices. The boot scan sends at most one recovery prompt for that pass.

## Avoiding the double-prompt race

A team-lead that was **both** mid-turn (`wasStreaming`) **and** has an open task is
a target of *both* mechanisms. Two prompts racing the same cold agent is wasteful
and can confuse the agent.

`SessionManager` coordinates the two paths with a small in-memory set:

- When `restoreSession`'s mid-turn branch re-prompts a session, it records the id
  in `_bootRepromptedSessions` and exposes it via `wasBootReprompted(id)`.
- `_bootResumeIdleTeamLeads` calls `wasBootReprompted(lead)` and **skips** any lead
  the mid-turn re-prompt already covered.
- The marker is cleared on `agent_start` (the session has begun its turn), so it
  cannot leak past the boot window.

Net effect: a session that is both mid-turn and a lead-with-work is prompted
**exactly once**.

## Why these timeouts

- **`COLD_REPROMPT_READY_TIMEOUT_MS = 90_000`** covers the observed worst-case
  cold-start latency (30–90 s, worse under parallel restore) before giving up on
  the agent waking.
- **`COLD_REPROMPT_PROMPT_TIMEOUT_MS = 120_000`** sits comfortably above that, so a
  prompt sent the instant the agent reports ready still has headroom to be
  accepted rather than racing the 30 s default to a spurious timeout.

These mirror the values the verification-harness reviewer-resume path already used
for the same hazard — now unified behind the shared constants.

## Pinning test

`tests/cold-restart-reprompt.test.ts` pins the behaviour through observable seams
(call order, the prompt timeout argument, whether a rejection escaped, how many
times the cold agent is prompted), not symbol names, so it stays robust against
implementation detail:

1. The mid-turn re-prompt calls `waitForReady` **before** `prompt` and passes a
   generous (≥ 90 s) timeout, so the cold prompt lands instead of rejecting with
   `Command timed out: prompt`.
2. The boot-resume nudge never lets the async-drain cold-start rejection escape as
   a process-level unhandled rejection (it must be awaited inside a `try/catch`).
3. A session that is both mid-turn and a team-lead with outstanding work is
   re-prompted/nudged **exactly once**.
4. A reopened `in-progress` goal with a pending reset gate and restored team
   receives one boot-resume nudge, while teamless, complete, paused, shelved, and
   archived goals do not.

## Where the code lives

| File | Symbol | Responsibility |
|---|---|---|
| `src/server/agent/rpc-bridge.ts` | `promptWhenReady`, `COLD_REPROMPT_READY_TIMEOUT_MS`, `COLD_REPROMPT_PROMPT_TIMEOUT_MS` | Shared wait-for-ready + generous-timeout prompt helper and its budget constants. |
| `src/server/agent/session-manager.ts` | `restoreSession` (mid-turn branch) | Re-prompts a `wasStreaming` session via `promptWhenReady`; records `_bootRepromptedSessions`. |
| `src/server/agent/session-manager.ts` | `wasBootReprompted`, `_bootRepromptedSessions` | Boot-coordination marker so the nudge skips an already-covered lead; cleared on `agent_start`. |
| `src/server/agent/session-manager.ts` | `enqueuePrompt` (`coldStart` opt) → `dispatchDirectPrompt` | Threads `coldStart` so the direct dispatch uses `promptWhenReady`. |
| `src/server/agent/team-manager.ts` | `_bootResumeIdleTeamLeads`, `_dispatchBootResumeNudge` | Boot-resume nudge for idle leads with work; owns the async-drain rejection. |
| `src/server/agent/verification-harness.ts` | `_tryResumeFromSession` | Reviewer resume — third consumer of `promptWhenReady` (see verification-restart.md). |
| `tests2/core/cold-restart-reprompt.test.ts` | Restart recovery coverage | Pins readiness wait, owned rejection handling, pending-gate recovery, dormant-goal suppression, and prompt deduplication. |
</content>
</invoke>
