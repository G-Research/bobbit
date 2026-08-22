# Clear Session Context

**Status:** design

## 1. Decision

Implement `/clear` as a `SessionManager`-owned context-generation replacement around Pi 0.84.1's `new_session` RPC. Keep the existing Bobbit `SessionInfo` and process/bridge, use `_coordinateSessionReplacement()` as the only dispatch fence and release owner, and persist the new active transcript pointer and all clear-boundary metadata together in the owning `SessionStore` record.

Do not implement clear as compaction, an empty summary, a new Bobbit session, or a second persistence journal.

The selected design adds one persisted boundary array, one coordinated clear transaction, one RPC convenience method, one outward-only synthetic boundary, and one boundary-selecting history endpoint. It reuses the reliable prompt ledger, replacement coordinator, session filesystem routing, atomic session store, visible snapshot pipeline, `replace-messages` reducer action, and pre-compaction history interaction.

## 2. Product contract

`/clear` starts a new Pi context generation while retaining the current Bobbit session identity and configuration:

- same Bobbit session id, connected clients, project, cwd/worktree, branch, sandbox, role, staff, goal/team/task links, system prompt, tools and permission policy;
- same selected provider/model, thinking level, image model, title, accessory, and other persisted session configuration;
- no prior user, assistant, tool-result, compaction-summary, or synthetic boundary message in Pi's new `messages` list or the next provider request;
- no generated summary and no `/clear` user message;
- prior conversation remains available only through collapsed, read-only history folds;
- prompts and steers admitted while clear is replacing the Pi generation remain durable and dispatch once, in FIFO order, only after success or verified rollback.

`/compact` and `/clear` remain distinct:

| | `/compact` | `/clear` |
|---|---|---|
| Model context | Replaces older context with a generated summary and retained tail | Starts with no conversation messages |
| Pi operation | `compact` | `new_session` |
| Transcript marker | Context compacted card with metrics | **Context Cleared** boundary |
| Earlier history | Orphaned part of the same Pi file | Complete immediately preceding Pi file |
| Active turn | Pi compaction lifecycle | Pi abort-and-new-session lifecycle under Bobbit's replacement fence |

## 3. Verified upstream and repository facts

### 3.1 Pi 0.84.1

The packaged contract is pinned by `tests2/core/pi-installed-contract.test.ts`. Pi 0.84.1 source establishes these additional facts, which new contract tests must pin rather than leave as assumptions:

1. RPC `new_session` calls `AgentSessionRuntime.newSession()`, returns only `{ cancelled: boolean }`, and rebinds RPC listeners after a successful replacement. It does not return the new path; Bobbit must issue `get_state` afterward.
2. `AgentSessionRuntime.newSession()` runs cancellable `session_before_switch` first. If accepted, it creates a fresh `SessionManager`, calls `teardownCurrent("new")`, and `teardownCurrent()` awaits `session.abort()` before `session_shutdown`, disposal, and runtime creation. The outgoing active turn is therefore settled and written before success returns.
3. The runtime factory is reused with the same cwd and agent directory, preserving the assembled runtime/system/tool configuration. The current model and thinking selection are not an explicit argument to `newSession()` and must be captured, reapplied, and verified by Bobbit.
4. A fresh persisted Pi session file is lazy. Bobbit must not pre-create/touch it; `session-manager.ts::persistSessionMetadata()` explicitly documents that Pi uses exclusive creation. Pi's `_persist()` deliberately does **not** create the JSONL for a model/thinking change or user-only history: it waits for the first assistant message, then uses exclusive `open(..., "wx")`. Calling `set_model` preserves selection in memory but does not materialize the file. Gateway-restart and live-respawn durability therefore need an explicit persisted “intentionally empty/unmaterialized generation” marker and one shared empty-generation recovery branch; manufacturing a fake assistant row or touching the file would either leak context or break Pi's later exclusive write.
5. RPC input handlers are concurrent. Bobbit must fence outward snapshot reads as well as prompt/steer writes while `new_session` is in flight.
6. A thrown/timed-out `new_session` is ambiguous. `get_state` may still expose the old path even if the old runtime was disposed before fresh runtime construction failed. Path equality alone is not proof that the old bridge is usable; verified `switch_session` or owned respawn is required.

### 3.2 Existing Bobbit seams to reuse

