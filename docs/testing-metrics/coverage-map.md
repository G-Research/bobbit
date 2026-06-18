# Split UI E2E coverage map

Update this map whenever browser E2E coverage moves to cheaper layers. Baseline metric files are committed as `docs/testing-metrics/baseline-<name>.json`; current runtime metrics remain unprefixed under `.profiles/metrics/<name>.json`. See [README.md](README.md) for metric commands, comparison examples, and baseline rules.

## Migration coverage map

| Target behavior | Spawned-gateway browser E2E coverage after migration | Replacement unit/fixture/API coverage | Retained full-stack smoke coverage | Baseline metric slice |
|---|---|---|---|---|
| Renderer, panels, status widgets, cost popovers, dynamic tabs | Browser coverage is limited to representative real-app journeys for renderer registration, panel opening, persistence/reload, and server-fed stats. Broad per-renderer, per-proposal, tab-order, preview-control, and review-pane matrices belong in fixtures. | `tests/activate-skill-renderer.spec.ts`, `ask-user-choices-renderer.spec.ts`, `ask-user-choices-widget.spec.ts`, `children-tool-renderers.spec.ts`, `context-cost-stats.spec.ts`, `gate-*-renderer.spec.ts`, `git-status-widget*.spec.ts`, `inbox-renderer.spec.ts`, `lazy-renderer-placeholder.spec.ts`, `notification-renderer.spec.ts`, `preview-renderer.spec.ts`, `proposal-panel-subsection-diff.spec.ts`, `proposal-rehydrate-client.spec.ts`, `review-document-sanitize.spec.ts`, `tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts`, `tests/ui-fixtures/preview-panel.spec.ts`, `tests/ui-fixtures/preview-reopen.spec.ts`, `tests/ui-fixtures/proposal-review-fixture.spec.ts`, plus API coverage such as `tests/api-goals-tree-cost.test.ts`. | Keep real-app smokes for child tool renderer registration, ask-user-choices lifecycle/finalization, proposal and review-pane opening/approval, preview side-panel persistence, goal status widget visibility, and cost/session stats sourced from the server. | `baseline-slice-renderer.json` |
| Scroll, tail-follow, jump-to-last-prompt, viewport geometry | Browser coverage is limited to real streaming, session-navigation replay, and mobile/review viewport integration. Pure geometry, jump-button state, overflow promotion, scroll-pin, and reflow matrices belong in deterministic DOM fixtures. | `tests/agent-interface-scroll.spec.ts`, `agent-interface-scroll-hardening.spec.ts`, `collapse-scroll-bugs.spec.ts`, `defer-offscreen-render.spec.ts`, `follow-tail.spec.ts`, `mobile-scroll-keyboard.spec.ts`, `render-debounce.spec.ts`, and `tests/ui-fixtures/chat-scroll.spec.ts`. | Keep one real streaming tail-chat smoke, one session-navigation bottom-pin smoke, one jump-to-last-prompt/mobile-header smoke, one pill overflow integration smoke, and one mobile review viewport smoke. | `baseline-slice-scroll.json` |
| Sidebar navigation, archived rows, ordering, selection, persistence | Browser coverage is limited to representative filter/search, keyboard routing, archived persistence/per-project rendering, session/goal navigation, and action-menu integration. Row-order, focus-cycle, archived bucketing, menu dismissal, copy fallback, fork visibility, hover layout, and mobile quick-action matrices belong in fixtures/API. | `tests/sidebar-goal-rendering.spec.ts`, `sidebar-goal-group-filters.spec.ts`, `sidebar-spawned-children.spec.ts`, `mobile-archived.spec.ts`, `rapid-keystroke-nav.spec.ts`, `back-button-goal.spec.ts`, `goal-card-back-nav.spec.ts`, `tests/ui-fixtures/sidebar-actions-menu-fixture.spec.ts`, `tests/ui-fixtures/sidebar-archived-fixture.spec.ts`, `tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts`, `tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts`, `tests/ui-fixtures/sidebar-navigation-fixture.spec.ts`, and API coverage in `tests/e2e/sidebar-api.spec.ts`, `sidebar-actions-server.spec.ts`, `archived-delegates-api.spec.ts`, `archived-footer-model.spec.ts`, `archived-session-merge.spec.ts`, `parent-scoped-archive-child.spec.ts`, `stories-sessions-api.spec.ts`. | Keep one filter/search smoke, one real-app keyboard route journey, one archived desktop/per-project smoke, one session/goal navigation smoke, one staff/search smoke, and one sidebar action-menu session+goal smoke. | `baseline-slice-sidebar.json` |

