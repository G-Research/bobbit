# Settings

## SET-01: Navigate to system settings

**Preconditions:** App loaded.

**Steps:**
1. Click gear icon (system) in sidebar

**Expected:**
- Settings page loads
- System scope selected
- All tabs visible: General, Models, Shortcuts, Maintenance, etc.

**Coverage:** `tests/e2e/ui/settings.spec.ts`.

---

## SET-02: Navigate to project settings

**Preconditions:** Multiple projects registered.

**Steps:**
1. Click gear icon on project header

**Expected:**
- Settings page loads with project scope
- Project-specific tabs: Commands & Sandbox, Models, Config Dirs, Appearance
- Scope row shows System + project tabs

**Coverage:** `tests/e2e/ui/settings.spec.ts` — partial.

---

## SET-03: Edit system settings

**Preconditions:** System settings page.

**Steps:**
1. Modify a setting (e.g. default model)
2. Save

**Expected:**
- Setting persisted
- Affects all projects without overrides
- Per-project resolved config shows "system" source

**Coverage:** `tests/e2e/ui/settings.spec.ts`.

---

## SET-04: Per-project config override

**Preconditions:** Project settings page.

**Steps:**
1. Set a project-level value (e.g. build command)
2. Save
3. Check resolved config

**Expected:**
- Project value overrides system default
- Resolved config API shows { value, source: "project" }
- Other projects unaffected

**Coverage:** `tests/e2e/per-project-config-dirs.spec.ts` (API). Partial UI.

---

## SET-05: Maintenance — orphaned worktrees

**Preconditions:** Settings → Maintenance tab.

**Steps:**
1. Click "Scan" for orphaned worktrees
2. Review list
3. Click "Clean Up"

**Expected:**
- Scan shows worktrees with no matching session
- Clean up removes them
- Confirmation shown

**Coverage:** `tests/e2e/ui/maintenance.spec.ts` — 7 tests.

---

## SET-06: Maintenance — orphaned sessions

**Preconditions:** Settings → Maintenance tab.

**Steps:**
1. Click "Scan" for orphaned sessions
2. Review list
3. Click "Clean Up"

**Expected:**
- Shows non-interactive sessions with no tracking
- Clean up terminates them

**Coverage:** `tests/e2e/ui/maintenance.spec.ts`.

---

## SET-07: Maintenance — expired archives

**Preconditions:** Settings → Maintenance tab.

**Steps:**
1. Click "Scan" for expired archives
2. Review list
3. Click "Purge"

**Expected:**
- Shows archived sessions past retention
- Purge deletes session data

**Coverage:** `tests/e2e/ui/maintenance.spec.ts`.

---

## SET-08: Config directories

**Preconditions:** Project settings → Config Directories tab.

**Steps:**
1. Add a config directory path
2. Save

**Expected:**
- Directory added to project's config_directories
- Skills, MCP servers, agent files discovered from new directory
- Other projects unaffected

**Coverage:** `tests/e2e/per-project-config-dirs.spec.ts` (API). No UI test.

---

## SET-09: Settings persists across navigation

**Preconditions:** On settings page.

**Steps:**
1. Change a setting
2. Save
3. Navigate to a session
4. Navigate back to settings

**Expected:**
- Changed setting still shows new value
- Scope and tab selection preserved in URL hash

**Coverage:** None — settings persistence across navigation untested.
