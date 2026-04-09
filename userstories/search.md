# Search User Stories

## SR-01: Search from sidebar
**Action:** Click search, type query.
**Expected:** Results from search index (per-project SQLite search.db), matching sessions/messages with snippets.
**Coverage:** none.

## SR-02: Search results page
**Action:** Navigate to #/search?q=query.
**Expected:** Full results page, grouped by session, message context shown, query persisted in URL hash.
**Coverage:** none.

## SR-03: Search across projects
**Action:** Multiple projects registered, search.
**Expected:** Aggregates results across all project indexes.
**Coverage:** none.

## SR-04: Empty state
**Action:** Search with no matches.
**Expected:** "No results" message, no errors.
**Coverage:** none.

## SR-05: Index rebuild
**Action:** Delete search.db, restart server.
**Expected:** Index rebuilt automatically on startup.
**Coverage:** none.
