# Multi-repo & Components — Design Doc

**Goal:** [Multi-repo & components](../../). Generalize Bobbit's project model so a project may hold one or more components (apps, libs, services, docs, infra), each pointing at a repo (or repo subdir). Replace runtime workflow YAMLs with bespoke project-authored workflows inlined into `project.yaml`, resolved structurally against components. Fix the worktree pool so goals use it and sessions get pool warmth without persistent placeholder branches. Add a configurable worktree parent.

**Audience:** implementors. This doc is the build plan; the goal spec is the contract.

---

## 0. High-level architecture summary

```
project.yaml
├─ name / rootPath / sandbox* / qa_* / config_directories     (project-level)
├─ worktree_root?                                              (NEW)
├─ components: [Component, …]                                  (NEW — only collection)
└─ workflows: { id: WorkflowDef }                              (NEW — inline, replaces files)

Component
├─ name                                                        # human label, branch-component dir name
├─ repo: "."  | "<sub-of-rootPath>"                            # "." for single-repo
├─ relative_path?                                              # optional sub-path within repo
├─ worktree_setup_command?                                     # per-component setup hook
└─ commands?: { [name: string]: shellString }                  # flat map; absent → data-only

WorkflowStep (type: command)
│   one of three shapes; no `cwd:` field:
├─ { component, command }                # structural, named command
├─ { component, run }                    # free-form shell at component path
└─ { run }                               # free-form shell at branch container root
```

Worktree layout (after this lands):

```
single-repo:   <rootPath>/                 ← git repo
               <worktree_root | rootPath-wt>/<branchSlug>/

multi-repo:    <rootPath>/                 ← container dir (NOT a repo)
               <rootPath>/<repoA>/         ← repos one level deep
               <rootPath>/<repoB>/
               <worktree_root | rootPath-wt>/<branchSlug>/<repoA>/
                                                       /<repoB>/
```

The agent's cwd in multi-repo is `<branchSlug>/` (the per-branch container), mirroring `rootPath`'s structure exactly.

A single resolver — `worktree-support.ts::resolveWorktreeSupport` — decides worktree capability for the session, staff, and goal paths alike, and `createWorktreeSet` only worktrees component dirs that are real git repo roots (skipping the non-git poly-repo container). See §4.4 / §4.5.

---

## 1. Project model — components as first-class

### 1.1 Schema

`src/server/agent/project-config-store.ts`:

```typescript
export interface Component {
  name: string;                     // unique within project; used in branch dir & UI
  repo: string;                     // "." for single-repo, else subfolder of rootPath
  relativePath?: string;            // optional sub-path inside the repo (e.g. "packages/api")
  worktreeSetupCommand?: string;    // per-component hook; runs at component root
  commands?: Record<string, string>; // flat name → shell. Absent ⇒ data-only.
}

export interface ProjectYaml {
  // existing project-level fields
  name: string;
  // rootPath is intentionally omitted from the yaml on disk (it's the registry value);
  // see registry.

  // sandbox / pool / qa / config_directories — UNCHANGED, project-level
  sandbox?: "none" | "docker";
  sandbox_image?: string;
  sandbox_tokens?: SandboxToken[];
  sandbox_mounts?: string[];
  worktree_pool_size?: number;
  qa_build_command?: string;
  qa_start_command?: string;
  qa_health_check?: string;
  qa_browser_entry?: string;
  qa_env?: Record<string, string>;
  qa_max_duration_minutes?: number;
  qa_max_scenarios?: number;
  config_directories?: ConfigDirectory[];

  // NEW
  worktree_root?: string;           // absolute or relative to rootPath
  components: Component[];          // exactly one collection
  workflows?: Record<string, WorkflowDef>; // bespoke; see Part 3
}
```

**Removed top-level keys** (after migration): `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `default_thinking_level` (only the command keys move; the thinking level stays).

### 1.2 Helpers

In `project-config-store.ts` (new helpers; existing class extends):

```typescript
class ProjectConfigStore {
  // …existing…
  getComponents(): Component[];
  getComponent(name: string): Component | undefined;
  componentsByRepo(): Map<string /*repoName*/, Component[]>;
  repoNames(): string[];                              // distinct repo values
  isMultiRepo(): boolean;                             // any repo !== "."
  isDataOnly(c: Component): boolean;                  // !c.commands || size 0
  componentRoot(c: Component, branchContainer: string): string;
  // = path.join(branchContainer, c.repo === "." ? "" : c.repo, c.relativePath ?? "")
}
```

`componentRoot()` is the single source of truth for "where does this component's commands run?". Call it everywhere a step or setup hook needs a cwd.

### 1.3 Migration (one-shot, on first server start after this lands)

Module: new `src/server/state-migration/migrate-project-yaml.ts`, invoked once at server startup before any project loads.

For every registered project (`projects.json`) and the bobbit-internal config:

1. Read `project.yaml`.
2. If `components:` already present → skip (idempotent).
3. Build a single component:
   - `name`: project's `name` from registry.
   - `repo`: `"."`.
   - `worktreeSetupCommand`: existing top-level `worktree_setup_command` (if non-empty).
   - `commands`: map of detected legacy keys:
     - `build_command → build`
     - `test_command → test`
     - `typecheck_command → check`
     - `test_unit_command → unit`
     - `test_e2e_command → e2e`
     - any extra `*_command` keys passed through as-is (drop the `_command` suffix).
   - Drop empty/whitespace-only values.
4. Move any files under `.bobbit/config/workflows/` into `project.yaml::workflows[id]` (keyed by file id), then `rm -rf .bobbit/config/workflows/`.
5. If neither legacy commands nor inline workflows existed and no scan-derived defaults are available, emit a warning and write `components: [{ name, repo: "." }]` (data-only) — the user will need to re-run setup or edit Settings.
6. Atomic write (`tmp` + rename), log `[migrate] project.yaml v2: <projectName>`.

**Invariant: default component name = project name.** This applies to the migration *and* to the project assistant when generating a config for a new single-folder project (Part 8 / acceptance criterion 2).

### 1.4 Validation

`Component`:
- `name` ∈ `/^[a-z0-9][a-z0-9-]*$/` (used as branch-dir name; reuse `ID_PATTERN` from workflow-manager); unique within project.
- `repo === "."` OR `repo` is a relative path with no `..`/absolute parts; also no slashes (must be a single folder name one level under `rootPath`).
- `relativePath` (if present): no `..`, no leading slash.
- `commands[name]` keys: same identifier pattern as `name`.

Errors raised as `Error("Project config invalid: …")` and surfaced in:
- `POST /api/projects` → 400 with the message.
- `PUT /api/projects/:id/config` → 400.
- Project assistant proposal acceptance → returns error to agent.

---

## 2. Multi-repo project layout

### 2.1 Mode inference

`isMultiRepo()` is `true` ⇔ any component has `repo !== "."`. There is no explicit mode flag; the schema speaks for itself.

### 2.2 Repo discovery (project assistant)

In `project-assistant.ts` (and a new helper module `src/server/agent/repo-scan.ts` so the same scan is reusable from `PUT /api/projects/:id/config?action=rescan`):

```typescript
export interface DetectedRepo {
  folder: string;     // relative to rootPath, "." for the root itself
  hasGit: boolean;    // .git dir or .git file
  detectedCommands: Record<string, string>; // from package.json, pyproject.toml, Cargo.toml
}

