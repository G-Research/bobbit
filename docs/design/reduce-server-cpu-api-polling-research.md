# Reduce Server CPU — API polling and git/status research

Task: read-only investigation of high-frequency REST polling and git/status endpoints as CPU suspects. No production/test changes were made.

## Scope read

- Client: `src/app/api.ts`, `src/app/goal-dashboard.ts`, `src/app/git-status-refresh.ts`, plus session git-status wiring in `src/app/session-manager.ts` where needed to understand cadence.
- Server: relevant endpoints and caches in `src/server/server.ts`.
- Tests/docs: `tests/e2e/git-status-caching.spec.ts`, `tests/git-status-retry.test.ts`, `tests/session-manager-git-dropdown-listener.test.ts`, `tests/goal-dashboard-setup-poll-repro.spec.ts`, `docs/internals.md`, `docs/debugging.md`, `docs/design/git-status-widget-reliability.md`.

## Call cadence

### Global sidebar/session refresh

`startSessionPolling()` in `src/app/api.ts` runs every 5s when the app is authenticated and `document.visibilityState === "visible"`.

Each tick calls `refreshSessions()`, which issues these in parallel:

| Endpoint | Cadence per visible tab | Notes |
| --- | ---: | --- |
| `GET /api/sessions?since=<generation>` | every 5s | Server returns `{changed:false}` when generation matches. Full response includes live sessions plus archived delegate enrichment when changed. |
| `GET /api/goals?since=<generation>` | every 5s | Server returns `{changed:false}` when generation matches. |
| `GET /api/projects` | every 5s | No generation/conditional request path; client only suppresses rendering via `setProjectsIfChanged()`. |

Additional sidebar badge work:

- On initial load or goal-list changes, `refreshGateStatusCache()` sends one `GET /api/goals/:id/gates` per live goal with a workflow.
- PR badge polling is throttled client-side to 60s and only considers active, non-archived, non-complete goals with branches; it sends one `GET /api/goals/:id/pr-status` per eligible goal.
- On `visibilitychange -> visible`, `main.ts` resets the PR throttle and calls `refreshSessions()` immediately.
- Initial load hydrates PR data from `GET /api/pr-status-cache` once.

Baseline request rate for a visible idle tab is therefore about **36 REST requests/minute** before PR/gate badge fan-out: three endpoints every 5s.

### Goal dashboard load and pollers

`loadDashboardData(goalId)` starts some pollers before the initial data batch, then performs a broad initial fetch.

Initial dashboard fetches:

- `GET /api/goals/:id`
- `GET /api/goals/:id/tasks`
- `GET /api/goals/:id/commits?limit=20`
- `GET /api/goals/:id/gates`
- `GET /api/goals/:id/git-status`
- `GET /api/goals/:id/cost`
- `GET /api/goals/:id/pr-status`
- then `GET /api/goals/:id/team`
- plus `GET /api/goals/:id/team/agents` from `startAgentPolling()`
- plus `GET /api/goals/:id/verifications/active` after data load

Steady dashboard pollers:

| Poller | Endpoints | Cadence | Visibility gated? |
| --- | --- | ---: | --- |
| Agent/team | `/team/agents`, `/team` | every 5s | No |
| Tasks | `/tasks` | every 10s | No |
| Gates | `/gates`, `/verifications/active` | every 8s | No |
| Cost | `/cost` | every 15s | No |
| Goal git/PR | `/git-status`, `/pr-status` | every 60s | Yes |
| Setup banner | `/api/goals/:id` | every 3s while `setupStatus === "preparing"` | No |

A single open goal dashboard adds roughly **51 REST requests/minute** in steady state, excluding the global sidebar poll and excluding retries. Most of these dashboard pollers keep running in hidden tabs; browsers may throttle timers, but the code itself does not pause them.

### Session git/status widget

The active session widget has its own safety poll in `session-manager.ts`:

- `GET /api/sessions/:id/git-status` every 30s for the active session, visible tabs only, with a 10s coalesce window after event-driven refreshes.
- Every session git-status refresh is followed by a PR status refresh: `GET /api/goals/:goalId/pr-status` when the session has a goal, otherwise `GET /api/sessions/:id/pr-status`.
- Visibility changes to visible trigger an immediate git refresh.
- Event-driven refreshes happen on active session connect, reconnect, idle status, and user git actions.
- `runGitStatusRefresh()` retries transient failures up to 4 attempts at delays `[0, 500, 2000, 5000]`; `not-a-repo` is terminal.

## Server caching and CPU behavior

