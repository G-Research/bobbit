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
```

Test filter flags: `--failures` (default), `--verbose`, `--full`.

UI-only changes need only unit tests. Server changes need E2E too. Docker-dependent tests (`tests/e2e/sandbox-docker.spec.ts`) skip automatically when Docker is unavailable — they never fail in CI without Docker.

**Test types:**
- **Unit** (`tests/*.spec.ts`, `tests/*.test.ts`): Playwright `file://` fixtures + Node test runner. See `mobile-header.spec.ts`.
- **API E2E** (`tests/e2e/*.spec.ts`): Import `test` from `./in-process-harness.js` — the gateway runs in the same Node process (no child process spawn). Covers HTTP/WS API tests, CRUD, agent protocol, etc. Runs as the `api` project in `playwright-e2e.config.ts` with 4 workers.
- **Browser E2E** (`tests/e2e/ui/*.spec.ts` + select non-ui files): Import `test` from `./gateway-harness.js` — spawns a real gateway child process. Used for tests that need a browser (`page` fixture), MCP integration, or process-level behavior (port allocation, localhost auth bypass). Runs as the `browser` project with 2 workers.
- **UI E2E** (`tests/e2e/ui/*.spec.ts`): A subset of browser E2E — fullstack tests that exercise user journeys (click buttons, fill forms, verify outcomes) through UI → WebSocket → server → mock agent → UI. Covers project management, goal creation, team lifecycle, session interactions, navigation, and settings. Run with: `npx playwright test --config playwright-e2e.config.ts --project browser tests/e2e/ui/`

**UI E2E page-object helpers** (`tests/e2e/ui/ui-helpers.ts`): Reusable helpers for browser tests. Import from `./ui-helpers.js`:
- `openApp(page)` — navigate with token auth, wait for sidebar to load
- `createSessionViaUI(page)` — click "New session", wait for textarea
- `sendMessage(page, text)` — fill textarea, press Enter
- `waitForAgentResponse(page, opts?)` — wait for assistant message (default: "OK")
- `navigateToHash(page, hash)` — set `location.hash`, wait for transition
- `navigateToGoalDashboard(page, goalId)` — navigate to `#/goal/<id>`, wait for dashboard
- `clickSidebarItem(page, label)` — click sidebar entry by text
- `getVisibleSessions(page)` — return sidebar session titles
- `waitForSessionIdle(sessionId)` — poll API until session is idle

**Mock agent keywords**: The mock agent in `tests/e2e/mock-agent.mjs` responds to keywords in the prompt. Send `GOAL_PROPOSAL` to trigger a `<goal_proposal>` XML block response (includes `<options>QA testing</options>`) — used to test the goal assistant flow without a real LLM.

**Choosing a harness for new E2E tests:**
- **`in-process-harness.js`** — Default for API-only tests (no browser, no MCP, no process-level behavior). Faster startup (~2s vs ~5-8s per worker). Exposes `sessionManager` on `GatewayInfo` for sandbox token testing.
- **`gateway-harness.js`** — Required when the test uses a `page` fixture (browser), needs MCP servers enabled, or tests process-level behavior (port allocation, auth bypass).

**Rules:**
- All tests run in isolation. In-process tests get `.e2e-inproc-<N>/`; spawned-gateway tests get `.e2e-worker-<port>/`.
- Never read/write `.bobbit/` in tests — use isolated directory from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent session. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests. Use E2E only when you need a real server.

## Recipes

**Add an API E2E test**: Create a `.spec.ts` file in `tests/e2e/`. Import `test, expect` from `./in-process-harness.js` and API helpers from `./e2e-setup.js`. The in-process harness starts the gateway in the same Node process — no child process spawn, no browser. Pattern: call REST/WS APIs via helpers → assert responses. See `gates-api.spec.ts` for a simple example.

**Add a UI E2E test**: Create a `.spec.ts` file in `tests/e2e/ui/`. Import `test, expect` from `../gateway-harness.js`, API helpers from `../e2e-setup.js`, and page helpers from `./ui-helpers.js`. Use `openApp(page)` to authenticate, page-object helpers for interactions, and API helpers for setup/teardown. See `session-interactions.spec.ts` for a simple example. Pattern: create state via API → interact via browser → assert via UI or API. Never use `setTimeout` — use Playwright's built-in waiting.

**E2E test coverage requirement**: Every feature that changes user-facing behavior MUST include browser-based E2E tests validating the full user journey. The workflow gates enforce this — the design-doc gate requires an E2E test plan, and the implementation gate runs an LLM review verifying E2E tests exist. A complete E2E test covers: (1) navigation — user can reach the feature, (2) happy path — core interaction works, (3) persistence — changes survive page reload, (4) cleanup — removal/undo reflects in UI. See `tests/e2e/ui/settings.spec.ts` for the canonical pattern. For bug fixes, a unit test or file:// fixture test is sufficient — E2E tests are only needed when the bug involves multi-step server interactions that can't be reproduced without a running gateway.

**Add a REST endpoint**: Edit `handleApiRoute()` in `src/server/server.ts`. See `git-diff`/`git-status` handlers for pattern (`execFileAsync`, path sanitization, 5s timeout). For project-scoped CRUD, see the `/api/projects` endpoints for the pattern (JSON body parsing, type guards, registry calls).

**Add a project**: Register via `POST /api/projects` (name + rootPath) for programmatic use, or use the "Add Project" button in the sidebar for the smart flow. The smart flow shows a path-only dialog (no name/color fields) with a Browse button for server-side directory navigation. On "Continue", `POST /api/projects/detect` checks the target directory and branches:

- **Path A — `.bobbit/` exists**: Auto-imports the project immediately (name auto-detected from `package.json` or directory basename). No assistant needed.
- **Path B — Directory has content but no `.bobbit/`**: Opens a Project Assistant session (detection mode, assistant type `"project"`) that explores the directory, detects the tech stack, and emits a `<project_proposal>` block with name, commands, system prompt, and `worktree_setup_command`.
- **Path C — Directory is empty or doesn't exist**: Opens a Project Assistant session (scaffolding mode, assistant type `"project-scaffolding"`) that guides through tech stack selection, scaffolding, and project configuration.

On proposal acceptance, the handler registers the project AND writes config fields (`build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `system_prompt_context`, `worktree_setup_command`) to `project.yaml` via `PUT /api/projects/:id/config`. Projects can optionally have a `palette` (one of 10 built-in palettes) and accent colors (`colorLight`/`colorDark`) — see [docs/internals.md](docs/internals.md#per-project-palette) for details. See [docs/internals.md](docs/internals.md#multi-project-architecture) for the full architecture.

**Remove a project**: To remove a non-default project, go to its per-project settings page → General tab and click "Remove Project" in the Danger Zone section. This calls `DELETE /api/projects/:id`, which unregisters the project from the server without deleting any files on disk. The button is hidden for the default project (the server's own CWD). After removal, the UI navigates back to system settings and refreshes the sidebar.

**Add a WebSocket command**: Add to `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts` switch, add `RpcBridge` method if needed. Examples: `set_model`, `set_thinking_level`.

**Viewer WebSocket (`/ws/viewer`)**: A read-only, sessionless WebSocket endpoint used by the goal dashboard to receive live gate verification events. Authenticates via `{ type: "auth", token }` like session connections, but does not associate with a session — events arrive through `broadcastToGoal()`'s fallback path (sends to all authenticated clients with no session). The dashboard opens this connection on mount and closes it on navigation away. Auto-reconnects with a 3s delay on unexpected close. See [docs/internals.md](docs/internals.md#viewer-websocket) for details.

**Add a UI component**: Create in `src/ui/components/`, export from `src/ui/index.ts`.

**Add a tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a tool**: Create YAML in `.bobbit/config/tools/<group>/`. Define `name`, `description`, `summary`, `group`, `provider`. Add extension code in group's `extension.ts` if needed. MCP tools are auto-discovered from `.mcp.json` — no YAML needed.

**Add a slash skill**: Create `SKILL.md` in `.claude/skills/<name>/` or `~/.claude/skills/<name>/`. YAML frontmatter: `description`, optional `argument_hint`, `allowed_tools`, `context`, `agent`. Auto-discovered by `discoverSlashSkills()`.

**Add/use MCP servers**: Configure in `.mcp.json` (project), `.bobbit/config/mcp.json` (overrides), or any of 7 discovery locations. In multi-project setups, MCP servers from all registered projects are discovered — not just the default project. See @docs/internals.md#mcp-servers for full priority list and multi-project behavior.

**Add a goal feature**: CRUD in `goal-manager.ts`/`goal-store.ts`. REST in `server.ts`. Assistant prompt in `goal-assistant.ts`. Proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`. Re-attempt: `buildReattemptContext()`, `startReattempt()`. Goals carry an optional `projectId` linking them to a registered project. All goal/task/gate operations route through `ProjectContextManager` to resolve the correct per-project store. Goals also carry `autoStartTeam` (boolean, defaults to `true`) — when enabled, the server automatically starts the team after worktree setup via `GoalManager.setupWorktreeAndStartTeam()`, removing the need for a manual "Start Team" click. `POST /api/goals` accepts `autoStartTeam` in the request body (default `true`). The goal creation form includes an "Auto-start team" toggle. Goal creation UI is rendered by `renderGoalForm()` in `src/app/render.ts`, called by both `goalPreviewPanel()` (assistant context) and `goalProposalPanel()` (proposal context). To add a new form field: update the `GoalFormConfig` interface, add rendering in `renderGoalForm()`, then wire callbacks in both wrappers — `goalPreviewPanel()` handles draft persistence, debounced title summarization, and re-attempt detection; `goalProposalPanel()` handles dismiss, saving state, and proposal sync.

**Inter-agent git handoff**: Tasks carry `baseSha`, `headSha`, and `branch` fields for local-only merges between agents — no PRs needed for inter-agent work. `baseSha` and `branch` are auto-populated when a task is assigned to a spawned agent. Agents set `headSha` on completion via `task_update(head_sha="...")`. The team lead merges locally: `git merge <task.branch>`. In sandboxed teams, agents share a bare repo mounted at `/team-repos/team-<goalId>.git` with a `team` remote and auto-push post-commit hook, so commits are visible across containers without pushing to an external remote. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md#git-handoff-fields) for the full lifecycle.

**Modify a store constructor**: All stores accept `stateDir` or `configDir` as a constructor parameter (not module-level globals). State stores (GoalStore, SessionStore, etc.) take `stateDir: string`; config stores (RoleStore, WorkflowStore, etc.) take `configDir: string`. When adding a new store, follow this pattern — never call `bobbitStateDir()` or `bobbitConfigDir()` at module level. See `ProjectContext` in `project-context.ts` for how stores are wired together. Managers (`GoalManager`, `TaskManager`) accept store instances directly — they no longer create stores internally. `StaffManager` accepts `ProjectContextManager` and resolves the correct per-project `StaffStore` on each operation. **Store resolution never falls back to a default project** — all resolution goes through `ProjectContextManager` methods like `getContextForGoal()`, `getContextForSession()`, or explicit `projectId`. If the project can't be resolved, the operation throws or returns null. The `getDefault()` and `getDefaultProjectId()` methods on `ProjectContextManager` are deprecated — use them only for bootstrapping or API creation endpoints where defaulting to the server CWD project is the correct contract. See [docs/internals.md](docs/internals.md#store-resolution-pattern) for the resolution pattern.

**Add/modify session creation logic**: Session creation uses a plan/execute pipeline in `session-setup.ts`. The three creation modes (normal, worktree, delegate) share composable pipeline steps (`resolveBridgeOptions`, `resolveGoalExtensions`, `resolveTools`, `resolvePrompt`, `resolveToolActivation`) with different executors (`executePlan` for normal/delegate, `executeWorktreeAsync` for worktree). `session-manager.ts` contains thin wrappers (`createSession`, `createDelegateSession`) that build a `SessionSetupPlan` and delegate to the pipeline. Persistence uses put-once-then-update: `persistOnce()` does a single `store.put()` at creation, then `persistSessionMetadata()` only calls `store.update()` for the `agentSessionFile` field.

**Change tool access policy**: Edit `.bobbit/config/tool-group-policies.yaml` (per-group) or role YAML `toolPolicies` (per-role). Three policy values: `allow` (immediate execution), `ask` (guard blocks, user prompted), `never` (tool not registered). Resolution: role+tool → role+group → tool default → group default → `allow`. See @docs/internals.md#tool-access-policies for full details.

**Change message rendering**: `src/ui/components/Messages.ts` for standard roles, `message-renderer-registry.ts` for custom types.

**Modify sandbox behavior**: Set `sandbox: "docker"` in `project.yaml`. Key files: `sandbox-pool.ts`, `docker-args.ts`, `sandbox-guard.ts`. Containers run on a dedicated `bobbit-sandbox-net` Docker bridge network with direct internet access (no proxy). All containers get resource limits (`--memory=4g`, `--cpus=2`, `--pids-limit=256`) and cloud metadata blackholes (`169.254.169.254`, `metadata.google.internal`, `metadata.internal` → `0.0.0.0`). Scoped sandbox tokens are in-memory only — never persisted to disk. The Docker image includes a git credential helper that reads `GITHUB_TOKEN` from the environment, enabling `git push` and `gh pr create` inside containers. The `sandbox_github_token` project setting (defaults to `true`) controls whether the host's GitHub token is injected into the container. Sandboxed team agents share a bare repo at `/team-repos/team-<goalId>.git` (created by `SandboxPool.createTeamRepo()`) with auto-push post-commit hooks — see [docs/internals.md](docs/internals.md#shared-team-repo) for details. See @docs/internals.md#docker-sandbox for full architecture.

**Preview endpoint security**: The `GET/POST /api/preview` endpoints accept an optional `sessionId` query parameter to scope preview HTML per session. The `sessionId` is validated against a strict UUID regex (`/^[a-f0-9-]{36}$/i`) — any non-UUID value (including path traversal sequences like `../`, backslashes, or colons) returns a 400 error. This prevents sandbox agents from writing `.html` files outside the state directory via crafted sessionIds. As defense in depth, the Vite dev server config (`vite.config.ts`) includes `server.fs.deny` rules blocking access to `.bobbit/state`, `.bobbit/config`, and `node_modules/.vite`, which prevents Vite's `/@fs/` route from serving sensitive files even if a file were written to those directories.

**Configure per-project settings**: Settings uses a two-tier layout — scope row (System + per-project tabs) above sub-tabs. System scope has all tabs; per-project scope shows Commands & Sandbox, Models, Config Directories, and Appearance. The Appearance tab has a palette picker and dual light/dark accent color inputs. Project settings inherit from System and can override individual fields. The sidebar gear icon on project headers navigates directly to that project's settings. URL scheme: `#/settings/<scope>/<tab>` where scope is `system` or a project UUID. REST: `GET/PUT /api/projects/:id/config`, `GET /api/projects/:id/config/resolved` (with `{ value, source }` annotations). See [docs/internals.md](docs/internals.md#per-project-config) for the resolution cascade.

**Manage config directories**: Settings → Config Directories tab, or `config_directories` in `project.yaml`. Config directories are scoped per-project — each project's `config_directories` affects only that project's sessions for skills, MCP servers, and agent files. See @docs/internals.md#config-scan-directories.

**Add QA testing to a project**: Add `qa_*` keys to `project.yaml` — at minimum `qa_start_command` (how to start an isolated server). The `/qa-test` slash skill reads these keys and orchestrates the ephemeral environment lifecycle. QA testing runs as an optional `agent-qa` verification step on the implementation gate (enabled per-goal via toggle). The QA toggle in the goal creation form is automatically disabled with an explanatory tooltip when `qa_start_command` is not configured for the project. See [docs/qa-testing.md](docs/qa-testing.md) for full config reference and protocol details.

**Seed QA ephemeral environment**: The `/qa-test` skill automatically seeds the ephemeral server with realistic fixture data (1 project, 1 goal with gates, 3 archived sessions with tool call messages, team state). The seed script at `scripts/qa-seed/seed.mjs` generates this data. Run manually: `node scripts/qa-seed/seed.mjs <WORK_DIR>`. See `scripts/qa-seed/README.md` for details on the seeded data format.

**Workflow verify step descriptions**: Verify steps in workflow YAML support an optional `description` field. When set on an optional step, it renders as an ⓘ tooltip next to the step's toggle in the goal creation form. Example:
```yaml
- name: agent-qa
  type: agent-qa
  optional: true
  label: "QA Testing"
  description: "Spins up an ephemeral server and drives a real browser through user scenarios."
```

## Debugging

See @docs/debugging.md for scannable checklists covering all subsystems.

Quick pointers for the most common issues:

- **Streaming sluggishness**: `AgentInterface` must NOT call `requestUpdate()` in the `message_update` handler — only `StreamingMessageContainer.setMessage()` updates during streaming (rAF-batched). See @docs/debugging.md#streaming-performance for full checklist.
- **Duplicate messages**: Check `flushDeferredMessage()` in `remote-agent.ts` — `MessageList` and `StreamingMessageContainer` must never overlap.
- **Context bar / model state**: After restart, `sendFallbackModelState()` in `handler.ts` sends persisted model info when `getState()` fails. If context bar shows wrong values, verify `modelProvider`/`modelId` in `<project-root>/.bobbit/state/sessions.json`. Client retries `get_state` after 3s on reconnect. See @docs/debugging.md#context-bar--model-state for full checklist.
- **Session persistence**: Check `<project-root>/.bobbit/state/sessions.json` (per-project). Missing `.jsonl` = session skipped on restore.
- **Sandbox**: `GET /api/sandbox-status` for Docker state. Containers use `bobbit-sandbox-net` bridge network — check `docker network inspect bobbit-sandbox-net` for connectivity issues. For shared team repo issues, check `ls <poolDir>/team-*.git` on the host to verify the bare repo exists; inside a container, check `git remote -v` for the `team` remote pointing to `/team-repos/team-<goalId>.git`. Run sandbox tests: `npx playwright test --config playwright-e2e.config.ts --project=api sandbox-security sandbox-docker`.
- **Search**: Each project has its own `<project-root>/.bobbit/state/search.db`. Delete and restart to rebuild. Searches aggregate across all project indexes. See @docs/debugging.md#search-index for full checklist.
- **Gates**: Check `GET /api/goals/:id/gates` for dependency state. Check `GET /api/goals/:id/verifications/active` for in-flight verification with phase progression. Steps may show `"skipped"` status if an earlier phase failed or if an optional step is not enabled for the goal. If the verification output modal is empty, check both the API response (`/api/goals/:id/verifications/active` step output) and the `/ws/viewer` WebSocket connection (browser DevTools → Network → WS tab). The modal bootstraps from the API on open, then streams via WS events. See @docs/debugging.md#gates for the full checklist. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md#phased-verification) for phased execution details.
- **Multi-project / per-project state**: Each project stores its own state in `<project-root>/.bobbit/state/` (goals, sessions, tasks, teams, gates, staff, search index, costs). The server aggregates via `ProjectContextManager`. Check `GET /api/projects` for registered projects. Sessions/goals/staff carry optional `projectId`; filter with `?projectId=` on list endpoints. Store resolution never falls back to a "default project" — all operations resolve the correct store via `ProjectContextManager` or throw/return null. API creation endpoints (sessions, goals, staff) default to the server CWD project when no `projectId` is provided — this is the API contract, not a store-resolution fallback. Config directories (MCP servers, skills, AGENTS.md/agent files) are resolved per-project through each project's `config_directories` setting. Per-project config: `GET /api/projects/:id/config/resolved` shows resolved values with source. See [docs/internals.md](docs/internals.md#multi-project-architecture) for architecture.
- **QA testing**: Check `qa_*` keys in project.yaml. The `/qa-test` skill requires `qa_start_command` at minimum. QA runs as an `agent-qa` verification step on the implementation gate. See [docs/qa-testing.md](docs/qa-testing.md).
- **State migration**: On first startup after upgrade, centralized state files are distributed to per-project dirs based on `projectId` tags. Central files renamed with `.pre-migration` suffix. Check for `.bobbit/state/.migrated-to-per-project` marker. See @docs/internals.md#state-migration for details.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Committing with a dirty working copy

When asked to commit, other unstaged/staged changes may exist from in-progress work by another agent or the user. **Never discard, stash, or reset those changes.** Instead, stage only the files you modified (`git add <your-files>`) and commit them. If your changes overlap with the existing modifications and you cannot cleanly separate them, ask the user for instructions.

### Worktrees

Dev server runs from **primary worktree** on `master`. Goal/agent sessions use separate worktrees under `<project-root>-wt-goal\`.

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
