# Claude Agent SDK session lifecycle

> **Historical lifecycle design.** The original Continue/Fork and SDK-history slice below is superseded by [G6 — Claude Agent SDK persistence and resume](claude-agent-sdk-persistence-resume-g6.md). G6 is the authoritative contract: archived SDK Continue is implemented through the persisted UUID and official SDK source preflight; live SDK Fork remains `422 RUNTIME_FORK_UNSUPPORTED`. The remaining lifecycle rationale records the foundation for the in-process bridge, but it must not be read as a JSONL-clone or missing-transcript contract for SDK sessions.

## Decision

Bobbit will add an in-process `ClaudeAgentSdkBridge` that implements the existing
`IRpcBridge` contract. It uses the official
`@anthropic-ai/claude-agent-sdk` `query({ prompt: AsyncIterable<SDKUserMessage>,
options })` API; it does **not** start, parse, or control a `claude` CLI process.

The bridge is selected only for the explicit `claude-agent-sdk` runtime. Existing
`pi` sessions retain the current `RpcBridge`, process lifecycle, RPC protocol,
provider setup, transcript handling, and tests unchanged.

This is a session-lifecycle slice only. It does not add a model picker/catalog,
a per-request session `initialModel` control, UI state, a second message
translator, Claude Code CLI support, or a new tool/permission system.

Selection is a configuration prerequisite, not a new request surface. An
operator registers a Custom Provider with exact id `claude-agent-sdk`, adds the
chosen model id, and selects `claude-agent-sdk/<model-id>` through the existing
`default.sessionModel` or role `model` configuration. The custom-provider name
must preserve that provider prefix in the selectable model string.
`MANUAL_CLAUDE_AGENT_SDK_MODEL` accepts only the matching unprefixed model id
for the opt-in manual smoke; it does not register the provider or set gateway
or default-model configuration.

## Current boundaries to preserve

- `src/server/agent/rpc-bridge.ts::IRpcBridge` is the runtime boundary. Its
  listener, prompt, steer, abort, model, thinking, compact, state, and readiness
  methods are consumed by `SessionManager`.
- `session-setup.ts` owns fresh-session planning, scoped session identity, prompt
  assembly, tool activation, spawn ordering, and pre-idle persistence.
- `session-manager.ts` owns queues, prompt-author sidecars, in-flight steer
  recovery, status transitions, restart/force-abort replacement coordination,
  and durable model state.
- `session-store.ts` is the durable restart boundary.
- `claude-sdk-event-translator.ts` is already the pure, immutable SDK-message →
  Pi-`AgentEvent` adapter. It remains the only SDK event translator.

The intended SDK declaration version is `0.3.222`. Before implementation is
accepted, the installed SDK `.d.ts` must be checked and a compile-pinned seam
must verify the exact `Query` signatures (including whether
`initializationResult` is a property or method), `interrupt`, `setModel`,
`setMaxThinkingTokens`, input streaming, and `close`, plus the `Options.hooks`
`PreCompact` declaration. There is no assumed public programmatic compact
method; the installed declaration is authoritative.

## File-level implementation plan

