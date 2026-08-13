# G10b — Embedded Claude Agent SDK subagent work

## Purpose and boundary

Claude Agent SDK helpers are rendered as activity **inside the existing root
`Agent` tool card**. A legacy native `Task` card can use the same display-only
renderer for compatible historical data. This is a transcript projection, not a
new Bobbit child-session system: an SDK helper never becomes a session, task,
team member, sidebar item, route, modal, or standalone transcript card.

The design keeps the root transcript as the page-level reading order. Child
text, thinking, tool calls, results, and terminal state are details of the
root tool call that admitted the child. This makes the relationship clear while
preserving the SessionManager and root message reducer as the owners of the
actual session turn.

G10b does not define cost, billing, search, or indexing behavior. Usage, token,
and cost fields on SDK rows remain opaque source metadata for audit. The
projection neither moves nor aggregates them.

## Exact-parent rule

`parent_tool_use_id` (normalized to `parentToolUseId`) is the only renderable
parent relationship:

```text
root Agent tool call (tool-use id: agent-use-1)
  └─ SDK child row/frame (parent_tool_use_id: agent-use-1)
```

A non-empty exact value is required. The implementation must not join a child
to the latest Agent card, infer a parent from `parent_agent_id`, match on type
or prose, or use arrival order. A repeated child or tool identity is scoped to
its parent partition, so interleaved children cannot settle one another's
tools or reorder root messages.

The SDK `SubagentStart` and `SubagentStop` hooks provide child id/type but not
the parent tool-use id. The bridge-local, already-admitted subagent policy
registry is therefore the only lifecycle correlation source. It emits a
lifecycle record only for a verified root Agent admission; hook input can never
invent a renderable parent. `start`, `stop`, and bridge cleanup become semantic
embedded-work frames only after that verified association exists.

## Projection and root isolation

The server assembler accepts partitioned translated SDK events and verified
lifecycle records, then publishes `claude_sdk_subagent_work` frames. It keeps
child messages, pending child tools, identities, and phases keyed by the exact
parent id. The bridge sends unpartitioned events through the normal root path;
it does not send a child event as root assistant content or root `agent_end`.

At the root-session boundary, `SessionManager` broadcasts and sequences these
frames for reconnect replay, but explicitly excludes them from:

- root activity and lifecycle acceptance;
- root status, completed-turn count, and queue or steer draining;
- root transcript rows and root ordering; and
- root cost/accounting processing.

The client performs the same separation before normal message handling. It
holds a parent-keyed nested-work map outside `message-reducer.ts`; snapshots are
partitioned before their root rows reach that reducer. Live semantic frames and
legacy partitioned frames update only this nested map. Consequently, child prose
cannot become root streaming prose, trigger proposal parsing, publish a root
host message, or appear in the root timeline.

Source rows converge by exact parent plus their stable SDK source id. Child tool
lifecycle is local to the partition and tool-call id. This is replay/display
deduplication only: it must not be reused as a cost or usage ledger.

## Existing-card rendering

The UI passes nested work only to the root call whose tool-use id matches the
map key. The native `Agent`/legacy `Task` renderer is display-normalized only
when such exact work exists; otherwise it retains the normal default tool
renderer. Child text and thinking use the established safe transcript
components, and child tool calls reuse the normal tool renderer after ordinary
SDK MCP-name canonicalization.

The rendered activity remains within the parent card's disclosure region:

- a compact Agent header exposes state and child activity;
- child sections preserve their own message/tool order and terminal state;
- nested tools do not gain a second card shell or a separate control surface;
- terminal errors expose only safe child-work detail; and
- a root Agent result/error is the only root-session and durable-history
  terminal authority.

Provider-controlled error bodies can contain paths or sensitive information.
The UI-bound child terminal error is therefore the fixed, safe text
`Subagent failed`; raw provider error text is not projected into the card,
root prose, or wire-visible child terminal detail. A terminal child tool with no
result is shown through the existing tool rendering path with a bounded local
failure explanation.

## Recovery, reload, and compaction

SDK history remains SDK-owned. Recovery uses the official SDK session-access
wrapper rather than SDK transcript files:

1. `listSubagents(sessionId, { dir })` supplies bounded child ids.
2. `getSubagentMessages(sessionId, agentId, { dir, limit })` supplies a bounded
   child history page.
3. Each returned row is adapted and accepted only when its non-empty
   `parent_tool_use_id` exactly names a real root Agent/Task call in the root
   snapshot.

