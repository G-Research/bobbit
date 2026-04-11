# Workflows — User Stories

These stories cover the Workflows settings page, the visual gate editor, verification phases, and how workflows integrate into goal creation. The workflow system defines quality gates that goals pass through during execution.

---

## W-01: View workflows list

**Preconditions:** At least one project registered. At least one builtin workflow exists (e.g. "Feature", "Bug Fix"). A custom server-level workflow has been created.

**Steps and expectations:**
1. Navigate to Settings → Workflows (`#/workflows`).
   - The workflows list renders inside `.wf-container`.
   - Each workflow appears as a `.wf-row` showing its **name**, **description**, and **gate count**.
2. Observe origin badges on each row.
   - Each row has a `.config-origin-badge` element.
   - Builtin workflows show a grey "builtin" badge. Server-level workflows show a blue "server" badge. Project-level overrides show a green "project" badge.
3. Observe inherited (non-overridden) workflows.
   - Inherited workflows appear **dimmed** compared to workflows defined at the current scope.
4. Register a second project via `POST /api/projects`.
   - A **scope selector** row appears above the list with a "System" button and a button for each project name.
5. Click the second project's scope button.
   - The list reloads, showing workflows resolved for that project's scope.
   - Origin badges update to reflect the selected project's cascade (builtin → server → project).
6. Click "System" in the scope selector.
   - The list shows only system-level and builtin workflows (no project overrides).

**Coverage:** config-scope.spec.ts (scope row, badges, scope switching); workflows-api.spec.ts (API list)

---

## W-02: View workflow editor

**Preconditions:** A workflow exists with at least two gates, one depending on the other. One gate has verification steps across two phases, including an optional step with a `description` field.

**Steps and expectations:**
1. Click a `.wf-row` in the workflows list.
   - The editor loads, showing an `input[placeholder='Workflow name']` pre-filled with the workflow name.
   - Each gate appears as a collapsible section with a `.wf-gate-header`.
2. Click a `.wf-gate-header` to expand the gate.
   - A `.wf-gate-body` becomes visible, listing verification steps grouped under `.wf-phase-group` containers.
   - Each phase group has a `.wf-phase-header` showing "Phase 0", "Phase 1", etc.
3. Observe a verification step card (`.wf-vstep-card`).
   - The collapsed header (`.wf-vstep-collapsed-header`) shows the step name and type.
4. Click a `.wf-vstep-collapsed-header` to expand a step.
   - A `.wf-vstep-body` becomes visible with a type dropdown (`select.wf-select`), input fields for the step configuration, and an optional checkbox row (`.wf-vstep-optional-row`).
5. Observe a step that has `description` set and `optional: true`.
   - The optional checkbox is checked.
   - A label input (`.wf-vstep-optional-row input.wf-input`) shows the label text.
   - In the goal creation form, this description renders as a `span.cursor-help` ⓘ tooltip next to the toggle.

**Coverage:** workflow-editor-phases.spec.ts (phase headers, step expansion, type select, optional checkbox, label input)

---

## W-03: Create workflow

**Preconditions:** On the Workflows page (`#/workflows`). No workflow with id "my-pipeline" exists.

**Steps and expectations:**
1. Click the "New" button.
   - A creation form appears with an empty `input[placeholder='Workflow name']` and a description field.
2. Type "My Pipeline" in the name input. Type a description.
   - Characters appear as typed. No validation error yet.
3. Click "Add Gate" (or equivalent) to add a gate.
   - A new gate section appears with inputs for gate name and an empty verification step list.
4. Name the gate "Lint". Click to add a verification step inside it.
   - A new `.wf-vstep-card` appears. The step type dropdown defaults to "command".
5. Set the step type to "command" and enter `echo lint` in the `input[placeholder='Command to run...']` field.
   - The command input accepts the text.
6. Click "Save".
   - A `POST /api/workflows` request fires with the workflow payload.
   - The server responds with 201.
   - The workflow appears in the workflows list as a new `.wf-row` with a "server" origin badge.
7. Navigate to goal creation (New Goal → `#/goal-assistant`). Open the workflow picker dropdown.
   - "My Pipeline" appears as a selectable option.
8. Attempt to save a workflow with an empty name.
   - The server returns 400 with an error containing "name".
9. Attempt to save a workflow with zero gates.
   - The server returns 400 with an error containing "at least one gate".

**Coverage:** workflows-api.spec.ts (POST create, validation: empty gates, missing name, duplicate ID)

---

