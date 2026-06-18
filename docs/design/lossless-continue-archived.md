# Lossless Continue-Archived

## Purpose

`POST /api/sessions/:archivedId/continue` creates a new live session from an
archived source without summarising, truncating, or re-rendering the archived
transcript. It clones the source agent `.jsonl` into the new session's slot and
lets the agent CLI rehydrate from that file through `switch_session`, matching
the restart/resume model used for live sessions.

This matters because archived sessions can be large and can contain structured
message content that is not faithfully represented by a prompt string. The
continue flow preserves the original transcript bytes so tool results, long
messages, proposal context, and model history survive unchanged.

## Scope and invariants

Continue-Archived preserves conversation and session identity metadata, not
runtime filesystem state.

Preserved in the new session:

- cloned agent `.jsonl` transcript
- copied proposal draft directory, including history snapshots
- copied lazy tool-content directory if one exists
- title prefix: `Continued: <source title>`
- role, accessory, assistant type, sandbox flag, and persisted model selection

Fresh runtime state:

- new session id
- new `session/<new-id8>` branch/worktree for worktree-backed sources
- cwd derived from the current project configuration
- worktree base derived from the current project repo/base ref

The archived `worktreePath` and `branch` are provenance only. Continue never
stats, repairs, revives, reuses, or checks out the archived worktree path or
branch. If those stale values point at deleted filesystem paths or pruned git
refs, continue still succeeds as long as the current project repo can create a
fresh worktree.

## Endpoint flow

The continue endpoint lives in the server REST route for
`POST /api/sessions/:archivedId/continue`.

1. Resolve the persisted source session.
   - Missing source returns `404`.
   - Non-archived source returns `409`.
   - Goal, delegate, and team sessions return `422`.
   - A source whose project is no longer registered returns `410`.
   - Assistant sessions are allowed and keep assistant metadata.
2. Resolve the source `.jsonl` path.
   - Prefer `PersistedSession.agentSessionFile`.
   - Fall back to `SessionManager.recoverSessionFile` for legacy records.
   - Missing or empty non-sandboxed files return `404` with
     `archived transcript missing or empty`.
3. Resolve fresh worktree intent from current project state.
   - If the archived source had `worktreePath`, continue treats that only as
     evidence that the source was worktree-backed.
   - The endpoint checks the current registered project root and derives the
     repo root from that project.
   - Failures are reported as fresh current-project worktree creation errors,
     not archived-source worktree errors.
4. Generate a new session id and initial destination `.jsonl` path with
   `formatAgentSessionFilePath(projectRoot, Date.now(), newSessionId)`.
5. Copy the source `.jsonl` with `sessionFileCopy`.
   - Same-realm host copies use the host filesystem.
   - Same-project sandbox copies use the sandbox container.
   - Cross-realm copies return `422`.
   - Other copy failures return `500` and clean up any partial artifacts.
6. Copy optional sidecar directories.
   - `copyProposalDirIfPresent` copies proposal drafts and history.
   - `copyToolContentDirIfPresent` copies a future on-disk tool-content cache
     if present; it is a no-op for today's wire-only tool-content path.
7. Create the new session with `preExistingAgentSessionFile`.
   - No `seedContext` is generated.
   - No prior-transcript prompt section is injected.
   - Worktree-backed continues set `awaitWorktreeSetup` and
     `bypassWorktreePool` so fresh setup failures are returned synchronously.
8. Rehydrate the agent from the cloned `.jsonl`.
   - Non-worktree sessions switch directly to the cloned file.
   - Worktree-backed sessions first create a fresh worktree, then rebase the
     cloned file into the final worktree-cwd slug directory before
     `switch_session`.
9. Persist title and model metadata, then return `201` with the new session id,
   cwd, status, title, and assistant type.

## Agent session file paths

Agent session files use the CLI-compatible format implemented by
`formatAgentSessionFilePath`:

```text
<global-agent-dir>/sessions/--<cwd-slug>--/<timestamp>_<session-id>.jsonl
```

Where:

- `<cwd-slug>` is `cwd.replace(/[^a-zA-Z0-9]/g, "-")`.
- `<timestamp>` is an ISO timestamp with `:` and `.` replaced by `-`.
- The parser in `SessionManager.recoverSessionFile` uses the same timestamp
  shape, so formatter and recovery stay round-trippable.

The continue endpoint can compute only the project-root path before session
creation. For worktree-backed continues, `executeWorktreeAsync` later knows the
final worktree cwd. It moves the cloned JSONL from the project-root slug
directory into the worktree-cwd slug directory and updates
`PersistedSession.agentSessionFile` before `switch_session`.

This worktree-cwd rebase is required because the agent CLI discovers session
files relative to its actual cwd. A clone left under the project-root slug would
be invisible after the CLI starts inside the fresh worktree.

## Worktree behavior

