# Session runtime identity

## Purpose

A Bobbit session has a runtime identity: either the existing Pi process runtime or
Claude Agent SDK. The identity is durable and visible in model selection so users
can choose the appropriate execution and recovery contract. It is deliberately
derived from the selected model provider rather than becoming a second setting
that could disagree with the model.

## Canonical derivation

`resolveSessionRuntime()` is the single server authority for runtime identity.

| Available identity | Runtime |
|---|---|
| `modelProvider === "claude-agent-sdk"` | Claude Agent SDK |
| Any other provider, including `anthropic` | Pi |
| No usable model tuple | Persisted runtime snapshot when valid; otherwise Pi |

Only the exact `claude-agent-sdk` provider selects the SDK. A provider segment
from the resolved initial model can supply the same information when a separate
provider field is not yet available. A known provider always wins over the
persisted snapshot, so an old contradictory row cannot change a session's
runtime.

Runtime is not independently selectable. The model and role pickers continue to
send provider/model values only, and their runtime badges are informational. A
live model change that would cross the Pi/SDK boundary is rejected: create a new
session instead. This avoids replacing a bridge and its history with an
incompatible runtime in place.

## Durable identity and recovery

`PersistedSession.runtime` is a denormalized audit snapshot, not an override. It
is written from the canonical derivation with the persisted model tuple and is
included for both live and archived records. Reading legacy `sessions.json` rows
does not require a migration rewrite:

- A row with a usable provider is normalized in memory to that provider's runtime
  and is persisted normally on its next write.
- A row with neither a usable tuple nor a runtime remains compatible and behaves
  as Pi.
- A valid legacy snapshot can identify a tuple-less historical row; invalid
  values are ignored.
- Pi normalization clears a stale SDK resume ID, because that ID has no Pi
  meaning.

Existing sessions cannot silently change runtime during restore, role/model
re-resolution, or force-abort replacement. Before a replacement bridge is made,
Bobbit compares the candidate model's derived runtime with the persisted
identity. A mismatch fails the operation and leaves the current identity in
place. This is particularly important for tuple-less legacy Pi rows: a newly
configured SDK default must not turn their historical conversation into an SDK
session.

An SDK session also persists the opaque UUID supplied by the SDK. SDK boot,
restore, replacement, and Continue require both the SDK-derived model tuple and
a valid resume UUID before constructing an SDK bridge. Missing or malformed
metadata leaves the record visible and recoverable as a failed/dormant SDK
session; Bobbit never starts a fresh SDK conversation and presents it as a
continuation of the old one.

## Status, audit, and presentation

The server projects the derived runtime through session list/detail responses and
`session_status` WebSocket frames. Status frames are a projection, not a second
authority; reconnect, heartbeat, and archived-session paths use the same server
resolution. Clients may omit the additive field during a rolling upgrade.

The model catalog also exposes a read-only derived runtime for every model.
Model-picker rows show a consistent Pi or Claude Agent SDK badge, explaining the
runtime contract without introducing a runtime control. Sidebar session rows —
live, archived, goal, delegate, and audit — do not render runtime badges; runtime
remains durable in the server projection and is selected and inspected through
model-selection surfaces.

Model availability is separate from identity. If a saved provider/model is not
in the current catalog, the session row keeps its persisted provider/model and
adds **Model unavailable** with the tuple in its tooltip. A missing provider must
not hide an archived session, substitute a default model, or relabel an SDK
session as Pi.

## Continue and fork boundaries

Pi keeps the existing lossless JSONL behavior:

- **Fork** clones the Pi transcript and its existing sidecars, then rehydrates
  the destination with Pi's `switch_session` flow.
- **Continue in New Session** creates a fresh Bobbit session and rehydrates a
  cloned archived Pi transcript. Worktree and container state remain fresh under
  the existing Continue rules.

SDK history belongs to the SDK, not to a Pi JSONL file:

- **Continue in New Session** creates a fresh Bobbit session with the source's
  SDK model tuple and opaque resume UUID. It validates both before creation and
  resumes through the SDK; it does not copy a Pi transcript, tool-content, or
  author sidecar. Invalid SDK metadata returns `422`
  `RUNTIME_CONTINUE_UNSUPPORTED`.
- **Fork** is unsupported: although the pinned SDK exports `forkSession`, Bobbit
  lacks a reviewed atomic integration joining an SDK fork to the active-query
  snapshot, destination/worktree creation, sidecar ownership, and rollback, so
  the endpoint returns `422 RUNTIME_FORK_UNSUPPORTED` before destination
  allocation or copying data and never uses a resume UUID as a fork.

## Related references

- [Claude Agent SDK sessions](../claude-agent-sdk-sessions.md) — SDK lifecycle,
  selection, and security boundary.
- [REST API](../rest-api.md#fork-session-endpoint) — Fork and Continue endpoint
  contracts.
- [Continue-Archived sessions](../internals.md#continue-archived-sessions) —
  Pi clone and worktree behavior.
