# Search — User Stories

Search allows users to find sessions, goals, messages, and staff across all projects. There are two modes: client-side title filtering (default, instant) and server-side FTS content search (toggled via the Content switch). A full search page provides paginated results with type filtering.

**Architecture:** Server-side SQLite FTS5 index (`search.db`) indexes goals (title + spec), sessions (title + role + goal title), messages (text content + tool names), and staff (name + description). Index is rebuilt from stores on startup if missing or schema-mismatched. Incremental indexing occurs as messages stream in. Client-side search filters sidebar items by title without an API call.

---

## SR-01: Sidebar title search (default mode)

**Preconditions:** Multiple sessions and goals exist with distinct titles. Content mode toggle is OFF (default).

**Steps and expectations:**
1. Click the search input in the sidebar (or press Ctrl+K / Cmd+K).
   - Search input focuses. Placeholder shows "Search... (Ctrl+K)" or "Search... (⌘K)" on Mac.
   - No controls row visible yet (content toggle, Full Search link hidden when query is empty).
2. Type "deploy" into the search input.
   - Controls row appears below the input (content toggle + "Full Search" link).
   - Sidebar filters instantly (no API call, no loading spinner) — only sessions and goals whose titles contain "deploy" (case-insensitive) are visible.
   - Goals that match show their child sessions. Goals whose child session titles match also appear.
   - Staff entries that match by name are visible.
   - Non-matching items are hidden from the sidebar.
   - Archived section (if open) also filters by title.
3. Modify the query to "deployx" (no matches).
   - Sidebar shows no sessions, no goals, no staff. No explicit "no results" message in the sidebar (items are simply hidden).
4. Clear the input (click X button or select all + delete).
   - All sessions and goals reappear in the sidebar.
   - Controls row hides (empty query).
   - If the archived section was auto-opened by search, it auto-closes.
5. Press Escape while the search input is focused.
   - Input clears. Focus leaves the input (blur).
   - Sidebar restores to unfiltered state.
6. Type a query, then navigate to a session by clicking it in the filtered sidebar.
   - Session opens. Search query remains in the input (not cleared on navigation).
   - Sidebar continues to show filtered results.

**Coverage:** none

---

## SR-02: Content search mode (FTS)

**Preconditions:** Multiple sessions with messages containing the word "kubernetes". Content mode is initially OFF.

**Steps and expectations:**
1. Type "kubernetes" in the search input.
   - Sidebar filters by title only (default mode). Sessions whose titles don't contain "kubernetes" are hidden — even if their messages do.
2. Click the "Content" toggle switch below the search input.
   - Toggle turns on (primary color background).
   - Loading spinner appears in the search icon position.
   - An API call fires to `GET /api/search?q=kubernetes`.
3. Results return.
   - Spinner stops. `<search-results>` component appears below the search input, replacing the session list.
   - Results are grouped by type: Goals, Sessions, Messages — each with a header, icon, and count.
   - Each result shows: title (bold), archived badge (if applicable), relative timestamp, and a snippet with `<b>` match highlighting.
   - Message results show the session title (not the message ID).
   - Sidebar items also filter to show only matching sessions/goals/staff (via `searchMatchIds`).
4. Click a goal result.
   - Navigates to the goal dashboard (`result-click` event with `type: "goal"`).
5. Click a session result.
   - Navigates to that session.
6. Click a message result.
   - Navigates to the session containing that message (`sessionId` from the result).
7. Toggle Content mode OFF.
   - `<search-results>` disappears. Sidebar reverts to title-only filtering.
   - No API call made — client-side filter applies immediately.
8. Toggle Content mode ON again with the same query.
   - API call fires again. Fresh results displayed.

**Coverage:** none

---

## SR-03: Full search page

**Preconditions:** Sessions and goals exist across multiple projects.

**Steps and expectations:**
1. Type a query in the sidebar search, then click "Full Search" link.
   - Navigates to `#/search?q=<query>`.
   - Full search page renders with: search input (pre-filled), type filter tabs (All, Goals, Sessions, Messages), and results area.
