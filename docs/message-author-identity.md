# Message author identity

Bobbit attaches accountable author metadata to messages that cross its server, search, transcript, and browser boundaries. This answers **who caused a visible message** without changing the message's Pi role, content, rendering category, or model semantics.

The metadata is Bobbit-owned. Pi transcripts and provider requests remain the source of truth for conversation content; Bobbit stores prompt attribution separately and derives safe values when older data has none.

## Public model

The shared contract is defined in `src/shared/message-author.ts`:

```ts
export type MessageAuthorKind = "user" | "agent" | "system";

export interface MessageAuthor {
  kind: MessageAuthorKind;
  id: string;
  label: string;
}

export type BobbitMessage<T extends object = Record<string, unknown>> = T & {
  author?: MessageAuthor;
};
```

`author` is optional at persistence, wire, transcript-reader, and client boundaries. This is intentional: sessions created before author metadata was introduced remain valid and are normalized when read.

The three kinds are deliberately small:

- `user` — a human. Local Bobbit uses `{ kind: "user", id: "user:local", label: "User" }`.
- `agent` — an LLM-backed Bobbit session, including staff, team, delegate, reviewer, and other agent sessions.
- `system` — Bobbit-generated or extension-generated session input and Bobbit UI notifications.

Tools and extensions are not additional author kinds. Extensions act through Bobbit and therefore use `system`; tool output inherits an accountable `user`, `agent`, or `system` author.

Author metadata received from storage or wire data is accepted only when its kind is valid and its `id` and `label` are bounded, non-empty strings. Invalid metadata is discarded before normalization.

## Author and role are independent

Pi roles still describe the message's protocol and rendering shape: `user`, `assistant`, `toolResult`, and Bobbit custom roles keep their existing meanings. `author` describes accountability.

Consequently:

- an ordinary browser prompt has `role: "user"` and `author.kind: "user"`;
- an agent-to-agent prompt is still delivered and echoed with `role: "user"`, but has `author.kind: "agent"`;
- a Bobbit notification or extension write can use the existing user-prompt transport while having `author.kind: "system"`;
- an assistant response normally has `role: "assistant"` and `author.kind: "agent"`;
- a synthesized setup failure may retain its existing assistant-shaped row while being authored by `system`.

Do not infer human authorship from `role: "user"`. Use `author.kind` when accountability matters, and continue to use `role` for rendering and provider semantics.

## Prompt provenance mapping

`PromptSource` remains the more granular internal delivery provenance. It is defined in `src/shared/prompt-source.ts` and mapped to the public kind as follows:

| `PromptSource` | Public kind | Typical producer |
|---|---|---|
| `user` | `user` | Browser prompt, steer, or ask response |
| `agent` | `agent` | Authenticated caller-session relay, owner-to-child prompt |
| `auto-nudge` | `system` | Team idle or watchdog nudge |
| `task-notification` | `system` | Task completion notice |
| `verification` | `system` | Verification result notice |
| `system` | `system` | Retry, restart, setup, orchestration, or context message |
| `child-complete` | `system` | Child-goal completion notice |
| `extension` | `system` | `host.session.postMessage` |

The server resolves the author from trusted call-site context. Browser prompt and steer frames cannot submit an author identity. An `agent` source without a valid trusted caller identity falls back to Bobbit's system identity rather than being misattributed to a human or fabricated agent.

## Stable identities

The construction helpers live in `src/server/agent/message-author.ts`.

### Users

Current local sessions use the stable fallback identity:

```ts
{ kind: "user", id: "user:local", label: "User" }
```

This leaves room for hosted human identities without changing the three-kind model.

### Agents

Agent identity uses `staff:<staffId>` when the session belongs to persisted staff; other sessions use `session:<sessionId>`. Components are sanitized before becoming metadata ids.

Labels prefer the staff name, then the session title, then the resolved role label or name, and finally `Agent`. The id is the durable key; labels are display metadata and can change as a session or staff record is renamed.

### Systems and extensions

Core Bobbit messages use `system:bobbit` with label `Bobbit`. Dynamic context uses `system:bobbit:dynamic-context`; a steer batch containing different accountable authors uses `system:bobbit:batch`.

Extension session writes use a server-derived identity:

```text
system:extension:<pack-id>:<tool-or-surface>
```

The fallback label is `<pack-id>/<tool-or-surface>`. The WebSocket handler derives both components from the server-minted surface token; it does not trust caller-supplied pack or tool identity. Both extension `role: "user"` and `role: "system"` writes are accountable to this `system` author. Existing extension delivery shaping, including the system-reminder framing for `role: "system"`, is unchanged by author metadata.

