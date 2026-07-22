# Author Identity Metadata

**Status:** implemented decision record

The imperative language below records the constraints followed by the implementation; it does not describe pending work. For the concise maintainer reference, see [Message author identity](../message-author-identity.md).

**Scope:** Bobbit-visible message metadata only; Pi 0.80.6 roles, transcript schema, and model/provider input remain unchanged.

## 1. Problem and goals

Before this feature, Bobbit treated `role` as both transport shape and apparent authorship. That was insufficient because a Pi `role: "user"` row can be a human prompt, a Bobbit orchestration prompt, an extension session write, or provider-history tool output. Conversely, Bobbit-created custom rows can use assistant-like roles without being model-authored.

Add an optional, Bobbit-owned author envelope:

```ts
export type MessageAuthorKind = "user" | "agent" | "system";

export interface MessageAuthor {
  kind: MessageAuthorKind;
  id: string;
  label: string;
}
```

The field is additive and optional. `role` continues to control Pi/provider semantics and rendering. `author` answers only who is accountable for the Bobbit-visible row.

Required outcomes:

- human prompts/steers resolve to `user`;
- model responses resolve to the target session's `agent` identity;
- server notifications, nudges, hidden context, and extension writes resolve to `system`;
- agent-to-agent prompts resolve to the calling session's `agent` identity;
- tool results never introduce a fourth author kind;
- live events and reloaded snapshots converge on the same author;
- old sessions with no author data remain readable and receive safe inferred authors;
- ordinary single-human chat remains visually unchanged.

## 2. Current architecture and constraints

### 2.1 Message ownership

Pi 0.80.6 owns the canonical agent JSONL and its provider-facing message types. Bobbit must not add arbitrary fields to the Pi transcript or rely on Pi preserving them. The relevant Bobbit paths are:

- live RPC events: `src/server/agent/session-manager.ts::handleAgentLifecycle`, `emitAgentEvent`, and `emitSessionEvent`;
- live WS envelopes: `src/server/ws/protocol.ts::ServerMessage` (`type: "event"`);
- snapshots: `src/server/ws/handler.ts::case "get_messages"`;
- in-flight rows: `src/server/agent/splice-inflight-message.ts::{spliceInFlightMessage,spliceInFlightSteers}`;
- queue persistence: `src/server/ws/protocol.ts::QueuedMessage`, `src/server/agent/prompt-queue.ts::PromptQueue`, and `src/server/agent/session-store.ts::PersistedSession.messageQueue`;
- restore: `src/server/agent/session-manager.ts` constructs `new PromptQueue(ps.messageQueue)` for dormant/live restore;
- archived history: `src/server/agent/session-manager.ts::getArchivedMessages`;
- transcript tools and pre-compaction history: `src/server/agent/transcript-reader.ts::{readTranscript,readOrphanedBeforeCompaction}`;
- UI state: `src/app/remote-agent.ts` and `src/app/message-reducer.ts`;
- rendering: `src/ui/components/{Messages,MessageList}.ts`.

`AgentMessage` and Pi `Message` remain role unions (`user`, `assistant`, `toolResult`, plus Bobbit custom roles). Bobbit should use an intersection type rather than changing those role unions.

### 2.2 Existing provenance

`src/server/agent/session-manager.ts::PromptSource` is internal delivery provenance. Move its declaration to dependency-neutral `src/shared/prompt-source.ts` and re-export it from `session-manager.ts`, so `ws/protocol.ts`, queues, and server delivery code share one union without a protocol -> session-manager runtime cycle:

```ts
type PromptSource =
  | "user"
  | "auto-nudge"
  | "task-notification"
  | "verification"
  | "system"
  | "agent"
  | "child-complete"
  | "extension";
```

It controls idle-nudge backoff through `SessionInfo.lastPromptSource`; it is not the public author model. Preserve all values and existing backoff behavior. Add an explicit mapping rather than collapsing or renaming `PromptSource`.

### 2.3 Sidecar precedent

Bobbit already keeps host-side metadata outside Pi JSONL:

- `<stateDir>/skill-sidecar/<sessionId>.jsonl` in `src/server/skills/skill-sidecar.ts`;
- `<stateDir>/compaction-sidecar/<sessionId>.jsonl` in `src/server/agent/compaction-sidecar.ts`;
- `<agent-jsonl-stem>.bobbit.json` in `src/server/agent/session-sidecar.ts`.

Author persistence must follow the first two for sandbox safety: use the Bobbit session id and the host state directory, never the possibly in-container transcript path.

## 3. Design decisions