| File | Change | Ownership |
|---|---|---|
| `package.json`, lockfile | Add the official Agent SDK dependency. | Dependency only; no CLI binary dependency. |
| `src/server/agent/session-runtime.ts` | Add runtime derivation and bridge construction. | The one runtime-selection seam. |
| `src/server/agent/claude-agent-sdk-bridge.ts` | Add the `IRpcBridge` implementation, SDK loader/deps seam, input queue, readiness state, and event-consumption loop. | SDK process/query ownership. |
| `src/server/agent/rpc-bridge.ts` | Keep Pi implementation unchanged; make all runtime-held bridge fields use `IRpcBridge`, not concrete `RpcBridge`. | Preserve the interface boundary. |
| `src/server/agent/session-setup.ts` | Resolve runtime options and call `createSessionBridge` in fresh/worktree/delegate paths. | Setup and fresh persistence. |
| `src/server/agent/session-manager.ts` | Use runtime derivation and `createSessionBridge` in restore, role restart, and force-abort replacement paths; branch only where Pi transcript `switch_session` is intrinsically Pi-specific. | Queue/replacement/persistence owner. |
| `src/server/agent/session-store.ts` | Persist runtime, opaque SDK session id, and durable SDK model/thinking tuple. | Restart source of truth. |
| `src/server/agent/provider-bridge-extension.ts` and existing lifecycle wiring | Reuse the existing `beforeCompact` lifecycle dispatch for SDK `PreCompact`; do not add a private provider protocol. | Extension-platform hook reuse. |
| `tests2/core/*`, `tests2/integration/*`, `tests2/tests-map.json` | Add deterministic fake-SDK lifecycle coverage and register each suite in its correct tier. | Bridge/translator/env helper behavior is core; `SessionManager` + store/recovery behavior is integration. |
| `tests/e2e/claude-agent-sdk-session-restart.spec.ts`, `tests/e2e/gateway-harness.ts` | Add gateway-process restart coverage through the production bridge factory/deps seam. | Proves durable restore and resume beyond in-process fakes. |
| `tests/manual-integration/*` | Add an opt-in real SDK/local-subscription lifecycle smoke. | Validates normal SDK subscription discovery without copying credentials into env. |

`session-runtime.ts` is deliberately a small generalization, not a parallel
protocol. It exports:

```ts
export type SessionRuntime = "pi" | "claude-agent-sdk";

export interface SessionBridgeOptions extends RpcBridgeOptions {
  runtime?: SessionRuntime;
  claudeAgentSdkSessionId?: string;
}

export function runtimeFromProvider(provider?: string): SessionRuntime;
export function resolveSessionRuntime(input: {
  runtime?: SessionRuntime;
  initialModel?: string;
  modelProvider?: string;
}): SessionRuntime;
export function createSessionBridge(options: SessionBridgeOptions): IRpcBridge;
```

`runtimeFromProvider("claude-agent-sdk")` returns `"claude-agent-sdk"`; every
other provider returns `"pi"`. In particular, `anthropic/*` remains Pi-backed.
This avoids silently changing existing Anthropic/Pi sessions. The existing
default-session and role model configuration chooses the SDK after the custom
provider exposes the exact prefix; this lifecycle slice adds no catalog or
per-request selection API.

`createSessionBridge` constructs `new RpcBridge(options)` for Pi and
`new ClaudeAgentSdkBridge(options, deps)` for the SDK. `SessionInfo.rpcClient`,
replacement helpers, and test factories must be typed as `IRpcBridge` so the
existing factory seam remains valid. `RpcBridge` itself is not rewritten.

## Bridge contract and ownership

`claude-agent-sdk-bridge.ts` exports the following testable shapes:

```ts
export type ClaudeAgentSdkState =
  | "new" | "starting" | "ready" | "running"
  | "interrupting" | "failed" | "stopped";

export interface ClaudeAgentSdkBridgeDeps {
  query: typeof import("@anthropic-ai/claude-agent-sdk").query;
  clock: Clock;
}

export interface ClaudeAgentSdkBridgeOptions extends SessionBridgeOptions {
  runtime: "claude-agent-sdk";
  onBeforeCompact?: (input: { span?: string; summary?: string }) => Promise<void>;
}

export class ClaudeAgentSdkBridge implements IRpcBridge { /* ... */ }
export class ClaudeAgentSdkUnavailableError extends Error {
  readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
}
```

The production construction path injects the real SDK `query` function and the
resolved gateway clock. Tests inject a fake `query` function and fake clock;
there is no global SDK mock, shell, timer, network, or subscription required.
`onBeforeCompact` is an adapter to the **existing** `LifecycleHub.dispatch(
"beforeCompact", ...)` path, assembled by the session owner from its current
session scope. It is not a new extension hook or a new provider wire protocol.

The remaining `IRpcBridge` members have explicit SDK semantics: `getMessages()`
returns a structured unsupported result because the SDK does not expose Pi's
RPC transcript snapshot; callers use the existing event/store snapshot path.
`sendCommand()` is Pi-wire-only and likewise returns structured unsupported
rather than accepting `switch_session` or other protocol commands. The
`readonly running` getter is true from successful query construction until
terminal stop/failure (it does not mean a turn is currently generating); it is
distinct from the internal `"running"` state below. Readiness remains
`waitForReady()`.