## Host-side author sidecar

Pi does not preserve arbitrary Bobbit fields reliably, and sandbox transcripts may live inside a container. Bobbit therefore never writes `author` into the Pi JSONL transcript. Prompt attribution is stored outside project roots in private server state at:

```text
<serverSecretsDir>/author-sidecar/<sessionId>.jsonl
```

The directory is owner-only (`0700`) and ledger files are owner-only (`0600`) on POSIX. Schema v2 dispatch records store `promptId`, dispatch time, a domain-separated keyed HMAC of the exact model text, `PromptSource`, and resolved author. They never store prompt plaintext. Settlement records mark prompts as `echoed` or `cancelled` and may include the echoed message id and timestamp. The HMAC subkey is derived from stable private server key material, so correlation remains stable across gateway restarts without exposing prompt text.

At startup, Bobbit migrates valid v1 rows from the former project-reachable `<stateDir>/author-sidecar` path into digest-only v2 records. It removes each plaintext source only after valid records have been preserved; malformed and partial rows degrade to inference. Failure to remove a reachable plaintext ledger fails startup closed. Pi JSONL is never read back into or rewritten by this migration.

A redispatch with the same prompt id replaces the earlier folded binding. Cancelled dispatches are never correlated to transcript rows. Runtime writes occur immediately before prompt or steer delivery and are best-effort. A write failure is logged but never delays or rejects delivery. Reads skip malformed lines, partial crash tails, invalid records, and unsupported schema versions. A missing or unreadable sidecar behaves like an empty sidecar and falls back to role/content inference.

Stable occurrence keys take precedence over text. Live and replayed events read Pi entry-id aliases from either the message or its outer event; once an occurrence is bound, its updates and duplicate terminal frames reuse that binding. Snapshot and transcript correlation then matches eligible user-role echoes by settled message id, timestamp plus keyed text digest, and finally FIFO keyed text digest. Tool-result-only user-role rows are excluded, and matching runs before display-text rewriting.

For array-shaped Pi user content, digest correlation reconstructs the dispatched text sequence without changing the message: ordered text-block fragments are concatenated with no inserted separator, while image and other non-text blocks are ignored only for matching. The original content array remains intact. This matters for prompts split across adjacent text blocks, where inserting a newline would produce a different digest and lose the sidecar author.

Legacy replay can contain user echoes with neither an id nor a timestamp. During the bounded `switch_session` replay, Bobbit therefore keeps a restore-only cursor over every non-cancelled sidecar occurrence, including settled rows. For each keyless user occurrence, the first remaining same-text binding in dispatch order wins. Its terminal frame removes that binding from the cursor, while a last-terminal guard keeps repeated `message_end` frames idempotent. The next user `message_start` clears that guard and advances the next occurrence, even when its text is identical.

This ordered boundary distinguishes a settled old occurrence from a crash-unsettled newer occurrence: replaying the old end cannot settle or remove the newer steer, but a later `message_start` followed by the newer end settles that newer prompt exactly once. If the newer occurrence is absent from replay, its ledger row remains unresolved and is requeued with its original text, source, and author. Outside replay, accepting a new dispatch clears the live last-terminal guard so its genuine echo can bind normally.

The replay cursor and terminal guard are runtime correlation state, not persisted data. Force-abort recovery hydrates them immediately before transcript replay and clears them when replay exits, whether successfully or by error. They add no sidecar fields or record types, synthesize no Pi ids, and change neither Pi events, transcript rows, prompt bytes, nor provider schemas.

Fork and continue operations copy only echoed bindings confirmed to exist in the cloned transcript. Unresolved and cancelled source dispatches are never copied, so a same-text prompt accepted later in the destination cannot inherit a foreign author. A hard purge removes the private ledger; ordinary archive operations retain it with the session history.

## Message lifecycle

### Acceptance, queue, and restore

`SessionManager` resolves `source` and `author` when it accepts a prompt. Both optional fields travel with `QueuedMessage`, are broadcast in `queue_update`, and persist in `PersistedSession.messageQueue`. `PromptQueue` validates restored metadata, preserves it through priority changes and recovery re-enqueues, and can recover a missing source from a valid author's kind. Legacy rows without either field retain the historical local-user default.

The in-flight steer ledger persists structured `{ text, promptId, source?, author? }` records until Pi echoes them or abort reconciliation returns them to the queue. Legacy string-only steer entries normalize as local-user prompts. When steers are combined into the existing newline-joined batch, a common author is retained; a mixed-author batch receives the Bobbit batch-system identity. The prompt text and batching behavior do not change.

