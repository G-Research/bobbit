# Design: Fix orphaned remote branch cleanup

**Goal:** stop Bobbit from leaking remote branches on goal-archive and session-archive.
**Status:** design.
**Scope:** code fixes for two real bugs + verification of the staff path. The
136-branch remote backlog is out-of-scope (one-shot script, follow-up goal).

## Bug 1 — `deleteRemoteGoalBranches` reads a mutated team entry

### Root cause (mutation timing)

`DELETE /api/goals/:id` in `src/server/server.ts:2744-2782`:

```ts
// L2754-2755 — capture team entry handle
const goalProjectCtx = projectContextManager.getContextForGoal(id);
const teamEntry = goalProjectCtx?.teamStore.get(id);   // shared object reference

// L2759-2766 — teardown mutates teamEntry.agents in place
if (teamState) await teamManager.teardownTeam(id);

// L2773 — now reads agents from the same (now empty) array
deleteRemoteGoalBranches(archivedGoal, teamEntry, archivedGoal.repoPath).catch(...);
```

`teamStore.get(id)` returns the live `PersistedTeamEntry` object held in the
store's `Map<string, PersistedTeamEntry>` (`src/server/agent/team-store.ts:23,
65-67`). It is **not** a clone.

`teardownTeam` (`src/server/agent/team-manager.ts:1302-1356`) iterates the
agents and calls `dismissRole(sessionId)` on each. Inside `dismissRole`
(`team-manager.ts:1087-1170`):

- `team-manager.ts:1136` — `entry.agents.splice(agentIndex, 1)` removes the
  agent from the **in-memory** `TeamEntry`.
- `team-manager.ts:1139` — `this.persistEntry(goalId)` then calls
  `teamStore.put(toPersistedEntry(entry))` (`team-manager.ts:250-255`), which
  builds a **new** `PersistedTeamEntry` and replaces the map slot.

After the last `dismissRole`, `teardownTeam` runs:

- `team-manager.ts:1351` — `this.teams.delete(goalId)`
- `team-manager.ts:1352` — `this.resolveTeamStore(goalId).remove(goalId)` —
  the persisted entry is now gone.

**But:** `teamEntry` captured at L2755 is the *original* persisted object,
which was last fully replaced at L1139 of the **last** `dismissRole`. The
final replacement passed `entry.agents` (already spliced down to length-1,
then 0). So `teamEntry.agents` is empty by the time
`deleteRemoteGoalBranches` runs.

Net effect: only `goal.branch` (the team-lead branch) gets push-deleted at
`server.ts:96-101`. Every per-role `goal-goal-<slug>-<id>-<role>-<short>`
branch leaks.

### Fix

Snapshot the agent branch list **before** teardown into a plain `string[]`
and pass that to the helper (instead of the mutable team entry).

**File:** `src/server/server.ts` (~L86-117 + L2754-2776).

```ts
// New signature — accepts a flat list, not the mutable entry.
async function deleteRemoteGoalBranches(
    goal: PersistedGoal,
    extraBranches: readonly string[],
    repoPath: string,
): Promise<void> {
    const branches = new Set<string>();
    if (goal.branch) branches.add(goal.branch);
    for (const b of extraBranches) {
        if (b) branches.add(b);
    }
    if (branches.size === 0) return;
    if (shouldSkipRemotePush()) return; // belt-and-braces gate
    for (const branch of branches) {
        try {
            await execFileAsync("git", ["push", "origin", "--delete", branch], {
                cwd: repoPath, timeout: 15_000,
            });
            console.log(`[api] Deleted remote branch: ${branch}`);
        } catch (err) {
            console.warn(`[api] Failed to delete remote branch ${branch}:`, err);
        }
    }
}
```

Caller (`server.ts:2754-2776`):

```ts
const goalProjectCtx = projectContextManager.getContextForGoal(id);
const teamEntry = goalProjectCtx?.teamStore.get(id);

// Snapshot agent + team-lead session branches BEFORE teardown mutates anything.
const agentBranches: string[] = [];
if (teamEntry?.agents) {
    for (const a of teamEntry.agents) {
        if (a.branch) agentBranches.push(a.branch);
    }
}
// Include the team-lead's own session branch if it differs from goal.branch.
// (teamLeadSessionId is in PersistedTeamEntry; resolve via sessionStore.)
if (teamEntry?.teamLeadSessionId) {
    const tl = goalProjectCtx?.sessionStore.get(teamEntry.teamLeadSessionId);
    if (tl?.branch) agentBranches.push(tl.branch);
}

