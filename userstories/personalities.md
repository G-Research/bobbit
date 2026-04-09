# Personalities

## P-01: View personalities list

**Preconditions:** App loaded.

**Steps:**
1. Navigate to #/personalities

**Expected:**
- All personalities listed with origin badges
- Config cascade scope row visible if multiple projects

**Coverage:** API-level only (`tests/e2e/personalities.spec.ts`).

---

## P-02: Create a personality

**Preconditions:** On personalities page.

**Steps:**
1. Click "New Personality"
2. Fill name, label, prompt fragment
3. Save

**Expected:**
- Personality appears in list
- Available in team_spawn personality picker
- YAML persisted

**Coverage:** API-level only. No UI create test.

---

## P-03: Edit a personality

**Preconditions:** Custom personality exists.

**Steps:**
1. Click personality in list
2. Modify prompt fragment
3. Save

**Expected:**
- Changes persisted
- New agent spawns use updated prompt

**Coverage:** API-level only. No UI edit test.

---

## P-04: Delete a personality

**Preconditions:** Custom personality exists.

**Steps:**
1. Click personality, then delete
2. Confirm

**Expected:**
- Personality removed from list
- Existing agents using it unaffected

**Coverage:** API-level only. No UI delete test.

---

## P-05: Customize builtin personality (override)

**Preconditions:** Builtin personality, multiple projects.

**Steps:**
1. Select project scope
2. Customize builtin
3. Modify and save

**Expected:**
- Project override created
- Green badge, project sessions use override

**Coverage:** API-level cascade tests. No UI test.

---

## P-06: Personality applied to spawned agent

**Preconditions:** Personality exists, goal with team.

**Steps:**
1. Spawn agent with personality selected
2. Agent receives system prompt

**Expected:**
- Personality prompt fragment appended to agent's system prompt
- Agent behavior reflects personality

**Coverage:** None — personality application untested end-to-end.
