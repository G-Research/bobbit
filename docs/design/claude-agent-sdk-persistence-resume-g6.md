# G6 — Claude Agent SDK persistence and resume audit

## Decision and scope

Keep one Bobbit session record and one `IRpcBridge` boundary. A Claude Agent SDK
session persists only its runtime discriminator, opaque SDK resume UUID, and the
already-owned model/thinking tuple. `SessionManager` remains the owner of status,
prompt queue, in-flight-steer ledger, replacement fencing, and visible-event
broadcasting. The SDK owns its own conversation/resume state; no Pi command,
JSONL clone, CLI process, or second Bobbit session database is introduced.

**Required decision:** an SDK source is not valid for either Fork or
Continue-Archived. Both endpoints must reject it explicitly with `422` and a
stable `SDK_TRANSCRIPT_UNSUPPORTED` code before inspecting `agentSessionFile`.
A fresh SDK session is the only supported new-conversation operation. This is
not a request to implement SDK transcript cloning.

## Audited baseline

The implementation already composes most of the intended paths:

| Concern | Existing path | Audit result |
|---|---|---|
| Runtime selection | `src/server/agent/session-runtime.ts::resolveSessionRuntime`, `createSessionBridge` | Explicit `claude-agent-sdk` selection only; Anthropic remains Pi. |
| SDK lifetime and resume option | `src/server/agent/claude-agent-sdk-bridge.ts::ClaudeAgentSdkBridge.startInternal` | One async-input `query`; passes `claudeAgentSdkSessionId` as SDK `resume`; never emits Pi `switch_session`. |
| Durable metadata | `src/server/agent/session-store.ts::PersistedSession`, `UpdatableSessionFields`; `session-setup.ts::persistOnce`; `session-manager.ts::persistSessionMetadata` | `runtime`, opaque id, and verified model/thinking tuple are stored in the existing `SessionStore`. |
| Gateway restore | `session-manager.ts::restoreOneSession`, `restoreSession` | Invalid SDK id becomes a dormant session; valid SDK restore starts the bridge and skips Pi transcript replay at `session-manager.ts:7966`. Restore failure is exposed as `SessionInfo.restoreError`. |
| Replacement | `session-manager.ts` role restart and `forceAbort` replacement branches | Reconstructs `SessionBridgeOptions` with runtime/id and skips Pi `switch_session` for SDK at `:10388` and `:12816`. |
| Queues and steers | `session-manager.ts::_dispatchSteer`, `_consumeSteerEcho`, `_reconcileInFlightSteers` | Existing durable ledger is still the sole dispatch-to-echo recovery authority. The bridge only acknowledges ordered SDK input. |
| Automatic compaction hook | `session-setup.ts::resolveSdkRuntimeOptions`; bridge `PreCompact` hook | Reuses `LifecycleHub.dispatch("beforeCompact", ...)`; manual SDK `compact()` is deliberately unsupported. |
| Deterministic restart proof | `tests/e2e/claude-agent-sdk-session-restart.spec.ts` | Covers persisted id, SDK `resume`, a post-restart prompt, and a co-resident Pi `switch_session` regression. |

## Ownership and data flow

1. Fresh setup resolves the runtime in
   `session-setup.ts::resolveSdkRuntimeOptions`, then `persistOnce` creates the
   normal session-store row. `executePlan`/`spawnAgent` start the selected
   bridge and call `SessionManager.persistSessionMetadata` before idle.
2. `ClaudeAgentSdkBridge.startInternal` receives the SDK initialization result
   and subsequent SDK events. It holds the volatile `Query`, input queue,
   translator state, listeners, and most recently observed opaque session id.
   It does not mutate `SessionStore` or Bobbit queues.
3. `persistSessionMetadata` reads bridge `getState()` and writes only
   `runtime: "claude-agent-sdk"` and `claudeAgentSdkSessionId` for SDK; the
   normal durable model/thinking fields stay in the same `PersistedSession`.