const teamState = teamManager.getTeamState(id);
if (teamState) {
    try { await teamManager.teardownTeam(id); }
    catch (err) { console.error(`[api] Error tearing down team for goal ${id}:`, err); }
}
const deleteGoalMgr = getGoalManagerForGoal(id);
await deleteGoalMgr.archiveGoal(id);

const archivedGoal = deleteGoalMgr.getGoal(id);
if (archivedGoal?.repoPath) {
    deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath)
        .catch(err => console.warn(`[api] Remote branch cleanup failed for goal ${id}:`, err));
}
```

Why this works: `agentBranches` is a fresh `string[]` containing values copied
out of the entry **before** `dismissRole` empties it. The captured strings
cannot be mutated by anything downstream.

The helper continues to dedupe via `Set` so the team-lead branch appearing in
both `goal.branch` and via `teamLeadSessionId` only gets one delete call.

### Side note

We do **not** need to import `PersistedTeamEntry` into the helper anymore —
its only consumer in `server.ts` is now type-erased.

---

## Bug 2 — `session/*` branches accumulate on remote

### Root cause

`session-manager.terminateSession` (`src/server/agent/session-manager.ts:3464-3578`)
does **not** push-delete the remote branch. It archives the session
(`L3565: terminateStore.archive(id)`). The actual `cleanupWorktree(...,
deleteBranch=true)` call lives in `purgeOneSession`
(`session-manager.ts:3721-3766`, line 3750):

```ts
await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true);
```

`purgeOneSession` only runs from:

1. `purgeArchivedSession` (manual UI purge), or
2. `purgeExpiredArchives` — invoked by `setInterval(... 24h)` at
   `session-manager.ts:4010-4014`, with a 7-day threshold
   (`session-manager.ts:3702-3704`).

Result: `session/*` branches survive ≥7 days on remote, and because the
24-hour interval restarts on every dev-server restart, the backlog never
drains in practice (110 of 136 leaked branches).

### Fix

On `terminateSession`, after the session is archived, fire-and-forget a
remote-branch delete *iff*:

- it's a non-delegate session (delegates share the parent's branch),
- the session has a `branch` and `repoPath`,
- the branch name starts with `session/` (don't touch goal/staff branches),
- the branch is fully merged into `origin/<primary>` (cheap ancestor check),
- `shouldSkipRemotePush()` is false.

Local worktree cleanup stays in `purgeOneSession` at the 7-day mark — that
preserves the archived-session review experience.

**File:** `src/server/agent/session-manager.ts` (insert near end of
`terminateSession`, after `terminateStore.archive(id)` at L3565 and before
the termination listener loop at L3567).

Code sketch:

```ts
// Eager remote branch delete for merged session/* branches.
// Local worktree cleanup is deferred to purgeOneSession (7-day archive).
this.maybeEagerDeleteRemoteSessionBranch(session).catch(err => {
    console.warn(`[session-manager] Eager remote-delete failed for ${id}:`, err);
});
```

New private method (anywhere convenient — colocate with `purgeOneSession`):

```ts
private async maybeEagerDeleteRemoteSessionBranch(session: SessionInfo): Promise<void> {
    if (session.delegateOf) return;
    const branch = session.branch;
    const repo = session.repoPath;
    if (!branch || !repo) return;
    if (!branch.startsWith("session/")) return;
    if (shouldSkipRemotePush()) return;

    // Detect primary branch and verify the session branch is fully merged.
    const primary = await detectPrimaryBranch(repo).catch(() => "master");
    try {
        await execFileAsync("git",
            ["merge-base", "--is-ancestor", branch, `origin/${primary}`],
            { cwd: repo, timeout: 10_000 });
    } catch {
        // Non-zero exit ⇒ not an ancestor (unmerged) OR refs missing. Skip.
        return;
    }

    try {
        await execFileAsync("git", ["push", "origin", "--delete", branch], {
            cwd: repo, timeout: 15_000,
        });
        console.log(`[session-manager] Deleted merged remote session branch: ${branch}`);
    } catch (err) {
        // Remote delete may fail (already deleted, network, auth) — non-fatal
        console.warn(`[session-manager] Failed to delete remote branch ${branch}:`, err);
    }
}
```

`SessionInfo` already carries `branch` and `repoPath`
(`session-store.ts:62-64`, mirrored to in-memory `SessionInfo` via
`session-setup.ts:435-438`). Imports needed at top of `session-manager.ts`:
`shouldSkipRemotePush, detectPrimaryBranch` from `../skills/git.js` (both are
already exported there — `git.ts:15-17` and `git.ts:55-72`).

`execFileAsync` is already imported via the `execFile` promisified handle
elsewhere in the file (search confirms `execFileAsync(... "git" ...)` calls
exist in this module — reuse the existing import).

#### Why `merge-base --is-ancestor`?

- O(1) graph walk; no network round-trip if `origin/<primary>` is current.
- Returns exit 0 iff `<branch>` is reachable from `origin/<primary>` —
  equivalent to "the branch is merged".
- If `origin/<primary>` is stale we're slightly conservative (skip delete).
  That's acceptable — `purgeExpiredArchives` will mop up after 7 days.

#### Order of operations

`terminateSession` already calls `session.rpcClient.stop()` at L3517 and
broadcasts `session_archived` at L3559 before this hook fires. The remote
delete is genuinely fire-and-forget; nothing blocks the API response.

---

## Bug 3 — `staff-*` branches (verify only, no code change)

`staff-manager.ts:195` calls:

```ts
await cleanupWorktree(staff.cwd, staff.worktreePath, staff.branch, true);
```

`cleanupWorktree` in `src/server/skills/git.ts:264-313`:

```ts
// L296-307
if (deleteBranch && branchName) {
    try {
        await execFile("git", ["branch", "-D", branchName], { cwd: repoPath });
    } catch { /* branch may not exist */ }
    if (!shouldSkipRemotePush()) {                              // L298
        try {
            await execFile("git", ["push", "origin", "--delete", branchName], {
                cwd: repoPath,
                timeout: 15_000,
            });                                                  // L300-303
        } catch {
            // Remote may not exist, branch may not be pushed, or network unreachable
        }
    }
}
```

Confirmed: the staff path push-deletes the remote branch. **No code change.**
The 1 leaked `staff-*` branch on remote almost certainly predates this code
or was a one-off — out of scope.

---

## Tests

### Bug 2 — unit test (focused, no full E2E harness)

`tests/orphan-branch-eager-delete.test.ts` (Node test runner; no Playwright
needed — pure logic test).

Strategy: test the new `maybeEagerDeleteRemoteSessionBranch` logic in
isolation by stubbing `execFile`. Cleanest path is to **extract the eager-
delete logic into a small pure helper** that takes `(branch, repoPath, exec)`
and let the test pass a fake `exec`.

Refactor: introduce in `src/server/agent/session-eager-branch-delete.ts`:

```ts
export async function eagerDeleteRemoteSessionBranch(opts: {
    branch?: string;
    repoPath?: string;
    delegateOf?: string;
    skipPush: boolean;
    detectPrimary: (cwd: string) => Promise<string>;
    runGit: (args: string[], cwd: string) => Promise<void>; // throws on non-zero
}): Promise<{ deleted: boolean; reason?: string }> { /* see sketch above */ }
```

`session-manager.ts` then composes it with the real `execFile`,
`detectPrimaryBranch`, `shouldSkipRemotePush()`.

Tests:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eagerDeleteRemoteSessionBranch } from "../src/server/agent/session-eager-branch-delete.js";

function recorder() {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    return { calls, run: async (args: string[], cwd: string) => { calls.push({ args, cwd }); } };
}

test("merged session branch is push-deleted exactly once", async () => {
    const r = recorder();
    const result = await eagerDeleteRemoteSessionBranch({
        branch: "session/abc-12345678",
        repoPath: "/tmp/repo",
        skipPush: false,
        detectPrimary: async () => "master",
        runGit: r.run, // both is-ancestor + push --delete succeed
    });
    assert.equal(result.deleted, true);
    const pushCalls = r.calls.filter(c => c.args[0] === "push");
    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].args, ["push", "origin", "--delete", "session/abc-12345678"]);
});

test("unmerged session branch is NOT deleted", async () => {
    const r = recorder();
    const runGit = async (args: string[], cwd: string) => {
        if (args[0] === "merge-base") throw new Error("not ancestor"); // exit 1
        return r.run(args, cwd);
    };
    const result = await eagerDeleteRemoteSessionBranch({
        branch: "session/foo",
        repoPath: "/tmp/repo",
        skipPush: false,
        detectPrimary: async () => "master",
        runGit,
    });
    assert.equal(result.deleted, false);
    assert.equal(r.calls.filter(c => c.args[0] === "push").length, 0);
});

test("non-session branch is skipped", async () => {
    const r = recorder();
    const result = await eagerDeleteRemoteSessionBranch({
        branch: "goal/something",
        repoPath: "/tmp/repo",
        skipPush: false,
        detectPrimary: async () => "master",
        runGit: r.run,
    });
    assert.equal(result.deleted, false);
    assert.equal(r.calls.length, 0);
});

test("delegate session is skipped", async () => {
    const r = recorder();
    const result = await eagerDeleteRemoteSessionBranch({
        branch: "session/foo",
        repoPath: "/tmp/repo",
        delegateOf: "parent-id",
        skipPush: false,
        detectPrimary: async () => "master",
        runGit: r.run,
    });
    assert.equal(result.deleted, false);
});

test("shouldSkipRemotePush short-circuits — no git calls at all", async () => {
    const r = recorder();
    const result = await eagerDeleteRemoteSessionBranch({
        branch: "session/foo",
        repoPath: "/tmp/repo",
        skipPush: true,
        detectPrimary: async () => "master",
        runGit: r.run,
    });
    assert.equal(result.deleted, false);
    assert.equal(r.calls.length, 0);
});
```