1. **One public field:** Bobbit-visible message objects may carry `author?: MessageAuthor`. No provider `name`, source header, or text prefix is added.
2. **Three accountable kinds only:** tools and extensions are not kinds. An extension session write is a system action with a more specific system id. A tool result inherits an accountable user/agent/system identity.
3. **Prompt authors are persisted outside Pi:** queue rows carry authors while waiting; dispatched prompt authors are written to an author sidecar for transcript/snapshot recovery.
4. **Assistant authors are deterministic:** model messages derive from session metadata and do not require sidecar storage.
5. **Normalization is the compatibility boundary:** every Bobbit-visible live event, snapshot, archived read, and transcript read runs through the same inference rules. Missing/corrupt sidecars degrade to inference, never to failure.
6. **No new visible chrome:** components accept the metadata but do not render a label for routine rows. Future ambiguity/detail surfaces can consume it without a transcript redesign.
7. **Server-derived identity only:** callers cannot submit an author over browser/REST protocol. The server derives the human fallback, authenticated caller session, or extension surface identity.

## 4. Types and identity construction

### 4.1 Shared types

Add `src/shared/message-author.ts`:

```ts
export type MessageAuthorKind = "user" | "agent" | "system";

export interface MessageAuthor {
  kind: MessageAuthorKind;
  id: string;
  label: string;
}

export type BobbitMessage<T extends object = Record<string, unknown>> =
  T & { author?: MessageAuthor };

export const LOCAL_USER_AUTHOR: MessageAuthor = {
  kind: "user",
  id: "user:local",
  label: "User",
};
```

Also export `isMessageAuthor(value): value is MessageAuthor`, which validates the kind and non-empty bounded strings before data crosses trust/storage boundaries. Do not add `author` to Pi package declarations.

Use `BobbitMessage<AgentMessage>` in `MessageList`, `RemoteAgent` state, and renderer properties. Custom Bobbit message interfaces (`UserMessageWithAttachments`, `ArtifactMessage`, `SystemNotificationMessage`, and `MutationPendingMessage`) receive `author?: MessageAuthor` where they are independently referenced.

### 4.2 Agent identity

Add pure/server helpers in `src/server/agent/message-author.ts`:

```ts
agentAuthorForSession(
  session: Pick<SessionInfo, "id" | "title" | "role" | "staffId">,
  deps?: {
    getStaff?: (id: string) => PersistedStaff | undefined;
    getRole?: (name: string) => Role | undefined;
  },
): MessageAuthor
```

Identity rules, in priority order:

- staff session: `id: "staff:<staffId>"`, label from `PersistedStaff.name`;
- other session: `id: "session:<session.id>"`;
- non-staff label: non-empty `session.title`, then role label, then role name, then `"Agent"`.

The id never depends on a mutable title. Archived reads use the equivalent fields from `PersistedSession`.

### 4.3 System identity

Core-generated content uses:

```ts
{ kind: "system", id: "system:bobbit", label: "Bobbit" }
```

Specific identities are allowed when the producer is known:

- extension write: `system:extension:<encoded-pack-id>:<encoded-tool>`, label from the pack contribution label when available, otherwise `<packId>/<tool>`;
- hidden provider context: `system:bobbit:dynamic-context`, label `"Bobbit context"`;
- mixed-author batch assembled by Bobbit: `system:bobbit:batch`, label `"Bobbit"`.

Ids must use a shared sanitizer (lowercase where identity is case-insensitive, replace unsafe separators, and cap each component) so sidecars/search cannot receive unbounded or path-shaped identity strings.

### 4.4 PromptSource mapping

Export and unit-test:

```ts
export function authorKindForPromptSource(source: PromptSource): MessageAuthorKind {
  if (source === "user") return "user";
  if (source === "agent") return "agent";
  return "system";
}
```

`resolvePromptAuthor(source, context)` applies that mapping:

- `user` -> `LOCAL_USER_AUTHOR`;
- `agent` -> authenticated caller/owner session author; if caller identity is unexpectedly unavailable, fall back to `system:bobbit` rather than inventing an agent id;
- all notification/retry/orchestration sources -> Bobbit system author;
- `extension` -> the extension-specific system author supplied by the surface-token handler.

The `PromptSource` mapping does not change the separate nudge-counter reset table.

## 5. Author sidecar

### 5.1 Location and module

Add `src/server/agent/author-sidecar.ts` with:

- `initAuthorSidecarDir(stateDir, { secretsDir, hmacKey })`;
- `appendPromptAuthorDispatch(sessionId, record)`;
- `appendPromptAuthorSettlement(sessionId, settlement)`;
- `readAuthorSidecar(sessionId)`;
- `mergeAuthorSidecarIntoMessages(entries, messages, context)`;
- `copyAuthorSidecar(fromSessionId, toSessionId, { transcript })`;
- `purgeAuthorSidecar(sessionId)`.

