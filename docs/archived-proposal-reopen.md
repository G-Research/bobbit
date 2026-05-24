# Reopen Archived Proposals

When a session that was driving a proposal (`goal`, `project`, `role`, `tool`,
or `staff`) gets archived — either deliberately or accidentally, mid-edit or
right after the agent emitted a polished draft — the user used to be stuck.
The proposal file sat on disk under `.bobbit/state/proposal-drafts/<sessionId>/`
with no way to submit it, and the only "Continue in New Session" affordance
was disabled for assistant sessions. This feature closes that gap with two
complementary paths.

## TL;DR

| Path | Surface | What it does | When to reach for it |
|---|---|---|---|
| **A — Resubmit in place** | "Resubmit `<type>` proposal" button on the archived footer | Opens the existing proposal panel hydrated from disk and lets the user submit via the live REST path. No new session, no agent. | The draft is already good enough — you just need to accept it. |
| **B — Continue assistant** | "Continue in New Session" button on the archived footer | Spawns a fresh assistant session (`assistantType` preserved) and clones the draft + its history snapshots into the new session's slot. The new agent boots with the in-progress draft as its current rev. | You want to keep iterating on the draft with the assistant. |

Both surfaces appear together when the archived session has at least one
proposal draft on disk; the chat transcript stays read-only either way.

## Why this exists

This is the orphaned-draft problem. The proposal lifecycle is
`propose → edit → submit → archive`. Before this feature the lifecycle
broke down at the seam between the second and third steps:

- The proposal file is the single source of truth (see
  [editable-proposals.md](design/editable-proposals.md)). On archive,
  `session-manager.ts::terminateSession` used to `fs.rm` the per-session
  directory, deleting the draft and every snapshot in `<type>.history/`.
- `POST /api/sessions/:archivedId/continue` explicitly rejected
  assistant sessions (`assistantType` set) with HTTP 422 — assistant
  sessions don't make sense to "continue as a fresh coder", so the
  lossless-clone path was off-limits for the very sessions that owned
  proposal drafts.

The combination meant a user who archived a session by accident — or
whose assistant session was terminated by an unrelated cleanup —
permanently lost their draft, even though `propose_*` had already
captured a clean, parseable payload on disk.

The fix is intentionally narrow:

1. Drafts survive archive on disk. They are now reaped together with
   the rest of the session at the 7-day purge mark, not at archive
   time.
2. The archived chat surfaces a context-aware footer that lets the
   user pick between resubmitting the draft directly (Path A) or
   continuing it in a fresh assistant session (Path B).

Everything else — the proposal-files module, snapshot rev counter,
WS rehydrate broadcast, accept handlers — stays unchanged.

## Where it fits in the bigger picture

```
  propose_*  ─▶  edit_proposal  ─▶  accept (DELETE)   ┐
       │                │                              │
       └─ writes file ──┘                              ▼
                                              proposal-drafts/<sid>/  ──▶ live UI
                                                       │
                                              archive  │
                                                       ▼
                                              (drafts SURVIVE until 7-day purge)
                                                       │
                                       ┌───────────────┴───────────────┐
                                       ▼                               ▼
                              Path A: resubmit in place      Path B: continue (clone)
                              (no new session)               (new session id)
```

The handoff to disk is owned by `src/server/proposals/proposal-files.ts`;
the seed/edit/restore lifecycle is documented in
[editable-proposals.md](design/editable-proposals.md) and
[proposal-revision-snapshots.md](design/proposal-revision-snapshots.md).
This document is concerned only with what changes once the owning
session is archived.

## Path A — In-place resubmit

The cheapest path. The proposal panel is already wired to submit
through the live REST endpoints (`createGoal`, `createProject`,
`createRole`, `createTool`, `createStaff` in `src/app/render.ts`);
the panel just needs to be visible, populated, and able to call those
handlers without trying to terminate the already-archived parent
session.

### What you see

