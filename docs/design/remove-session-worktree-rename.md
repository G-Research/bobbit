# Remove session worktree & branch renaming

**Status:** Design (proposed)
**Goal:** `goal-remove-poo-29a70b7e`
**Supersedes (partially):** `docs/design/multi-repo-components.md` §5.4 (session rename-on-first-prompt mechanics).

## 1. Problem

The worktree pool pre-builds branches as `pool/_pool-<id>`. When a regular
session claims one via `claimUnnamed()`, we keep the temporary branch name
in place and **defer** a rename to the first user prompt — at which point
`renameSessionFromPool` (and its multi-repo cousin
`_renameSessionFromPoolMultiRepo`) does:

1. `git branch -m pool/_pool-<id> session/<slug>-<id8>`
2. `git worktree move <oldPath> <newPath>` (or `fs.renameSync` of the
   per-branch container plus `git worktree repair` for multi-repo).
3. Persist the new `branch`, `worktreePath`, `cwd`, `repoWorktrees`; clear
   `poolId`; refresh the `RpcBridge` cwd.

Why this hurts:

- **Failure modes are non-trivial.** Each step can fail independently. Today
  we "succeed" on a partial outcome (branch renamed, dir not moved → degraded
  flag). The session ends up in a state where the on-disk dir name no longer
  matches the branch name, which confuses the boot sweeper, manual debugging,
  and any tool that infers branch from path.
- **Restart resume must reason about an in-flight rename.** Did the rename
  finish? Did half of the multi-repo fan-out succeed? The reconciliation
  burden is real (see `worktree-sweeper.ts` and the legacy `session/_pool-*`
  prefix tolerance in `isPoolBranch`).
- **Race with `setTitle`/`generateGoalTitle`.** Two concurrent rename
  triggers exist (lines 3603 and 3858 in `session-manager.ts`); both
  fire-and-forget. We rely on `session.poolId` being unset on the second
  call to no-op, but the gap between the two firings is a window for races
  and double-pushes to origin.
- **No functional value.** The `<slug>` portion is purely cosmetic — the
  display title is already a separate concern (`session.title`, plus the
  user-facing `PUT /api/sessions/:id/title` rename dialog). Branch and
  worktree directory names exist for git plumbing, not for users.
- **The cost of touching disk + refs after the user has started typing.**
  First-prompt latency is exactly when the session should be most
  responsive. We currently do extra work right then.

## 2. Goal

Eliminate all session worktree/branch renaming. A session claimed from the
pool keeps a stable, id-derived branch name and container directory from
creation through archive. No first-prompt rename. No degraded fallback path.

## 3. Decisions

### 3.1 New live-session branch name format

**Decision:** `session/<id8>` where `<id8>` is the **first 8 chars of the
session id** (full session UUIDs are 36 chars; 8 chars matches the existing
`-<id8>` slug suffix length and the `_pool-<8hex>` convention).

Justification:

- Stable and deterministic — known at session-row creation time, no slug
  computation needed.
- 8 hex chars is plenty given the per-project namespace (collision odds
  negligible relative to all other failure modes).
- Branch lengths stay short, which keeps Windows path-length budgets
  comfortable when combined with the per-repo nesting in multi-repo
  projects (`<rootPath>-wt/session-<id8>/<repo>/...`).
- Symmetric with `pool/_pool-<id8>` and `goal/<slug>-<id8>` — readers can
  scan branch lists and see the namespace at a glance.

The `<slug>` half is **dropped** entirely. Display titles continue to live
on `session.title` (independent of git refs) and remain user-editable via
the existing title-rename dialog.

### 3.2 Pool claim flow

**Decision: Option (a) — single `git branch -m` at claim time, no
worktree directory move.**

The pool keeps building entries on `pool/_pool-<poolId>` (no change to
`_fill()`). At `claimUnnamed()` time:

1. Generate the target branch name `session/<sessionId8>` *before* calling
   `claimUnnamed` (we know the session id by then — see §3.4).
2. Inside the pool, fan out a single `git branch -m pool/_pool-<poolId>
   session/<sessionId8>` per repo.