The bridge owns only:

1. one SDK `Query`, its `AbortController`, and its consumer task;
2. one `AsyncInputQueue<SDKUserMessage>` feeding that query;
3. ephemeral readiness/failure state, listeners, model, thinking level, and
   observed SDK session id; and
4. translation state from `createClaudeSdkTranslatorState()`.

`SessionManager` continues to own all durable queues, author bindings, status,
retries, recovery, and replacement fencing. The bridge must not write
`SessionStore`, mutate `SessionInfo`, drain Bobbit queues, or synthesize a
second lifecycle protocol.

### Finite readiness/failure state machine

```
new --start--> starting --SDK initializationResult succeeds--> ready
                         |                                    |
                         | first input yielded                  | first input yielded
                         v                                    v
                       failed <--- SDK iterator/error --- running
                         ^                                    |
                         |                         interrupt() |
                         |                                    v
                         +---------- fatal error -------- interrupting

new|starting|ready|running|interrupting --stop/close--> stopped
failed --stop--> stopped
stopped is terminal; no restart of the same bridge instance.
```

Rules:

- `start()` is idempotent only while its first start promise is pending or once
  `ready`/`running`; it never creates a second query.
- It creates an `AsyncInputQueue`, calls `query({ prompt: queue, options })`,
  immediately starts one `for await (const sdkEvent of query)` consumer, then
  awaits `query.initializationResult()`.
- Readiness resolves only after initialization succeeds. The default bounded
  readiness window is `COLD_REPROMPT_READY_TIMEOUT_MS` (90 seconds), matching
  current cold restore policy. A startup, iterator, or initialization failure
  rejects readiness immediately and records one sanitized terminal error.
- `waitForReady(ms)` races the single readiness promise with the supplied
  bounded timer. It never polls and never waits after `failed`/`stopped`.
- A terminal SDK result before readiness, a thrown iterator, or an SDK import/
  construction failure moves once to `failed`, rejects pending input acks,
  emits translated terminal events if available, then emits one `process_exit`
  equivalent only when no translated root `agent_end` established terminal
  lifecycle. Late events are ignored.
- `running` means at least one input has been yielded to the SDK; it is not a
  second readiness state exposed to `SessionManager`.

This gives startup and cold resume bounded waits while preserving the existing
`promptWhenReady` contract.

## Streaming prompt input and steer ordering

`AsyncInputQueue` is a private async iterable with a single serialized
producer/consumer sequence number. It has `push(message, deadlineMs)`,
`next()`, `fail(error)`, and `close()`; `push` resolves only after `next()` has
handed that exact row to the SDK. A delivery deadline rejects rather than
leaving a `prompt()` promise pending indefinitely.

`prompt(text, images, timeoutMs)` does the following:

1. verifies `ready`/`running` and rejects with the stored sanitized failure if
   terminal;
2. uses existing `synthesizeAttachmentText` and converts attachments to the
   official `MessageParam` content form;
3. appends `{ type: "user", message, parent_tool_use_id: null }` to the input
   queue; and
4. resolves when the queue consumer accepts that ordered item, or rejects at
   `timeoutMs` (default 30 seconds), on terminal failure, or on stop.

The one long-lived query receives the async iterable directly. Do not open a
new `query()` per prompt and do not concurrently call `Query.streamInput`; that
would lose session identity and introduce competing write order.

`steer(text)` uses the same queue and same acknowledgement rule, but emits
`priority: "now"`. It is serialized after already-delivered input and before
later queued input. The existing `SessionManager._dispatchSteer` remains the
source of truth for Bobbit-side ordering: it writes its in-flight ledger before
bridge dispatch, removes queue rows only after the ordered delivery succeeds,
and reconciles on restart. The SDK bridge does not bypass that ledger.

A rejected/expired input is reported before Bobbit removes its durable row, so
existing dispatch recovery re-enqueues it exactly once. If an SDK event proves
that a turn was observed before its acknowledgement fails, current
`agentObservedTurnVersion` handling remains authoritative.

