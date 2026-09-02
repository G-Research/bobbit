# Split UI E2E coverage map

Update this map whenever spawned-gateway browser coverage moves to a cheaper layer. Baselines are committed as `baseline-<name>.json`; current measurements remain under `.profiles/metrics/`. See [README.md](README.md).

## Migration coverage map

| Surface | Cheaper deterministic coverage | Retained integration coverage | Metric slice |
|---|---|---|---|
| Renderer, proposals, reviews, preview, status and stats | DOM/component tests plus `tests/browser/fixtures/{dynamic-chat-tabs,proposal-review-fixture,side-panel-tabs}.fixture.spec.ts`; gateway/API tests own persistence and validation contracts. | `children-tool-renderers`, `ask-user-choices-ui`, `proposals`, `review-pane`, `review-artifacts`, `goal-team-gates-reset`, and `cost-popover-cache-hit` journeys. | `baseline-slice-renderer.json` |
| Scroll, tail-follow, jump controls and viewport geometry | `tests/browser/fixtures/{agent-interface-scroll,chat-scroll,follow-tail,jump-to-last-prompt,mobile-review-commenting,pill-overflow-promotion}.fixture.spec.ts` and DOM scroll tests. | Real-stream and cross-session replay coverage remains in `tests/e2e/browser/tail-chat-*.browser-e2e.spec.ts`. | `baseline-slice-scroll.json` |
| Sidebar navigation, filtering, archives, keyboard and actions | `tests/browser/fixtures/sidebar-{actions-menu-fixture,archived-fixture,filter-search-fixture,keyboard-nav-fixture,navigation-fixture}.fixture.spec.ts` plus sidebar unit/DOM and gateway/API tests. | `sidebar-nav.journey.spec.ts`, `tests/e2e/browser/search-result-navigation.browser-e2e.spec.ts`, and `sidebar-actions-menu.browser-e2e.spec.ts`. | `baseline-slice-sidebar.json` |
| Add Project and directory selection | `directory-picker.dom.test.ts`, `add-project-flow.fixture.spec.ts`, project preflight gateway tests, and the canonical `project-onboarding-*` journeys. | Canonical onboarding journeys retain routing, assistant creation and persistence boundaries; duplicate `add-project-*` matrices were retired. | Renderer/browser aggregate |
| Marketplace MCP | `marketplace-mcp-ui.dom.test.ts` owns source and operation UI states; marketplace MCP API/unit tests own backend behavior. | `marketplace-mcp.journey.spec.ts` retains one real browse/install/reload/disable/uninstall lifecycle. | Renderer/browser aggregate |
| Staff, workflows and subgoals | Staff trigger/sidebar fixtures and unit/gateway tests own editor matrices and eligibility rules. Workflow fixtures, store/validator tests and gateway tests own field mappings. | Small journeys remain where real routing, persistence, worktree setup or reload is the contract. | Browser aggregate |

## September 2026 browser-lane reduction

The canonical-layout cutover temporarily brought the legacy spawned-gateway matrices into the browser lane alongside the consolidated v2 suite. The lane grew from 667 to 1,134 tests and regressed from a sub-five-minute target to roughly 18 minutes at the default worker count.

This reduction:

- deletes legacy journeys only where an exact fixture, DOM, unit, gateway/API, E2E, or consolidated journey replacement exists;
- moves directory-picker, dashboard mutation, session-loader, marketplace MCP UI, staff-trigger, sidebar action, debug-policy, and subgoal eligibility matrices to cheaper deterministic tests;
- shrinks broad journeys to a single irreducible full-stack boundary;
- retains cold reload, reconnect, cross-client, destructive cascade, authentication, gateway restart, worktree/setup, and real routing behavior as browser journeys;
- keeps the H3 B/C/D browser smokes at one default iteration while unit tests own exhaustive reducer stress.

## Retained smoke inventory

The machine-readable source of truth is [`thresholds.json`](thresholds.json). Its current browser smokes cover:

- child tool renderer registration and ask-user-choices lifecycle/finalization;
- proposal, review, preview, gate-status and server-fed cost integration;
- side-panel persistence and dynamic preview tabs;
- real streaming/replay plus deterministic jump, overflow and mobile-review geometry;
- real sidebar navigation/search plus deterministic filter, keyboard and archived bucketing;
- real search-result and action-menu routing.

## Update rules

1. Add or identify replacement coverage before deleting a spawned-gateway journey.
2. Keep browser journeys only for routing, WebSocket/server wiring, persistence/reload, cross-client behavior, real process/worktree setup, or actual-app geometry.
3. Put pure logic in unit tests, DOM state in DOM tests, deterministic geometry in browser fixtures, and server contracts in gateway/API tests.
4. Update `retainedSmokeFiles` and `retainedSmokeCoverage` in `thresholds.json` whenever a retained smoke changes.
5. Profile the relevant slice, then run the complete retry-free browser lane.
6. Use `metrics:e2e:all` for final E2E split validation instead of rerunning full E2E projects independently.

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