Why a focused unit test rather than extending `in-process-harness.ts`: the
in-process harness sets `BOBBIT_TEST_NO_PUSH=1` globally and never spins up a
real remote — exactly the wrong shape for asserting we *would* have called
`git push --delete`. Stubbed-helper test is cleaner, faster, and avoids
race-y polling of `git ls-remote`.

### Bug 1 — E2E test against a local bare-repo origin

`tests/e2e/goal-archive-branch-cleanup.spec.ts` — must spin up a real remote
because the bug is in **call-site composition** (data flow), not in a single
function we can unit-test.

#### Harness extension

The default `in-process-harness.ts` sets `BOBBIT_TEST_NO_PUSH=1` (L90). We
need to opt out for this one spec without affecting other workers.
`shouldSkipRemotePush()` reads `process.env` per call (`git.ts:15-17`), so
**unsetting `BOBBIT_TEST_NO_PUSH` inside the test scope** works safely — but
since the fixture is worker-scoped, doing this in a worker that *also* runs
other specs would break their assumptions.

Cleanest solution: **co-locate this spec in its own Playwright project** in
`tests/e2e/playwright-e2e.config.ts` so it runs in an isolated worker, with a
`webServer`-style env override. Or — simpler — put it in a separate file
that uses a custom fixture extending `in-process-harness` but resets the env
flag before fixture init. Recommend: standalone fixture file
`tests/e2e/in-process-harness-realpush.ts` that mirrors `in-process-harness`
minus the `BOBBIT_TEST_NO_PUSH = "1"` line, and register the spec under its
own Playwright project entry in `playwright-e2e.config.ts`.