| Concern | Reused symbols | Existing protecting coverage |
|---|---|---|
| Exact command and drafts | `AgentInterface.sendMessage()`, `_clearAttachmentDraft()` in `src/ui/components/AgentInterface.ts` | `tests2/core/agent-interface-attachment-draft-race.test.ts`, `tests2/dom/model-selection-required-ux.test.ts` |
| Slash discovery | `BUILT_IN_SLASH_COMMANDS`, `mergeBuiltInSlashCommands()`, `_updateSlashAutocomplete()`, `_selectSlashSkill()` in `src/ui/components/MessageEditor.ts` | `tests2/dom/message-editor-slash.test.ts` |
| Client replacement | `RemoteAgent.send()`, `replaceMessages()`, event dispatch in `src/app/remote-agent.ts`; `replace-messages` in `src/app/message-reducer.ts` | `tests2/core/message-reducer.test.ts`, `tests2/core/message-reducer-dedup.test.ts` |
| Auth/restricted sessions | `ClientMessage` in `src/server/ws/protocol.ts`; `SESSION_WORK_MESSAGE_TYPES`, `rejectRestrictedSessionWork()`, authenticated connection-bound `sessionId` in `src/server/ws/handler.ts` | `tests2/integration/session-ws-write-policy.test.ts` |
| Pi RPC | `IRpcBridge`, `RpcBridge.sendCommand()`, `compact()` in `src/server/agent/rpc-bridge.ts` | `tests2/core/pi-installed-contract.test.ts` and RPC bridge tests |
| Replacement/admission owner | `_coordinateSessionReplacement()`, `_queuePromptBehindReplacement()`, `_promptQueueOwner()`, `_mergeReplacementPromptOwner()`, `drainQueue()` in `src/server/agent/session-manager.ts` | `tests2/core/reliable-compaction-release.test.ts`, `tests2/integration/reliable-intent-recovery.test.ts`, `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts` |
| Active-turn terminal replay | `_forceAbortOwned()`, `handleAgentLifecycle(..., { replacementOwnedTerminal, deferQueueDrain })`, `_markModernInFlightAttemptsUncertain()`, `_reconcileAfterAbort()` | reliable-turn and Stop coverage above |
| Atomic metadata | `PersistedSession`, `UpdatableSessionFields`, `RECOVERY_CRITICAL_FIELDS`, `SessionStore.update()`, `flushAsync()` in `src/server/agent/session-store.ts` | `tests2/core/session-store-atomic-write.test.ts`, `tests2/core/session-store.test.ts` |
| Transcript realms | `sessionFsContextForAgentFile()`, `sessionFileRead()`, `sessionFileExists()`, `sessionFileDelete()`, `canonicalContainerAgentSessionPath()` in `src/server/agent/session-fs.ts`; `switchSessionPathForAgent()`, `trustPersistedAgentSessionFile()`, `resolveSafeSessionsPath()` | `tests2/core/session-fs-sandbox-publication.test.ts`, transcript-sanitizer tests |
| Transcript branch | `parseTranscript()`, `activeTranscriptBranch()` in `src/server/agent/transcript-tree.ts`; message/author projection in `transcript-reader.ts` | transcript-tree/sanitizer and before-compaction integration tests |
| Outward-only synthesis | `buildVisibleMessageSnapshot()` / `transformMessages()` in `src/server/agent/visible-message-snapshot.ts` | snapshot purity and `tests2/core/session-manager-snapshot-memo.test.ts` |
| Compaction ownership | `readCompactionSidecarEntries()`, `mergeCompactionSidecarIntoMessages()` in `src/server/agent/compaction-sidecar.ts` | compaction sidecar/reducer/history tests |
| Read-only history UI | `PreCompactionHistory`, `MessageList.getCompactionSidecarId()` and inline mount, `readOrphanedBeforeCompaction()` and its REST route | `tests2/integration/transcript-before-compaction.test.ts`, `tests2/browser/e2e/pre-compaction-history.spec.ts` |
| Cleanup/recovery | `restoreSessions()` orphan `tracked` set; `purgeOneSession()` | `tests2/core/session-store-orphan-cleanup.test.ts` and sandbox cleanup coverage |

## 4. Durable data model

Add the following recovery-critical field to `PersistedSession` and `UpdatableSessionFields`:

```ts
interface ContextClearBoundary {
  schemaVersion: 1;
  id: string;                         // clr_<epoch-ms>_<random>
  clearedAt: string;                  // ISO-8601 commit timestamp
  previousAgentSessionFile: string;   // immediately preceding Pi generation
  activatedAgentSessionFile: string;  // Pi generation selected by this commit
  /** False until Pi flushes the first assistant message for the activated generation. */
  activatedTranscriptMaterialized: boolean;
  /** False means the immediately preceding generation had zero model-facing messages. */
  previousTranscriptMaterialized: boolean;
  compactionIds: string[];            // sidecar cards owned by the prior generation
}

interface PersistedSession {
  contextClearBoundaries?: ContextClearBoundary[];
}
```

`contextClearBoundaries` is recovery-critical and is published in the same session-record generation as `agentSessionFile`. If an intentionally empty generation must be recreated by either cold restore or an in-place/live respawn before its first assistant flush, the same atomic patch updates only `agentSessionFile` and the latest matching boundary's `activatedAgentSessionFile`; the marker stays false. This is a repair of the already-visible generation: it never appends a boundary, changes `previousAgentSessionFile`, or selects any historical path. The patch is published only after the replacement runtime, exact persisted model/thinking tuple, assembled runtime configuration, and zero-message state are verified under the existing replacement fence. A failed runtime or unpublished store operation leaves the prior pointer/boundary pair canonical and all accepted work fenced for recovery. The latest boundary is marked materialized once when Pi flushes its first assistant message at its possibly repaired active path. The array is not count-truncated: dropping an old record would silently destroy a durable transcript affordance. Disk purge of the Bobbit session is the retention boundary.

A small pure module, `context-clear-boundary.ts`, owns structural validation, stable-id creation, compaction-id ownership, and outward synthetic-row construction. Consumers skip malformed unknown-version entries and never use an unvalidated path. Runtime writes only schema v1.

Repeated clears naturally segment by immutable Pi files:

```text
initial file A
clear A: boundary A { previous=A, activated=B }, active=B
clear B: boundary B { previous=B, activated=C }, active=C
```

The active snapshot contains boundary A, boundary B, then only C's messages. Expanding A reads A; expanding B reads B. Boundary A is not inside B because boundaries are Bobbit-only rows and never enter Pi.

### 4.1 Compaction sidecar segmentation

The compaction sidecar is keyed by Bobbit session id, not Pi generation. Without explicit ownership, every old compaction card would be merged into every post-clear snapshot.

At clear commit, read the sidecar strictly and compute:

```text
current generation compaction ids =
  all valid sidecar ids - union(all prior boundary.compactionIds)
```

Store that exact set on the new boundary. Extend `mergeCompactionSidecarIntoMessages()` with an excluded-id set equal to the union owned by all clear boundaries. New compactions remain visible in the active generation; older cards do not leak or duplicate.

The existing best-effort sidecar reader cannot distinguish “no file” from an I/O failure. Add a strict read seam for the transaction: missing file is an empty set, while permission/read failures abort clear and trigger rollback. Malformed individual legacy lines retain the existing skip behavior.

