# v2-dom → browser-tier punts

These 8 legacy fixtures were migrated to happy-dom but are **irreducibly flaky
under happy-dom** and belong in the **Chromium browser tier** (tier 2 smoke
journeys), per the design D2/D5 boundary. They are renamed `*.test.ts.txt` so
vitest ignores them (not deleted — the ports are preserved for re-use when the
browser-tier specs are written).

**Why they can't be hermetic under happy-dom:** each drives the full app render
loop and/or real WebSocket session streams (RemoteAgent connect + reconnect
timers). happy-dom has no real event loop/network, so these emit fire-and-forget
stragglers ("Connection timed out", async render-into-torn-down-document) that
land in later files and fail the run non-deterministically at low fork counts.
Their assertions are real page-journey assertions — exactly tier-2 material.

| File | Reason → browser tier |
|---|---|
| `sidebar-keyboard-nav-fixture` | Full sidebar page: session connect (real WebSocket) + keyboard-nav render loop; WS reconnect stragglers. |
| `sidebar-archived-fixture` | Full sidebar page with live session/WS state + render loop. |
| `sidebar-filter-search-fixture` | Full sidebar page: live filter + WS-driven session list re-render. |
| `search-preview-search-page` | Full search page: WS-backed live results + async render loop. |
| `search-index-ui` | Full search/index maintenance page: async index progress via WS + render loop. |
| `search-preview-maintenance` | Full maintenance page: async worktree/index scan + WS + render loop. |
| `goal-workflow-editor` | Full workflow-editor page: WS-driven state + app render loop. |
| `tool-manager-mcp-section` | Settings tool-manager page: app render loop + async refresh; flaky settle under happy-dom. |

**Action for the team lead:** re-bucket these entries in `tests-map.json` from
`v2-dom` to `browser` (tier 2) and fold their assertions into the corresponding
browser smoke journeys (sidebar navigation, search page, settings, goal workflow).
The `.txt` ports here are the faithful reference for those assertions.
