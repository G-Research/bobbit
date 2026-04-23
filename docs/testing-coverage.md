# Testing Coverage

Per-area notes on what user stories and contracts are covered by which test files. For test architecture and harness APIs, see [testing-strategy.md](testing-strategy.md).

## Prompt interactions

User stories PI-01 through PI-25 (+ sub-stories) are defined in `userstories/prompt-interactions.md`.

- **Unit fixture tests** — isolated component behavior: file attachments, drag-drop, voice input, model/thinking selectors, context bar, cost display, git status widget, background process pills, abort/focus management, personality selector. Pattern reference: `tests/message-editor-attach.spec.ts`.
- **Browser E2E** — multi-component flows needing a real server: model persistence, context stats, personality selection. Pattern reference: `tests/e2e/ui/prompt-stats-e2e.spec.ts`.
- **Spec-framework stories**:
  - `tests/e2e/ui/stories-streaming.spec.ts` — contracts CT-01 (streaming lifecycle) and CT-06 (focus follows intent), including ST-DEDUP-01 (reconnect-mid-stream dedup).
  - `tests/e2e/ui/stories-drafts.spec.ts` — contract CT-02 (draft preservation), 7 stories spanning all 8 contract variations, plus spec graph analysis tests.
- Story definitions registered in `tests/e2e/ui/story-registry.ts` for `tools/spec-check.ts` coverage reporting.

## Sidebar

User stories SB-00 through SB-37 (+ SB-00b) are defined in `userstories/sidebar.md`.

- **Unit fixture tests** — rendering logic: session hierarchy, time formatting, unseen activity, goal badges, PR status, setup indicators, empty states, personality badges, sandbox indicators, role picker, staff rendering, mobile behavior, keyboard shortcuts.
- **Browser E2E** — multi-component flows: project collapse, goal team navigation, session switching, session create/rename/terminate, search filtering, archived toggle, sidebar collapse, goal actions.
- **Per-project Archived subsections** — `tests/e2e/ui/sidebar-archived-per-project.spec.ts` (4 tests): per-project rendering with no global block; per-project collapse state persists across reload; search surfaces archived items in the correct project subsection; global See Archived toggle hides all per-project subsections at once. Uses per-test isolation — `beforeEach`/`afterEach` spin up fresh projects + archived goals with unique suffixes; `localStorage` (`bobbit-show-archived`, `bobbit-archived-collapsed-projects`) is cleared via `addInitScript` before each `openApp` so retries pass `--repeat-each=5` cleanly.
- **Mobile archived filtering + matched-term highlighting** — `tests/e2e/ui/sidebar-mobile-archived-search.spec.ts` (filter at 375×667, `<strong>` wrapper for matches) and `tests/render-highlighted-text.spec.ts` (empty query, single/multiple matches, case-insensitive, regex-special chars).
- **Shared helpers** — `src/app/render-helpers.ts` exports `filterArchivedGoalsByQuery`, `filterArchivedSessionsByQuery`, `renderHighlightedText`, used by both `renderSidebar` (`src/app/sidebar.ts`) and `renderMobileLanding` (`src/app/render.ts`).
- **Mobile per-project Archived subsections** — `tests/e2e/ui/sidebar-mobile-archived-per-project.spec.ts` (4 tests at 375×667, mirrors desktop file). Mobile and desktop share `renderProjectArchivedSection` in `src/app/render-helpers.ts` (+ `bucketArchivedByProject` for mobile; desktop keeps its inline bucketing loop in `sidebar.ts` which additionally emits `console.warn` for orphaned items). Mobile hides the "Load more archived…" pagination buttons while `state.searchQuery` is active; desktop retains global pagination.
- **Spec-framework stories**:
  - `tests/e2e/ui/stories-sidebar.spec.ts` — CT-03 (sidebar highlights), CT-04 (live status).
  - `tests/e2e/ui/stories-navigation.spec.ts` — CT-13 (URL routing & keyboard shortcuts).
- Pattern references: `tests/sidebar-hierarchy.spec.ts` (unit), `tests/e2e/ui/sidebar-navigation.spec.ts` (E2E).

## Sessions & resilience

User stories defined in `userstories/sessions.md`, `userstories/resilience.md`, and the session subset of `userstories/projects.md`.

- `tests/e2e/ui/stories-sessions.spec.ts` — S-01 through S-12 (create, switch, draft isolation, delete, rapid switching, worktree, rename, persistence, messaging).
- `tests/e2e/ui/stories-resilience.spec.ts` — RE-01 through RE-08. Only RE-07 (WebSocket disconnect/reconnect) runs in standard E2E; RE-01–RE-06 and RE-08 exercise real process crash/restart and Docker recovery and are `test.skip()` with "INFRASTRUCTURE: Requires npm run test:manual" annotations — they run under the manual-integration harness instead.
- `tests/e2e/ui/stories-projects.spec.ts` — PR-01/PR-04/PR-09/PR-10 (project organization).
- All stories registered in `tests/e2e/ui/story-registry.ts`; `tools/spec-check.ts` reports per-contract variation coverage (CT-05 at 75%, CT-16 at 100%).
- **Framework extensions** in `tests/e2e/ui/spec-framework.ts`: `ProjectHandle` entity handle; `SpecContext.createTestSession(name, opts)` accepting `opts.cwd` (worktree-backed) and `opts.goalId` (goal-scoped); `SpecContext.create_session_via_ui()` and `rename_session()` for sidebar-driven flows; `event.disconnect()` to force a WebSocket close; `event.server_crash()` / `event.server_restart()` which throw "requires manual harness" outside `npm run test:manual`.

## Sidebar child auto-loading

Ensures visible sidebar entries always have their children loaded.

- **API tests** — `tests/e2e/sidebar-child-loading.spec.ts`, `tests/e2e/archived-session-merge.spec.ts`: verify server-side BFS enrichment covers `teamGoalId`, `teamLeadSessionId`, `delegateOf` chains; archived-goals response includes affiliated sessions.
- **Browser E2E** — `tests/e2e/ui/sidebar-child-loading.spec.ts`: expanding a goal always shows its children including archived team members and delegates.
