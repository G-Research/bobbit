# Config Cascade User Stories

## CC-01: Three-layer resolution

**Action:** Builtin, server, and project overrides all exist for the same config item.

**Expected:** Project-level wins over server-level, which wins over builtin. Each item shows where it comes from. Overridden items indicate what they shadow.

**Coverage:** Covered.

---

## CC-02: Cascade UI display

**Action:** Open a config page (Roles, Personalities, Workflows, etc.).

**Expected:**
- Grey badge = builtin origin.
- Blue badge = server origin.
- Green badge = project origin.
- Inherited items appear dimmed.
- Overridden items show an indicator of what they override.

**Coverage:** Partial.

---

## CC-03: Customize a builtin or inherited item

**Steps:**
1. Select project scope.
2. Click Customize on an inherited item.
3. Modify and save.

**Expected:**
- Form pre-populated with the inherited values.
- After save, origin badge changes (e.g. to green for project).
- Item no longer appears dimmed.
- Revert button appears.

**Coverage:** Partial.

---

## CC-04: Revert an override

**Steps:**
1. Click Revert on an overridden item.

**Expected:**
- Override removed.
- Item reverts to the inherited value.
- Badge and dimming update accordingly.

**Coverage:** Partial.

---

## CC-05: Cascade affects sessions

**Preconditions:** Role customized at project level.

**Action:** Create a new session in that project.

**Expected:** The new session uses the customized role, not the builtin or server-level version.

**Coverage:** None.

---

## CC-06: Cascade affects goal creation

**Preconditions:** Workflow customized at project level.

**Action:** Create a new goal in that project.

**Expected:** The new goal uses the customized workflow and its gates.

**Coverage:** None.

---

## CC-07: Scope switching

**Steps:**
1. Open a config page with multiple projects registered.
2. Switch between System, Project A, and Project B scope tabs.

**Expected:**
- Items update to reflect the selected scope.
- Badges change per scope.
- No stale items from the previous scope appear.

**Coverage:** Partial.