A hard force-abort keeps this ledger intact after stopping the old bridge because an echo may already be durable even if the live listener missed it. Immediately before the replacement runs `switch_session`, Bobbit reloads author bindings, removes ledger rows already proven echoed by the sidecar, and enables the keyless replay guard. Replay events pass through normal author preparation, then only correlated steer-echo consumption; they do not update activity or lifecycle state and are not buffered, costed, or broadcast. After replay, abort reconciliation cancels and requeues only unresolved rows. The replacement coordinator drains them only after the final bridge commits; if replacement setup fails, the same reconciliation preserves them as queued intent for a later recovery.

### Live events

All message-bearing Pi `message_update` and `message_end` events pass through one normalization boundary before lifecycle tracking, buffering, replay, or broadcast. Assistant events receive the session agent identity. User-role echoes correlate by stable occurrence key when Pi supplies one, with exact model text used only for ordered fallback; a newly resolved terminal occurrence is then settled into the sidecar. Other visible rows use the inference rules below.

Because normalization happens before the event buffer and `latestMessageUpdate` tracking, reconnect replay and in-flight assistant snapshots preserve the same metadata as the original live stream.

### Snapshots

`src/server/agent/visible-message-snapshot.ts` is the shared pipeline for active, archived, reconnect, refresh, role-switch, and compaction snapshots. It:

1. normalizes tool-result error shapes;
2. splices the latest in-flight assistant row and un-echoed steer rows;
3. merges compaction history;
4. correlates the author sidecar and infers remaining authors;
5. truncates large tool display content;
6. applies slash-skill and file-mention display metadata;
7. stamps snapshot ordering metadata.

The result is Bobbit-visible data only and is never sent back to Pi. In-flight synthetic steer rows carry their ledger author when available; the later real echo replaces them through the normal client reducer path.

### Transcript and pre-compaction history

The transcript reader applies author correlation to the full ordered message sequence before filtering, pagination, or compact/verbose projection. Pre-compaction history uses the same path. Any arbitrary `author` field found in Pi JSONL is discarded as untrusted; only the Bobbit sidecar and read-time inference supply the projected author.

Legacy inference follows these rules:

- Bobbit hidden, dynamic-context, notification, compaction-summary, and custom rows are `system`;
- assistant rows are the session agent;
- ordinary user rows are the matched prompt author, or local user when no binding exists;
- tool-result rows inherit the closest preceding accountable author, falling back to the session agent when session context is available;
- unknown Bobbit custom rows are `system`.

Direct transcript-reader callers that provide no session context do not invent `session:unknown` for assistant or orphan tool-result rows.

### Search

Message indexing streams transcript rows from disk rather than retaining the complete history, attachments, images, or tool payloads in memory. When sidecar state is within its configured count and byte budgets, a bounded two-pass resolver preserves full-sequence attribution: the first pass reserves settled message-id and timestamp-plus-digest matches across the transcript; the second revalidates those reservations, then consumes eligible keyless settlements by dispatch-ordered FIFO. This prevents an earlier same-text row from stealing a later exact binding.

The streamed boundary remains fail-safe:

- transcript-provided `author` fields are discarded as untrusted;
- cancelled bindings never match, and unresolved dispatches cannot claim historical rows through digest or FIFO matching;
- an unresolved binding is used only for Bobbit's exact synthetic in-flight-steer id;
- only compact sidecar references and at most one reservation per binding are retained;
- if compact sidecar state exceeds either budget, Bobbit abandons correlation for that session and continues indexing every row, but omits `authorKind`, `authorId`, and `authorLabel` for ambiguous user-role rows rather than fabricating `user:local`.

Search extraction happens after message-level normalization. Oversized transcripts still retain exact sidecar authors when their compact binding state is within budget; transcript size alone does not discard attribution. Every searchable block from a message, including separate adjacent text blocks, receives the same resolved author metadata. Search records add `authorKind`, `authorId`, and `authorLabel` to schemaless result metadata when attribution is known. These values are not added to indexed text, snippets, weights, or content hashes, so attribution and labels do not change query matching.

The over-budget case is intentionally distinct from a legacy session with no sidecar. Legacy absence may use the documented read-time fallback, but an over-budget sidecar proves that authoritative bindings exist and cannot be correlated safely within the memory bound. Treating those ambiguous prompts as local-human input would be false attribution. Forged transcript `author` fields remain stripped in both cases.

### Client state and UI