## Events and translator integration

The query consumer feeds every SDK `SDKMessage` through:

```ts
const result = translateClaudeSdkEvent(this.translatorState, sdkMessage);
this.translatorState = result.state;
for (const event of result.events) this.emit(event);
```

Diagnostics are bounded logs/bridge diagnostics only. They do not create a
parallel message model. The existing translator retains its root/child
partitioning, deduplication, streamed text/thinking/tool ordering, terminal
drain, and `claudeSdk` metadata behavior unchanged.

A root translated `agent_end` is the bridge's turn boundary. It resets only
bridge-local `running` bookkeeping; `SessionManager.handleAgentLifecycle`
continues to determine error/abort status, queue draining, retry policy, cost,
and client broadcasts. Child terminal events never terminate the root bridge.

## Interrupt, Stop, and replacement

These operations must remain distinct:

| Operation | Bridge action | SessionManager outcome |
|---|---|---|
| Soft interrupt (`abortSessionTurn`, `IRpcBridge.abort`) | `await query.interrupt()`; leave input/query open. | Existing `aborting` → translated abort terminal → idle/reconcile behavior. |
| Forced abort (`forceAbort`) | Start the existing grace race around `abort()`; if it does not settle, call `stop()`, then build a fenced replacement. | Existing replacement coordinator owns queue recovery and canonical bridge swap. |
| Terminal stop (`terminateSession`, shutdown, failed replacement cleanup) | `input.close()`, reject unsent input acks, `abortController.abort()`, then `query.close()` once. | No future input; listeners are detached and status becomes terminated/archive behavior. |

`abort()` must never call `close()`, kill an external process, or discard queued
steers. `stop()` must be idempotent and terminal. `forceAbort` keeps its current
"listener before abort, do not await a wedged abort before grace timer" rule;
the SDK bridge's interrupt promise is simply the graceful participant in that
race.

## Model, thinking, and compaction

For `claude-agent-sdk/<model-id>` sessions, `setModel(provider, modelId)`
requires `provider === "claude-agent-sdk"`, calls `Query.setModel(modelId)`,
and updates bridge-local model only after success. `getState()` returns that
runtime/provider pair and the last initialized SDK session id. A cross-runtime
provider request returns `{ success: false, error: "Switching runtimes requires a new session" }`.

The runtime-specific branch in model resolution must preserve the existing
read-back/persist contract, but must not invoke Pi spawn flags or Pi-only model
normalization for this runtime. The selected model is passed to SDK `Options`
as `model`, and `tryAutoSelectModel` persists only after `getState()` verifies
the provider/id pair. No model catalog change is part of this work.

`setThinkingLevel(level)` maps Bobbit's canonical level to a documented,
versioned SDK token budget table in the bridge and calls
`Query.setMaxThinkingTokens(budgetOrNull)`. `off` maps to `null`; all other
levels map to fixed increasing budgets. The bridge updates `thinkingLevel` only
after success, and `getState()` exposes it for the existing read-back checks.
The table must be a pure exported helper with exhaustive tests; SDK/model
unsupported errors are normal rejected controls, not silent downgrade.

There is no public SDK compact command. Consequently `compact()` returns a
structured unsupported failure and does not fabricate Pi compaction events or
sidecars. SDK `PreCompact` hooks still invoke the existing `LifecycleHub`
`beforeCompact` dispatcher through the `onBeforeCompact` adapter, so providers
can retain context before SDK-managed automatic compaction. This uses the
existing Extension Platform hook and requires **no additive hook**.

## Persistence and resume

Add the following recovery-critical fields to `PersistedSession` and
`UpdatableSessionFields`:

```ts
runtime?: "pi" | "claude-agent-sdk"; // absent remains pi
claudeAgentSdkSessionId?: string;      // opaque SDK/Claude session id
```

The durable `modelProvider`, `modelId`, and `effectiveThinkingLevel` fields
remain the model tuple. Do not store subscription credentials, environment
values, raw SDK messages, or a query handle.

