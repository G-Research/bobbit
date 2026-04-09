# Staff User Stories

## ST-01: View staff
**Action:** Navigate to #/staff or view sidebar.
**Expected:** Staff listed with name, description, state (idle/active/terminated), lastWakeAt, currentSessionId. Staff visible in sidebar under project in collapsible Staff section.
**Coverage:** none.

## ST-02: Create staff
**Action:** Click New Staff or sidebar Add Staff.
**Expected:** Fill name, prompt, description, optional triggers, optional cwd. Creates staff agent, appears in sidebar, session created.
**Coverage:** none.

## ST-03: Edit staff
**Action:** Click staff entry, modify prompt/triggers, save.
**Expected:** Changes persisted, behavior updated on next interaction.
**Coverage:** none.

## ST-04: Delete staff
**Action:** Delete staff, confirm.
**Expected:** Removed from list and sidebar, session terminated.
**Coverage:** none.

## ST-05: Staff in sidebar
**Action:** View sidebar.
**Expected:** Staff section under project, collapsible (per-project collapse state in localStorage `bobbit-collapsed-staff`), click opens staff session, active staff show status indicator.
**Coverage:** none.

## ST-06: Staff triggers
**Action:** Trigger condition met.
**Expected:** Staff session receives trigger prompt, processes, responds, status updates.
**Coverage:** none.