`RemoteAgent`, the unified message reducer, custom message types, and UI message shapes preserve optional authors from snapshots and live events. Optimistic prompts and steers use the local-user identity; client-created Bobbit notifications, permission cards, errors, and mutation cards use the core system identity.

The renderer does not add author labels to ordinary chat bubbles. This keeps current single-human sessions visually unchanged while making identity available to diagnostics and future ambiguous-session UI.

## Tool-result attribution

A tool is a producer, not an accountable author. Bobbit recognizes dedicated `toolResult`, `tool_result`, and `tool` roles as well as provider histories that encode tool output as a user-role message containing only tool-result blocks.

During sequential normalization, a tool result inherits the closest preceding accountable message author. If none is available and the session is known, it falls back to that session's agent identity. Existing `toolName`, `toolCallId`, role, block, and error metadata remain intact. No path can produce `author.kind: "tool"`.

## Provider and model equivalence

Author identity is an additive Bobbit display and indexing concern. The implementation does not:

- change Pi or provider roles;
- prefix or inject author labels into message text;
- map author data to provider name or source fields;
- rewrite Pi transcript rows;
- alter existing prompt, steer, tool-result, or batching content.

Live normalization copies Pi event objects without changing their role or content. Snapshot normalization runs only after `getMessages()` returns and its result is never fed back into the agent. `defaultConvertToLlm()` defensively removes `author` from standard messages, while attachment messages are reconstructed from their existing role/content fields without copying it.

These boundaries keep provider/model input byte-equivalent to the pre-author path. Any existing transformation—such as skill expansion, error-recovery framing, attachment synthesis, steer newline batching, or extension system-reminder framing—continues to operate exactly where it did before and is not affected by author metadata.

## Verification strategy

Author tests are split by architectural boundary so failures identify the broken contract rather than depending on a full external-agent run:

- pure and memory-filesystem tests pin identity mapping, legacy/tool-result inference, queue and steer restore, transcript projection, sidecar corruption/correlation behavior, and exact adjacent-text-block matching without content rewriting;
- lifecycle tests use mocked RPCs, deferred promises, and a manual clock to reproduce dispatch, echo, retry, abort, and restore races without wall-clock sleeps; they pin live last-terminal replacement, duplicate terminal idempotence, settled-old-only replay, and ordered settled-old-then-crash-unsettled replay across `message_start` boundaries;
- in-process gateway tests use the real WebSocket and snapshot paths with a mock agent bridge and session-local virtual clock, proving live/snapshot/reconnect equality for both human and system prompts while keeping roles and text unchanged;
- DOM and search-source tests pin client preservation, provider conversion stripping, metadata-only indexing, bounded streamed correlation, later exact-binding reservation, rejection of forged transcript authors, exact attribution for oversized transcripts within the compact budget, and omission of ambiguous user authors when sidecar state exceeds that budget;
- the Chromium journey verifies stable user/assistant authors across reload and confirms that ordinary bubbles render no new identity label.

The restart-sensitive steer tests restore from the persisted ledger through `SessionManager` with a fresh mock bridge instead of restarting an operating-system process. They assert both ordered outcomes: if replay contains only an older settled same-text occurrence, the newer prompt remains pending and is requeued unchanged; if replay contains a subsequent occurrence boundary and the newer echo, the cursor advances, settles it once, and prevents requeue. Duplicate terminal frames do not advance the cursor. Live lifecycle cases separately prove that a newly accepted dispatch supersedes the prior keyless terminal guard. Broader process-level E2E remains responsible for gateway restart infrastructure.

See the [implemented design](design/author-identity-metadata.md#13-deterministic-verification-strategy) for the rationale behind these deterministic seams.

## Maintainer map

| Area | Module |
|---|---|
| Shared public types and validation | `src/shared/message-author.ts` |
| Internal provenance enum | `src/shared/prompt-source.ts` |
| Identity construction and inference | `src/server/agent/message-author.ts` |
| Host-side dispatch ledger, split-block matching, and stream correlation | `src/server/agent/author-sidecar.ts` |
| Queue and in-flight persistence | `src/server/agent/prompt-queue.ts`, `session-store.ts` |
| Live acceptance and event stamping | `src/server/agent/session-manager.ts` |
| Snapshot pipeline | `src/server/agent/visible-message-snapshot.ts` |
| Transcript projections | `src/server/agent/transcript-reader.ts` |
| Bounded streamed search attribution | `src/server/search/` |
| Client preservation and provider conversion | `src/app/remote-agent.ts`, `message-reducer.ts`, `src/ui/components/Messages.ts` |