- Fresh setup persists `runtime` before start. Once initialization exposes a
  non-empty SDK `session_id`, it updates `claudeAgentSdkSessionId` through
  `persistSessionMetadata` before the session is marked idle. It also records
  the verified provider/model/thinking tuple by the existing persistence path.
- SDK options receive `resume: persisted.claudeAgentSdkSessionId` only after
  strict opaque-id validation. A malformed/empty value is ignored for new
  sessions and is a restore error for a record claiming the SDK runtime.
- Restore, role restart, and force-abort replacement reconstruct the same
  `SessionBridgeOptions`, pass the persisted SDK id, await readiness, and
  install the replacement only after it is ready and model/thinking read-back
  succeeds. They do **not** issue Pi `switch_session`, inspect a Pi JSONL, or
  call transcript sanitizers for this runtime.
- During restore, SDK iterator events are staged exactly like Pi replay: no
  queue drain, lifecycle side effects, or cost duplication until the bridge is
  canonical. Any persisted in-flight steer left unacknowledged is reconciled by
  the existing ledger after canonical install.
- **Superseded Continue/Fork slice:** archived SDK Continue is implemented by G6. It validates the persisted UUID and exact model tuple, preflights official SDK session info before destination allocation, then creates a fresh Bobbit wrapper with that same UUID as `resume`; it never clones Pi JSONL or sidecars and never uses `switch_session`. Live SDK Fork remains an early `422 RUNTIME_FORK_UNSUPPORTED`, before destination allocation or Pi/worktree/sidecar work. See [G6 — Claude Agent SDK persistence and resume](claude-agent-sdk-persistence-resume-g6.md).

## Provider availability and environment isolation

The SDK's `Options.env` replaces its subprocess environment. Therefore the
bridge must construct a new minimal allowlist rather than spread `process.env`
or `RpcBridgeOptions.env` wholesale.

`buildClaudeAgentSdkEnv(options)` is a pure exported helper. It allows only
runtime necessities (`HOME`/platform home variables, `PATH`, temp variables,
locale, and `CLAUDE_AGENT_SDK_CLIENT_APP`), plus the current session's
`BOBBIT_SESSION_ID` and `BOBBIT_SESSION_SECRET` if Bobbit tools require them.
It removes `BOBBIT_TOKEN`, gateway/admin credentials, generic `*_TOKEN`,
`*_SECRET`, `*_KEY`, cloud/provider credentials, preload/injection variables,
and project-supplied environment keys unless an explicit future SDK credential
handoff is separately approved.

The SDK is allowed to discover the user's local Claude subscription from its
own expected user-home auth store. That auth is not copied into env, persisted,
logged, or shared between sessions. Each bridge gets a fresh environment object,
`AbortController`, input queue, query, and translator state; no mutable module
singleton may carry model/auth/session state across sessions.

`query()` loader/import, initialization, prompt delivery, and terminal iterator
errors are normalized into `ClaudeAgentSdkUnavailableError` when they mean SDK
missing, authentication unavailable, or provider unavailable. Errors are
sanitized and bounded. Startup failures reject `createSession`/restore rather
than hanging; post-ready provider/auth failures emit the translated terminal
error and settle pending calls. No retry loop may retry an unavailable provider
forever; existing session error/retry classification controls any subsequent
user-visible recovery.

## Automated test tiers

Add a fake SDK in `tests2` that supplies an async-generator `Query`, deferred
`initializationResult`, controlled input pulls, programmable emitted SDK
messages/errors, `interrupt`, `setModel`, `setMaxThinkingTokens`, and `close`.
It is injected through the production `ClaudeAgentSdkBridgeDeps` and bridge
factory seam, uses a fake clock, and never imports a real SDK, accesses a local
subscription, starts a CLI, or waits on wall-clock timers.

Place pure bridge, queue, translator pass-through, model/thinking, compaction,
and environment-helper cases in `tests2/core`. Place cases that instantiate
`SessionManager` with `session-store` — ordered durable dispatch/steer recovery,
force-abort replacement, fresh metadata persistence, and restore/role-restart
resume — in `tests2/integration`. Register both in `tests2/tests-map.json`.

Required cases:

