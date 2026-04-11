# Search — User Stories

Search has two modes:

- **Filter mode** (default): If the search string matches anything visible in the sidebar — goal names, session titles, staff names, agent names — it remains visible. Everything else is hidden. Instant, client-side, no API call.
- **Full search mode**: Matches everything Filter mode matches, PLUS content that isn't visible in the sidebar — goal specs, user prompts, agent responses, staff prompts/instructions, gate content (e.g. design specs). Uses SQLite FTS5. API call required.

**Architecture:** Server-side SQLite FTS5 index (`search.db`) indexes goals (title + spec), sessions (title + role + goal title), messages (text content + tool names), and staff (name + description). Index is rebuilt from stores on startup if missing or schema-mismatched. Incremental indexing occurs as messages stream in.

---

## SR-01: Filter mode — sidebar filtering

**Preconditions:** Multiple sessions and goals exist with distinct titles. Search is in Filter mode (default).

**Steps and expectations:**
1. Click the search input in the sidebar (or press Ctrl+K / Cmd+K).
   - Search input focuses. Placeholder shows "Search... (Ctrl+K)" or "Search... (⌘K)" on Mac.
   - No controls row visible yet (Full Search link hidden when query is empty).
2. Type "deploy" into the search input.
   - Controls row appears below the input ("Full Search" link).
   - Sidebar filters instantly (no API call, no loading spinner).
   - Items remain visible if "deploy" matches (case-insensitive) any of: goal name, session title, staff name, agent name.
   - A goal remains visible if it matches OR if any of its child sessions match.
   - A session remains visible if it matches OR if its parent goal matches.
   - Staff entries remain visible if their name matches.
   - Non-matching items are hidden.
   - Archived section (if open) also filters.
3. Modify the query to "deployx" (no matches).
   - Sidebar shows nothing. Items are simply hidden — no explicit "no results" message.
4. Clear the input (click X button or select all + delete).
   - All items reappear in the sidebar.
   - Controls row hides.
   - If the archived section was auto-opened by search, it auto-closes.
5. Press Escape while the search input is focused.
   - Input clears. Focus leaves the input (blur).
   - Sidebar restores to unfiltered state.
6. Type a query, then click a filtered result in the sidebar.
   - Session opens. Search query remains in the input (not cleared on navigation).
   - Sidebar continues to show filtered results.

**Coverage:** none

---

## SR-02: Full search mode

**Preconditions:** Multiple sessions with messages containing the word "kubernetes" but whose titles do NOT contain "kubernetes".

