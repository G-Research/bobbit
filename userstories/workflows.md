# Workflows — User Stories

## W-01: View workflows list

**As a** user
**I want to** see all available workflows on the Workflows page
**So that** I can understand what workflow templates exist for structuring goals

### Acceptance Criteria

- The Workflows page displays all workflows, including built-in defaults and user-created ones.
- Each workflow shows its **name**, **description**, and **gate count**.
- Each workflow displays an **origin badge**: grey for builtin, blue for server-level, green for project-level.
- Inherited (non-overridden) workflows appear **dimmed**.
- When multiple projects are registered, a **scope selector** appears above the list.

### Coverage

**API only.** No browser E2E test validates the list page rendering, badges, or scope selector.

---

## W-02: View workflow editor

**As a** user
**I want to** click a workflow and see its gate structure in a visual editor
**So that** I can understand and modify the workflow's verification pipeline

### Acceptance Criteria

- Clicking a workflow opens a **visual editor** showing gates and their dependencies.
- Each gate lists its **verification steps** with type, optional flag, and label.
- Optional steps show a **description tooltip** (ⓘ icon) when a description is configured.

### Coverage

**Covered (8 tests).** The workflow editor UI has comprehensive E2E test coverage.

---

## W-03: Create workflow

**As a** user
**I want to** create a new workflow with custom gates and verification steps
**So that** I can define project-specific quality gates for my goals

### Acceptance Criteria

- Clicking "New" opens a workflow creation form.
- The user defines: **name**, **description**, and one or more **gates**.
- Each gate can have **dependencies** on other gates and **verification steps**.
- On save, the workflow is available in the goal creation workflow picker.

### Coverage

**API only.** No browser E2E test for the full creation form interaction.

---

## W-04: Edit gates

**As a** user
**I want to** add, remove, and configure gates in a workflow
**So that** I can refine the verification pipeline as project needs evolve

### Acceptance Criteria

- In the workflow editor, the user can:
  - **Add** a new gate.
  - **Remove** an existing gate.
  - **Set dependencies** — a gate cannot proceed until its dependencies pass.
  - **Add verification steps** to a gate, each with a type (command / LLM review / QA test), optional flag, label, and description.
- Changes are persisted on save.
- Existing goals are **not** affected — workflows are snapshotted at goal creation.

### Coverage

**Partial.** The gate editor UI is tested but not all add/remove interactions have dedicated E2E coverage.

---

## W-05: Delete workflow

**As a** user
**I want to** delete a custom workflow
**So that** unused workflows don't clutter the list

### Acceptance Criteria

- Clicking "Delete" on a workflow shows a confirmation dialog.
- On confirm, the workflow is removed from the list.
- Existing goals using this workflow are **not** affected — the workflow was snapshotted into the goal at creation time.
- Only custom workflows can be deleted; builtins cannot.

### Coverage

**API only.** No browser E2E test for the delete confirmation flow.

---

## W-06: Workflow in goal creation

**As a** user
**I want to** select a workflow when creating a goal
**So that** the goal has the appropriate verification gates

### Acceptance Criteria

- The goal creation form includes a **workflow picker** listing all available workflows for the goal's project.
- Selecting a workflow updates the **gate preview** in the form.
- Optional verification steps show **toggles**, with a **tooltip** (from the step's description) next to each toggle.
- The selected workflow is **snapshotted** into the goal — later workflow edits don't affect this goal.
- The QA testing toggle is automatically **disabled with a tooltip** when QA is not configured for the project.

### Coverage

**Partial.** The workflow picker and gate preview render, but E2E tests don't fully validate optional step toggles, tooltips, or QA auto-disable behavior.

---

## W-07: Customize builtin workflow (project override)

**As a** user
**I want to** create a project-level override of a builtin workflow
**So that** I can customize verification gates for a specific project

### Acceptance Criteria

- With a project scope selected, clicking "Customize" on a builtin workflow creates an editable copy for that project.
- The origin badge changes from grey (builtin) to green (project).
- Goals in that project use the override; other projects see the original builtin.
- Clicking "Revert" removes the override and restores the inherited workflow, changing the badge back.

### Coverage

**API only.** No browser E2E test for the Customize/Revert button interactions.

---

## W-08: Verification phases

**As a** user
**I want** verification steps to execute in phased order
**So that** expensive checks only run after prerequisite checks pass

### Acceptance Criteria

- Steps within the **same phase** run in **parallel**.
- Phases run **sequentially** — the next phase does not start until the current one completes.
- A **failure** in an earlier phase causes later phases to be **skipped**.
- **Optional steps** can be skipped without failing their phase.
- Skipped steps show a "skipped" status in the gate detail view.
- A running verification can be **cancelled** via the Cancel button in the dashboard.

### Coverage

**Partial.** Phase structure is rendered in the editor and some execution behavior is covered, but full parallel/sequential ordering and skip propagation are not fully validated in E2E tests.