2. Results display grouped by type with the same format as sidebar content search (title, snippet with highlights, timestamp, archived badge).
   - Each result shows its project name (if multi-project).
3. Click a type tab (e.g. "Messages").
   - Results filter to show only messages.
   - API re-fetches with `type=messages` parameter.
   - Result count updates.
4. Scroll to the bottom of results.
   - If more results exist, a "Load more" button or infinite scroll triggers.
   - Additional results append via `offset` pagination.
5. Modify the query in the full search page input.
   - Results update after debounce.
   - URL updates to reflect the new query (`history.replaceState`).
6. Navigate directly to `#/search?q=someterm` via URL.
   - Full search page loads with the query pre-filled and results displayed.
7. Click a result on the full search page.
   - Navigates to the corresponding session, goal, or staff item.

**Coverage:** none

---

## SR-04: Search across projects

**Preconditions:** Two projects registered (Project A and Project B), each with sessions and goals.

**Steps and expectations:**
1. Type a query that matches items in both projects.
   - Sidebar title filter shows matching items from both projects (items are grouped under their project headers as usual).
2. Enable Content mode.
   - FTS results include matches from both projects.
   - Each result includes `projectName` in the display.
3. On the full search page, results from both projects appear.
   - Project name is shown on each result to disambiguate.
4. If a project filter is applied (e.g. via `projectId` query param), only that project's results appear.

**Coverage:** none

---

## SR-05: Empty and edge-case searches

**Preconditions:** Active app with sessions and goals.

**Steps and expectations:**
1. Enable Content mode. Search for a query that matches nothing.
   - Loading spinner appears briefly.
   - "No matches for '<query>'" message displays in the results area.
   - No errors in console. No crash.
2. Search for a single character "a".
   - Results return (FTS5 prefix matching: `a*` matches any word starting with "a").
   - Results are reasonable — not every entry in the database.
3. Search for special characters: `"deploy:prod"`, `hello-world`, `path/to/file`.
   - FTS5 query sanitiser wraps tokens in double quotes. No FTS5 syntax error.
   - Results match the literal terms (quotes stripped, hyphens/colons/slashes treated as word separators).
4. Search for a very long query (500+ characters).
   - No crash. API returns results or empty set.
5. Search with leading/trailing whitespace: `  deploy  `.
   - Whitespace is trimmed. "deploy" results appear normally.
6. Clear the search input. No search-results component visible. Sidebar shows all items.
7. Type a query, wait for content results, then rapidly type a different query.
   - Stale responses are discarded (guard: `state.searchQuery !== query`).
   - Only the final query's results display.

**Coverage:** none

---

## SR-06: Keyboard shortcut (Ctrl+K / Cmd+K)

**Preconditions:** App is loaded. User is in any view (session, dashboard, settings).

**Steps and expectations:**
1. Press Ctrl+K (Cmd+K on Mac).
   - Search input in the sidebar focuses immediately.
   - If the sidebar is collapsed (mobile), it should open or the mobile search should focus.
2. Type a query and press Enter.
   - Nothing special happens on Enter (search is live/debounced, not submit-on-enter).
3. Press Escape.
   - Search clears and input blurs.
4. Press Ctrl+K again.
   - Input re-focuses. Previous query is cleared (from the Escape).
5. While a dialog is open (e.g. settings), press Ctrl+K.
   - Search input should focus (keyboard shortcut is global via `document.addEventListener`).
   - If this conflicts with dialog focus, the dialog should close first or the shortcut should be suppressed.

**Coverage:** none

---

## SR-07: Search result navigation and context preservation

**Preconditions:** Content mode ON. Search returns results across goals, sessions, and messages.

**Steps and expectations:**
1. Search for "deploy". Results show 2 goals, 3 sessions, 5 messages.
2. Click a message result that belongs to session X.
   - App navigates to session X.
   - The search query remains in the sidebar search input.
   - Sidebar still shows filtered results.
3. Press Ctrl+K and modify the query.
   - Results update. Previous session stays open in the main panel.