**Steps and expectations:**
1. Type "kubernetes" in the search input.
   - Filter mode: no results visible (titles don't match).
2. Click "Full Search" link below the input.
   - Navigates to `#/search?q=kubernetes`.
   - Full search page renders with: search input (pre-filled with "kubernetes"), type filter tabs (All, Goals, Sessions, Messages), and results area.
   - Loading spinner appears while the API call runs (`GET /api/search?q=kubernetes`).
3. Results return.
   - Grouped by type: Goals, Sessions, Messages — each with a header, icon, and count.
   - Each result shows: title (bold), archived badge (if applicable), relative timestamp, and a snippet with match highlighting.
   - Message results show the parent session title.
   - Results include items that matched by title (same as filter mode) AND items that matched by content (goal specs, user prompts, agent responses, staff instructions, gate content).
4. Click a type tab (e.g. "Messages").
   - Results filter to show only messages.
   - API re-fetches with `type=messages` parameter.
5. Scroll to the bottom of results.
   - If more results exist, a "Load more" button or pagination triggers via `offset`.
6. Modify the query in the full search page input.
   - Results update after debounce.
   - URL updates to reflect the new query (`history.replaceState`).
7. Click a result.
   - Navigates to the corresponding session, goal, or staff item.

**Coverage:** none

---

## SR-03: Search across projects

**Preconditions:** Two projects registered (Project A and Project B), each with sessions and goals.

**Steps and expectations:**
1. Type a query that matches items in both projects.
   - Filter mode: matching items from both projects remain visible, grouped under their project headers.
2. On the full search page, results from both projects appear.
   - Each result shows its project name to disambiguate.
3. If a project filter is applied (e.g. via `projectId` query param), only that project's results appear.

**Coverage:** none

---

## SR-04: Empty and edge-case searches

**Preconditions:** Active app with sessions and goals.

**Steps and expectations:**
1. Full search for a query that matches nothing.
   - Loading spinner appears briefly.
   - "No matches for '<query>'" message displays. No errors. No crash.
2. Search for a single character "a".
   - Results return (FTS5 prefix matching: `a*` matches words starting with "a").
   - Results are reasonable — not the entire database.
3. Search for special characters: `"deploy:prod"`, `hello-world`, `path/to/file`.
   - No FTS5 syntax error. FTS5 query sanitiser handles special chars.
   - Results match the literal terms (hyphens/colons/slashes treated as word separators).
4. Search for a very long query (500+ characters).
   - No crash. API returns results or empty set.
5. Search with leading/trailing whitespace: `  deploy  `.
   - Whitespace is trimmed. Results appear normally.
6. Type a query, wait for results, then rapidly type a different query.
   - Stale responses are discarded (guard: `state.searchQuery !== query`).
   - Only the final query's results display.

**Coverage:** none

---

## SR-05: Keyboard shortcut (Ctrl+K / Cmd+K)

**Preconditions:** App is loaded. User is in any view.

**Steps and expectations:**
1. Press Ctrl+K (Cmd+K on Mac).
   - Search input in the sidebar focuses immediately.
   - If the sidebar is collapsed (mobile), the mobile search should focus.
2. Type a query. Filter mode engages instantly.
3. Press Escape.
   - Search clears and input blurs. Sidebar restores.
4. Press Ctrl+K again.
   - Input re-focuses. Previous query is cleared (from the Escape).
5. While a dialog is open (e.g. settings), press Ctrl+K.
   - Keyboard shortcut is global (`document.addEventListener`). Should focus search or be suppressed if a dialog has focus.

**Coverage:** none

---

## SR-06: Result navigation and context preservation

**Preconditions:** Full search page open with results across goals, sessions, and messages.

**Steps and expectations:**
1. Search for "deploy". Results show goals, sessions, and messages.
2. Click a message result belonging to session X.
   - App navigates to session X.
3. Press browser Back button.
   - Returns to the full search page with the same query and results.
4. Click a goal result.
   - Goal dashboard opens.
5. In the sidebar, the search query persists in filter mode — sidebar still shows filtered items.
6. Clear the search.
   - Sidebar shows all items. Current view (session/goal) is unaffected.

**Coverage:** none

---

## SR-07: Archived items in search

**Preconditions:** Some sessions and goals are archived. Archived section is initially collapsed.

**Steps and expectations:**
1. Type a query that matches an archived item's name.
   - Filter mode: the archived section auto-opens to show the matching item.
   - A flag tracks that archived was opened by search.
2. Clear the search.
   - Archived section auto-closes (reverts to its pre-search state).
3. Full search for text in an archived session's messages.
   - Archived results appear with an archive badge icon.
4. Click an archived result.
   - The archived session or goal opens.
5. Manually open the archived section first, then search.
   - Archived section stays open (it was opened manually, not by search).
   - Clearing the search does NOT auto-close it.

**Coverage:** none

---

## SR-08: Index rebuild and incremental indexing

**Preconditions:** Server is running with existing sessions and goals.

**Steps and expectations:**
1. Search for a message that exists in a session's chat history (full search mode).
   - Content search returns the message with a snippet. Index was built on startup.
2. Send a new message containing the word "flamingo".
   - As the agent streams, messages are incrementally indexed.
3. Full search for "flamingo".
   - The new message appears in results without a server restart.
4. Create a new goal titled "Flamingo Migration".
   - Goal is indexed on creation.
5. Search for "flamingo" — both the message and the goal appear.
6. Delete the search index file (`<project-root>/.bobbit/state/search.db`). Restart the server.
   - The index is rebuilt automatically from stores.
   - Search works again — all previously indexed content is available.

**Coverage:** none

---

## SR-09: Search debounce and performance

**Preconditions:** Large project with many sessions (50+).

**Steps and expectations:**
1. Type rapidly in the search input: "d", "de", "dep", "depl", "deplo", "deploy".
   - Filter mode: sidebar filters update on each keystroke (instant, client-side).
   - Full search mode: API calls are debounced (200ms). Only 1-2 API calls fire, not 6.
   - Loading spinner shows during the API call.
   - No duplicate results or flickering.
2. The final results correspond to the full query "deploy", not an intermediate one.

**Coverage:** none

---

## SR-10: Mobile search

**Preconditions:** Mobile viewport (or narrow browser window where sidebar becomes an overlay).

**Steps and expectations:**
1. The search input is present in the mobile sidebar/drawer.
2. Type a query.
   - Filter mode works (instant sidebar filtering).
3. Click "Full Search".
   - Full search page opens with results.
4. Click a result.
   - Session/goal opens. Mobile sidebar closes.

**Coverage:** none

---

## SR-11: Staff search

**Preconditions:** At least one staff member exists (active, not retired).

**Steps and expectations:**
1. Search by staff name in filter mode.
   - Matching staff entries remain visible in the sidebar.
2. Full search for text in a staff member's description or instructions.
   - Staff results appear in the results.
3. Click a staff result.
   - Navigates to the staff member's session or detail view.
4. Retired staff members are filtered out of sidebar results in filter mode.

**Coverage:** none
