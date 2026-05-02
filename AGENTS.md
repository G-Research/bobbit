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

UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server`. Always `npm run check` before restarting.

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

See [docs/testing-strategy.md](docs/testing-strategy.md) for harness selection, helper APIs, mock agents. See [docs/testing-coverage.md](docs/testing-coverage.md) for per-area coverage.

**Rules:**
- Tests run in isolation — never read/write `.bobbit/` directly, use the isolated directory from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests. Use E2E only when you need a real server.

**E2E coverage requirement**: Every feature that changes user-facing behavior MUST include a browser E2E test covering (1) navigation, (2) happy path, (3) persistence across reload, (4) cleanup/undo. Canonical pattern: `tests/e2e/ui/settings.spec.ts`. Bug fixes need only a unit test unless the bug involves multi-step server interactions.

## Recipes

One-liner task → entry point. Follow links for walkthroughs.

- **Add an API E2E test** → `tests/e2e/`, import `./in-process-harness.js`. See `gates-api.spec.ts`.
- **Add a UI E2E test** → `tests/e2e/ui/`, import `../gateway-harness.js`. See `session-interactions.spec.ts`.
- **Add a Tier 2.5 video-capturing E2E test** → import `tests/e2e/ui/fixtures.ts`, call `await rec.capture(label)`, run with `RECORDSCREEN=1`. See [docs/testing-tier-2-5.md](docs/testing-tier-2-5.md).
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [docs/rest-api.md](docs/rest-api.md).
- **Add a project** → `POST /api/projects` or sidebar "Add Project". Key: `src/server/agent/project-registry.ts`, `project-context-manager.ts`. The project assistant designs all workflows — server seeds none. See [docs/internals.md — Project assistant](docs/internals.md#project-assistant).
- **Remove a project** → settings → General → Remove. `DELETE /api/projects/:id`.
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method.
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`.
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. Discovered skills auto-exposed for autonomous activation via `activate_skill`. Skills support `references/`, `scripts/`, `assets/` subdirs (Level-3 progressive disclosure). See [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Modify slash-skill expansion / chip rendering** → `src/server/skills/resolve-skill-expansions.ts`, `skill-sidecar.ts`, `src/ui/components/SkillChip.ts`.
- **Add an IndexSource** → implement `IndexSource` from `src/server/search/types.ts`. See [docs/design/portable-search.md](docs/design/portable-search.md).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager` (`src/server/agent/project-context-manager.ts`).
- **Add/modify session creation** → `session-setup.ts`, wrappers in `session-manager.ts`. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Continue an archived session** → footer button → `POST /api/sessions/:archivedId/continue`. Lossless: server clones the source `.jsonl`. See [docs/design/lossless-continue-archived.md](docs/design/lossless-continue-archived.md).
- **Server-side read/unread state** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`. See [docs/internals.md — Read/unread state](docs/internals.md#readunread-state).
- **Config cascade** → builtin → server → project, for **roles, tools, and tool-group-policies only**. Workflows are project-scoped, not cascaded. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` or `.bobbit/config/tool-group-policies.yaml`. Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. `gate_signal` is team-lead-only. See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).
- **Per-role model / thinking-level override** → role YAML `model: "<provider>/<modelId>"` and `thinkingLevel`. Edit via Model tab in role-manager page. See [docs/design/per-role-model-overrides.md](docs/design/per-role-model-overrides.md).
- **Change message rendering** → `src/ui/components/Messages.ts` (standard), `message-renderer-registry.ts` (custom).
- **Modify message transcript ordering** → all transcript mutations route through `reduce(state, action)` in `src/app/message-reducer.ts`. Never push directly into `state.messages`. See [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify the PWA resume bootstrap / persisted UI snapshot** → `src/app/ui-snapshot.ts`, `src/app/main.ts` (`initApp` synchronous hydrate + `data-rendered` attr), `index.html` (inline skeleton + `__bobbitPrepaint` + watchdog), `public/sw.js` (shell SWR + 4 s nav timeout), `src/app/remote-agent.ts` (pageshow/freeze/resume + heartbeat). See [docs/design/pwa-resume.md](docs/design/pwa-resume.md).
- **Modify proposal panel streaming UX** → flag in `state.proposalStreamingByTag`; scroll preserved via `reconcileFollowTail` in `src/app/follow-tail.ts`.
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `src/server/skills/git-status-native.ts`. See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).
- **Add a multi-repo project / components / inline workflows** → components in `project.yaml::components[]`, workflows inline in `project.yaml::workflows`. See [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components) and [`defaults/workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md).
- **Cleanup remote branches on archive** → `deleteRemoteGoalBranches` in `server.ts` (goals); `session-eager-branch-delete.ts` (sessions). See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Per-project settings** → Settings → project tab. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent may call `propose_project` against the registered project; user accepts via `PUT /api/projects/:id/config`. See [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md).
- **Edit a proposal mid-session** → `view_proposal(type)` / `edit_proposal(type, old_text, new_text)`. Each successful write also writes a per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`. See [docs/design/editable-proposals.md](docs/design/editable-proposals.md), [docs/design/proposal-revision-snapshots.md](docs/design/proposal-revision-snapshots.md).
- **Add QA testing** → set `qa_start_command` (and friends) on the relevant component's `config:` map in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md).
- **Add a verification reminder site** → see `src/server/agent/verification-harness.ts`. After dispatching the reminder, await `SessionManager.waitForStreaming(sessionId, 10_000).catch(() => {})` before racing `waitForIdle`.
- **Create a design mockup** → `/mockup` skill or `.bobbit/config/docs/design-mockups.md`.
- **Generate an image** → `generate_image` tool routes through `POST /api/image-generation/generate`. See [docs/internals.md — Image generation routing](docs/internals.md#image-generation-routing).
- **Add / debug per-provider OAuth** → `src/server/auth/oauth.ts`; REST endpoints at `/api/oauth/*`. See [docs/rest-api.md — OAuth](docs/rest-api.md#oauth).

## Debugging

Keyword index — full diagnostic walkthroughs live in [docs/debugging.md](docs/debugging.md).

- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **`lastActivity` reads as "just now" after restart** — `isUserVisibleActivity` filter in `src/server/agent/session-manager.ts`.
- **Sandbox status** — `GET /api/sandbox-status`; container label `bobbit-project=<projectId>`.
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification`.
- **Worktree setup not running** — single source of truth is `components[*].worktreeSetupCommand`; everything routes through `runComponentSetups()`.
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`.
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`.
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` (`src/server/agent/project-context-manager.ts`) post-filters orphans.
- **Search index** — FlexSearch at `.bobbit/state/search.flex/`; delete to force rebuild.
- **Sidebar child loading** — server BFS enrichment, archived-goals `archivedSessions`.
- **QA screenshot token bloat** — extension must emit `[screenshot_file]` not `[screenshot_base64]`.
- **Stale project-proposal panel** — shallow-merge in `onProjectProposal`; see [docs/debugging.md](docs/debugging.md).
- **Monorepo subprojects not detected** — `src/server/agent/monorepo-scan.ts`; cap 30 candidates.
- **Legacy JSON-string `project.yaml` field rejected (HTTP 400)** — send structured arrays; QA keys live on components, not top level.
- **Skill chip / autonomous activation / resource manifest** — `src/server/skills/`, sidecar at `<stateDir>/skill-sidecar/<sessionId>.jsonl`.
- **Tool-guard extension ParseError** — quoting slip in template-literal generator; guarded by `tests/tool-guard-extension.test.ts`.
- **Auto-nudge flooding** — `nudgePending` guard in TeamManager.
- **Reviewer session triggers spurious team-lead nudge** — `kind: "reviewer"` filter in `resubscribeTeamEvents()` and `notifyTeamLead()`.
- **Resumed reviewer terminated ~46ms after restart** — await `waitForStreaming` before `waitForIdle` race.
- **`x-opencode-session` header missing or shared** — `writeAigwModelsJson` / `BOBBIT_SESSION_ID` env.
- **`models.json` stale after gateway upgrade** — `startupAigwCheck` rewrites on next gateway start.
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw (no silent fallback).
- **Live-steer lost after Stop** — must route via `SessionManager.deliverLiveSteer()`.
- **Session wedged after errored turn** — implicit unstick clears `lastTurnErrored`; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`.
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry, `abortAllWaits()`.
- **Large file writes freezing** — `truncateLargeToolContent()` at >32KB; check `.jsonl` exists.
- **Preview Open button broken** — `tool_result` must include `__preview_snapshot_v1__` marker block.
- **Streaming dedup/reorder** — events carry `seq`+`ts`; `{type:"resume", fromSeq}` on reconnect. See [docs/design/streaming-dedup-reorder.md](docs/design/streaming-dedup-reorder.md).
- **WS overflow guard** — `decideOverflowAction` in `ws-overflow-guard.ts`; transient spike tolerated via deferred re-check.
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`; `seq`-based LRU dedupe.
- **Scroll snaps back / vibration** — `AgentInterface` ResizeObserver auto-scrolls only on `delta > 0`. See [docs/internals.md — Chat scroll lock invariant](docs/internals.md#chat-scroll-lock-invariant).
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag[<tag>_proposal]` flag.
- **"Open proposal" on old card destroys later edits** — check for `__proposal_rev_v1__:<n>` marker; legacy archived sessions intentionally fall back.
- **Proposal panel doesn't update after `edit_proposal`** — check WS `proposal_update` frame and structured error code.
- **Stale messages on session navigate / dup messages / out-of-order widgets** — handled by reducer in `src/app/message-reducer.ts`.
- **Blank/white screen on iOS PWA resume** — bootstrap blocked on `waitForGateway` + WS connect; resolved by snapshot hydrate + Page Lifecycle hooks. See [docs/design/pwa-resume.md](docs/design/pwa-resume.md).
- **`Failed to load module script` / `MIME type of text/html`** — SW intercepting `/assets/*` (must be bypassed) or SPA fallback returning `index.html` for an asset URL. See [docs/design/pwa-resume.md](docs/design/pwa-resume.md).
- **Skeleton overlay intercepts clicks on settings / non-session pages** — hide-trigger must be `data-rendered` (every Lit page), not `data-connected` (session pages only); `pointer-events: none` is the safety net. See [docs/design/pwa-resume.md](docs/design/pwa-resume.md).
- **`pageshow` handler / heartbeat-gap stale-streaming bypass** — `_onPageShow` force-closes WS + reconnects on iOS bfcache restore; >5 min heartbeat gap bypasses `_hadDisconnectSinceLastSnapshot` for one resync. See [docs/design/pwa-resume.md](docs/design/pwa-resume.md).
- **Continue-Archived button missing** — only renders when archived AND no `goalId` AND no `delegateOf` AND project still registered.
- **Continued session missing earlier transcript** — confirm cloned `.jsonl` at `agentSessionFile` path; worktree-backed sources are rebased onto worktree-cwd slug-dir in `executeWorktreeAsync`.
- **Archived session footer shows wrong model** — archived `auth_ok` branch must push `state` frame via `buildArchivedStateData()`.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`.
- **400 "projectId required"** — pass `projectId` or `cwd` inside a registered project.
- **Orphan remote branches** — see [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Image generation failure** — `400` for malformed input, `500 { error }` for provider-side; never `502`/`503`.
- **Tier 2.5 report missing / ffmpeg failed** — set `FFMPEG_PATH` or install ffmpeg; report only emitted when `RECORDSCREEN=1`.
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=` directly.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Committing with a dirty working copy

When asked to commit, other unstaged/staged changes may exist from another agent or the user. **Never discard, stash, or reset those changes.** Stage only the files you modified (`git add <your-files>`) and commit. If your changes overlap and can't be cleanly separated, ask the user.

### Worktrees

Dev server runs from the **primary worktree** on `master`. All sessions use separate worktrees under `<project-root>-wt/<branch>/` (single-repo) or `<project-root>-wt/<branch>/<repo>/` (multi-repo). Default parent is `<rootPath>-wt/`; override with `worktree_root`. Assistant sessions don't edit code and don't get worktrees.

**Branch namespaces:** `pool/_pool-<id>`, `session/<id8>`, `goal/<slug>-<id>`, `staff-<name>-<id>`. See [docs/dev-workflow.md — Worktree branch namespaces](docs/dev-workflow.md#worktree-branch-namespaces).

**Multi-repo invariant:** every configured component repo (including data-only ones) gets a sibling worktree on the same branch. The agent's cwd is the per-branch container (`<rootPath>-wt/<branch>/`), mirroring the primary `rootPath` structure. See [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components).

**Always edit files in your session worktree, never in the primary worktree.** Editing the primary worktree risks merge conflicts during rebase, corruption of in-progress work, and breaking the running dev server. Even for infra files, the correct flow is: edit here → commit → push → pull from primary. See [docs/dev-workflow.md](docs/dev-workflow.md).

**Pushing to remote `master` does NOT update the dev server.** Pull into the primary worktree:

```bash
cd <primary-worktree> && git pull origin master
```

### Worktree setup command (per-component)

Configured **per component** via `components[*].worktree_setup_command` in `project.yaml`. Runs at the component's root path with `SOURCE_REPO` env var pointing at the matching primary path. 2-minute timeout per component, non-fatal, `sh -c`. No deduplication.

```yaml
components:
  - name: myapp
    repo: "."
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    commands: { build: npm run build, test: npm test }
```

Components without `worktree_setup_command` are silently skipped. Staff agent worktrees are auto-refreshed on each wake cycle. `runComponentSetups()` in `src/server/skills/worktree-setup.ts` is the single source of truth — every worktree-creation site routes through it.

## Reference docs

- [docs/internals.md](docs/internals.md) — tool policies, search, MCP, sandbox, config, disk state, goals, multi-project
- [docs/debugging.md](docs/debugging.md) — full diagnostic checklists
- [docs/dev-workflow.md](docs/dev-workflow.md) — running modes, restart workflow, worktree rationale
- [docs/testing-strategy.md](docs/testing-strategy.md) — test architecture and harness APIs
- [docs/testing-coverage.md](docs/testing-coverage.md) — per-area test coverage
- [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) — goal/workflow/gate data model
- [docs/blocking-tools.md](docs/blocking-tools.md) — blocking-tool pattern (`verification_result`)
- [docs/non-blocking-ask.md](docs/non-blocking-ask.md) — non-blocking `ask_user_choices` flow
- [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md) — transcript ordering single source of truth