## Retained full-stack smoke inventory

Retained spawned-gateway browser E2E should prove integration wiring that fixtures cannot: real routing, server/WebSocket state, persistence across reload, cross-client behavior, or browser layout under the actual app shell.

### Renderer and panel surfaces

- Tool renderer registration: `tests/e2e/ui/children-tool-renderers.spec.ts`.
- Ask-user choices lifecycle and finalization: `tests/e2e/ui/ask-user-choices-ui.spec.ts`.
- Proposal/review panel integration: `tests/e2e/ui/proposal-open-all-types.spec.ts`, `proposal-tools.spec.ts`, `review-pane.spec.ts`.
- Preview and dynamic side-panel integration: `tests/e2e/ui/preview-happy-path.spec.ts`, `side-panel-tabs.spec.ts`, `dynamic-chat-tabs.spec.ts`.
- Status and stats widgets with server-fed data: `tests/e2e/ui/goal-status-widget.spec.ts`, `cost-popover-cache-hit.spec.ts`, `prompt-stats-e2e.spec.ts`.

### Scroll and geometry surfaces

- Real streaming tail-follow: `tests/e2e/ui/tail-chat-real-stream.spec.ts`.
- Session-navigation replay bottom-pin: `tests/e2e/ui/tail-chat-session-navigate.spec.ts`.
- Jump-to-last-prompt mobile/header integration: `tests/e2e/ui/jump-to-last-prompt.spec.ts`.
- Narrow-width pill overflow integration: `tests/e2e/ui/pill-overflow-promotion.spec.ts`.
- Mobile review viewport integration: `tests/e2e/ui/mobile-review-commenting.spec.ts`.

### Sidebar surfaces

- Filter/search integration: `tests/e2e/ui/stories-sidebar.spec.ts` and the retained smoke in `sidebar-filters.spec.ts`.
- Keyboard route journey: `tests/e2e/ui/sidebar-keyboard-nav.spec.ts`.
- Archived desktop/per-project behavior: `tests/e2e/ui/sidebar-archived-layout.spec.ts` and `sidebar-archived-per-project.spec.ts`.
- Session/goal navigation: `tests/e2e/ui/sidebar-navigation.spec.ts`.
- Staff/search integration: `tests/e2e/ui/sidebar-staff-loading.spec.ts`, `search-e2e.spec.ts`, and `search-result-navigation.spec.ts`.
- Session+goal action-menu integration: `tests/e2e/ui/sidebar-actions-menu.spec.ts`.

## Coverage-map update rules

When moving browser E2E rows to cheaper layers:

1. Add or identify fixture/API/unit coverage before deleting or skipping spawned-gateway browser rows.
2. Update this map in the same change: list the retired browser matrix, replacement coverage, and retained full-stack smoke.
3. Keep retained browser E2E to integration journeys: real routing, persistence, WebSocket/server wiring, cross-client behavior, or real browser layout that fixtures cannot represent.
4. Update `retainedSmokeFiles` and `retainedSmokeCoverage` in `thresholds.json` whenever a retained smoke file is intentionally renamed, removed, or split; `metrics:check` fails if a listed file is missing from disk, absent from the browser report, or has too few non-skipped tests.
5. Measure the relevant slice before the full E2E validation step.
6. Use `metrics:e2e:all` for final split-suite validation instead of rerunning full E2E through multiple commands.

## Baseline metric files

<!-- baseline-metric-files:start -->
- `baseline-coverage.json`
- `baseline-e2e-api-realpush.json`
- `baseline-e2e-api.json`
- `baseline-e2e-browser.json`
- `baseline-e2e-full.json`
- `baseline-slice-renderer.json`
- `baseline-slice-scroll.json`
- `baseline-slice-sidebar.json`
- `baseline-unit-browser.json`
- `baseline-unit-node.json`

Thresholds: `thresholds.json`.
<!-- baseline-metric-files:end -->
