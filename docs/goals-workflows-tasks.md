# Goals, Workflows, Tasks & Gates

This document explains how Bobbit's goal orchestration system works — how goals, workflows, tasks, and gates relate to each other, and how context flows between agents.

## Concepts

### Goals

A **goal** is a unit of work with a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved` | `blocked`). The `'blocked'` state is scheduler-managed: set when a child's `dependsOnPlanIds` reference sibling subgoals that have not yet merged, and automatically cleared to `'todo'` when those deps merge. It is distinct from `goal.paused` (operator-set) — see [docs/design/pause-cascade.md](design/pause-cascade.md) for the full separation. Every goal is scoped to a registered project via its `projectId` field (see [internals.md — Multi-project architecture](internals.md#multi-project-architecture)). Worktrees are created relative to that project's `rootPath`.

`POST /api/goals` requires the caller to identify the project: either an explicit `projectId` in the request body, or a `cwd` inside a registered project's `rootPath`. There is no default-project fallback — a request with neither resolvable returns **400**. See the [Project resolution contract](rest-api.md#project-resolution-contract) in the REST API docs for the exact error shape.

Goals can run in **team mode**, where a Team Lead agent orchestrates multiple role agents (coders, reviewers, testers) working concurrently in their own worktrees. Goals carry an `autoStartTeam` flag (defaults to `true`). When enabled, the server automatically calls `teamManager.startTeam()` after worktree setup completes — no manual "Start Team" click needed. If auto-start fails but the worktree succeeded, the error is logged and the worktree remains usable; the user can start the team manually. The retry-setup handler also respects this flag.

**Team-lead kickoff.** When `startTeam` boots the lead session, it dispatches an initial user message that prepends the goal spec as a `# Goal Spec` block before the standard "Execute the task described in your system prompt" instruction. The spec is re-read from the goal store at dispatch time so late edits (e.g. a parent team-lead filling in a `goal_spawn_child` placeholder spec while the child's session was still booting) land in the kickoff message rather than the stale construction-time copy. The team-lead role prompt instructs the agent to read the spec from this first user message and **not** to call `view_goal_spec` on startup — that tool is reserved for mid-flight re-reads triggered by `goal_spec_changed` notifications (see [design/team-lead-spec-injection.md](design/team-lead-spec-injection.md) and [design/goal-spec-edit-notification.md](design/goal-spec-edit-notification.md)). The REST endpoint `POST /api/goals/:id/team/start` enforces a non-empty, non-placeholder spec via `400 SPEC_REQUIRED`; internal call sites bypass that guard.

#### Nested goals (Phase 1 data model)

Goals can nest. A nested goal IS a goal — same record shape, same store, same gates, same workflow snapshot, same team-lead session. The only difference is a handful of optional fields on `PersistedGoal` that establish the parent/child relationship and a few root-only policy fields. Phase 1 adds the data model; the verification harness `subgoal` step type that consumes it lands in Phase 3.

