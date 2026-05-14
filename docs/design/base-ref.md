# Configurable base ref per project

Status: in-progress · Tracked in goal `goal/configurab-99c9ffe2`.

## Problem

Today every new worktree (session, goal, staff, pool entry) is branched from
**`resolveRemotePrimary()`** — typically `origin/master`/`origin/main`. The same
hard-coded reference is also baked into:

- workflow gate verify commands (`{{master}}` for the ready-to-merge gate),
- the LLM-review prompts the project assistant seeds for new projects,
- the per-branch upstream that `git push -u` sets at worktree-creation time,
- the "primary" comparator the git-status widget uses for the
  `aheadOfPrimary` / `behindPrimary` counters in `git-status-native.ts`.

Some workflows want a different integration target — `develop`, a release branch,
or even a local `master` that is never pushed. This document defines a single
project-level setting, **`base_ref`**, that controls all of the above.

## Setting

Project-level config key (lives in `project.yaml` alongside `worktree_root`,
`worktree_pool_size`, etc.):

```yaml
base_ref: origin/develop
```

| Aspect | Value |
|---|---|
| Scope | project-wide (single value, applied to every component in multi-repo) |
| Type | string (optional) |
| Accepted | a **branch** ref — local (`master`, `develop`) or remote (`origin/develop`, `origin/release/2026.05`) |
| Whitespace | trimmed; empty after trim is treated as unset |
| Default | unset → preserve today's behaviour (`resolveRemotePrimary()`) |
| UI | Settings → General → Worktree section, immediately under `worktree_root` |

### Save-time validation

The PUT `/api/projects/:id/config` handler rejects malformed values *before*
persisting. Each failure mode returns HTTP 400 with a structured payload
`{ field: "base_ref", error: "<message>", details?: [...] }`:

| Trigger | Message |
|---|---|
| Tag (e.g. `v1.2.3`) | `base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: v1.2.3` |
| Commit SHA (`/^[0-9a-f]{7,40}$/`) | `base_ref must be a branch ref, not a commit SHA. Got: abc123def` |
| Invalid branch grammar | `base_ref must be a valid branch name. Got: feature foo` |
| `sandbox = docker` + local ref | `base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: master` |
| Non-`origin` remote prefix | `base_ref only supports the 'origin' remote today. Got: upstream/main. If you need a different primary remote, configure it as 'origin' in your local clone.` |

After grammar validation, the handler runs `git rev-parse --verify <base_ref>`
against every component repo. Failures are collected and returned as:

```json
{
  "field": "base_ref",
  "error": "base_ref 'origin/develop' is not present in 2 of 3 component repos",
  "details": [
    { "component": "frontend",   "message": "ref not found. Try: cd frontend && git fetch origin" },
    { "component": "shared-lib", "message": "ref not found. Try: cd shared-lib && git fetch origin" }
  ]
}
```

Non-fatal: component paths that aren't git repos are skipped with a warning in
the response payload (`{ ok: true, warnings: [...] }`). This matches today's
tolerance for partially-configured multi-repo projects.

**Validation only runs when `base_ref` is present in the PUT body.** Unrelated
config changes (e.g. editing `worktree_pool_size`) do not trigger git
invocations.

**Sandbox boundary:** host-side validation only at save. Container-side
validation happens at worktree-creation time, since the sandbox image may not
share refs with the host and the container may not be running at save time.

**Out of scope:** auto-fetching `origin` during validation. If a remote ref
isn't in the local clone, the user fixes it manually and re-saves. The error
message ("Try: cd <repo> && git fetch origin") includes the fix.

### Branch-name grammar

Valid branch grammar accepts ASCII letters, digits, `/`, `_`, `-`, `.`, no
leading `-`, no `..`, no whitespace, no control chars. Implementation
piggy-backs on the same predicate `git check-ref-format` would use; the
helper below applies it in pure JS so the API responds without an exec
round-trip:

```ts
function isValidBranchGrammar(name: string): boolean {
  if (!name) return false;
  if (/\s/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (/[\x00-\x1f\x7f~^:?*\[\\]/.test(name)) return false;
  return /^[A-Za-z0-9_./-]+$/.test(name);
}
```

The SHA-shape predicate `/^[0-9a-f]{7,40}$/i` runs **before** grammar — a
40-char hex string is grammatically valid as a branch name but is rejected as
a SHA for clarity.

