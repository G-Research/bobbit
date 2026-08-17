# Cold-restart re-prompt recovery

When the gateway restarts, it revives the agent process for each ordinarily
restorable persisted session. Two boot-recovery mechanisms then re-prompt those
sessions so work resumes without operator intervention:

1. **Mid-turn re-prompt** — a session that was *streaming* (mid-turn) when the
   gateway died is told to continue from where it left off.
2. **Boot-resume nudge** — an idle team-lead that still has concrete
   outstanding work (an unresolved workflow gate or an open task) is nudged to
   pick that work back up, rather than sitting idle until the stuck-sweep tick.

A session in `MODEL_SELECTION_REQUIRED` is the exception: it remains a
processless, attachable recovery capsule, so boot recovery does not start,
re-prompt, or nudge it. It stays readable until the user activates a verified
replacement through the model picker. See
[Restored session requires a model](debugging.md#restored-session-requires-a-model).

This document covers the shared readiness/timeout plumbing both ordinary paths
use, the `coldStart` enqueue option, and the coordination that stops them
double-prompting the same agent. For the verification-harness reviewer-resume
path — which is a third consumer of the same helper — see
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
before the prompt is sent and the prompt itself gets the generous timeout. A
`MODEL_SELECTION_REQUIRED` capsule never reaches this restore path and is not
re-prompted when a client attaches.

### Continuation durability and acknowledgement fencing

Restore gives the interrupted-turn state two distinct owners:

- `restoreStartupWasStreaming` is an in-memory, one-shot fence for dispatching the
  restored continuation.
- Persisted `wasStreaming` records that the accepted continuation turn is still
  active and must be re-driven after another gateway restart.

RPC acknowledgement consumes only the startup dispatch fence. It proves that the
agent accepted the continuation, not that the turn finished, so it must not clear
persisted `wasStreaming`. Ordinary canonical lifecycle settlement remains the
owner of that durable transition: a final `agent_end` (or terminal process exit)
clears the active-turn marker through the existing lifecycle path.

This ownership split matters when a hard development restart bypasses
`SessionManager.shutdown()`. If manager 2 is killed after accepting the restored
continuation but before lifecycle settlement, manager 3 still reads
`wasStreaming: true` and dispatches another continuation automatically. The same
rule applies to further consecutive hard kills; no user prompt is needed to wake
the session.

Each restored interactive RPC bridge receives exactly one fresh tracked
continuation attempt while that durable marker remains active. This includes a
new bridge restored after the previous bridge emitted a correlated user echo but
was killed before lifecycle settlement: `switch_session` rehydrates the durable
history, but replaying that history does not execute the interrupted turn in the
new agent process. Exact-occurrence deduplication therefore applies within a
tracked attempt. It prevents ambiguous duplicate delivery of that occurrence,
but must not suppress the fresh recovery attempt required by a new bridge.
Canonical lifecycle settlement clears the durable marker and ends this re-drive.

Acknowledgements are also fenced against session replacement. Dispatch captures
the canonical session and its RPC bridge. A delayed acknowledgement may consume
that dispatch's startup fence only while the captured session is still canonical,
still owns the captured bridge, and has not entered replacement lifecycle
fencing. This permits a correlated acknowledgement that arrives after terminal
turn settlement when the same bridge remains canonical; it consumes only the
startup fence and cannot rewrite the already-settled durable state. Once
replacement begins, an acknowledgement from the old bridge is inert throughout
the lifecycle-fenced interval, any temporary session-map gap, and after the
replacement becomes canonical. It therefore cannot consume the replacement's
startup fence or mutate its durable occurrence state.

### Preserved recovery boundaries

The durability change does not create a second recovery protocol:

- `nonInteractive` reviewer and QA sessions remain excluded from generic boot
  continuation. The verification harness exclusively owns their re-drive and the
  compatibility `wasStreaming` bit is cleared when ownership is handed off.
- Continuations retain their exact-occurrence identity, system author, and durable
  queue/ledger handling. An ambiguous write is not duplicated within its tracked
  attempt, while each newly restored bridge still receives its required fresh
  recovery attempt.
- Definite-no-start rejection and poisoned-history rollback keep their existing
  ownership. RPC acceptance is not a rollback signal.
- Session-replacement coordination, stop/terminate cancellation, model binding,
  and serialization remain unchanged; only the final canonical bridge dispatches
  deferred continuation work.
- Graceful shutdown still snapshots restart re-drive need through the existing
  lifecycle rules. The durable marker specifically covers hard exits that bypass
  that snapshot.

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

## Pinning tests

`tests2/core/cold-restart-reprompt.test.ts` pins the behaviour through observable
recovery outcomes rather than private implementation structure:

1. The mid-turn re-prompt waits for readiness and uses the cold-start timeout
   budget, so the prompt lands instead of failing at the generic RPC timeout.
2. An accepted manager-2 continuation keeps persisted `wasStreaming` true, and a
   manager 3 created after another hard kill automatically dispatches exactly one
   continuation.
3. A correlated user echo on one bridge does not suppress the fresh tracked
   continuation on each later hard-restored bridge before lifecycle settlement.
4. Canonical lifecycle settlement—not acknowledgement—owns the persisted clear.
   A valid correlated late acknowledgement may consume only its startup fence.
5. Delayed acknowledgements from a changed bridge, lifecycle-fenced session,
   temporary canonical-map gap, or replacement session are inert.
6. `nonInteractive` restores receive no generic continuation, and stop/terminate
   winners cancel deferred continuation.
7. The boot-resume nudge owns asynchronous dispatch failures, and a lead targeted
   by both recovery mechanisms is prompted exactly once.
8. Reset recovery nudges eligible restored teams while explicit dormant states and
   teamless goals remain excluded.

The orphan-result rehydration boundary coverage separately pins exact-occurrence
retention, durable queues, and poisoned-history rollback across the same restart
path.

## Where the code lives

| File | Symbol | Responsibility |
|---|---|---|
| `src/server/agent/rpc-bridge.ts` | `promptWhenReady`, `COLD_REPROMPT_READY_TIMEOUT_MS`, `COLD_REPROMPT_PROMPT_TIMEOUT_MS` | Shared wait-for-ready + generous-timeout prompt helper and its budget constants. |
| `src/server/agent/session-manager.ts` | `restoreSession` (mid-turn branch) | Restores the interrupted-turn marker and schedules generic continuation for eligible interactive sessions. |
| `src/server/agent/session-manager.ts` | `_dispatchBootContinuation` | Dispatches the tracked system continuation, fences its acknowledgement to the captured canonical bridge, and consumes only the restore-startup fence. |
| `src/server/agent/session-manager.ts` | `wasBootReprompted`, `_bootRepromptedSessions` | Boot-coordination marker so the nudge skips an already-covered lead; cleared on `agent_start`. |
| `src/server/agent/session-manager.ts` | `enqueuePrompt` (`coldStart` opt) → `dispatchDirectPrompt` | Threads `coldStart` so the direct dispatch uses `promptWhenReady`. |
| `src/server/agent/team-manager.ts` | `_bootResumeIdleTeamLeads`, `_dispatchBootResumeNudge` | Boot-resume nudge for idle leads with work; owns the async-drain rejection. |
| `src/server/agent/verification-harness.ts` | `_tryResumeFromSession` | Reviewer resume — third consumer of `promptWhenReady` (see verification-restart.md). |
| `tests2/core/cold-restart-reprompt.test.ts` | Restart recovery coverage | Pins readiness wait, owned rejection handling, pending-gate recovery, dormant-goal suppression, and prompt deduplication. |
</content>
</invoke>
