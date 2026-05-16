# Proposal Modal — Goal / Workflow / Roles Tabs

The goal-proposal modal (rendered by the goal assistant and the `propose_goal` tool) is structured as a three-tab surface. This document describes the tab layout, the shared-renderer contract, the submit-path logic, and the rationale for the design choices made.

## Background

Before commit `6749bddd`, the proposal modal was a flat form — title, spec, parent picker, and a few toggles. A prior merge (`46e21256`) silently dropped the inline-workflow and inline-roles editor surfaces that had existed as raw `<details>/<textarea>` blocks. Rather than restoring those raw textareas, the modal was redesigned as a tabbed surface that reuses the same renderers as the main Workflows and Roles pages.

## Tab layout

```
┌─────────────────────────────────────────────────────────┐
│  [ Goal ]  [ Workflow ]  [ Roles ]                       │  ← tab bar
├─────────────────────────────────────────────────────────┤
│                                                          │
│  (active tab's body)                                     │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                            [ Dismiss ]  [ Create Goal ] │  ← footer always visible
└─────────────────────────────────────────────────────────┘
```

The footer sits outside the tab panels so the submit button is visible on every tab. Tab switching is handled via `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected` and roving `tabindex`. Arrow keys, Home, and End navigate between tabs.

Tab state (`data-testid="goal-proposal-tab-{goal,workflow,roles}"`) persists within the modal's lifetime and is reset when a proposal is dismissed.

## Goal tab

The default tab. Contains the existing form: title, spec, parent picker, sandbox / auto-start / QA / subgoal toggles, max depth, and worktree info. The workflow `<select>` picker lives here as the *selector* — the Workflow tab is the *inspector and customizer*.

## Workflow tab

### Left pane — list

