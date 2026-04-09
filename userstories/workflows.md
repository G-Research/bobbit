# Workflows — User Stories

## W-01: View workflows list

**As a** user  
**I want to** navigate to `#/workflows` and see all available workflows  
**So that** I can understand what workflow templates exist for structuring goals

### Acceptance Criteria

- Navigating to `#/workflows` displays all workflows resolved through the config cascade (builtin + server + project layers).
- Each workflow entry shows its **name**, **description**, and **gate count**.
- Each workflow displays an **origin badge**: grey for builtin, blue for server, green for project.
- Inherited (non-overridden) workflows render at **70% opacity**.
- When multiple projects are registered, a **project scope row** appears above the list.

### Technical Notes

- Resolution uses `ConfigCascade.resolveWorkflows(projectId)`.
- REST: `GET /api/workflows?projectId=<id>` returns the resolved list with origin metadata.
- Shared UI code in `config-scope.ts` and `config-scope.css`.

### Coverage

**API only.** No browser E2E test validates the list page rendering, badges, or scope row.

---

## W-02: View workflow editor

**As a** user  
**I want to** click a workflow and see its gate/phase structure in a visual editor  
**So that** I can understand and modify the workflow's verification pipeline

### Acceptance Criteria

- Clicking a workflow navigates to its **visual gate/phase editor**.
- Gates are shown with their **dependencies** (visualized as a graph or ordered list).
- Each gate lists its **verify steps** with:
  - **type**: `command`, `llm-review`, or `agent-qa`
  - **optional** flag and toggle
  - **label** and **description** (description renders as ⓘ tooltip on optional steps)
- **Phases** define execution order: steps within a phase run in **parallel**, phases run **sequentially**.

### Technical Notes

- Workflow YAML structure: `id`, `name`, `description`, `gates[]` where each gate has `id`, `name`, `dependsOn[]`, and `verify[]` steps.
- Verify steps: `name`, `type`, `optional`, `label`, `description`.
- The editor is a rich UI component — see existing workflow editor tests.

### Coverage

**Covered (8 tests).** The workflow editor UI has comprehensive E2E test coverage.

---

## W-03: Create workflow

**As a** user  
**I want to** create a new workflow with custom gates and verification steps  
**So that** I can define project-specific quality gates for my goals

### Acceptance Criteria

- Clicking "New" opens a workflow creation form.
- The user defines: **id** (unique, lowercase with hyphens), **name**, **description**.
- The user adds **gates**, each with:
  - **id** and **name**
  - **dependsOn** array (references other gate IDs)
  - **verify** steps with type, optional flag, label, and description
- On save, the YAML is persisted and the workflow is available in the goal creation workflow picker.

### Technical Notes

- REST: `POST /api/workflows` with JSON/YAML body. Accepts optional `projectId`.
- YAML persisted to `<scope>/.bobbit/config/workflows/<id>.yaml`.
- The workflow is also available programmatically via `propose_workflow` tool call.

### Coverage

**API only.** No browser E2E test for the full creation form interaction.

---

## W-04: Edit gates

**As a** user  
**I want to** add, remove, and reorder gates in a workflow, and configure their verify steps  
**So that** I can refine the verification pipeline as project needs evolve

### Acceptance Criteria

- In the workflow editor, the user can:
  - **Add** a new gate with a unique ID and name.
  - **Remove** an existing gate (dependencies are updated accordingly).
  - **Reorder** gates (by adjusting dependencies).
  - **Set dependencies** (`dependsOn` array) — a gate cannot proceed until its dependencies pass.
  - **Add verify steps** to a gate with: `name`, `type` (`command` / `llm-review` / `agent-qa`), `optional` flag, `label`, `description`.
- Phases group steps for execution ordering: steps within a phase run in parallel, phases run sequentially.
- Changes are persisted on save.

### Technical Notes

- Gate dependency enforcement: server returns 409 if upstream gates haven't passed when `gate_signal` is called.
- Verify step `description` field renders as ⓘ tooltip next to the step's toggle in the goal creation form.

### Coverage