Tag detection: a value that resolves via `git rev-parse --verify <value>` to a
tag object (verified with `git for-each-ref --format='%(objecttype)' refs/tags/<value>`).
We don't enumerate the tag namespace exhaustively — the simpler check is
`git show-ref --verify refs/tags/<value>` succeeds.

## The two helper APIs

All three of `parseBaseRef`, `resolveBaseRef`, `resolveBaseRefWithExec` live in
**`src/server/skills/git.ts`** — the same module that owns `createWorktree`.

```ts
/**
 * Pure parser — splits a configured value into its component pieces. Exported
 * so sandbox-internal callers can use the same logic without an exec
 * round-trip. Does NOT consult disk; trim() and origin/ stripping only.
 *
 * configured = ""           → { ref: "", branch: "", isRemote: false } (sentinel: unset)
 * configured = "master"     → { ref: "master", branch: "master", isRemote: false }
 * configured = "origin/dev" → { ref: "origin/dev", branch: "dev", isRemote: true }
 */
export function parseBaseRef(configured: string):
  { ref: string; branch: string; isRemote: boolean };

/**
 * Host-side resolver. Used by the bulk of the server.
 *   - configured non-empty → parseBaseRef(configured)
 *   - configured empty/undefined → resolveRemotePrimary(repoPath) → split on "origin/"
 */
export async function resolveBaseRef(
  repoPath: string,
  configured: string | undefined,
): Promise<{ ref: string; branch: string; isRemote: boolean }>;

/**
 * Sandbox variant. Used by project-sandbox.ts so the container path doesn't
 * pay an extra docker exec when configured is non-empty.
 *   - configured non-empty → parseBaseRef (no exec)
 *   - configured empty → exec(["symbolic-ref", "refs/remotes/origin/HEAD"])
 */
export async function resolveBaseRefWithExec(
  exec: (args: string[]) => Promise<string>,
  configured: string | undefined,
): Promise<{ ref: string; branch: string; isRemote: boolean }>;
```

The existing private `resolveRemotePrimary(repoPath)` and `detectPrimaryBranch(repoPath)`
helpers stay. They are now consumed exclusively by `resolveBaseRef()` (the empty-config
fallback) and by `{{master}}` substitution respectively. The duplicate copies in
`worktree-pool.ts` and `staff-manager.ts` are removed.

## Behavioural changes

### 1. Worktree start-point

Every call site that today resolves `undefined` → `resolveRemotePrimary()` is
updated to thread the configured `base_ref` through:

| File | Line | Caller |
|---|---|---|
| `src/server/skills/git.ts` | `createWorktree` :142 | resolves internally via `resolveBaseRef(repoPath, opts?.configuredBaseRef)` |
| `src/server/skills/git.ts` | `createWorktreeSet` :269 | same |
| `src/server/agent/goal-manager.ts` | :275, :308, :440 | reads from `projectConfigStore.get("base_ref")`, passes via opts |
| `src/server/agent/session-setup.ts` | :618, :631 | reads from project config in plan, passes via opts |
| `src/server/agent/worktree-pool.ts` | `_fill()` :489, `freshenInBackground()` | new `baseRefResolver: () => string \| undefined` field — see §7 |
| `src/server/agent/staff-manager.ts` | :144 | reads project config, passes via opts |
| `src/server/agent/project-sandbox.ts` | `createWorktree` :209, `createWorktreeSet` :301 | uses `resolveBaseRefWithExec` with the existing `_dockerExec` |

If the ref disappears between save and creation:

```
Failed to create worktree: base_ref 'origin/develop' no longer exists in repo '<name>'.
It may have been deleted on the remote since the project was configured.
Run 'git fetch origin' to refresh, then update the base_ref setting if the branch was renamed.
```

**Out of scope:** `src/server/agent/team-manager.ts:885` is **deliberately
unchanged**. Team members branch off `origin/<goal-branch>` by hierarchical
design — there is an explicit `git fetch origin <goal-branch>` immediately
preceding the `createWorktree` call. This is a different base concept (the
goal's branch, not the project's integration target).

### 2. Upstream tracking

After the worktree is created (and after the existing `git push -u origin
<branch>` runs for backup / origin visibility), `createWorktree` issues:

```bash
git -C <worktree> branch --set-upstream-to=<base-ref> <branch>
```

Effect:

- Local base → local upstream. `git status` ahead/behind compares against the
  local base. Push still happens (we keep `git push -u origin <branch>` for
  crash-recovery / inspection), but `--set-upstream-to` then overrides what
  `@{u}` resolves to.
