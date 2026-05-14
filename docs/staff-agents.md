# Staff Agents

Staff agents are long-lived, project-scoped agents that survive across wake/sleep cycles instead of being recreated on each use. They are the right shape for "I have a recurring assistant that knows this project" — code reviewer, release captain, on-call triager — as opposed to a one-shot goal session.

This page covers the user-facing model. For the sidebar/UI placement see [internals.md — Staff agents in the sidebar](internals.md#staff-agents-in-the-sidebar); for the REST surface see [rest-api.md — Staff Agents](rest-api.md#staff-agents); for sidebar handling of legacy records see the orphan banner section in `internals.md`.

## Lifecycle at a glance

- **Creation.** The user opens a staff creation assistant from a project (sidebar "+ New staff" or the project header). The assistant proposes a `propose_staff` payload; accepting it persists a `PersistedStaff` record under that project and creates the staff's permanent worktree on a `staff-<name>-<id>` branch.
- **Wake / sleep.** Each interaction wakes the staff into a fresh session against the same worktree. Non-sandboxed staff have their worktree rebased onto the primary branch and per-component `worktree_setup_command` hooks re-run on wake — see [internals.md — Staff agent worktrees](internals.md#staff-agent-worktrees).
- **Editing.** The staff edit page (`#/staff/<id>`) can change name, description, system prompt, triggers, cwd, role, colour, and memory. A handful of properties are deliberately **immutable for the staff's lifetime**; see below.
- **Deletion.** Removing the staff also terminates its current session and cleans up the staff branch.

## Sandbox mode is a creation-time decision

**Staff sandbox mode is chosen once, at creation, and frozen for the staff's lifetime.** The choice is stored as a plain boolean (`PersistedStaff.sandboxed`) on the staff record itself. The project's `sandbox:` config is **not** consulted anywhere in the staff path — neither at creation, nor on wake, nor when the edit page renders the indicator.

This mirrors session sandboxing: a session's sandbox mode is fixed when it is created, and likewise cannot be flipped mid-life.

### Why immutable

Sandboxed and host-mode agents live in fundamentally different filesystems:

- A **host** staff agent owns a real git worktree under `<project-root>-wt/staff-<name>-<id>/` on the developer's machine.
- A **sandboxed** staff agent owns a worktree of the same name **inside the project's Docker container**, with no host counterpart.

Switching realms mid-life would mean tearing down one worktree and provisioning the other, with no good story for:

- Uncommitted edits, untracked files, and stashes living in the old worktree.
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

Staff records created before this change have no `sandboxed` field on disk. On load, those records normalise to `sandboxed: false`. There is **no in-place migration to `true`** — even if the project was Docker-configured when the staff was originally created, the legacy record reads as host-mode.

If a pre-existing staff should be running sandboxed, create a new staff with the toggle on. The legacy staff can then be deleted or kept as a host-mode peer.

## Validation timing

The `sandboxed: true` flag on the staff record is honoured even when the project is not Docker-configured — the value is just data. The mismatch surfaces when the staff first tries to spawn a session: the existing session-creation sandbox validation (which checks the project has a Docker image, that the daemon is reachable, etc.) is what fails, with the usual session-creation error path. There is no separate "validate the staff record against the project's sandbox config" step. This keeps the staff record's semantics simple — a boolean — and avoids racing two sources of truth.

## Code orientation

The user-facing model above is what matters; the file paths below are an orientation aid only.

- **Persistence.** `src/server/agent/staff-store.ts` (`PersistedStaff.sandboxed: boolean`; loader normalises missing field to `false`).
- **Spawn / wake.** `src/server/agent/staff-manager.ts` reads `staff.sandboxed` for both initial spawn and every subsequent wake. The project's `isSandboxEnabled` is not consulted.
- **REST.** `POST /api/staff` accepts `sandboxed?: boolean`. `GET /api/staff` and `GET /api/staff/:id` return the stored value verbatim. `PUT /api/staff/:id` does not accept `sandboxed`; attempts to change it are silently dropped.
- **UI.** Creation checkbox lives in the staff assistant panel (`src/app/render.ts`). The read-only edit-page indicator lives in `src/app/staff-page.ts`.
- **Tests.** `tests/e2e/staff.spec.ts` pins the persistence + immutability invariants; a browser E2E pins the create-flow toggle and the edit-page indicator round-trip.