The clear-history endpoint returns complete message/tool rows from the prior generation's active parent-linked branch. It does not synthesize nested compaction cards or nested clear folds; that extra recursive UI is unnecessary to meet complete-history semantics and would add another ownership model. Compacted-away ancestor messages remain present on the selected JSONL branch and are included.

## 5. Selected control flow

### 5.1 Client and authorization admission

1. Add built-in `{ name: "clear", description: "Start fresh with no prior conversation context", source: "built-in" }` to `BUILT_IN_SLASH_COMMANDS`.
2. Built-ins are reserved. Change `mergeBuiltInSlashCommands()` to put built-ins first and remove same-name discovered skill/pack entries; the current implementation lets a discovered command shadow a built-in.
3. In `AgentInterface.sendMessage()`, after the existing `MODEL_SELECTION_REQUIRED` guard and before provider-key/send hooks, match only `input.trim().toLowerCase() === "/clear"`.
4. Clear editor text, attachments, and `_clearAttachmentDraft()` exactly as the existing `/compact` accepted path does. Never call `appendMessage()`, never create an optimistic row, never run skill expansion, and never call `prompt()`.
5. Call `RemoteAgent.clearContext()`, which sends `{ type: "clear" }` on the session's already authenticated WebSocket. Draft clearing is conditional on the editor still containing the submitted command/attachments so text entered during an asynchronous send boundary is not erased. The attachment-draft invalidation generation prevents an in-flight IndexedDB load from resurrecting cleared attachments.
6. Add `clear` to `ClientMessage` and `SESSION_WORK_MESSAGE_TYPES`. The connection-bound session id remains authoritative; the frame has no caller-supplied target id. `rejectRestrictedSessionWork()` therefore rejects read-only and non-interactive sessions before manager admission with the existing `SESSION_READ_ONLY` or `NON_INTERACTIVE_WORK_CONTROL` errors. Read-only sessions remain composerless; crafted frames still fail server-side.

No in-progress transcript boundary is created. Existing `aborting`/status feedback represents the short replacement interval. A completed boundary appears only after durable commit. Failure leaves the old transcript visible and adds the standard actionable error banner: `Context wasn't cleared. Your previous context is still active. Try /clear again.`

### 5.2 Synchronous replacement fence

`SessionManager.clearContext(id)` performs all eligibility checks before mutation:

- session exists and is interactive/writable;
- no `MODEL_SELECTION_REQUIRED` condition;
- no compaction, abort, terminal request, or existing replacement coordinator;
- no second clear already admitted.

Busy/repeated concurrent requests fail with `CLEAR_ACTIVE`; they are not coalesced, because one user command must produce exactly one boundary.

The method then synchronously installs:

```ts
_coordinateSessionReplacement(
  id,
  "clear-context",
  token => _clearContextOwned(id, token),
  { drainOnRelease: true, cancelOnTerminal: () => { throw CLEAR_CANCELLED; } },
)
```

Installation occurs before the first `await`. From that point:

- `enqueuePrompt()` enters `_queuePromptBehindReplacement()` and persists one successor-targeted row;
- `deliverLiveSteer()` must check `_queuePromptBehindReplacement()` before classifying the steer as a continuation. Today it notices the coordinator only after assigning `targetTurn`; move the replacement check first;
- `steerQueued()` must not call `_dispatchSteer()` while any replacement coordinator exists and must target the promoted row at `next-turn` for clear;
- retry/drain/tool-boundary dispatch retains its existing coordinator checks;
- `_mergeReplacementPromptOwner()` remains the sole reconciliation of durable rows;
- coordinator release remains the sole post-clear drain.

No `isClearing` boolean, second lock, second queue, or parallel fence is introduced.

### 5.3 Snapshot and lifecycle fence

A write fence alone is insufficient because Pi RPC commands are concurrent.

At transaction start, mark the current `SessionInfo.lifecycleFenced = true`. Canonical Pi events are already rejected by `_sessionWriterIsCurrent()` after the coordinator advances the lifecycle generation. A temporary transaction listener captures only terminal events needed for bookkeeping: `message_end`, `compaction_end`/`auto_compaction_end`, final non-retry `agent_end`, and `agent_settled`. It never broadcasts.

Make public `getMessagesSnapshotBase()` coordinator-aware:

1. before using the memoized promise, detect an active `clear-context` coordinator and await its tail;
2. after an underlying read resolves, check again, so a snapshot started just before clear cannot return old rows after commit;
3. refetch the canonical `SessionInfo` and retry after the coordinator settles.

Extract/use an internal unfenced snapshot read for `_clearContextOwned()` so the transaction cannot wait on itself. Existing callers, including WS `get_messages`, compaction refresh, cursor refresh, and multi-tab attach, automatically converge through the public wrapper. Clear invalidates `messagesSnapshotCache`, `messagesSnapshotCursorProjection`, and prompt cursor generations before and after Pi replacement.

`sendCanonicalSessionState()` already falls back when `lifecycleFenced` is true, so clients see the persisted model tuple rather than a transient old/new Pi path. Unfence only after verified rollback or durable commit.

### 5.4 Owned transaction

Under the replacement token:

