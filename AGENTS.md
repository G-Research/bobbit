# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Full build (server + UI)
npm run build:server   # Compile server TypeScript only
npm run build:ui       # Vite bundle UI only
npm run dev            # Gateway + vite dev server with hot reload
npm run dev:harness    # Gateway via restart harness + vite (use this for development)
npm run restart-server # Signal the harness to rebuild & restart the server
npm start              # Run built gateway (serves embedded UI)
npm run check          # Type-check both server and web without emitting
npm test               # Run all tests (unit + E2E)
npm run test:unit      # Unit tests — Node test runner + Playwright file:// fixtures (<30s)
npm run test:e2e       # E2E tests — API (in-process) + browser (spawned gateway)
npm run test:manual    # Manual integration tests — real agents + Docker (~5 min)
SCREENSHOTS=1 npm run test:manual  # Same + browser screenshots + HTML report
```

### Dev server harness

Use `npm run dev:harness` for development. The harness watches `.bobbit/state/gateway-restart` — run `npm run restart-server` to rebuild and restart after server changes. Auto-restarts on crashes. Sessions survive restarts via `.bobbit/state/sessions.json`.

## Development workflow

See [docs/dev-workflow.md](docs/dev-workflow.md).

**Quick reference**: UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server`. Always `npm run check` before restarting.

## Testing

```bash
npm run check                    # Type-check first
npm run test:unit 2>&1 | tail -5 # Unit tests (<30s, no server)
npm run test:e2e 2>&1 | tail -5  # E2E tests (API in-process + browser spawned)
npm run test:manual              # Manual integration tests — real agents + Docker (~5 min)
```

Test filter flags: `--failures` (default), `--verbose`, `--full`.

**When to run what:**
- UI-only changes → unit tests
- Server changes → unit + E2E
- Session lifecycle, sandbox, worktree, or restart changes → also `npm run test:manual`

Docker-dependent tests skip automatically when Docker is unavailable.

**Test types:**
- **Unit** (`tests/*.spec.ts`, `tests/*.test.ts`): Playwright `file://` fixtures + Node test runner.
- **API E2E** (`tests/e2e/*.spec.ts`): In-process gateway. Import from `./in-process-harness.js`.
- **Browser E2E** (`tests/e2e/ui/*.spec.ts`): Spawned gateway + Playwright. Import from `../gateway-harness.js`.
- **Manual integration** (`tests/manual-integration/`): Real agents, real Docker. Not in CI.

See [docs/testing-strategy.md](docs/testing-strategy.md) for harness selection, helper APIs, mock agents. See [docs/testing-coverage.md](docs/testing-coverage.md) for per-area coverage (prompt interactions, sidebar, sessions & resilience, sidebar child auto-loading).

**Rules:**
- Tests run in isolation — never read/write `.bobbit/` directly, use the isolated directory from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests. Use E2E only when you need a real server.

**E2E coverage requirement**: Every feature that changes user-facing behavior MUST include a browser E2E test covering (1) navigation, (2) happy path, (3) persistence across reload, (4) cleanup/undo. Canonical pattern: `tests/e2e/ui/settings.spec.ts`. Bug fixes need only a unit test unless the bug involves multi-step server interactions.

## Recipes

One-liner task → entry point. Follow links for walkthroughs.