- Remote base (`origin/X`) → remote upstream. `git push` defaults work
  normally.

Save-time validation guarantees the base is a branch ref, so `--set-upstream-to`
never fails on tag/SHA at runtime. Defence-in-depth error if it does fail
anyway (e.g. ref deleted mid-flight):

```
Failed to set upstream for branch '<branch>' to '<base_ref>': <git stderr>.
Check that the ref is still a valid branch.
```

### 3. Template substitution — one new variable, `{{master}}` unchanged

A single new built-in variable is added to the verification harness's
`builtinVars` map (alongside `branch`, `master`, `cwd`, `goal_spec`, `commit`):

- **`{{baseBranch}}`** → bare branch name derived from the project's `base_ref`.
  - `base_ref = "origin/develop"` → `{{baseBranch}}` = `"develop"`
  - `base_ref = "develop"` (local) → `{{baseBranch}}` = `"develop"`
  - `base_ref = ""` (unset) → `detectPrimaryBranch()` → typically `"master"`

Workflow authors write `origin/{{baseBranch}}` explicitly whenever a remote ref
is needed (mirrors the existing `origin/{{master}}` pattern — same shape, just
configurable).

**`{{master}}` is intentionally not touched.** It continues to resolve via
`detectPrimaryBranch(cwd)` regardless of `base_ref`. This keeps existing
custom workflows that reference `{{master}}` behaving exactly as today. The
authoring guide documents the distinction:

> - `{{master}}` — the project's primary branch (`master`/`main`).
>   Independent of `base_ref`.
> - `{{baseBranch}}` — bare branch name from `base_ref`. Falls back to the
>   project primary when `base_ref` is unset.

### 4. New-project workflow templates

`src/server/state-migration/seed-default-workflows.ts` and
`src/server/agent/project-assistant.ts:133` are updated to emit
`{{baseBranch}}` instead of `{{master}}`:

- Ready-to-Merge gate:
  - `git fetch origin {{baseBranch}} && git merge-base --is-ancestor origin/{{baseBranch}} {{branch}}`
  - `gh pr list --head {{branch}} --base {{baseBranch}}`
- Code-review / design / impl prompts: `origin/{{baseBranch}}` throughout.

`seed-default-workflows.ts` is consumed only by:

- `state-migration/per-component-workflows.ts` (per-component scaffolding when
  a multi-component project is first set up), and
- `agent/project-assistant.ts` (template the assistant uses when generating
  workflows for `propose_project`).

There is **no re-seeding of existing projects**. Existing `project.yaml` files
are frozen — users who change `base_ref` on an existing project AND want their
gates to track it must manually edit `project.yaml::workflows.*.gates.*.verify[].run`
to swap `{{master}}` for `{{baseBranch}}`. A release note documents this. Without
the manual edit, gates keep passing against the project primary (today's
behaviour).

**PR gate precise failure condition:** `gh pr list --head {{branch}} --base {{baseBranch}}`
passes iff `origin/{{baseBranch}}` exists on the remote AND a PR targeting it
exists. A user can configure local `develop` and still pass the gate when
`origin/develop` exists.

### 5. UI ahead/behind — narrower than it looks

`src/server/skills/git-status-native.ts` already exposes **two** count pairs
per worktree:

- `ahead`/`behind` vs `@{u}` (the branch's own upstream — already
  per-branch-correct after §2 sets `@{u}` to the configured base).
- `aheadOfPrimary`/`behindPrimary` vs `origin/<primary>` (a uniform
  comparator for all worktrees in the UI).

**The per-branch `@{u}` path needs zero changes** — it already shows "commits
relative to where the branch would merge to" because the upstream is what
`--set-upstream-to` has set.

**Single change:** the inline `primaryBranch` resolution at `git-status-native.ts:130-140`
(host path) and the equivalent in the container batch script (~line 246) is
redirected to honor `base_ref`:

- `base_ref` non-empty → `parseBaseRef(configured).branch` becomes
  `primaryBranch`.
- `base_ref` empty → existing `symbolic-ref refs/remotes/origin/HEAD` chain.

The `aheadOfPrimary`/`behindPrimary` counts then reflect the configured
integration target. The per-branch `@{u}` counts are unchanged — old branches
with their old upstream tracking keep their meaningful per-branch
comparisons.

To thread `configured` into `runBatchGitStatusNative`, `BatchGitStatusOpts`
gains a new field:

