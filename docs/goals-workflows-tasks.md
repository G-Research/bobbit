# Goals, Workflows, Tasks & Gates

This document explains how Bobbit's goal orchestration system works — how goals, workflows, tasks, and gates relate to each other, and how context flows between agents.

## Concepts

### Goals

A **goal** is a unit of work with a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`). Every goal is scoped to a registered project via its `projectId` field (see [internals.md — Multi-project architecture](internals.md#multi-project-architecture)). Worktrees are created relative to that project's `rootPath` when worktree support is enabled.

`POST /api/goals` requires an explicit `projectId` in the request body. Headquarters is a valid built-in project with `projectId: "headquarters"`. `cwd`-based project inference has been removed — `cwd` is an execution directory validated after project selection, not a project identifier. A missing `projectId` returns **400 PROJECT_ID_REQUIRED**. See the [Project resolution contract](rest-api.md#project-resolution-contract) in the REST API docs.

Goals can run in **team mode**, where a Team Lead agent orchestrates multiple role agents (coders, reviewers, testers) working concurrently in their own worktrees. Goals carry an `autoStartTeam` flag (defaults to `true`). That flag is evaluated only during the goal creation / setup flow: after worktree setup completes, the server may call `teamManager.startTeam()` so no manual "Start Team" click is needed. The retry-setup handler also respects the same flag. Data-only no-worktree goals should normally use `autoStartTeam: false` unless the chosen workflow/team path is known to be git-independent.

Team worker capacity counts only live active worker sessions, not every historical row in `team-state.json`. Missing or terminated worker records are passively reaped before spawn-cap checks and during restart resubscribe, while explicit dismiss/completion paths still own archive and worktree cleanup. Verification-harness reviewer sessions are excluded from worker capacity; ordinary team-spawned workers with role `reviewer` still count as workers. See [internals.md — Worker liveness, spawn capacity, and stale reap](internals.md#worker-liveness-spawn-capacity-and-stale-reap).

`autoStartTeam` is **not** a standing restart policy. On gateway/server restart, Bobbit restores persisted active teams and re-subscribes their existing sessions, but it does not create a new Team Lead for an existing goal that has no active team. A goal created with `autoStartTeam: false`, or a goal whose team was later stopped with `teardownTeam`, remains teamless across restart; once setup is ready the UI should continue to offer manual "Start Team". If creation-time auto-start fails but the worktree succeeded, the error is logged and the worktree remains usable for that same manual start path.

### Per-goal worktree provisioning

Worktree setup for a goal is driven by **per-component / project setup commands** plus, for goal-scoped variation, **hierarchical goal metadata**.

- **Per-component setup** — each component's `worktree_setup_command` (project config) runs when a goal worktree is provisioned, identically for every goal in the project. Failures are non-fatal (logged; the worktree is still used). See [dev-workflow.md — Worktree branch namespaces](dev-workflow.md#worktree-branch-namespaces).
- **Goal-scoped variation** — when you need one goal to differ from another (enable a feature, seed an index, disable a tool/provider, reorder prompt sections), use **hierarchical goal metadata** and the `goalProvisioned` extension hook. Metadata is set at goal creation, inherited down the goal tree, and applied uniformly to every session (team lead, members, delegates, reviewers, nested sub-goals). See **[docs/design/goal-metadata.md](design/goal-metadata.md)** for the full design.

> **Legacy note — per-goal setup command removed.** An earlier design (PR #816) added bespoke per-goal `worktreeSetupCommand` / `worktreeSetupTimeoutMs` fields on `PersistedGoal`, plus matching REST, `propose_goal`, and goal-dialog affordances. That surface is **superseded by goal metadata and the `goalProvisioned` hook** and has been removed: the goal-store load path **drops** those legacy fields, the REST / `propose_goal` / UI inputs no longer exist, and posting them has no effect. Only the **component / project** `worktree_setup_command` (and its `worktree_setup_timeout_ms`) remains supported. To run goal-specific setup, declare metadata that an extension's `goalProvisioned` provider acts on — that hook fires at **every** worktree provisioning in the subtree (including pool claims), so filesystem treatments land on every agent and sub-goal worktree symmetrically, which the single per-goal command could not guarantee.

### Headquarters no-worktree goals

Headquarters can host explicit data-only goals without a git worktree. A goal created with `projectId: "headquarters"`, `worktree: false`, and a valid workflow snapshot can reach `setupStatus: "ready"` with no `branch`, `worktreePath`, or `repoPath`.

Supported no-worktree flows include goal listing, archive, gates, signals, tasks, and cost/search surfaces that do not require git state.

Git-dependent affordances are guarded instead of falling back to the server checkout. Goal git status, diff, commit history, PR status, PR merge, and child-goal merge return `409` with `code: "GOAL_GIT_UNAVAILABLE"` when the goal lacks branch/worktree data. The UI shows this copy and hides branch/merge/PR actions:

> This Headquarters goal runs in the server directory without a git worktree. Git branch, merge, and PR actions are unavailable.

### Workflows

A **workflow** is a reusable template that defines which gates a goal must pass, their dependency relationships (a DAG), and verification configs. Workflows live **inline in `project.yaml::workflows`** — the project assistant generates a bespoke block per project from [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md). The MD authoring guide is the single source of truth for workflow patterns; the runtime never reads it.

Workflows are **project-scoped only** — there is no system-scope or builtin layer and no config cascade. New normal projects do **not** receive any default seed; the project assistant designs workflows from the discovered components and commands, and a project may legitimately persist with zero workflows. Headquarters can own workflows too: `projectId=headquarters` reads the Headquarters `project.yaml::workflows` block from the aliased server config store. Every step references project-specific `(component, command)` pairs that have no meaning outside the owning project, so cascading would be ceremony around an empty upper layer. See [internals.md — Workflows are project-scoped only](internals.md#workflows-are-project-scoped-only), [No default workflow scaffold](internals.md#no-default-workflow-scaffold), and [Headquarters project](headquarters.md).

When a goal is created with a `workflowId`, the entire workflow is **snapshotted** into `PersistedGoal.workflow`. Later project-template edits do not change this frozen copy, so an active goal's requirements remain stable unless a caller explicitly replaces its snapshot. `POST /api/goals` can also receive an inline `workflow` object; that snapshot is used directly instead of resolving a project workflow template.

Goals without workflows still work fine — workflows are optional **at the data-model layer**. However, the standard goal-creation flow (the +New Goal picker and the goal assistant) requires either a linked project workflow or a valid inline workflow snapshot carried by the proposal. See [Default workflow resolution](#default-workflow-resolution) below for the resolution rules and the empty-workflows UX.

#### Replacing an active goal's workflow snapshot

`PUT /api/goals/:goalId/workflow` is the explicit escape hatch for changing an active goal's frozen requirements. It accepts a complete workflow definition rather than a partial patch, so it supports general changes: names and descriptions, gates, dependency edges, gate metadata, verification arrays, and step fields such as `timeout`. The workflow id cannot change. The server runs the same full workflow validation used by authoring before persisting anything; malformed fields, missing or cyclic dependencies, invalid component/command references, and non-positive or fractional timeouts are rejected.

Replacement also reconciles persisted gate state so it cannot disagree with the new DAG:

- unchanged gates retain their status, history, and verification cache;
- modified gates return to `pending`, retain their signal history for audit, and invalidate cached verification results;
- removed gates are dropped from gate state;
- added gates start `pending` with no signals.

A presentation-only reorder of unchanged gates does not reset them. If a changed or removed gate has verification running, the server rejects the whole replacement with `409 WORKFLOW_ACTIVE_VERIFICATION`; unrelated gate edits remain safe. The guard and persistence are one uninterrupted server continuation, preventing a verification from starting between the conflict check and mutation.

This endpoint is intentionally goal-local. Editing the project workflow template affects snapshots created by future goals, not goals already in progress. See the [REST contract](rest-api.md#goal-workflow-replacement) and [Changing a timed-out review allowance](#changing-a-timed-out-review-allowance) for the scoped UI built on these two write paths.

#### Default workflow resolution

Goal creation never assumes a workflow named `"general"` exists. The default-workflow rule, applied both server-side and UI-side (the goal preview panel and proposal toast), is:

1. **Inline `workflow` body supplied** — the public `POST /api/goals` route uses that workflow snapshot directly. The goal proposal UI sends this body field, not `workflowId`, when the draft carries a valid `inlineWorkflow`.
2. **Explicit `workflowId` supplied** — used as-is. If the id doesn't resolve in the project's `WorkflowStore`, the request fails with `Workflow not found: <id>`.
3. **No `workflowId` supplied** — the server falls back to **the first workflow in `workflowStore.getAll()`**. Order is the store's insertion order, which preserves the project-config cascade priority (project > user > defaults). The UI mirrors this: the workflow `<select>` is seeded to the first available id once `fetchWorkflows` resolves.
4. **No workflows at all and no inline workflow body** — `createGoal` throws `NO_WORKFLOWS_MSG` ("This project has no workflows configured…"). The UI never reaches submit in this state because the empty-workflows banner disables the Accept button (see below).

These defaults are final goal-creation and user-side acceptance safety nets. Proposal seed validation follows the same precedence for bespoke workflows: a structurally valid `inlineWorkflow` satisfies the workflow requirement, and any omitted, stale, or unknown `workflow` field is non-authoritative. Without a valid `inlineWorkflow`, `propose_goal` must still name an explicit project workflow ID when project workflows are resolvable and non-empty (see [Validating a proposed workflow at proposal time](#validating-a-proposed-workflow-at-proposal-time)).

No source file outside seed data, tests, and documentation may use the literal string `"general"` as a workflow default. This is enforced by the pinning test [`tests/no-general-workflow-default.test.ts`](../tests/no-general-workflow-default.test.ts), which scans `src/server/agent/` and `src/app/` for the string and rejects new occurrences (the role named `"general"` is explicitly allowlisted; it is unrelated to workflows). The pin exists because `"general"` was historically a magic default hardcoded in five places — UI dropdown initial state, accept handler fallback, `GoalManager` lookup, the goal-assistant prompt, and the re-attempt context builder — but workflows are now project-scoped with no system-level builtins, so there is no guarantee any given project has a workflow with that id. Hardcoding the string produced confusing `Workflow not found: general` errors on projects whose assistant had generated a bespoke workflow set with different names. The fix routes everything through "first workflow in store" instead, with the pinning test preventing reintroduction. See [Workflows](#workflows) for why workflows are project-scoped.

#### Goal creation in a zero-workflow project

Projects can legitimately exist with zero workflows (e.g. a freshly registered project whose assistant has not yet run). The goal-creation UX in that state:

- **Goal preview panel** (the +New Goal picker and the goal-assistant accept panel) renders an **empty-workflows banner** with a brief explanation and an **Open Project Assistant** button. The button calls `createProjectAssistantSession(project.rootPath, …)` from `src/app/dialogs.ts`, passing the linked project's id and existing name. The Accept button is disabled while the banner is visible, with a tooltip explaining why. A proposal with a valid `inlineWorkflow` is the exception: the inline snapshot supplies the workflow, so the banner stays hidden and Accept remains enabled.
- **While workflows are still loading** for the linked project, the panel shows a skeleton placeholder instead of either the dropdown or the banner. This prevents the banner from flickering on initial load before `ensureWorkflowsLoaded(projectId)` resolves.
- **Goal assistant LLM** receives guidance from `SessionManager._buildWorkflowList()` (via the exported `buildWorkflowListText()` helper) when the project has no registered workflows. Rather than forbidding `propose_goal` outright, the prompt steers the assistant toward the preferred path — scaffold a registered workflow first (open the project assistant from Settings → Components / the goal-panel banner) — but tells it that it MAY still propose a goal for a workflowless project provided it supplies a valid `inlineWorkflow` in the `propose_goal` call, which then becomes the authoritative workflow. Inline workflow is presented as a planning-stage escape hatch, not the default. This mirrors the UI guard (which keeps Accept enabled for a proposal carrying a valid inline workflow) and the goal-manager backstop, so all layers agree. The assistant's normal "pick the first listed workflow" guidance only applies when at least one registered workflow is present.

The per-project workflow availability is cached client-side (`_workflowCacheByProject` in `src/app/render.ts`) so switching back to a project that has workflows does not refetch unnecessarily. Browser E2E coverage lives in [`tests/e2e/ui/goal-empty-workflows-banner.spec.ts`](../tests/e2e/ui/goal-empty-workflows-banner.spec.ts).

To author workflows for a project, see [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md) and run the project assistant from Settings → Components.

#### Unified goal proposal tabs

Every goal proposal surface uses the same tabbed form rendered by `renderGoalForm()` in `src/app/proposal-panels.ts`. This includes assistant proposal panels, the `+ New Goal` flow, historical proposal revision views, and project-scoped goal creation. The unified form keeps proposal editing predictable: fields no longer move between surfaces, and accept/dismiss/create footer actions stay available regardless of the selected tab.

Guaranteed tab layout:

- **Goal** is the default active tab.
- **Goal**, **Workflow**, **Roles**, and **Metadata** are always visible for goal proposals.
- **Sub-goals** appears only when the Settings sub-goals flag is enabled.
- The footer is outside the tab panels, so submit/dismiss/create behavior is preserved across tabs.

Tab ownership is strict:

- The **Goal** tab owns title, project/directory, workflow picker shortcut, sandbox/team toggles, optional workflow-step toggles, and the spec editor/preview.
- The **Workflow** tab owns workflow inspection and per-goal workflow customization. When no workflows are available, it renders a read-only empty state instead of disappearing.
- The **Roles** tab owns role inspection and per-goal role customization. While roles are loading or unavailable, it renders loading/empty states instead of hiding the tab.
- The **Metadata** tab is the only place the key/value metadata editor renders. The main Goal tab must never contain `renderGoalMetadataEditor()`.
- The **Sub-goals** tab owns parent/child goal controls and is gated only by the system sub-goals setting.

Workflow and Roles draft state is also shared by the proposal form, not by the active DOM panel. Proposal-supplied `inlineWorkflow` and `inlineRoles` hydrate the Workflow/Roles tabs on every goal proposal surface, including the goal assistant / `+ New Goal`, project-scoped goal creation, re-attempt sessions, and historical revision tabs. Customizing a workflow forwards the inline workflow snapshot instead of `workflowId`; customizing a role forwards only the touched role entries as `inlineRoles`. These snapshots are goal-scoped and do not mutate project workflow or role definitions.

When a valid `inlineWorkflow` is active, the Goal and Workflow tab pickers both prepend a selected bespoke option labeled exactly `Bespoke (N Gates)`, where `N` is the current `inlineWorkflow.gates.length`. The label is derived from the draft, so adding or removing gates in the Workflow tab updates both pickers before acceptance. The inline workflow selection takes precedence over any project workflow id in the proposal fields; project workflow options remain available and keep the `<workflow name> (<gate count> gates)` label. Selecting or reverting to a project workflow clears the stale inline workflow draft so submission returns to `workflowId`.

Goal proposal tab state is scoped by proposal context. A newly opened proposal context starts on **Goal**, while returning to the same in-progress proposal revision can preserve its selected tab and inline Workflow/Roles draft. Historical revisions use their own session/revision-scoped state and render from the historical snapshot, not from the live proposal mirrors. The form also resolves the proposal's source project before loading Workflow/Roles or submitting, replacing any stale project id left by a previous proposal context so customizations and created goals apply to the correct project.

Metadata draft state is shared across tabs rather than stored in panel-local DOM. Seeded `propose_goal` metadata hydrates the Metadata tab, user edits survive tab switches, blank-key rows are dropped on submit, values are JSON-parsed where possible, and accepted/created goals persist the resulting `metadata` field. An empty metadata editor sends no override, preserving legacy goal records.

Browser coverage lives in [`tests/e2e/ui/goal-metadata.spec.ts`](../tests/e2e/ui/goal-metadata.spec.ts), [`tests/e2e/ui/goal-tabs-wiring.spec.ts`](../tests/e2e/ui/goal-tabs-wiring.spec.ts), [`tests/e2e/ui/goal-role-tabs-wiring.spec.ts`](../tests/e2e/ui/goal-role-tabs-wiring.spec.ts), and [`tests/e2e/ui/goal-proposal-workflow-tab.spec.ts`](../tests/e2e/ui/goal-proposal-workflow-tab.spec.ts). They pin the default Goal tab, required tab visibility, Metadata-tab-only editor placement, Sub-goals flag behavior, metadata edit persistence, inline Workflow/Roles customization wiring and persistence, bespoke inline workflow labels and submission, active-tab/draft isolation across contexts, historical revision isolation, and accepted-goal metadata persistence.

#### `createGoal` failure preserves the assistant

The goal-assistant accept flow (both the goal-preview panel handler and the `propose_goal` proposal-toast handler in `src/app/render.ts`) awaits `POST /api/goals` **before** tearing down any state. Disconnecting the remote agent, clearing the active assistant view, deleting the persisted draft, removing `gateway.sessionId`, and navigating to the goal dashboard all happen only on success.

On failure (any rejection from `createGoal`), the assistant session, chat history, draft, `gatewaySessions` entry, and form state are left intact. The standard `showConnectionError("Failed to create goal", …)` toast surfaces the error message — the user can edit the proposal (e.g. pick a different workflow, fix the title) and click Accept again, or ask the assistant to revise. This avoids the prior failure mode where a 400 response (typically `Workflow not found: …` or `NO_WORKFLOWS_MSG`) would dismiss the assistant and force the user to start over with no context. Re-attempt sessions (with `reattemptGoalId`) go through the same accept handler and benefit from the same guarantee. Browser E2E coverage lives in [`tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts`](../tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts).

#### Validating a proposed workflow at proposal time

The goal assistant emits a goal via the `propose_goal` tool. The default path names a registered project `workflow` ID plus optional `options` (comma-separated optional-step names). A proposal may instead carry a bespoke `inlineWorkflow` snapshot for a custom one-off workflow; registered workflows remain preferred by default because they keep project policy reusable and centrally inspectable. Because the assistant's prompt is seeded with the project's workflow list at session-creation time, that list can go stale — a project's workflows may be renamed or removed after the session started — and an LLM can hallucinate IDs outright. **Why this matters:** without validation a stale or invented workflow silently produces a broken proposal that only fails much later at goal-creation submit, by which point the assistant has already torn down its rationale. Worse, the `propose_goal` tool used to swallow the rejection and report a false `"Proposal submitted"` ack, so the agent never learned it needed to correct itself.

Validation now happens **at seed time**, before the server commits a revisioned proposal file. The `POST /api/sessions/:id/proposal/goal/seed` handler (which the tool calls to persist the draft) resolves the session's project workflows — mirroring goal creation: `configCascade.resolveWorkflows(projectId)`, falling back to the project context `workflowStore` — and runs `validateGoalProposalWorkflow()` **before** writing the file. Validation first honors a structurally valid `inlineWorkflow`: that snapshot satisfies the workflow requirement, takes precedence over an omitted or stale `workflow` field, and becomes the workflow used for optional-step checks. If `inlineWorkflow` is malformed, the seed fails with a structural validation error instead of falling through to misleading `MISSING_WORKFLOW` or `UNKNOWN_WORKFLOW` errors. An invalid workflow therefore produces no server-stamped `goal.md`, no `proposal_update {source:"seed"}`, and no proposal revision marker.

The attempted draft is still recoverable in the client because the `propose_goal` tool call input and its failed tool result live in the transcript. Bobbit uses that transcript data to render/open a failed, non-revisioned proposal snapshot for inspection.

Rejections are structured `400` JSON so the agent can self-correct:

- **`MISSING_WORKFLOW`** — `workflow` is omitted or blank, no valid `inlineWorkflow` is present, and the session has resolvable, non-empty project workflows. The body carries `availableWorkflows: [{id, name}]` and a `message` instructing the agent to re-call `propose_goal` with one of those IDs.
- **`UNKNOWN_WORKFLOW`** — `workflow` is named but is not a configured workflow ID, and no valid `inlineWorkflow` is present to take precedence. The body carries `availableWorkflows: [{id, name}]` and a `message` listing the valid IDs.
- **`UNKNOWN_OPTIONAL_STEP`** — one or more `options` names don't match an optional step of the selected workflow source. With `inlineWorkflow`, options are validated against optional `verify` steps in the inline snapshot; otherwise they are validated against the named project workflow. The body carries `validOptionalSteps: string[]` and a `message` listing them. Optional steps are matched **only by the canonical `step.name`** of `verify` steps with `optional: true` — the same identifier the verification runtime (`verification-logic.ts`) and the goal-creation UI key on (see [Optional verify steps](#optional-verify-steps)). Accepting an `optionalLabel`/`label` here would be a false success that later fails to enable the step.

**Validation is skipped** (no error) only when there is genuinely nothing to validate against:

- The session has no resolvable `projectId`, so project workflows can't be found.
- Workflow resolution itself is unavailable for the session/project context.
- The resolved workflow list is empty, preserving the zero-workflow state (see [Goal creation in a zero-workflow project](#goal-creation-in-a-zero-workflow-project)).

Ordinary proposal panels and final user-side Accept flows may still normalize stale empty/phantom workflow selections after workflows load. A failed workflow-validation proposal is the exception: the failed snapshot preserves the missing or unknown value so the UI does not hide the server rejection by selecting the first available workflow. Agent-side `propose_goal` seed validation must include an explicit valid `workflow` whenever project workflows are resolvable and non-empty, unless the proposal supplies a structurally valid bespoke `inlineWorkflow`.

On the tool side, `propose_goal` (in `defaults/tools/proposals/extension.ts`) surfaces a seed rejection as an `isError` tool result whose text is the server's `message` — including the missing/available-workflow list or valid optional-step names — so the agent sees the correction it needs. The other `propose_*` tools keep their log-and-ack behaviour; only `propose_goal` validates a workflow. The happy-path ack and the `__proposal_rev_v1__:<rev>` success contract are unchanged.

The client accepts both structured JSON error bodies and plaintext extension errors. Some tool runtimes preserve only the extension's text block, so the proposal renderer and session glue infer `MISSING_WORKFLOW` / `UNKNOWN_WORKFLOW` from phrases such as `Workflow is required...` or `Unknown workflow...`, and parse valid workflow IDs from `workflow IDs:`, `available workflows:`, or `one of these IDs:` segments. This keeps the failed proposal card and panel actionable even when `availableWorkflows` did not survive as JSON.

Coverage: [`tests/e2e/proposal-goal-workflow-validation.spec.ts`](../tests/e2e/proposal-goal-workflow-validation.spec.ts) (API), [`tests/proposal-tools-goal-validation.test.ts`](../tests/proposal-tools-goal-validation.test.ts) (tool-level), [`tests/proposal-renderer-failed.spec.ts`](../tests/proposal-renderer-failed.spec.ts) (renderer), [`tests/e2e/ui/failed-goal-proposal-ux.spec.ts`](../tests/e2e/ui/failed-goal-proposal-ux.spec.ts) (browser UX), and [`tests/e2e/ui/goal-proposal-workflow-tab.spec.ts`](../tests/e2e/ui/goal-proposal-workflow-tab.spec.ts) (bespoke inline workflow proposal UX).

#### Failed workflow-validation proposal UX

A failed `propose_goal` workflow validation is not treated like a successful proposal. The chat tool card renders with a failed visual state, displays the server rejection message, and keeps an **Open proposal** action so the user can inspect what the agent attempted.

Opening that card creates a failed, non-revisioned goal proposal snapshot from the tool-call input plus the parsed workflow error metadata. The goal proposal panel then:

- shows the workflow error in the bottom-left footer/status area;
- marks the workflow selector invalid and keeps the missing/unknown attempted value visible (`Select workflow` for missing, `Unknown workflow: <id>` for unknown);
- disables **Create Goal** until the user selects a configured workflow;
- clears the validation error only after the selected workflow ID is known for the linked project.

This is deliberately different from ordinary phantom-workflow normalization. Auto-selecting the first workflow would make the failed draft look valid and would obscure why the server rejected the agent's proposal.

The failed metadata lives in the in-memory `ProposalSlot.workflowValidationError`, not in `goal.md`, because no server-stamped draft exists for the rejected seed. Reload and reconnect recover the same state from durable transcript data: `_checkToolProposals` remembers the failed tool call input, `_checkProposalToolResult` re-parses the failed result, and the **Open proposal** event carries `workflowValidationError` for no-rev failed snapshots. A later successful `propose_goal` retry has a real revision marker and server `proposal_update`; opening that successful card renders the normal rev-backed proposal with an enabled create flow. Historical scans keep the failed no-rev metadata tied to its own card so it does not poison a later successful retry.

#### Phantom workflow IDs in the proposal panel

A second failure mode lived in the proposal panel's workflow `<select>` (`src/app/proposal-panels.ts`). The dropdown binds its value to the proposed workflow ID. When that ID isn't among the project's loaded workflows, no `<option>` matches, so the browser visually falls back to the first option while the form state still holds the **phantom** (not-in-list) value. Re-selecting the displayed option fires no `change` event, so the phantom persists and Create submits the invalid workflow — the dropdown appears to "have no effect."

The fix is `normalizeWorkflowSelections()`: once the workflow list is loaded, ordinary empty or phantom selections reset to the first available ID so the rendered option and the underlying state always agree. A value already present in the list is never clobbered. Failed workflow-validation proposals opt out through `shouldPreserveFailedWorkflowSelection()` so the invalid state remains visible until corrected. Normalization runs from the cached and async paths of `ensureWorkflowsLoaded`, from `syncProposalFormState()` (the inline goal-proposal panel's `_proposalWorkflowId`), and from `setSelectedWorkflowId()` (the assistant preview panel's `_selectedWorkflowId`). Because workflows load asynchronously, the post-load pass is the safety net for a phantom ID present before the list arrived; stale async loads for a project the user has navigated away from never clobber the active selection. Browser E2E for both panels: [`tests/e2e/ui/goal-proposal-invalid-workflow.spec.ts`](../tests/e2e/ui/goal-proposal-invalid-workflow.spec.ts).

**Removed runtime concepts:**

- `.bobbit/config/workflows/<id>.yaml` is no longer read at runtime. The first-boot migration in `migrate-project-yaml.ts` folds any pre-existing files into the inline `workflows:` block and removes the directory.
- `defaults/workflows/*.yaml` no longer exists. There is no shipped-builtins location for workflows; `BuiltinConfigProvider.getWorkflows()` returns `[]`. The project assistant generates project-specific workflows from the MD guide on creation. See [No default workflow scaffold](internals.md#no-default-workflow-scaffold).

#### Workflow data model

```typescript
interface VerifyStep {
  name: string;
  type: "command" | "llm-review" | "agent-qa" | "human-signoff";
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
  optionalLabel?: string; // Human-readable label for the goal-creation toggle.
  label?: string;     // Human-signoff card title only (type: "human-signoff").
  description?: string; // Tooltip text shown as ⓘ icon next to the toggle. For agent-qa steps, overridden when no component has config.qa_start_command set.
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
          - { name: "Code review", type: llm-review, phase: 1, prompt: "Review the changes on {{branch}} vs origin/{{baseBranch}}." }

      - id: ready-to-merge
        name: Ready to Merge
        depends_on: [implementation]
        verify:
          # Pure free-form (cwd = per-branch container root):
          - { name: "Branch pushed", type: command, run: "git push origin {{branch}}:refs/heads/{{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
```

**Why structural references.** Editing `components[name].commands[name]` updates every workflow step that references it — no regeneration required for command edits. Validation at load time catches typos and stale references (component renamed, command removed) before the agent runs anything. Cleaner audit trail in gate output: shows the `(component, command)` pair, not just a literal shell string.

**Validator rejects** at workflow-load time:

- `type: command` with `command:` but no `component:`
- `type: command` with both `command:` and `run:`
- `component:` referencing an unknown component name
- a `(component, command)` pair where the component has no such command name

The validator does **not** reject template tokens in free-form `run:` or `prompt:` strings. Runtime context tokens (`{{branch}}`, `{{baseBranch}}`, `{{goal_spec}}`, `{{goal_title}}`, etc. — `{{master}}` is still accepted as a legacy alias) are necessary for workflows to function and are substituted by the gate runner before each step executes. `{{baseBranch}}` is a built-in bare branch name derived from configured `base_ref` (`origin/master` → `master`), falling back to the detected primary branch when unset. `{{project.*}}` is unsupported in verification templates; use structural `{ component, command }` references instead of project-variable command lookups.

#### Workflow editor authoring

Settings → Workflows exposes the same schema as inline workflow YAML. Authors can edit gate `id`, `name`, `dependsOn`, `content`, `injectDownstream`, `optional`, `manual`, and `metadata`; verification step `type`, command/run source, prompt, role, component, timeout, phase, description, optional toggle, and `optionalLabel`; and `human-signoff`-specific `label` and `prompt` fields.

Timeout authoring is type-aware and leaving the field empty does not serialize a default. Command steps show the generic 300-second default and the 1200-second component `command: unit` exception. `llm-review` shows the 1200-second per-active-turn default. `agent-qa` explains that its omitted value is the greater of 1200 seconds and component `qa_max_duration_minutes + 5m`. Review-agent help also states that a positive explicit value may be shorter and that provider backoff is excluded.

The editor validates the same user-facing constraints before save: `human-signoff` steps require a card title and prompt; named `command` steps require a component; review-agent timeouts are positive whole seconds with a minimum of one second; and stale hidden fields are stripped when a step changes type so saved workflows use the canonical YAML shape.

#### Dependency DAG

Each gate's `dependsOn` lists sibling gate IDs that must pass before it can be signaled. An empty list is explicit and valid: it makes the gate an independent root/parallel gate. The workflow editor preserves `dependsOn: []` instead of silently converting it into a dependency on the previous gate.

This serves two purposes:

1. **Signal gating** — the server returns 409 if you try to signal a gate before its dependencies have passed.
2. **Context injection** — when an agent is spawned to produce work for a gate, the passed content of upstream gates is automatically injected into the agent's system prompt.

### Gate states

Each gate has a status: `pending`, `passed`, `failed`, or `bypassed`.

- **`pending`** — initial state; the gate has not been signaled, or was reset after an upstream re-signal or explicit reset.
- **`passed`** — the gate was signaled and all verification steps succeeded (or no verification was defined).
- **`failed`** — the gate was signaled but verification failed.
- **`bypassed`** — a human overseer forced the gate past verification without the work passing. It is deliberately a distinct state from `passed` so the override is auditable and visually obvious. See [Human gate bypass](#human-gate-bypass).

When a previously-passed gate is re-signaled, all transitive downstream gates are cascade-reset to `pending`.

### Per-gate actions in the goal status widget

The chat-header `<goal-status-widget>` is the compact workflow surface for the current goal. Its popover lists every gate. The actions shown on a row depend on its status:

- **View** (`passed` rows only) — opens the goal dashboard Gates tab for that gate and expands the gate detail section.
- **Reset** (`passed` rows only) — asks for confirmation, then clears the selected gate and downstream dependent gates back to `pending`.
- **Bypass** (`pending` and `failed` rows only) — the human-only override that forces the gate to the `bypassed` state. It is never shown on `passed`, `running`, or already-`bypassed` rows. See [Human gate bypass](#human-gate-bypass).

So `passed` rows show View/Reset, `pending`/`failed` rows show Bypass, and `running` rows show no actions. This keeps View/Reset focused on completed approvals that can be inspected or invalidated, while exposing the bypass override only where it is meaningful.

#### Dashboard focus route

The View action navigates with hash-query state so browser Back and reload can restore the focused gate:

```text
#/goal/<goalId>?tab=gates&gate=<gateId>&signal=<signalId|latest-passed>
```

The dashboard reads `tab`, `gate`, and `signal` from the route. It switches to the Gates tab, expands the gate row, highlights it briefly, scrolls it into view, and expands/focuses the requested signal entry. `signal=latest-passed` is a convenience token used when the caller does not already know the concrete latest passed signal; after gate data loads, the dashboard replaces it with the resolved signal id when possible.

Manual gate or signal expansion on the dashboard updates the same route state. This makes focused dashboard views shareable and resilient enough for reload/back navigation without introducing separate UI state storage.

#### Reset invalidation semantics

`POST /api/goals/:id/gates/:gateId/reset` resets the selected gate plus every transitive downstream dependent discovered from the workflow DAG (`dependsOn`), not from display order. Independent gates are untouched.

Each affected `GateState` also receives `verificationCacheInvalidatedAt`, set to the reset timestamp. Verification cache selection treats that timestamp as a boundary: passed step results from signals at or before the marker are ineligible for same-commit reuse, while later signals remain eligible. This makes the next post-reset signal run active verification steps normally even when the commit SHA is unchanged.

Reset is safe to repeat:

- gates already `pending` stay pending and are reported as unchanged;
- failed downstream gates are also reset to `pending`, because their result may have depended on the invalidated upstream output;
- active verifications for any affected gate are cancelled before statuses are rewritten;
- verification-step cache eligibility is invalidated for both changed and already-pending affected gates;
- only gates whose stored status actually changes are counted in `changedGateIds`.

The endpoint broadcasts `gate_status_changed` for affected gates and a `gate_reset` summary event so gate consumers refresh promptly.

#### Reset-driven goal reopening

A human gate reset creates new workflow work even when the team previously finished. For an active goal in `complete`, Bobbit therefore persists the goal as `in-progress` before resetting the selected and downstream gates. Keeping it complete would hide the new pending work from team-lead no-workers, workers-idle, stuck-sweep, and restart recovery.

This transition reuses the existing lifecycle rather than starting over. The goal ID, workflow snapshot, tasks, gate history, branch/worktree and repository metadata, and PR association remain intact. When the completed team's runtime still exists, its team record and lead session are preserved too. Reset reinstalls that lead's event subscription, clears completion-era nudge bookkeeping, and starts a fresh base-delay nudge cycle when the lead is already idle; it does not recreate dismissed role workers or replace the lead.

A prior explicit `teardownTeam` is authoritative absence, not a broken completed team. Reset still reopens the goal and invalidates its gates, but it does not create a replacement team, lead, subscription, or timer. This keeps `autoStartTeam` a creation-time policy rather than an implicit resume policy; the operator can start a new team separately if the reopened work needs one.

Only an active `complete` goal is reopened. Active `todo`, `in-progress`, and scheduler-managed `blocked` states are preserved. Archived, shelved, and paused goals return `409` without gate mutation, notification, or team rearm; the operator must explicitly restore their lifecycle first. Dormant intent takes precedence even if a stored goal also says `complete`.

The lifecycle outcome is additive in both the reset response and `gate_reset` WebSocket event:

```json
{
  "reopen": {
    "reopened": true,
    "previousState": "complete",
    "state": "in-progress"
  }
}
```

`reopen` is returned for every successful reset. A new retry after a fully finalized transition reports `reopened: false` with `previousState` and `state` both `in-progress`. Rearming is likewise one-shot: retries do not replace subscriptions, duplicate timers, emit another `goal_state_changed`, or enqueue another reset notice when no gate status changed. The recovery case is intentionally distinct: if runtime rearm or intent cleanup failed, the retained transaction reports its original `complete` → `in-progress` outcome when the same reset request resumes it.

On a real transition, global `goal_state_changed` makes sidebar, dashboard, widget, and other-tab goal caches refresh from the goal-list API. The status widget treats its lifecycle field as a reversible mirror, not a one-way completed latch. It watches the authoritative app goal cache while open, so completion performed by another agent or tab appears without remounting; on reset it applies the response and affected pending gates immediately, then refreshes goal, gate, and active-verification state. Its own goal-scoped viewer subscription performs the same authoritative refresh on external `goal_state_changed`, including reopen when no active chat socket is mounted.

See [REST API — Gate reset endpoint](rest-api.md#gate-reset-endpoint) for the full transaction, response, and `409` shapes, and [WebSocket Protocol](websocket-protocol.md) for event fields.

#### Durability and completion races

The lifecycle transition and gate invalidation span separate project stores, so they are coordinated by a project-scoped write-ahead intent. The intent is persisted before either store changes; strict, fail-loud writes then persist the goal first and gate reset second. A boot-time coordinator replays any retained intent before team restoration and boot-resume scans, making crashes after intent, goal, gate, or finalization persistence converge on `in-progress` plus pending gates. The ordering exists to prevent the unsafe durable state `complete` plus pending gates, which would suppress recovery nudges.

A synchronous gate-write failure is compensated by strictly restoring the prior goal state and clearing the intent. Runtime side effects, broadcasts, and lead notification happen only after the durable reset. If compensation cannot be persisted, the intent stays available for boot replay rather than hiding a partial commit. If the reset committed but an existing team's unsubscribe or event-subscription callback fails, the API returns a retryable durable-reset error and retains the intent; a repeated request retries rearm without installing partial or duplicate runtime state.

Completion has the opposite interleaving hazard. `completeTeam` checks workflow truth before dismissing workers, but worker dismissal is asynchronous and a human reset can win during those awaits. It therefore re-reads every required gate immediately after dismissal and before writing `complete`. If any gate became unresolved, completion aborts, leaves the goal `in-progress`, and rearms the lead runtime so the reset work remains nudge-eligible.

Dormant lifecycle changes win during recovery. Archived, shelved, or paused goals are never reopened by an old reset intent. See [REST API — Durable reset transaction](rest-api.md#durable-reset-transaction) for the failure codes and retry contract.

#### History and audit preservation

Reset invalidates the current pass state and old cache eligibility; it does **not** delete audit data. Gate signal history, verification output, content, content version, and metadata remain in the gate store. Consumers must treat `status` as the source of truth for whether preserved content is currently approved. In other words, a reset gate may still have historical content attached, but downstream context injection and user trust decisions should require the gate to be `passed` again.

`human-signoff` steps are never reused from cache, regardless of reset state. Prior human approvals stay inspectable in signal history, but every re-signal must obtain a fresh human decision.

After a fresh post-reset signal passes, normal cache behavior resumes from that new signal forward: later non-reset re-signals at the same commit may reuse the post-reset passed step output and show `[cached from prior signal]` for reused non-human steps.

#### Team lead notification

After a reset changes at least one gate or reopens the goal, Bobbit sends the live team lead a system-origin message. The message names:

- the goal lifecycle outcome, including `complete` → `in-progress` when reopened;
- the selected gate that was reset;
- downstream dependent gates invalidated by the DAG traversal;
- which gates had passed state cleared;
- which affected gates were already not passed;
- why downstream implementation, review, or verification work may need to be revisited.

If the team lead is streaming, the server delivers the notice as a live steer; otherwise it queues it as a steered prompt. The reset response includes `teamLeadNotified` so callers can tell whether a live lead received the message. Goals without an active team lead still reset normally. An exact no-op retry sends no duplicate notice.

#### Usage and test coverage

Use Reset when an approved upstream artifact is no longer trustworthy and downstream work may have been built on it. Use a new gate signal instead when the gate has fresh replacement evidence ready to verify immediately.

Coverage lives in:

- [`tests/gate-store-logic.test.ts`](../tests/gate-store-logic.test.ts) — gate-store reset and dependency behavior.
- [`tests/e2e/gate-reset-api.spec.ts`](../tests/e2e/gate-reset-api.spec.ts) — DAG invalidation, idempotency, preserved history/content, active verification cancellation, sandbox denial, team lead notification.
- [`tests/e2e/ui/goal-status-widget.spec.ts`](../tests/e2e/ui/goal-status-widget.spec.ts) — passed-gate View/Reset controls, dashboard focus route reload/back behavior, confirmation guard, widget/sidebar/dashboard refresh, and team lead message visibility.

### Human gate bypass

A gate can be **bypassed**: a human overseer forces it past verification when an agent reports that a verification step is genuinely impossible to satisfy (for example, a check that cannot pass in the current environment, or a requirement that has been overtaken by a deliberate scope decision). Bypass exists so a goal is not permanently stuck behind a gate that no amount of agent work can clear — while keeping the escape hatch firmly in human hands.

#### Why this is human-only, and how that is enforced

The whole point of a gate is to stop low-quality or unverified work from flowing downstream. If an agent could clear its own gate, the gate would be worthless. Bypass is therefore an **honesty-system override reserved for the human overseer** — consistent with the rest of the gate UI, which trusts the gateway token rather than modeling per-user identity.

This is defended in two layers, in order of importance:

1. **Non-advertisement (primary).** The bypass capability is *never* exposed to agents. There is no MCP/agent tool for it, and it is never mentioned in any agent-facing prompt, tool description, or injected context. An agent has no way to learn the capability exists from inside its own context.
2. **Runtime guard (backstop).** The bypass endpoint requires `isInitiatedByHuman: true` in the request body and refuses anything else with a 400 explaining that bypass is for human use only. Sandbox-scoped agent tokens are rejected with 403 before the guard is even reached.

Because there is no identity model yet, the endpoint does not (and cannot) cryptographically prove a human sent the request. The trust model is honesty plus non-discoverability, not authentication. This is intentional and matches the existing reset / sign-off endpoints.

#### What a bypass records

Bypass is auditable like any other gate event. `POST /api/goals/:id/gates/:gateId/bypass` appends a **synthetic audit signal** to the gate's signal history (`sessionId: "human-bypass"`, `metadata.bypass: "true"`) capturing:

- **`whyBypassed`** — required free-text justification, persisted verbatim;
- **`whoAmI`** — required free-text label naming who performed the bypass (not verified — honesty system);
- **`bypassedAt`** — server timestamp.

The gate status is then set to `bypassed`, persisted, and a `gate_status_changed` event is broadcast on the goal WebSocket. The team lead session, if live, is notified with a system-origin message naming the gate, the `whoAmI` label, the reason, and a reminder that the goal still needs explicit human confirmation before it can complete. See [rest-api.md — Gate bypass endpoint](rest-api.md#gate-bypass-endpoint) for the full request/response contract and error matrix.

#### Dependency vs. completion semantics

A bypassed gate is treated differently depending on what is being decided:

- **Downstream dependency ordering — satisfied.** A bypassed upstream gate unblocks its dependents exactly as a passed gate would, so the rest of the workflow can proceed. Without this, bypassing one stuck gate would still leave everything behind it blocked, defeating the purpose.
- **Downstream context injection — NOT injected.** Only `passed` gates with `injectDownstream` inject their content into downstream agents' prompts. A bypassed gate has no verified content to stand behind, so nothing is injected. Dependents proceed, but they do not receive bypassed-gate content as trusted upstream context.
- **Goal completion — still blocked until a human confirms.** `team_complete` (the agent/MCP path) refuses to finish a goal that has any bypassed gate, with a distinct error (`Cannot complete: N gate(s) were bypassed and require human confirmation`). An agent therefore cannot auto-finish a goal that was only resolved via a human override.

#### Confirming completion despite bypassed gates

The explicit human path to finish such a goal is `POST /api/goals/:id/team/complete` with `{ confirmBypassedGates: true }`. This reuses the completion route's options (`completeTeam({ allowBypassedGates: true })`) rather than adding a separate endpoint. Like bypass itself, this confirmation is human-only: sandbox-scoped tokens are rejected with 403, so an agent cannot confirm its way past a bypass. In the UI a **Confirm completion** button appears only when bypassed gates exist.

#### Resetting a bypassed gate

Bypass is reversible. Resetting a bypassed gate (via the reset endpoint or the widget's Reset action) returns it to `pending` and clears it from the downstream/completion calculus, just like resetting a passed gate. The bypass audit signal remains in history for the record.

#### UI differentiation

The override is made visually unmistakable so a bypass is never mistaken for a clean pass:

- **Bypass button** — the `<goal-status-widget>` popover shows a destructive-styled **Bypass** action only on gates that have *not* yet passed (pending/failed rows). It is never offered on a passed or already-bypassed gate. Clicking it opens an inline form collecting `whyBypassed` (multi-line) and `whoAmI` (text), then calls the endpoint with `isInitiatedByHuman: true`; endpoint errors surface inline like the reset error row.
- **Per-gate icon** — a bypassed gate renders a red warning/exclamation triangle (distinct from the green check used for passed), with the `whoAmI` and `whyBypassed` available on the row.
- **Differentiated progress badge** — `renderGateProgressBadge` (the chat-header pill and the sidebar goal badge both call it) counts bypassed gates *toward the numerator* so a fully-resolved-via-bypass goal still reads `(4/4)`, **but turns the whole badge red and appends a trailing `!`** (e.g. red `(4/4)!`) to signal this is not a clean pass. The dropdown's header badge inherits the same treatment. The badge reads `bypassed` / `bypassedCount` from the cached `GateStatusSummary`.

#### Coverage

- [`tests/gate-dependency-enforcement.test.ts`](../tests/gate-dependency-enforcement.test.ts) — a bypassed upstream gate unblocks dependents like a passed one.
- [`tests/e2e/gate-bypass-api.spec.ts`](../tests/e2e/gate-bypass-api.spec.ts) — endpoint happy path, audit-signal persistence, broadcast, guard/validation errors, sandbox denial, reset-to-pending, and completion gating.
- [`tests/e2e/ui/gate-bypass.spec.ts`](../tests/e2e/ui/gate-bypass.spec.ts) — Bypass button visibility, why/who form submission, bypassed row state, red `(N/N)!` badge, and persistence across reload.

### Signaling a gate

Agents signal gates via the `gate_signal` tool (or `POST /api/goals/:id/gates/:gateId/signal`). A signal can include:

- **Content** — markdown text (for content gates like design docs)
- **Metadata** — key-value pairs (for metadata gates like test results)

Each signal is recorded in the gate's signal history with a unique ID, timestamp, and session reference.

**`gate_signal` is restricted to the team lead role at the tool-policy layer.** Every contributor role (`coder`, `test-engineer`, `reviewer`, `code-reviewer`, `bug-hunter`, `security-reviewer`, `architect`, `spec-auditor`, `qa-tester`, `docs-writer`) declares `toolPolicies.gate_signal: never` in `defaults/roles/*.yaml`, so the tool-guard extension hard-blocks the call at runtime. Only the team lead has the goal branch checked out and can merge contributor work before verification runs from the goal-branch HEAD. Contributors hand off command-format / expect-failure gate inputs (raw shell command, `error_pattern` regex) via task `result_summary` for the team lead to attach when signalling. Invariant enforced by `tests/role-gate-signal-policy.test.ts`.

### Verification

Gates can define automated verification that runs when signaled:

- **Command** — runs shell commands and checks exit codes (e.g. `npm run check`). Command steps default to a 300s timeout unless the workflow sets `timeout`; component-linked `command: unit` steps default to 1200s because the full unit suite can exceed the generic shell default under contention.
- **LLM review** — spawns a sub-agent for qualitative review against a prompt. An omitted timeout gives each active attempt, reminder, retry, restart continuation, and recovery turn a fresh 1200-second allowance.
- **Agent QA** — spawns a test-engineer session that drives browser-based QA testing via the `/qa-test` skill. Its omitted per-turn allowance is the greater of 1200 seconds and the component QA duration plus five minutes.
- **Review-agent override** — for `llm-review` and `agent-qa`, an explicit positive `timeout` is authoritative even below 1200 seconds; the minimum is one second. Provider overload/rate-limit backoff is excluded from the active-turn allowance.
- **Human sign-off** — parks the gate on a deferred resolver until a person approves or rejects via the UI (see [Human sign-off steps](#human-sign-off-steps))
- **Combined** — mechanical + qualitative steps across phases

Verification is async. On signal, the verification status is `"running"`. On completion: the gate transitions to `"passed"` (all steps pass) or `"failed"` (any step fails, with details). A WebSocket event `gate_verification_complete` is emitted. If no verification is defined, the gate auto-passes.

#### Review-agent timeout semantics

Review-agent `timeout` values measure **active turns**, not total verification wall time. Each from-scratch attempt, reminder, session auto-retry, restart continuation/reminder, step-level retry, and same-session process resurrection receives a fresh full resolved allowance after streaming begins. A streaming turn waits for that allowance; a genuinely idle turn without `verification_result` may enter reminder/recovery immediately.

Setup, readiness, prompt transport, and provider backoff do not consume the allowance. Fixed operational waits also remain separate: 10 seconds for restart streaming settle, 15 seconds for reminder/resurrection streaming settle, 20 seconds for late-verdict arrival, and 30 seconds for successful-result terminal flush. Retryable error handling waits up to 75 seconds for an ordinary retry turn to start or 330 seconds for provider backoff; the newly streaming turn then receives its full allowance. Provider overload/rate-limit retries remain effectively unbounded under the existing cancellation rules.

Only actual allowance expiry emits the durable/live machine contract:

```json
{
  "passed": false,
  "status": "timeout",
  "timeout": {
    "configuredSeconds": 1200,
    "elapsedMs": 1200000
  }
}
```

`configuredSeconds` is the resolved per-active-turn allowance and `elapsedMs` is the elapsed time for the turn that expired. Total `duration_ms` may be larger after retries, reminders, recovery, or provider waits. Other failures and idle-without-result do not use the timeout marker. See [Verifier Recovery](llm-review-recovery.md) for lifecycle details.

#### Changing a timed-out review allowance

Gate inspection and the live verification card use the structured marker above to render a warning clock, the distinct **Timed out** label, elapsed active-turn time, and configured limit. The overall gate still fails for dependency purposes. A generic failed step whose output merely mentions a timeout does not receive this presentation or remediation control; the UI never infers timeout state from prose.

A marked step exposes **Change timeout**. The dialog requires a positive whole number of seconds and offers two independent checkboxes:

- **This goal** replaces the current goal's frozen workflow snapshot through `PUT /api/goals/:goalId/workflow`. Only the named verification step is patched in the submitted copy. Reconciliation returns that changed gate to `pending`, after which it can be re-signaled with the new allowance.
- **Future goals in this project** updates the project workflow template through `PUT /api/workflows/:workflowId?projectId=…`. If the resolved workflow is not yet a project-owned override, Bobbit first calls `POST /api/workflows/:workflowId/customize?projectId=…`. Newly created goals snapshot the new value; every existing goal, including the one whose card opened the dialog, remains unchanged.
- Selecting **both** performs both independent writes. Each scope reports success or failure separately. A partial success is not reported as complete, and Retry skips a scope that already succeeded.

The dialog defaults to the current-goal scope. Future-only is useful when the current failure should remain auditable under its original contract; both is the explicit choice when the current retry and later goals need the same allowance. Template updates never retroactively reconfigure active goals.

#### Active verification snapshots

While verification is running, the gate store contains seeded step rows so history is never empty. Those rows are not authoritative for live progress: they may carry placeholder values before a step starts. Agent tools and UI surfaces therefore read a shared active snapshot that overlays the persisted signal with `VerificationHarness` state for the latest running signal.

`gate_status` and `gate_inspect section=verification` use the same snapshot, so they agree on step status, summary counts, durations, bounded output, and active metadata. Final completed signals still read from the persisted verification result.

Step `status` is explicit:

| Status | Meaning |
|---|---|
| `passed` | Step completed successfully. |
| `failed` | Step completed unsuccessfully. |
| `timeout` | A review-agent active turn exhausted its resolved allowance. The step and overall gate fail. |
| `skipped` | Step was intentionally skipped, such as a disabled optional step or a later phase skipped after an earlier phase failed. |
| `running` | Step is executing now; duration is elapsed time so far. |
| `waiting` | Step has not started yet. This is also the API representation for "yet to run". |
| `blocked` | Active-snapshot derived state for a not-yet-run step blocked by an earlier phase failure; terminal persisted rows use `skipped`. |

For non-final `running`, `waiting`, and `blocked` states, callers should use `status` instead of treating `passed: false` as failure. Terminal rows preserve explicit `status` as `passed`, `failed`, `timeout`, or `skipped`; `skipped: true` rows are ignored by aggregate pass calculation and should not be rendered as ordinary passes or failures.

Verification log output is bounded by default: `gate_status` and `gate_inspect section=verification` return the last 20 lines per step, not full logs. Agents that need deeper evidence should call `gate_inspect` with a targeted selection mode:

- `mode=tail&lines=N` for more trailing context;
- `mode=head&lines=N` for startup output;
- `mode=slice&from=A&to=B` for an exact line range;
- `mode=grep&pattern=...&context=N` for focused failure searches;
- `full` only when a broad read is needed. Normal line, byte, and tool-result caps still apply.

Running command steps can include live stdout/stderr tails. The server reads those log files with bounded byte limits before applying the same selection and aggregate response budgets used for persisted output. Live WebSocket events are bounded too: `gate_verification_step_output.text` is truncated to a preview when a single chunk is large, and `gate_verification_step_complete.output` has a separate completion preview cap. Truncated live events include byte-count metadata (`textTruncated` / `outputTruncated`, original bytes, preview bytes) so the UI can show that the live stream is only a preview.

Completed command steps also retain stdout/stderr under Bobbit state. Default status surfaces, implicit inspection, and live WS frames stay compact, but any explicit `gate_inspect(section="verification", mode=...)` request can query the retained logs and returns diagnostics metadata when available. Playwright-style `test-results` and `playwright-report` artifacts are copied into the same retained diagnostics tree, including `error-context.md`, traces, screenshots, and reports. Retained log streams are capped at 20 MiB each, artifact copying is symlink-hardened, and diagnostics are cleaned up when the owning goal is archived or deleted. Team leads should inspect these persisted diagnostics before rerunning expensive suites. See [Retained gate diagnostics](gate-diagnostics.md) for the full storage, inspection, cleanup, and full-output recovery model.

#### Command step restart recovery

Command verification steps persist enough state to survive a gateway restart: process metadata, stdout/stderr log paths, durable exit-file paths, identity files, heartbeat files, original deadlines, and cancellation/timeout kill intent. If a restarted gateway finds an exit file, it finalizes from that real command verdict and retained logs. If the command is still running, Bobbit reattaches only after identity checks prove the PID belongs to the recorded command.

A restart that leaves no durable exit status is not treated as a command failure. Bobbit records an explicit restart-interrupted step row, leaves the gate `pending`, and asks the team lead to re-signal. Timeout and cancellation cleanup also persists intent until Bobbit verifies the command tree is gone; if identity cannot be proven, Bobbit refuses unsafe PID kills and keeps retryable cleanup state instead of killing an unrelated process.

See [Restart-safe command gate verification](verification-restart.md) for the full recovery, identity, and cleanup model.

##### Targeting a single verification step

A gate often runs several verify steps (e.g. type-check + lint + unit + e2e, or multiple review steps). By default `gate_inspect section=verification` returns *every* step, so a team lead chasing one failing step still receives all the others' output and cannot scope a `grep`/`slice` to the step they care about. The optional `step` parameter fixes that: pass the step **name** and the snapshot is scoped to just that one step.

- **Why by name:** step names are already surfaced to callers — `gate_status` returns the names of failed steps in `failedSteps`, and each step's `name` appears in an unfiltered verification snapshot. So the names needed to target a step are always in hand. Targeting is by name only; there is no index-based selector.
- **What changes:** `steps[]` contains only the matching step (still a single-element array, so the response shape is unchanged), and the selection mode (`grep`/`tail`/`slice`/`head`/`full`) applies to that one step's output. Per-step `selection` metadata and the default bounded-tail behavior are preserved.
- **Validation:** an unknown step name returns 400 listing the available step names for that signal. `step` is only meaningful for `section=verification`; combining it with `section=content` or `section=signals` returns 400 (`step is only valid with section='verification'`).

Typical triage flow: `gate_status` reports a failure and names the culprit in `failedSteps`, then `gate_inspect(section="verification", step="<name>", mode="grep", pattern="error|failed", context=2)` focuses the search on that step's log alone. See the [`gate_inspect` tool docs](../defaults/tools/tasks/gate_inspect.yaml) for the full parameter table.

The UI uses the same explicit-status model. Gate status cards, the `gate_inspect` renderer, and signaled gate live cards reconcile WebSocket events, active-verification fetches, and persisted signal rows without flickering back to placeholder failed or `0ms` states while verification is still running.

#### Verification template semantics

Verification `run:` strings and `prompt:` bodies use a small runtime template scope:

- `{{baseBranch}}` is a built-in and resolves to the bare integration branch from the project's configured `base_ref` (`origin/master` → `master`). If `base_ref` is unset, it falls back to the detected primary branch.
- `{{master}}` is a legacy alias for the detected primary branch. It does not honor `base_ref`; prefer `{{baseBranch}}` in new workflows.
- `{{project.*}}` is unsupported in verification templates. Component commands should use `{ component, command }`; QA settings should live under the selected component's `config:` map.

Unresolved optional metadata can still make an optional command step skip. That skip behavior must not apply to required Ready-to-Merge built-ins: a required Ready-to-Merge check that references `{{branch}}`, `{{baseBranch}}`, or `{{master}}` should execute when the project has a resolvable branch, or fail loudly if the built-in cannot be resolved. It must not pass solely because the template remained unresolved.

#### Gate verification baselines

A gate's **baseline** is the git reference the reviewer diffs `HEAD` against when deciding what to comment on. Choosing the right baseline matters: too broad and the reviewer critiques upstream work that another agent already merged; too narrow and real goal-branch changes slip through unreviewed. It is also the single biggest source of false-positive "branch doesn't match design doc" findings when it drifts.

Gate verification is **baseline-aware** — different gate kinds compare against different git references:

| Gate kind              | Baseline                                  | How it's detected                     |
|------------------------|-------------------------------------------|---------------------------------------|
| Pre-implementation     | None — no diff is run                     | `content: true` AND no `depends_on` (see `isPreImplementationGate` in `src/server/agent/verification-logic.ts`) |
| Implementation & later | `origin/<primary>...HEAD`                 | All other verify-bearing gates        |
| `ready-to-merge`       | `origin/<primary>` via `git merge-base`   | Hardcoded in workflow YAML            |

**Why `origin/<primary>` and not local `<primary>`:** in remote-backed projects, local refs are only as fresh as the last `git pull` on the host. Goal worktrees are normally created from `origin/<primary>`; verification must diff against the same anchor or it surfaces commits that have already been merged upstream as if they were goal-unique work.

Before verification, the harness first checks whether the repo has an `origin` remote. If there is no `origin`, remote sync and baseline fetch are skipped quietly, and verification continues from the current local worktree state.

When `origin` exists, the harness checks for `refs/heads/<goalBranch>` before syncing the goal branch:

- If the remote goal branch exists, verification fetches it (`git fetch origin <goalBranch>`) and then performs a **non-destructive, ancestry-aware sync** instead of an unconditional reset. After the fetch it compares the local worktree HEAD against `origin/<goalBranch>` with `git merge-base --is-ancestor` and takes one of three branches:
  - **Local ahead of (or equal to) origin** — `origin/<goalBranch>` is an ancestor of local HEAD. The reset is **skipped** and the local tree is verified as-is (log marker `skipped-because-ahead`). This is the normal team-lead state: the worktree already contains every origin commit plus locally-merged member branches that have not been re-pushed. **This is the key fix** — an unconditional `git reset --hard origin/<goalBranch>` here would silently discard those un-pushed local commits and verify stale code.
  - **Local behind origin** — local HEAD is an ancestor of `origin/<goalBranch>`, so the remote is strictly ahead and the worktree has nothing unique. The harness fast-forwards to `origin/<goalBranch>` via `git reset --hard` (log marker `fast-forwarded`). This is safe because no local commits can be lost, and `reset --hard` (rather than `git merge`) deliberately avoids running repo-local git hooks such as `post-merge`. This preserves the original "published work is verified exactly as remote consumers see it" behaviour for the behind/up-to-date case.
  - **Diverged** — each side has unique commits. The harness does **not** hard-reset (that would discard local commits); it emits a visible `console.warn` (`diverged-kept-local`) and verifies the local state. Divergence is never resolved by silently throwing away local work.
- If the remote goal branch is missing, verification treats that as an expected local-only branch case. This covers goal worktrees claimed from the pool and unpublished goal branches: remote goal-branch sync is skipped without a warning or stack trace, and verification runs against the current local worktree.
- Unexpected remote-check, network, auth, or fetch/sync failures still warn non-fatally. The gate can continue using the best local state available, but the warning stays visible because it may affect diff freshness.

**Why the sync is ancestry-aware rather than an unconditional reset:** under the team-lead local-merge model, the goal worktree is normally *ahead* of `origin/<goalBranch>` — the lead merges member branches locally and only publishes at `ready-to-merge`. A blanket `git reset --hard origin/<goalBranch>` before every gate would roll those un-pushed merges back to the last-published tip and verify stale code, silently losing work. The ancestry check keeps the original "verify pushed work" intent for the behind case while never discarding local commits in the ahead or diverged cases.

The baseline branch is fetched separately when `origin` exists so `origin/<primary>` / `origin/{{baseBranch}}` is current for implementation and Ready-to-Merge checks.

**Why pre-implementation gates skip the diff entirely:** a design-doc or issue-analysis gate, by workflow construction, runs before any code is committed. A branch with zero goal-unique commits is the normal expected state. Running a diff produces noise at best, and — if local `<primary>` is stale — false positives at worst. The reviewer prompt explicitly forbids `git diff` / `git log` for these gates.

**Primary branch detection:** the harness calls `detectPrimaryBranch(cwd)` from `src/server/skills/git.ts`, which uses `git symbolic-ref refs/remotes/origin/HEAD` with a `master` → `main` fallback. Never hardcode `"master"` in new gate logic — always resolve via this helper. The resolved baseline (e.g. `origin/main@abc1234`) is printed into every review prompt's "Signal Context" so failures are trivial to diagnose.

**Configurable integration target (`base_ref`):** the project-level `base_ref` setting lets workflows track a different branch (e.g. `develop`, a release branch) as the integration target. New built-in/seeded workflows substitute `{{baseBranch}}` — a built-in bare branch name derived from `base_ref` (for example, `origin/master` → `master`, `origin/develop` → `develop`) or from `detectPrimaryBranch()` when unset. `{{master}}` is a legacy alias that continues to resolve via `detectPrimaryBranch()` regardless of `base_ref`, so existing user-authored workflows keep their meaning. Write `origin/{{baseBranch}}` explicitly when a remote ref is needed. Full semantics, validation rules, and error inventory: [design/base-ref.md](design/base-ref.md).

**Branch publication safety:** Ready-to-Merge templates publish the goal branch with an explicit destination refspec:

```bash
git push origin {{branch}}:refs/heads/{{branch}}
```

Do not use bare forms such as `git push origin {{branch}}` in verification. Bare branch pushes can be redirected by inherited upstream config or `push.default=upstream` (for example, to `origin/master`). Bobbit-owned branch publication for goal/session/team worktrees uses the same rule (`<branch>:refs/heads/<branch>` or `HEAD:refs/heads/<branch>`), so `base_ref` controls baselines and status comparisons but never the remote push destination.

**Verification push guard:** before running any command step, the harness checks substituted shell text for unsafe `git push` invocations. From a non-primary goal/session branch it rejects pushes with no explicit refspec, bare branch refspecs, `--all`/`--mirror`, and explicit destinations that update the protected base/primary branch (`{{baseBranch}}`, `{{master}}`, or the primary fallback). The check also catches the wrapper forms covered by regression tests, such as absolute `git` executable paths and `env ... git push ...`. Safe publication to the current branch (`{{branch}}:refs/heads/{{branch}}`) is allowed.

**How the harness enforces this per-gate:** reviewer/architect/spec-auditor role YAMLs contain a `{{REVIEW_CONTEXT}}` placeholder in their preamble. `buildReviewPrompt()` in `src/server/agent/verification-harness.ts` substitutes it with either (a) an "implementation review" block containing the concrete `origin/<primary>...HEAD` diff instructions and the resolved baseline SHA, or (b) a "pre-implementation" notice that explicitly forbids `git diff` / `git log` and reminds the reviewer that zero goal-unique commits is the normal state. The branching decision uses `isPreImplementationGate()` on the signalled gate — role YAMLs never hardcode diff commands.

**Migration note for user-authored workflows:** `.bobbit/config/workflows/<id>.yaml` is no longer read at runtime. Pre-existing files there are folded into `project.yaml::workflows` on first boot by `migrate-project-yaml.ts` and the directory is removed. The harness resolves `{{master}}` to the dynamically-detected primary branch, but the `origin/` prefix is now injected only by built-in workflow content. User-authored prompts that still say `{{master}}...HEAD` (without `origin/`) will diff against the local ref — rewrite to `origin/{{master}}...HEAD` to get the full fix. Pre-implementation gates automatically benefit regardless, because that logic lives in the harness's review-prompt builder.

#### Phased verification

Verification steps have an optional `phase` field (integer, default 0). Steps are grouped by phase and phases execute **sequentially** in ascending order. Within a phase, steps run concurrently by default, including `type: command` steps. If two command checks must not overlap, put them in different phases instead of relying on step type for ordering.

If any step in a phase fails, all subsequent phases are skipped immediately and the gate fails. Skipped downstream steps are persisted as `status: "skipped"`, `skipped: true`, and their original `phase`, with output `"Skipped — earlier phase failed"`. `computeAllPassed()` ignores skipped rows when aggregating the gate result, so skipped downstream steps do not become additional failures; the phase's real failed step is what fails the gate.

This avoids wasting expensive LLM reviews (phase 1) when cheap command checks (phase 0) have already failed, while keeping the `phase` field as the sole source of verification ordering. In the built-in `feature` and `bug-fix` workflows, type-checking and tests run at phase 0, while code quality and security reviews run at phase 1.

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

**Backward compatibility:** Steps without a `phase` field default to phase 0. Existing workflows and snapshotted goal workflows continue to work without migration. Same-phase steps run concurrently by default; explicit ordering between command checks should be represented with different `phase` values.

**WebSocket events:** The server broadcasts `gate_verification_phase_started` before each phase begins, including the phase number and which step indices belong to it. Step-level events (`gate_verification_step_started`, `gate_verification_step_output`, `gate_verification_step_complete`) include an optional `phase` field where applicable. Output events are live previews, not the durable source of full logs; large chunks are truncated before goal-level fanout so normal verification activity cannot wedge the UI. The goal dashboard uses these events to show phase progression in real time and falls back to active snapshots / retained diagnostics for full output.

#### Verification step artifacts

Step results can carry an optional `artifact` containing rich content that would be too large or structured for the short `output` summary field.

```typescript
interface GateSignalStep {
  name: string;
  type: string;
  passed: boolean;
  status?: "waiting" | "running" | "passed" | "failed" | "timeout" | "skipped";
  phase?: number;            // Workflow phase used for grouping and execution order
  skipped?: boolean;         // true when step was skipped (optional not enabled, or earlier phase failed)
  output: string;            // Short summary
  duration_ms: number;       // Total step elapsed time
  timeout?: {                // Present only when a review-agent active turn expires
    configuredSeconds: number;
    elapsedMs: number;
  };
  artifact?: {
    content: string;         // Full report body
    contentType: string;     // "text/markdown" | "text/html"
    metadata?: Record<string, string>;
  };
}
```

**LLM review artifacts:** When an `llm-review` step completes, the verification harness stores the reviewer's full analysis as a `text/markdown` artifact. The `output` field retains the short summary, while the artifact preserves the complete review text that was previously lost. For reviewer retry, reminder, restart-resume, and exhausted-recovery diagnostics, see [Verifier Recovery](llm-review-recovery.md).

**Size limit:** Artifact content is capped at 10 MB. Content exceeding this limit is truncated.

**Dashboard rendering:** The goal dashboard renders artifacts based on their content type:
- **`text/markdown`** — shown inline in a collapsible "Full Review" section below the step result.
- **`text/html`** — a "View Report" button opens the HTML content in a new browser tab via a Blob URL.
- **Metadata** — if `artifact.metadata` is present, key-value pairs are displayed alongside the content.

#### Optional verify steps

Verify steps can be marked `optional: true` with a human-readable `optionalLabel` for the UI toggle. Optional steps are **disabled by default** — they only run when explicitly enabled for a specific goal. Steps can also include a `description` string, which renders as an ⓘ tooltip icon next to the toggle. For `agent-qa` steps, the toggle is automatically greyed out when no component in the project has `config.qa_start_command` set (driven by `isQaConfiguredOnAnyComponent()` via `GET /api/projects/:id/qa-testing-config`), and the tooltip is overridden with a configuration hint.

`label` is reserved for `type: human-signoff` card titles. Legacy optional non-human steps that used `label` are migrated to `optionalLabel` on load and written back in canonical shape on save.

**How it works:**
- Goals carry an `enabledOptionalSteps: string[]` field listing the `name` values of optional steps that should be active.
- At goal creation, the UI shows a checkbox for each optional step in the selected workflow. The goal assistant can pre-toggle steps via the `options` parameter (comma-separated step names) in its `propose_goal` tool call.
- During verification, the harness checks each step before phase grouping. If `step.optional === true` and the step's `name` is not in the goal's `enabledOptionalSteps`, the step is skipped with `status: "skipped"`, `skipped: true`, its workflow `phase`, and output `"Skipped — not enabled for this goal"`.
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
    optionalLabel: "Enable QA Testing"
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

**Timeout:** When `timeout` is omitted, the resolved active-turn allowance is the maximum of 1200 seconds and `(qa_max_duration_minutes + 5) * 60` seconds; `qa_max_duration_minutes` defaults to 10. A valid explicit workflow timeout always wins, even when shorter than the omitted default, with a one-second minimum. The harness resolves the owning component via the step's `component:` field, falling back to the first component with `config.qa_start_command`, then a name-match against the project. See [QA Testing](qa-testing.md) for the full per-component config layout.

**Retry logic:** Up to 3 attempts with backoff on transient failures (same pattern as `llm-review`). Each attempt, reminder, restart continuation, and recovery turn gets a fresh resolved active allowance; provider backoff is outside it.

**Test environments:** Respects `BOBBIT_LLM_REVIEW_SKIP` — when set, `agent-qa` steps auto-pass without spawning an agent.

**Resume support:** If the server restarts during an `agent-qa` step, the harness re-executes the step from scratch on the next verification cycle.

The `agent-qa` step typically runs at phase 2 in the `feature` and `bug-fix` workflows — after command checks (phase 0) and LLM reviews (phase 1) have passed. See [QA Testing](qa-testing.md) for project configuration and the `/qa-test` skill protocol.

#### Human sign-off steps

A `human-signoff` verification step parks the gate on a deferred resolver until a human approves or rejects it via the UI. It reuses the same async-verification machinery as `llm-review` and `agent-qa` — the only difference is *who* resolves the await: a REST submission from the browser rather than a reviewer agent's `verification_result` call.

**Why it exists.** Some gates need an authoritative human decision — a design review, a release sign-off, a security exception — without coupling the decision to the team lead's liveness or context-window budget. A dedicated step type keeps approval state on the verification record (restart-safe, cancellable, persisted) and emits the same `{ passed, output, artifact }` shape every other step produces, so failed sign-off feedback flows back through the team lead's normal "consume failed reviewer findings" path.

**YAML shape:**

```yaml
verify:
  - name: design-approval
    type: human-signoff
    phase: 1
    label: "Approve design doc"
    prompt: |
      Review the design doc for {{branch}} and approve or reject.
```

Both `label` and `prompt` are required (the validator rejects the step on load otherwise). `{{branch}}`, `{{baseBranch}}`, `{{goal_spec}}`, and `{{<gate>.meta.<key>}}` tokens (`{{master}}` remains valid as a legacy alias) are substituted before the prompt is shown to the user — same machinery as the other step types.

**Lifecycle.** When the harness reaches the step it broadcasts `gate_verification_awaiting_human` (see [websocket-protocol.md](websocket-protocol.md)), sets `awaitingHuman: true` on the active step, persists, and `await`s a deferred resolver. The chat-header `<goal-status-widget>` and active verification cards rendered by `gate_signal`, `gate_status`, and `gate_inspect(section="verification")` surface the pending request. Their shared **Start Review** launcher opens the submitted gate content in the review pane only while that authoritative marker remains true. The review pane owns inline comments, final comment, Approve / Reject validation, and decision submission. The browser POSTs to `/api/goals/:id/gates/:gateId/signoff` with `{ signalId, stepName, decision, feedback? }`; the harness builds a step result (passed = `decision === "pass"`; `output` and a `text/markdown` artifact carry the composed final/inline feedback when present) and the gate completes through the standard phase machinery. See [Review Pane Sign-Off](review-pane-signoff.md) for launcher eligibility, the review-source model, validation rules, persistence, and sanitization constraints.

**Resume / cancellation.**

- Server restart re-broadcasts `gate_verification_awaiting_human` from the resume path; the persisted `humanPrompt` / `humanLabel` survive intact. No data loss, no duplicate UI prompt — the widget reconciles by `(signalId, stepName)`.
- Re-signaling the gate while a sign-off is pending drains the resolver with `{ cancelled: true }`; the failed step result is suppressed and the fresh signal opens a new request.
- `POST /signoff` is idempotent — already-resolved or cancelled steps respond `409 { error: "step is no longer awaiting human input", status }`.

**Authz (v1).** Trusts the gateway token — anyone with UI access can sign off. Bobbit has no user-identity model today; submission records only a server-side timestamp. Sandboxed sub-agents are blocked from POSTing to `/signoff` at the `sandbox-guard` layer so a sandboxed agent cannot self-approve a sign-off step that gates its own work.

**Test bypass.** Only `BOBBIT_HUMAN_SIGNOFF_SKIP=1` auto-passes the step. There is **no** fallback to `BOBBIT_LLM_REVIEW_SKIP`: a "human" gate must not share a bypass with `agent-qa` / `llm-review`, otherwise the global E2E harness (which sets `BOBBIT_LLM_REVIEW_SKIP=1`) would silently auto-approve every human gate. With `BOBBIT_HUMAN_SIGNOFF_SKIP` unset or `=0`, the step parks awaiting a real human decision.

Feature behavior: [Review Pane Sign-Off](review-pane-signoff.md). Full design: [design/human-signoff-gates.md](design/human-signoff-gates.md). UI-side notification rules: [design/notification-policy.md](design/notification-policy.md).

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

Lifecycle-created work branches — including goal integration, team-member, and delegated helper/session sub-agent branches — stay local during creation, status, reuse, and recovery. Bobbit does not push them to origin as a safety net; the persistent local worktree is the crash-recovery and merge handoff mechanism. Team leads merge or cherry-pick from the local ref/worktree when it is available, so no remote fetch is required.

Remote publication is still allowed when it is intentional: a user-requested push, a workflow/cross-machine/container handoff that needs a remote branch, or the final Ready-to-Merge / PR publication of the goal integration branch. Intentional Bobbit-owned pushes use explicit destination refspecs (`HEAD:refs/heads/<branch>` or `<branch>:refs/heads/<branch>`) so local upstream tracking cannot redirect them to the base/primary branch. The only routine PR in the workflow is the final goal-to-primary-branch PR for human review.

#### Multi-repo git handoff

In multi-repo projects, a single goal/session/staff worktree set spans multiple repos all sharing one branch name (`goal/<slug>-<id>`, `session-<slug>-<id>`, etc.). To track per-repo commit state, tasks carry a per-repo handoff map:

```typescript
// Multi-repo handoff (Phase 4):
task.gitHandoff: { [repoName]: { baseSha: string, headSha?: string, branch: string } }
```

The single-repo flat shape (`task.baseSha` / `task.headSha` / `task.branch` directly on the task) is preserved for back-compat — read helpers transparently project a single-repo task into the same shape so callers don't need to special-case mode.

Goal `git-status` and `git-diff` endpoints aggregate across all repos; the git-status widget shows per-repo collapsible sections. Cleanup tears down all per-repo worktrees and deletes matching remote branches when they exist; missing remotes for local-only sub-agent branches are expected. PR/merge tooling (gh integration) operates per-repo; a multi-repo goal opens N PRs (one per repo with commits), all titled with the goal's branch.

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

5. Agent produces the design, commits locally, and marks the task complete
   with `head_sha`. Team Lead merges from the local ref/worktree and signals
   the gate:
   gate_signal(gate_id="design-doc", content="# Design\n\n...")
   → Server runs verification (if configured) → gate status: passed
   (Only the team lead can call gate_signal — see "Signaling a gate" above.)

6. Team Lead spawns next agent with upstream context:
   team_spawn(role="coder", task="Implement the design",
     workflowGateId="implementation")
   → Agent receives the passed design-doc content in its system prompt

7. Agent completes implementation, commits locally, and marks the task
   complete with `head_sha`. Team Lead merges from the local ref/worktree and
   signals the gate:
   gate_signal(gate_id="implementation")
   → Verification runs (npm run check + LLM review) → gate status: passed

8. Process continues through the DAG until every gate is passed (or human-bypassed —
   a bypassed gate satisfies downstream dependency ordering like a passed one, but
   completion still requires explicit human confirmation; see step 9)

9. team_complete() — server verifies all workflow gates have passed.
   (If any gate was human-bypassed, team_complete is refused; a human must
   confirm via POST /api/goals/:id/team/complete { confirmBypassedGates: true }.
   See "Human gate bypass" above.)
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
| `POST` | `/api/goals/:id/gates/:gateId/reset` | Reset the gate plus transitive downstream dependents to pending |
| `GET` | `/api/goals/:id/gates/:gateId/signals` | Get signal history for a gate |
| `GET` | `/api/goals/:id/gates/:gateId/content` | Get the current passed content of a gate |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |
| `GET` | `/api/goals/:id/verifications/active` | Get in-flight verification state (running steps, sessions) |

The gate list, gate detail, and task list endpoints support `?view=summary` for slim agent-facing responses. See [rest-api.md — Summary views](rest-api.md#summary-views-viewsummary) for response shapes, the [Gate reset endpoint](rest-api.md#gate-reset-endpoint) for reset response details, and the [Gate inspect endpoint](rest-api.md#gate-inspect-endpoint) for the `/inspect` endpoint.

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
| `src/server/agent/gate-store.ts` | Gate state, reset, and signal history persistence |
| `src/server/agent/task-store.ts` | Task persistence with `workflowGateId` and `inputGateIds` |
| `src/server/agent/team-manager.ts` | Context injection via `buildDependencyContext()` |
| `src/server/agent/system-prompt.ts` | System prompt assembly including gate context |
| `src/app/goal-dashboard.ts` | Goal dashboard gate pipeline, focused route state, expanded gate/signal sections |
| `src/ui/components/GoalStatusWidget.ts` | Chat-header gate popover, passed-gate View/Reset controls, sign-off launcher |
| `defaults/tools/tasks/extension.ts` | Agent tools: `gate_signal`, `gate_status`, `gate_list`, `gate_inspect`, `task_create` |
| `defaults/tools/team/extension.ts` | Agent tools: `team_spawn`, `team_prompt` with context injection |
| `defaults/roles/team-lead.yaml` | Team Lead prompt template (workflow-aware) |
| `src/server/state-migration/seed-default-workflows.ts` | Internal workflow templates (used by per-component scaffolds; not seeded into new projects) |