Storage is `<serverSecretsDir>/author-sidecar/<sanitized-sessionId>.jsonl`, outside project roots, with `0700` directory and `0600` file modes on POSIX. `src/server/server.ts` initializes it with stable private key material. Startup migrates former `<stateDir>/author-sidecar` v1 plaintext ledgers to v2 and removes each reachable source only after preservation.

### 5.2 Versioned append-only schema

Use two v2 line variants:

```ts
interface PromptAuthorDispatchRecord {
  schemaVersion: 2;
  type: "prompt-author";
  promptId: string;             // queue id, steer-batch id, or generated direct id
  dispatchedAt: number;         // epoch ms
  modelTextDigest: string;      // domain-separated keyed HMAC; never plaintext
  source: PromptSource;
  author: MessageAuthor;
}

interface PromptAuthorSettlementRecord {
  schemaVersion: 2;
  type: "prompt-author-settlement";
  promptId: string;
  settledAt: number;
  outcome: "echoed" | "cancelled";
  messageId?: string;     // Pi-visible message id when available
  messageTimestamp?: number;
}
```

Rationale:

- dispatch records are appended immediately before the RPC call, closing the crash window before Pi echoes/persists the row;
- a rejected RPC appends `cancelled`, preventing a stale identical text from claiming a later prompt;
- a matching live user `message_end` appends `echoed` and records Pi's id/timestamp when available;
- redispatch can reuse the same queue/batch `promptId`; readers fold by prompt id and use the latest dispatch plus latest settlement;
- malformed lines, unknown versions/types, invalid authors, and settlements without a dispatch are skipped.

Do not store prompt plaintext, images, attachments, or rewritten display text. In-memory call inputs still contain exact `modelText`, but persistence immediately replaces it with a keyed digest derived from stable private server key material. Runtime sidecar I/O is best-effort: log and continue with inference if append/read fails. Legacy plaintext removal during startup migration fails closed.

### 5.3 Matching algorithm

`readAuthorSidecar` folds records into active and echoed prompt-author bindings. Snapshot/transcript merge matches user-prompt rows in this order:

1. exact `message.id === settlement.messageId`;
2. exact message timestamp/settlement timestamp within 2 seconds plus keyed text-digest equality;
3. keyed text-digest equality, FIFO by `dispatchedAt`, consuming each sidecar record once.

Live and restore replay additionally use stable occurrence keys from Pi id aliases on either the message or outer event. A keyed occurrence retains one binding across updates and repeated terminal frames, so a duplicate cannot advance to the next same-text prompt.

Array-shaped Pi user content must be reduced to the exact dispatched text sequence before digest comparison. Concatenate ordered text-block fragments without inserting separators; ignore image and other non-text blocks only for correlation. Never rewrite or flatten the original content array. This keeps adjacent split text blocks digest-equivalent to the original model text.

Legacy replay may provide neither id nor timestamp. For the bounded `switch_session` replay window, retain an ordered cursor of every non-cancelled sidecar occurrence, including settled rows. A keyless user occurrence selects the first remaining same-text binding by dispatch order. On its `message_end`, remove that exact binding from the cursor but retain it as the last-terminal guard. A repeated end with no intervening start reuses the guard and remains idempotent; the next user `message_start` clears the guard and permits the next same-text occurrence to advance.

This boundary preserves both safety and liveness. A settled historical end cannot settle or consume the steer ledger for a newer crash-unsettled occurrence. If replay then emits a new start and that newer end, it receives the newer author, settles once, and is not requeued. If the newer occurrence never appears, its ledger row remains unresolved and is requeued unchanged. Outside replay, accepting a new dispatch clears the live terminal guard so a genuine later echo can bind it.

In force-abort recovery, hydrate the independent restore-only cursor immediately before replay and clear both cursor and terminal guard on every replay exit so neither can shadow later live input. These are in-memory correlation state: they add no v2 sidecar fields or record variants, synthesize no Pi ids, and change neither Pi JSONL nor model/provider roles, content, or schemas.

Cancelled records never match. Snapshot/transcript duplicates remain distinct because matching consumes a multiset, not a `Set`. When compaction removes an earlier duplicate, timestamp/id binding prevents the retained duplicate from consuming the removed prompt's author. The merge clones only changed message objects and is idempotent.

## 6. Queue and in-flight state

### 6.1 QueuedMessage

Extend `src/server/ws/protocol.ts::QueuedMessage`:

```ts
source?: PromptSource;
author?: MessageAuthor;
```

`source` is optional because old `sessions.json` rows lack it. `author` is optional on the wire and disk for backward compatibility.

Update `PromptQueue.enqueue` and `enqueueAtFront` to accept/copy both fields. `steer`, remove, reorder, `toArray`, and the `SessionStore` need no special serialization because they already preserve the whole row. Constructor normalization validates present authors; old rows default at dispatch to `source: "user"` and `LOCAL_USER_AUTHOR`.

