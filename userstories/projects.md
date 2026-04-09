# Projects

## PR-01: Add project (existing .bobbit directory)

**Preconditions:** Directory with .bobbit/ exists.

**Steps:**
1. Click "Add Project" in sidebar
2. Enter or browse to directory path
3. Click Continue

**Expected:**
- Project auto-imported (Path A — no assistant needed)
- Name detected from package.json or directory basename
- Project appears in sidebar with folder
- Sessions/goals scoped to project

**Coverage:** `tests/e2e/ui/add-project-flow.spec.ts`.

---

## PR-02: Add project (new directory, detection mode)

**Preconditions:** Directory has content but no .bobbit/.

**Steps:**
1. Click "Add Project"
2. Enter directory path
3. Click Continue
4. Project assistant session opens
5. Assistant detects tech stack
6. Agent calls propose_project
7. Review form appears
8. Click Accept

**Expected:**
- Provisional project created during assistant session
- Sidebar shows project with "(setting up)" badge
- On accept: project promoted, config written, worktree pool initialized
- Assistant session terminated

**Coverage:** `tests/e2e/ui/project-assistant.spec.ts` — 15 tests. Well-covered.

---

## PR-03: Add project (empty directory, scaffolding)

**Preconditions:** Directory is empty or doesn't exist.

**Steps:**
1. Click "Add Project"
2. Enter empty directory path
3. Scaffolding assistant opens
4. Guide through tech stack selection
5. Accept proposal

**Expected:**
- Directory created if needed
- Project scaffolded with chosen stack
- Config written

**Coverage:** `tests/e2e/ui/project-assistant.spec.ts` — partial.

---

## PR-04: Remove a project

**Preconditions:** Non-default project exists.

**Steps:**
1. Navigate to project settings
2. General tab → Danger Zone
3. Click "Remove Project"
4. Confirm

**Expected:**
- Project removed from sidebar
- Worktree pool drained
- Files on disk not deleted
- Sessions/goals remain but lose project scope
- Navigation returns to system settings

**Coverage:** `tests/e2e/ui/project-removal.spec.ts`.

---

## PR-05: Project settings — commands

**Preconditions:** Project registered.

**Steps:**
1. Click gear icon on project header in sidebar
2. Navigate to Commands & Sandbox tab
3. Edit build/test/typecheck commands
4. Save

**Expected:**
- Commands persisted to project.yaml
- New sessions/goals use updated commands
- Resolved config shows source (project vs system)

**Coverage:** `tests/e2e/ui/settings.spec.ts` — partial.

---

## PR-06: Project settings — models

**Preconditions:** Project settings page.

**Steps:**
1. Navigate to Models tab
2. Set project-specific model preferences
3. Save

**Expected:**
- Model config persisted
- New sessions in this project use project models
- Other projects use system defaults

**Coverage:** `tests/e2e/models-api.spec.ts` (API). No UI test.

---

## PR-07: Project settings — appearance

**Preconditions:** Project settings page.

**Steps:**
1. Navigate to Appearance tab
2. Select palette
3. Set accent colors (light/dark)
4. Save

**Expected:**
- Project sessions use selected palette
- Accent colors applied to project UI elements
- Other projects unaffected

**Coverage:** `tests/e2e/ui/palette-session.spec.ts` — partial.

---

## PR-08: Browse directory dialog

**Preconditions:** Add Project dialog open.

**Steps:**
1. Click Browse button
2. Navigate directory tree
3. Select directory

**Expected:**
- Directory browser shows real filesystem
- Can navigate up/down
- Selected path populates input

**Coverage:** `tests/e2e/ui/add-project-flow.spec.ts`, `tests/e2e/project-detect-browse.spec.ts`.

---

## PR-09: Multi-project sidebar

**Preconditions:** Multiple projects registered.

**Steps:**
1. View sidebar
2. Each project has its own folder/section
3. Sessions and goals grouped under projects

**Expected:**
- Project headers with name and palette color
- Collapse/expand per project
- Gear icon navigates to project settings
- "Add Goal" and "Add Staff" scoped to project

**Coverage:** `tests/e2e/ui/project-management.spec.ts`. `tests/e2e/ui/single-project-sidebar.spec.ts`.

---

## PR-10: Provisional project cleanup

**Preconditions:** Project assistant session active (provisional project).

**Steps:**
1. Terminate assistant session without accepting proposal

**Expected:**
- Provisional project deleted
- Sidebar updated
- No orphaned state

**Coverage:** `tests/e2e/ui/project-assistant.spec.ts`.
