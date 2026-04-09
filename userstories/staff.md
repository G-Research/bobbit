# Staff

## ST-01: View staff list

**Preconditions:** App loaded.

**Steps:**
1. Navigate to #/staff or view staff section in sidebar

**Expected:**
- All staff agents listed
- Each shows name, description, status (idle/active)
- Staff visible in sidebar under project

**Coverage:** None — staff UI completely untested.

---

## ST-02: Create a staff agent

**Preconditions:** On staff page.

**Steps:**
1. Click "New Staff" or use sidebar "Add Staff" button
2. Fill name, prompt, triggers, CWD
3. Save

**Expected:**
- Staff agent created
- Appears in sidebar under project
- Session created for staff agent
- Can interact with staff session

**Coverage:** None — staff creation untested.

---

## ST-03: Edit staff agent

**Preconditions:** Staff agent exists.

**Steps:**
1. Click staff agent in list
2. Modify prompt or triggers
3. Save

**Expected:**
- Changes persisted
- Staff behavior updated on next interaction

**Coverage:** None.

---

## ST-04: Delete staff agent

**Preconditions:** Staff agent exists.

**Steps:**
1. Click staff agent, then delete
2. Confirm

**Expected:**
- Staff removed from list and sidebar
- Session terminated

**Coverage:** None.

---

## ST-05: Staff agent in sidebar

**Preconditions:** Staff agent exists.

**Steps:**
1. View sidebar
2. Staff section visible under project
3. Click staff agent

**Expected:**
- Staff session opens
- Can send messages
- Staff section collapsible (per-project)

**Coverage:** None.

---

## ST-06: Staff triggers

**Preconditions:** Staff agent with triggers configured.

**Steps:**
1. Trigger condition met (e.g. file change, schedule)
2. Staff agent activates

**Expected:**
- Staff session receives trigger prompt
- Processes and responds
- Status updates in sidebar

**Coverage:** None.