```ts
export interface BatchGitStatusOpts {
  untracked?: boolean;
  containerId?: string;
  configuredBaseRef?: string;  // NEW: empty/undefined → today's fallback chain
}
```

Callers (the git-status cache in `server.ts`) populate this from the resolved
project config when assembling the request.

### 6. Centralisation

Three new exports, two removals:

- `parseBaseRef` (pure)
- `resolveBaseRef(repoPath, configured)` (host)
- `resolveBaseRefWithExec(exec, configured)` (sandbox)

Removed:
- Private `resolveRemotePrimary` in `worktree-pool.ts` (replaced by
  `resolveBaseRef` via the new `baseRefResolver`).
- Inline `symbolic-ref` block in `staff-manager.ts:325` (replaced by
  `resolveBaseRef`).

`detectPrimaryBranch` stays — it remains the source for `{{master}}`
substitution.

### 7. Pool — reuse the existing live-resolver pattern

`worktree-pool.ts` already takes `componentsResolver: () => Component[]`,
called fresh on every `_fill()`. A sibling **`baseRefResolver: () => string |
undefined`** is added with the same pattern:

```ts
class WorktreePool {
  constructor(
    ...,
    private componentsResolver: () => Component[],
    private baseRefResolver: () => string | undefined,  // NEW
  ) { ... }

  private async _fill() {
    ...
    const configured = this.baseRefResolver();
    await createWorktree(this.repoPath, branchName, {
      configuredBaseRef: configured,
      worktreeRoot: this.worktreeRoot,
    });
    ...
  }

  private freshenInBackground(worktreePath: string, branch: string): void {
    (async () => {
      await execFile("git", ["fetch", "origin"], { cwd: worktreePath, timeout: 30_000 });
      const configured = this.baseRefResolver();
      const { ref } = await resolveBaseRef(this.repoPath, configured);
      await execFile("git", ["reset", "--hard", ref], { cwd: worktreePath, timeout: 10_000 });
    })().catch(() => { /* swallow */ });
  }
}
```

`session-manager.ts` wires both resolvers when constructing the pool:

```ts
new WorktreePool(
  repoPath,
  size,
  worktreeRoot,
  () => projectConfigStore.getComponents(),
  () => projectConfigStore.get("base_ref"),
);
```

- No config-change listener.
- No "recorded base" field on pool entries.
- No drain on setting change.
- Pool entries auto-adopt the current base whenever they're touched.

The unconditional `git fetch origin` in `freshenInBackground` stays — harmless
when base is local, useful for refreshing any other tracking branches the
session might want.

## Error message inventory

Every user-visible failure path has an explicit, actionable message:

| Trigger | Surface | Message |
|---|---|---|
| Save tag | 400 | `base_ref must be a branch ref, not a tag. Tags can't be used as git upstreams. Got: <value>` |
| Save SHA | 400 | `base_ref must be a branch ref, not a commit SHA. Got: <value>` |
| Save invalid grammar | 400 | `base_ref must be a valid branch name. Got: <value>` |
| Save sandbox + local | 400 | `base_ref must be a remote ref (origin/...) for sandboxed projects. The container has separate ref visibility from the host. Got: <value>` |
| Save non-origin prefix | 400 | `base_ref only supports the 'origin' remote today. Got: <value>. If you need a different primary remote, configure it as 'origin' in your local clone.` |
| Save ref missing in N components | 400 | `base_ref '<value>' is not present in N of M component repos` + per-component `details[]` |
| Component path isn't a git repo | warning in success response | `base_ref validation skipped for component '<name>': not a git repo at <path>` |
| Worktree creation: ref deleted | runtime error | `Failed to create worktree: base_ref '<value>' no longer exists in repo '<name>'. ...` |
| `set-upstream-to` fails | runtime error | `Failed to set upstream for branch '<branch>' to '<value>': <git stderr>. Check that the ref is still a valid branch.` |

Save-time errors render inline in the Settings UI; runtime errors appear in
the session log with the same prefix.

## What's out of scope

- Per-component overrides (deferred; documented in field help text).
- Per-role / per-staff base refs.
- Automatically pushing local base branches to origin.
- `team-manager.ts` worktree creation (hierarchical branching — see §1).
- Live re-sizing the pool when `worktree_pool_size` changes (pre-existing limitation).
- Periodic re-validation of `base_ref` after save (no polling for "deleted on origin").
- Supporting non-`origin` remotes.
- Auto-fetching `origin` during save-time validation.
- Re-seeding existing projects' workflows. No such mechanism exists and
  we're not building one; users edit `project.yaml` manually if they want
  their existing gates to track `base_ref`.