export async function scanRepos(rootPath: string, opts?: { maxDepth?: 1 }): Promise<DetectedRepo[]>;
```

Algorithm:
- One level deep under `rootPath`, plus `rootPath` itself.
- Skip `node_modules`, `.bobbit`, dotfiles, `.git`.
- A folder is a repo if it has `.git` (dir or file).
- For each repo, parse `package.json::scripts`, `pyproject.toml::[tool.poetry.scripts]`/`[tool.pdm.scripts]`, `Cargo.toml::[bin]` to suggest a `commands` map.
- No symlink following; warn when `realpath(folder) !== folder`.

**Single-repo case:** `rootPath` itself has `.git` → return `[{ folder: ".", … }]`. No subfolder scan.

**Multi-repo case:** `rootPath` has no `.git`; one or more children do → return all children that have `.git`.

### 2.3 Primary branch consistency

After scan, for multi-repo:

```typescript
const primaries = await Promise.all(repos.map(r => detectPrimaryBranch(path.join(rootPath, r.folder))));
const distinct = new Set(primaries);
if (distinct.size > 1) {
  warning = `Repos disagree on primary branch: ${[...distinct].join(", ")}`;
}
```

Surface the warning in the project assistant chat and in Settings → project tab. The user must resolve before the project can be saved (or override with a confirmation).

### 2.4 Constraints (enforced at validation)

- Repos must be exactly one level deep beneath `rootPath`.
- Component names must be unique.
- Repos covered by components must all exist; missing → 400.

---

## 3. Bespoke project-authored workflows (inline + structural)

### 3.1 Files removed; one MD authoring guide added

**Delete from the repo:**
- `defaults/workflows/bug-fix.yaml`
- `defaults/workflows/feature.yaml`
- `defaults/workflows/general.yaml`
- `defaults/workflows/quick-fix.yaml`
- `defaults/workflows/test-fast.yaml` (kept only if needed by tests; if so, move it under `tests/fixtures/test-fast.yaml` and load explicitly, not via the runtime workflow path)

**Add `defaults/workflow-authoring-guide.md`** — written in this PR; the source of truth for the project / workflow / goal assistants. Sections:

1. **Project model:** rootPath, components, the multi-repo invariant, data-only components.
2. **Component model:** `name`, `repo`, `relative_path`, `commands` map (no fixed schema), `worktree_setup_command`.
3. **Workflow gate semantics:** id, name, depends_on, content, inject_downstream, optional, manual (see §3.6), metadata schema, signal contracts.
4. **Verification step shapes:**
   - `type: command` — structural `{ component, command }`, structural `{ component, run }`, or pure `{ run }`.
   - `type: llm-review` — `role`, `prompt`, `phase`, `expect`, `optional`, `optionalLabel`, `description`, `timeout`.
   - `type: agent-qa` — same plus implicit dependency on project-level `qa_*` fields.
   - `type: human-signoff` — `label` (sign-off card title), `prompt`, `phase`, `role`, `optional`, `optionalLabel`, `description`; no timeout.
5. **Runtime context tokens:** `{{branch}}`, `{{master}}`, `{{goal_spec}}`, `{{agent.<key>}}`, `{{<gate_id>.meta.<key>}}`. **No `{{project.<key>}}`** (replaced by structural references).
6. **Pattern library** — typical gates per workflow style: general / feature / bug-fix / quick-fix / pr-review. The bobbit appendix in the goal spec is reproduced as a worked single-repo example; multi-repo and monorepo worked examples follow the same shape.
7. **Anti-patterns:** literal shell strings instead of structural refs; copy-paste of step bodies; over-broad `expect: failure`.

This MD file is **not** read at runtime; only assistant prompts include it.

### 3.2 Inline `workflows:` block

Stored in `project.yaml`. Discriminated union for steps:

```typescript
// src/server/agent/workflow-store.ts (rewrite)
export type CommandStep =
  | { name: string; type: "command"; component: string; command: string;
      phase?: number; expect?: "success" | "failure"; timeout?: number;
      optional?: boolean; optionalLabel?: string; description?: string }
  | { name: string; type: "command"; component: string; run: string;
      phase?: number; expect?: "success" | "failure"; timeout?: number;
      optional?: boolean; optionalLabel?: string; description?: string }
  | { name: string; type: "command"; run: string;
      phase?: number; expect?: "success" | "failure"; timeout?: number;
      optional?: boolean; optionalLabel?: string; description?: string };

export type LlmReviewStep = {
  name: string; type: "llm-review"; prompt: string;
  role?: string; phase?: number; expect?: "success" | "failure";
  timeout?: number; optional?: boolean; optionalLabel?: string; description?: string;
};

export type AgentQaStep = {
  name: string; type: "agent-qa"; prompt: string;
  role?: string; phase?: number; timeout?: number;
  optional?: boolean; optionalLabel?: string; description?: string;
};

export type HumanSignoffStep = {
  name: string; type: "human-signoff"; label: string; prompt: string;
  role?: string; phase?: number;
  optional?: boolean; optionalLabel?: string; description?: string;
};

export type VerifyStep = CommandStep | LlmReviewStep | AgentQaStep | HumanSignoffStep;