3. **Do not** rename the on-disk container directory. Its name is now an
   opaque id, not a branch slug.

The container directory's stable name is **`session-<sessionId8>`** —
chosen at claim time and never changed thereafter. This is *not* the
flattened branch slug (`session-<sessionId8>` happens to coincide because
we dropped the slug, but the convention is "container dir name = session
container id, fixed for life").

For multi-repo projects, the container is the per-branch directory and
each repo's worktree lives under `<container>/<repo>/<relative_path>`,
identical to today. The container is created with its final name at the
moment of claim — there is no `pool-_pool-<id>` directory naming step
that needs to be renamed away.

**Why not (b):** moving the directory is the part that fails on Windows
file locks; eliminating it eliminates the degraded-mode codepath entirely.
Branch renames are local ref ops and effectively can't fail in normal
operation.

**Why not (c):** the session id isn't known when the pool fills, so the
pool entry must have *some* name; we keep `pool/_pool-<id>` and rename
once at claim. The cost is one `git branch -m` per repo — single-digit
milliseconds.

#### 3.2.1 Pool fill changes

The pool's on-disk container directory is renamed from
`pool-_pool-<id>/` to `session-<sessionId8>/` **at claim time** by
producing the directory with that name from the start. Concretely:

- `_fill()` still creates `pool/_pool-<id>` worktrees on disk under
  `<rootPath>-wt/pool-_pool-<id>/`. **No change.**
- `claimUnnamed(sessionId)` (new signature) computes the target container
  path `<rootPath>-wt/session-<sessionId8>/`, calls `git branch -m`, then
  performs **one** filesystem rename of the container directory plus
  `git worktree repair` per repo (multi-repo only) — analogous to the
  existing claim path but executed once at claim, never again.

Wait — that contradicts the "no directory move" claim. Let me restate.

**Correction.** The cleanest implementation is:

- **Single-repo:** the pool fills at `pool-_pool-<id>/`. At claim we rename
  the branch (`git branch -m`) **and** rename the container directory once
  via `git worktree move` — but **only at claim**, not deferred to first
  prompt. After claim, the directory is `session-<sessionId8>/` and never
  changes again.
- **Multi-repo:** identical — `fs.renameSync` of the container plus
  `git worktree repair` per repo, **once at claim**.

The reduction in scope vs. today is that the rename happens **synchronously
during session creation**, not asynchronously on first prompt. There is no
"degraded mode" — if the directory rename fails at claim, the claim itself
fails and we fall back to `createWorktree` (legacy path that synthesizes the
branch up front under its final name).

Rationale for keeping the directory rename at claim (instead of leaving the
container as `pool-_pool-<id>`): readability and operator sanity. Branch
name and dir name should match for grep-debugging. The flake risk is
contained because (a) it happens at claim, before the session is published
to the user, and (b) on failure we can fall back cleanly to `createWorktree`
without a half-renamed state to repair.

> **Implementation note.** The "no directory move" framing in the goal spec
> is rejected here in favour of "directory move once at claim, never
> deferred." This is still a reduction from today (one move not two; no
> degraded persistent state) and the team lead should confirm before
> implementation.

### 3.3 Multi-repo invariant

A multi-repo claim is a single fan-out:

1. `fs.renameSync(<wtRoot>/pool-_pool-<id>, <wtRoot>/session-<sessionId8>)`
   — atomic on the same filesystem.
2. `Promise.all(repos.map(repo => git branch -m pool/_pool-<id>
   session/<sessionId8>))` inside each per-repo worktree dir.
3. `Promise.all(repos.map(repo => git worktree repair <newPath>))` from
   each parent repo so the admin entries point at the new container.

If step 1 fails, the whole claim fails — fall back to
`createWorktreeSet` on a freshly-named branch (no half-state).

If step 2 fails for one repo, the claim fails and we clean up
(`cleanupWorktree` per repo) — same disposition as today's pool claim
failure path.