- **Add an API E2E test** → `tests/e2e/`, import `./in-process-harness.js`. See `gates-api.spec.ts`.
- **Add a UI E2E test** → `tests/e2e/ui/`, import `../gateway-harness.js`, helpers `./ui-helpers.js`. See `session-interactions.spec.ts`.
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [docs/rest-api.md](docs/rest-api.md).
- **Add a project** → `POST /api/projects` or sidebar "Add Project". Key: `project-registry.ts`, `project-context.ts`. See [docs/internals.md — Project assistant](docs/internals.md#project-assistant).
- **Remove a project** → settings → General → Remove. `DELETE /api/projects/:id`. Refuses at zero projects (400; `?force=1` under `BOBBIT_E2E=1`).
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method.
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`. Review pane details in [docs/review-pane-mobile.md](docs/review-pane-mobile.md).
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Label multi-line bash calls** → pass `description` to `bash` (mirrors `bash_bg`'s required `name`). See `defaults/tools/shell/bash.yaml`.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`. See [docs/internals.md — MCP servers](docs/internals.md#mcp-servers).
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`; later REST call resolves it. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. See [docs/internals.md — Config scan directories](docs/internals.md#config-scan-directories).
- **Add an IndexSource** → implement `IndexSource` from `src/server/search/types.ts`; wire into `SearchService`. See [docs/design/portable-search.md](docs/design/portable-search.md).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager`. See [docs/internals.md — Store resolution](docs/internals.md#store-resolution-pattern).
- **Add/modify session creation** → plan/execute in `session-setup.ts`, wrappers in `session-manager.ts`. Four modes: normal, worktree, delegate, continue-archived. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Continue an archived session** → footer button in `AgentInterface.ts` → `ContinueSessionChooser.ts` → `POST /api/sessions/:archivedId/continue`. Server: `src/server/agent/continue-archived.ts`. See [docs/internals.md — Continue-Archived sessions](docs/internals.md#continue-archived-sessions).
- **Config cascade** → builtin → server → project. Modules: `builtin-config.ts`, `config-cascade.ts`. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).
- **Add a config type to the cascade** → loader in `BuiltinConfigProvider`, `resolveX()` in `ConfigCascade`, REST endpoint, UI scope row (`config-scope.ts`).
- **Debug review/naming model picking the wrong model under AI Gateway** → `applyReviewModelOverrides` in `src/server/agent/review-model-override.ts` parses `default.reviewModel`/`default.namingModel` as `provider/modelId`, calls `rpc.setModel`, then `rpc.getState()` and throws on mismatch (accepts both `{success,data:{model}}` and `{model}` shapes). Naming fallback: `title-generator.ts::pickFallbackAigwNamingModel` tiers haiku→sonnet→opus. See [docs/debugging.md](docs/debugging.md).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` (builtin) or `.bobbit/config/tool-group-policies.yaml` (project). Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).
- **Change message rendering** → `src/ui/components/Messages.ts` (standard), `message-renderer-registry.ts` (custom).
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `AgentInterface.ts`, `src/app/session-manager.ts`, `src/app/goal-dashboard.ts`, `src/app/git-status-refresh.ts`, `src/app/api.ts`, `src/server/server.ts` (`batchGitStatus`). See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md) and [docs/internals.md — Git status cache & client resilience](docs/internals.md#git-status-cache--client-resilience).
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Applied in `session-setup.ts`/`session-manager.ts`. Renderers: `WriteRenderer.ts`, `PreviewRenderer.ts`. Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`. See [docs/internals.md — Large content truncation](docs/internals.md#large-content-truncation).
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).
- **Maintenance cleanup** → Settings → Maintenance. Scan/preview/execute pattern. Hosts Search Index panel. See [docs/internals.md — Semantic search](docs/internals.md#semantic-search).
- **Per-project settings** → Settings → project tab. Inherits from System. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent can call `propose_project` against the current registered project; the user reviews a diff in a "Project" tab in the preview panel and accepts via `PUT /api/projects/:id/config` without ending the session. Key: `session-manager.ts::acceptProjectProposal` (dispatches provisional vs registered), `render.ts::projectProposalPanel`, `propose_project` tool, `PUT /api/projects/:id/config`. Spec: [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md); summary in [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Add QA testing** → `qa_start_command` in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md). Screenshots: agent uses `<img src="file:///<path>">` from `[screenshot_file]` (NOT base64 — bloats transcript). Server inlines file:// refs to data URIs on report submission.
- **Create a design mockup** → `/mockup` skill or [.bobbit/config/docs/design-mockups.md](.bobbit/config/docs/design-mockups.md).

## Debugging

See [docs/debugging.md](docs/debugging.md) for full checklists. Keyword index for common symptoms:

- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **Sandbox status** — `GET /api/sandbox-status`; container label `bobbit-project=<projectId>`.
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification` or dashboard Cancel.
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`. See [docs/goals-workflows-tasks.md — Gate verification baselines](docs/goals-workflows-tasks.md#gate-verification-baselines).
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`. See [docs/rest-api.md — Summary views](docs/rest-api.md#summary-views-viewsummary).
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` post-filters orphans. See [docs/internals.md — Orphan filtering & stale-click safety net](docs/internals.md#orphan-filtering--stale-click-safety-net).
- **Search index** — FlexSearch at `.bobbit/state/search.flex/`; delete to force rebuild. Meta mismatch auto-rebuilds. See [docs/internals.md — Semantic search](docs/internals.md#semantic-search).
- **Sidebar child loading** — check server BFS enrichment, archived-goals `archivedSessions`, on-demand fallback guard. See [docs/debugging.md](docs/debugging.md) "Paginated archives".
- **QA screenshot token bloat** — verify extension emits `[screenshot_file]` not `[screenshot_base64]`. See [docs/qa-testing.md — Screenshots in QA reports](docs/qa-testing.md#screenshots-in-qa-reports).
- **Tool-guard extension ParseError** — new sessions crash for roles with a `never`-policy tool; quoting slip in the template-literal generator in `tool-guard-extension.ts`. Guarded by `tests/tool-guard-extension.test.ts`. See [docs/debugging.md](docs/debugging.md).
- **Auto-nudge flooding** — `nudgePending` guard in TeamManager.
- **Review/naming models under AI Gateway** — reviewer/QA bind via `applyReviewModelOverrides` (`src/server/agent/review-model-override.ts`); any failure throws → hard gate failure (no silent fallback). Naming auto-picks cheapest-tier Claude via `pickFallbackAigwNamingModel` when no explicit pref. Settings → Models shows red "Unavailable" badge for stale prefs + per-row Test button (`POST /api/models/test`).
- **Live-steer lost after Stop** — must route through `SessionManager.deliverLiveSteer()`, which persists to `promptQueue` before calling `rpcClient.steer()`. Repro: `PI-25b`/`PI-25c` in `tests/e2e/abort-status-e2e.spec.ts`.
- **Session wedged after errored turn** — a new prompt/steer to a session with `lastTurnErrored=true` now implicitly unsticks it (clears the flag, prepends a `[SYSTEM: previous turn failed…]` prefix, dispatches fresh intent — no retry of the failed turn). Capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3` so a persistently broken upstream can't be re-triggered on every nudge; beyond the cap, messages park until a human clicks Retry (which bypasses the cap). TeamManager no longer suppresses nudges to errored team leads. See [docs/debugging.md — Session wedged after errored turn](docs/debugging.md#session-wedged-after-errored-turn).
- **`bash_bg wait` not interrupted by steer** — steers must go via `deliverLiveSteer`; `BgProcessManager.waits` registry aborted by `abortAllWaits()`. See [docs/internals.md — Steer-interruptible bash_bg wait](docs/internals.md#steer-interruptible-bash_bg-wait).
- **Large file writes freezing** — `truncateLargeToolContent()` at >32KB. If lazy-load fails, check `.jsonl` exists.
- **Preview Open button broken** — `tool_result` must include the `__preview_snapshot_v1__` marker block; truncated snapshots hydrate via `GET /api/sessions/:id/tool-content/:mi/:bi`; flip panel via PATCH `{preview:true}` → POST `/api/preview`.
- **Streaming dedup/reorder** — events carry `seq`+`ts`; client sends `{type:"resume", fromSeq}` on reconnect; `resume_gap` falls back to `get_messages`. See [docs/design/streaming-dedup-reorder.md](docs/design/streaming-dedup-reorder.md).
- **Continue-Archived button missing** — only renders when archived AND no `goalId` AND no `delegateOf` AND project still registered.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects writes with older `gen`; client must increment `gen` per change, tombstone carries highest.
- **400 "projectId required"** on `POST /api/goals|/api/sessions|/api/staff` — pass `projectId` or a `cwd` inside a registered project; no default fallback. See [docs/rest-api.md — Project resolution contract](docs/rest-api.md#project-resolution-contract).

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Committing with a dirty working copy

When asked to commit, other unstaged/staged changes may exist from another agent or the user. **Never discard, stash, or reset those changes.** Stage only the files you modified (`git add <your-files>`) and commit. If your changes overlap and can't be cleanly separated, ask the user.

### Worktrees

Dev server runs from the **primary worktree** on `master`. All sessions use separate worktrees — goal sessions under `<project-root>-wt-goal/`, regular sessions under `<project-root>-wt-session/`. Assistant sessions (goal/project/tool assistants) don't edit code and don't get worktrees.

**Always edit files in your session worktree, never in the primary worktree.** Editing the primary worktree risks merge conflicts during rebase, corruption of in-progress work by other agents, and breaking the running dev server. Even for infra files that need to end up in primary, the correct flow is: edit here → commit → push → pull from primary. See [docs/dev-workflow.md](docs/dev-workflow.md) for the full rationale.

**Pushing to remote `master` does NOT update the dev server.** Pull into the primary worktree:

```bash
cd <primary-worktree> && git pull origin master
```

You cannot `git checkout master` from a goal worktree — push to remote and pull from primary instead.

### Worktree setup command

Configured via `worktree_setup_command` in `project.yaml`. Runs in new worktree dir with `SOURCE_REPO` env var. 2-minute timeout, non-fatal, `sh -c`.

```yaml
worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
# or: cp -r "$SOURCE_REPO/node_modules" node_modules
```

If not set, no setup runs (Bobbit doesn't assume your package manager).

Staff agent worktrees are auto-refreshed on each wake cycle — rebased onto primary and `worktree_setup_command` re-run. `setupWorktreeDeps()` exported from `src/server/skills/git.ts` for reuse. Sandboxed staff skip host-side refresh.

## Reference docs

- [docs/internals.md](docs/internals.md) — tool policies, search, MCP, sandbox, config, disk state, goals, multi-project
- [docs/debugging.md](docs/debugging.md) — scannable debugging checklists
- [docs/dev-workflow.md](docs/dev-workflow.md) — running modes, restart workflow, worktree rationale
- [docs/testing-strategy.md](docs/testing-strategy.md) — test architecture and harness APIs
- [docs/testing-coverage.md](docs/testing-coverage.md) — per-area test coverage (prompt interactions, sidebar, sessions, resilience)
- [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) — goal/workflow/gate data model
- [docs/blocking-tools.md](docs/blocking-tools.md) — blocking-tool pattern (`verification_result`)
- [docs/non-blocking-ask.md](docs/non-blocking-ask.md) — non-blocking `ask_user_choices` flow