A listed child id is not a parent mapping and does not prove lifecycle state.
Recovery never derives a parent, completion, timestamps, or Stop event from an
id list or missing history. Unavailable, malformed, oversize, conflicting, or
unmatched recovery data is rejected while received live work remains usable. It
does not fail the root session or create a fallback card.

The recovery reader limits child enumeration, concurrent reads, per-child rows,
total rows, and total serialized bytes. It passes only the session cwd to the
SDK API and normalizes unavailable errors through the existing SDK-unavailable
boundary. These limits keep reload/archive recovery auditable without allowing
a child history to become an unbounded transport payload.

A visible SDK snapshot is an envelope when nested work exists:

```ts
{ messages: rootMessages, subagentWork: embeddedWorkByParent }
```

Only `messages` participates in root ordering. `subagentWork` remains nested
metadata and is carried through snapshot truncation with its source metadata,
parent id, and identity intact. Archived history uses the same official-history
projection and bounded recovery path.

On reload, resume, reconnect, or post-compaction refresh, the client hydrates
from that snapshot before applying later frames. Parent keys and source
identities make snapshot and replay idempotent. A child terminal never makes a
root turn terminal. Conversely, bridge replacement, root terminal cleanup, or
abort marks verified live children aborted once so a card cannot retain a
permanent running state. Compaction may change retained root history, but it
must never promote retained child work into root prose or duplicate it between
the root timeline and its parent card.

## Late and unknown work

A child partition can arrive before its parent root card. It is buffered under
its exact id and becomes visible only when that exact real card is present.
Unresolved work is visually suppressed; it must never flash in root prose,
attach to a nearby card, or cause a synthetic Agent card to be created.
Diagnostic markers preserve the parent/identity failure state without retaining
prompts, credentials, environment data, transcript paths, or raw provider
errors.

## Maintenance entrypoints

The implementation is intentionally split at stable ownership boundaries:

- `claude-sdk-event-translator.ts` owns source partitioning and child-local
  event ordering.
- `claude-agent-sdk-tool-surface.ts` owns admitted helper policy and the
  lifecycle registry.
- `claude-agent-sdk-bridge.ts` correlates verified lifecycle, emits semantic
  frames, and keeps child terminals out of the root event path.
- `claude-sdk-subagent-work.ts` owns the pure server projection, replay
  identity, official bounded recovery, and history partitioning.
- `claude-agent-sdk-session-access.ts` is the only SDK history/subagent access
  seam; it validates ids, cwd scoping, and unavailable errors.
- `session-manager.ts` and the visible snapshot pipeline preserve the nested
  envelope while protecting root lifecycle and accounting ownership.
- `src/app/claude-sdk-subagent-work.ts` owns client-side partition/snapshot
  projection; `remote-agent.ts` applies it before root handling.
- `DelegateRenderer.ts` and the normal message/tool components render the
  already-projected activity inside the existing card.

The focused test seams are `claude-sdk-subagent-work.test.ts`,
`claude-sdk-subagent-client.test.ts`, `claude-agent-sdk-bridge.test.ts`,
`claude-agent-sdk-session-access.test.ts`,
`session-manager-claude-sdk-subagent-rendering.test.ts`,
`claude-sdk-subagent-card.test.ts`, and
`claude-sdk-subagent-card.spec.ts`. The browser journey is the guard against
accidentally adding a child session/task surface or leaking child text into the
root timeline.

## Debugging invariants

When diagnosing a bad card, establish the exact parent id first, then follow
that partition through translator, semantic frame, snapshot envelope, and
client map. Do not repair an association in the renderer.

The following invariants are safety boundaries rather than presentation
preferences:

- Child source rows and terminals never enter root assistant prose or root
  lifecycle handling.
- `parent_tool_use_id` is the sole attachment key; no best-effort association
  is permitted.
- A `SubagentStart`/`SubagentStop` event is usable only through the verified
  admission registry.
- A child failure uses safe terminal detail and can update only embedded-work
  presentation; only a root result settles the root turn and durable history.
- Official recovery confirms every row's exact parent and remains bounded;
  missing data is unknown/diagnostic, not fabricated.
- Snapshot, replay, reload, compaction, archive, and resume keep nested work
  outside root ordering and converge without duplicate child rows.
- Opaque usage/cost metadata can survive on its source row but is never
  aggregated or applied by this feature.

For runtime/session ownership and SDK recovery more broadly, see
[Claude Agent SDK sessions](../claude-agent-sdk-sessions.md). For the visual
interaction contract, see the companion
[embedded subagent card UX](claude-agent-sdk-subagent-card-ux.md).