1. Snapshot the exact old persisted shapes: `agentSessionFile`, presence/value of `contextClearBoundaries`, `wasStreaming`, and `streamingStartedAt`. Retain the old live status and `setupComplete` shape.
2. Await any existing `session.pendingMetadataPersist` before reading Pi. This prevents an old metadata retry from publishing a stale path across the transaction.
3. Read and validate old `get_state`, `get_messages`, and `get_entries`. Capture provider/model, thinking level, old Pi `sessionFile`, baseline active entry ids, and old persisted/agent path equivalence. Use path-realm validation, not untrusted string concatenation.
4. Mark modern in-flight delivery attempts uncertain, install the temporary terminal listener, fence deferred first-turn `_finishSessionSetup()` metadata persistence, and broadcast `aborting` only when an active turn is being interrupted.
5. Call `rpcClient.newSession(120_000)`, implemented as `sendCommand({ type: "new_session" }, timeout)` with no `parentSession`.
6. If `{ cancelled: true }`, remove the listener, restore the untouched lifecycle/status, unfence, and return `CLEAR_CANCELLED`; Pi has not called teardown.
7. On success, read new `get_state`, raw `get_messages`, and `get_entries`. Require:
   - a non-empty path different from the old path under realm-aware identity;
   - `messageCount === 0`, `pendingMessageCount === 0`;
   - `get_messages.messages.length === 0`;
   - the pre-selection transcript tree contains no message entry/leaf.
8. Reapply the captured provider/model with `setModel()` even when it appears unchanged, then reapply thinking level. Verify exact readback and re-check `get_messages` remains empty. Do **not** require or create the new JSONL: Pi keeps model-change entries in memory but intentionally defers file creation until the first assistant flush.
9. Capture the preceding segment after Pi teardown. If the old model-facing message list/baseline contains messages, read the old transcript with `sessionFileRead(sessionFsContextForAgentFile(oldRecord, oldPath), oldPath, ...)`, parse it with `parseTranscript()`, and require every baseline active entry id to exist on the captured branch; allow additional abort-terminal entries written during teardown. Record `previousTranscriptMaterialized: true`. If the immediately preceding generation has zero model-facing messages, a missing lazy JSONL is valid: record `previousTranscriptMaterialized: false` and make its history endpoint return a stable empty envelope. A non-empty segment with a missing/unreadable file is a capture failure and rolls back.
10. Replay captured terminal events exactly once through `handleAgentLifecycle(..., { replacementOwnedTerminal: true, deferQueueDrain: true })`. Suppress `_finishSessionSetup()` during replay so it cannot independently publish `agentSessionFile`. Then run `_reconcileAfterAbort({ outcome: "proven-no-start", retargetQueuedContinuation: true })`. Existing current-turn occurrences proven in the old transcript settle; unresolved accepted work becomes successor `next-turn` work.
11. Strictly capture current-generation compaction ids. Construct the new validated boundary.
12. Perform one `SessionStore.update()` patch containing:
    - `agentSessionFile: newPath`;
    - appended `contextClearBoundaries` with `activatedTranscriptMaterialized: false`;
    - `wasStreaming: false` and `streamingStartedAt: undefined`;
    - the already reconciled durable queue/in-flight shapes as needed.
13. `await store.flushAsync()`. No boundary event, replacement snapshot, or active-pointer client state is emitted before this durability fence.
14. Do not write an adjacent recovery sidecar until Pi materializes the new JSONL; writing it beside an agent-coordinate container path is already best-effort, and touching the transcript itself would violate Pi's exclusive-create contract. The existing first-assistant metadata path writes/heals recovery metadata and must atomically mark the latest matching boundary `activatedTranscriptMaterialized: true` only when the JSONL exists at the then-current `agentSessionFile` and matching `activatedAgentSessionFile`. If cold or live recovery revised that empty generation's path first, only the revised path may materialize or satisfy this transition.
15. Clear only conversation-runtime residue: old streaming message/tool/provenance state, latest message-update cache, retry/error residue attributable to the aborted generation, snapshot/cursor caches, `lastPromptText/images`, and pending old tool permission presentation. Do not clear durable queue rows, tool policy/grants that survive normal turn boundaries, identity/configuration, clients, or event sequence.
16. Build a fresh visible snapshot from the new raw empty message list. `buildVisibleMessageSnapshot()` injects all durable clear boundaries and only current-generation compaction cards.
17. Emit one sequenced `context_cleared { clearId, clearedAt, messages }` event through `EventBuffer`. The client clears streaming/pending-tool state and applies `replaceMessages(messages)`, not the normal `snapshot` action. Broadcast verified state/status idle, restore `lifecycleFenced = false`, then return.
18. Coordinator finalization removes the fence and calls the sole `drainQueue()` boundary. Every admitted prompt/steer is dispatched once against the fresh context.

The `replace-messages` reducer action is intentionally destructive and already exists. Normal `snapshot` retains optimistic/synthetic/live survivors; using it at clear could preserve old positive-order rows across the boundary.

## 6. Persistence atomicity and rollback

### 6.1 SessionStore publication contract

A single `sessions.json` generation contains both the active pointer and boundary array. The atomic tmp-write, file fsync, and rename ensure a crash sees either:

- old pointer + old boundaries; or
- new pointer + appended boundary.

There is no legal persisted `new pointer/no boundary` or `old pointer/new boundary` state.

Harden `SessionStore`'s explicit publication contract while implementing this feature: once the canonical rename succeeds, that generation must count as published and post-rename fingerprint refresh must not turn it into a reported failure. Today a fingerprint exception after rename can make `flushAsync()` look failed even though new bytes are canonical. Make post-rename bookkeeping non-fatal (or otherwise report the committed generation) and pin it in `session-store-atomic-write.test.ts`. After that, a clear `flushAsync()` rejection proves the clear generation was not published.

The manager keeps an exact optional-field snapshot so an unpublished failure restores both in-memory fields without converting “absent” into a materially different value. Add a narrow exact-shape compensation helper analogous to `restoreUserTagsShape()` if ordinary typed `update()` cannot preserve absence.

### 6.2 Failure table