Worktree-backed continue uses the current project repo and creates a fresh
`session/<new-id8>` branch/worktree. The archived branch name is never used as a
base ref and the archived worktree path is never inspected.

This keeps continue robust after normal cleanup operations:

- deleted archived worktree directories
- pruned archived branches
- cleaned worktree pool entries
- stale persisted `worktreePath` values

If the current project root is not a usable git repo, continue returns an
actionable fresh-worktree error. The error is about the current project/base ref
because that is the only runtime dependency for the new worktree.

## Sandbox and copy behavior

`sessionFileCopy` dispatches by source and destination sandbox realms:

| Source | Destination | Behavior |
| --- | --- | --- |
| host | host | Copy with host filesystem APIs after creating the destination directory. |
| sandboxed | same-project sandboxed | Copy inside the sandbox container after creating the destination directory. |
| host | sandboxed | Reject with `CrossRealmCopyError`. |
| sandboxed | host | Reject with `CrossRealmCopyError`. |
| sandboxed project A | sandboxed project B | Reject with `CrossRealmCopyError`. |

Cross-realm rejection is intentional. The continue endpoint copies the source
`sandboxed` flag verbatim to the new session, so cross-realm copies are not part
of today's user-facing flow. Rejecting unsupported realm transitions avoids a
host staging location that would need separate cleanup, leak prevention, and
test coverage.

## Sidecar directories

### Proposal drafts

`copyProposalDirIfPresent` recursively copies
`<stateDir>/proposal-drafts/<sourceId>/` to the new session id. The copy is
schema-agnostic: live draft files and history snapshots move together, and the
review panel rehydrates from the new session's directory.

### Tool content

Tool-content lazy loading is currently JSONL-backed. The server resolves
`tool-content/<messageIndex>/<blockIndex>` from the live message list returned by
the agent RPC client, so cloning the `.jsonl` is enough for current tool-content
fidelity.

`copyToolContentDirIfPresent` is still kept as a defensive no-op. If a future
implementation adds an on-disk `<stateDir>/tool-content/<sessionId>/` cache, the
continue flow will copy it without changing the endpoint contract. Because
block ids are message-index/block-index pairs, a straight recursive copy is
sufficient; no id rewriting is needed.

## Cleanup and failure handling

Continue creates cloned artifacts before the new session is fully live. On copy,
create-session, worktree setup, or `switch_session` failure, cleanup removes:

- the initial cloned `.jsonl`
- any rebased `.jsonl` path persisted during worktree setup
- copied proposal draft directory for the new session id
- copied tool-content directory for the new session id

A worktree setup failure may still leave an archived failed session row for
diagnostics, but the cloned continue artifacts are removed.

## Error behavior

| Condition | Status | Error behavior |
| --- | --- | --- |
| Source session not found | `404` | `session not found` |
| Source is not archived | `409` | `source not archived` |
| Goal, delegate, or team source | `422` | `goal, delegate, or team sessions cannot be continued` |
| Project no longer registered | `410` | `source project no longer registered` |
| Source transcript missing or empty | `404` | `archived transcript missing or empty` |
| Current project repo cannot be inspected | `500` | Fresh worktree creation error for the current project |
| Current project root is not a git repo | `500` | Fresh worktree creation error for the current project |
| Cross-realm transcript copy | `422` | `cross-realm continue not supported` |
| Transcript clone fails | `500` | `failed to clone session file: <message>` |
| Fresh worktree or create-session fails | `500` | `failed to create session: <message>` with copied artifacts cleaned up |
| `switch_session` fails | `500` | `failed to create session: switch_session failed: <message>` |

## Resolved design decisions

### Cross-realm copies reject with `422`

Continue preserves the source sandbox flag, so supported copies are same-realm:
host to host or sandbox to the same project's sandbox. Host-to-sandbox,
sandbox-to-host, and cross-project sandbox copies are rejected as unsupported
realm transitions.

This keeps the flow explicit and avoids a temporary host staging area. If future
UI/API work allows changing sandbox mode during continue, support can be added
inside `sessionFileCopy` without changing the endpoint's transcript-cloning
model.

### `copyToolContentDirIfPresent` stays defensive

There is no current on-disk tool-content cache to copy, but the helper is kept
because it is cheap, isolated, and makes a future cache lossless by default. The
helper is deliberately best-effort and absence of the source directory is a
silent no-op.

## Verification coverage

Regression coverage exercises the behavior rather than the historical
implementation details:

- stale archived `worktreePath` / `branch` still creates a fresh session
  worktree from the current project repo/base ref
- invalid current project repo/base-ref returns a synchronous fresh-worktree
  creation error
- worktree-backed continues rebase the cloned JSONL to the final worktree-cwd
  slug path before `switch_session`
- non-worktree continues clone transcript bytes and preserve messages without
  summary mode or prompt seeding
- proposal/tool-content helper behavior is covered by unit tests
