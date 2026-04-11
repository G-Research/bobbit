# Navigation — User Stories

Hash-based routing, sidebar interactions, deep links, browser history, keyboard shortcuts, mobile behavior, and page title. The sidebar and URL bar are the primary navigation surfaces.

---

## N-01: Sidebar session selection

**Preconditions:** At least two sessions exist (session A and session B). Sidebar is expanded.

**Steps and expectations:**
1. Click session A in the sidebar session list.
   - Session A row highlights (active background style).
   - URL updates to `#/session/<sessionA-id>`.
   - Content area shows session A's chat view with textarea visible.
2. Click session B in the sidebar.
   - Session B row highlights. Session A row loses highlight.
   - URL updates to `#/session/<sessionB-id>`.
   - Content area shows session B's chat — messages, textarea, and context bar reflect session B.
3. Reload the page (F5) while on session B.
   - URL remains `#/session/<sessionB-id>`.
   - Session B reloads and is selected in the sidebar.
   - Textarea is visible and focused.
4. Click the same session that is already selected (session B).
   - No navigation occurs. No flicker. URL stays the same.
5. While a session is selected, observe the sidebar:
   - The selected session row has a visually distinct background (`bg-secondary` or equivalent).
   - Non-selected session rows have no active background.

**Coverage:** covered (navigation.spec.ts — deep-link to session view, session to settings and back)

---

## N-02: Goal dashboard navigation

**Preconditions:** At least one goal exists with a title (e.g. "My Test Goal"). At least one session exists.

**Steps and expectations:**
1. Click the goal entry in the sidebar.
   - URL updates to `#/goal/<goal-id>`.
   - Content area shows the goal dashboard with the goal title "My Test Goal" visible.
   - Sidebar goal row is highlighted.
2. Click a session in the sidebar while on the goal dashboard.
   - URL updates to `#/session/<session-id>`.
   - Content area switches to the session chat view.
   - Goal row loses highlight; session row gains highlight.
3. Press the browser Back button.
   - URL returns to `#/goal/<goal-id>`.
   - Goal dashboard re-renders with the goal title visible.
4. Press the browser Forward button.
   - URL returns to `#/session/<session-id>`.
   - Session chat view re-renders.
5. Navigate to a goal that does not exist (manually set URL to `#/goal/nonexistent-uuid`).
   - The app handles the missing goal gracefully — no crash, no blank screen. Landing view or error state shown.

**Coverage:** covered (navigation.spec.ts — navigate to goal dashboard via deep link, back navigation works)

---

## N-03: Deep links

**Preconditions:** App is loaded. At least one session and one goal exist.

**Steps and expectations:**
1. Navigate directly to `#/session/<valid-session-id>` (paste in address bar or open as URL).
   - Session view loads. Textarea is visible. Sidebar highlights the session.
2. Navigate directly to `#/goal/<valid-goal-id>`.
   - Goal dashboard loads. Goal title is visible.
3. Navigate directly to `#/settings/system/models`.
   - Settings page loads. The "Models" tab is active within the system scope.
4. Navigate directly to `#/roles`.
   - Roles list page loads.
5. Navigate directly to `#/tools`.
   - Tools list page loads.
6. Navigate directly to `#/workflows`.
   - Workflows list page loads.
7. Navigate directly to `#/staff`.
   - Staff list page loads.
8. Navigate directly to `#/personalities`.
   - Personalities list page loads.
9. Navigate directly to `#/search?q=hello`.
   - Search view loads with "hello" pre-filled as the search query.
10. Navigate to an invalid hash (e.g. `#/nonexistent/route`).
    - App falls through to the landing view. No crash, no blank screen.
11. Navigate to `#/` or empty hash.
    - Landing view is shown (no session selected, no config page).

**Coverage:** covered (navigation.spec.ts — deep-link to session view, navigate to goal dashboard via deep link; page-title.spec.ts)

---

## N-04: Browser back and forward

**Preconditions:** App is loaded with at least one session.

**Steps and expectations:**
1. Start at landing (`#/`).
2. Click a session in the sidebar → URL becomes `#/session/<id>`.
3. Click the Settings button → URL becomes `#/settings/...`.
4. Press browser Back.
   - URL returns to `#/session/<id>`. Session chat view renders with textarea visible.
5. Press browser Back again.
   - URL returns to `#/`. Landing view renders.