export interface WorkflowGate {
  id: string;
  name: string;
  dependsOn: string[];
  content?: boolean;
  injectDownstream?: boolean;
  optional?: boolean;
  manual?: boolean;                 // see §3.6
  metadata?: Record<string, "string">; // schema-only; values are runtime
  verify?: VerifyStep[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  hidden?: boolean;
  gates: WorkflowGate[];
}
```

The store no longer reads `<configDir>/workflows/`. Replace `WorkflowStore` with `InlineWorkflowStore` whose data source is `ProjectConfigStore::getYaml().workflows`.

```typescript
export class InlineWorkflowStore {
  constructor(private cfg: ProjectConfigStore) {}
  getAll(): WorkflowDef[];      // resolves all workflows; filters hidden
  get(id: string): WorkflowDef | undefined;
  getResolved(id: string, components: Component[]): ResolvedWorkflowDef; // see §3.4
}
```

`WorkflowManager` uses `InlineWorkflowStore`. `createWorkflow / updateWorkflow / deleteWorkflow` now mutate `project.yaml` via `ProjectConfigStore.setWorkflows(map)`.

### 3.3 Structural step resolution

A step's working dir + command pair is computed by:

```typescript
function resolveStep(step: VerifyStep, components: Component[], branchContainer: string):
  { cwd: string; runString?: string }
{
  if (step.type !== "command") return { cwd: branchContainer };
  if ("component" in step) {
    const c = components.find(x => x.name === step.component);
    if (!c) throw new WorkflowResolveError(`step "${step.name}": component "${step.component}" not found`);
    const cwd = componentRoot(c, branchContainer);
    if ("command" in step) {
      const run = c.commands?.[step.command];
      if (!run) throw new WorkflowResolveError(
        `step "${step.name}": component "${c.name}" has no command "${step.command}". ` +
        `Available: ${Object.keys(c.commands ?? {}).join(", ") || "(none)"}`);
      return { cwd, runString: run };
    }
    return { cwd, runString: step.run };
  }
  return { cwd: branchContainer, runString: step.run };
}
```

Resolution happens twice:
1. **Load-time validation** (when a project YAML is parsed or a goal snapshots a workflow) — fail fast, surface clear error to user.
2. **Verification-time** (in `verification-harness.ts` per step) — resolve for the actual branch container.

### 3.4 Validator

New module `src/server/agent/workflow-validator.ts`:

```typescript
export interface WorkflowResolveError extends Error { gate: string; step: string; reason: string; }

export function validateWorkflow(wf: WorkflowDef, components: Component[]): WorkflowResolveError[];
export function validateAllWorkflows(workflows: Record<string, WorkflowDef>, components: Component[]): WorkflowResolveError[];
```

Rules:
- Existing gate-DAG checks (uniqueness, dependsOn exists, no cycles, no self-ref) — port from `workflow-manager.ts::validateGates`.
- Step type-discriminator checks:
  - `command` step with `component` and `command` and `run` → reject ("both `command` and `run` set").
  - `command` step with `command` and no `component` → reject.
  - `command` step with neither `command` nor `run` → reject.
  - `command`/`component` pair where component or command name is unknown → reject (with "did you mean" suggestion via Levenshtein on the available set).
- Free-form `run:` strings and `prompt:` strings → **not** validated for tokens. Runtime context tokens (`{{branch}}`, `{{master}}`, `{{goal_spec}}`, `{{agent.x}}`, `{{<gate>.meta.x}}`) pass through to `verification-logic.ts::substituteVars`. Anything else fails at shell-time as a typo. (Acceptance criterion 6.)
- `optional` step requires `optionalLabel` (legacy non-human `label` is migrated on load and saved canonically).
- `agent-qa` step requires the project to have `qa_start_command` configured (warn, don't reject — runtime already returns "QA not configured").

Error format (acceptance criterion 8):

```
Workflow "general", gate "implementation", step 3:
  component "apii" not found in components[]. Did you mean "api"?
```

**Empty/missing workflow block** at goal creation → `POST /api/goals` returns 400:

```
This project has no workflows configured. Run project setup or generate workflows from Settings → project tab.
```

No silent fallback to a built-in workflow.

### 3.5 Feature-parity audit (acceptance criterion 7)

Audit performed by reading every `defaults/workflows/*.yaml`, `workflow-store.ts`, `verification-harness.ts`, and `verification-logic.ts`. Below: every feature today's workflow YAML supports, with the new representation and a coverage test.

| # | Today's feature | Used in | New representation | Test |
|---|-----------------|---------|--------------------|------|
| 1 | Workflow `id`, `name`, `description` | all | Same on `WorkflowDef` | `inline-workflow-load.spec.ts` |
| 2 | `hidden: true` | test-fast | Same on `WorkflowDef` | `workflow-hidden.spec.ts` |
| 3 | Gate `id`, `name`, `depends_on` | all | Same on `WorkflowGate` | `workflow-validator.spec.ts` |
| 4 | Gate `content: true` (accepts markdown) | design-doc, issue-analysis | Same | `gate-content-flow.spec.ts` (existing) |
| 5 | Gate `inject_downstream: true` | design-doc, issue-analysis | Same | existing `gate-inject-downstream.spec.ts` |
| 6 | Gate `optional: true` (signaled with N/A) | none in builtins, but supported | Same | `gate-optional.spec.ts` |
| 7 | Gate `metadata: { key: "type" }` (signal schema) | bug-fix `reproducing-test` | Same; values resolved via `{{agent.x}}`/`{{gate.meta.x}}` | `gate-metadata.spec.ts` (existing) |
| 8 | Step `type: command` with literal `run:` | ready-to-merge gates | `{ run }` (free-form) | `workflow-step-shapes.spec.ts` |
| 9 | Step `type: command` with `{{project.X}}` | implementation gates | **Replaced by** `{ component, command }` | `step-component-resolution.spec.ts` |
| 10 | Step `type: llm-review` with `prompt` | many | Same shape; structural refs not relevant | `llm-review-step.spec.ts` |
| 11 | Step `type: agent-qa` with `prompt` | feature, bug-fix | Same shape | `agent-qa-step.spec.ts` |
| 11a | Step `type: human-signoff` with `label` + `prompt` | human approval gates | First-class workflow step; parks verification until the chat-header goal-status widget receives approve/reject. `label` is the sign-off card title. | `human-signoff.spec.ts`, `goal-status-widget.spec.ts` |
| 12 | Step `role:` (architect, code-reviewer, security-reviewer, spec-auditor, qa-tester) | many | Unchanged | covered by 10/11/11a |
| 13 | Step `expect: failure` | bug-fix `reproducing-test` (and TDD) | Unchanged on all `command` shapes | `step-expect-failure.spec.ts` |
| 14 | Step `timeout:` (seconds) | build/E2E steps | Unchanged | `step-timeout.spec.ts` |
| 15 | Step `phase:` (parallel grouping) | many | Unchanged | `phased-verification.spec.ts` (existing) |
| 16 | Step `optional: true` + `optionalLabel` + `description` | feature/bug-fix QA testing | `optionalLabel` is canonical for goal-creation toggles; legacy non-human `label` is migrated on load/save. `label` is reserved for human-signoff card titles. | `optional-step-toggle.spec.ts` (existing) |
| 17 | `{{branch}}` / `{{master}}` runtime tokens | many | Unchanged in `run:` and `prompt:` | `template-vars.spec.ts` (existing) |
| 18 | `{{goal_spec}}` injection | many | Unchanged | existing |
| 19 | `{{agent.X}}` from signal metadata | bug-fix `{{agent.test_command}}` | Unchanged | existing |
| 20 | `{{gate_id.meta.key}}` from upstream gates | bug-fix `{{reproducing-test.meta.test_command}}` | Unchanged | existing |
| 21 | `{{project.X}}` token | implementation steps | **Removed.** Validator rejects in command shapes (`{ component, command }` is the replacement). Free-form `run:` keeps it functional but the migration rewrites all known usages. | `template-vars-no-project.spec.ts` |
| 22 | `isCommandStepSkippable` (auto-skip on unresolved tokens / empty) | optional infra steps | **Replaced** by: data-only components produce zero steps, missing commands are validator errors. Kept only for free-form `run:` with unresolved `{{agent.X}}` to preserve existing optional-metadata semantics. | `step-skippable.spec.ts` |
| 23 | `error_pattern` agent metadata + `expect: failure` regex match | bug-fix `reproducing-test` | Unchanged | `expect-failure-pattern.spec.ts` (existing) |
| 24 | Re-run / resume of llm-review and agent-qa transient failures | harness | Unchanged | existing harness tests |
| 25 | Step result caching by commit SHA | harness | Unchanged | existing |
| 26 | Skipped steps count as passed | harness | Unchanged | existing |
| 27 | Phase failure cascades skip downstream phases | harness | Unchanged | existing |
| 28 | Pre-implementation gates skip diff-baseline injection | harness | Unchanged | existing |
| 29 | `metadata: { test_command: string }` schema declaration on gate | bug-fix `reproducing-test` | Unchanged | existing |

**Net new feature** introduced by this design (called out for explicit decision):

- §3.6 **Manual gates** (`manual: true`): a workflow can declare a gate that has no automated verify (or whose verify is informational) and must be explicitly signed off by the user via a UI button. Today's workflows don't use this, but the goal spec lists "manual" as a supported feature; we add the YAML field and the dependency-gating support so it's available. UI affordance is a "Mark passed" button on the gate card. If the workflow YAML doesn't set `manual: true`, behavior is identical to today.

**Confirmed: no feature is lost.** Step 21 (`{{project.X}}`) is the only deliberate breaking change, and the migration rewrites the affected steps.

### 3.6 Manual gates

`WorkflowGate.manual?: boolean`. If true:
- Gate is treated as "user-only signal source"; agents may signal but a user must accept.
- New REST: `POST /api/goals/:id/gates/:gateId/manual-pass` (auth: same as existing signal). Records a synthetic signal with `metadata.manualBy = userId`.
- Verification harness skips the verify-step run for manual gates whose latest signal is `manualBy`.
- UI: gate card shows a "Mark passed" button when `manual: true` and dependencies are met.

### 3.7 Re-generation flow

When the user adds/removes/renames a component in Settings → project tab, the project assistant offers to regenerate workflows. The proposal panel renders a sub-section diff scoped to `workflows:` (see §8.6). Hand edits are merged: any hand-added gate not in the regenerated set is preserved with a comment marker.

---

## 4. Worktree layout & `worktree_root`

### 4.1 Branch-to-path mapping

New helper `src/server/skills/worktree-paths.ts`:

```typescript
export function worktreeRoot(project: { rootPath: string; worktreeRoot?: string }): string {
  if (!project.worktreeRoot) return path.resolve(project.rootPath, "..", `${path.basename(project.rootPath)}-wt`);
  return path.isAbsolute(project.worktreeRoot)
    ? project.worktreeRoot
    : path.resolve(project.rootPath, project.worktreeRoot);
}

export function branchContainer(project, branchSlug: string): string {
  return path.join(worktreeRoot(project), branchSlug);
}

export function repoWorktreePath(project, components, branchSlug, repo: string): string {
  return repo === "."
    ? branchContainer(project, branchSlug) // single-repo: container == repo worktree
    : path.join(branchContainer(project, branchSlug), repo);
}
```

`branchSlug` = `branch.replace(/\//g, "-")` (existing convention preserved).

### 4.2 Single vs multi-repo collapse

In single-repo (one component with `repo === "."`), `branchContainer` and `repoWorktreePath` collide — there is exactly one worktree directory at `<wt-root>/<branchSlug>/` and that's also the agent's cwd. Identical to today's behavior.

In multi-repo, the container directory is created (`mkdir -p`) but is not itself a git repo. Each repo gets its own `git worktree add` underneath.

### 4.3 Existing call sites to refactor

All paths in `src/server/agent/{goal-manager,session-manager,session-setup,worktree-pool}.ts` and `src/server/skills/git.ts` that currently compute `<repoPath>-wt/<branchSlug>` must call `branchContainer()` / `repoWorktreePath()` instead. Search guard: grep for `-wt`, `path.basename(repoPath)`, `path.resolve(repoPath, "..")` — replace with helpers.

### 4.4 Worktree-capability resolution — single source of truth

**Problem.** "Does this project support a worktree, and what is the container `repoPath`?" was answered in three places with three different rules — the session REST path (`server.ts` `POST /api/sessions`), the staff path (`staff-manager.ts`), and the goal path (`goal-manager.ts::createGoal`). The staff rule was the buggy outlier: it iterated `repoNames()` and required **every** declared repo — including a non-git `.` container in a poly-repo — to pass `isGitRepo`. In a poly-repo (a project whose root is *not* a git repo but contains git sub-repos as components), that either bailed to `supported:false` or, worse, drove `git worktree add` against the non-git container root and failed with `fatal: not a git repository`. Staff creation diverged from session creation for the same project — the opposite of the stated staff↔session parity premise.

**Fix.** `src/server/agent/worktree-support.ts::resolveWorktreeSupport(components, projectRoot, cwd)` is now the single source of truth. It returns `{ supported, repoPath?, multiRepo }` and is called identically by all three paths (session, staff, goal). Centralising the decision is the whole point: a poly-repo now resolves the same way no matter who asks, so staff behaves exactly like a regular session.

The decision rule:

- **Multi-repo** (any component `repo !== "."`): worktrees anchor at `projectRoot` **only**. `supported` is true iff `projectRoot` is known **and** at least one distinct component repo resolves to a git repo **root** beneath it (probed with `isGitRepoRoot`, see §4.5). On success: `repoPath = projectRoot`, `multiRepo: true`. Multi-repo **never** falls through to a `cwd`/ancestor probe — doing so would let a non-git container nested inside an *unrelated* parent git repo resolve to that parent and reintroduce the bug.
- **Single-repo** (no component `repo !== "."`): if `cwd` is inside a git repo, `repoPath = getRepoRoot(cwd)`, `multiRepo: false`, `supported: true`; otherwise unsupported.
- **Otherwise unsupported** → callers proceed with **no worktree** (run in the original `cwd`), never throw.

Call sites: `server.ts` (session) sets `worktreeOpts.repoPath` from `support.repoPath` when supported; `staff-manager.ts::projectSupportsWorktree` delegates wholesale and forwards `components`; `goal-manager.ts::createGoal` sets `repoPath` from it.

### 4.5 `createWorktreeSet` skips non-git component dirs; graceful no-worktree fallback

**`isGitRepoRoot` vs `isGitRepo` (`src/server/skills/git.ts`).** `isGitRepo(dir)` runs `git rev-parse --is-inside-work-tree`, which returns true for **any** path *inside* a repo — including a non-git poly-repo container that merely happens to sit under an unrelated parent git repo (the "nested-parent false positive"). `isGitRepoRoot(dir)` instead compares the canonicalized `git rev-parse --show-toplevel` against the canonicalized input dir, so it is true **only when `dir` is itself a repo root** (canonicalization is win32 case-insensitive). The distinction matters because acting on the false positive would run `git worktree add` against a directory that is not a worktree-able repo.

**Skip rule.** In multi-repo mode, `createWorktreeSet(rootPath, components, branch, …)` now keeps a distinct repo only if its source dir (`<rootPath>/<repo>`) passes `isGitRepoRoot`. One rule covers four cases that must all be skipped:

- the non-git `.` container in a poly-repo (the original `fatal: not a git repository` crash),
- the nested-parent false positive (non-git container under an unrelated parent git repo),
- non-git, data-only components, and
- components whose source dir is missing.

A `.` entry whose source *is* a git repo root (a genuine single-repo / container-root component) is still kept, so single-repo and normal all-git multi-repo behaviour is unchanged.

**Graceful no-worktree fallback.** If no worktree-able git repo remains after the skip pass, `createWorktreeSet` short-circuits and returns an empty `worktrees: []` **without creating the container directory** — it never runs `git worktree add` against the non-git root. Each caller treats an empty set (or `supported:false` from §4.4) as "no worktree": run in the original `cwd`, leave `worktreePath` / `repoWorktrees` unset.

- `staff-manager.ts::provisionStaffWorktree` → returns `{ sessionCwd: cwd }`.
- `session-setup.ts::executeWorktreeAsync` → sets `noWorktreeFallback`, skips per-component setup and sandbox-branch wiring, leaves `plan.cwd` unchanged.
- `goal-manager.ts::_doSetupWorktree` → calls `_restoreNoWorktree`, which clears the precomputed `worktreePath`/`repoWorktrees` and resets the goal `cwd` to its original (un-offset) project path.

**Net effect.** Staff creation in a poly-repo now produces one worktree per git sub-repo under the branch container — byte-for-byte the same shape a regular session produces for the same project. Projects with no worktree-able git repo fall back to no-worktree instead of throwing.

---

## 5. Worktree pool fixes

> **Superseded.** The deferred-rename design described in this section (§5.1–5.5) has been replaced. Sessions no longer get a temp `pool/_pool-<id>` branch with a first-prompt rename to `session/<slug>-<id>`. Instead, `pool.claim(targetBranch)` produces the final `session/<id8>` name with a single branch-rename + worktree-move at claim time. See [`docs/design/remove-session-worktree-rename.md`](remove-session-worktree-rename.md) for the current design, including the unified fallback naming, sweeper post-upgrade behaviour (§13), `moveWorktree` consolidation (§14), `PoolClaimResult.degraded` semantics (§15), and the E2E test plan (§16). The historical content below is preserved for reference.

### 5.1 Pool entry becomes a set

`worktree-pool.ts`:

```typescript
interface PoolEntry {
  poolId: string;                                 // `_pool-<8hex>`
  branchName: string;                             // shared across repos: `pool/<poolId>` (no slashes once flattened)
  worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }>;
  createdAt: number;
}

class WorktreePool {
  constructor(opts: {
    project: RegisteredProject;
    components: Component[];
    targetSize?: number;
  });

  async claim(targetBranch: string): Promise<{
    branchName: string;
    container: string;          // <wt-root>/<targetBranchSlug>/
    worktrees: Array<{ repo: string; worktreePath: string }>;
  } | null>;

  async drain(): Promise<void>;
  startFilling(activeContainerPaths?: Set<string>): void;
  setComponents(components: Component[]): void;   // invalidates future fills (existing entries kept until claimed)
}
```

### 5.2 Claim sequence (the fast path)

For each repo in the pool entry, in parallel:

1. `git branch -m pool/<poolId> <targetBranch>` (fast, local ref rename).
2. Clear any inherited upstream unless it already points at `origin/<targetBranch>`. This happens before the caller receives the claimed worktree, so a pool branch that tracked `origin/master` cannot leak that upstream into a goal/session branch.
3. `git worktree move <pool-path> <target-path>` — atomic since git 2.17. On failure (typically Windows file locks), **degraded fallback**: skip the move; log `[worktree-pool] degraded: dir kept at pool path for <repo>`. The branch rename succeeded so the agent can still work; only the directory name is stale. The boot sweeper will reclaim it later.

4. **Hand control to the caller now.** The remaining steps run in the background:
   - `git fetch origin` then `git reset --hard <base-ref>`.
   - `git push origin <targetBranch>:refs/heads/<targetBranch>` (fire-and-forget, skipped under `BOBBIT_TEST_NO_PUSH=1`), then fetch the remote-tracking ref and set upstream to `origin/<targetBranch>`.

Replenishment kicks off immediately. Pool target is `worktree_pool_size` × number of distinct repos (so pool slot count is per-set, not per-repo).

### 5.3 Goal flow — through the pool

`goal-manager.ts::_doSetupWorktree` becomes:

```typescript
const pool = ctx.worktreePools.get(goal.projectId);
const claim = pool ? await pool.claim(goal.branch).catch(() => null) : null;

if (claim) {
  this.store.update(goal.id, {
    worktreePath: claim.container,
    repoWorktrees: Object.fromEntries(claim.worktrees.map(w => [w.repo, w.worktreePath])),
    setupStatus: "ready",
  });
  return;
}

// Fallback: no pool warmth — create from scratch
const result = await createWorktreeSet(goal.repoPath, components, goal.branch);
// …same persist…
```

**This is the fix for AC 12.** Goals are observably as fast as sessions when the pool is warm.

### 5.4 Session flow — temp branch + rename on first prompt

`session-manager.ts::createSession`:

1. On creation: claim with branch `pool/<poolId>` directly — **don't** synthesize a `session/new-session-<id>` branch up front. Persist `session.branch = "pool/<poolId>"` and `session.poolId` for later rename.
2. On the first user prompt arrival (in `session-manager.ts` prompt handler, *before* dispatching to the agent): check `session.poolId`. If set and `titleGenerated` becomes true:
   - Compute target `session/<slug>-<id8>` from the new title.
   - Run the same rename sequence as `pool.claim`: `git branch -m`, `git worktree move`, update session record's `branch` and `worktreePath` (and per-repo `repoWorktrees`). Update RPC bridge's cwd if it uses an absolute path.
   - On `git worktree move` failure → degraded mode: branch renamed, dir stays. Persist a `degraded: true` flag on the session for the sweeper.
3. If session is archived without a first prompt: cleanup uses the pool branch name; no rename.

### 5.5 Boot sweeper

`src/server/agent/worktree-sweeper.ts` (new), invoked once at startup before pool fill:

```typescript
async function sweepOrphanedWorktrees(opts: {
  projects: RegisteredProject[];
  goals: PersistedGoal[];
  sessions: PersistedSession[];   // including archived where worktree still exists
  staff: PersistedStaff[];
}): Promise<{ reclaimed: number; cleaned: number }>;
```

Algorithm per project:
- Enumerate `git worktree list --porcelain` in each repo.
- For each worktree, classify:
  - Pool branch (`pool/_pool-<id>`) AND in pool already → keep.
  - Pool branch AND not in pool AND no session/goal/staff owns it → reclaim into pool (push to `pool.entries`).
  - Active session/goal/staff branch → keep.
  - Branch with no owner (likely from a pre-rename crash) → `git worktree remove` + `git branch -D`.
  - Branch matches an active record but at a different path (rename-mid-shutdown) → repair via `git worktree repair`; if that fails, `move` to expected path; if that fails, update record to current path.

Logged as `[sweeper] reclaimed N, cleaned M, repaired K`.

Acceptance: AC 18.

### 5.6 `git worktree move` requirement

Acceptance criterion 14. `worktree-paths.ts::moveWorktree(repoPath, oldPath, newPath)` wraps the call. Used by `pool.claim` and the session-rename path. On failure:

```
[worktree-pool] git worktree move failed for <repo>: <stderr>
[worktree-pool] degraded mode: branch renamed, dir kept at <oldPath>
```

The session/goal record stores `worktreePath = oldPath` so subsequent operations work.

---

## 6. Per-repo git handoff & PR-per-repo

### 6.1 Task handoff schema

`task-store.ts`:

```typescript
export interface PersistedTask {
  // …existing flat fields kept for back-compat…
  baseSha?: string;
  headSha?: string;
  branch?: string;
  // NEW
  gitHandoff?: Record<string /*repoName*/, { baseSha?: string; headSha?: string; branch?: string }>;
}
```

Migration on load (in `task-store.ts::load`):
- If `task.baseSha`/`headSha`/`branch` present and `gitHandoff` absent and the goal is multi-repo → set `gitHandoff[<defaultRepoName>]` from the flat fields. Default repo = first component's repo name.
- Single-repo tasks: leave flat fields populated, leave `gitHandoff` absent. Reads must accept both shapes.

Helper:

```typescript
export function readHandoff(task: PersistedTask, repo: string):
  { baseSha?: string; headSha?: string; branch?: string }
{
  if (task.gitHandoff?.[repo]) return task.gitHandoff[repo];
  // back-compat single-repo: flat fields
  return { baseSha: task.baseSha, headSha: task.headSha, branch: task.branch };
}
```

### 6.2 Aggregated git status / diff

`server.ts`:

- `GET /api/goals/:id/git-status` → returns `{ aggregate: GitStatus, repos: Record<string, GitStatus> }` for multi-repo; single-repo returns `{ aggregate, repos: { ".": aggregate } }` (back-compat — existing UI handles flat shape).
- `GET /api/goals/:id/git-diff?repo=<name>` → diff scoped to a repo. Without `?repo=`, returns concatenated diff with per-repo headers.
- `batchGitStatus()` (existing) is reused per-repo and aggregated.

The matching **session-context** endpoints (`GET /api/sessions/:id/git-status` and `git-diff`) reached parity in a follow-up — see §13 for the session envelope, the synthesized aggregate for non-git branch containers, per-repo diff routing, and the container-diff security hardening.

### 6.3 PR-per-repo

Existing PR helpers (`pr-status-store.ts`, `gh pr list/create` in workflow `ready-to-merge` gates) operate per-repo. The bobbit appendix workflow uses pure-`run` steps (`git push origin {{branch}}:refs/heads/{{branch}}`, `gh pr list …`) that already act on whatever cwd the step runs in. For multi-repo, the assistant generates one set of these steps per repo, each with `component:` set to the appropriate component:

```yaml
- { name: "Push api", type: command, component: "api",
    run: "git push origin {{branch}}:refs/heads/{{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
- { name: "Push web", type: command, component: "web", run: "…" }
```

`pr-status-store.ts` keys PR records by `(goalId, repoName)`.

---

## 7. Per-component `worktree_setup_command` & sandbox

### 7.1 Per-component setup loop

New function `src/server/skills/worktree-setup.ts`:

```typescript
export async function runComponentSetups(opts: {
  components: Component[];
  branchContainer: string;             // host or container path
  primaryWorktreeRoot: string;          // for SOURCE_REPO mapping
  exec: (cmd: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<void>; // host or docker
}): Promise<void> {
  for (const c of opts.components) {
    if (!c.worktreeSetupCommand) continue; // skip data-only and components without hook
    const cwd = componentRoot(c, opts.branchContainer);
    const sourceRepo = path.join(opts.primaryWorktreeRoot, c.repo === "." ? "" : c.repo, c.relativePath ?? "");
    try {
      await withTimeout(opts.exec(c.worktreeSetupCommand, cwd, { ...process.env, SOURCE_REPO: sourceRepo }), 120_000);
      console.log(`[worktree-setup] ${c.name}: ok`);
    } catch (err) {
      console.warn(`[worktree-setup] ${c.name}: failed (non-fatal):`, err);
    }
  }
}
```

- Sequential per-component, declared order. Independent failures: each component runs even if a prior one failed.
- 2-minute timeout per command.
- No deduplication. Two components in the same repo each running `npm ci` → it runs twice.
- `SOURCE_REPO` resolves to the matching component path in the project's primary checkout.

`setupWorktreeDeps` in `git.ts` keeps its current single-repo signature as a thin wrapper that constructs a one-element components list when called from legacy paths (pool prebuild for single-repo, recovery).

### 7.2 Sandbox (Docker) layout

`docker-args.ts`:

- For multi-repo projects:
  - Named volume `bobbit-workspace-<projectId>` mounted at `/workspace` — contains all repos under `/workspace/<repo>/`.
  - Named volume `bobbit-worktrees-<projectId>` at `/workspace-wt/` — agent worktrees: `/workspace-wt/<branchSlug>/<repo>/`.
- For single-repo: unchanged (`/workspace` is the repo).

`project-sandbox.ts::createWorktree` becomes `createWorktreeSet`:

```typescript
async createWorktreeSet(name: string, branch: string, components: Component[], baseBranch?: string):
  Promise<{ container: string; worktrees: Array<{ repo: string; worktreePath: string }> }>
```

For each repo (one if single-repo), run `git worktree add /workspace-wt/<name>/<repo> -b <branch> <startPoint>` inside the container, where the cwd is `/workspace/<repo>` for the source repo.

Then:
```typescript
await runComponentSetups({
  components, branchContainer: `/workspace-wt/${name}`,
  primaryWorktreeRoot: "/workspace",
  exec: (cmd, cwd, env) => this._dockerExec(this.containerId, ["sh", "-c", cmd], { cwd, env }),
});
```

Pool prebuild inside the sandbox uses the same path via `pool.fill()` invoking `sandbox.createWorktreeSet(poolId, `pool/${poolId}`, components)`.

### 7.3 Token stripping & host-path rewriting

Existing `stripTokenFromGitUrl` and `toDockerPath` keep working. The only new wrinkle: when the user sets `worktree_root` to an absolute host path *outside* `rootPath`, sandbox mode must still work — emit a warning and fall back to the named-volume default (worktree_root only applies in non-sandbox mode). Documented and tested.

---

## 8. UI surface

### 8.1 Add Project flow

`src/ui/components/ProjectPickerPopover.ts` and the project-assistant chat surface:

1. User picks a folder.
2. Server runs `repo-scan.ts::scanRepos`.
3. Assistant proposes:
   - List of detected repos as a checklist (defaulting all checked).
   - For each checked repo, a flat editable `commands` map (suggestions pre-filled from `package.json` etc.).
   - Per-repo "data-only" toggle (skips command suggestions and produces a no-commands component).
   - Auto-generated `workflows:` block previewable via "Preview workflows" button.
4. `propose_project` is extended (see §8.5) to carry the full structured proposal in one shot.

### 8.2 Settings → project tab

`src/ui/components/SettingsView.ts` (existing) gains a "Components" section:

```
┌─ Components ──────────────────────────────────────────┐
│ ▾ api          repo: api          [delete] [rename]   │
│   relative_path:  packages/api                        │
│   worktree_setup_command:  npm ci --prefer-offline    │
│   commands:                                           │
│     build    npm run build                  [×]       │
│     test     npm test                       [×]       │
│     [+ add command]                                   │
│ ▾ shared       repo: shared       no commands         │  ← data-only
│ ▸ docs (data-only)                                    │
│ [+ add component]    [Re-scan repos]                  │
└───────────────────────────────────────────────────────┘
```

Plus:
- `worktree_root` text input (general project section).
- "Workflows" expandable panel showing each workflow's gates → steps with their resolved `(component, command)` pair. Clicking a step shows the resolved shell string.
- "Regenerate workflows" button (calls the project assistant in a one-shot mode).

### 8.3 Goal/session creation indicator

`GoalCreationDialog` and `NewSession` flows query `GET /api/projects/:id/components` and show:

> Will create 3 worktrees across api, web, shared (data-only).

### 8.4 Git status widget

`src/ui/components/GitStatusWidget.ts`: when `repos` map has more than one entry, render a collapsible per-repo section with aggregated counts in the header:

```
[Git status]  3 changed across 2 repos    ▾
  ▾ api    +12 −3   ●●●
  ▾ web    +1  −0   ●
  shared   clean
```

API contract change: existing flat shape continues for single-repo. Multi-repo returns the new envelope; widget detects and renders accordingly.

### 8.5 `propose_project` tool

`defaults/tools/proposals/extension.ts`: rewrite the schema:

```typescript
parameters: Type.Object({
  name: Type.String(),
  root_path: Type.String(),
  worktree_root: Type.Optional(Type.String()),
  sandbox: Type.Optional(Type.String()),
  qa_start_command: Type.Optional(Type.String()),
  // …other qa_/sandbox_/sandbox_tokens fields…
  components: Type.Array(Type.Object({
    name: Type.String(),
    repo: Type.String(),                                                  // "." for single-repo
    relative_path: Type.Optional(Type.String()),
    worktree_setup_command: Type.Optional(Type.String()),
    commands: Type.Optional(Type.Record(Type.String(), Type.String())),
  })),
  workflows: Type.Optional(Type.Record(Type.String(), Type.Any())),       // structural validation server-side
  session_model: Type.Optional(Type.String()),
  review_model: Type.Optional(Type.String()),
  naming_model: Type.Optional(Type.String()),
}),
```

Acceptance side (`session-manager.ts::acceptProjectProposal`): writes `components` + `workflows` to `project.yaml` in one transaction; runs `validateAllWorkflows` first; on failure returns the error to the agent for revision.

### 8.6 Sub-section diff in proposal panel

`src/ui/components/ProjectProposalPanel.ts` (existing): teach the diff renderer to scope diffs by top-level YAML key. When the user expands "workflows", they see only that block's diff. Done by parsing both old and new YAML to AST, computing per-key diffs, rendering each in its own collapsible section.

---

## 9. Testing plan (mapped to acceptance criteria)

### 9.1 Unit / file-fixture tests (`tests/*.spec.ts`)

| AC | Test |
|----|------|
| 1, 2 | `migrate-project-yaml.spec.ts` — feed legacy `project.yaml` (with named project), assert `components: [{ name: <projectName>, repo: "." }]` + commands map; run twice → idempotent; assistant code path produces same shape for new single-folder. |
| 3 | `repo-scan.spec.ts` — fixture dirs (single repo, multi-repo, monorepo, data-only), assert detected components and detected commands. |
| 6 | `workflow-validator.spec.ts` — positive cases (all three step shapes); negatives (missing component, wrong command, both `command`+`run`, neither). Asserts error messages include "Did you mean…". |
| 7 (audit) | One spec per row in §3.5 table — file-fixture workflows, parse + validate + (where applicable) execute under the harness. |
| 8 | `inline-workflow-load.spec.ts` — load a project with empty `workflows: {}`, attempt `POST /api/goals` → 400 with the documented error. |
| 17 | `task-handoff-multi-repo.spec.ts` — task store accepts and retrieves `gitHandoff` per repo; legacy flat fields continue to work. |
| 19 | `worktree-setup-multi.spec.ts` — fake `exec`, three components, declared order asserted; one fails non-fatally; data-only skipped. |

### 9.2 API E2E (`tests/e2e/`)

| AC | Test |
|----|------|
| 3, 21 | `multi-repo-project.spec.ts` — `POST /api/projects` with two-component + data-only components + workflows; `PUT /api/projects/:id/config` to add a component; assert structural workflow validation rejects invalid step shapes. Single-repo POST without `components` → server fills default component named after project. |
| 10 | `multi-repo-goal.spec.ts` — create goal in a 3-repo project; assert disk has `<wt>/<branchSlug>/api`, `/web`, `/shared` worktrees on the goal branch. |
| 11 | `worktree-root-override.spec.ts` — set `worktree_root: "../my-wts"`; create goal; assert path resolution. |
| 17 | `git-handoff-multi-repo.spec.ts` — task with `gitHandoff` per repo; agent reads handoff via existing API. |
| 22 | `pool-flow.spec.ts` — fill pool, assert goal claims (no fallback `createWorktree`); session claims with temp branch; first prompt → branch renames; pool replenishes. |

### 9.3 Browser E2E (`tests/e2e/ui/`)

| AC | Test |
|----|------|
| 5, 8, 20 | `multi-repo-flow.spec.ts` — register project with 2 git fixtures + 1 data-only fixture; settings shows 3 components; data-only rendered; workflows previewed; create goal; verify on-disk worktree set including data-only repo; per-component setup invocation traced; git-status widget shows 3 sections; signal one gate end-to-end; archive goal; verify cleanup of all 3 worktrees. Includes persistence-across-reload. |

### 9.4 Manual integration (`tests/manual-integration/`)

| AC | Test |
|----|------|
| 23 | `multi-repo-docker.test.ts` — real Docker, real git, two real repos in container; create goal; per-component setup runs inside container; one llm-review and one agent-qa gate execute end-to-end; teardown succeeds. |

---

## 10. Files touched (build checklist)

**New:**
- `defaults/workflow-authoring-guide.md`
- `src/server/agent/repo-scan.ts`
- `src/server/agent/workflow-validator.ts`
- `src/server/agent/worktree-sweeper.ts`
- `src/server/skills/worktree-paths.ts`
- `src/server/skills/worktree-setup.ts`
- `src/server/state-migration/migrate-project-yaml.ts`
- Tests listed in §9.

**Deleted (after MD guide lands and tests are green):**
- `defaults/workflows/bug-fix.yaml`
- `defaults/workflows/feature.yaml`
- `defaults/workflows/general.yaml`
- `defaults/workflows/quick-fix.yaml`
- `defaults/workflows/test-fast.yaml` (or relocate to fixtures)
- `.bobbit/config/workflows/` reading paths in code

**Modified:**
- `src/server/agent/project-config-store.ts` — Component types, getters, getYaml/setComponents/setWorkflows.
- `src/server/agent/project-registry.ts` — no schema change; just bumping migration call.
- `src/server/agent/workflow-store.ts` → renamed/refactored to `InlineWorkflowStore`; new step union types.
- `src/server/agent/workflow-manager.ts` — uses `InlineWorkflowStore`; integrates validator.
- `src/server/agent/project-assistant.ts` — repo scan; per-component command detection; default component name = project name; emits full `propose_project` payload incl. workflows.
- `src/server/agent/goal-manager.ts` — pool-first setup; per-repo worktree map; multi-repo branch.
- `src/server/agent/session-manager.ts` — pool claim with temp branch; rename on first prompt; sweeper hookup.
- `src/server/agent/session-setup.ts` — uses `branchContainer`/`repoWorktreePath`.
- `src/server/agent/worktree-pool.ts` — pool entry as set; multi-repo prebuild; degraded fallback.
- `src/server/agent/project-sandbox.ts` — `createWorktreeSet`, multi-repo mount layout.
- `src/server/agent/docker-args.ts` — multi-repo mount layout (no change to single-repo).
- `src/server/agent/verification-harness.ts` — step resolution via `resolveStep`; per-step cwd from component.
- `src/server/agent/verification-logic.ts` — drop `{{project.X}}` resolution branch; keep token semantics for free-form.
- `src/server/agent/task-store.ts` — `gitHandoff` field + read-helper; migration.
- `src/server/server.ts` — multi-repo `git-status`/`git-diff`; `propose_project` schema; manual-pass endpoint.
- `src/server/skills/git.ts` — generalized `createWorktree` callers; `setupWorktreeDeps` thin wrapper kept for legacy.
- `src/ui/components/ProjectPickerPopover.ts`, `SettingsView.ts`, `ProjectProposalPanel.ts`, `GitStatusWidget.ts`, `GoalCreationDialog.ts`, `AgentInterface.ts` — UI surface §8.
- `defaults/tools/proposals/extension.ts` — `propose_project` schema (§8.5).
- `AGENTS.md` — Worktrees, Git conventions sections.
- `docs/internals.md` — multi-repo, components, inline workflows, sandbox layout, pool, sweeper.
- `docs/goals-workflows-tasks.md` — per-repo handoff, structural step references, inline workflow model.

**Doc-only:**
- `docs/design/multi-repo-components.md` (this file).

---

## 11. Rollout & risk

- **Order of merging:** (1) MD guide + validator + Component types (no behavior change). (2) Inline workflow loader with migration of `.bobbit/config/workflows/`. (3) Pool-set + sweeper + goal-through-pool + session temp-branch rename. (4) Multi-repo plumbing in git/sandbox/server/UI. (5) Delete `defaults/workflows/*.yaml`.
- **Risk areas:** sandbox volume layout change for multi-repo (existing single-repo projects unaffected because `repo === "."` collapses to today's paths); pool degraded-mode on Windows file locks; `git worktree move` requires git ≥ 2.17 (already a hard prerequisite).
- **Backwards compatibility:** every existing single-repo project continues to work after one-shot migration. Goal/task records get a one-time migration to per-repo handoff for multi-repo only.
- **Out of scope:** normalizing `sandbox_tokens`/`qa_env`/`config_directories` to native YAML — **completed** in a follow-up goal; see `docs/internals.md` → "Native-YAML project.yaml fields".

---

## 12. Open questions called out (non-blocking)

1. **Manual gates (§3.6)** — UI affordance is "Mark passed" button. Confirm whether we want a comment field on manual-pass for an audit trail. Default: yes, store `metadata.note`.
2. **Pool sizing for multi-repo** — `worktree_pool_size` is per-set today. For an N-repo project, this means N×size physical worktrees. If memory/disk pressure becomes an issue we can introduce `worktree_pool_repo_concurrency` later.
3. **`worktree_root` + sandbox** — currently warned and ignored. If users push back, we can mount a host bind under `/workspace-wt-host` and reroute. Not in the AC.

---

## 13. Session git-status / git-diff parity (addendum, 2026-06)

§6.2 described the **goal** dashboard's aggregated git status/diff. This section documents the matching **session-context** work: the per-session pill + popover above the composer now show the same multi-repo aggregate that the goal dashboard does. Goal and single-repo behaviour are byte-for-byte unchanged; only the session code path gained multi-repo awareness.

**Why this was needed.** A polyrepo session's worktrees live one level under a non-git *branch container* (see §4.2). The session widget previously statused only the container `cwd` and rendered a flat single-repo result — so a true polyrepo session showed just a branch name with no per-repo breakdown and no aggregated dirty/ahead/behind/diff counts. The goal path already solved this; sessions were the remaining gap.

### 13.1 Envelope shape (`GET /api/sessions/:id/git-status`)

The handler in `src/server/server.ts` (the `/api/sessions/:id/git-status` branch) mirrors the goal handler's envelope:

- **Single-repo / no `repoWorktrees`** → unchanged flat shape plus back-compat keys: `{ ...result, aggregate: result, repos: { ".": result } }`. The existing 400 `{ error: "Not a git repository" }` and 500 paths are preserved, and the auto-push of unpushed feature/`session/…` branches still runs on `result`.
- **Multi-repo** (`session.repoWorktrees.length > 1`) → `{ ...aggregate, aggregate, repos }`, where `repos` is keyed by **repo name** and each entry is a full `GitStatusResult`.

**Shape note.** In-memory `session.repoWorktrees` is an **array** `Array<{ repo, repoPath, worktreePath }>` (see `session-manager.ts`), unlike the goal's `Record<string, string>` (`goal.repoWorktrees`). The session handler iterates the array and statuses each entry's `worktreePath` (sandboxed sessions route through the container via the `containerId` argument, exactly as the flat path does). Per-repo failures are swallowed (`try/catch`, skip the entry) so one broken sub-repo cannot 500 the whole status. Each per-repo `batchGitStatus` call honours the project `base_ref` config (`configuredBaseRef`), matching the goal handler and `docs/design/base-ref.md` §5.

### 13.2 Synthesized aggregate for non-git containers

The root container status comes from `batchGitStatus(cwd, …)`. In a **true polyrepo** the container `cwd` is *not* itself a git repo (§4.2), so this returns `null` / throws. That is **non-fatal in multi-repo mode** — the per-repo worktrees are the source of truth. The aggregate is resolved as:

1. **Root `result` exists** (the container is itself a git repo — e.g. a `repo: "."` component, or a single-repo collapse) → use it as the aggregate, for back-compat with the flat shape.
2. **Root `result` is null** (genuine non-git container) → **synthesize** an aggregate from the per-repo results. All sub-repos share the same session branch, so `branch` / `primaryBranch` / `primaryRef` / `isOnPrimary` / `hasUpstream` / `mergedIntoPrimary` are taken from the **first** repo, while the numeric counters (`ahead`, `behind`, `aheadOfPrimary`, `behindPrimary`, `insertionsVsPrimary`, `deletionsVsPrimary`) are **summed** across repos. `clean` is the **AND** across repos (clean only if every repo is clean), `unpushed` is the **OR**, `status` is `[]` (the flat file list is suppressed — the per-repo popover sections are authoritative), and `summary` is `"<N> repos"`.

If neither a root `result` nor any per-repo result is available, the handler returns the same 400 `{ error: "Not a git repository" }` as the flat path.

**Why synthesize rather than 400.** Without the synthesized aggregate, a polyrepo session whose container is non-git would have no top-level status object at all, so the pill would fall back to rendering only the branch name — the exact gap this work closes. Synthesizing lets the pill show real aggregated stats even though the directory the agent's `cwd` points at is not a git repo.

**Auto-push** only runs when the root `result` exists. For a non-git-container polyrepo there is no root repo to push, and the individual session branches are already published at worktree-claim time (§5.2 / `docs/design/remove-session-worktree-rename.md`), so skipping container auto-push is correct.

### 13.3 Per-repo diff routing (`GET /api/sessions/:id/git-diff`)

Clicking a file inside a per-repo popover section opens that repo's diff. The widget's `_openDiffModal(file, repo?)` (`src/ui/components/GitStatusWidget.ts`) appends `?repo=<name>` to the diff URL when the file came from a multi-repo section. The session `git-diff` handler resolves `?repo=` against `session.repoWorktrees` (find the array entry whose `repo` matches) and diffs that entry's `worktreePath`; an absent or `.` repo param (or an unknown name) falls back to the container `cwd`. This mirrors the goal `git-diff` handler's `?repo=` resolution.

### 13.4 Container-path security: argument-vector exec

`getGitDiff`'s container branch previously built a `/bin/sh -c "git diff … -- <file>"` string with the user-supplied `file` interpolated in, a command-injection vector. It now uses **argument-vector execution** via `execGitArgsSafe` → `execGitArgs`, which runs `docker exec -w <cwd> <containerId> git <args…>` with `file` passed as a distinct argv element — never parsed by a shell. (Path-traversal / absolute / drive-letter `file` values are still rejected up front with `INVALID_PATH`.)

**Why argv instead of a shell string.** Passing `file` through `/bin/sh -c` meant any shell metacharacters in the filename were interpreted by the container's shell. Argv execution removes the shell entirely, so the diff target is always treated as literal data regardless of its contents — closing the injection vector without changing behaviour for legitimate paths.

### 13.5 Widget rendering

`src/ui/components/GitStatusWidget.ts` already rendered per-repo sections and a multi-repo pill label; this work completed the aggregation:

- **Pill** — in multi-repo mode (`repos` has >1 entry) the pill shows `"<N> changed across <M> repos"` (dirty-file count summed across repos, `M` = count of dirty repos) **plus** full aggregated primary-comparison segments. `_aggregatePrimaryStats()` sums `aheadOfPrimary` / `behindPrimary` / `insertionsVsPrimary` / `deletionsVsPrimary` across the `repos` envelope entries, and `_segmentSpans()` renders the shared coloured `↓behind ↑ahead +ins -del` markup (the same helper the flat `_pillSegments()` uses, so styling never diverges).
- **Clean collapse** — multi-repo clean state (every repo clean *and* all summed primary stats zero, with no PR) collapses to the single green "clean" indicator. This is derived from the **aggregate**, **independent of `isOnPrimary`** — a clean `session/…` branch must still collapse to "clean" even though it is not on the primary branch. Flat/single-repo collapse logic is unchanged (it still considers `isOnPrimary` / `mergedIntoPrimary`).
- **Popover** — `_renderMultiRepoSections()` renders one collapsible section per repo with per-repo counts; dirty repos auto-expand, clean ones stay collapsed.

The per-repo envelope entries already carried `aheadOfPrimary` / `behindPrimary` / `insertionsVsPrimary` / `deletionsVsPrimary` (added by the line-counts work in `docs/design/git-status-widget-reliability.md` §13), so the pill aggregation reuses those fields directly rather than recomputing anything server-side.

### 13.6 Tests

- **Widget unit / file-fixture** — the `git-status-widget-multi-repo` bundle (`tests/fixtures/build-bundle.ts`) covers the full-aggregate pill (summed dirty + ahead/behind/+/−) and the clean-collapse case.
- **API E2E** — `GET /api/sessions/:id/git-status` returns `{ repos, aggregate }` for a multi-repo session and the unchanged flat + `repos: { ".": result }` shape for single-repo.
- **Browser E2E** (`tests/e2e/ui/`) — a polyrepo session shows aggregated pill stats; the popover shows one section per repo with correct counts; a clean repo renders collapsed; clicking a file opens that repo's diff; state persists across reload.

---

## Appendix A — Worked example: Bobbit's own `project.yaml`

The goal spec's appendix is the canonical post-migration shape. Implementors should diff Bobbit's current `.bobbit/config/project.yaml` against that target as a smoke test (one component, project-name == component-name, `commands` map covering build/check/unit/e2e, single inline `workflows:` block with the four bobbit workflows).