| Area | Existing behavior | CPU implication |
| --- | --- | --- |
| `/api/sessions` | Generation short-circuit returns small `{changed:false}` before listing/enrichment. Full response maps live sessions and may BFS-enrich archived delegates. | Good when unchanged; changed generations under active streaming/status churn can re-run list/enrichment every visible tab tick. |
| `/api/goals` | Generation short-circuit for live goals. Archived path is paginated and separate. | Good when unchanged. |
| `/api/projects` | No generation/ETag; returns filtered registry every 5s per visible tab. | Likely small, but pure avoidable baseline work and multi-tab amplification. |
| `/api/goals/:id/gates` | Returns full enriched gates by default, including content-ish fields and full `signals`; summary view exists with `?view=summary` but dashboard/sidebar helper does not use it. | Strong suspect when workflows have many gates/signals or multiple dashboards/tabs. JSON serialization/comparison is repeated every 8s. |
| `/api/goals/:id/verifications/active` | Lightweight in-memory active verification projection. | Low per call, but paired with gate polling every 8s even though WS verification events exist. |
| `/api/goals/:id/team/agents` and `/team` | In-memory team state/list. | Likely cheap individually; high cadence produces many requests. |
| `/api/goals/:id/tasks` | In-memory task list. | Likely cheap, but no generation/conditional path. |
| `/api/goals/:id/cost` | Gets all session IDs for goal, sums tracker data. | Likely moderate only for large teams/delegate trees; no conditional path. |
| Git status endpoints | `batchGitStatus()` has 2000ms TTL and single-flight cache by `container/cwd/summary-or-untracked`; errors are not cached. Host path uses parallel `execFile`; container path uses one `docker exec`. | Current cache should collapse bursts. Sustained 30s/60s polls are probably not the first suspect unless repos are huge, multi-repo dashboards fan out, or git errors cause retry storms. |
| PR status endpoints | Server `_prCache`: OPEN 10s, null/no-PR 30s, closed/merged 15m; in-flight single-flight; viewer permission cache 5m. | Reasonable. Multiple visible tabs still hit the REST handler, but most avoid `gh` while cache is warm. Sandbox session PR status does a container branch lookup before cache. |

## Multi-tab amplification

There is no cross-tab leader election or shared polling result. Each visible tab runs its own global 5s poll. Each open dashboard route runs its own dashboard pollers. Server-side single-flight helps git/PR subprocesses, but it does not eliminate HTTP routing, auth, JSON creation, object comparison, or uncached endpoint work.

Approximate request rate examples:

- 1 visible idle tab: ~36 req/min from session/goal/project refresh.
- 3 visible idle tabs: ~108 req/min, plus PR/gate fan-out.
- 1 visible dashboard tab: ~36 req/min global + ~51 req/min dashboard = ~87 req/min.
- 3 visible dashboard tabs on the same goal: ~261 req/min before retries; git subprocesses coalesce partly, but gates/team/tasks/cost do not.

Hidden tabs reduce some work only where code checks `document.visibilityState`: global session polling and git/status polling. Dashboard agent/task/gate/cost/setup pollers currently lack that gate.

## Likely suspects, ranked

1. **Dashboard gate polling with full gate payloads.** The 8s poll uses the full `/gates` response, then stringifies on the client. Summary mode already exists server-side and would likely satisfy polling/sidebar badge needs.
2. **Unconditional `/api/projects` on every global 5s tick.** It is low-cost but constant and amplified by tabs. It lacks the generation optimization already used for sessions/goals.
3. **Dashboard team polling every 5s via two endpoints.** Team membership/status changes are event-like and already have WS event types (`team_agent_*`), so polling at this cadence is mostly a freshness fallback.
4. **Dashboard pollers not visibility-gated.** Hidden dashboard tabs can continue hitting team/tasks/gates/cost/setup, subject only to browser timer throttling.
5. **Git/status under error or multi-repo workloads.** Normal git-status has good TTL/single-flight protections. Risk remains when errors are frequent, dashboards cover multi-repo goals, dropdown `?untracked=1` scans are repeated, or sandbox PR status performs pre-cache container branch checks.

## Safe optimization ideas to test later

These are candidates only; they should be measured independently before implementation.

1. Add `projectsGeneration` support to `GET /api/projects?since=` and client state, mirroring sessions/goals. This is small and low risk.
2. Use `GET /api/goals/:id/gates?view=summary` for dashboard/sidebar polling paths, fetching full gate detail only for expanded/detail views. Existing endpoint support lowers implementation risk.
3. Add generation/updatedAt conditional responses for goal dashboard pollers: tasks, gates, team agents, cost. Even `{changed:false}` responses would reduce serialization and client JSON stringify cost.
4. Gate dashboard agent/task/gate/cost/setup pollers on `document.visibilityState === "visible"`; on visibility return, run one immediate refresh. Preserve setup correctness by keeping WS `goal_setup_complete/error` handling and a visible-tab fallback.
5. Replace or relax high-frequency team polling using existing `team_agent_spawned`, `team_agent_dismissed`, and `team_agent_finished` WS events, with a slower fallback poll.
6. Coalesce dashboard gate polling with verification WS events: poll slower when no verification is active; poll or fetch details only after `gate_signal_received` / `gate_status_changed` events.
7. For git/status, keep current cache but add instrumentation counters before changing behavior: endpoint count, cache hit/miss, in-flight join, underlying git invocation count, error count, per-repo fan-out count, and retry source (`event`/`poll`/`user`).
8. For sandbox session PR status, consider checking the PR cache before running the container branch lookup when a stable persisted branch is available.

## Suggested measurement counters

For the CPU benchmark/report phase, an env-gated endpoint/request logger should capture counts and timings for:

- REST path normalized route, status, duration, response size.
- Per-route per-minute counts split by tab/workload scenario.
- Git status cache hit/miss/in-flight/error and underlying git invocation count.
- Gate endpoint payload size, gate count, signal count, and `view=summary` versus full.
- Dashboard poller source labels if practical: `global-refresh`, `dashboard-agent`, `dashboard-gate`, `dashboard-cost`, `session-git`, `goal-git`, `visibility`.

This should make it possible to prove whether reductions come from fewer requests, smaller payloads, fewer subprocesses, or less JSON/object work.
