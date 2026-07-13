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

Pi does not preserve arbitrary Bobbit fields reliably, and sandbox transcripts may live inside a container. Bobbit therefore never writes `author` into the Pi JSONL transcript. Prompt attribution is stored on the host at:

```text
<stateDir>/author-sidecar/<sessionId>.jsonl
```

`src/server/agent/author-sidecar.ts` implements an append-only, versioned ledger with two record types:

- a dispatch record stores `promptId`, dispatch time, exact model text, `PromptSource`, and resolved author;
- a settlement record marks that prompt as `echoed` or `cancelled` and may include the echoed message id and timestamp.

A redispatch with the same prompt id replaces the earlier folded binding. Cancelled dispatches are never correlated to transcript rows.

Writes occur immediately before prompt or steer delivery and are best-effort. A write failure is logged but never delays or rejects delivery. Reads skip malformed lines, partial crash tails, invalid records, and unsupported schema versions. A missing or unreadable sidecar behaves like an empty sidecar and falls back to role/content inference. The Pi transcript is never repaired or rewritten.

When rebuilding visible history, Bobbit correlates each eligible user-role prompt echo in this order:

1. exact settled message id;
2. exact model text plus a nearby settled message timestamp;
3. FIFO exact model text, consuming duplicate prompts separately.

Tool-result-only user-role rows are excluded from this matching. Author correlation runs before slash-skill and file-mention sidecars replace expanded model text with user-facing text, so matching uses the exact dispatched bytes.

Fork and continue operations copy the sidecar after the destination session exists. A hard purge removes it. Ordinary archive operations retain it with the session history.

## Message lifecycle

### Acceptance, queue, and restore

`SessionManager` resolves `source` and `author` when it accepts a prompt. Both optional fields travel with `QueuedMessage`, are broadcast in `queue_update`, and persist in `PersistedSession.messageQueue`. `PromptQueue` validates restored metadata, preserves it through priority changes and recovery re-enqueues, and can recover a missing source from a valid author's kind. Legacy rows without either field retain the historical local-user default.

The in-flight steer ledger persists structured `{ text, promptId, source?, author? }` records until Pi echoes them or abort reconciliation returns them to the queue. Legacy string-only steer entries normalize as local-user prompts. When steers are combined into the existing newline-joined batch, a common author is retained; a mixed-author batch receives the Bobbit batch-system identity. The prompt text and batching behavior do not change.

### Live events

All message-bearing Pi `message_update` and `message_end` events pass through one normalization boundary before lifecycle tracking, buffering, replay, or broadcast. Assistant events receive the session agent identity. User-role echoes are matched to the pending dispatch ledger by exact model text, then settled into the sidecar when the final event arrives. Other visible rows use the inference rules below.

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

Message indexing normalizes the complete ordered transcript with the author sidecar before extracting searchable blocks. Search records add `authorKind`, `authorId`, and `authorLabel` to schemaless result metadata. These values are not added to indexed text, snippets, or content hashes, so author labels do not change query matching.

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

## Maintainer map

| Area | Module |
|---|---|
| Shared public types and validation | `src/shared/message-author.ts` |
| Internal provenance enum | `src/shared/prompt-source.ts` |
| Identity construction and inference | `src/server/agent/message-author.ts` |
| Host-side dispatch ledger and correlation | `src/server/agent/author-sidecar.ts` |
| Queue and in-flight persistence | `src/server/agent/prompt-queue.ts`, `session-store.ts` |
| Live acceptance and event stamping | `src/server/agent/session-manager.ts` |
| Snapshot pipeline | `src/server/agent/visible-message-snapshot.ts` |
| Transcript projections | `src/server/agent/transcript-reader.ts` |
| Search metadata | `src/server/search/` |
| Client preservation and provider conversion | `src/app/remote-agent.ts`, `message-reducer.ts`, `src/ui/components/Messages.ts` |