## Acceptance criteria

(See goal spec — this design doc and the goal spec are intentionally
identical on the acceptance list. Implementation tasks will tick each row.)

- `base_ref` editable in Settings; persisted via `project-config-store`;
  round-trips through GET/PUT.
- Every save-time validation row in the inventory table emits its exact
  message verbatim.
- Multi-repo save with ref missing in one component returns 400 with
  structured `details[]`.
- Empty value → behaviour identical to today.
- `base_ref = "master"` (local) → new worktree HEAD = local master's SHA;
  `git rev-parse --abbrev-ref <branch>@{upstream}` returns `master`.
- `base_ref = "origin/develop"` → new worktree HEAD = `origin/develop`'s SHA;
  upstream = `origin/develop`.
- `{{baseBranch}}` substitutes correctly for both local and remote configured
  values, falls back when unset.
- `{{master}}` continues to resolve via `detectPrimaryBranch` independent of
  `base_ref`.
- `seed-default-workflows.ts` and `project-assistant.ts` contain no
  `{{master}}` references after the change.
- UI per-branch ahead/behind unchanged. `aheadOfPrimary`/`behindPrimary`
  reflects the configured `base_ref`.
- Pool freshen-on-claim resets to the current configured base.
- Goal, session, staff, pool, project-sandbox call sites all honour the
  setting.

## E2E test plan

This goal is user-facing (a new Settings field, a new workflow variable, a new
ahead/behind comparator). Every behaviour above needs a browser E2E.

`tests/e2e/ui/base-ref-settings.spec.ts`:

1. **Persistence happy path.** Navigate to project Settings → General. Enter
   `origin/develop`. Save. Reload. Assert the field still shows
   `origin/develop`.
2. **Inline tag error.** Enter `v1.2.3`. Save. Assert the inline error renders
   verbatim (`base_ref must be a branch ref, not a tag. ...`).
3. **Sandbox-specific error.** Set `sandbox` to `docker`. Enter `master`.
   Save. Assert the sandbox-only error renders.
4. **Multi-repo missing-ref.** With a 3-component project where 2 components
   lack `origin/develop`, save. Assert the top-level error AND the per-component
   bullets render.

`tests/e2e/ui/base-ref-ahead-behind.spec.ts`:

5. **Per-branch `@{u}` unchanged.** Create a branch with an explicit
   upstream. Change `base_ref` on the project. Assert the per-branch
   ahead/behind reads against the branch's `@{u}`, not the base.

API E2E in `tests/e2e/base-ref-api.spec.ts`:

6. **PUT round-trip.** PUT `base_ref = "origin/develop"`. GET. Assert echoed.
7. **Worktree start-point.** PUT base. Create a goal. Assert worktree HEAD =
   `origin/develop`'s SHA and `@{u}` = `origin/develop`.
8. **Ready-to-Merge gate substitution.** Trigger ready-to-merge gate
   evaluation with `base_ref = "origin/develop"` and assert the substituted
   command uses `origin/develop` (not `origin/master`).
9. **Pool entry adopts new base.** Seed the pool at base A. Change base to B.
   Claim an entry. Assert HEAD = B.

Unit (`tests/base-ref-parse.spec.ts`):

10. `parseBaseRef` covers local / remote / nested-slash / empty / whitespace /
    non-origin remote rejection.
11. `resolveBaseRef` falls back to `resolveRemotePrimary` when configured is
    empty.
12. Save-time validation hits every error-inventory row.
13. Template substitution: `{{baseBranch}}` resolves for local and remote
    bases; `{{master}}` stays independent.

## Migration note (for the release notes)

> **`base_ref` setting added.** New projects' workflows reference
> `{{baseBranch}}` instead of `{{master}}` for their Ready-to-Merge gate and
> review prompts. Existing projects are unchanged — if you set `base_ref` on
> an existing project AND want gates to track it, edit
> `.bobbit/config/project.yaml::workflows.*.gates.*.verify[].run` and replace
> `{{master}}` with `{{baseBranch}}`. Without the edit, gates keep passing
> against the project primary.

## Cross-references

- `docs/dev-workflow.md` — branch namespaces and worktree story.
- `docs/internals.md` — config cascade, sandbox, git-status pipeline.
- `docs/goals-workflows-tasks.md` — workflow gate definitions.
- `docs/rest-api.md` — project-config PUT validation rules.
- `AGENTS.md` — reference list addition.
