# Search User Stories

## SR-01: Search from sidebar
**Steps:** Click the search icon in the sidebar. Type a query into the search field.
**Expected:** Results appear showing matching sessions and messages with highlighted snippets. Clicking a result navigates to that session or message.
**Coverage:** none.

## SR-02: Search results page
**Steps:** Navigate to the search page with a query.
**Expected:** A full results page is displayed. Results are grouped by session. Message context is shown around each match.
**Coverage:** none.

## SR-03: Search across projects
**Pre-condition:** Multiple projects are registered.
**Steps:** Perform a search.
**Expected:** Results include matches from all projects.
**Coverage:** none.

## SR-04: Empty state
**Steps:** Search for a query that matches nothing.
**Expected:** A "No results" message is displayed. No errors are shown.
**Coverage:** none.

## SR-05: Index rebuild
**Steps:** Delete the search index file, then restart the server.
**Expected:** The search index is rebuilt automatically. Search works again after restart.
**Coverage:** none.