**Partial (editor UI).** The gate editor UI is tested but not all add/remove/reorder interactions have dedicated E2E coverage.

---

## W-05: Delete workflow

**As a** user  
**I want to** delete a custom workflow  
**So that** unused workflows don't clutter the list

### Acceptance Criteria

- Clicking "Delete" on a workflow shows a confirmation dialog.
- On confirm, the workflow is removed from the list and its YAML file is deleted.
- Existing goals using this workflow are **not** affected — the workflow is **snapshotted** into the goal at creation time.
- Only custom workflows can be deleted; builtins cannot.

### Technical Notes

- REST: `DELETE /api/workflows/:id` with optional `?projectId=`.
- The snapshot-at-creation design means deleting a workflow is always safe for in-flight goals.

### Coverage

**API only.** No browser E2E test for the delete confirmation flow.

---

## W-06: Workflow in goal creation

**As a** user  
**I want to** select a workflow when creating a goal  
**So that** the goal has the appropriate verification gates

### Acceptance Criteria

- The goal creation form includes a **workflow dropdown** listing all available workflows (resolved for the goal's project).
- Selecting a workflow updates the **gate preview** in the form.
- Optional verify steps show **toggles** in the form, with an **ⓘ tooltip** (from the step's `description` field) next to each toggle.
- The selected workflow is **snapshotted** into the goal at creation — subsequent workflow edits don't affect existing goals.
- The QA testing toggle (`agent-qa` step) is automatically **disabled with an explanatory tooltip** when `qa_start_command` is not configured for the project.

### Technical Notes

- Goal creation UI: `renderGoalForm()` in `src/app/render.ts`.
- The form is used in both `goalPreviewPanel()` (assistant context) and `goalProposalPanel()` (proposal context).
- `POST /api/goals` accepts `autoStartTeam` in the request body (default `true`).
- Workflow snapshotting ensures goal immutability from workflow changes.

### Coverage

**Partial.** The workflow dropdown and gate preview render, but E2E tests don't fully validate optional step toggles, tooltips, or QA step auto-disable behavior.

---

## W-07: Customize builtin workflow (project override)

**As a** user  
**I want to** create a project-level override of a builtin workflow  
**So that** I can customize verification gates for a specific project

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin workflow copies it to the project config directory.
- The origin badge changes from grey (builtin) to green (project).
- Project goals use the override; other projects see the builtin.
- Clicking "Revert" removes the override and restores the inherited workflow.

### Technical Notes

- Customize: `POST /api/workflows/:id/customize?scope=project&projectId=X`.
- Revert: `DELETE /api/workflows/:id/override?scope=project&projectId=X`.
- Same cascade pattern as roles and personalities.

### Coverage

**API only.** No browser E2E test for the Customize/Revert button interactions.

---

## W-08: Verify step phases

**As a** user  
**I want** verify steps to execute in phased order  
**So that** expensive checks only run after prerequisite checks pass

### Acceptance Criteria

- Verify steps are organized into **phases** within a gate.
- Steps within the **same phase** run in **parallel**.
- Phases run **sequentially** — phase N+1 does not start until all non-optional steps in phase N complete.
- A **failed step** in an earlier phase causes later phases to be **skipped**.
- **Optional steps** can be skipped without failing their phase.
- Skipped steps show `"skipped"` status in the gate detail view.
- The verification can be **cancelled** via `POST /api/goals/:id/gates/:gateId/cancel-verification` or the Cancel button in the dashboard.
- **Zombie verifications** (all reviewer sessions dead) are auto-cancelled on re-signal.

### Technical Notes

- Phased execution: see `docs/goals-workflows-tasks.md#phased-verification`.
- Gate re-signal cancellation: see `docs/goals-workflows-tasks.md#gate-re-signal-cancellation`.
- Verification output streams via `/ws/viewer` WebSocket; modal bootstraps from `GET /api/goals/:id/verifications/active`.

### Coverage

**Partial (editor UI).** Phase structure is rendered in the editor and some execution behavior is covered, but full parallel/sequential execution ordering and skip propagation are not fully validated in E2E tests.