Either option is acceptable; the implementer should pick whichever produces
a smaller diff. The standalone fixture is preferred because the line count
is small (~60 lines copied) and isolation is bulletproof.

#### Test setup

```ts
import { test, expect } from "./in-process-harness-realpush.js";   // realpush variant
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFetch, createGoal } from "./e2e-setup.js";

test.setTimeout(60_000);

test("archiving a team goal deletes all per-role remote branches", async () => {
    // 1. Set up a local bare-repo "origin" + a clone-with-master-commit.
    const tmpRoot = mkdtempSync(join(tmpdir(), "bobbit-bare-"));
    const bareRepo = join(tmpRoot, "origin.git");
    const workRepo = join(tmpRoot, "work");
    execFileSync("git", ["init", "--bare", "-b", "master", bareRepo]);
    execFileSync("git", ["clone", bareRepo, workRepo]);
    execFileSync("git", ["-C", workRepo, "commit", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", workRepo, "push", "-u", "origin", "master"]);

    // 2. Register workRepo as a project; create a team goal in it; spawn 2 roles.
    const goal = await createGoal({ title: "branch-cleanup-test", team: true, cwd: workRepo });
    const goalId = goal.id;
    // Spawn coder + reviewer via /api/goals/:id/team/spawn so each gets a worktree
    // and a branch like `goal-goal-<slug>-<id>-coder-<short>`.
    await apiFetch(`/api/goals/${goalId}/team/spawn`, {
        method: "POST", body: JSON.stringify({ role: "coder", task: "no-op" }),
    });
    await apiFetch(`/api/goals/${goalId}/team/spawn`, {
        method: "POST", body: JSON.stringify({ role: "reviewer", task: "no-op" }),
    });

    // 3. Wait for spawn to finish and capture the expected branch list from the team store.
    const stateResp = await apiFetch(`/api/goals/${goalId}/team`);
    const state = await stateResp.json();
    const expectedBranches: string[] = state.agents.map((a: any) => a.branch).filter(Boolean);
    expect(expectedBranches.length).toBe(2);

    // Sanity: branches are pushed (createWorktree pushes -u origin <branch>).
    const lsBefore = execFileSync("git", ["ls-remote", "--heads", bareRepo]).toString();
    for (const b of expectedBranches) expect(lsBefore).toContain(b);

    // 4. Archive the goal (DELETE /api/goals/:id).
    const del = await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // 5. Poll ls-remote for up to 60s — branches must disappear.
    const deadline = Date.now() + 55_000;
    let lsAfter = "";
    while (Date.now() < deadline) {
        lsAfter = execFileSync("git", ["ls-remote", "--heads", bareRepo]).toString();
        if (expectedBranches.every(b => !lsAfter.includes(b))) break;
        await new Promise(r => setTimeout(r, 500));
    }
    for (const b of expectedBranches) {
        expect(lsAfter, `branch ${b} should have been deleted`).not.toContain(b);
    }
});
```

