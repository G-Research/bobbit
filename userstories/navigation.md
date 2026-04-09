# Navigation User Stories

## N-01: Sidebar session selection
**Action:** Click sessions in sidebar.
**Expected:** Selected session highlighted, main panel shows session, URL updates to #/session/<id>, previous session disconnected/cached.
**Coverage:** partial.

## N-02: Goal dashboard navigation
**Action:** Click goal in sidebar.
**Expected:** #/goal/<id>, dashboard renders, back button works.
**Coverage:** partial.

## N-03: Deep link
**Action:** Navigate directly to #/settings/system/models or #/roles or #/session/<id>.
**Expected:** Correct view rendered, no blank screen, sidebar reflects location.
**Coverage:** partial.

## N-04: Browser back/forward
**Action:** Navigate through views, use back/forward buttons.
**Expected:** Hash history works, each view renders correctly. configPreviousHash used for config page toggle (pressing same config nav button returns to previous view).
**Coverage:** unit test only.

## N-05: Mobile sidebar
**Action:** Mobile viewport.
**Expected:** Sidebar collapsed by default, hamburger opens it as overlay, selecting item closes sidebar, can re-open.
**Coverage:** minimal (1 test).

## N-06: Sidebar collapse
**Action:** Click project header.
**Expected:** Sections collapse. Persisted in localStorage per-project (`bobbit-collapsed-ungrouped` for sessions, `bobbit-collapsed-staff` for staff). Preserved across navigation and page reload.
**Coverage:** none.

## N-07: Page title
**Action:** Navigate between views.
**Expected:** document.title updates to reflect current view (session name, goal name, "Settings", etc).
**Coverage:** covered (1 test).

## N-08: Cross-feature journey
**Action:** Landing → create session → send message → navigate to goal → dashboard → settings → back to session.
**Expected:** Each view correct, no state corruption, session reconnects after settings detour, no console errors.
**Coverage:** none.