After a successful claim, **every repo worktree is on
`session/<sessionId8>` and lives under `<wtRoot>/session-<sessionId8>/`**.
There is no first-prompt rename to fan out, no
`_renameSessionFromPoolMultiRepo`, no degraded per-repo state.

### 3.4 Session creation order

To know the session id at claim time, the call sequence becomes:

1. Allocate `sessionId` (today's pre-claim step — no change).
2. Compute `targetBranch = "session/" + sessionId.slice(0, 8)`.
3. Call `pool.claim(targetBranch)` (existing API; the legacy `claim()`
   that takes a target branch already does the rename — we route the
   session-creation path through this instead of `claimUnnamed()`).
4. `claimUnnamed()` is **deleted**.

This collapses the two pool-claim APIs into one and eliminates the
deferred-rename plumbing entirely.

## 4. Files to delete / modify

### 4.1 Delete

- **`renameSessionFromPool` and `_renameSessionFromPoolMultiRepo`** in
  `src/server/agent/session-manager.ts` (lines ~3865–4045).
- **Two call sites** at `session-manager.ts:3603` (in `setTitle`) and
  `:3858` (in `_generateGoalTitleAsync`).
- **`claimUnnamed()` and `UnnamedClaim`** in `worktree-pool.ts` — sole
  consumer was the deferred-rename path.
- **`session.poolId` field** on `SessionInfo` (`session-manager.ts:193`)
  and `PersistedSession` (`session-store.ts:82`). Audit confirms its
  only consumers are `renameSessionFromPool` and the persistence
  read/write at `session-manager.ts:2647, 2794, 2836–2843,
  3937, 3953, 4023, 4036`. After the rename helpers go, no one reads it.
  Remove `"poolId"` from `WRITABLE_FIELDS` (line ~139) and the explicit
  list at line ~261. Migration: existing persisted sessions with a stale
  `poolId` field — the field is just ignored on load (no schema check
  rejects unknown fields), so no migration required.
- **`session.worktreeDegraded` field** — degraded mode is gone. Also a
  silent-ignore field on load if any persisted records have it set.
- **`moveWorktree` in `src/server/skills/git.ts`** — confirm via post-
  refactor `grep -rn moveWorktree src/`; the only callers today are
  `worktree-pool.ts::claim` (kept — see §3.2.1) and
  `session-manager.ts::renameSessionFromPool` (deleted). If `pool.claim`
  is the sole remaining caller, **inline** it into `worktree-pool.ts` as
  a private helper rather than keeping a public skill export, since it
  no longer has the "skill" use-case justification.
- **Comment at `session-store.ts:79–80`** — referencing "cleared when
  the rename succeeds (Phase 3, multi-repo design)". Delete with the
  field.
- **Legacy prefix tolerance** — `isPoolBranch` and the orphan-reclaim
  scan currently accept both `pool/_pool-*` and the pre-Phase-3
  `session/_pool-*` prefix. **Keep** the pool-branch tolerance (back-
  compat for in-flight pool entries across upgrades). **Drop** the
  symmetric tolerance for `session-_pool-*` directory slugs — these
  cannot exist post-refactor (no pool-named directory ever survives
  claim).

### 4.2 Modify

- **`src/server/agent/worktree-pool.ts`:**
  - `claim()` is kept and is the only public claim API.
  - `claimUnnamed()` and `UnnamedClaim` removed.
  - Update class doc comment ("Steps performed in the background…")
    to reflect that claim is now exclusively used for the
    final-named branch.
  - `freshenInBackground` unchanged.
- **`src/server/agent/session-manager.ts`:**
  - Replace the `claimUnnamed()` block (line ~2757) with a `claim(targetBranch)`
    call where `targetBranch = "session/" + id.slice(0, 8)`.
  - Drop the `unnamed.poolId` / `repoWorktrees` plumbing block at
    lines ~2794–2799 — `pool.claim` already returns the final
    `branchName`, `worktreePath`, and (for multi-repo) `worktrees`.
  - Drop the `if (session.poolId) { ... }` persist patch at
    lines ~2836–2843.
  - Remove `session.worktreeDegraded` reads/writes wherever they appear
    (the boot sweeper currently checks it; the sweeper logic
    simplifies to "branch matches expected, dir matches expected, else
    cleanup").
  - The `setTitle` and `_generateGoalTitleAsync` paths lose their
    `renameSessionFromPool(...)` calls — title changes are pure
    metadata updates now.
- **Restart resume** (`session-manager.ts::restoreSessions` and friends):
  - Remove any "is this still on a pool branch?" branching. Sessions
    persisted with `branch = pool/_pool-<id>` cannot exist after
    upgrade because the rename now happens **synchronously at claim**
    before the session row is broadcast. Old persisted records with
    pool branches are an upgrade-time concern only — see §6.
- **Boot sweeper** (`worktree-sweeper.ts`):
  - Active session detection: a session worktree should now match
    `<wtRoot>/session-<id8>/` exactly. Anything else is orphaned.
  - Drop the "renamed-but-orphaned" branch (where the rename completed
    on disk but persistence missed it) — that race is gone.

## 5. Test impact

### 5.1 Existing tests requiring updates

| Test file | Change |
|---|---|
| `tests/worktree-pool.test.ts` lines ~67–95 ("happy path: claim renames branch and moves directory") | Keep — already exercises the synchronous claim path. Update assertion at line ~89 to reflect that `path.basename(claim!.worktreePath)` is now `session-<id8>` not `session-test-12345678` (since the slug is gone). |
| `tests/worktree-pool.test.ts` lines ~96–124 ("degraded fallback") | **Delete.** Degraded mode no longer exists; failure paths fall back to `createWorktree`. Replace with a test that asserts a directory-rename failure causes `claim()` to return `null` (caller fallback). |
| `tests/worktree-pool.test.ts` lines ~125–144 ("claimUnnamed returns entry without renaming and yields a poolId") | **Delete** — `claimUnnamed` is gone. |
| `tests/worktree-pool-multi.test.ts` ("claimUnnamed should expose multi-repo worktrees", lines ~110–129) | **Delete** for the same reason. Add a multi-repo `claim()` test asserting per-repo branches all end on `session/<id8>` after a single claim call. |
| `tests/e2e/pool-flow.spec.ts` | Update the persistence-check loop (lines ~64–95) to expect `session/<id8>` immediately after session creation, not after first prompt. The current "branch starts with `pool/_pool-`" assertion describes the deferred-rename behaviour — invert it. |
| `tests/manual-integration/restart-minimal.spec.ts:199` | Comment/assertion describes `setTitle` triggering rename. Remove the rename expectation; assert title-set is metadata-only and branch is unchanged. |

### 5.2 New regression tests

1. **Pool-claim → first-prompt → branch unchanged** (unit, in
   `worktree-pool.test.ts`): claim a pool entry with target
   `session/abcd1234`, fire `setTitle("Whatever")`, assert `git branch
   --list` still shows exactly `session/abcd1234`. (Best done in the
   API E2E layer where `setTitle` is reachable.)
2. **Multi-repo claim consistency**
   (`tests/worktree-pool-multi.test.ts`): after `pool.claim("session/abcd1234")`,
   every repo's worktree is on `session/abcd1234` and located under
   `<wtRoot>/session-abcd1234/<repo>/`.
3. **Restart resume on a pool-claimed session**
   (`tests/manual-integration/restart-minimal.spec.ts` or analogous):
   create session → restart server before first prompt → resume →
   assert no rename code path runs (instrument via log probe or branch
   inspection). Branch should already be `session/<id8>`.
4. **Persisted session with legacy `poolId` loads cleanly** (unit):
   feed a `sessions.json` row with `branch: "pool/_pool-foo"` and
   `poolId: "_pool-foo"` into `SessionStore.load()` and assert the
   record loads without error and the orphaned worktree is cleaned up
   by the sweeper. (Upgrade safety.)

## 6. Upgrade & migration

In-flight state on upgrade:

- **Pool entries** (no session yet): unchanged. `pool/_pool-<id>` branches
  on disk continue to work; the next claim renames them via the new path.
- **Sessions on `pool/_pool-<id>` branches** (claimed pre-upgrade, not
  yet first-prompted): rare — the pre-upgrade window is short. The
  boot sweeper detects branch-name mismatch and treats them as orphaned;
  they get cleaned up. Acceptable because such sessions have no user
  data (no first prompt yet by definition) and the user's session-row
  in `sessions.json` is preserved on the goal/session list as a
  `preparing` row that the sweeper marks failed. Document in the
  release note.
- **Sessions with a stale `poolId` field on disk:** the field is silently
  ignored by the loader (already covered above).

## 7. Doc updates (for the documentation gate, not implementation)

- `AGENTS.md`: "Branch namespaces" line — drop `<slug>-<id>` from the
  session entry, change to `session/<id>` (using `<id>` to mean the
  8-char id8).
- `docs/internals.md` "Session worktrees" — drop the entire
  rename-on-first-prompt mechanics paragraph (lines ~586–592 in current
  HEAD). Update the namespace table at line ~549.
- `docs/dev-workflow.md`: namespace table at line ~255 — update
  `session/<slug>-<id>` row to `session/<id>` and drop the "after first
  prompt rename" wording.
- `docs/design/multi-repo-components.md` lines 469–558 (§5.4 in
  particular): mark §5.4 obsolete, link here.
- `docs/debugging.md` "Worktree setup not running on pool / staff" entry
  — references "pool claim, and rename-on-first-prompt mechanics"; drop
  the rename half.

## 8. Out of scope

- User-facing session title rename (`PUT /api/sessions/:id/title` and the
  rename dialog) — pure display-title updates, independent of branch.
- Goal/staff branch namespaces (`goal/<slug>-<id>`,
  `staff-<name>-<id>`) — these are created with their final name up
  front and have no rename phase to remove.
- The pool's internal `pool/_pool-<id>` namespace — kept; only the
  post-claim deferred rename to `session/<slug>-<id>` is being removed.

## 9. Acceptance criteria

1. `renameSessionFromPool` and `_renameSessionFromPoolMultiRepo` are
   gone. `grep -rn 'renameSessionFromPool\|_renameSessionFromPoolMultiRepo' src/`
   returns nothing.
2. `claimUnnamed` and `UnnamedClaim` are gone.
3. `session.poolId` is gone from `SessionInfo` and `PersistedSession`.
4. A session created from a warm pool has `branch = session/<id8>` from
   the moment it appears in `sessions.json` — verifiable by reading
   `sessions.json` immediately after `POST /api/sessions` and before the
   first prompt.
5. Multi-repo: every repo's worktree shows the same final branch name
   immediately on creation.
6. `git worktree move` calls in the session lifecycle are bounded to
   the single pool-claim call — no first-prompt move.
7. `worktreeDegraded` flag is gone (or unused on the read side).
8. All existing tests updated; new regression tests pass; restart-minimal
   manual integration test still green.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Synchronous directory rename at claim adds latency to session creation. | Single `fs.renameSync` (atomic on same fs) — sub-millisecond. The deferred path was an optimisation premised on first-prompt latency, but the rename was small even there. |
| A pool claim that fails at the directory-rename step now falls back to `createWorktree` (slow path) rather than degraded-but-usable. | Acceptable. The degraded mode was already a confusing state in production. Failure is rare (only seen on Windows file-lock contention). The fallback is the same code path used when the pool is empty — well-tested. |
| Persisted sessions still on `pool/_pool-<id>` branches across an upgrade. | See §6. Window is small (pre-first-prompt only); sweeper cleans them up; documented in release notes. |
| Future readers expect a `<slug>` in branch names for grep convenience. | Display title is on `session.title`. Operator UX: a follow-up could add `git config gitweb.description` per worktree; out of scope here. |

---

## 11. Fallback (non-pool) branch naming

The cold-pool / non-git / sandbox path today synthesises
`session/new-session-<id8>` (`session-manager.ts` line ~2762:
`const fallbackSlug = "session/new-session-" + uuid8;`). This is a second
naming scheme alongside the post-rename `session/<slug>-<id8>`.

**Decision: unify on `session/<id8>`.** Both warm-pool claims and
fallback-`createWorktree` calls produce branches of the form
`session/<id8>` — single namespace for all live regular sessions. The
`new-session-` prefix is dropped.

Rationale:

- One naming scheme is simpler than two; future readers don't need to
  ask "is this from the pool or the fallback path?"
- The `new-session-` prefix carried no semantic value — it was a
  workaround for not knowing the title at creation time, which is no
  longer relevant since we've severed branch names from titles.
- Sandbox sessions get the same treatment: branch name is computed as
  `session/<sessionId.slice(0,8)>` regardless of host vs sandbox.

Test impact (additions to §5.1):

| Test | Change |
|---|---|
| `tests/e2e/sandbox-branch-reconcile.spec.ts:63` | Update regex `/^session\/new-session-[a-f0-9]{8}$/` → `/^session\/[a-f0-9]{8}$/`. |
| `tests/e2e/sandbox-branch-reconcile.spec.ts:152` | Same regex update. |
| `tests/sandbox-branch-reconcile.test.ts:61,93,98,108,113,123,128` | Replace literal `session/new-session-620e30c0` with `session/620e30c0` (or whatever 8-hex prefix the fixture uses post-update). |

Acceptance criteria addition (§9):

9. **Fallback path also produces `session/<id8>`.** A session created
   when the pool is empty, when the project is non-git, or when the
   session is sandboxed has `branch = session/<id8>` — same format as
   the warm-pool path. No `session/new-session-*` branches exist
   anywhere in `sessions.json` or in `git branch --list` output across
   any path.

## 12. Directory-vs-branch slug formula

The container directory name is derived from the branch name by
flattening slashes:

```
dirName = branch.replace(/\//g, "-")
```

This matches the existing convention in `worktree-pool.ts::branchToSlug`
and is the **single source of truth** post-refactor.

**Worked example:**

| Branch | Container dir |
|---|---|
| `session/abcd1234` | `<wtRoot>/session-abcd1234/` |
| `pool/_pool-deadbeef` | `<wtRoot>/pool-_pool-deadbeef/` (pool fill-time) |
| `goal/cleanup-foo-12345678` | `<wtRoot>/goal-cleanup-foo-12345678/` (unchanged) |

Before/after for a session claimed from a warm pool, session id starts
with `abcd1234…`:

| Stage | Pre-refactor | Post-refactor |
|---|---|---|
| Pool fill | branch `pool/_pool-deadbeef`, dir `<wtRoot>/pool-_pool-deadbeef/` | identical |
| Claim | branch `pool/_pool-deadbeef` (deferred), dir same | branch `session/abcd1234`, dir `<wtRoot>/session-abcd1234/` (renamed at claim) |
| First prompt | branch renamed to `session/<slug>-abcd1234`, dir renamed to `<wtRoot>/session-<slug>-abcd1234/` | **no change** — already on final names |
| Archive | cleanup `session/<slug>-abcd1234` | cleanup `session/abcd1234` |

The "directory equals flattened branch" invariant holds at every stage
post-claim. The boot sweeper relies on this.

## 13. `worktree-sweeper.ts` upgrade behavior

The sweeper post-refactor classifies every directory under
`<rootPath>-wt/` against three patterns:

| Pattern | Source | Action |
|---|---|---|
| `^session-([a-f0-9]{8})$` | Live regular session (post-refactor) | Match against `sessions.json`. If a non-archived session row owns it → keep. Else → orphan, schedule cleanup. |
| `^pool-_pool-[a-f0-9]{8}$` | Pool fill (current convention) | Match against the in-memory pool. If present → keep. Else → reclaim into pool (unchanged behaviour). |
| `^session-[a-z0-9-]+-[a-f0-9]{8}$` (longer slug between) | **Legacy upgrade-window orphan** — pre-refactor `session/<slug>-<id8>` directory whose session row has been migrated/cleared. | Match against `sessions.json`. If owned → keep (back-compat: a still-live pre-upgrade session may be on the legacy dir name and be allowed to live out its lifetime). If unowned → orphan, schedule cleanup. |
| `^session-new-session-[a-f0-9]{8}$` | Legacy fallback-path orphan | Same as above row. |
| `^goal-[a-z0-9-]+-[a-f0-9]{8}$` | Goal worktree | Unchanged. Match against `goals.json`. |
| `^staff-[a-z0-9-]+-[a-f0-9]{8}$` | Staff worktree | Unchanged. Match against `staff.json`. |
| `^pool-_pool-[a-f0-9]{8}$` legacy `session-_pool-` synonym | Pre-Phase-3 pool dir | Unchanged: reclaim into pool via `isPoolBranch` tolerance. |
| Anything else | Foreign | Leave alone (today's behaviour — never touch unknown dirs). |

The "renamed-but-orphaned" reconciliation branch in the current sweeper
(where the rename completed on disk but persistence missed it) is
**deleted** — that race no longer exists because the rename happens
synchronously inside `pool.claim()` before the session row is persisted.

Upgrade window: pre-existing legacy `session-<slug>-<id8>` and
`session-new-session-<id8>` directories owned by still-live persisted
sessions are tolerated indefinitely (the session keeps running on its
old branch). Once those sessions archive normally, their cleanup path
removes the worktree, after which no legacy patterns remain.

## 14. `moveWorktree` fate

**Definitive:** `moveWorktree` is **deleted** from
`src/server/skills/git.ts` and **inlined as a private helper** in
`src/server/agent/worktree-pool.ts`.

Justification: the only post-refactor caller is `pool.claim()`. The
"skill" abstraction in `skills/git.ts` exists for things multiple call
sites share; a single private caller is better expressed as a private
helper next to its only consumer. This also removes an export from the
skills surface that was always more git-plumbing than skill.

## 15. `PoolClaimResult.degraded` flag — keep or drop

**Decision: keep `PoolClaimResult.degraded` as a transient claim-result
signal; drop the persisted `session.worktreeDegraded` field.**

- `PoolClaimResult.degraded` (in-memory result of `pool.claim()`) stays
  as an internal signal for the caller to decide whether to log a
  warning / fall back. Post-refactor, "degraded" means the directory
  rename failed but the branch rename succeeded — a transient, in-memory
  state inside one `claim()` invocation. Whether to treat that as a
  hard failure (return `null`, fall back to `createWorktree`) or
  proceed-with-warning is an implementation detail; the field gives
  `claim()` the flexibility to decide.
- `session.worktreeDegraded` (the **persisted** flag on
  `PersistedSession` and `SessionInfo`) is **deleted**. There is no
  longer any state worth persisting: post-claim, every successful
  session has branch == flattened-dir-name, full stop. Any session with
  an inconsistent state is broken and should be cleaned up by the
  sweeper, not kept around with a flag.

This is consistent with the broader principle: in-memory transient
state is cheap to express; on-disk persistent state is a contract that
must be maintained across restarts and migrations. The fewer flags on
disk, the fewer migration paths.

## 16. E2E test plan

### 16.1 Updates to `tests/e2e/pool-flow.spec.ts:64-95`

Replace the current "warm to `pool/_pool-*` then session creation
claims one" assertion sequence with a stepwise lifecycle assertion:

```ts
// Step 1: Pool warms with pool/_pool-* entries (unchanged).
// Loop polls pool status until ≥ 1 entry with branch matching
// /^pool\/_pool-[a-f0-9]{8}$/.

// Step 2: Create a session via POST /api/sessions.
// IMMEDIATELY after the response (before any prompt), read sessions.json
// (or hit GET /api/sessions/<id>):
//
//   expect(persisted.branch).toMatch(/^session\/[a-f0-9]{8}$/);
//   expect(persisted.branch).not.toMatch(/^pool\//);
//   expect(persisted.branch).not.toMatch(/^session\/new-session-/);
//
// Verify the on-disk worktree dir is `<wtRoot>/session-<id8>/`.

// Step 3: Send the first prompt via WS / POST.
// After the prompt round-trips, re-read persistence:
//
//   expect(persisted.branch).toBe(<branch from step 2>);
//
// I.e. the branch name is byte-equal to what step 2 saw — no rename
// occurred. Also assert no `git branch -m` ran (probe via session log
// scrape for the absence of the legacy "Renaming pool worktree" log
// line that renameSessionFromPool used to emit).

// Step 4: Set the title via PUT /api/sessions/<id>/title.
// Confirm metadata-only:
//
//   expect(persisted.title).toBe("Whatever");
//   expect(persisted.branch).toBe(<branch from step 2>);  // unchanged

// Step 5: Archive via DELETE /api/sessions/<id>.
// Confirm worktree cleanup uses the final branch name (no orphan
// session/new-session-* or session/<slug>-<id8> branches left in
// git branch --list).
```

### 16.2 New restart-resume E2E

**File:** `tests/e2e/pool-claim-restart-resume.spec.ts` (new spec, sits
alongside `pool-flow.spec.ts`).

**Scenario.** Pool warms; create a session (claims a pool entry on
`session/<id8>`); send the first prompt and wait for completion;
restart the gateway via the harness; re-attach to the session via WS
resume; assert that across the entire lifecycle the persisted `branch`
field is byte-stable (`branch` after restart === `branch` before
restart === `branch` immediately after creation), no `git branch -m`
ever ran (log probe: no `[session-manager] Renaming pool worktree`
lines in either pre-restart or post-restart server log; symbol grep
on the running build asserts `renameSessionFromPool` doesn't exist),
and the worktree dir on disk has not moved (inode-stable on
Linux/macOS via `fs.statSync(<wtRoot>/session-<id8>/).ino`; on Windows
just assert `existsSync` plus contents-unchanged).

### 16.3 Multi-repo lifecycle E2E

**Extend `tests/e2e/multi-repo-pool.spec.ts`** with a new test case:
`"multi-repo session lifecycle: branch + dir stable across creation, prompt, restart, archive"`.

Scenario:

1. Register a multi-repo project (2+ repos, including one data-only).
2. Wait for the pool to warm at least one multi-repo set.
3. `POST /api/sessions` → claim from the pool.
4. Immediately assert: every repo's worktree at
   `<wtRoot>/session-<id8>/<repo>/`, every repo's branch is
   `session/<id8>`, byte-identical across repos.
5. Send first prompt; re-assert all values unchanged.
6. Restart gateway; resume; re-assert all values unchanged.
7. Archive; assert all per-repo branches deleted from each repo's
   local refs (and remote, gated by `BOBBIT_TEST_NO_PUSH`).

The existing single-claim test in `tests/worktree-pool-multi.test.ts`
(unit-level) covers claim mechanics; this E2E layer covers the full
lifecycle through real REST + WS + restart.

### 16.4 Coverage matrix

| Path | Unit | API E2E | Browser E2E | Manual integration |
|---|---|---|---|---|
| Warm-pool claim → `session/<id8>` | `worktree-pool.test.ts` (updated) | `pool-flow.spec.ts` (updated) | n/a | n/a |
| Cold-pool fallback → `session/<id8>` | `sandbox-branch-reconcile.test.ts` (regex update) | `sandbox-branch-reconcile.spec.ts` (regex update) | n/a | n/a |
| First-prompt branch stability | new unit asserting `setTitle` no-op on branch | `pool-flow.spec.ts` step 3-4 (updated) | n/a | n/a |
| Restart resume preserves branch | n/a | `pool-claim-restart-resume.spec.ts` (new) | n/a | `restart-minimal.spec.ts:199` (updated) |
| Multi-repo lifecycle | `worktree-pool-multi.test.ts` (updated) | `multi-repo-pool.spec.ts` (extended) | n/a | n/a |
| Sweeper handles legacy `session-<slug>-<id8>` orphans | new `tests/worktree-sweeper.test.ts` case | n/a | n/a | n/a |

