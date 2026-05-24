# Staff Agents

Staff agents are long-lived, project-scoped agents that survive across wake/sleep cycles instead of being recreated on each use. They are the right shape for "I have a recurring assistant that knows this project" — code reviewer, release captain, on-call triager — as opposed to a one-shot goal session.

A staff agent's runtime directory is always derived from its owning project: either the selected project root/subdirectory or a worktree created from that project. It never falls back to Bobbit's server launch directory or `config.defaultCwd`.

This page covers the user-facing model. For the sidebar/UI placement see [internals.md — Staff agents in the sidebar](internals.md#staff-agents-in-the-sidebar); for the REST surface see [rest-api.md — Staff Agents](rest-api.md#staff-agents); for sidebar handling of legacy records see the orphan banner section in `internals.md`.

## Lifecycle at a glance

- **Creation.** The user opens a staff creation assistant from a project (sidebar "+ New staff" or the project header). Accepting the assistant's `propose_staff` payload persists a `PersistedStaff` record under that project. Git-backed projects create a staff worktree by default; non-git projects and explicit worktree opt-out run from the project directory.
- **Wake / sleep.** Each interaction wakes the staff into its permanent session. Worktree-backed, non-sandboxed staff rebase onto the primary branch and re-run per-component `worktree_setup_command` hooks on wake — see [internals.md — Staff agent worktrees](internals.md#staff-agent-worktrees).
- **Editing.** The staff edit page (`#/staff/<id>`) can change name, description, system prompt, triggers, cwd, role, colour, accessory, and memory. Cwd changes must stay inside the staff's owning project.
- **Reassignment.** The orphan banner can re-home a legacy/orphaned staff record to a project. Reassignment resets cwd to the target project root and drops old session/worktree metadata so old-project paths cannot be reused.
- **Deletion.** Removing the staff also terminates its current session and cleans up the staff branch when one exists.

## Identity accessory

Each staff record stores an `accessory` field alongside its name, prompt, role, and memory. This value is the source of truth for the staff avatar/identity; it lives in `staff.json` and survives even when the staff has no current session.

The staff edit page initialises the accessory picker from `selectedStaff.accessory` and saves through `PUT /api/staff/:id`. It does not rely on `PATCH /api/sessions/:sid` to remember the choice. Session metadata only mirrors the staff value for rendering.

Permanent staff sessions copy `staff.accessory` when they are created or recreated. `PUT /api/staff/:id` also mirrors an accessory change to the linked current session when one exists, so the sidebar/avatar updates immediately. If that session is missing, archived, or later replaced, the next permanent session still inherits the persisted staff accessory.

## Project and cwd anchoring

Staff creation resolves a real, visible project before a record is written:

1. A non-empty `projectId` selects that registered project.
2. Otherwise, a non-empty `cwd` must be inside a registered project's `rootPath`.
3. If neither resolves, creation returns the standard project-resolution 400. The server/default cwd is not used as a fallback.

When `projectId` is supplied and `cwd` is missing or blank, Bobbit uses the selected project's `rootPath`. When both are supplied, the cwd must still be inside that same project.

The staff proposal panel is anchored to the proposal session's resolved project, not the mutable active project in the sidebar. This matters when the user changes active projects or reloads while a staff proposal is open: a blank proposal cwd is shown and submitted as the proposal session project's root path.

## Worktree preference

The creation panel exposes **Create worktree when supported**. The REST field is `worktree?: boolean`.

| Setting | Behavior |
|---|---|
| Omitted / `true` | Auto mode. Git-backed single-repo and multi-repo projects create a `staff-<name>-<id>` worktree derived from the project. |
| `false` | Opt-out. The staff session runs directly in the project root/subdirectory and stores no staff branch or `worktreePath`. |
| Non-git project | Auto mode degrades to no-worktree without failing. The staff session runs in the project directory. |

For subdirectory projects, the selected project-relative offset is preserved. Example: a project registered at `/repo/packages/app` gets a worktree at the repo root, but the staff process starts in the matching `packages/app` path inside that worktree.

## Edit and reassignment safeguards

`PUT /api/staff/:id` validates changed cwd values against the staff's own project. A new cwd outside that project, in another registered project, or blank is rejected. If a legacy/orphan record already has an unchanged cwd, the edit page may still save other fields without forcing reassignment first; changing that orphan cwd is rejected until the staff is attached to a real project.

`PATCH /api/staff/:id` reassigns a staff record to another project. It terminates/archives the old current session best-effort, moves the record between per-project stores, sets `cwd` to the target project's root, and clears old runtime fields (`currentSessionId`, `worktreePath`, `branch`, `repoPath`, `repoWorktrees`). The next wake creates fresh runtime state for the target project.

## Sandbox mode is a creation-time decision

**Staff sandbox mode is chosen once, at creation, and frozen for the staff's lifetime.** The choice is stored as a plain boolean (`PersistedStaff.sandboxed`) on the staff record itself. The project's `sandbox:` config is **not** consulted anywhere in the staff path — neither at creation, nor on wake, nor when the edit page renders the indicator.

This mirrors session sandboxing: a session's sandbox mode is fixed when it is created, and likewise cannot be flipped mid-life.

Sandboxed staff keep the same project-derived cwd contract inside the container:

- Worktree-backed staff run under `/workspace-wt/<branch>` plus any project-relative subdirectory offset.
- No-worktree staff run under `/workspace` plus the same offset.

### Why immutable

Sandboxed and host-mode agents live in fundamentally different filesystems:

- A **host** worktree-backed staff agent owns a real git worktree under the project's worktree root on the developer's machine.
- A **sandboxed** worktree-backed staff agent owns a worktree of the same branch name inside the project's Docker container.
- A no-worktree staff agent runs from the project checkout (`/workspace` in Docker), not from a staff branch.

Switching realms mid-life would mean tearing down one runtime and provisioning the other, with no good story for:

- Uncommitted edits, untracked files, and stashes living in the old location.
- A live wake session still executing against the old realm at the moment of the switch.
- Re-running per-component `worktree_setup_command` hooks in the new realm and recovering when they fail.
- Existing search/index entries and any cross-references to the old branch.

Rather than ship a half-correct migration that strands work, sandbox mode is intentionally fixed for the staff's lifetime. The same reasoning applies to sessions.

### How to "change" the sandbox mode of an existing staff

Delete the staff and create a new one with the desired mode. Memory, system prompt, and any other config can be copied across by hand. Make sure the old staff is committed/pushed before deleting if you care about its branch contents.

## Where you see and set sandbox mode in the UI

**At creation.** The staff creation assistant exposes a **Sandbox (Docker)** checkbox alongside the other staff fields. The toggle is **always visible** — including on projects that have no `sandbox:` config — because the choice belongs to the staff agent, not the project. Default: **off**. Whatever the user ticks at creation is what gets persisted onto the record. (When the project is not configured for Docker, ticking the box is still possible at this stage but session creation will reject it later; see "Validation timing" below.)

**After creation.** The staff edit page renders a read-only **Sandbox** indicator showing either `Enabled` or `Disabled`. This line reflects the persisted `staff.sandboxed` value verbatim — there is no toggle, no "inherited from project settings" hint, no Docker badge. If you need a different mode, delete and recreate.

## Legacy staff records

Older staff records may have no `sandboxed` field on disk. On load, those records normalise to `sandboxed: false`. There is **no in-place migration to `true`** — even if the project was Docker-configured when the staff was originally created, the legacy record reads as host-mode.

Older records may also have missing, blank, non-string, or unknown `accessory` values. On load and on write, those records normalise to `accessory: "none"` so they remain renderable and safe to edit.

Legacy records may also be orphaned: missing `projectId` or stored under the hidden system project. They are listed by `GET /api/staff/orphaned` and can be assigned to a real project from the sidebar orphan banner. Reassignment resets old-project cwd/worktree/session metadata as described above.

If a pre-existing staff should be running sandboxed, create a new staff with the toggle on. The legacy staff can then be deleted or kept as a host-mode peer.

## Validation timing

The `sandboxed: true` flag on the staff record is honoured even when the project is not Docker-configured — the value is just data. The mismatch surfaces when the staff first tries to spawn a session: the existing session-creation sandbox validation (which checks the project has a Docker image, that the daemon is reachable, etc.) is what fails, with the usual session-creation error path. There is no separate "validate the staff record against the project's sandbox config" step. This keeps the staff record's semantics simple — a boolean — and avoids racing two sources of truth.

## Code orientation

The user-facing model above is what matters; the file paths below are an orientation aid only.

- **Persistence.** `src/server/agent/staff-store.ts` (`PersistedStaff.sandboxed: boolean`; `PersistedStaff.accessory: string`; loader normalises missing `sandboxed` to `false` and missing/invalid `accessory` to `"none"`).
- **Spawn / wake.** `src/server/agent/staff-manager.ts` resolves project-scoped cwd/worktree state, reads `staff.sandboxed` for both initial spawn and every subsequent wake, and never consults the project's `isSandboxEnabled`. It also passes `staff.accessory` into staff session creation/recreation so the permanent session mirrors the staff avatar.
- **REST.** `POST /api/staff` accepts `sandboxed?: boolean`, `worktree?: boolean`, and `accessory?: string`. `GET /api/staff` and `GET /api/staff/:id` return the stored `sandboxed` value and normalised persisted `accessory`. `PUT /api/staff/:id` accepts `accessory` and mirrors it to the current staff session when present; it does not accept `sandboxed`, and attempts to change `sandboxed` are silently dropped.
- **UI.** Creation cwd/worktree/sandbox controls live in the staff assistant panel (`src/app/render.ts`). The read-only edit-page sandbox indicator and accessory picker live in `src/app/staff-page.ts`; the picker reads/writes the staff record, not the session record.
- **Tests.** `tests/e2e/staff-cwd-parity.spec.ts`, `tests/e2e/staff-patch-reassign.spec.ts`, and `tests/e2e/ui/staff-proposal-cwd-worktree.spec.ts` pin the project/cwd/worktree invariants. `tests/e2e/staff.spec.ts` and the sandbox indicator browser E2E pin sandbox persistence + immutability.
