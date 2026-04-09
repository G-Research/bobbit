# Roles

## R-01: View roles list

**Preconditions:** App loaded.

**Steps:**
1. Navigate to #/roles

**Expected:**
- All roles listed (builtin + server + project overrides)
- Each role shows origin badge (grey=builtin, blue=server, green=project)
- Inherited roles at 70% opacity
- Project scope row visible if multiple projects

**Coverage:** `tests/e2e/ui/config-scope.spec.ts` — partial (scope row, badges).

---

## R-02: Create a custom role

**Preconditions:** On roles page.

**Steps:**
1. Click "New Role" button
2. Fill in name, label, prompt
3. Configure tool policies (optional)
4. Save

**Expected:**
- Role appears in list with server or project origin
- Role is available in session role picker
- Role YAML written to config directory

**Coverage:** `tests/e2e/roles-api.spec.ts` (API CRUD). No UI create test.

---

## R-03: Edit an existing role

**Preconditions:** Custom role exists.

**Steps:**
1. Click role in list
2. Edit page loads with current values
3. Modify prompt or policies
4. Save

**Expected:**
- Changes persisted to YAML
- Existing sessions using this role unaffected
- New sessions pick up changes

**Coverage:** `tests/e2e/roles-api.spec.ts` (API PUT). No UI edit test.

---

## R-04: Delete a custom role

**Preconditions:** Custom role exists (not builtin).

**Steps:**
1. Click role in list
2. Click Delete button
3. Confirm

**Expected:**
- Role removed from list
- YAML file deleted
- Cannot select deleted role for new sessions
- Existing sessions unaffected

**Coverage:** `tests/e2e/roles-api.spec.ts` (API DELETE). No UI delete test.

---

## R-05: Customize a builtin role (project override)

**Preconditions:** Builtin role exists, multiple projects registered.

**Steps:**
1. Navigate to roles page with project scope selected
2. Click "Customize" on a builtin role
3. Modify the prompt
4. Save

**Expected:**
- Override created at project level
- Role shows green origin badge
- Project sessions use override
- Other projects still see builtin

**Coverage:** `tests/e2e/config-cascade-api.spec.ts` (API customize). `tests/e2e/ui/config-scope.spec.ts` (partial UI).

---

## R-06: Revert a role override

**Preconditions:** Project-level override exists for a role.

**Steps:**
1. Click "Revert" on the overridden role
2. Confirm

**Expected:**
- Override deleted
- Role reverts to inherited value (builtin or server)
- Origin badge changes back
- Opacity returns to 70% (inherited)

**Coverage:** `tests/e2e/config-cascade-api.spec.ts` (API revert). No UI revert test.

---

## R-07: Role used in session creation

**Preconditions:** Custom role exists.

**Steps:**
1. Click role picker dropdown on New Session button
2. Select custom role
3. Create session

**Expected:**
- Session created with custom role's prompt
- Tool policies from role applied
- Context bar may show role indicator

**Coverage:** None — role picker flow untested.

---

## R-08: Config cascade affects goal team

**Preconditions:** Goal with team, role customized at project level.

**Steps:**
1. Team spawns agent with a role
2. Role resolves through cascade (project > server > builtin)

**Expected:**
- Agent gets project-level role override
- Role prompt includes project customizations
- This is the bug path where cascade broke goal creation

**Coverage:** None — cascade effect on team roles untested.