`SessionManager.enqueuePrompt`, `deliverLiveSteer`, and `enqueuePromptForRetryRecovery` resolve author once at acceptance and put both `source` and `author` on every queued row. `drainQueue` sets `session.lastPromptSource` from the dequeued row (not whichever unrelated prompt most recently touched the session) and dispatches with that row's author.

### 6.2 Structured in-flight steers

The current persisted `inFlightSteerTexts?: string[]` loses identity. Keep the property name for disk compatibility but widen its element shape:

```ts
export interface InFlightSteerRecord {
  text: string;
  promptId: string;
  source?: PromptSource;
  author?: MessageAuthor;
}

type PersistedInFlightSteer = string | InFlightSteerRecord;
```

At restore, normalize legacy strings to records with `source: "user"` and local-user author. Runtime `SessionInfo` should use `InFlightSteerRecord[]`; only the `PersistedSession` boundary accepts strings. Update `_dispatchSteer`, `_consumeSteerEcho`, `_reconcileAfterAbort`, `persistInFlightSteerLedger`, and `spliceInFlightSteers` to operate on records.

For a steer batch:

- preserve the existing joined text and single Pi RPC, so model behavior is byte-equivalent;
- if all rows have the same author, retain it;
- if authors differ, use `system:bobbit:batch` because Bobbit assembled one indivisible Pi message from multiple accountable inputs;
- generate a deterministic `promptId` from the ordered queue ids so retry/reconcile reuses the sidecar binding.

`spliceInFlightSteers` copies `record.author` to its synthetic `role: "user"` row. Thus a `get_messages` call during the dispatch-to-echo gap exposes the same identity as the eventual live echo.

### 6.3 Runtime pending bindings

Add `SessionInfo.pendingPromptAuthors?: PromptAuthorDispatchRecord[]`. Every direct/queued/steer dispatch pushes a record before invoking Pi and appends it to the sidecar. A user-role event first reuses its stable id/timestamp occurrence binding; exact text is the ordered fallback only when Pi supplies no key. A newly resolved `message_end` stamps the cloned visible event, appends an `echoed` settlement, and consumes only the matching pending record. Rejection removes that record and appends `cancelled`.

Restore also hydrates settled occurrence bindings and the bounded keyless replay cursor described in §5.3. `_consumeSteerEcho` acts on the correlated `promptId` and ignores already-settled duplicate terminal frames. Each terminal removes only its cursor occurrence; a new `message_start` is the keyless occurrence boundary that permits the next same-text binding to advance. Keep this independent of `pendingSkillExpansions`; both may match the same echo. Skill rewriting and author stamping must be applied to the same cloned event without either helper discarding the other's fields.

Hard force-abort must not drain the in-flight steer ledger when the old bridge stops: Pi may have persisted a terminal echo that the detached listener never saw. The replacement hydrates sidecar bindings immediately before `switch_session`, prunes ledger rows already settled as echoed, and prepares each replay event through the normal author boundary before passing it only to `_consumeSteerEcho`. Staged startup and replay remain invisible—no activity, lifecycle, event-buffer, cost, or broadcast effects.

When the bounded replay exits, clear `promptAuthorReplayBindings` and `lastKeylessPromptAuthorEnd` in a `finally` path. Then reconcile only the remaining ledger rows: cancel their stale dispatch bindings, requeue them at the front with original text/source/author, and leave dispatch to the replacement coordinator after the final bridge commits. Replacement failure performs the same reconciliation and guard cleanup so accepted intent survives for a later recovery without leaking replay guards into live traffic.

## 7. Live event flow

### 7.1 Single normalization chokepoint

Add to `src/server/agent/message-author.ts`:

```ts
normalizeVisibleAgentEvent(session, event, deps): unknown
normalizeVisibleMessage(message, context): BobbitMessage
normalizeVisibleMessages(messages, context): BobbitMessage[]
```

All `rpcClient.onEvent` subscriptions in `session-manager.ts` and `session-setup.ts` must normalize once before lifecycle tracking and emission. A small `SessionManager.prepareVisibleAgentEvent(session, rawEvent)` method prevents the restore, role-switch, external-session, refresh, and respawn listeners from drifting.

Order:

1. clone/stamp author on message-bearing events;
2. pass the normalized event to `handleAgentLifecycle` so `latestMessageUpdate` stores the authored message;
3. truncate large content;
4. apply the existing skill/file-mention splice while retaining `author`;
5. `emitSessionEvent` buffers and broadcasts the authored event.

`message_update` and final assistant `message_end` both receive the same `agentAuthorForSession(session)`. Since EventBuffer stores the normalized event, resume replay also preserves authors.

