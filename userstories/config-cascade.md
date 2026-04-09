# Config Cascade

## CC-01: Three-layer resolution (builtin → server → project)

**Preconditions:** Builtin role exists, server override exists, project override exists.

**Steps:**
1. Query resolved roles for project

**Expected:**
- Project override wins over server override
- Server override wins over builtin
- Each item tagged with correct origin
- Items without overrides show builtin origin

**Coverage:** `tests/e2e/config-cascade-api.spec.ts` — thorough API tests.

---

## CC-02: Cascade UI display

**Preconditions:** Config page (roles/tools/personalities/workflows) loaded.

**Steps:**
1. View items list
2. Note origin badges

**Expected:**
- Grey badge = builtin
- Blue badge = server
- Green badge = project
- Inherited items at 70% opacity
- Overridden items show "overrides: [layer]" indicator

**Coverage:** `tests/e2e/ui/config-scope.spec.ts` — 6 tests. Partial coverage.

---

## CC-03: Customize action

**Preconditions:** Inherited item (builtin or server), project scope selected.

**Steps:**
1. Click "Customize" on inherited item
2. Edit form pre-populated with inherited values
3. Modify and save

**Expected:**
- Override created at selected scope
- Origin badge changes to project/server
- Opacity becomes 100%
- Revert button appears

**Coverage:** API-level (`config-cascade-api.spec.ts`). No UI test for customize flow.

---

## CC-04: Revert action

**Preconditions:** Override exists at project or server level.

**Steps:**
1. Click "Revert" on overridden item
2. Confirm

**Expected:**
- Override deleted
- Item reverts to inherited value
- Badge and opacity update
- Revert button disappears

**Coverage:** API-level. No UI test.

---

## CC-05: Cascade affects session creation

**Preconditions:** Role customized at project level.

**Steps:**
1. Create a session in that project
2. Check which role prompt is used

**Expected:**
- Session gets project-level role override
- Not the builtin or server version

**Coverage:** None — cascade effect on sessions untested.

---

## CC-06: Cascade affects goal creation

**Preconditions:** Workflow customized at project level.

**Steps:**
1. Create a goal in that project
2. Check which workflow gates are created

**Expected:**
- Goal uses project-level workflow override
- Gates match customized workflow
- This is the exact path where builtin workflow resolution broke goal creation

**Coverage:** None — this is a known bug path with no automated test.

---

## CC-07: Scope switching on config pages

**Preconditions:** Multiple projects, config page loaded.

**Steps:**
1. View roles at system scope
2. Switch to project A scope
3. Switch to project B scope

**Expected:**
- Items update to reflect selected scope
- Badges change per scope
- No stale items from previous scope
- Scope selection preserved in URL

**Coverage:** `tests/e2e/ui/config-scope.spec.ts` — partial.