When the user opens an archived session that has at least one proposal
draft on disk, `AgentInterface.ts` does a one-shot
`GET /api/sessions/:id/proposals` (see
[rest-api.md — Proposal drafts](rest-api.md#proposal-drafts)) and
caches the resulting type list on `_archivedProposalTypes`. The
archived footer then renders:

- **"Resubmit `<type>` proposal"** — primary button. Selects the live
  proposal tab in the session's side-panel workspace so the existing
  proposal panel becomes visible beside the chat. Legacy `previewPanelTab`
  / `assistantTab` mirrors are updated only for compatibility.
- **"Continue in New Session"** — secondary button, kept for Path B.

If no drafts are present, only "Continue in New Session" is rendered
(this is the historical footer layout).

### What happens on submit

The proposal panel is already hydrated. The unified WS handshake
emits `proposal_update {source:"rehydrate"}` for every surviving
draft on attach (`src/server/ws/handler.ts`), and the same data is
available via the REST list endpoint as a fallback. By the time the
user clicks the Resubmit button, `state.activeProposals[type]` is
already populated.

The submit path is the live REST path verbatim — `POST /api/goals`,
`POST /api/projects`, `POST /api/roles`, `POST /api/tools`, or
`POST /api/staff`. The accept handlers in `src/app/render.ts` were
adjusted in exactly one place: a new `isSessionArchived()` helper
guards the `DELETE /api/sessions/:id` teardown call so resubmitting
from an archived session view does not 404-toast.

```ts
// src/app/render.ts
function isSessionArchived(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return state.archivedSessions.some((s) => s.id === sessionId);
}
// later, inside each accept handler:
if (sessionId && !isSessionArchived(sessionId)) {
  await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
}
```

After a successful accept the user is navigated to the new entity
(goal dashboard, project page, etc.) exactly like the live flow, and
`DELETE /api/sessions/:id/proposal/:type` clears the draft so the
button does not reappear on a refresh.

The chat transcript itself stays read-only — no message editor, no
steer, no agent involvement.

### Why not just rehydrate via the WS push?

A previous browser tab on the same archived session may not refire
`auth_ok` (e.g. a fast back-button navigation that keeps the same WS
alive). The `GET /api/sessions/:id/proposals` REST endpoint is the
explicit, one-shot fallback for that case — it returns the same
parsed projections the WS broadcast would have, with the
authoritative `rev` from `latestRev()` stamped on each entry.

## Path B — Continue assistant session

This piggybacks on the existing lossless Continue-Archived flow
(`POST /api/sessions/:archivedId/continue`) — see
[rest-api.md — Continue-Archived endpoint](rest-api.md#continue-archived-endpoint)
and [design/lossless-continue-archived.md](design/lossless-continue-archived.md)
for the underlying mechanism. The new piece is two small
extensions to that flow.

### Lifted assistant guard

The continue handler previously rejected sessions with `assistantType`
set (422). That guard is gone:

- Coding-agent guards (`goalId`, `delegateOf`, `teamGoalId`) stay.
  Those sessions live inside an active goal or team and don't survive
  the continue-into-a-fresh-session model.
- Assistant sessions are now accepted. The new session inherits the
  source's `assistantType`, persisted `role`, and `accessory`, so the
  resumed agent picks up the same identity (goal-proposal assistant,
  role-creation assistant, etc.) it had before archive.

The success response now echoes `assistantType` so callers can confirm
the inheritance worked.

### Proposal-dir clone

Adjacent to the existing `.jsonl` clone and the defensive
`copyToolContentDirIfPresent` helper, the handler now invokes a
sibling helper `copyProposalDirIfPresent(srcId, dstId, stateDir)`:

```ts
// src/server/agent/continue-archived.ts
export function copyProposalDirIfPresent(srcId: string, dstId: string, stateDir: string): void {
  const src = path.join(stateDir, "proposal-drafts", srcId);
  if (!fs.existsSync(src)) return;
  const dst = path.join(stateDir, "proposal-drafts", dstId);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
```

This is a schema-agnostic recursive copy — the live `<type>.{md,yaml}`
file plus the entire `<type>.history/<rev>.<ext>` snapshot tree are
mirrored verbatim into the new session's slot. The new agent inherits
the in-progress draft as its current rev, and the rev counter
continues from there because `latestRev()` (in
`src/server/proposals/proposal-files.ts`) recomputes by scanning the
copied history dir — no metadata file to keep in sync.

Once the new session goes live, the standard WS `auth_ok` handshake
emits `proposal_update {source:"rehydrate", rev}` per surviving file
(`src/server/ws/handler.ts`). The proposal panel populates without
any additional wiring.

### Cleanup on failure

`cleanupFailedContinue` was extended to also `rm -rf` the
partially-cloned `<stateDir>/proposal-drafts/<newSessionId>/` on
rollback. Any of the existing failure paths (cross-realm copy,
`createSession` throw, `switch_session` failure) will leave no
half-cloned draft behind.

### Carry-over hint in the modal

`ContinueSessionChooser` accepts a new `proposalTypes` property fed
from `AgentInterface._archivedProposalTypes`. When non-empty the
modal renders an extra line under the headline:

> Your `<type>` proposal draft will be carried over so you can keep editing.

For multi-draft sessions the types are joined with `/` (e.g.
"goal / role"). No other modal copy or button wiring changed.

## Why drafts now survive archive

Both paths read the same files off disk, so both need the draft
directory to outlive the parent session. The fix is one moved line:

- `session-manager.ts::terminateSession` no longer touches
  `<stateDir>/proposal-drafts/<sessionId>/`. It still cleans up the
  worktree, the sandbox slot, the model-name file, and the
  branch — proposal drafts are simply skipped.
- `purgeOneSession` — the 7-day mark that already deletes the `.jsonl`,
  the session prompt, and the search index entries — now also fires
  a best-effort `fsp.rm` against the draft directory.

This keeps the steady-state cleanup story unchanged (drafts do not
accumulate forever; they go with the rest of the session at purge
time) while unblocking both Path A and Path B for the entire
window during which the archived session is still visible in the
sidebar.

The previous "delete on archive" behaviour was an over-eager
optimisation that nobody depended on — the proposal file's lifecycle
was implicitly tied to the live session, but the design never
documented why. With the file model now formally allowed to outlive
the session, the only semantic change for existing callers is that
`view_proposal` against a recently-archived session would now find
content where it previously returned `FILE_NOT_FOUND`. The agent
context for that case (an archived assistant session) is exactly the
one we want to keep working.

## Failure modes & guards

| Symptom | What's happening | Where to look |
|---|---|---|
| Resubmit button missing on archived footer | `GET /api/sessions/:id/proposals` returned empty, or `canContinueArchived` is false (goal-linked, delegate, team, or unregistered project). | `AgentInterface.canContinueArchived` + `_refreshArchivedProposalTypes`. The endpoint is in `src/server/server.ts` and matches `^/api/sessions/([^/]+)/proposals$`. |
| Continue assistant returns 422 | Source has `goalId`, `delegateOf`, or `teamGoalId` set. Assistant guard is gone but coding-agent guards stay. | `src/server/server.ts` — the continue handler. |
| Resubmit toasts a 404 from `DELETE /api/sessions/:id` | The archive-guard was bypassed. The `isSessionArchived` helper in `src/app/render.ts` should short-circuit that DELETE for archived parents. | `isSessionArchived` call sites in `render.ts` — pinned by `tests/e2e/ui/archived-proposal-resubmit.spec.ts`. |
| Continued session shows no draft | Clone failed silently, or the WS rehydrate fired before the copy completed. Server logs surface a `[continue-archived] proposal-dir copy failed (non-fatal): …` warning when `copyProposalDirIfPresent` throws. | `copyProposalDirIfPresent` in `src/server/agent/continue-archived.ts`; rehydrate emitter in `src/server/ws/handler.ts`. |
| Draft missing on every archived session | `terminateSession` is back to deleting the directory, or `purgeOneSession` ran prematurely. Drafts must outlive archive and only purge on the 7-day mark. | `src/server/agent/session-manager.ts::terminateSession` (skips proposal-drafts) and `purgeOneSession` (removes them). |

## Cross-references

- [docs/design/editable-proposals.md](design/editable-proposals.md) — the
  on-disk format (`<stateDir>/proposal-drafts/<sessionId>/<type>.{md,yaml}`)
  that this feature reopens.
- [docs/design/proposal-revision-snapshots.md](design/proposal-revision-snapshots.md) —
  the `<type>.history/<rev>.<ext>` snapshot tree that `copyProposalDirIfPresent`
  carries over.
- [docs/design/lossless-continue-archived.md](design/lossless-continue-archived.md) —
  the underlying `.jsonl` clone + `switch_session` flow Path B sits on top of.
- [docs/rest-api.md — Continue-Archived endpoint](rest-api.md#continue-archived-endpoint) —
  the updated semantics (assistant sessions accepted, `assistantType` echoed).
- [docs/rest-api.md — Proposal drafts](rest-api.md#proposal-drafts) — the
  `GET /api/sessions/:id/proposals` listing endpoint Path A relies on.
- [docs/internals.md — Continue-Archived sessions](internals.md#continue-archived-sessions) —
  scope gate and copy semantics.
- [docs/internals.md — Editable proposals](internals.md#editable-proposals) —
  client-side `state.activeProposals` shape and `rehydrateProposalsForSession`.