4. On boot, `restoreOneSession` validates the stored UUID, and
   `restoreSession` constructs a new bridge with that UUID. Events stay staged
   until the bridge is canonical; then the existing in-flight-steer ledger is
   reconciled once and an interrupted interactive turn is re-prompted through
   `_dispatchBootContinuation`. Non-interactive verifier re-drive remains
   owned by `VerificationHarness`.
5. SDK events go through the existing
   `src/server/agent/claude-sdk-event-translator.ts` and
   `SessionManager.emitAgentEvent`; transcript author sidecars, prompt queue,
   status, and WebSocket replay therefore remain Bobbit-owned as they are for
   Pi. The SDK conversation itself remains SDK-owned.

Compaction does not create a new persistence schema or a Bobbit compact command.
The SDK `PreCompact` hook dispatches the existing lifecycle hook. The bridge must
continue retaining the latest valid SDK session id observed in post-compaction
frames; the next metadata persistence and any replacement/boot restore use that
id as `resume`.

## Concrete gaps to close

1. **Do not reach idle without a valid SDK id.**
   `ClaudeAgentSdkBridge.startInternal` accepts an initialization result with a
   missing/invalid `session_id`; `persistSessionMetadata` then falls through to
   Pi `sessionFile` retries and setup can become idle without resumable SDK
   identity. Treat a missing/invalid SDK initialization id as
   `ClaudeAgentSdkUnavailableError` (or a dedicated sanitized resume-id error)
   before readiness resolves. In `persistSessionMetadata`, an SDK bridge with
   no valid id must reject rather than attempt Pi transcript persistence.

2. **Make unsupported archive/fork semantics explicit.**
   `src/server/server.ts` routes `POST /api/sessions/:id/fork` (around
   `:13856`) and `POST /api/sessions/:id/continue` (around `:14426`) currently
   enter the Pi JSONL-copy pipeline. Normal SDK records happen to have no
   `agentSessionFile` and receive a generic `404`, but a malformed/imported
   record with one can reach `sessionFileCopy` and `switch_session`. Add the
   runtime check before model resolution and file work. Do not copy the opaque
   id into a new session: SDK resume means continuation, not fork.

3. **Visible transcript is currently not restart-safe for SDK.**
   `ClaudeAgentSdkBridge.getMessages()` returns unsupported. Live/reconnect
   snapshots use `SessionManager.getMessagesSnapshotBase()` and
   `ws/handler.ts` `get_messages`; archived snapshots use
   `SessionManager.getArchivedMessages()`, which parses Pi JSONL. The event
   buffer is process-local. Thus a new browser attach, server restart, or
   archived SDK view cannot reconstruct the pre-restart visible transcript,
   despite live event delivery working. The restart E2E only proves a
   post-restart prompt, not a retained snapshot.

   G6 cannot satisfy the visible-transcript requirement merely by persisting
   the UUID. The minimal acceptable resolution is to compose an **official SDK
   history/snapshot API**, if version `0.3.222` exposes one, behind
   `ClaudeAgentSdkBridge.getMessages()` and retain SDK ownership. If that API
   does not exist, this is a scope/acceptance conflict: persisting translated
   messages in a new Bobbit log or synthesizing a Pi JSONL is a second durable
   transcript protocol and is rejected by this design. Do not hide the loss
   behind an empty successful snapshot.

4. **Resume failure needs deterministic user-facing evidence.**
   Boot currently creates a dormant/terminated session with `restoreError`,
   but no focused test proves that an unavailable SDK session id becomes that
   state, preserves queued rows, and does not silently start unrelated history.
   Keep the existing `CLAUDE_AGENT_SDK_UNAVAILABLE` normalization; verify its
   sanitized error reaches the session listing/state surface and the source row
   is not archived or overwritten.

5. **Coverage is mostly bridge/store, not manager recovery.**
   `tests2/core/claude-agent-sdk-bridge.test.ts` is strong bridge coverage, but
   `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` only tests
   factory selection and raw `SessionStore` round-trip (and uses the invalid
   example string `sdk-opaque-session-id`). It does not instantiate
   `SessionManager` with a fake SDK for restore, steer recovery, replacement,
   unavailable-id handling, archive/fork rejection, or post-compaction resume.

