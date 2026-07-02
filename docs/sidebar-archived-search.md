# Sidebar Archived Search

The sidebar filter searches live UI state immediately, but archived data is paginated on demand. Archived sessions and goals can outnumber the first page, so a client-only filter would miss older matches. Bobbit therefore uses server-backed archived search whenever the sidebar filter has a non-empty query and archived rows are visible or auto-opened by the search.

## Where it fits

The sidebar keeps two paths:

- **Live data** — active sessions, live goals, and staff rows are filtered in the browser from already-loaded state for instant feedback.
- **Archived data** — archived sessions and goals are searched through paginated REST calls with `q`, so matching rows are found across the full archived corpus before pagination.

This preserves fast local filtering for common live data while avoiding arbitrary loading of non-matching archived pages.

## Triggering archived search

When the user types a non-empty sidebar filter:

1. If Show Archived is off, the sidebar opens archived sections for the search only.
2. The client debounces remote archived search before calling:
   - `GET /api/sessions?include=archived&q=<query>&limit=50`
   - `GET /api/goals?archived=true&q=<query>&limit=50`
3. Returned archived rows are merged into the existing sidebar state.
4. The active client-side filter still hides non-matching archived rows, including any rows loaded earlier for normal archived pagination or nesting.

Clearing the filter clears archived-search pagination state. If the filter was the reason archived sections opened, clearing also closes them again.

## Matching semantics

Archived search uses the same case-insensitive substring contract as the sidebar filter:

- Archived sessions match on `title` or `role`.
- Archived goals match on `title`.
- Archived goals also match when an affiliated non-child session matches on `title` or `role`.

An affiliated session is attached through the goal relationship fields used by the sidebar (`goalId` or `teamGoalId`). Archived verifier sessions (`llm-review-*` / `agent-qa-*`) also use `goalId` as an effective team-goal fallback when legacy rows are missing `teamGoalId`; see [Reviewer Archive Cleanup](reviewer-archive-cleanup.md). Delegate and child sessions are not direct goal-match evidence, but the API can return related archived sessions for a matched goal page so the sidebar can render nesting correctly.

Search does not inspect transcript contents, tool output, goal specs, or task text.

## Query-aware pagination

Archived search keeps pagination separate from normal Show Archived pagination.

- Initial search loads the first matching page for archived sessions and goals independently.
- If more matching archived goals exist, the sidebar shows **Load more matching archived goals…**.
- If more matching archived sessions exist, it shows **Load more matching archived sessions…**.
- These actions keep the active `q` value and pass the returned `nextCursor`; they do not fall back to unfiltered archive pages.
- While a remote archived search page is pending, the sidebar shows **Searching archived…**.

Normal archived pagination is unchanged when no query is active: Show Archived loads archive pages by recency with no `q` filter.

## Project bucketing and parity

The server returns archived records with their project metadata intact. The client merges them into the same state used by normal archived pagination, then buckets archived sessions and goals under each project archived section. Desktop and mobile sidebar renderers share the same filtering helpers, so matching and highlight behavior stay consistent across layouts.

## API reference

See [REST API — Sessions](rest-api.md#sessions) and [REST API — Goals](rest-api.md#goals) for parameter and response details:

- `GET /api/sessions?include=archived&q=<query>&limit=<n>&after=<cursor>` filters archived sessions by session title/role before pagination.
- `GET /api/goals?archived=true&q=<query>&limit=<n>&after=<cursor>` filters archived goals by goal title or affiliated session title/role before pagination.

The regression is pinned by archived-query API coverage and the sidebar archived search browser repro tests.