6. Press browser Forward.
   - URL returns to `#/session/<id>`. Session chat view renders.
7. Press browser Forward again.
   - URL returns to `#/settings/...`. Settings page renders.
8. Rapidly press Back 3 times in quick succession.
   - Each navigation resolves correctly. No intermediate views flash. Final state matches the expected history position.
9. Navigate: landing → session → goal dashboard → settings → session.
   - Press Back: returns to settings.
   - Press Back: returns to goal dashboard (goal title visible).
   - Press Back: returns to session (textarea visible).
   - Press Back: returns to landing.
   - History stack is fully intact across view types.

**Coverage:** covered (navigation.spec.ts — session to settings and back, back navigation works)

---

## N-05: Mobile sidebar behavior

**Preconditions:** Viewport is mobile-sized (e.g. 375×667).

**Steps and expectations:**
1. Load the app at mobile viewport width.
   - Sidebar is collapsed by default (mobile default).
   - Main content area takes full width.
   - The expand button (hamburger / `PanelLeftOpen` icon, `title="Expand sidebar (Ctrl+[)"`) is visible.
2. Tap the expand button.
   - Sidebar slides open, overlaying the content area.
   - Session list, goal list, and bottom buttons (Settings, Collapse) are visible.
3. Tap a session in the sidebar.
   - Session view loads in the content area.
   - URL updates to `#/session/<id>`.
   - Sidebar auto-collapses after selection (mobile UX pattern).
4. Tap the expand button again. Tap "Settings".
   - Settings page loads. Sidebar collapses.
5. With sidebar open, tap outside the sidebar (on the content area).
   - Sidebar collapses. No navigation change.
6. Resize viewport from mobile (375px) to desktop (1280px) while sidebar is collapsed.
   - Sidebar respects the stored `bobbit-sidebar-collapsed` localStorage state rather than auto-expanding.

**Coverage:** partial (navigation.spec.ts covers collapse/expand; no dedicated mobile viewport test)

---

## N-06: Sidebar collapse persistence

**Preconditions:** App is loaded at desktop viewport (≥768px). Sidebar is expanded (default state).

**Steps and expectations:**
1. Click the Collapse button (`title="Collapse sidebar (Ctrl+[)"`).
   - Sidebar collapses to a narrow icon strip.
   - Collapse button disappears. Expand button (`title="Expand sidebar (Ctrl+[)"`) appears.
   - `localStorage` key `bobbit-sidebar-collapsed` is set to `"true"`.
2. Reload the page (F5).
   - Sidebar is still collapsed (state persisted via localStorage).
   - Expand button is visible.
3. Click the Expand button.
   - Sidebar expands to full width (~240px).
   - Expand button disappears. Collapse button reappears.
   - `localStorage` key `bobbit-sidebar-collapsed` is set to `"false"`.
4. Reload the page.
   - Sidebar is expanded (state persisted).
5. Navigate between sessions, goals, and settings while sidebar is collapsed.
   - Sidebar remains collapsed across all view transitions. Collapse state is independent of route.
6. Open a new browser tab to the same app URL.
   - New tab reads `bobbit-sidebar-collapsed` from localStorage and starts with the matching sidebar state.

**Coverage:** covered (navigation.spec.ts — sidebar collapse and expand)

---

## N-07: Page title

**Preconditions:** App is loaded with at least one project registered (e.g. project named "MyApp").

**Steps and expectations:**
1. On any view with an active project, check `document.title`.
   - Title reads `"MyApp · Bobbit"` (project name, interpunct, "Bobbit").
2. If no project is active (or no projects registered), check `document.title`.
   - Title reads `"Bobbit"`.
3. Switch between projects (if multi-project is configured).
   - Title updates to reflect the newly active project name.
4. Navigate between sessions, goals, settings, and landing.
   - Title always follows the pattern `"<activeProjectName> · Bobbit"` — it does not change per view, only per active project.

**Coverage:** covered (page-title.spec.ts — shows active project name with interpunct and Bobbit)

---

## N-08: Keyboard shortcuts for navigation

**Preconditions:** App is loaded, at least two sessions exist, sidebar is expanded.

**Steps and expectations:**
1. Press `Ctrl+[` (or `Cmd+[` on macOS).
   - Sidebar collapses. Expand button appears.
2. Press `Ctrl+[` again.
   - Sidebar expands. Collapse button appears.
