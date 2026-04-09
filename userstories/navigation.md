# Navigation

## N-01: Sidebar session selection

**Preconditions:** Multiple sessions exist.

**Steps:**
1. Click different sessions in sidebar

**Expected:**
- Clicked session highlighted
- Main panel shows session content
- URL hash updates to #/session/{id}
- Previous session disconnected gracefully

**Coverage:** `tests/e2e/ui/navigation.spec.ts` — partial.

---

## N-02: Goal dashboard navigation

**Preconditions:** Goal exists.

**Steps:**
1. Click goal in sidebar
2. Dashboard loads
3. Click back or sidebar item

**Expected:**
- URL changes to #/goal/{id}
- Dashboard renders
- Back navigation works

**Coverage:** `tests/e2e/ui/navigation.spec.ts`.

---

## N-03: Deep link navigation

**Preconditions:** App loaded.

**Steps:**
1. Navigate directly to #/settings/system/models
2. Navigate directly to #/roles
3. Navigate directly to #/session/{valid-id}

**Expected:**
- Each deep link resolves to correct view
- No blank screen or errors
- Sidebar reflects current location

**Coverage:** `tests/e2e/ui/navigation.spec.ts` — partial.

---

## N-04: Browser back/forward

**Preconditions:** Navigated through several views.

**Steps:**
1. Navigate: landing → session → goal → settings
2. Click browser Back button
3. Click Forward button

**Expected:**
- Back returns to previous view
- Forward returns to next view
- State is correct at each step
- No stale data displayed

**Coverage:** Unit tests for back-button-goal. No full navigation chain test.

---

## N-05: Mobile sidebar toggle

**Preconditions:** App loaded at mobile viewport width.

**Steps:**
1. Sidebar is collapsed by default on mobile
2. Click hamburger/toggle button
3. Sidebar opens
4. Click a session
5. Sidebar collapses, session loads

**Expected:**
- Sidebar overlays content on mobile
- Selection closes sidebar
- Can re-open sidebar

**Coverage:** `tests/e2e/ui/mobile-staff-sidebar.spec.ts` — 1 test (staff section). `tests/mobile-header.spec.ts` (unit).

---

## N-06: Sidebar collapse/expand sections

**Preconditions:** Multiple projects with sessions.

**Steps:**
1. Click project header to collapse sessions section
2. Navigate away and back
3. Collapse state preserved

**Expected:**
- Collapsed sections stay collapsed
- Persisted in localStorage per-project
- Staff section independently collapsible

**Coverage:** None — sidebar collapse persistence untested.

---

## N-07: Page title updates

**Preconditions:** Various views.

**Steps:**
1. Navigate to session — title shows session name
2. Navigate to goal — title shows goal name
3. Navigate to settings — title shows "Settings"

**Expected:**
- Document title reflects current view
- Useful for browser tab identification

**Coverage:** `tests/e2e/ui/page-title.spec.ts` — 1 test.

---

## N-08: Cross-feature navigation journey

**Preconditions:** Project with sessions, goals, and config.

**Steps:**
1. Start at landing
2. Create a session, send a message
3. Navigate to goals, create a goal
4. Navigate to dashboard
5. Navigate to settings, change something
6. Navigate back to session
7. Verify session still works

**Expected:**
- Each navigation loads correct view
- No state corruption between views
- Session reconnects cleanly after settings detour
- No console errors throughout

**Coverage:** None — cross-feature navigation journey untested.