Server-synthesized message events that bypass `rpcClient.onEvent` must provide a validated author explicitly. In particular, `src/server/agent/session-setup.ts::handleSetupFailure` currently calls `emitSessionEvent` with a synthetic `role: "assistant"` error; stamp it with `system:bobbit` before emission so it is not inferred as model-authored. Keep `emitSessionEvent`'s input type permissive for non-message lifecycle events, but assert in tests that every server-created message-bearing event is authored.

### 7.2 Message inference rules

Apply rules in this order:

1. `customType === "bobbit:dynamic-context"`, `display === false` dynamic context, Bobbit `system-notification`, mutation/setup/retry notification rows, and compaction synthetic rows -> system;
2. assistant/model message -> session agent;
3. ordinary user/user-with-attachments echo -> matched pending/sidecar author, else local user;
4. message-level `toolResult`, `tool_result`/`tool` aliases, or a provider-history `role: "user"` message whose meaningful content consists only of tool-result blocks -> closest preceding accountable author, normally the preceding assistant agent; if no predecessor is available, use the session agent;
5. unknown Bobbit-created custom rows -> system unless their creator supplied a validated author.

Detection of tool-result blocks must recognize the same shapes already handled by `transcript-reader.ts` and `tool-result-error-normalizer.ts`: `toolResult`, `tool_result`, `tool`, and block-level `tool_result`/`toolResult`. It must never emit `kind: "tool"`.

## 8. Snapshot and transcript flow

### 8.1 Central snapshot pipeline

Create `src/server/agent/visible-message-snapshot.ts` so every client snapshot uses one pipeline rather than duplicating logic in WS and session-manager call sites:

```text
Pi snapshot
  -> normalizeToolResultErrorSnapshot
  -> spliceInFlightMessage
  -> spliceInFlightSteers
  -> mergeCompactionSidecarIntoMessages
  -> mergeAuthorSidecarIntoMessages + infer remaining authors
  -> truncateLargeToolContentInMessages
  -> mergeSkillSidecarEntriesIntoMessages
  -> stampSnapshotOrder (WS boundary only)
```

Author merge runs before skill display-text rewriting because the sidecar key is a keyed digest of exact `modelText`. Existing `author` fields survive truncation and skill rewriting via object spread.

Use the helper from:

- `src/server/ws/handler.ts::case "get_messages"` for active sessions;
- `src/server/agent/session-manager.ts::refreshAfterCompaction`;
- role-switch/refresh message broadcasts in `session-manager.ts`;
- archived `get_messages` after `getArchivedMessages` parses envelopes;
- any attach/reconnect branch that emits `type: "messages"`.

Title generation (`generateSessionTitle`) continues to use raw Pi messages; it does not need author metadata.

### 8.2 Archived messages

Refactor `SessionManager.getArchivedMessages` to retain each JSONL envelope's outer `id` and timestamp during normalization, even though the returned visible message keeps the same Pi role/content shape. Pass persisted session metadata and author-sidecar entries to `normalizeVisibleMessages`, then discard any private correlation-only fields before WS send.

Archive is soft deletion, so retain the author sidecar. Hard purge/termination cleanup invokes `purgeAuthorSidecar` beside transcript/session-sidecar cleanup.

### 8.3 Transcript reader and pre-compaction history

Extend `CompactMessage` and `VerboseMessage` in `src/server/agent/transcript-reader.ts` with `author?: MessageAuthor`. When `VerboseMessage.message` is included, place the same author on that message object so `<message-list>` receives it.

Extend `ReadTranscriptOptions` and `ReadOrphanedOptions` with an optional author-resolution context containing:

- Bobbit session/persisted-session identity fields;
- folded author-sidecar entries.

`parseJsonl` already retains `entryId`, timestamp, role, and `fullMessage`; use those fields for sidecar correlation. `readTranscript` and `readOrphanedBeforeCompaction` run sequential author normalization over the selected transcript ordering before compact/verbose projection. Direct library callers that omit context keep today's output except for safely inferred `user`/`system` where session-independent; server routes always supply context.

The REST response remains additive. Older clients ignore `author`.

### 8.4 Fork and continue

The fork and continue routes in `src/server/server.ts` copy Pi JSONL at the `destJsonl` paths around the existing `sessionFileCopy` calls. After the destination Bobbit session id is known, call `copyAuthorSidecar(sourceSessionId, destinationSessionId, { transcript: clonedTranscript })`. Copy only echoed bindings confirmed in that transcript; unresolved/cancelled source dispatches must not enter the destination ledger. Failure is non-fatal and produces legacy inference on the clone. Failed-fork cleanup removes the destination author sidecar together with cloned transcript state.

### 8.5 Search

Search role/weight behavior remains unchanged. Add author metadata only:

