# Navigation User Stories

## N-01: Sidebar session selection
**Steps:** Click different sessions in the sidebar.
**Expected:** Selected session highlighted. Content area loads the session. URL updates.
**Coverage:** partial.

## N-02: Goal dashboard navigation
**Steps:** Click a goal in the sidebar.
**Expected:** Goal dashboard loads. Back navigation works.
**Coverage:** partial.

## N-03: Deep links
**Steps:** Navigate directly to a URL like #/settings/system/models or #/roles.
**Expected:** Correct page loads. No blank screen.
**Coverage:** partial.

## N-04: Browser back/forward
**Steps:** Navigate through several views, use browser back/forward buttons.
**Expected:** Each view renders correctly. History navigation works as expected.
**Coverage:** unit test only.

## N-05: Mobile sidebar
**Pre:** Mobile viewport.
**Expected:** Sidebar collapsed by default. Hamburger button opens it. Selecting an item closes it.
**Coverage:** minimal.

## N-06: Sidebar collapse
**Steps:** Click a project header to collapse its section.
**Expected:** Section collapses. State preserved across navigation and page reload. Sessions and staff sections collapse independently.
**Coverage:** none.

## N-07: Page title
**Expected:** Browser tab title reflects the current view (session name, goal name, "Settings", etc.).
**Coverage:** covered.

## N-08: Cross-feature journey
**Steps:** Create a session → send a message → navigate to a goal dashboard → go to settings → return to the session.
**Expected:** Each view renders correctly. No state corruption. The session still works after the detour.
**Coverage:** none.