4. Click a different result (a goal).
   - Goal dashboard opens.
5. Press browser Back button.
   - Returns to the previous session.
6. Clear the search.
   - Sidebar shows all items again. The current session/goal view is unaffected.

**Coverage:** none

---

## SR-08: Archived items in search

**Preconditions:** Some sessions and goals are archived. Archived section is initially collapsed in the sidebar.

**Steps and expectations:**
1. Type a query that matches an archived session's title.
   - In title-filter mode: the archived section auto-opens to show the matching archived item.
   - A flag tracks that archived was opened by search (`_archivedBySearch`).
2. Clear the search.
   - Archived section auto-closes (reverts to its state before search opened it).
3. Enable Content mode. Search for text that exists in an archived session's messages.
   - Archived results appear in the `<search-results>` component with an archive badge icon.
   - Sidebar archived section auto-opens if matching archived items exist.
4. Click an archived result.
   - The archived session or goal opens (read-only if applicable).
5. Manually open the archived section, then search.
   - Archived section stays open (it was opened manually, not by search).
   - Clearing the search does NOT auto-close it.

**Coverage:** none

---

## SR-09: Index rebuild and incremental indexing

**Preconditions:** Server is running with existing sessions and goals.

**Steps and expectations:**
1. Search for a message that exists in a session's chat history.
   - Content search returns the message with a snippet. Index was built on startup.
2. Send a new message in a session containing the word "flamingo".
   - As the agent streams its response, messages are incrementally indexed (`indexMessage` called from `handleAgentLifecycle`).
3. Search for "flamingo" in content mode.
   - The new message appears in results without a server restart.
4. Create a new goal titled "Flamingo Migration".
   - Goal is indexed on creation.
5. Search for "flamingo" — both the message and the goal appear.
6. Delete the search index file (`<project-root>/.bobbit/state/search.db`).
7. Restart the server.
   - The index is rebuilt automatically from stores (`rebuildFromStores` triggered by `needsRebuild()`).
   - Console shows: `[search] Rebuilding index: N goals, M sessions, K messages, J staff`.
8. Search works again — all previously indexed content is available.

**Coverage:** none

---

## SR-10: Search debounce and performance

**Preconditions:** Large project with many sessions (50+).

**Steps and expectations:**
1. Type rapidly in the search input: "d", "de", "dep", "depl", "deplo", "deploy".
   - In title mode: sidebar filters update on each keystroke (instant, no debounce needed for client-side).
   - In content mode: API calls are debounced (200ms). Only 1-2 API calls fire, not 6.
   - Loading spinner shows during the API call.
   - No duplicate results or flickering.
2. The final results correspond to the full query "deploy", not an intermediate one.
3. Switching from Content mode to title mode mid-debounce cancels the pending API call.
   - No stale content results appear.

**Coverage:** none

---

## SR-11: Mobile search

**Preconditions:** Mobile viewport (or narrow browser window where sidebar becomes an overlay).

**Steps and expectations:**
1. The search input is present in the mobile sidebar/drawer.
   - Rendered via the mobile layout in `render.ts` (separate `<search-box>` instance).
2. Type a query.
   - Title filtering works (instant).
3. Enable Content mode.
   - FTS results appear in the `<search-results>` component within the mobile sidebar.
4. Click a result.
   - Session/goal opens. Mobile sidebar closes.
5. Ctrl+K / Cmd+K may not be relevant on mobile (no physical keyboard), but the search input is directly accessible.

**Coverage:** none

---

## SR-12: Staff search

**Preconditions:** At least one staff member exists (active, not retired).

**Steps and expectations:**
1. Search by staff name in title mode.
   - Matching staff entries appear in the sidebar.
2. Enable Content mode. Search for text in a staff member's description.
   - Staff results appear in the results grouped under a "Staff" section (if the component supports it — currently staff is not shown in SearchResults groups, only in sidebar filtering).
3. Click a staff result.
   - Navigates to the staff member's session or detail view.
4. Retired staff members are filtered out of sidebar results.

**Coverage:** none