| Failure point | Required action |
|---|---|
| Eligibility, old-state read, or old metadata drain fails before `new_session` | No Pi/store/UI mutation; unfence and report actionable failure |
| `session_before_switch` cancellation | Old Pi runtime was not torn down; restore prior status, emit `CLEAR_CANCELLED`, drain nothing prematurely |
| `new_session` throws/times out | Treat as ambiguous; do not trust old-looking `get_state`. Attempt verified `switch_session(oldAgentPath)`; if unverifiable, use `_respawnAgentInPlaceOwned()` under the existing clear token |
| New path/messages/tree/model/thinking validation fails | Verified switch/owned respawn to old path; store still points old; replay/settle terminal evidence; release queued work once to old context |
| A non-empty old transcript/history capture or strict compaction read fails | Same rollback; never create a materialized-history boundary whose file cannot be read. A genuinely empty lazy generation is recorded as empty instead |
| Store flush fails before rename | Restore exact old in-memory pointer/boundary shape, then verified switch/owned respawn old; disk is proven old by the hardened publication contract |
| Rollback `switch_session` is cancelled/fails | `_respawnAgentInPlaceOwned()` with the saved old persisted record and same replacement token; never nest public `_respawnAgentInPlace()` and deadlock on the coordinator |
| Both switch and owned respawn fail | Keep lifecycle fenced/terminated with old durable pointer and queue intact; return a recovery error directing the user to Refresh agent/restart. Never dispatch against an unverifiable bridge |
| Cold/live empty-generation replacement cannot start or fails path, runtime-config, model/thinking, or zero-message verification | Stop and fence the candidate; retain the old durable active-pointer/latest-boundary pair and the existing boundary count/history; keep queued prompts/steers owned by the replacement coordinator and leave a dormant/terminated recoverable capsule rather than switching to history |
| Atomic empty-generation repair update/flush fails before publication | Compensate the exact in-memory pointer/latest-boundary path shapes, stop and fence the candidate, and retain the old durable pair. Do not install the candidate, emit a boundary, or drain. A post-rename bookkeeping fault is non-fatal under §6.1 because the repaired generation is already canonical |
| Socket send fails after durable commit | Do not rollback. Persistence is canonical; reconnect/reload rebuilds the same new context and boundary |
| Crash before atomic rename | Restart restores old generation |
| Crash after atomic rename but before event/broadcast | Restart restores new empty generation and injects the boundary from `sessions.json` |
| Crash after an atomic empty-generation path repair | Restart uses the repaired active/latest-boundary path pair and the still-false marker; it never follows the superseded nonexistent path or appends another boundary |

Rollback path verification compares agent-coordinate identities. For sandbox records, construct `{ ...oldPersisted, agentSessionFile: oldPath }`, pass it through `switchSessionPathForAgent()`, and verify the returned state path after canonical container/host mapping. Never host-read a container path directly.

The coordinator remains installed for the entire success or rollback sequence, so no queued work reaches an old, new, or uncertain bridge halfway through recovery.

## 7. Reload, respawn, cleanup, and path realms

### 7.1 Shared cold-restore and live-respawn recovery

Pi intentionally leaves a cleared generation's JSONL absent until its first assistant message. This valid state can reach both lifecycle families:

- cold boot is `restoreSessions()` → `restoreOneSession()` → `_restoreSessionCoalesced()` → `restoreSession()`;
- live replacement enters through `recoverSandboxSessions()`, the poisoned-dormant revive branch of `enqueuePrompt()`, `_recoverBlankTextPoison()`, `_recoverPoisonedHistory()`, `_restartSessionWithUpdatedRole()`, `restartAgent()`, or the in-memory branch of `ensureSessionAlive()`, then converges through `_respawnAgentInPlace()` / `_respawnAgentInPlaceOwned()` → `restoreSession()`. `_recoverPoisonedHistory()` already calls the owned form under its existing coordinator token; clear rollback will do the same under its clear token. Neither may add a nested coordinator or eagerly sanitize a recognized missing empty-generation path.

Add one narrow `_restoreUnmaterializedClearGeneration()` helper at the shared `restoreSession()` convergence point, after `rpcClient.start()` and before the ordinary `switch_session` block. `_restoreSessionCoalesced()` forwards its existing `SessionReplacementToken`; `_respawnAgentInPlaceOwned()` forwards the token it already owns. The helper never creates a lifecycle flag, lock, coordinator, queue, or drain. Thus cold restore retains the `"restore"` coordinator and every in-place caller retains the `"respawn"`, poison, or clear coordinator already installed by `_coordinateSessionReplacement()`.

`restoreOneSession()` must let a missing host **or sandbox** active path reach this helper, instead of applying the ordinary missing-transcript archive/dormant rule, only when the latest structurally validated boundary matches that path and has `activatedTranscriptMaterialized === false`. The helper is authoritative and repeats the realm-aware existence/eligibility check so a preflight race cannot turn transcript loss into an empty restore:

