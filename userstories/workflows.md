# Workflows

## W-01: View workflows list

**Preconditions:** App loaded.

**Steps:**
1. Navigate to #/workflows

**Expected:**
- All workflows listed (builtin + custom)
- Each shows name, description, gate count
- Origin badges

**Coverage:** `tests/e2e/workflows-api.spec.ts` (API). No UI list test.

---

## W-02: View workflow editor

**Preconditions:** Workflow exists.

**Steps:**
1. Click workflow in list
2. Editor opens

**Expected:**
- Visual gate/phase editor
- Gates shown with dependencies
- Verify steps listed per gate
- Can add/remove/reorder gates

**Coverage:** `tests/e2e/ui/workflow-editor-phases.spec.ts` — 8 tests covering phase editing.

---

## W-03: Create a custom workflow

**Preconditions:** On workflows page.

**Steps:**
1. Click "New Workflow"
2. Define gates and dependencies
3. Configure verify steps per gate
4. Save

**Expected:**
- Workflow appears in list
- Available in goal creation workflow picker
- YAML persisted

**Coverage:** `tests/e2e/workflows-api.spec.ts` (API). No UI create test.

---

## W-04: Edit workflow gates

**Preconditions:** Custom workflow exists.

**Steps:**
1. Open workflow in editor
2. Add a new gate
3. Set dependencies
4. Add verify steps (command, LLM review)
5. Save

**Expected:**
- Gate added to workflow
- Dependencies enforced in execution order
- Verify steps run on gate signal

**Coverage:** `tests/e2e/ui/workflow-editor-phases.spec.ts` (editor interactions). API tests for gate logic.

---

## W-05: Delete a custom workflow

**Preconditions:** Custom workflow exists, not in use.

**Steps:**
1. Open workflow
2. Click Delete
3. Confirm

**Expected:**
- Workflow removed from list
- Cannot select for new goals
- Existing goals using it unaffected

**Coverage:** `tests/e2e/workflows-api.spec.ts` (API DELETE). No UI test.

---

## W-06: Workflow selected during goal creation

**Preconditions:** Multiple workflows exist.

**Steps:**
1. Create new goal via assistant
2. In goal preview form, select workflow from dropdown
3. Optional step toggles appear per workflow

**Expected:**
- Dropdown shows all available workflows
- Selecting a workflow updates gate preview
- Optional steps show toggles with tooltip descriptions
- Selected workflow used when goal is created

**Coverage:** `tests/e2e/ui/goal-creation.spec.ts` (partial), `tests/e2e/ui/optional-steps.spec.ts`.

---

## W-07: Customize builtin workflow (override)

**Preconditions:** Builtin workflow, multiple projects.

**Steps:**
1. Select project scope on workflows page
2. Customize builtin workflow
3. Modify gates or verify steps
4. Save

**Expected:**
- Project-level override created
- Project goals use customized workflow
- Other projects see builtin

**Coverage:** API cascade tests. No UI test.

---

## W-08: Workflow phases (verify step ordering)

**Preconditions:** Workflow with multi-phase verification.

**Steps:**
1. Edit workflow
2. Arrange verify steps into phases
3. Steps within a phase run in parallel, phases run sequentially

**Expected:**
- Phase 1 completes before phase 2 starts
- Failed step in earlier phase skips later phases
- Optional steps can be skipped without failing phase

**Coverage:** `tests/e2e/ui/workflow-editor-phases.spec.ts` — phase UI editing.