## W-04: Edit gates and verification steps

**Preconditions:** A workflow "Test Phases Workflow" exists with one gate ("Gate 1") containing steps in Phase 0 and Phase 1.

**Steps and expectations:**
1. Open the workflow in the editor. Expand "Gate 1".
   - Phase 0 shows its steps (e.g. "Lint check", "Code review"). Phase 1 shows its step (e.g. "Integration test").
2. Click "Add Phase" button.
   - A new `.wf-phase-group` appears with the next phase number in its `.wf-phase-header`.
   - The phase count increases by one.
3. Add a verification step inside the new phase.
   - A new `.wf-vstep-card` appears inside the new phase group.
4. Expand the new step. Change the type dropdown (`select.wf-select`) from "command" to "agent-qa".
   - The `input[placeholder='Command to run...']` disappears.
   - A `textarea[placeholder='QA test prompt...']` appears in its place.
   - The "Expect" select (pass/fail condition) is not visible — only the type select remains.
5. Check the "Optional" checkbox in the `.wf-vstep-optional-row`.
   - A label input (`.wf-vstep-optional-row input.wf-input`) appears next to the checkbox.
6. Type "Enable QA Testing" in the label input.
   - The label text is accepted.
7. Click "Save".
   - A PUT request updates the workflow. Server responds 200.
   - Navigate away (`#/workflows`) and back to the workflow editor.
   - Expand the gate and the QA step — the type is still "agent-qa", optional is still checked, and the label reads "Enable QA Testing".
8. Click the `.wf-phase-delete` button on an empty phase.
   - The empty phase group is removed. Phase count decreases by one.
9. Verify existing goals are unaffected.
   - Create a goal using this workflow (via API). Edit the workflow and save changes.
   - `GET /api/goals/:id` shows the goal's snapshotted workflow is unchanged.

**Coverage:** workflow-editor-phases.spec.ts (agent-qa type, phase grouping, Add Phase, optional checkbox + label, save/reload persistence, empty phase removal, phase compaction, default phase)

---

## W-05: Delete workflow

**Preconditions:** A custom (non-builtin) workflow "Deletable WF" exists. An active goal uses "Deletable WF". A second custom workflow "Unused WF" exists with no active goals.

**Steps and expectations:**
1. Click "Delete" on "Unused WF" in the workflows list.
   - A confirmation dialog appears.
2. Confirm the deletion.
   - A `DELETE /api/workflows/:id` request fires.
   - The server responds with 204.
   - "Unused WF" disappears from the list.
3. Verify the deleted workflow is gone.
   - `GET /api/workflows/unused-wf` returns 404.
4. Click "Delete" on "Deletable WF" (which has an active goal).
   - The server responds with 409 and an error containing "in use".
   - The workflow remains in the list.
5. Complete or archive the goal using "Deletable WF". Then delete the workflow.
   - The server now responds with 204. The workflow is removed.
6. Attempt to delete a builtin workflow (e.g. "Feature").
   - The delete action is not available (no delete button) or the server rejects the request.
   - Builtin workflows cannot be deleted.

**Coverage:** workflows-api.spec.ts (DELETE 204, DELETE 404 for unknown, DELETE 409 when in-use by active goal)

---

## W-06: Workflow in goal creation

**Preconditions:** The "feature" builtin workflow exists with an optional "QA testing" step that has a `description` field. The project does not have `qa_start_command` configured.

**Steps and expectations:**
1. Click "New Goal" (`button[title='New goal (Alt+G)']`).
   - The goal assistant session opens with a textarea.
2. Send a message that triggers a `GOAL_PROPOSAL` from the mock agent.
   - A `.goal-preview-panel` renders with an `input[placeholder='Goal title']` pre-filled with the proposed title.
   - A workflow picker dropdown (`select` inside `.goal-preview-panel`) shows the proposed workflow.
3. Observe the gate preview section.
   - Gates from the selected workflow are listed with their names.
4. Change the workflow dropdown to "feature".
   - The gate preview updates to show the feature workflow's gates.
   - An "Optional Steps" section appears with an "Enable QA Testing" toggle (`.toggle-switch` checkbox).
5. Observe the ⓘ tooltip icon next to "Enable QA Testing".
   - A `span.cursor-help` with text "ⓘ" is visible next to the label.
   - Its `title` attribute contains the step's description text (mentions "QA agent", "ephemeral server", "browser", "end-to-end").
   - The icon has CSS classes `text-[9px]`, `text-muted-foreground`, `cursor-help`.