## Same-scope approaches

| Approach | Composition | Result |
|---|---|---|
| **A. Minimal runtime composition — recommended** | Keep the existing store fields and `IRpcBridge`; use SDK `resume` for restore/replacement; use an official SDK history API for `getMessages` if available; explicitly reject SDK Fork/Continue. | Meets the one-store/one-runtime-boundary constraint and preserves the source of truth. It is blocked until the installed SDK declaration proves a history API exists. |
| **B. Bobbit-owned translated transcript log** | Append translated SDK messages/events to a new per-session JSONL/store and rebuild snapshots/archives from it. | Can satisfy visible history without an SDK API, but adds a second durable transcript database and a runtime-specific message protocol. Reject for G6. |

Approach A must not fall back to Pi `switch_session`, transcript sanitizers,
`sessionFileCopy`, or synthetic JSONL. If SDK history is unavailable, record the
requirement conflict and keep SDK sessions fail-loud for snapshots rather than
claiming complete G6 persistence.

## Targeted deterministic test matrix

Use the existing fake-`Query` dependency seam; no global mock, CLI, network,
subscription, or wall clock.

| Tier/file | Case | Required assertions |
|---|---|---|
| `tests2/core/claude-agent-sdk-bridge.test.ts` | Initialization result lacks/has malformed UUID | `start` and `waitForReady` reject once; no idle-capable bridge and no Pi metadata fallback. |
| same | `PreCompact`, then SDK frame carries the valid resume id, then restart construction | lifecycle hook runs; the last valid id is retained and supplied as `options.resume`. |
| same | SDK unavailable/init rejection | sanitized `CLAUDE_AGENT_SDK_UNAVAILABLE`; pending prompt/steer settles, no hang. |
| `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` (expand or split) | Fresh `SessionManager` setup | Store has only runtime/id plus normal tuple; no `agentSessionFile` requirement for SDK; valid UUID fixture replaces `sdk-opaque-session-id`. |
| same | Boot restore with queued prompt and an in-flight steer | factory receives `resume`; no `sendCommand(switch_session)`; accepted echo clears ledger, unechoed steer is re-enqueued exactly once ahead of later prompt. |
| same | SDK resume unavailable/missing id | session becomes dormant with sanitized `restoreError`; queue is retained; no fresh SDK conversation and no archive. |
| same | Forced abort and role replacement | ready replacement receives the same id, is canonical before queue drain, and does not issue Pi commands. |
| `tests/e2e/claude-agent-sdk-session-restart.spec.ts` | Existing gateway restart, expanded | Assert pre-restart transcript snapshot remains available after reconnect/restart if SDK history API exists; assert compaction hook then restart/post-restart prompt resumes the same id; preserve co-resident Pi regression. |
| gateway API test near archive/fork coverage | SDK source for `/fork` and archived `/continue` | Both return `422 SDK_TRANSCRIPT_UNSUPPORTED`; neither calls copy/switch nor creates a destination record. |

`tests2/tests-map.json` already registers the current core, integration, E2E,
and manual SDK suites; register any split test at its existing tier.

## Acceptance criteria

- A valid opaque SDK id is persisted before an SDK session is idle and is the
  only runtime-specific recovery metadata.
- Stop/restart, gateway boot restore, role replacement, and forced-abort
  replacement construct one ready SDK query with that exact id as `resume`;
  none issues Pi `switch_session`.
- Missing, malformed, or unavailable ids fail clearly without starting a fresh
  unrelated conversation, dropping queues, or corrupting the store.
- SDK automatic compaction keeps the same lifecycle hook and resumable identity;
  manual compaction remains unsupported.
- Archive Continue/Fork reject SDK sources explicitly.
- The visible-transcript acceptance criterion is proven through an official SDK
  snapshot capability, or is reported as an explicit SDK/API constraint rather
  than implemented with a second Bobbit transcript protocol.