3. Press `Ctrl+,` (or `Cmd+,` on macOS).
   - Settings page opens. URL changes to `#/settings/...`.
4. Press `Ctrl+,` again (toggle behavior via `toggleSettings`).
   - Settings page closes. URL returns to the previous view (session, landing, etc.).
5. Press `Ctrl+K` (or `Cmd+K` on macOS).
   - Sidebar search input focuses. Cursor is in the search box, ready for typing.
6. Type a query in the search box and press Escape.
   - Search input blurs. Focus returns to the main content area.
7. Press `Ctrl+ArrowUp`.
   - Previous session in the ordered list is selected. URL updates. Content switches.
8. Press `Ctrl+ArrowDown`.
   - Next session in the ordered list is selected. URL updates. Content switches.
9. Press `Ctrl+ArrowUp` repeatedly past the first session.
   - Wraps to the last session (circular navigation).
10. Press `Ctrl+ArrowDown` repeatedly past the last session.
    - Wraps to the first session (circular navigation).
11. Press `Ctrl+T` (or `Alt+N`).
    - A new session is created and connected. URL updates to the new session.
12. Press `Ctrl+/`.
    - Message textarea focuses (if a session view is active).
13. All navigation shortcuts (`Ctrl+[`, `Ctrl+,`, `Ctrl+ArrowUp`, `Ctrl+ArrowDown`, `Ctrl+T`, `Ctrl+/`) work even when the textarea has focus (`allowInInput: true`).
    - The shortcut fires instead of typing the character.

**Coverage:** partial (navigation.spec.ts tests sidebar collapse button clicks; keyboard shortcut E2E tests not yet comprehensive)

---

## N-09: Cross-feature navigation journey

**Preconditions:** App is loaded with at least one session, one goal, and one project.

**Steps and expectations:**
1. Start at landing view (`#/`).
   - No session selected. Sidebar visible with session list, goal list.
2. Click a session in the sidebar.
   - Session chat loads. Textarea visible. URL: `#/session/<id>`.
3. Type "hello" in the textarea and press Enter.
   - Message sends. Agent response streams. Chat is active.
4. Click a goal in the sidebar.
   - Goal dashboard loads. URL: `#/goal/<goal-id>`. Goal title visible.
5. Click "Settings" in the sidebar (or press `Ctrl+,`).
   - Settings page loads. URL: `#/settings/...`.
6. Navigate to Roles via `#/roles`.
   - Roles list page loads.
7. Press browser Back.
   - Returns to Settings.
8. Press browser Back.
   - Returns to goal dashboard. Goal title still visible.
9. Press browser Back.
   - Returns to session. Chat messages (including "hello" and the agent response) are still visible. Textarea is focused.
10. Press browser Back.
    - Returns to landing.
11. Throughout the journey:
    - No blank screens at any transition.
    - No JavaScript errors in the console.
    - Sidebar highlight tracks the current view at each step.
    - Page title remains `"<ProjectName> · Bobbit"` throughout.

**Coverage:** partial (navigation.spec.ts covers individual transitions; no single end-to-end journey test)

---

## N-10: Settings sub-navigation

**Preconditions:** App is loaded with at least one project registered.

**Steps and expectations:**
1. Navigate to `#/settings/system/general`.
   - Settings page loads. System scope is selected. "General" tab is active.
2. Click the "Models" tab.
   - URL updates to `#/settings/system/models`.
   - Models tab content renders. General tab is no longer active.
3. Switch to a project scope (click the project name in the settings scope selector).
   - URL updates to `#/settings/<project-id>/general` (or whichever tab is active).
   - Settings content reflects project-level overrides.
4. Click the "Maintenance" tab.
   - URL updates to `#/settings/<project-id>/maintenance`. Maintenance content renders.
5. Press browser Back.
   - Returns to the previous settings tab/scope.
6. Press browser Back until exiting settings entirely.
   - Returns to the view that was active before opening settings (session, landing, etc.).
7. Navigate directly to `#/settings` (no scope, no tab).
   - Settings page loads with a default scope and tab selected (system/general).
8. Navigate to `#/settings/shortcuts` (legacy format — tab only, no scope).
   - Interpreted as `#/settings/system/shortcuts`. Shortcuts tab renders under system scope.

**Coverage:** partial (navigation.spec.ts tests session-to-settings round trip; no sub-tab navigation tests)
