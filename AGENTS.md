# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Full build (server + UI)
npm run dev:harness    # Gateway via restart harness + vite (use this for dev)
npm run restart-server # Rebuild & restart after server changes
npm run check          # Type-check server + web (no emit)
npm run test:unit      # Unit — file:// fixtures + Node runner (<30s)
npm run test:e2e       # E2E — API (in-process) + browser (spawned gateway)
npm run test:manual    # Manual integration — real agents + Docker (~5 min)
SCREENSHOTS=1 npm run test:manual  # + browser screenshots + HTML report
```

Dev: `npm run dev:harness`. UI changes (`src/ui/`, `src/app/`) hot-reload; server changes (`src/server/`) require `npm run restart-server`. Always `npm run check` before restarting. Sessions survive restarts via `.bobbit/state/sessions.json`. See [docs/dev-workflow.md](docs/dev-workflow.md).

## Testing

**When to run what:** UI-only → `test:unit`. Server → `test:unit` + `test:e2e`. Session lifecycle / sandbox / worktree / restart → also `test:manual`. Filter flags: `--failures` (default), `--verbose`, `--full`. Docker tests skip automatically when Docker is unavailable.

**Test types:**
- **Unit** (`tests/*.spec.ts`, `tests/*.test.ts`): Playwright `file://` fixtures + Node test runner.
- **API E2E** (`tests/e2e/*.spec.ts`): in-process gateway. Import from `./in-process-harness.js`.
- **Browser E2E** (`tests/e2e/ui/*.spec.ts`): spawned gateway + Playwright. Import from `../gateway-harness.js`.
- **Manual integration** (`tests/manual-integration/`): real agents, real Docker. Not in CI.

See [docs/testing-strategy.md](docs/testing-strategy.md), [docs/testing-coverage.md](docs/testing-coverage.md).

**Rules:**
- Tests run in isolation — never read/write `.bobbit/` directly; use the isolated dir from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent. Use Playwright `webServer` config.
- Prefer `file://` fixtures for new tests; use E2E only when you need a real server.
- **E2E coverage requirement**: every user-facing feature MUST include a browser E2E covering navigation, happy path, persistence across reload, cleanup/undo. Pattern: `tests/e2e/ui/settings.spec.ts`.
- **Run tests before committing.** **No flaky tests** — every failure is a real bug. **Add or update tests** for every feature or bug fix.

## Recipes

One-liner task → entry point. Follow links for walkthroughs.

### Tests
- **Add an API E2E test** → `tests/e2e/`, import `./in-process-harness.js`. See `gates-api.spec.ts`.
- **Add a UI E2E test** → `tests/e2e/ui/`, import `../gateway-harness.js`. See `session-interactions.spec.ts`.
- **Add a Tier 2.5 video-capturing E2E test** → [docs/testing-tier-2-5.md](docs/testing-tier-2-5.md).
- **Assert tail-chat / scroll-pin in an E2E test** → helpers in `tests/e2e/ui/tail-chat-helpers.ts`. Outcome-only — never assert on `_stickToBottom` / private fields. See [docs/design/tail-chat-redesign.md](docs/design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).

### Server / API
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [docs/rest-api.md](docs/rest-api.md).
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`. YAML fields driving the per-turn `# Tools` section in the system prompt:
  - `params: [name, name?, ...]` (optional) — renders as `name(params) — summary`. Trailing `?` marks an optional parameter. Omit the field to render as `name — summary` with no parens.
  - `summary` — ≤ 10 words, sentence-fragment OK; this is the only prose shown per-turn.
  - `description` (function-schema field) — ≤ 15 words; what the model sees alongside the JSON-schema params.
  - `docs` and `detail_docs` are **not** inlined into the prompt. They are folded (in that order) into `<stateDir>/tool-docs/<group>.md` by `generateDetailDocs()`, and the prompt's per-group header points at that file (`## <Group> — see <path>`). Put any prose, examples, anti-patterns there. See [docs/internals.md — MCP tool documentation](docs/internals.md#mcp-tool-documentation) for the full prompt layout.
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. See [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager` (`src/server/agent/project-context-manager.ts`).
- **Add/modify session creation** → `session-setup.ts`, wrappers in `session-manager.ts`. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Add a verification reminder site** → `src/server/agent/verification-harness.ts`. Await `waitForStreaming(...).catch(()=>{})` before `waitForIdle`.
- **Return errors from a server handler** → use `jsonError(status, err, extra?)` in `src/server/server.ts` for any caught exception so `stack` flows to the client modal. Validation responses with literal strings stay as `json({ error: "..." }, ...)`. See [docs/rest-api.md — Error response shape](docs/rest-api.md#error-response-shape).

### Sessions, status, steer
- **Mutate session status** → `broadcastStatus()` in `src/server/agent/session-status.ts` is the **single writer** for `session.status`. Client: `_state.status` on `RemoteAgent` is canonical; `isStreaming`/`isArchived`/`isPreparing` are derived getters. `case "session_status"` is the sole writer (plus `case "state"` on attach, `reset()` on navigate). `agent_start`/`agent_end`/`error` are signals only. See [docs/design/unify-session-status.md](docs/design/unify-session-status.md).
- **Modify steer / queue dispatch** → single dispatch site `SessionManager._dispatchSteer()` in `src/server/agent/session-manager.ts`. Rows leave `promptQueue` *before* `rpcClient.steer()`, then enter shadow ledger `inFlightSteerTexts`. Never reintroduce `PromptQueue.dispatched`. See [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Continue an archived session** → `POST /api/sessions/:archivedId/continue`. See [docs/design/lossless-continue-archived.md](docs/design/lossless-continue-archived.md).
- **Re-attempt a goal** → `POST /api/sessions { reattemptGoalId }` → `buildReattemptContext()`.
- **Server-side read/unread state** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`.
- **Read another session's transcript (`read_session` tool)** → parser `src/server/agent/transcript-reader.ts`; `GET /api/sessions/:id/transcript`; same-project auth via `x-bobbit-session-id` header.

### UI
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Show a server error in a modal** → `<error-details>` (`src/ui/components/ErrorDetails.ts`) renders message + optional code + collapsible stack. API wrappers in `src/app/api.ts` parse `await res.json()`, attach `code`/`stack` to the thrown `Error`, and forward both to `showConnectionError(title, message, { code, stack })` in `src/app/dialogs.ts`. The background polling site in `refreshSessions()` (`src/app/api.ts`) is intentionally silent.
- **Add a route-level page (lazy-loaded)** → add a `lazyPage(...)` branch in `mainArea()` in `src/app/render.ts`. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Add a heavy tool renderer (lazy)** → `registerLazyToolRenderer()` in `src/ui/tools/index.ts`; placeholder + `TOOL_RENDERER_LOADED_EVENT` swap.
- **Defer a heavy library (lazy load)** → `src/ui/lazy/markdown-block.ts::ensureMarkdownBlock()` pattern; or `await import()` for value imports.
- **Change message rendering** → `src/ui/components/Messages.ts` (standard); `message-renderer-registry.ts` (custom).
- **Modify message transcript ordering** → all transcript mutations route through `reduce(state, action)` in `src/app/message-reducer.ts`. Never push directly into `state.messages`. See [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify proposal panel streaming UX** → flag in `state.proposalStreamingByTag`; scroll preserved via `reconcileFollowTail` in `src/app/follow-tail.ts`.
- **Large content truncation** → `truncate-large-content.ts` (>32 KB). Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Copy session link button** → header ghost icon in `src/app/render.ts`. `showHeaderToast()` (`data-testid="header-toast"`, distinct from `proposal-toast`); `CopyLinkFallbackDialog` on clipboard reject.
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `src/server/skills/git-status-native.ts`. See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).

### Projects, config, sandbox
- **Add a project** → `POST /api/projects`. Key: `src/server/agent/project-registry.ts`, `project-context-manager.ts`. Project assistant designs all workflows. See [docs/internals.md](docs/internals.md#project-assistant).
- **Splash-screen new-session gating** → buttons in `src/app/render.ts` gated on `state.projects.length` (0 → "New Project" CTA; 1 → bound session; ≥2 → splash project picker via `state.splashProjectPickerOpen`). System-scope tool-assistants pass `projectId: "system"`. See [docs/internals.md — Synthetic system project](docs/internals.md#synthetic-system-project).
- **Remove a project** → settings → General → Remove. `DELETE /api/projects/:id`.
- **Symlink-aware project registration** → `detectSymlinkRoot()` in `src/server/agent/project-registry.ts`. `POST /api/projects` returns 400 `{ code: "symlink_root", canonical }`; UI re-submits with `acceptCanonical: true`. `findByCwd()` canonicalises both sides; `getByPath()` does NOT.
- **Per-project settings** → Settings → project tab. `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent may call `propose_project`; user accepts via `PUT /api/projects/:id/config`. See [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md).
- **Add a multi-repo project / components / inline workflows** → `project.yaml::components[]` and `project.yaml::workflows`. See [docs/internals.md](docs/internals.md#multi-repo--components), [`defaults/workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md).
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md](docs/internals.md#docker-sandbox).
- **Add QA testing** → `qa_start_command` etc. on the component's `config:` map in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md).
- **Config cascade** → builtin → server → project, for roles, tools, tool-group-policies, and `system-prompt.md` (resolves via `resolveSystemPromptPath()`; user override at `.bobbit/config/system-prompt.md` wins). Workflows are project-scoped, not cascaded. See [docs/internals.md](docs/internals.md#config-cascade).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` or `.bobbit/config/tool-group-policies.yaml`. Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. `gate_signal` is team-lead-only. MCP groups default to `allow`.
- **Per-role model / thinking override** → role YAML `model: "<provider>/<modelId>"` and `thinkingLevel`. See [docs/design/per-role-model-overrides.md](docs/design/per-role-model-overrides.md).
- **Pin agent model at spawn time** → `RpcBridgeOptions.initialModel`/`initialThinkingLevel` → `--model`/`--thinking` flags via `buildAgentArgs`. Resolution: role override → `default.sessionModel` (or `default.reviewModel`) → undefined.
- **Archived session footer model** → `buildArchivedStateData()` in `src/server/ws/handler.ts` sent on archived `auth_ok`.

### MCP
- **MCP meta-tool aggregation (server → sub-namespace → op)** → single source of truth `parseMcpToolName()` in `src/server/mcp/mcp-meta.ts`. Aggregation in `src/server/agent/tool-activation.ts` keyed by `(server, sub)`. Policy keys via `mcpPolicyKeys(name) → {group, tool}`; tool-key beats group-key. See [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md).

### Goals, workflows, gates
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Archive a goal (UI)** → sidebar/dashboard trash funnels through `deleteGoal()` in `src/app/api.ts`; detects active team, runs `teardownTeam()` before `DELETE /api/goals/:id`.
- **Cleanup remote branches on archive** → `deleteRemoteGoalBranches` (goals); `session-eager-branch-delete.ts` (sessions). See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).

### Proposals
- **Edit a proposal mid-session** → `view_proposal(type)` / `edit_proposal(type, old, new)`. Per-rev snapshots under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`. See [docs/design/editable-proposals.md](docs/design/editable-proposals.md).
- **Dismiss/restore invariant for proposal panels** → `goalDraft.restore`/`roleDraft.restore`/`projectDraft.restore` in `src/app/session-manager.ts` gate rehydration on `isProposalDismissedTyped`. Dismiss does NOT delete the on-disk draft. Only `goal`/`role`/`project` persist drafts; `staff`/`tool`/`workflow` are transient.
- **Header toast vs proposal toast testid collision** → `header-toast` vs `proposal-toast`; two slots in `src/app/render.ts`.

### Worktree (operational)
- **Pool worktree placed under `<projectDir>-wt/` instead of `<repoRoot>-wt/`** → `WorktreePool` constructor in `src/server/agent/worktree-pool.ts` resolves `opts.repoPath` to git toplevel; both `initWorktreePoolForProject` sites in `src/server/server.ts` also resolve. Pinned by `tests/worktree-pool-nested-rootpath.test.ts`.

### Preview / HTML / images
- **Preview HTML with sibling assets** → `preview_open({ html | file, assets?, manifest? })`. **Explicit opt-in**: bare `file` copies only the entry HTML; siblings declared via `assets: [...]` or a `manifest` JSON. Snapshot marker: `__preview_snapshot_v3__`. Re-opening the same `file` (including paths that resolve inside the mount itself) is safe — `mountFile()` stages into a sibling tmp dir and atomically swaps. See [docs/preview-architecture.md](docs/preview-architecture.md).
- **Author HTML output** → [`defaults/docs/html-rendering.md`](defaults/docs/html-rendering.md). One artefact, one surface. Use theme tokens (`--background`, `--card`, `--chart-1..6`, `--positive`/`--negative`/`--warning`/`--info`).
- **Generate an image** → `generate_image` → `POST /api/image-generation/generate`.

## Debugging

Keyword index — full diagnostic walkthroughs live in [docs/debugging.md](docs/debugging.md). All entries below: see `debugging.md` (or the named design doc) for the full checklist.

### Session / status / steer
- **Stop button stuck visible / duplicate user message on second send** — divergence between `_state.isStreaming` and `gatewaySessions[i].status`. Check no new write to `_state.status` outside `case "session_status"`/`case "state"`/`reset()`; no server write to `session.status` outside `broadcastStatus()`. See [docs/design/unify-session-status.md](docs/design/unify-session-status.md).
- **Live-steer lost / duplicated after Stop** — single `_dispatchSteer()` + shadow ledger `inFlightSteerTexts`; never re-add `PromptQueue.dispatched`. See [steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Session wedged after errored turn** — implicit unstick; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`.
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry; `abortAllWaits()` from `deliverLiveSteer`.
- **Streaming dedup/reorder** — `seq`+`ts` envelope, `{type:"resume", fromSeq}` on reconnect.
- **Bypass class for the seq envelope** — see "Compaction frames or synthetic agent_end lost on reconnect" below; only `{type:"event"}` frames go through `EventBuffer.push()`.
- **WS overflow guard** — `decideOverflowAction` in `src/server/ws/ws-overflow-guard.ts`.
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`.
- **Stale messages / dups / out-of-order widgets on session navigate** — reducer in `src/app/message-reducer.ts`.
- **Compaction frames or synthetic agent_end lost on reconnect** — every `{type:"event"}` frame must route through `emitSessionEvent` (not the bare `broadcast()` in `src/server/ws/handler.ts`); only event frames are seq-stamped via `EventBuffer.push()`. Non-event frames (`task_changed`, `state`, `client_joined`) intentionally bypass.
- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **`lastActivity` reads "just now" after restart** — `isUserVisibleActivity` filter in `session-manager.ts`.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`.

### Worktree / sandbox / projects
- **Worktree setup not running** — single source of truth `runComponentSetups()` in `src/server/skills/worktree-setup.ts`.
- **Sandbox status / project container** — `GET /api/sandbox-status`; label `bobbit-project=<projectId>`.
- **Synthetic system project / `projectId: "system"`** — registered at startup; `hidden: true`; anchored at `<bobbitStateDir>/system-project/`.
- **Symlinked project root rejected with `code: symlink_root`** — `POST /api/projects` returns 400; UI re-submits with `acceptCanonical: true`. CLI/scripted callers must do the same or pass canonical path.
- **`findByCwd` returns undefined for a symlinked cwd** — should not happen post-fix; `findByCwd()` canonicalises both sides via `realpathSync`. `getByPath()` is intentionally NOT canonicalised.
- **Monorepo subprojects not detected** — `src/server/agent/monorepo-scan.ts`; cap 30 candidates.
- **Legacy JSON-string `project.yaml` field rejected (HTTP 400)** — send structured arrays.
- **400 "projectId required"** — splash buttons gated on `state.projects.length`; system tool-assistants pass `projectId: "system"`.

### MCP
- **MCP server unavailable / partial outage** — stub meta extension at `<stateDir>/mcp-extensions/…`.
- **MCP per-op `never` policy not enforced** — two layers: `mcpPolicyKeys` (Layer A) + `resolveGrantPolicy` (Layer B, `/api/internal/mcp-call`).
- **MCP gateway server collapses sub-namespaces into one tool** — callsite parsing names with own `indexOf("__", …)` instead of `parseMcpToolName()`. Check `(server, sub)` aggregation in `tool-activation.ts`.
- **Tools page "MCP" section missing/empty** — `GET /api/mcp-servers`; `renderMcpSection()`.

### Models / AI gateway
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw, no silent fallback.
- **`x-opencode-session` header / `models.json`** — `writeAigwModelsJson`, `BOBBIT_SESSION_ID` env, `startupAigwCheck`.

### Gates / verification / team
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification`.
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`.
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`.
- **Auto-nudge flooding** — `nudgePending` guard in `TeamManager`.
- **Reviewer spuriously nudges team-lead** — `kind: "reviewer"` filter in `resubscribeTeamEvents` / `notifyTeamLead`.

### Search / config
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` post-filters orphans.
- **Search index location** — FlexSearch at `.bobbit/state/search.flex/`; delete to rebuild.
- **`system-prompt.md` customisation not taking effect** — `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts`.
- **Tool-guard extension ParseError** — quoting slip in template-literal generator.
- **Skill chip / autonomous activation / resource manifest** — `src/server/skills/`.

### UI / scroll / proposals
- **Scroll snaps back / tail-chat lost / false-positive Jump** — `AgentInterface` ports `use-stick-to-bottom`; two-flag `_isAtBottom`/`_escapedFromLock`; never re-add `_programmaticEchoes`/`_settleWindow*`/`_suppressJumpUntilTs`. See [docs/design/tail-chat-redesign.md](docs/design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag` flag.
- **Proposal panel empty after reload** — `_bufferedProposalEvents` in `src/app/remote-agent.ts`.
- **Goal `prUrl` field gone** — `PrStatusStore` (`src/server/agent/pr-status-store.ts`) is single source of truth. `buildReattemptContext(goal, prStatusStore)` reads `prStatusStore.get(goal.id)?.url`. `PUT /api/goals/:id` ignores any `prUrl`.
- **Stale project-proposal panel** — shallow-merge in `onProjectProposal`.
- **Dismissed proposal reappears after reload** — `goalDraft.restore` / `roleDraft.restore` must consult `isProposalDismissedTyped`.
- **"No project selected for this goal" toast in re-attempt assistant** — `goalProposalPanel()` / `goalPreviewPanel()` in `src/app/render.ts`.
- **Page chunk fails to load on first navigation** — `lazyPage()` in `src/app/render.ts`.

### QA / preview / tier-2.5
- **QA screenshot token bloat** — extension must emit `[screenshot_file]` not `[screenshot_base64]`.
- **Tier 2.5 report missing / ffmpeg failed** — set `FFMPEG_PATH` or install ffmpeg; only when `RECORDSCREEN=1`.
- **Preview standalone tab unstyled / `--background` empty** — inline `<style data-bobbit-preview-theme="snapshot">` injected by `src/server/preview/content-route.ts` from `src/server/preview/theme-snapshot.ts`; `PREVIEW_THEME_BRIDGE` early-returns when `parent === window`. See [docs/preview-architecture.md](docs/preview-architecture.md#theme-token-snapshot-for-standalone-tabs).
- **Preview Refresh button does nothing / SSE bumps don't reload** — iframe cache-buster must be `?mtime=` (query string, triggers reload), not `#mtime=` (hash, same-document). See `htmlPreviewContent()` in `src/app/render.ts`.

### Misc
- **Modal shows only "Failed: 400"** — caller dropped the structured body. Check the `src/app/api.ts` wrapper parses `await res.json()` and forwards `code`/`stack` to `showConnectionError`. Server side: confirm the handler uses `jsonError(...)` not literal `json({ error: String(err) })`.
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=`.
- **Continue-Archived button missing** — needs archived + no `goalId` + no `delegateOf` + project still registered.
- **Bundle-size assertion fails** — `tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json`; 600 kB main / 500 kB per-chunk.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

**Line endings:** LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows contributors: `git config --global core.autocrlf false` (phantom "modified" entries on fresh checkout = `core.autocrlf=true`).

### Worktrees

Dev server runs from the **primary worktree** on `master`. Sessions use separate worktrees under `<project-root>-wt/<branch>/` (single-repo) or `<project-root>-wt/<branch>/<repo>/` (multi-repo). Override parent with `worktree_root`. Assistant sessions don't get worktrees.

**Branch namespaces:** `pool/_pool-<id>`, `session/<id8>`, `goal/<slug>-<id>`, `staff-<name>-<id>`. See [docs/dev-workflow.md](docs/dev-workflow.md#worktree-branch-namespaces).

**Multi-repo invariant:** every component repo gets a sibling worktree on the same branch. Agent cwd is the per-branch container.

**Always edit files in your session worktree, never in the primary worktree.** For infra files: edit here → commit → push → pull from primary. **Pushing to remote `master` does NOT update the dev server** — `cd <primary-worktree> && git pull origin master`.

### Worktree setup command (per-component)

`components[*].worktree_setup_command` in `project.yaml`. Runs at the component's root with `SOURCE_REPO` env var. 2-min timeout, non-fatal, `sh -c`. Single source of truth: `runComponentSetups()` in `src/server/skills/worktree-setup.ts`.

```yaml
components:
  - name: myapp
    repo: "."
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    commands: { build: npm run build, test: npm test }
```

## Reference docs

[docs/internals.md](docs/internals.md) (tool policies, search, MCP, sandbox, config, disk state, goals, multi-project) · [docs/debugging.md](docs/debugging.md) (full diagnostics) · [docs/dev-workflow.md](docs/dev-workflow.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/blocking-tools.md](docs/blocking-tools.md) · [docs/non-blocking-ask.md](docs/non-blocking-ask.md) · [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md) · [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md) · [docs/design/unify-session-status.md](docs/design/unify-session-status.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md)
