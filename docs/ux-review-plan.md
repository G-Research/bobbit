# Bobbit Specification Framework

## The Goal

A specification of every user flow in Bobbit, written in plain language, that:
- Translates directly into automated tests
- Catches regressions when features interact in unexpected ways
- Guides agents building new features ("how should X interact with Y?")
- Enables the pipeline: **bug → find spec → add variation → test → fix → never regress**

## What We Have Now

240 stories across 20 files. Good structure (preconditions → steps → assertions → coverage). But three problems:

1. **Stories mix user behavior with implementation details** — CSS classes, API calls, component internals leak into assertions
2. **Cross-feature interactions are implicit** — nothing documents "draft must survive X, Y, Z" as a contract
3. **Variation coverage is spotty** — PI-04 tests draft across session switch but not model/personality change

## The Transformation, By Example

---

### Example 1: Cleaning a story (PI-04 → PI-04 revised)

**Current PI-04** (excerpt):
```markdown
9. Add an attachment to session B (don't send). Switch to session A and back.
   - Session B's draft includes both "draft B" text and the attachment tile.
   - Attachments are part of the draft and are preserved.

**Coverage:** covered (message-editor-queue.spec.ts, draft-api.spec.ts)
```

Problems: "attachment tile" is UI jargon. Coverage doesn't say which steps are tested. No mention of what triggers could break drafts.

**Revised PI-04:**
```markdown
## PI-04: Draft preservation across sessions

**Preconditions:** Two sessions exist (A and B). Both are idle.

**Steps:**
1. In session A, type "draft A" without sending.
   - The typed text remains in the input area.
2. Switch to session B. Type "draft B" without sending.
   - "draft B" is visible. Session A's text is not.
3. Switch back to session A.
   - Input area shows "draft A" exactly as typed.
4. Switch back to session B.
   - Input area shows "draft B" exactly as typed.
5. Reload the page. Navigate to session A.
   - "draft A" is restored in the input area.
6. Navigate to session B.
   - "draft B" is restored.
7. In session A, send "draft A".
   - Input area clears. Draft is gone.
8. Switch away and back to session A.
   - Input area is empty.
9. In session B, attach a file without sending. Switch away and back.
   - Both "draft B" and the attached file are preserved.

**Contracts:** CT-02

**Coverage:**
- steps 1-8: message-editor-queue.spec.ts, draft-api.spec.ts
- step 5-6 (reload): e2e/ui/queue-ui.spec.ts ("story 22")
- step 9: message-editor-attach.spec.ts
```

What changed:
- Removed "attachment tile," "px-4 pt-3 container" — those are test/implementation details
- Structured coverage per-step so gaps are visible
- Added contract reference (CT-02 — see below)

---

### Example 2: Writing a contract (CT-02)

No contract exists for draft preservation. The stories cover session-switch, but an agent adding a new feature (say, a personality picker) has no way to know it could break drafts. This is the gap contracts fill.

```markdown
## CT-02: Draft preservation across context changes

**What it guarantees:**
Any text (and attachments) the user has typed but not sent in a session's
input area survives all of the following without loss:

- Switching to another session and back (PI-04 steps 1-4)
- Page reload (PI-04 steps 5-6)
- Model selector change (PI-04d — to be written)
- Personality change (PI-04e — to be written)
- Sidebar collapse/expand
- Agent finishing a response while user is in another session
- WebSocket reconnection after brief disconnect

**What it does NOT guarantee:**
- Draft does not survive session termination (intentional)
- Draft does not survive browser cache clear (stored in sessionStorage)

**Timing constraint:**
Draft save must complete before any navigation away from the session
takes effect. If save is async/debounced, the switch must await it.
(This is the root cause of PI-04b — the rapid-switch race.)

**When to consult this contract:**
Any feature that re-renders the input area, changes session state,
or triggers navigation must verify drafts are preserved.

**Stories:** PI-04, PI-04b, PI-04c, PI-04d, PI-04e
**Tests:** draft-persistence.spec.ts, e2e/ui/draft-loss.spec.ts, e2e/ui/queue-ui.spec.ts
```