- `src/server/search/sources/message-source.ts` streams each session transcript and loads/folds its author sidecar once;
- `src/server/search/search-service.ts::indexMessage` reads a validated `message.author` on live indexing;
- emitted `Indexable.metadata` gains `authorKind`, `authorId`, and `authorLabel` when available;
- all searchable blocks extracted from one normalized message inherit that message's resolved author.

Transcript size must not force full-history buffering or discard attribution. Use a bounded two-pass correlation helper in `author-sidecar.ts`: pass one streams rows to reserve settled message-id and timestamp-plus-digest matches globally; pass two revalidates reservations and consumes remaining eligible keyless settlements by dispatch-ordered FIFO. This preserves exact sidecar authors for oversized transcripts while retaining only compact binding references and at most one row-index reservation per binding. Raw JSON lines, message bodies, images, attachments, and tool payloads do not survive between streamed rows.

Keep matching authority narrow:

- discard every transcript-provided `author` before normalization;
- exclude cancelled bindings;
- permit digest/FIFO matching only for echoed bindings;
- permit an unresolved binding only when the row carries Bobbit's exact synthetic `inflight-steer:<promptId>` identity;
- reserve later exact id/timestamp bindings before any earlier same-text row can consume FIFO.

Cap compact binding state by both count and estimated bytes. If either cap is exceeded, abandon sidecar correlation atomically for that session but continue indexing its entire transcript. In this explicit degraded state, omit `authorKind`, `authorId`, and `authorLabel` from ambiguous user-role rows; do not infer or fabricate `user:local`, and never restore a forged transcript author. This differs from a legacy session with no sidecar: ordinary read-time legacy fallback remains valid when Bobbit has no authoritative binding set, whereas an over-budget set is known to exist but cannot be correlated safely within the memory bound. Deterministic non-ambiguous authors may still be derived where the normal rules establish them independently.

Do not add author labels to indexed message text, snippets, weights, or content hashes. No search schema version bump is required because metadata is schemaless, but a normal rebuild/backfill should populate it for existing rows. If the index cannot access a sandbox transcript or sidecar, retain current indexing behavior without sidecar metadata.

## 9. Prompt producer audit

Every producer must pass the correct `PromptSource` and, for agent/extension relays, server-derived identity context.

### Human (`user`)

- `src/server/ws/handler.ts` cases `prompt` and `steer`;
- `src/server/server.ts` ask-response submit (`enqueuePrompt(sessionId, envelope)`), because the answers are human input;
- user-operated team steer endpoints only when the authenticated request is from the app rather than an agent tool.

Optimistic client rows in `src/app/remote-agent.ts::{prompt,steer}` must include `LOCAL_USER_AUTHOR` so the first paint and server echo agree.

### Agent relay (`agent`)

- `src/server/server.ts` `/api/sessions/:id/prompt`: derive caller from `X-Bobbit-Session-Secret` and use that caller session's agent author;
- `src/server/server.ts` team prompt/steer routes invoked by the team tools: derive the caller with existing session authentication, never from body fields;
- `src/server/agent/orchestration-core.ts::{spawn,prompt,steer}`: initial child instructions and follow-ups are authored by `ownerSessionId`;
- `src/server/agent/session-prompt-delivery.ts` threads `source` and resolved `author` through normal, steer, and errored-recovery queue paths.

### System

Explicitly correct current default-`user` internal paths:

- `src/server/agent/inbox-nudger.ts::applyPolicyThenNudge` -> `source: "system"`;
- `src/server/agent/team-manager.ts::notifyTeamLeadOfSpecChange` -> `source: "system"`;
- `src/server/agent/nested-goal-routes.ts` parent pause/replan notification -> `source: "system"` or `"child-complete"` as appropriate;
- existing auto nudge, task completion, child completion, verification, and orchestration reminder calls retain their specific non-user `PromptSource`;
- restart/retry/setup-failure continuations use `source: "system"` even if their Pi transport remains user-role.

### Extension system identity

In `src/server/ws/handler.ts::ext_session_post`, the server already resolves trusted `surf.packId` and `surf.tool`. Construct the extension system author there and pass it through both `enqueuePrompt` and `deliverLiveSteer`. `postMsg.role` remains a framing/display choice and does not make the browser extension a human author. No caller-supplied pack/tool/author is trusted.

## 10. UI behavior

Update client mirrors in:

- `src/app/remote-agent.ts::QueuedMessage`;
- `src/ui/components/MessageEditor.ts::QueuedMessage`;
- `src/app/message-reducer.ts::OrderedMessage`;
- `src/ui/components/Messages.ts` and `MessageList.ts` message property types.

Reducers already preserve unknown object fields through spread/replacement; add assertions so author survives optimistic replacement, live `message_end`, snapshot merge, and in-flight streaming state. Dedup keys remain role/content/id based; author must not split otherwise-equivalent rows during optimistic-to-server reconciliation.