1. If the active path exists, return “normal restore”; the caller follows today's sanitize + `switch_session` path.
2. If it is missing without an exact latest-boundary match and false marker, fail closed under the existing missing/transcript-loss policy. A true marker is never recoverable as empty.
3. For the exact false-marker case, keep the existing replacement/lifecycle fence installed and use the newly started Pi runtime as the replacement generation. Do **not** call `switch_session`, read `previousAgentSessionFile`, switch to any boundary path, touch/pre-create JSONL, or synthesize a message.
4. Reuse `restoreSession()`'s normal bridge construction so cwd/worktree, role/staff/goal association, sandbox/container wiring, assembled system prompt, tools/extensions/permissions, and other runtime options are unchanged. Reapply the exact persisted provider/model and effective thinking level, verify exact `get_state` readback, and require `get_messages` plus the message-bearing transcript entries/tree to contain zero model-facing messages. Reject a same/empty/unsafe reported replacement path. Convert and compare host/container identities through `sessionFsContextForAgentFile()`, `switchSessionPathForAgent()`, `trustPersistedAgentSessionFile()`, and the canonical container/host mapping helpers; never host-read a container coordinate.
5. Only after all verification succeeds, issue one `SessionStore.update()` that changes `agentSessionFile` and that same latest boundary's `activatedAgentSessionFile`, retaining `activatedTranscriptMaterialized: false`, the boundary id/count/order, every `previousAgentSessionFile`, `previousTranscriptMaterialized`, compaction ownership, reliable queue/in-flight evidence, and all unrelated configuration. `await store.flushAsync()` before installing/broadcasting the candidate. This is path repair inside the existing clear generation, not another clear.
6. On runtime creation, path/configuration, model/thinking, zero-message, store-update, or pre-publication flush failure, stop and fence the candidate, restore the exact old in-memory store shapes if mutation began, and retain the old durable active/latest-boundary pair. Cold restore leaves its normal dormant recoverable record; in-place recovery reinstalls its terminated/fenced rollback capsule with attached clients. The coordinator retains durable prompt/steer ownership and releases nothing against an uncertain bridge. A later recovery retries from the same old false-marker record.
7. After verified publication, install the fresh `SessionInfo`; only coordinator finalization may merge and drain its prompt owner. Queued prompts and steers therefore dispatch FIFO/exactly once against the verified empty generation. If accepted successor work had started before a crash but Pi had not flushed an assistant, the existing reliable-turn recovery—not an invented transcript row—owns its exact redrive/parking decision.
8. Once Pi flushes the first assistant message, the normal metadata/lifecycle path verifies that the file exists at the current repaired path and atomically flips the latest matching marker true. Thereafter all cold/live respawns use the active pointer exactly as today. A missing materialized file is transcript loss and fails closed.

This branch supports the first clear and repeated clears with no intervening turn. A second clear records the immediately preceding false-marker generation as unmaterialized/empty, so its expansion returns zero rows without inventing a file. Recovering either generation updates only its then-latest activated path, never adds a boundary, mixes segments, or restores prior content. Historical paths are passed to `switch_session` only during explicit transaction rollback; no cold or live recovery can leak an earlier segment into Pi or the next provider request.

### 7.2 Safe historical reads

Each history request is `GET /api/sessions/:id/transcript/before-clear?clearId=...`. The server:

1. resolves the authenticated session record;
2. validates `clearId` and finds exactly one normalized boundary owned by that session;
3. returns an empty envelope immediately when `previousTranscriptMaterialized === false`;
4. otherwise obtains `previousAgentSessionFile` from server metadata, never from a client path;
5. validates the host/container path and selects `sessionFsContextForAgentFile(targetPs, recordedPath)`;
6. reads it through `sessionFileRead()` and projects only message entries on `activeTranscriptBranch(parseTranscript(content))`, with existing author resolution and verbose pagination.

Use the same last-50-first page contract as pre-compaction history: `total`, `returned`, cursor/offset, `nextCursor`, and verbose full message objects. A missing retained file returns `404 transcript_unavailable`; malformed ids/parameters return `400`; the UI keeps the boundary and shows a retryable inline error.

### 7.3 Orphan tracking and purge

`restoreSessions()` must add every validated materialized `previousAgentSessionFile` and the current `agentSessionFile` to the orphan-transcript tracked set. Convert container-coordinate files to the comparable host bind-mount identity before comparing with the host scan; raw container strings do not match `scanOrphanedTranscriptsAsync()` host paths. An empty-generation repair's superseded active path has no file and is no longer metadata-owned, so it needs no orphan entry or deletion. The atomically published replacement path becomes the current tracked identity immediately—even while absent—so its first assistant materialization cannot be reported as orphaned on the next scan. A retained `previousAgentSessionFile` with `previousTranscriptMaterialized === false` is likewise known-empty and may be skipped by file scans/deletes without weakening segment ownership.

Archive retains boundaries and historical files. `purgeOneSession()` deletes, once per distinct validated path:

- active JSONL;
- every historical `previousAgentSessionFile` JSONL;
- adjacent Bobbit recovery sidecars in the correct host realm;
- existing per-session compaction/author/skill sidecars through their current purge owners.

Use `sessionFileDelete()` for each file's own realm. Host paths must pass `resolveSafeSessionsPath()`; container paths must pass `canonicalContainerAgentSessionPath()`. Do not delete a trusted read-only legacy path outside purge-safe roots.

## 8. Visible boundary and history UX

### 8.1 Synthetic shape and leak barrier

Use a distinct UI-only tool, `__context_cleared`, with a stable assistant/tool-result pair:

```ts
{
  schemaVersion: 1,
  clearId,
  clearedAt
}
```

The renderer root uses `data-testid="context-clear-card"`, `data-boundary-id`, standard `rounded-md border border-border bg-card p-3`, a distinct Eraser icon, and exact completed header **Context Cleared**. It has no token, reduction, summary, or duration fields.

Register it only through `src/ui/tools/index.ts`; never add an LLM tool definition. Inject it only in `visible-message-snapshot.ts` after Pi `get_messages` returns.

The non-leak guarantee is structural:

- `/clear` is intercepted before prompt/skill expansion and is never appended;
- old JSONL bytes are read only by validation/history REST paths;
- clear boundaries are synthesized only in the outward snapshot transform;
- expanded rows remain component-local and never enter `RemoteAgent.state.messages`;
- the client replacement event contains the outward new snapshot, but Bobbit never passes that snapshot back to Pi or a provider.

### 8.2 History interaction

Generalize `PreCompactionHistory` without forcing a tag/file rename. Add boundary kind/id and endpoint/wording properties while preserving the existing compaction default. For a clear boundary, use stable hooks:

- `context-clear-card`;
- `pre-clear-history`;
- `pre-clear-toggle`;
- `pre-clear-rows`;
- `pre-clear-load-more`;
- matching `data-boundary-id` on card and widget.

`MessageList` detects the `clearId` in `__context_cleared` arguments and inserts the widget immediately above that boundary, just as it inserts pre-compaction history.

Interaction:

