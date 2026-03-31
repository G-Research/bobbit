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
npm run test:e2e       # E2E tests — each worker spawns its own gateway (<90s)
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
npm run test:e2e 2>&1 | tail -5  # E2E tests (<90s, spawns gateways)
```

Test filter flags: `--failures` (default), `--verbose`, `--full`.

UI-only changes need only unit tests. Server changes need E2E too.

**Test types:**
- **Unit** (`tests/*.spec.ts`, `tests/*.test.ts`): Playwright `file://` fixtures + Node test runner. See `mobile-header.spec.ts`.
- **E2E** (`tests/e2e/*.spec.ts`): Import `test` from `./gateway-harness.js` for auto-started gateway per worker. See `session-lifecycle-ui.spec.ts` for fullstack pattern.

**Rules:**
- All tests run in isolation. E2E tests get unique `BOBBIT_DIR` (`.e2e-worker-<port>/`).
- Never read/write `.bobbit/` in tests — use isolated directory from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent session. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests. Use E2E only when you need a real server.

## Recipes

**Add a REST endpoint**: Edit `handleApiRoute()` in `src/server/server.ts`. See `git-diff`/`git-status` handlers for pattern (`execFileAsync`, path sanitization, 5s timeout).

**Add a WebSocket command**: Add to `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts` switch, add `RpcBridge` method if needed. Examples: `set_model`, `set_thinking_level`.

**Add a UI component**: Create in `src/ui/components/`, export from `src/ui/index.ts`.

**Add a tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a tool**: Create YAML in `.bobbit/config/tools/<group>/`. Define `name`, `description`, `summary`, `group`, `provider`. Add extension code in group's `extension.ts` if needed. MCP tools are auto-discovered from `.mcp.json` — no YAML needed.

**Add a slash skill**: Create `SKILL.md` in `.claude/skills/<name>/` or `~/.claude/skills/<name>/`. YAML frontmatter: `description`, optional `argument_hint`, `allowed_tools`, `context`, `agent`. Auto-discovered by `discoverSlashSkills()`.

**Add/use MCP servers**: Configure in `.mcp.json` (project), `.bobbit/config/mcp.json` (overrides), or any of 7 discovery locations. See @docs/internals.md#mcp-servers for full priority list.

**Add a goal feature**: CRUD in `goal-manager.ts`/`goal-store.ts`. REST in `server.ts`. Assistant prompt in `goal-assistant.ts`. Proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`. Re-attempt: `buildReattemptContext()`, `startReattempt()`.

**Add/modify session creation logic**: Session creation uses a plan/execute pipeline in `session-setup.ts`. The three creation modes (normal, worktree, delegate) share composable pipeline steps (`resolveBridgeOptions`, `resolveGoalExtensions`, `resolveTools`, `resolvePrompt`, `resolveToolActivation`) with different executors (`executePlan` for normal/delegate, `executeWorktreeAsync` for worktree). `session-manager.ts` contains thin wrappers (`createSession`, `createDelegateSession`) that build a `SessionSetupPlan` and delegate to the pipeline. Persistence uses put-once-then-update: `persistOnce()` does a single `store.put()` at creation, then `persistSessionMetadata()` only calls `store.update()` for the `agentSessionFile` field.

**Change tool access policy**: Edit `.bobbit/config/tool-group-policies.yaml` (per-group) or role YAML `toolPolicies` (per-role). Resolution: role+tool → role+group → tool default → group default → `always-allow`. See @docs/internals.md#tool-access-policies for full details.

**Change message rendering**: `src/ui/components/Messages.ts` for standard roles, `message-renderer-registry.ts` for custom types.

**Modify sandbox behavior**: Set `sandbox: "docker"` in `project.yaml`. Key files: `sandbox-proxy.ts`, `sandbox-pool.ts`, `docker-args.ts`, `sandbox-guard.ts`. See @docs/internals.md#docker-sandbox for full architecture.

**Manage config directories**: Settings → Config Directories tab, or `config_directories` in `project.yaml`. See @docs/internals.md#config-scan-directories.

## Debugging

See @docs/debugging.md for scannable checklists covering all subsystems.

Quick pointers for the most common issues:

- **Duplicate messages**: Check `flushDeferredMessage()` in `remote-agent.ts` — `MessageList` and `StreamingMessageContainer` must never overlap.
- **Session persistence**: Check `.bobbit/state/sessions.json`. Missing `.jsonl` = session skipped on restore.
- **Sandbox**: `GET /api/sandbox-status` for Docker state. Proxy logs prefixed `[sandbox-proxy]`.
- **Search**: Delete `.bobbit/state/search.db` and restart to rebuild index.
- **Gates**: Check `GET /api/goals/:id/gates` for dependency state.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

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

- @docs/internals.md — tool policies, search, MCP, sandbox, config directories, disk state, goals
- @docs/debugging.md — scannable debugging checklists for all subsystems
- [docs/dev-workflow.md](docs/dev-workflow.md) — running modes, restart workflow, safe change process
- [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) — goal/workflow/gate data model and lifecycle