Key API names verified above:
- `createGoal({ team: true })` exists in `tests/e2e/e2e-setup.ts` (used by
  `team-abort.spec.ts:26`).
- `GET /api/goals/:id/team` returns `{ agents: [{ branch, ... }] }` per
  `team-manager.ts:1366-1370`.

The implementer must verify the exact spawn endpoint name (`/team/spawn`)
and request body shape; signatures live in `server.ts` near the other
`team/*` handlers.

### What we explicitly do NOT add

- No staff-path test changes (Bug 3 is verify-only).
- No tests asserting the local 7-day worktree cleanup window — already
  covered by existing purge tests.
- No backlog-cleanup script tests — out of scope.

---

## Constraints (recap)

- Every push-delete call (existing and new) must remain gated behind
  `shouldSkipRemotePush()`. Bug 2's new helper checks this before invoking
  `merge-base --is-ancestor` to avoid even *touching* git in test mode.
- Bug 1 callsite changes are surgical: ~10 lines in `server.ts` plus a
  small signature change to `deleteRemoteGoalBranches`.
- Bug 2 changes are likewise small: one new private method on
  `SessionManager` (or extracted helper, preferred for testability) plus
  one fire-and-forget call from `terminateSession`. Existing
  `purgeOneSession` cleanup is untouched.

## Risk register

| Risk | Mitigation |
|---|---|
| `merge-base --is-ancestor` requires `origin/<primary>` ref locally; if the worktree never fetched, we skip-delete (conservative). | Acceptable — purgeExpiredArchives mops up at 7 days. |
| Push-delete could race a concurrent push from another agent on the same branch. | Branches we delete are session-scoped (`session/*`) or per-role goal branches that have already been merged to master before archive. Race window is theoretical. |
| Bug 1 fix shifts to including the team-lead session branch in the delete set. If the lead's `branch` equals `goal.branch` (current behaviour), we dedupe via `Set`. If it differs (e.g. lead worktree was renamed), we now delete it — desired. | None — that's the intended behaviour. |
| Real-push E2E test flakes if Git Bash on Windows handles `git ls-remote` against a file-path bare repo poorly. | Use forward-slash paths in `mkdtempSync`/`join`; if issues arise, switch to `file://` URL form. |

## Files touched (summary)

| File | Change |
|---|---|
| `src/server/server.ts` | Bug 1: snapshot agent branches before teardown; change `deleteRemoteGoalBranches` signature to take `readonly string[]`. |
| `src/server/agent/session-manager.ts` | Bug 2: add fire-and-forget eager remote-delete hook in `terminateSession`. |
| `src/server/agent/session-eager-branch-delete.ts` (new, small) | Bug 2: extracted pure helper for unit testing. |
| `tests/orphan-branch-eager-delete.test.ts` (new) | Bug 2 unit tests. |
| `tests/e2e/goal-archive-branch-cleanup.spec.ts` (new) | Bug 1 E2E. |
| `tests/e2e/in-process-harness-realpush.ts` (new) | Test harness variant without `BOBBIT_TEST_NO_PUSH`. |
| `tests/e2e/playwright-e2e.config.ts` | Register the new spec/project for isolation. |

No changes to: `team-manager.ts`, `staff-manager.ts`, `skills/git.ts`,
`team-store.ts`, `session-store.ts`.