- collapsed by default after success, navigation, reload, and restart;
- toggle text `Show N messages before this clear` / `Hide N messages before this clear`;
- first expansion loads the last 50 messages; `▲ Load N older` prepends earlier pages;
- expanded region uses the existing 2px `var(--border)` left rule, 0.75rem left padding, opacity 0.7, nested `<message-list>` with `isStreaming=false` and `hasStreamMessage=false`;
- it remains read-only but not pointer-disabled: users may select/copy text and open tool disclosures. No prompt/queue/permission actions are offered;
- native toggle button with `aria-expanded`, `aria-controls`, a labelled `role="region"`, loading `role="status"`, and error `role="alert"`;
- no horizontal overflow at 320–390px; affordance remains touch-operable.

Repeated layout is:

```text
[history A, collapsed/expanded]
[Context Cleared A]
[history B, collapsed/expanded]
[Context Cleared B]
[current generation messages]
```

History A and B have distinct ids, counts, local row ids, and component state. B contains only messages between A and B and excludes boundary A.

### 8.3 Client replacement event

On sequenced `context_cleared`, `RemoteAgent`:

- invalidates streaming message/id, pending tool calls, tool partials/inputs, proposal-stream flags, compaction animation residue, and stale snapshot memo state;
- applies `replaceMessages(event.messages)` once;
- retains durable outbox/queue projections and their ids/order;
- emits a UI event so `AgentInterface` repaints and follows the boundary when follow-tail is active.

A duplicate/replayed `context_cleared` event is idempotent because the supplied snapshot contains stable boundary ids and `replace-messages` replaces rather than merges. A reconnect gap or gateway restart obtains the same rows from normal snapshot synthesis.

## 9. Alternatives and defect surface

### 9.1 Selected: SessionStore-atomic boundary array

New independent concepts:

1. one optional recovery-critical boundary array on `PersistedSession`;
2. one manager transaction under the existing replacement coordinator;
3. one `newSession()` RPC convenience method;
4. one outward-only synthetic boundary/renderer;
5. one boundary-selecting REST history mode.

Necessary focused branches include snapshot waiting, early steer routing, strict sidecar read, transaction rollback, repeated-boundary synthesis, history path selection, and historical cleanup. It adds no queue, lock, lifecycle flag, transaction sidecar, commit marker, boot journal reconciler, empty-summary transform, or reducer action.

Atomicity comes from one already crash-safe `sessions.json` generation. The active pointer and its display/history ownership cannot split.

### 9.2 Rejected independent approach: context-generation manifest + WAL

The alternative stores a host-owned committed manifest and pending WAL under `<stateDir>/context-clear/`:

```text
manifest: { revision, activeAgentSessionFile, boundaries[] }
pending:  { transactionId, oldPath, newPath, oldRevision }
```

Its protocol writes a prepared WAL, updates `SessionStore.agentSessionFile`, publishes a committed manifest, then removes the WAL. Boot recovery must scan every WAL, use manifest membership as a commit marker, choose roll-forward/rollback, update the correct project store, fsync it, and clean up. Snapshot/history/purge code reads the manifest rather than `PersistedSession`.

This is viable and gives an explicit two-store journal, but it introduces at least these additional owners/branches:

- manifest schema/store and atomic writer;
- pending WAL schema/store and atomic writer;
- transaction id/revision/commit-marker rules;
- pointer-versus-manifest publication ordering;
- restart reconciliation before live session construction;
- missing-file/dormant recovery policy;
- duplicate/stale WAL cleanup;
- independent purge/orphan ownership;
- another snapshot read/failure surface.

It still needs the same coordinator, Pi validation, model reapplication, terminal replay, path handling, synthetic UI, and history endpoint. The WAL therefore does not replace complexity; it adds a second atomic domain solely to reconstruct a fact that fits in the existing session record. Reject it in favor of the single-store commit.

### 9.3 Rejected non-approach: treat clear as compaction

An empty/manual compaction is invalid even if it appears smaller:

- Pi may generate or retain a summary/tail, violating zero prior model messages;
- compaction events/cards/animations and continuation affinity have different meaning;
- compaction history assumes old and active context share one JSONL;
- no matching Pi `compaction_end` exists for a `new_session` masquerade;
- compaction's `isCompacting` lifecycle would become a second release owner and can strand or double-drain work.

## 10. Expected implementation files

Production:

- `src/server/ws/protocol.ts`
- `src/server/ws/handler.ts`
- `src/server/agent/rpc-bridge.ts`
- `src/server/agent/session-store.ts`
- `src/server/agent/session-manager.ts`
- `src/server/agent/session-fs.ts` only if a comparable host/container identity helper is extracted
- `src/server/agent/visible-message-snapshot.ts`
- `src/server/agent/compaction-sidecar.ts`
- new `src/server/agent/context-clear-boundary.ts`
- `src/server/agent/transcript-reader.ts`
- `src/server/server.ts`
- `src/app/remote-agent.ts`
- `src/ui/components/AgentInterface.ts`
- `src/ui/components/MessageEditor.ts`
- `src/ui/components/MessageList.ts`
- `src/ui/components/PreCompactionHistory.ts`
- `src/ui/tools/index.ts`
- new `src/ui/tools/renderers/ContextClearedRenderer.ts`
- `docs/compaction.md` (clear comparison/behavior/history section; implementation documentation gate)

Tests are new/extended only under `tests2/` and registered in `tests2/tests-map.json`.

## 11. Test matrix

