# Search

## SR-01: Search from sidebar

**Preconditions:** Sessions with messages exist.

**Steps:**
1. Click search icon/box in sidebar
2. Type a search query
3. Results appear

**Expected:**
- Results show matching sessions/messages
- Snippets highlight matching text
- Can click result to navigate to session

**Coverage:** None — search UI completely untested.

---

## SR-02: Search results page

**Preconditions:** Search query entered.

**Steps:**
1. Navigate to #/search?q=query
2. View results

**Expected:**
- Full search results page
- Grouped by session
- Message context shown
- Pagination if many results

**Coverage:** None.

---

## SR-03: Search across projects

**Preconditions:** Multiple projects with sessions.

**Steps:**
1. Search for a term that exists in different projects

**Expected:**
- Results from all projects
- Project name shown per result
- Can filter by project (if supported)

**Coverage:** None.

---

## SR-04: Search empty state

**Preconditions:** No matching results.

**Steps:**
1. Search for a term with no matches

**Expected:**
- "No results" message shown
- No errors

**Coverage:** None.

---

## SR-05: Search index rebuild

**Preconditions:** Search returning stale results.

**Steps:**
1. Delete search.db
2. Restart server
3. Search again

**Expected:**
- Index rebuilt automatically
- Results reflect current data

**Coverage:** None.