Now when an agent builds the personality picker, it sees CT-02 in the feature matrix and knows: "I need to verify that changing personality doesn't clobber the draft." That produces a new sub-story:

```markdown
## PI-04d: Draft preserved across personality change

**Preconditions:** Active session with a personality assigned.

**Steps:**
1. Type "important text" without sending.
2. Change the session's personality via the selector.
   - The personality indicator updates.
   - Input area still shows "important text".
3. Send the message.
   - Agent responds using the new personality's behavior.

**Contracts:** CT-02
**Coverage:** untested
```

That story immediately becomes a test:

```typescript
test("PI-04d: draft preserved across personality change", async ({ page }) => {
  // setup: create session, navigate to it
  const textarea = page.locator("textarea").first();
  await textarea.fill("important text");
  
  // change personality
  await page.click('[data-testid="personality-selector"]');
  await page.click('text=Concise');
  
  // draft survives
  await expect(textarea).toHaveValue("important text");
});
```

---

### Example 3: The bug-to-fix pipeline in action

**Bug report:** "I switched sessions quickly and my draft disappeared."

```
Step 1: FIND THE SPEC
  → PI-04 (draft preservation). Already exists.

Step 2: DOES IT COVER THIS VARIATION?
  → PI-04 covers normal switching (steps 1-4). 
  → PI-04b covers rapid switching specifically. It exists but was
    marked "suspected bug" — check if the test actually validates
    the timing race.

Step 3: EXAMINE THE TEST
  → draft-persistence.spec.ts tests PI-04b by... reading source code
    to check that _flushDraft returns a Promise. That's a code
    inspection test, not a behavioral test. It doesn't actually
    type text, switch fast, and check the draft survived.
    GAP FOUND.

Step 4: WRITE THE REAL TEST
  → E2E test: type text, switch session within 50ms, switch back,
    assert text is present. This is what PI-04b's steps describe
    but no test actually does it.

Step 5: RUN IT → it fails (reproduces the bug)

Step 6: FIX → ensure flush awaits save before allowing switch

Step 7: RUN IT → passes. CI guards it forever.
```

The key insight: the *story* PI-04b already existed and correctly described the bug. But the *test* was a source-code inspection (`expect(source).toContain("await _pendingSave")`) instead of a behavioral test. The framework's rule — "tests verify user-visible behavior, not implementation" — would have caught this mismatch.

---

### Example 4: Feature interaction matrix in action

An agent is building a new "session templates" feature (save/restore session configuration). It consults the matrix:

```markdown
## Features that change session state

**Contracts:** CT-02 (drafts), CT-03 (sidebar highlight), CT-10 (crash recovery)

**Checklist:**
- [ ] Draft is preserved (CT-02)
- [ ] Sidebar reflects the change without full re-render (CT-03)
- [ ] New state survives crash/restart (CT-10)
- [ ] If the feature adds new persisted state, add it to CT-10's inventory
```

The agent now knows three things it must verify without reading all 240 stories.

---

## What Needs to Happen

### Phase 1: Contracts + Matrix (highest leverage)

Write `userstories/contracts.md` (~15 contracts) and `userstories/feature-matrix.md`. This creates the cross-feature connective tissue that doesn't exist today.

### Phase 2: Story cleanup (one file at a time)

For each story file: strip implementation details from assertions, add contract references, structure coverage per-step, add missing variation sub-stories. Start with `prompt-interactions.md` (most user-visible, most variations).

### Phase 3: Test alignment

For each story with "untested" steps or source-inspection-only tests: write real behavioral tests. Priority = contracts first (they protect the most surface area), then high-traffic stories.

### Phase 4: Rules in AGENTS.md

- Every PR references story IDs
- Every bug adds a sub-story before the fix
- New features consult the matrix
- Stories never contain implementation details
