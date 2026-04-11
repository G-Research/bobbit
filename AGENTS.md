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

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full guide.

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
- **API E2E** (`tests/e2e/*.spec.ts`): In-process gateway, no browser. Import from `./in-process-harness.js`.
- **Browser E2E** (`tests/e2e/ui/*.spec.ts`): Spawned gateway + Playwright browser. Import from `./gateway-harness.js`.
- **Manual integration** (`tests/manual-integration/`): Real agents, real Docker, crash/restart resilience. Not in CI.

See [docs/testing-strategy.md](docs/testing-strategy.md) for test architecture, harness selection, helper APIs, and mock agent details.

**Rules:**
- All tests run in isolation — never read/write `.bobbit/` directly, use the isolated directory from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests. Use E2E only when you need a real server.

**E2E test coverage requirement**: Every feature that changes user-facing behavior MUST include browser-based E2E tests. A complete E2E test covers: (1) navigation, (2) happy path, (3) persistence across reload, (4) cleanup/undo. See `tests/e2e/ui/settings.spec.ts` for the canonical pattern. Bug fixes need only a unit test unless the bug involves multi-step server interactions.

## Recipes

Each recipe gives the entry point and key files. For detailed walkthroughs, see the linked docs.

**Add an API E2E test**: Create `.spec.ts` in `tests/e2e/`, import from `./in-process-harness.js`. See `gates-api.spec.ts`.

**Add a UI E2E test**: Create `.spec.ts` in `tests/e2e/ui/`, import from `../gateway-harness.js`. Use helpers from `./ui-helpers.js`. See `session-interactions.spec.ts`.

**Add a REST endpoint**: Add handler in `handleApiRoute()` in `src/server/server.ts`. See `git-diff`/`git-status` for the pattern. See [docs/rest-api.md](docs/rest-api.md).

**Add a project**: `POST /api/projects` (programmatic) or "Add Project" sidebar button (smart flow with Path A/B/C detection). Key files: `project-registry.ts`, `project-context.ts`. See [docs/internals.md — Project assistant](docs/internals.md#project-assistant) for the full flow.

**Remove a project**: Per-project settings → General → "Remove Project". Calls `DELETE /api/projects/:id` (unregisters only, no files deleted).

**Add a WebSocket command**: Add to `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method if needed.

**Add a UI component**: Create in `src/ui/components/`, export from `src/ui/index.ts`.

**Add a tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts` for multi-tool pattern.

**Add a tool**: Builtin tools live in `defaults/tools/<group>/` (tracked in git, shipped to all users). Project-specific tool overrides go in `.bobbit/config/tools/<group>/` (runtime only, gitignored). MCP tools are auto-discovered from `.mcp.json`. See [docs/internals.md — MCP servers](docs/internals.md#mcp-servers).

**Add a slash skill**: Create `SKILL.md` in `.claude/skills/<name>/`. YAML frontmatter: `description`, optional `argument_hint`, `allowed_tools`, `context`, `agent`. Scoped per-project via `config_directories`. See [docs/internals.md — Config scan directories](docs/internals.md#config-scan-directories).

**Add a UI component**: Create in `src/ui/components/`, export from `src/ui/index.ts`. Notable built-in components: `BobbitLoadingAnimation` — an animated pixel-art bouncing mascot used as a loading indicator during session connection and dashboard loading. Review pane components live in `src/ui/components/review/`: `<review-pane>` (tabbed container), `<review-document>` (markdown renderer + text annotator with mobile selection support), `<annotation-popover>` (comment input — supports `mode="popover"` for desktop and `mode="bottom-sheet"` for mobile, plus `existingComment` for edit pre-fill), and `AnnotationStore` (cache-first with server-side persistence via REST API — annotations survive browser close, server restart, and are shared across clients on refresh). `ReviewPane` listens for the `annotation-cache-ready` window event to refresh badge counts after cache hydration on connect. All use light DOM for annotator compatibility. Exported from `src/ui/index.ts`. Mobile annotation support uses `window.matchMedia('(pointer: coarse)')` to detect touch-primary devices and enables a custom selection flow: `selectionchange` listener with 300ms debounce → floating "Add Comment" button → bottom sheet comment input. Desktop flow is completely unaffected — all mobile paths are gated behind an `_isMobile` flag. See [docs/review-pane-mobile.md](docs/review-pane-mobile.md) for the full mobile annotation architecture.

**Add a goal feature**: CRUD in `goal-manager.ts`/`goal-store.ts`, REST in `server.ts`, assistant prompt in `goal-assistant.ts`. Proposals use `propose_*` tool calls via `defaults/tools/proposals/extension.ts`. All goal operations route through `ProjectContextManager`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).

**Inter-agent git handoff**: Tasks carry `baseSha`, `headSha`, and `branch` for local merges between agents. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).

**Modify a store constructor**: Stores take `stateDir` or `configDir` as constructor params — never use module-level globals. Store resolution goes through `ProjectContextManager` (never falls back to a default). See [docs/internals.md — Store resolution](docs/internals.md#store-resolution-pattern).

**Add/modify session creation**: Plan/execute pipeline in `session-setup.ts`, thin wrappers in `session-manager.ts`. Three modes: normal, worktree, delegate. Non-goal/non-assistant sessions in git repos auto-get worktree branches. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).

**Config cascade**: Three layers: builtin → server → project. Most-specific wins. Key modules: `builtin-config.ts`, `config-cascade.ts`. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).