| Field                   | Type                                          | Where set                                                                                  | Meaning                                                                                                                                                              |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentGoalId`          | `string?`                                     | At creation only (never updated thereafter)                                                | Parent goal ID. Undefined for root goals.                                                                                                                            |
| `rootGoalId`            | `string?`                                     | Auto-derived at creation                                                                   | Root of this goal's tree. Equals `id` for root, equals `parent.rootGoalId ?? parent.id` for children. Defensive `?? parent.id` covers legacy parents missing the field. |
| `mergeTarget`           | `"master" \| "parent"?`                       | Auto-derived at creation                                                                   | Where this goal's branch merges. `"master"` for root (raises a PR via `ready-to-merge`). `"parent"` for children (local merge into parent's branch — no remote PR).     |
| `divergencePolicy`      | `"strict" \| "balanced" \| "autonomous"?`     | REST (root only)                                                                           | Mutation policy for post-freeze plan changes. Default `"balanced"`. Inert on sub-goals (forward-compat); harness consults the root's value.                          |
| `maxConcurrentChildren` | `number?`                                     | REST (root only)                                                                           | Max parallel children across the tree. Default 3, hard max 8. Inert on sub-goals.                                                                                    |
| `acceptanceCriteria`    | `string[]?`                                   | Auto-populated from `## Acceptance criteria` in the spec markdown                          | Used by the criteria-coverage check (Phase 4) to gate `criteria-drop` mutations.                                                                                     |
| `spawnedFromPlanId`     | `string?`                                     | Stamped by the harness immediately after `createGoal` in `runSubgoalStep` (no awaits between)     | Subgoal idempotency key. Lookup by `(parentGoalId, planId)` rescues children stranded by mid-spawn restart.                                                          |
| `dependsOnPlanIds`      | `string[]?`                                   | Stamped by `POST /api/goals/:id/spawn-child` and by `runSubgoalStep` immediately after `createGoal`, alongside `spawnedFromPlanId`. Sourced from `body.dependsOn` (REST) or `step.subgoal.dependsOn` (harness). | Sibling `planId`s this child waits on. Drives the Plan-tab DAG topological-depth layout (column = `max(deps.column) + 1`) and the explicit edge set. Empty / undefined = parallel sibling, no incoming edge. Validated at the API layer (`SELF_DEPENDENCY`, `UNKNOWN_PLAN_ID`, `DEPENDS_ON_CYCLE`). See [nested-goals.md — Declaring dependencies](nested-goals.md#declaring-dependencies). |
| `paused`                | `boolean?`                                    | `POST /pause` and `POST /resume` only — **never set by the scheduler**                    | Operator pause: set by `goal_pause`, cleared by `goal_resume`. Sticky. Children may inherit via cascade (`cascade: true`) using a top-down `cascadeSubtree` walk. Distinct from `state: 'blocked'` (scheduler-managed dep wait). A paused child does NOT suppress the parent's idle nudge. See [pause-cascade.md](design/pause-cascade.md) and [hierarchical-cascade.md](design/hierarchical-cascade.md). |
| `replanCount`           | `number?`                                     | Bumped by REST classifier on every successful post-freeze mutation                         | Auto-pause trigger when `> 5` (human review required).                                                                                                               |
| `suggestedRole`         | `string?`                                     | Stamped by `POST /api/goals/:id/spawn-child` in the same atomic `updateGoal` as `spawnedFromPlanId` | Optional role hint from the parent — read by the child team-lead's system prompt to bias the first delegation. Not enforced; the lead may pick a different role if the work demands it. |
| `spawnedBySessionId`    | `string?`                                     | Stamped by `POST /api/goals/:id/spawn-child` in the same atomic `updateGoal` as `spawnedFromPlanId`. Header `X-Bobbit-Spawning-Session` wins over `body.spawnedBySessionId` so a forwarded request can't lie about the spawning agent. The children-tools extension (`defaults/tools/children/extension.ts`) sets the header on every `goal_*` API call. | Identifies the team-lead session that spawned this child. Drives sidebar nesting: sub-goals stamped with this field render INSIDE the spawning team-lead's expanded block (`renderTeamGroup`), so collapsing the team-lead hides them as one unit. Falls back to parent-forest level when the spawning session is fully gone. Boot-time `GoalManager.backfillSpawnedBySessionId(teamStore, sessionStore?)` stamps legacy sub-goals from the parent's persisted team-lead session id (or, when the team is gone, a single archived team-lead match in the session store). |

**Derivation rules** (applied at `createGoal`):

- `parentGoalId === undefined` → `rootGoalId = id`, `mergeTarget = "master"` (root goal).
- `parentGoalId` set → walk parent chain (capped at 64 deep) for cycle prevention; `rootGoalId = parent.rootGoalId ?? parent.id`; `mergeTarget = "parent"`.

**Lazy migration**: existing `goals.json` files written before Phase 1 load unchanged — every new field reads as `undefined`. The data layer never backfills defaults; defaults are computed at use sites. Top-level goals created post-Phase-1 have `rootGoalId = id` and `mergeTarget = "master"` stamped explicitly.

**Inheritance**: `divergencePolicy` and `maxConcurrentChildren` are root-only and **NOT** auto-inherited by children. The harness consults the root's value at runtime. Sub-goals can persist their own value but it's inert.

**Security**: `parentGoalId` is set only at creation (never updated). `rootGoalId` and `mergeTarget` are server-derived only — never accept these from a client. Cycle prevention's depth cap of 64 guards against DoS via a self-referential or arbitrarily deep parent chain. `acceptanceCriteria` is plain text extracted from markdown and must not be rendered as HTML.

**Criteria-coverage check** (full implementation Phase 4): walks the union of {root spec, remaining subgoal step specs} for each acceptance criterion using a whitespace-normalised, locale-pinned (`toLocaleLowerCase("en")`) substring match. Hashes don't work — they fail the moment the team-lead paraphrases. Team-leads MUST quote criteria verbatim in subgoal specs (a `## Covers` heading is the convention). The locale pin (R-023 remediation) prevents Turkish/Lithuanian dotless-i false negatives.

**Other root-snapshotted fields not in the table above:**

- `inlineRoles?: Record<roleName, Role>` — ephemeral roles snapshotted onto the goal at creation time. Resolved BEFORE the project/server/builtin role cascade by `resolveRole(goal, name, roleStore)` in `src/server/agent/resolve-role.ts`. Inherited by `goal_spawn_child` (server merges parent + child). Lazy-migration in `goal-store.load()` drops malformed values (non-object / array) with a `console.warn`. See [nested-goals.md — Ephemeral roles & workflows](nested-goals.md#ephemeral-roles--workflows-goal-scoped).
- `workflow?: Workflow` — the goal's frozen workflow snapshot. Either built from `workflowId` lookup at creation, supplied inline as `body.workflow`, or inherited from `parent.workflow` via `stripSubgoalStepsForChildInheritance` for child goals.

The verbatim list of fields, types, and validation rules is the source of truth for `src/server/agent/goal-store.ts::PersistedGoal`. The pure helper that parses the criteria from spec markdown lives at `src/shared/parse-acceptance-criteria.ts`.

### Workflows

A **workflow** is a reusable template that defines which gates a goal must pass, their dependency relationships (a DAG), and verification configs. Workflows live **inline in `project.yaml::workflows`** — the project assistant generates a bespoke block per project from [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md). The MD authoring guide is the single source of truth for workflow patterns; the runtime never reads it.

Workflows are **project-scoped only** — there is no system-scope or builtin layer and no config cascade. New projects do **not** receive any default seed; the project assistant designs workflows from the discovered components and commands, and a project may legitimately persist with zero workflows. Every step references project-specific `(component, command)` pairs that have no meaning outside the owning project, so cascading would be ceremony around an empty upper layer. See [internals.md — Workflows are project-scoped only](internals.md#workflows-are-project-scoped-only) and [No default workflow scaffold](internals.md#no-default-workflow-scaffold).

When a goal is created with a `workflowId`, the entire workflow is **snapshotted** into `PersistedGoal.workflow`. This frozen copy is immune to later template edits — the goal's requirements are locked at creation time.

Goals without workflows still work fine — workflows are optional **at the data-model layer**. However, the standard goal-creation flow (the +New Goal picker and the goal assistant) requires the linked project to have at least one workflow. See [Default workflow resolution](#default-workflow-resolution) below for the resolution rules and the empty-workflows UX.

#### Default workflow resolution

Goal creation never assumes a workflow named `"general"` exists. Two layers cooperate:

**Server handler (`POST /api/goals` in `src/server/server.ts`)** — responsible for *resolving* the workflow before calling the manager. It runs four steps:

1. **Cascade lookup** — `configCascade.resolveWorkflows(projectId)` is searched for `workflowId`.
2. **Project-store fallthrough** — if the cascade misses, the handler tries `targetCtx.workflowStore.get(workflowId)` directly. This handles transient cascade-staleness after archive/create cycles where the cached cascade is briefly out of sync with the live store.
3. **Auto-seed defaults** — if the project's `workflowStore` is empty, the handler seeds default workflows and re-resolves. This fires for both explicit-`workflowId` and no-`workflowId` request bodies so a freshly registered project can immediately accept a goal.
4. **Friendly 400 on genuine miss** — if an explicit `workflowId` is still unknown after steps 1–3 and the store is non-empty, the handler returns `400 { code: "WORKFLOW_NOT_FOUND", workflowId, available: [<id>, …] }` via `jsonError`. This replaces the prior 500 crash and lets clients render a useful error (e.g. "workflow `foo` not found; available: `design`, `release`").

When `body.workflowId` is absent, the handler passes `undefined` to `GoalManager.createGoal` (the old `"general"` magic default was removed).

**Manager (`GoalManager.createGoal` in `src/server/agent/goal-manager.ts`)** — the downstream consumer. Its own fallback applies when the handler passes `undefined`:

1. **Explicit `workflowId` supplied** — looked up in the project's `WorkflowStore`; failure throws `Workflow not found: <id>` (the handler normally intercepts this case before delegation, but the manager remains defensive for non-HTTP callers).
2. **No `workflowId` supplied** — falls back to **the first workflow in `workflowStore.getAll()`** (insertion order, preserving project > user > defaults cascade priority). The UI mirrors this: the workflow `<select>` is seeded to the first available id once `fetchWorkflows` resolves.
3. **No workflows at all** — throws `NO_WORKFLOWS_MSG` ("This project has no workflows configured…"). The UI never reaches submit in this state because the empty-workflows banner disables the Accept button (see below).

Pinning tests: [`tests/api-goals-workflow-not-found.test.ts`](../tests/api-goals-workflow-not-found.test.ts) covers the cascade-miss / store-hit success, the cascade-miss / store-miss `WORKFLOW_NOT_FOUND` response shape, and the no-`workflowId` first-workflow fallback. [`tests/e2e/goal-creation-auto-seed.spec.ts`](../tests/e2e/goal-creation-auto-seed.spec.ts) covers the empty-store auto-seed path end-to-end.

No source file outside seed data, tests, and documentation may use the literal string `"general"` as a workflow default. This is enforced by the pinning test [`tests/no-general-workflow-default.test.ts`](../tests/no-general-workflow-default.test.ts), which scans `src/server/agent/` and `src/app/` for the string and rejects new occurrences (the role named `"general"` is explicitly allowlisted; it is unrelated to workflows). The pin exists because `"general"` was historically a magic default hardcoded in five places — UI dropdown initial state, accept handler fallback, `GoalManager` lookup, the goal-assistant prompt, and the re-attempt context builder — but workflows are now project-scoped with no system-level builtins, so there is no guarantee any given project has a workflow with that id. Hardcoding the string produced confusing `Workflow not found: general` errors on projects whose assistant had generated a bespoke workflow set with different names. The fix routes everything through "first workflow in store" instead, with the pinning test preventing reintroduction. See [Workflows](#workflows) for why workflows are project-scoped.

#### Goal creation in a zero-workflow project

Projects can legitimately exist with zero workflows (e.g. a freshly registered project whose assistant has not yet run). The goal-creation UX in that state:

- **Goal preview panel** (the +New Goal picker and the goal-assistant accept panel) renders an **empty-workflows banner** with a brief explanation and an **Open Project Assistant** button. The button calls `createProjectAssistantSession(project.rootPath, …)` from `src/app/dialogs.ts`, passing the linked project's id and existing name. The Accept button is disabled while the banner is visible, with a tooltip explaining why.
- **While workflows are still loading** for the linked project, the panel shows a skeleton placeholder instead of either the dropdown or the banner. This prevents the banner from flickering on initial load before `ensureWorkflowsLoaded(projectId)` resolves.
- **Goal assistant LLM** receives a stern sentinel from `SessionManager._buildWorkflowList()` when the project has no workflows: an instruction *not* to call `propose_goal` and to surface the empty state to the user. The assistant's normal "pick the first listed workflow" guidance only applies when at least one workflow is present.

The per-project workflow availability is cached client-side (`_workflowCacheByProject` in `src/app/render.ts`) so switching back to a project that has workflows does not refetch unnecessarily. Browser E2E coverage lives in [`tests/e2e/ui/goal-empty-workflows-banner.spec.ts`](../tests/e2e/ui/goal-empty-workflows-banner.spec.ts).

To author workflows for a project, see [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md) and run the project assistant from Settings → Components.

#### `createGoal` failure preserves the assistant

The goal-assistant accept flow (both the goal-preview panel handler and the `propose_goal` proposal-toast handler in `src/app/render.ts`) awaits `POST /api/goals` **before** tearing down any state. Disconnecting the remote agent, clearing the active assistant view, deleting the persisted draft, removing `gateway.sessionId`, and navigating to the goal dashboard all happen only on success.

On failure (any rejection from `createGoal`), the assistant session, chat history, draft, `gatewaySessions` entry, and form state are left intact. The standard `showConnectionError("Failed to create goal", …)` toast surfaces the error message — the user can edit the proposal (e.g. pick a different workflow, fix the title) and click Accept again, or ask the assistant to revise. This avoids the prior failure mode where a 400 response (typically `Workflow not found: …` or `NO_WORKFLOWS_MSG`) would dismiss the assistant and force the user to start over with no context. Re-attempt sessions (with `reattemptGoalId`) go through the same accept handler and benefit from the same guarantee. Browser E2E coverage lives in [`tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts`](../tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts).

**Removed runtime concepts:**

- `.bobbit/config/workflows/<id>.yaml` is no longer read at runtime. The first-boot migration in `migrate-project-yaml.ts` folds any pre-existing files into the inline `workflows:` block and removes the directory.
- `defaults/workflows/*.yaml` no longer exists. There is no shipped-builtins location for workflows; `BuiltinConfigProvider.getWorkflows()` returns `[]`. The project assistant generates project-specific workflows from the MD guide on creation. See [No default workflow scaffold](internals.md#no-default-workflow-scaffold).

#### Workflow data model

```typescript
interface VerifyStep {
  name: string;
  type: "command" | "llm-review" | "agent-qa" | "subgoal";
  // For type: "command" — three exclusive shapes:
  component?: string; // Component name to resolve against components[]
  command?: string;   // Named command on that component (component.commands[command])
  run?: string;       // Free-form shell. May coexist with component (uses component cwd) or stand alone.
  // For type: "llm-review" / "agent-qa":
  prompt?: string;    // Review/QA prompt body (runtime tokens substituted by gate runner)
  role?: string;      // Reviewer role to spawn
  expect?: "success" | "failure";
  timeout?: number;
  phase?: number;     // Execution phase (default 0). See "Phased verification" below.
  optional?: boolean; // If true, step runs only when enabled per-goal. See "Optional verify steps".
  label?: string;     // Human-readable label for the toggle in goal creation UI.
  description?: string; // Tooltip text shown as ⓘ icon next to the toggle. For agent-qa steps, overridden when no component has config.qa_start_command set.
  // For type: "subgoal":
  subgoal?: { planId: string; title: string; spec: string; workflowId?: string; suggestedRole?: string; dependsOn?: string[] };
}

interface WorkflowGate {
  id: string;              // Unique within this workflow, e.g. "design-doc"
  name: string;            // Display name
  dependsOn: string[];     // Other gate IDs within THIS workflow (the DAG)
  content?: boolean;       // Whether this gate accepts markdown content
  injectDownstream?: boolean; // Whether passed content is injected into downstream agents
  metadata?: Record<string, string>; // Key-value metadata schema
  optional?: boolean;      // If true, team lead may signal with "N/A" (still must be signaled)
  manual?: boolean;        // If true, gate has no automated verify — user clicks "Mark passed" when ready
  verify?: VerifyStep[];   // Verification steps to run on signal
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  gates: WorkflowGate[];
  createdAt: number;
  updatedAt: number;
}
```

#### Inline workflow YAML format

Workflows live inside `project.yaml` under the top-level `workflows:` block (one entry per id). For `type: command` steps, three step shapes are accepted; there is **no `cwd:` field** on any step — working directory is structurally derived from the component, or it is the per-branch container root.

| Step shape | Working directory | Command source |
|---|---|---|
| `{ component, command }` | `<branch-container>/<component.repo>/<component.relative_path>` | `components[component].commands[command]` |
| `{ component, run }` | same as above | literal `run` string |
| `{ run }` | `<branch-container>` (per-branch worktree set root) | literal `run` string |

```yaml
# project.yaml excerpt
components:
  - name: myapp
    repo: "."
    commands: { build: npm run build, check: npm run check, test: npm test }

workflows:
  general:
    name: General
    description: Lightweight workflow for general-purpose goals.
    gates:
      - id: design-doc
        name: Design Document
        content: true
        inject_downstream: true
        verify:
          - { name: "Design review", type: llm-review, role: architect, prompt: "Review this design document." }

      - id: implementation
        name: Implementation
        depends_on: [design-doc]
        verify:
          # Component-linked, named command — resolves to components.myapp.commands.build:
          - { name: "Build myapp", type: command, component: "myapp", command: "build" }
          # Component-linked, free-form shell (cwd derived from component):
          - { name: "Custom thing", type: command, component: "myapp", run: "./scripts/special.sh" }
          - { name: "Code review", type: llm-review, phase: 1, prompt: "Review the changes on {{branch}} vs origin/{{master}}." }

      - id: ready-to-merge
        name: Ready to Merge
        depends_on: [implementation]
        verify:
          # Pure free-form (cwd = per-branch container root):
          - { name: "Branch pushed", type: command, run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
```

**Why structural references.** Editing `components[name].commands[name]` updates every workflow step that references it — no regeneration required for command edits. Validation at load time catches typos and stale references (component renamed, command removed) before the agent runs anything. Cleaner audit trail in gate output: shows the `(component, command)` pair, not just a literal shell string.

**Validator rejects** at workflow-load time:

- `type: command` with `command:` but no `component:`
- `type: command` with both `command:` and `run:`
- `component:` referencing an unknown component name
- a `(component, command)` pair where the component has no such command name

The validator does **not** reject template tokens in free-form `run:` or `prompt:` strings. Runtime context tokens (`{{branch}}`, `{{master}}`, `{{goal_spec}}`, `{{goal_title}}`, etc.) are necessary for workflows to function and are substituted by the gate runner before each step executes. Any other tokens (e.g. a stale `{{project.foo}}` left from a hand edit) just pass through to the shell as literal strings and fail at runtime the same way any other typo would.

#### Dependency DAG

Each gate's `dependsOn` lists sibling gate IDs that must pass before it can be signaled. This serves two purposes:

1. **Signal gating** — the server returns 409 if you try to signal a gate before its dependencies have passed.
2. **Context injection** — when an agent is spawned to produce work for a gate, the passed content of upstream gates is automatically injected into the agent's system prompt.

### Gate states

Each gate has a status: `pending`, `passed`, or `failed`.

- **`pending`** — initial state; the gate has not been signaled, or was reset after an upstream re-signal.
- **`passed`** — the gate was signaled and all verification steps succeeded (or no verification was defined).
- **`failed`** — the gate was signaled but verification failed.

When a previously-passed gate is re-signaled, all transitive downstream gates are cascade-reset to `pending`.

### Signaling a gate

Agents signal gates via the `gate_signal` tool (or `POST /api/goals/:id/gates/:gateId/signal`). A signal can include:

- **Content** — markdown text (for content gates like design docs)
- **Metadata** — key-value pairs (for metadata gates like test results)

Each signal is recorded in the gate's signal history with a unique ID, timestamp, and session reference.

**`gate_signal` is restricted to the team lead role at the tool-policy layer.** Every contributor role (`coder`, `test-engineer`, `reviewer`, `code-reviewer`, `security-reviewer`, `architect`, `spec-auditor`, `qa-tester`, `docs-writer`) declares `toolPolicies.gate_signal: never` in `defaults/roles/*.yaml`, so the tool-guard extension hard-blocks the call at runtime. Only the team lead has the goal branch checked out and can merge contributor work before verification runs from the goal-branch HEAD. Contributors hand off command-format / expect-failure gate inputs (raw shell command, `error_pattern` regex) via task `result_summary` for the team lead to attach when signalling. Invariant enforced by `tests/role-gate-signal-policy.test.ts`.

### Verification

Gates can define automated verification that runs when signaled:

- **Command** — runs shell commands, checks exit codes (e.g. `npm run check`)
- **LLM review** — spawns a sub-agent for qualitative review against a prompt
- **Agent QA** — spawns a test-engineer session that drives browser-based QA testing via the `/qa-test` skill
- **Combined** — mechanical + qualitative steps across phases

Verification is async. On signal, the verification status is `"running"`. On completion: the gate transitions to `"passed"` (all steps pass) or `"failed"` (any step fails, with details). A WebSocket event `gate_verification_complete` is emitted. If no verification is defined, the gate auto-passes.

#### Gate verification baselines

A gate's **baseline** is the git reference the reviewer diffs `HEAD` against when deciding what to comment on. Choosing the right baseline matters: too broad and the reviewer critiques upstream work that another agent already merged; too narrow and real goal-branch changes slip through unreviewed. It is also the single biggest source of false-positive "branch doesn't match design doc" findings when it drifts.

Gate verification is **baseline-aware** — different gate kinds compare against different git references:

| Gate kind              | Baseline                                  | How it's detected                     |
|------------------------|-------------------------------------------|---------------------------------------|
| Pre-implementation     | None — no diff is run                     | `content: true` AND no `depends_on` (see `isPreImplementationGate` in `src/server/agent/verification-logic.ts`) |
| Implementation & later | `origin/<primary>...HEAD`                 | All other verify-bearing gates        |
| `ready-to-merge`       | `origin/<primary>` via `git merge-base`   | Hardcoded in workflow YAML            |

**Why `origin/<primary>` and not local `<primary>`:** local refs are only as fresh as the last `git pull` on the host. Goal worktrees are created from `origin/<primary>`; verification must diff against the same anchor or it surfaces commits that have already been merged upstream as if they were goal-unique work. The harness runs `git fetch origin <primary>` before each review so `origin/<primary>` is current.

**Why pre-implementation gates skip the diff entirely:** a design-doc or issue-analysis gate, by workflow construction, runs before any code is committed. A branch with zero goal-unique commits is the normal expected state. Running a diff produces noise at best, and — if local `<primary>` is stale — false positives at worst. The reviewer prompt explicitly forbids `git diff` / `git log` for these gates.

**Primary branch detection:** the harness calls `detectPrimaryBranch(cwd)` from `src/server/skills/git.ts`, which uses `git symbolic-ref refs/remotes/origin/HEAD` with a `master` → `main` fallback. Never hardcode `"master"` in new gate logic — always resolve via this helper. The resolved baseline (e.g. `origin/main@abc1234`) is printed into every review prompt's "Signal Context" so failures are trivial to diagnose.

**Configurable integration target (`base_ref`):** the project-level `base_ref` setting lets workflows track a different branch (e.g. `develop`, a release branch) as the integration target. New built-in/seeded workflows substitute `{{baseBranch}}` — the bare branch name derived from `base_ref` (or `detectPrimaryBranch()` when unset). `{{master}}` is intentionally unchanged and continues to resolve via `detectPrimaryBranch()` regardless of `base_ref`, so existing user-authored workflows keep their meaning. Write `origin/{{baseBranch}}` explicitly when a remote ref is needed. Full semantics, validation rules, and error inventory: [design/base-ref.md](design/base-ref.md).

**How the harness enforces this per-gate:** reviewer/architect/spec-auditor role YAMLs contain a `{{REVIEW_CONTEXT}}` placeholder in their preamble. `buildReviewPrompt()` in `src/server/agent/verification-harness.ts` substitutes it with either (a) an "implementation review" block containing the concrete `origin/<primary>...HEAD` diff instructions and the resolved baseline SHA, or (b) a "pre-implementation" notice that explicitly forbids `git diff` / `git log` and reminds the reviewer that zero goal-unique commits is the normal state. The branching decision uses `isPreImplementationGate()` on the signalled gate — role YAMLs never hardcode diff commands.

**Migration note for user-authored workflows:** `.bobbit/config/workflows/<id>.yaml` is no longer read at runtime. Pre-existing files there are folded into `project.yaml::workflows` on first boot by `migrate-project-yaml.ts` and the directory is removed. The harness resolves `{{master}}` to the dynamically-detected primary branch, but the `origin/` prefix is now injected only by built-in workflow content. User-authored prompts that still say `{{master}}...HEAD` (without `origin/`) will diff against the local ref — rewrite to `origin/{{master}}...HEAD` to get the full fix. Pre-implementation gates automatically benefit regardless, because that logic lives in the harness's review-prompt builder.

#### Phased verification

Verification steps have an optional `phase` field (integer, default 0). Steps are grouped by phase and phases execute **sequentially** in ascending order. Within each phase, steps run in **parallel** (preserving pre-phase behavior for phase-0 steps).

If any step in a phase fails, all subsequent phases are skipped immediately and the gate fails. Skipped steps are recorded with `skipped: true` on `GateSignalStep` and output `"Skipped — earlier phase failed"`. The `skipped` flag persists to disk so the UI can distinguish skipped steps from passed/failed ones after page reload.

This avoids wasting expensive LLM reviews (phase 1) when cheap command checks (phase 0) have already failed. In the built-in `feature` and `bug-fix` workflows, type-checking and tests run at phase 0, while code quality and security reviews run at phase 1.

```yaml
verify:
  - name: "Type check"
    type: command
    run: "npm run check"
    # phase: 0 (default — runs first)

  - name: "Unit tests"
    type: command
    run: "npm run test:unit"
    # phase: 0

  - name: "Code quality review"
    type: llm-review
    phase: 1              # Only runs if all phase-0 steps pass
    prompt: |
      Review for correctness, completeness, and code quality.
```

**Backward compatibility:** Steps without a `phase` field default to phase 0. Existing workflows and snapshotted goal workflows continue to work — all steps execute in parallel as before.

**WebSocket events:** The server broadcasts `gate_verification_phase_started` before each phase begins, including the phase number and which step indices belong to it. Step-level events (`gate_verification_step_started`, `gate_verification_step_complete`) include an optional `phase` field. The goal dashboard uses these to show phase progression in real time.

#### Verification step artifacts

Step results can carry an optional `artifact` containing rich content that would be too large or structured for the short `output` summary field.

```typescript
interface GateSignalStep {
  name: string;
  type: string;
  passed: boolean;
  skipped?: boolean;         // true when step was skipped (optional not enabled, or earlier phase failed)
  output: string;            // Short summary
  duration_ms: number;
  artifact?: {
    content: string;         // Full report body
    contentType: string;     // "text/markdown" | "text/html"
    metadata?: Record<string, string>;
  };
}
```

**LLM review artifacts:** When an `llm-review` step completes, the verification harness stores the reviewer's full analysis as a `text/markdown` artifact. The `output` field retains the short summary, while the artifact preserves the complete review text that was previously lost.

**Size limit:** Artifact content is capped at 10 MB. Content exceeding this limit is truncated.

**Dashboard rendering:** The goal dashboard renders artifacts based on their content type:
- **`text/markdown`** — shown inline in a collapsible "Full Review" section below the step result.
- **`text/html`** — a "View Report" button opens the HTML content in a new browser tab via a Blob URL.
- **Metadata** — if `artifact.metadata` is present, key-value pairs are displayed alongside the content.

#### Optional verify steps

Verify steps can be marked `optional: true` with a human-readable `label` for the UI toggle. Optional steps are **disabled by default** — they only run when explicitly enabled for a specific goal. Steps can also include a `description` string, which renders as an ⓘ tooltip icon next to the toggle. For `agent-qa` steps, the toggle is automatically greyed out when no component in the project has `config.qa_start_command` set (driven by `isQaConfiguredOnAnyComponent()` via `GET /api/projects/:id/qa-testing-config`), and the tooltip is overridden with a configuration hint.

**How it works:**
- Goals carry an `enabledOptionalSteps: string[]` field listing the `name` values of optional steps that should be active.
- At goal creation, the UI shows a checkbox for each optional step in the selected workflow. The goal assistant can pre-toggle steps via the `options` parameter (comma-separated step names) in its `propose_goal` tool call.
- During verification, the harness checks each step before phase grouping. If `step.optional === true` and the step's `name` is not in the goal's `enabledOptionalSteps`, the step is skipped with `{ passed: true, skipped: true, output: "Skipped — not enabled for this goal" }`.
- Skipped optional steps do not block the gate and do not affect phase pass/fail logic.

**Example in workflow YAML:**
```yaml
verify:
  - name: "Type check"
    type: command
    run: "npm run check"

  - name: "QA testing"
    type: agent-qa
    phase: 2
    optional: true
    label: "Enable QA Testing"
    description: "Spawn a QA agent that builds the project, starts an ephemeral server, and drives a real browser through user scenarios."
    prompt: |
      You are performing QA testing for this goal...
```

#### `agent-qa` step type

The `agent-qa` verification step type spawns a test-engineer agent session that performs automated QA testing. It is designed for browser-based validation of user-facing changes, using the `/qa-test` skill to manage an ephemeral environment.

**How it works:**
1. The harness spawns a test-engineer session with the step's `prompt` (after variable substitution with `{{goal_spec}}`, `{{branch}}`, etc.) and upstream gate content injected as context.
2. The agent uses the `/qa-test` skill to stand up an ephemeral server, drive browser scenarios, and produce an HTML report.
3. The agent calls the `verification_result` tool to deliver structured results: verdict (pass/fail), summary, and optional HTML report.
4. If the agent includes `report_html`, the HTML is stored as the step's artifact with `contentType: "text/html"`.
5. If the agent goes idle without calling the tool, the harness sends a reminder prompt. If idle again, the step fails.

**Timeout:** Reads `qa_max_duration_minutes` from the owning component's `config:` map (default 10) plus a 5-minute buffer for setup/teardown. The verification harness resolves the component name via the step's `component:` field, falling back to the first component with `config.qa_start_command`, then a name-match against the project. See [docs/qa-testing.md](qa-testing.md) for the full per-component config layout.

**Retry logic:** Up to 3 attempts with backoff on transient failures (same pattern as `llm-review`).

**Test environments:** Respects `BOBBIT_LLM_REVIEW_SKIP` — when set, `agent-qa` steps auto-pass without spawning an agent.

**Resume support:** If the server restarts during an `agent-qa` step, the harness re-executes the step from scratch on the next verification cycle.

The `agent-qa` step typically runs at phase 2 in the `feature` and `bug-fix` workflows — after command checks (phase 0) and LLM reviews (phase 1) have passed. See [QA Testing](qa-testing.md) for project configuration and the `/qa-test` skill protocol.

#### `subgoal` step type

The `subgoal` verification step type spawns or resolves a child goal and waits for that child's `ready-to-merge` gate to pass before merging the child's branch into the parent locally. **The subgoal step IS the scheduler** — there is no background poll loop; the harness's existing phase-parallel run loop, plus a per-`rootGoalId` semaphore, is the entire orchestration mechanism. Full reference: [Nested Goals & DAG Subgoals](nested-goals.md).

**Descriptor shape:**

```yaml
verify:
  - name: "Implement v0.1"
    type: subgoal
    subgoal:
      planId: "v0.1"               # Stable idempotency key (string, unique within the gate)
      title: "v0.1 — basic CLI"    # Becomes the child goal's title
      spec: |                      # Becomes the child goal's spec markdown
        ## Overview
        ...
        ## Covers
        - "Basic CLI works end-to-end"   # Quote root acceptance criteria verbatim here
      workflowId: "feature"        # Optional — child's workflow id (defaults to parent's workflow if omitted)
      suggestedRole: "team-lead"   # Optional — hint for the child's lead role
      dependsOn: ["v0.0"]          # Optional — sibling planIds this step depends on; drives the
                                   #   Plan-tab DAG layout. Empty/omitted = parallel sibling.
                                   #   See nested-goals.md#declaring-dependencies.
```

**What it does** (in `runSubgoalStep`, `src/server/agent/verification-harness.ts`):

1. Resolve descriptor and look up an existing child by `(parentGoalId, planId)` using a tier-based preference: live in-progress > archived complete > live other > archived non-complete. A cached `active.steps[i].subgoal.childGoalId` pointer is sanity-checked and wiped if it points at an archived non-complete row.
2. If no live child resolves, spawn one via `goalManager.createGoal({ parentGoalId, ... })` and **immediately** stamp `spawnedFromPlanId = planId` on the new record — no awaits between createGoal and the stamp.
3. Acquire a permit on the per-`rootGoalId` semaphore (default 3, hard max 8); release in `finally`.
4. Wait for the child's `ready-to-merge` gate to pass, or for the child to be externally archived, or for the step to be cancelled.
5. On success: `goalManager.mergeChild(parent, child)` (local `git merge --no-ff` into the parent's branch, gated push to origin), then `teamManager.teardownTeam(child.id)` and `goalManager.archiveGoalAfterMerge(child.id)` — the latter stamps `state: "complete"` BEFORE flipping `archived: true` so a crash mid-archive can't strand the harness in the rescue path.
6. On merge conflict: `passed: false` with a manual-recovery directive in the output. The child is **NOT auto-archived** — its work is preserved for retry.

**Mid-flight progress is reflected in the parent's gate UI** via the resolved child's gates. The Plan tab DAG SVG renders nested sub-trees inline with chevron disclosure (depth cap 3) — clicking expands the child's plan inline; deeper levels surface via "Show N more…". Server-side `resolvePlanStepChild` and client-side `resolvePlanNodeChild` (`src/app/plan-node-state.ts`) implement the same tier preference and MUST agree on displayed state.

**Idempotency:** `planId` is the stable key. A re-entry of the same step (after restart, after a re-signal of the gate, after a parent re-render) finds the existing child via tiers 1/1.5/2 and reuses it; only an absent or invalidated child triggers a fresh spawn. The `spawnedFromPlanId` field is the persistence backbone — every spawn site (the harness, the `goal_spawn_child` REST endpoint, any future spawner) MUST stamp it synchronously immediately after `createGoal`.

**`goal-plan` gate freeze:** when the parent goal's `goal-plan` gate is signalled, the per-goal workflow snapshot's `executionGate.metadata.frozen = "true"`. Subsequent mutations to `execution.verify[]` route through the mutation classifier (`src/server/agent/plan-mutation.ts`); see [nested-goals.md — Mutation classifier](nested-goals.md#mutation-classifier).

### Gate Re-Signal Cancellation

When a gate is re-signaled while a previous verification is still running:
- The in-flight verification is cancelled — its reviewer sessions are terminated and its results are suppressed
- The cancelled signal's verification status is persisted as `"failed"` in the gate store
- Only the latest signal's verification determines the gate's pass/fail status
- The team lead is not notified about superseded verification results
- Command steps that are already running will complete but their results won't update gate status

This prevents reviewer agent proliferation when gates are re-signaled multiple times. The cancellation is triggered by `cancelStaleVerifications()` in `verification-harness.ts`, which is called before starting a new verification in the gate signal handler.

**Zombie detection:** If the previous verification's reviewer sessions have all died (crashed, timed out), the server detects this via `areVerificationSessionsAlive()` and auto-cancels the zombie verification instead of returning a 409 duplicate error. This prevents deadlocks where a stuck verification blocks all future signals.

**Manual cancellation:** A stuck verification can also be cancelled via `POST /api/goals/:goalId/gates/:gateId/cancel-verification`. The goal dashboard shows a Cancel button in the signal entry header when a verification is in "running" state. The endpoint is idempotent — calling it when nothing is running returns `{ cancelled: false }`.

### Tasks

**Tasks** are the operational work items within a goal. They track what needs to be done, who's doing it, and what state it's in.

Tasks have a state machine: `todo` → `in-progress` → `complete` | `skipped` | `blocked`.

Tasks can declare:
- **`dependsOn`** — other task IDs that must complete first (advisory, not enforced)
- **`workflowGateId`** — which workflow gate this task should produce output for
- **`inputGateIds`** — which workflow gate IDs to inject as context when prompting the assigned agent

#### Git handoff fields

Tasks carry structured git fields that enable local-only merges between agents, eliminating the need for PR-based inter-agent handoffs:

- **`baseSha`** — the commit the agent started from. Auto-populated by the system when a task is assigned to a spawned agent (resolved from `git rev-parse HEAD` in the agent's worktree).
- **`headSha`** — the tip of the agent's finished work. Set by the agent on completion via `task_update(head_sha="...")`.
- **`branch`** — the agent's working branch name. Auto-populated by the system from the `TeamAgent` record when a task is assigned.

These fields replace the old `commitSha` field, which was a single optional field with ambiguous semantics. The `baseSha` + `headSha` pair precisely defines the agent's changeset, and `branch` gives the team lead a direct local ref to merge from.

**Why local merges?** Agents work in co-located git worktrees on the same machine. Routing merges through origin (via PRs) added latency, created orphaned PRs, and introduced a fragile parsing step where the team lead had to extract branch names from free-text summaries. Local merges are instant and deterministic.

#### Git handoff lifecycle

| When | Who | What |
|------|-----|------|
| `team_spawn` | System | Auto-populates `baseSha` (HEAD at spawn) and `branch` (agent's branch name) on the `TeamAgent` record |
| Task assignment | System | Copies `baseSha` and `branch` from the `TeamAgent` to the assigned task |
| Agent works | Agent | Commits normally on its branch |
| Agent finishes | Agent | `task_update(state="complete", head_sha="$(git rev-parse HEAD)", result_summary="...")` |
| Team lead merges | Team lead | `git merge <task.branch>` locally — no remote fetch needed |
| Cleanup | Team lead | `team_dismiss` cleans up the agent's worktree |

Agents still push to origin as a safety net (crash recovery, inspection), but the merge path is purely local. The only PR in the workflow is the final goal-to-primary-branch PR for human review.

#### Multi-repo git handoff

In multi-repo projects, a single goal/session/staff worktree set spans multiple repos all sharing one branch name (`goal/<slug>-<id>`, `session-<slug>-<id>`, etc.). To track per-repo commit state, tasks carry a per-repo handoff map:

```typescript
// Multi-repo handoff (Phase 4):
task.gitHandoff: { [repoName]: { baseSha: string, headSha?: string, branch: string } }
```

The single-repo flat shape (`task.baseSha` / `task.headSha` / `task.branch` directly on the task) is preserved for back-compat — read helpers transparently project a single-repo task into the same shape so callers don't need to special-case mode.

Goal `git-status` and `git-diff` endpoints aggregate across all repos; the git-status widget shows per-repo collapsible sections. Cleanup tears down all per-repo worktrees and deletes all matching remote branches. PR/merge tooling (gh integration) operates per-repo; a multi-repo goal opens N PRs (one per repo with commits), all titled with the goal's branch.

Multi-repo invariant: all repos in a worktree set sit on the same branch name. There is no per-repo branch divergence within a goal.

Tasks and workflows are complementary layers:
- **Workflows** = quality layer (what gates to pass, in what order, with what verification)
- **Tasks** = operational layer (who's doing what, status tracking, assignment)

## Context injection

Context injection is the mechanism that feeds passed upstream gate content into agent prompts. This is how the design doc shapes the implementation, and the issue analysis feeds the reproducing test.

### At spawn time (`team_spawn`)

When spawning an agent via `team_spawn`, you can pass:

- **`workflowGateId`** (0 or 1) — declares which workflow gate the agent should produce output for. If `inputGateIds` is not set, the server auto-resolves inputs from the DAG's `dependsOn`.
- **`inputGateIds`** (0 or more) — explicit list of workflow gate IDs whose passed content to inject. Overrides automatic DAG resolution.

The resolved gate content is injected into the agent's **system prompt** under a `# Upstream Gates` section.

**Examples:**
```
# Auto-resolve from DAG (implementation depends on design-doc):
team_spawn(role="coder", task="Implement the fix", workflowGateId="implementation")

# Explicit inputs (reviewer needs more context than the formal DAG requires):
team_spawn(role="reviewer", task="Review the fix",
  workflowGateId="code-review",
  inputGateIds=["design-doc", "implementation", "test-results"])
```

### At prompt time (`team_prompt`)

When prompting an existing agent with new work via `team_prompt`, you can pass the same parameters:

- **`workflowGateId`** (optional) — what the agent should produce next
- **`inputGateIds`** (optional) — which gate content to inject as context

The resolved gate content is **prepended to the prompt message**, so the agent receives fresh context for the new task without needing to be respawned.

**Example:**
```
team_prompt(session_id="abc", message="Now review the implementation",
  workflowGateId="code-review",
  inputGateIds=["design-doc", "implementation", "test-results"])
```

### On gate signal (`gate_signal`)

When signaling a gate, the server checks that all upstream dependencies have passed. If any upstream gate has not passed, the signal is rejected with a 409 response listing the missing dependency.

## How it all fits together

Here's the typical flow for a team goal with a workflow:

```
1. User creates a goal with workflowId="feature" (or any workflow defined on the project)
   → Server snapshots the workflow into the goal
   → Gate states initialized: design-doc=pending, implementation=pending, ready-to-merge=pending

2. Team Lead reads the workflow, sees the gate DAG:
   design-doc → implementation → ready-to-merge

3. Team Lead creates tasks linked to workflow gates:
   task_create(title="Write design doc", type="custom",
     workflowGateId="design-doc")

4. Team Lead spawns an agent with gate context:
   team_spawn(role="coder", task="Write design doc",
     workflowGateId="design-doc")
   → Agent gets the goal spec in its system prompt (no upstream deps for first gate)

5. Agent produces the design, pushes its branch, marks task complete.
   Team Lead merges the branch and signals the gate:
   gate_signal(gate_id="design-doc", content="# Design\n\n...")
   → Server runs verification (if configured) → gate status: passed
   (Only the team lead can call gate_signal — see "Signaling a gate" above.)

6. Team Lead spawns next agent with upstream context:
   team_spawn(role="coder", task="Implement the design",
     workflowGateId="implementation")
   → Agent receives the passed design-doc content in its system prompt

7. Agent completes implementation, pushes branch, marks task complete.
   Team Lead merges the branch and signals the gate:
   gate_signal(gate_id="implementation")
   → Verification runs (npm run check + LLM review) → gate status: passed

8. Process continues through the DAG until all gates pass

9. team_complete() — server verifies all workflow gates have passed
```

## REST API reference

### Workflows

All mutations require `projectId` (400 otherwise). Reads without `projectId` return `[]` / 404. See [rest-api.md — Workflows](rest-api.md#workflows) for the full contract.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows?projectId=X` | List workflows for a project |
| `GET` | `/api/workflows/:id?projectId=X` | Get full workflow detail |
| `POST` | `/api/workflows?projectId=X` | Create a workflow |
| `PUT` | `/api/workflows/:id?projectId=X` | Update a workflow |
| `DELETE` | `/api/workflows/:id?projectId=X` | Delete (blocked if in-use by active goals) |
| `POST` | `/api/workflows/:id/clone?projectId=X` | Deep-copy a workflow with a new ID |

### Gates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/gates` | List all gates for a goal with status and definitions |
| `GET` | `/api/goals/:id/gates/:gateId` | Get gate detail (status, signals, definition) |
| `GET` | `/api/goals/:id/gates/:gateId/inspect` | Scoped gate data retrieval — content, verification, or signal history |
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate — triggers verification |
| `GET` | `/api/goals/:id/gates/:gateId/signals` | Get signal history for a gate |
| `GET` | `/api/goals/:id/gates/:gateId/content` | Get the current passed content of a gate |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |
| `GET` | `/api/goals/:id/verifications/active` | Get in-flight verification state (running steps, sessions) |

The gate list, gate detail, and task list endpoints support `?view=summary` for slim agent-facing responses. See [rest-api.md — Summary views](rest-api.md#summary-views-viewsummary) for response shapes and the [Gate inspect endpoint](rest-api.md#gate-inspect-endpoint) for the `/inspect` endpoint.

### Tasks (gate-linked)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/tasks` | Create task — accepts `workflowGateId` and `inputGateIds` |
| `PUT` | `/api/tasks/:id` | Update task — accepts `workflowGateId` and `inputGateIds` |

### Team (context injection)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/team/spawn` | Spawn agent — `workflowGateId` + `inputGateIds` for context injection |
| `POST` | `/api/goals/:id/team/prompt` | Prompt agent — `workflowGateId` + `inputGateIds` prepended to message |

## Storage

State is per-project — each project has its own copies of these files in `<project-root>/.bobbit/state/`. The server aggregates across all projects via `ProjectContextManager`.

| Location | What |
|---|---|
| `defaults/workflows/*.yaml` | Workflow templates (repo-local, version controlled) |
| `<project>/.bobbit/state/goals.json` | Goals with snapshotted workflows (includes `projectId`) |
| `<project>/.bobbit/state/gates.json` | Gate state and signal history |
| `<project>/.bobbit/state/tasks.json` | Tasks with workflow gate links |

## Key source files

| File | Purpose |
|---|---|
| `src/server/agent/workflow-store.ts` | YAML persistence for workflow templates |
| `src/server/agent/workflow-manager.ts` | Workflow CRUD, DAG validation, cloning |
| `src/server/agent/verification-harness.ts` | Async verification orchestration (command + LLM review + agent-qa, session lifecycle, artifact population) |
| `src/server/agent/verification-logic.ts` | Pure verification logic — variable substitution, phase grouping, optional step skipping, cache reuse, error pattern matching (unit-testable without server state) |
| `src/server/agent/gate-store.ts` | Gate state and signal history persistence |
| `src/server/agent/task-store.ts` | Task persistence with `workflowGateId` and `inputGateIds` |
| `src/server/agent/team-manager.ts` | Context injection via `buildDependencyContext()` |
| `src/server/agent/system-prompt.ts` | System prompt assembly including gate context |
| `defaults/tools/tasks/extension.ts` | Agent tools: `gate_signal`, `gate_status`, `gate_list`, `gate_inspect`, `task_create` |
| `defaults/tools/team/extension.ts` | Agent tools: `team_spawn`, `team_prompt` with context injection |
| `defaults/roles/team-lead.yaml` | Team Lead prompt template (workflow-aware) |
| `src/server/state-migration/seed-default-workflows.ts` | Internal workflow templates (used by per-component scaffolds; not seeded into new projects) |