Lists all workflows available for the current project (same set as the main Workflows page, sourced from `ensureWorkflowsLoaded`). The currently-selected workflow (matching the Goal tab's picker) is highlighted. Clicking a row updates `_proposalWorkflowId`, which the Goal tab's picker reads from — they share a single state variable, so selection is bidirectional.

### Right pane — inspector / editor

Displays the selected workflow using `renderWorkflowInspector` (read-only) or `renderWorkflowEditor` (editable) from `src/app/workflow-page.ts`. Both share the same DOM structure and CSS classes (`.wf-gate-card`, `.wf-vstep-card`, `.wf-phase-group`) so the rendering is identical to the main Workflows page.

A **Customize for this goal** button deep-clones the selected workflow into `_proposalInlineWorkflow` (draft-scoped). The editor runs with `scope: "goal-draft"`, which hides the project-library save/delete chrome and routes every mutation through `onInlineWorkflowChange` — the project workflow store is never touched. A **Reset to selected** button clears `_proposalInlineWorkflow` and reverts to the library workflow.

If an inline workflow is active, its row in the list is marked with a "customized" badge.

## Roles tab

### Left pane — list

Lists all roles available for the current project (built-ins + project overrides), sourced from the same role-resolution path as the main Roles page. Rows for roles that have been customized for this goal draft show a visible marker (`customizedNames` set).

### Right pane — inspector / editor

Displays the selected role using `renderRoleInspector` (read-only) or `renderRoleEditor` (editable) from `src/app/role-manager-page.ts`. The same sub-renderers (`renderRolePromptTab`, `renderRoleToolAccessTab`, `renderRoleModelTab`) and testids are used — the rendering is identical to the main Roles page.

A **Customize for this goal** button copies the selected role into `_proposalInlineRoles[name]`. The editor routes mutations through `onRoleDraftChange`, which updates only that entry in the map. A **Reset to default** button deletes the entry.

## Submit path

`createGoal` receives:

| Condition | Field sent |
|---|---|
| No workflow customization | `workflowId` (from picker) |
| Workflow customized via editor | `workflow` (inline snapshot; `workflowId` omitted) |
| No roles customized | `inlineRoles` omitted |
| One or more roles customized | `inlineRoles: { [name]: RoleData }` — only the touched subset |

The existing server-side API accepts both `workflow` (inline object) and `inlineRoles` — no API change was needed. The inline workflow and roles become snapshots on the goal at creation time; they are never written back to the project's workflow store or role store.

## Hydration from agent proposals

When a `propose_goal` tool call from an agent includes `inlineWorkflow` or `inlineRoles` in its payload, `syncPreviewProposalTabsState()` is called before rendering the proposal panel. It:

1. Parses `inlineWorkflow` from the payload and deep-clones it into `_proposalInlineWorkflow`. Sets `_selectedWorkflowId` to match so the Goal tab's picker reflects the inline workflow's id.
2. Iterates `inlineRoles` and deep-clones each entry into `_proposalInlineRoles`.
3. Uses identity keying (`sessionId + initial-payload hash`) so a re-render of the same proposal does not reset user edits made after the modal opened.

The user can inspect and further customize the agent-proposed workflow and roles before accepting. On accept, the (possibly modified) values follow the same submit path described above.

Hydration is identity-gated: the key is computed from `sessionId + JSON.stringify(inlineWorkflow)`. Subsequent renders of the same proposal (without a new inline payload) do not overwrite user edits.

## Renderer reuse contract

The load-bearing requirement is that the Workflow and Roles tab renderers in the modal must be **the same functions** used by the main pages — not copies or forks.

### Workflow renderers (exported from `src/app/workflow-page.ts`)

| Export | Description |
|---|---|
| `renderWorkflowList({ workflows, selectedId, dirtyIds?, onSelect, scope? })` | Stateless list. Highlights `selectedId`; badges rows in `dirtyIds` as "customized". |
| `renderWorkflowInspector({ workflow, scope? })` | Read-only gates/verify view. Same markup as the editor. |
| `renderWorkflowEditor({ workflow, onChange, scope })` | Controlled editor. Under `scope: "goal-draft"`, hides project-library chrome and routes every mutation through `onChange`. |
| `clearWorkflowEditorController()` | Clears embed controller state on unmount. |

`renderWorkflowEditor` seeds its module-level state on `workflow.id` change. `showEdit` / `showNewEdit` on the page side clear the controller so page-level edits are not mistaken for embed edits.

### Role renderers (exported from `src/app/role-manager-page.ts`)

| Export | Description |
|---|---|
| `renderRoleList({ roles, selectedName, customizedNames, onSelect, scope? })` | Stateless list with selection and customized-row markers. |
| `renderRoleInspector({ role, availableTools, groupPolicies, scope? })` | Thin wrapper over `renderRoleEditor` with `readOnly: true`. |
| `renderRoleEditor({ role, draft, availableTools, groupPolicies, callbacks, scope? })` | Full editor with Prompt / Tool Access / Model tabs. Under `scope: "goal-draft"`, hides project-library save/delete chrome. |

The `data-testid="role-editor"` attribute with `data-role-name` and `data-scope` on the editor root allows tests to assert parity between the page and the modal.

### Why not fork?

Forking the renderers would mean any future field added to the Workflows or Roles page would not automatically appear in the modal. The shared-renderer contract is pinned by a browser E2E test (`tests/e2e/ui/proposal-modal-tabs.spec.ts`) that asserts the workflow inspector DOM is the same whether reached from the main page or the modal.

## Source pins

`tests/source-pin-merge-invariants.test.ts` contains pins that fail if the renderer contract is broken by a future merge:

- `src/app/render.ts` must reference `inlineWorkflow`.
- `src/app/render.ts` must reference `inlineRoles`.
- `src/app/render.ts` must contain `data-testid="goal-proposal-tab-workflow"`.
- `src/app/render.ts` must contain `data-testid="goal-proposal-tab-roles"`.
- `src/app/api.ts::createGoal` opts must include `workflow?:` and `inlineRoles?:` fields.

Each pin cites commit `46e21256` (the regression) in its failure message so the cause is immediately traceable.

## `goal_archive_child` security hardening

Commit `03b0fbe3` added a parent-scoped archive route (`DELETE /api/goals/:parentId/archive-child/:childId`) to close a lateral-movement vector: the old `goal_archive_child` tool called the general `DELETE /api/goals/:id` route, which only checked existence, not parent/child relationship. The new route enforces that `child.parentGoalId === parentId` — non-children are rejected with `403 NOT_DIRECT_CHILD`. See [docs/rest-api.md](../rest-api.md) for the endpoint contract.