**Add a config type to the cascade**: Add loader to `BuiltinConfigProvider`, add `resolveX()` to `ConfigCascade`, wire REST endpoint, add UI scope row + origin badges (import from `config-scope.ts`).

**Change tool access policy**: Builtin group policies are in `defaults/tool-group-policies.yaml`. To override per-project, edit `.bobbit/config/tool-group-policies.yaml`. Per-role overrides go in role YAML `toolPolicies`. Three values: `allow`, `ask`, `never`. See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).

**Change message rendering**: `src/ui/components/Messages.ts` for standard roles, `message-renderer-registry.ts` for custom types.

**Modify sandbox behavior**: Set `sandbox: "docker"` in `project.yaml`. Key files: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. One long-lived container per project. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).

**Run maintenance cleanup**: Settings → Maintenance tab. Three sections: orphaned worktrees, orphaned sessions, expired archives. Each has scan → preview → execute. Cleanup is never automatic.

**Configure per-project settings**: Settings → project tab → sub-tabs. Config inherits from System, overridable per field. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).

**Add QA testing**: Add `qa_start_command` (minimum) to `project.yaml`. Runs as optional `agent-qa` verification step. See [docs/qa-testing.md](docs/qa-testing.md).

## Debugging

See [docs/debugging.md](docs/debugging.md) for scannable checklists covering all subsystems — streaming, messages, sessions, sandbox, gates, search, multi-project, and more.

Key quick checks:
- **Session persistence**: `<project-root>/.bobbit/state/sessions.json` — missing `.jsonl` = session skipped on restore.
- **Sandbox status**: `GET /api/sandbox-status`. Container label: `bobbit-project=<projectId>`.
- **Stuck gate verification**: Cancel via `POST /api/goals/:id/gates/:gateId/cancel-verification` or the dashboard Cancel button.
- **Gate/task tool bloat**: Agent tools (`gate_list`, `gate_status`, `task_list`) use `?view=summary` by default for slim responses. Use `gate_inspect` to drill into content, verification output, or signal history on demand. See [docs/rest-api.md — Summary views](docs/rest-api.md#summary-views-viewsummary).
- **Search index**: Delete `<project-root>/.bobbit/state/search.db` and restart to rebuild.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Committing with a dirty working copy

When asked to commit, other unstaged/staged changes may exist from in-progress work by another agent or the user. **Never discard, stash, or reset those changes.** Instead, stage only the files you modified (`git add <your-files>`) and commit them. If your changes overlap with the existing modifications and you cannot cleanly separate them, ask the user for instructions.

### Worktrees

Dev server runs from **primary worktree** on `master`. All sessions use separate worktrees — goal sessions under `<project-root>-wt-goal/`, regular sessions under `<project-root>-wt-session/`. Assistant sessions (goal/project/tool assistants) are the exception: they don't edit code and don't get worktrees.

**Always edit files in your session worktree, never in the primary worktree.** The user or other context may reference files by their primary-worktree path — read those for reference, but all edits, builds, and git operations must happen in your CWD (your session worktree). The same source tree is available at both paths; editing the primary worktree risks conflicts with the dev server and other agents.

> **Why this matters:** The primary worktree is shared, mutable state — the dev server runs from it, other agents may have uncommitted work there, and the user may be editing files in it. When you `cd` into the primary worktree and make changes, you can cause merge conflicts during rebase, corrupt other agents' in-progress work, or break the running dev server. Even if your intent is to change infrastructure files (Dockerfiles, configs) that "need to end up" in the primary worktree, the correct flow is: edit in your worktree → commit → push to origin → pull from primary. One `cd /workspace` violation cascades — once you're there, all subsequent commands (edit, git add, commit, rebase) operate on shared state. Treat your working directory as a hard constraint, not a suggestion.

**Pushing to remote `master` does NOT update the dev server.** Pull into the primary worktree:

```bash
cd <primary-worktree> && git pull origin master
```

You cannot `git checkout master` from a goal worktree — push to remote and pull from primary instead.

### Worktree setup command

Configured via `worktree_setup_command` in `project.yaml`. Runs in new worktree dir with `SOURCE_REPO` env var. 2-minute timeout, non-fatal. Runs via `sh -c`.

```yaml
worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
# or: cp -r "$SOURCE_REPO/node_modules" node_modules
```

If not set, no setup runs (intentional — Bobbit doesn't assume your package manager).

## Reference docs

- @docs/internals.md — tool policies, search, MCP, sandbox, config directories, disk state, goals, multi-project architecture
- @docs/debugging.md — scannable debugging checklists for all subsystems
- [docs/dev-workflow.md](docs/dev-workflow.md) — running modes, restart workflow, safe change process
- [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) — goal/workflow/gate data model and lifecycle