Do not add badges or per-bubble author text. Existing user, assistant, tool, artifact, permission, and system renderers remain visually identical. Detail/diagnostic code may inspect `message.author` programmatically.

`defaultConvertToLlm` and `customConvertToLlm` must strip Bobbit-only `author` before returning Pi `Message` objects. This is a defensive guarantee that future local-agent use cannot accidentally forward metadata, while current text/role/content bytes remain unchanged.

## 11. Failure handling and backward compatibility

- `author` remains optional in every persisted/wire/client type.
- Old queued rows and legacy in-flight steer strings normalize to local user; no migration is required.
- Old transcript rows infer by role/content. Assistant -> session agent; ordinary user -> local user; hidden/custom -> system; tool result -> preceding/session agent.
- Missing, empty, corrupt, partially written, or future-version author sidecars are treated as absent. Log bounded warnings and continue.
- A sidecar append failure affects only author precision after reload; live normalization still stamps the event.
- Sidecar data never gates prompt dispatch, retry, restore, archive, compaction, transcript reading, or search.
- Search-side compact binding overflow is fail-safe: continue indexing, but omit unknown user-role attribution rather than claiming local-human authorship from an authoritative set that could not be correlated.
- Do not rewrite existing Pi JSONL files. Backfill is read-time normalization; the first search rebuild may persist only derived search metadata.
- Unknown/invalid incoming `author` fields from Pi transcript data are not authoritative. Strip them before search/transcript normalization and replace them only with Bobbit-derived values from a validated sidecar/live path or an unambiguous inference rule.
- IDs/labels are metadata, not authorization principals. Existing session secrets, surface tokens, and REST authorization remain the authority.

## 12. Implemented module map

| Path | Responsibility |
|---|---|
| `src/shared/message-author.ts` | Public types, constants, guards, and the `BobbitMessage` intersection. |
| `src/shared/prompt-source.ts` | Dependency-neutral home for the unchanged eight-value `PromptSource` union; `session-manager.ts` re-exports it for compatibility. |
| `src/server/agent/message-author.ts` | Identity construction, PromptSource mapping, tool-result detection, and event/message normalization. |
| `src/server/agent/author-sidecar.ts` | Host-side versioned JSONL dispatch/settlement persistence, split-block text correlation, bounded stream resolution, and merge/copy/purge operations. |
| `src/server/agent/visible-message-snapshot.ts` | Shared snapshot pipeline for active, refresh, role-switch, and archived paths. |
| `src/server/ws/protocol.ts` | Optional `source`/`author` fields on `QueuedMessage`. |
| `src/server/agent/prompt-queue.ts` | Author/source preservation through enqueue, promotion, and restore. |
| `src/server/agent/session-store.ts` | Back-compatible structured in-flight steer persistence. |
| `src/server/agent/session-manager.ts` | Author-aware acceptance, dispatch, event normalization, snapshot integration, restore, and cleanup. |
| `src/server/agent/session-setup.ts` | Bobbit system identity on server-synthesized setup failures. |
| `src/server/agent/session-prompt-delivery.ts` | Resolved author propagation through prompt, steer, and recovery delivery. |
| `src/server/agent/splice-inflight-message.ts` | Authored in-flight assistant/steer snapshot rows and legacy ledger compatibility. |
| `src/server/agent/transcript-reader.ts` | Optional authors in compact/verbose and legacy/pre-compaction projections. |
| `src/server/ws/handler.ts` | Authored snapshots and trusted human/extension author context. |
| `src/server/server.ts` | Sidecar lifecycle, agent relay identity, producer provenance, and fork/continue handling. |
| `src/server/agent/{team-manager,inbox-nudger,nested-goal-routes,orchestration-core}.ts` | Correct producer sources and trusted caller identities. |
| `src/server/search/{search-service.ts,sources/message-source.ts}` | Streamed, bounded author metadata indexing without text or role-weight changes. |
| `src/app/{remote-agent,message-reducer,custom-messages}.ts` | Client types, optimistic/system authors, preservation, and provider-conversion stripping. |
| `src/ui/components/{Messages,MessageList,MessageEditor}.ts` | Author-aware types without label rendering. |

Avoid a broad Pi type augmentation and avoid adding author fields to client command payloads.

## 13. Deterministic verification strategy

The author contract crosses storage, RPC events, WebSocket snapshots, client reconciliation, and rendering. Its tests therefore verify convergence across those boundaries, but avoid making identity correctness depend on an external model, provider credentials, host filesystem timing, or wall-clock sleeps.

### 13.1 Pure and persistence contracts