1. Start readiness resolves only after initialization; timeout, SDK-loader
   failure, iterator throw, and init auth/provider rejection fail once without
   hanging a prompt.
2. Ordered prompt input is delivered once; attachment-only text uses the shared
   synthesizer; an input delivery timeout preserves the SessionManager durable
   queue row.
3. Steer uses `priority:"now"`, preserves pre-existing ordered input, and
   SessionManager's in-flight ledger survives delivery→echo restart recovery.
4. Interleaved root/child SDK frames pass through the existing translator; no
   new translator implementation or duplicate terminal is introduced.
5. Soft interrupt calls `Query.interrupt` and leaves a subsequent prompt
   usable; terminal stop calls `close`, rejects pending inputs, and disallows
   restart of the same instance.
6. `forceAbort` still reaches its grace timeout when fake `interrupt()` never
   settles, then installs only a ready, fenced replacement.
7. Model, thinking token mapping, read-back, wrong-provider rejection, and
   unsupported SDK controls are deterministic and persist only verified state.
8. Automatic `PreCompact` calls existing `beforeCompact`; manual `compact()`
   returns unsupported without fabricated compaction events.
9. Fresh initialization persists the SDK session id; restore/role restart/
   force-abort resume with it and never send Pi `switch_session`; malformed or
   missing SDK ids fail restore cleanly.
10. Two concurrent fake bridges have separate env objects, queues, translator
    state, listeners, abort controllers, and session ids; subscription/gateway
    secrets never appear in the SDK env or diagnostics.
11. Pi regression coverage proves `runtime: "pi"` still constructs
    `RpcBridge`, retains current env/model/thinking/compaction behavior, and
    does not import or invoke the SDK.

Retain the existing offline `claude-sdk-event-translator.test.ts` unchanged as
the translator contract.

## Gateway-restart and subscription validation

Add `tests/e2e/claude-agent-sdk-session-restart.spec.ts` using the existing
`tests/e2e/gateway-harness.ts`. Its test-only gateway configuration injects the
fake through the same production `ClaudeAgentSdkBridgeDeps`/bridge-factory path
used to construct `ClaudeAgentSdkBridge`; it must not add a parallel mock or
restore protocol. Via REST, create a `claude-agent-sdk` session, prompt it, and
observe a translated SDK event. Assert its stored record contains both
`runtime: "claude-agent-sdk"` and the opaque SDK id; restart the gateway; then
assert the restored production bridge factory receives that id as `resume`,
reaches readiness, and round-trips a post-restart prompt. Instrument the Pi
wire seam to prove no `switch_session` is sent. Create a co-resident Pi session
in the same harness run and assert it restores through its existing bridge and
continues to prompt unchanged.

**Gateway-restart acceptance criterion:** after a gateway process restart, a
persisted `claude-agent-sdk` session reconstructs an SDK bridge that passes its
persisted opaque id as `resume`, reaches ready, accepts a post-restart prompt,
and never emits Pi `switch_session`; a co-resident Pi session remains Pi-backed
and functional.

Add an opt-in `tests/manual-integration` smoke run under existing gate-exempt
`npm run test:manual`: with the real installed SDK and a local Claude
subscription, verify bounded readiness, one prompt, one steer, soft interrupt,
termination, and subscription discovery under the allowlisted environment.
This is the only test that may use a local subscription; it must not log or
copy its credentials.

No `tests2/browser` journey is required because this lifecycle slice adds no UI
surface. If runtime selection becomes user-visible, that change must add its
own browser journey.

## PR #841 assessment

PR #841 is useful only for these runtime-plumbing lessons: make runtime
selection explicit and durable, keep a distinct opaque external session id,
persist it before idle, resume during restore/replacement, use a minimal
per-session environment, and inject deterministic runtime fakes.

Its implementation is otherwise rejected for this goal. The PR's
`ClaudeCodeBridge`, `claude-code-stream.ts`, local executable probing,
`stream-json` stdin/stdout parser, process killing, and parallel protocol are
all CLI-specific and must not be copied. The official Agent SDK owns transport,
streaming, interruption, initialization, and session resume; Bobbit consumes
that API through `IRpcBridge` and the already-integrated translator.