6. Check the "Enable QA Testing" toggle and click "Create Goal".
   - The app navigates to the goal dashboard (`#/goal-dashboard/` or `#/goal/`).
   - `GET /api/goals/:id` shows `enabledOptionalSteps` contains "QA testing".
7. Switch the workflow back to "general".
   - The "Optional Steps" section disappears — the general workflow has no optional steps.
   - No `span.cursor-help` tooltip icons are present.
8. When the project lacks `qa_start_command`:
   - The QA toggle is automatically **disabled** with a tooltip explaining QA is not configured for this project.

**Coverage:** goal-creation.spec.ts (optional step toggles in assistant and proposal panels, dismiss button); goal-form-tooltips.spec.ts (ⓘ icon visibility, title text, CSS classes, general workflow has no tooltips)

---

## W-07: Customize builtin workflow (project override)

**Preconditions:** Two projects registered ("Project A" and "Project B"). On the Workflows page with "Project A" scope selected. The builtin "Feature" workflow exists and is not overridden.

**Steps and expectations:**
1. Observe the "Feature" workflow row.
   - It shows a grey "builtin" `.config-origin-badge`.
   - The row appears dimmed (inherited, not overridden at this scope).
2. Click "Customize" on the "Feature" row.
   - The workflow editor opens with the builtin's gates and steps pre-filled as an editable copy.
   - The origin badge changes to green "project".
3. Modify a gate name or add a new verification step. Click "Save".
   - A `POST` or `PUT` to the project-scoped workflow endpoint succeeds.
4. Navigate to goal creation in Project A. Open the workflow picker.
   - The customized "Feature" workflow is shown (with the modifications).
5. Switch scope to "Project B" on the Workflows page.
   - "Feature" shows the original builtin (grey badge, dimmed) — Project B is unaffected.
6. Switch back to "Project A" scope. Click "Revert" on the customized "Feature" workflow.
   - The project-level override is removed.
   - The origin badge reverts to grey "builtin". The row becomes dimmed again.
   - The original builtin gates and steps are restored.

**Coverage:** config-scope.spec.ts (scope row with System and project tabs, origin badges, scope switching reloads list)

---

## W-08: Verification phases

**Preconditions:** A workflow exists with a gate containing three verification steps: two in Phase 0 (a "command" step and an "llm-review" step) and one in Phase 1 (a "command" step). The gate has an additional optional step.

**Steps and expectations:**
1. Signal the gate (trigger verification).
   - Phase 0 begins: both the command step and the LLM review step start executing **in parallel**.
   - Phase 1 does **not** start yet.
2. Both Phase 0 steps complete successfully.
   - Phase 1 begins: the integration test step starts executing.
   - The gate detail view shows Phase 0 steps as passed and Phase 1 step as in-progress.
3. The Phase 1 step completes successfully.
   - The gate status transitions to "passed".
   - All steps show a passed status in the gate detail view.
4. Repeat with the Phase 0 command step **failing**.
   - The LLM review step (also Phase 0, running in parallel) may still complete.
   - Phase 1 is **skipped** — it never starts.
   - Skipped steps show a "skipped" status in the gate detail view.
   - The gate status transitions to "failed".
5. Observe an optional step that is disabled (not in `enabledOptionalSteps`).
   - The optional step is **skipped** without failing its phase.
   - Other non-optional steps in the same phase still execute normally.
6. While verification is running, click the **Cancel** button in the dashboard.
   - Verification is cancelled via `POST /api/goals/:id/gates/:gateId/cancel-verification`.
   - Running steps are terminated. The gate returns to a signalable state.
7. Open the workflow editor. Verify phase display matches execution order.
   - Phase 0 group contains the two parallel steps. Phase 1 group contains the sequential follow-up.
   - `.wf-phase-group` containers are ordered by phase number.
8. Save a workflow with non-contiguous phase numbers (e.g. Phase 0 and Phase 2, skipping 1).
   - On save, phases are **compacted** — renumbered to 0 and 1 with no gaps.
   - Reload the editor: `.wf-phase-header` labels show "Phase 0" and "Phase 1".
9. Create a workflow with steps that have no `phase` field.
   - All steps default to **Phase 0**.
   - The editor shows a single `.wf-phase-group` with a "Phase 0" header containing all steps.

**Coverage:** workflow-editor-phases.spec.ts (phase grouping display, phase compaction on save, empty phase removal, default phase assignment, save/reload persistence)