Core tests exercise identity construction, all `PromptSource` mappings, legacy inference, tool-result inheritance, queue restore, in-flight splices, and sidecar correlation as pure transformations where possible. Sidecar and transcript cases use a scoped in-memory filesystem. Unexpected filesystem access fails the test, which both removes host I/O variance and proves that the intended Bobbit-owned persistence boundary is the only one used.

The persistence cases deliberately include corrupt and future-version records, cancellation, redispatch, repeated identical text, id-priority matching, timestamp disambiguation, adjacent split text blocks, copy/purge, and legacy rows. The split-block case asserts separator-free digest correlation while retaining the original content array. These are the ambiguous cases most likely to make live and restored attribution diverge or accidentally change provider-visible content.

Session lifecycle tests use mocked RPC methods, deferred promises, and a manual clock. They drive dispatch, echo, rejection, retry, abort, and restore seams directly rather than waiting for child processes or real timers. Regressions pin four keyless occurrence boundaries: a newly accepted same-text dispatch supersedes the prior live terminal binding; an immediate duplicate terminal with no newer start remains idempotent; replay containing only an old settled occurrence leaves a newer prompt pending for unchanged requeue; and replay containing old then newer occurrences advances at `message_start`, settles the crash-unsettled newer prompt exactly once, and does not requeue it. The assertions also keep message role and content unchanged.

### 13.2 Client and search boundaries

DOM tests run the real reducer and conversion helpers under Happy DOM. They prove that optimistic human authors are replaced by authoritative server authors without changing role/text deduplication, that snapshots and live assistant rows retain authors, and that model conversion strips Bobbit-only metadata.

Search-source tests normalize transcripts through the real streamed indexing source. They assert author metadata separately from indexed text, weights, and hashes; reserve later exact bindings ahead of same-text FIFO; preserve exact authors for oversized rows without retaining attachments; strip forged transcript authors; and force compact binding overflow to prove ambiguous user-role metadata is omitted while all rows are still indexed.

### 13.3 Gateway convergence

The gateway integration suite runs in process with the mock agent bridge. Each bridge gets a session-local virtual clock, rather than advancing the gateway's shared clock or sleeping, so settling one prompt cannot fire unrelated session timers. The tests send real WebSocket commands and assert:

- human and server-generated prompt authors on live events;
- assistant identity on the same exchange;
- unchanged Pi roles and exact message text;
- equality between live events, `get_messages`, and reconnect snapshots.

Restart-sensitive steer coverage targets the durable seam rather than restarting an operating-system process: it leaves accepted steers in the persisted in-flight ledger, removes the live session, and restores through `SessionManager`. The tests cover a fresh mock-bridge echo, replay containing only an older settled keyless same-text occurrence, and replay that advances through old and crash-unsettled occurrences. They assert both safe unchanged requeue when the newer echo is absent and exact-once settlement without requeue when its occurrence is present, without conflating persistence with process startup noise.

Producer-focused seam tests separately pin trusted agent/system source forwarding for team, inbox, and orchestration paths; pure tests pin extension identity construction from trusted pack/tool metadata. Keeping those decisions close to each producer makes attribution regressions fail at their origin rather than only in an end-to-end transcript.

### 13.4 Browser acceptance

The Chromium journey covers the user-visible invariant that lower-level tests cannot: a normal prompt and assistant response expose stable authors in client state before and after reload, while ordinary one-human bubbles gain no author label. It waits on authored application state and idle status instead of selecting an arbitrary assistant row or sleeping for a model response.

### 13.5 Gate ownership

The dedicated pure, DOM, and in-process gateway tests run in the unit gate; the authored reload journey runs in the browser gate. The full E2E gate remains the broader regression owner when session restore, queue persistence, or extension delivery changes. This split keeps the author contract fast and deterministic without replacing the repository's real process-level coverage.

## 14. Acceptance traceability

| Acceptance criterion | Design mechanism |
|---|---|
| Correct live user/assistant/system kinds | PromptSource mapping + single live normalization chokepoint (§4.4, §7). |
| Legacy sessions load/render/search | Optional types + read-time inference + sidecar failure fallback (§8, §11). |
| Server prompts distinguishable from humans | Corrected producer audit + prompt-author sidecar (§5, §9). |
| Tool is not an author kind | Three-kind type and tool-result inheritance rules (§3, §7.2). |
| In-flight steer/assistant snapshots authored | Structured steer ledger + normalized `latestMessageUpdate` (§6, §7). |
| Reload matches live stream | EventBuffer normalization + centralized snapshot/sidecar merge (§7, §8). |
| UI remains uncluttered | Type-only UI change; no label rendering (§10). |
| Provider behavior unchanged | No transcript mutation/text prefix/provider-name mapping; defensive conversion stripping (§3, §10). |
| Bobbit-owned/additive persistence | Host-side versioned author sidecar and optional queue fields (§5, §6). |