| Tier | Scenario | Required assertions |
|---|---|---|
| Core: slash | discovery and interception | built-in description present without server skills; built-in wins same-name collision; exact trimmed mixed-case standalone command intercepted; `/clear x` is ordinary input; no user/optimistic message; composer and attachment draft clear only on accepted invocation; model-selection fence runs first |
| Core: RPC/Pi contract | real 0.84.1 `new_session` | exact command, cancelled response, path discovered through `get_state`; active abort settles before success; fresh messages empty; model/thinking reapplied; model change does not materialize JSONL before assistant flush; system/runtime remains usable |
| Core: store | atomic pointer/boundary | one generation contains both fields; repeated boundary normalization; flush failure leaves old generation; post-rename fingerprint failure cannot report an uncommitted result; exact optional-shape compensation |
| Core: transaction success | idle and streaming clear | A→B pointer change only after validation; baseline ids captured in A; B messages empty; same SessionInfo/config/clients; one boundary event after flush; no old snapshot emitted |
| Core: transaction failures | every fallible phase | cancellation; throw/timeout before/after teardown; invalid/same/missing new path value; nonempty messages/entries; set-model/thinking mismatch; non-empty old history missing/unreadable; strict compaction read failure; store failure; switch rollback failure; owned-respawn fallback; no boundary/replace event on rollback |
| Core: snapshot fence | reads before/during clear | pre-existing and new `get_messages` reads cannot return old rows after commit; internal transaction read does not deadlock; state falls back while lifecycle-fenced; stale cursor/memo cannot republish old data |
| Core: reliable delivery | active-turn admissions | prompt and direct steer before/during/after admission; promoted steer and retry; all clear-time rows target next-turn; zero Pi work RPC before release; FIFO/exactly once after success; failure releases once to old verified context; an empty-generation live respawn retains prompt + steer and releases each exactly once only after repair publication; duplicate clear/Stop/terminate interleavings |
| Core: lifecycle | active abort evidence | terminal events captured/replayed once; interrupted occurrence settles from old transcript; unresolved rows become proven-no-start successor work; first-turn metadata persistence cannot race pointer commit; costs/grants/tool state follow existing terminal policy |
| Core: repeated clear | A/B/C | first empty clear and second clear with no intervening materialization produce two stable ordered boundary pairs; A reads only A, B is stable empty, C is active and empty; recovery revises only latest activated path; no boundary row in Pi; no duplicate cards on repeated snapshot/event/reload |
| Core: compaction interaction | compactions across generations | old compaction ids excluded after clear; new compaction visible; second clear assigns only unowned ids; clear during active compaction rejected; strict read errors rollback |
| Core/integration: path realms | host and sandbox | validate host/container paths; old/new files read through correct realm; rollback path translated with `switchSessionPathForAgent`; host scanner tracks translated historical container files; purge deletes distinct safe files/sidecars only |
| Integration: WS policy | authenticated/restricted | allowed frame targets only bound session; read-only and non-interactive crafted frames rejected before `new_session`; archived/unavailable rejected; no model/store mutation on denial |
| Integration: non-leak | next provider request | after ordinary clear, first/repeated empty-generation cold restore, and live respawn, prior user, assistant, tool input/result, compaction summary, `/clear`, synthetic boundary, and historical file content are absent; current assembled system prompt and tools remain present |
| Core/integration: empty-generation restore/respawn | first and repeated clear, host and sandbox | A→unmaterialized B, then optionally B→unmaterialized C; force `restartAgent()`/in-place respawn before assistant output and exercise cold restore; fresh reported path has zero Pi messages/entries; same Bobbit identity, runtime config, model, and thinking; one unchanged boundary per clear with atomic active/latest-boundary path repair; history remains expandable after reload; host/container paths use the right realm; queued prompt + steer issue no old RPC and dispatch exactly once after publication; next provider request has no A/B history |
| Core/integration: empty-generation recovery failures | runtime and store faults | fresh bridge start/config/readback/zero-message failure and store update/flush failure for cold, live, and sandbox paths retain the old durable pointer/latest-boundary pair and boundary count, stop/fence the candidate, emit no replacement/boundary, perform no historical switch, and do not drain queued prompt/steer work; retry remains possible |
| Integration: restart | crash boundaries | restart before rename restores A/no boundary; restart after rename recognizes missing B as intentionally empty and recreates it without old context; active pointer/latest boundary path update atomically; first assistant flush marks materialized; crash after successor prompt admission but before assistant flush preserves exact reliable occurrence recovery; a later missing materialized file fails closed; queue rows release once; repeated empty/non-empty boundaries persist |
| Integration: history API | pagination/auth/path | active parent-linked branch only; complete user/assistant/tool rows; last-50-first/load older; author projection; invalid id/foreign path unavailable; missing retained file actionable |
| Browser journey | `tests2/browser/journeys/clear-session-context.journey.spec.ts` | autocomplete/keyboard insertion; seed user+assistant+tool content; mixed-case invocation; composer/attachment clearing; no `/clear` bubble; exact Context Cleared card; expand/collapse dimmed interactive history; fresh follow-up; reload; second clear with disjoint folds; mobile no-overflow/tap; cleanup in `finally` |

The browser journey covers navigation, happy path, reload, and cleanup. Gateway-restart and fault injection belong in integration/E2E harness coverage rather than being simulated by browser reload.

## 12. Completion invariants

Implementation is complete only when tests prove all of the following:

1. The next Pi/provider message list after clear has the current system runtime and zero prior conversation/summary/synthetic content.
2. Pointer and boundary metadata are one durable publication.
3. No client receives a mixed old/new snapshot.
4. Every accepted prompt/steer is retained and dispatched at most once at the coordinator's final boundary.
5. Failure restores a verified old runtime or leaves an explicitly fenced recoverable capsule; it never drains onto an uncertain bridge.
6. Historical rows and boundary synthetics have no path back into Pi.
7. First and repeated clear, lazy empty-generation cold restore and every live/in-place respawn, later materialized respawn, host/sandbox path repair and reads, orphan tracking, and purge preserve exact segment ownership: recovery atomically revises only the active/latest-boundary path, never adds a boundary or switches to history, verifies zero messages and runtime configuration before queue release, and fails fenced without pointer/boundary split or prior-content leakage.
