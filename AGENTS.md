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

One-liner task → entry point. Follow links for walkthroughs. **Keep entries to one line each — detail belongs in the linked doc.**

### Tests
- **Add an API E2E test** → `tests/e2e/`, import `./in-process-harness.js`; see `gates-api.spec.ts`.
- **Add a UI E2E test** → `tests/e2e/ui/`, import `../gateway-harness.js`; see `session-interactions.spec.ts`.
- **Add a Tier 2.5 video-capturing E2E test** → [docs/testing-tier-2-5.md](docs/testing-tier-2-5.md).
- **Assert tail-chat / scroll-pin** → helpers in `tests/e2e/ui/tail-chat-helpers.ts`; outcome-only. See [tail-chat-redesign.md](docs/design/tail-chat-redesign.md).

### Server / API
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [rest-api.md](docs/rest-api.md).
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, `RpcBridge` method.
- **Add a tool** → `defaults/tools/<group>/` (or project override `.bobbit/config/tools/<group>/`); MCP auto-discovered from `.mcp.json`. See [internals.md#mcp-tool-documentation](docs/internals.md#mcp-tool-documentation).
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/`. See [skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Add a blocking tool** → [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; resolve via `ProjectContextManager`.
- **Add/modify session creation** → `session-setup.ts`, `session-manager.ts`. See [internals.md#session-worktrees](docs/internals.md#session-worktrees).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, `server.ts`, `goal-assistant.ts`. See [goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Add a verification reminder site** → `src/server/agent/verification-harness.ts`; await `waitForStreaming(...).catch(()=>{})` before `waitForIdle`.
- **Return errors from a server handler** → `jsonError(status, err, extra?)` in `src/server/server.ts`. See [rest-api.md#error-response-shape](docs/rest-api.md#error-response-shape).

### Sessions, status, steer
- **Mutate session status** → single writer `broadcastStatus()` in `src/server/agent/session-status.ts`. See [unify-session-status.md](docs/design/unify-session-status.md).
- **Modify steer / queue dispatch** → single dispatch site `SessionManager._dispatchSteer()`; never reintroduce `PromptQueue.dispatched`. See [steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Continue an archived session** → `POST /api/sessions/:archivedId/continue`. See [lossless-continue-archived.md](docs/design/lossless-continue-archived.md).
- **Re-attempt a goal** → `POST /api/sessions { reattemptGoalId }` → `buildReattemptContext()`.
- **Server-side read/unread** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`.
- **Read another session's transcript** → `read_session` tool; `transcript-reader.ts`; `x-bobbit-session-id` header for same-project auth.

### UI
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`; see `ProposalRenderer.ts`.
- **Show a server error in a modal** → `<error-details>` + `showConnectionError(...)` in `src/app/dialogs.ts`; API wrappers in `src/app/api.ts` attach `code`/`stack`.
- **Add a route-level page (lazy)** → `lazyPage(...)` branch in `mainArea()` in `src/app/render.ts`. See [ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Add a heavy tool renderer (lazy)** → `registerLazyToolRenderer()`; placeholder + `TOOL_RENDERER_LOADED_EVENT` swap.
- **Defer a heavy library** → `ensureMarkdownBlock()` pattern in `src/ui/lazy/`; or `await import()` for values.
- **Change message rendering** → `src/ui/components/Messages.ts`; custom via `message-renderer-registry.ts`.
- **Modify message transcript ordering** → all mutations through `reduce()` in `src/app/message-reducer.ts`; never push to `state.messages`. See [unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify snapshot ↔ live merge** → server `spliceInFlightMessage()`; client `_order > snapshotMaxOrder` guard + multiset dedup. See [snapshot-live-race-fix.md](docs/design/snapshot-live-race-fix.md).
- **Modify proposal panel streaming UX** → `state.proposalStreamingByTag`; `reconcileFollowTail` in `src/app/follow-tail.ts`.
- **Large content truncation** → `truncate-large-content.ts` (>32 KB); lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Copy session link button** → header ghost icon in `src/app/render.ts`; `showHeaderToast()` (testid `header-toast`); `CopyLinkFallbackDialog` on clipboard reject.
- **Git-status widget** → `GitStatusWidget.ts`, `git-status-native.ts`. See [git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).

### Projects, config, sandbox
- **Add / remove a project** → `POST` / `DELETE /api/projects`; key files `project-registry.ts`, `project-context-manager.ts`. See [internals.md#project-assistant](docs/internals.md#project-assistant).
- **Splash-screen new-session gating** → buttons gated on `state.projects.length` (0/1/≥2); system tool-assistants pass `projectId: "system"`. See [internals.md#synthetic-system-project](docs/internals.md#synthetic-system-project).
- **Symlink-aware project registration** → `detectSymlinkRoot()`; UI re-submits with `acceptCanonical: true`. `findByCwd()` canonicalises both sides; `getByPath()` does NOT.
- **Per-project settings** → `GET/PUT /api/projects/:id/config`. See [internals.md#per-project-config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → `propose_project` → user `PUT /api/projects/:id/config`. See [mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md).
- **Multi-repo / components / inline workflows** → `project.yaml::components[]` and `::workflows`. See [internals.md#multi-repo--components](docs/internals.md#multi-repo--components), [`workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md).
- **Sandbox behavior** → `sandbox: "docker"`; `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [internals.md#docker-sandbox](docs/internals.md#docker-sandbox).
- **QA testing** → `qa_start_command` etc. in component `config:` map. See [qa-testing.md](docs/qa-testing.md).
- **Config cascade** → builtin → server → project (roles, tools, tool-group-policies, `system-prompt.md`); workflows are project-scoped. See [internals.md#config-cascade](docs/internals.md#config-cascade).
- **Tool access policy** → `tool-group-policies.yaml` (cascaded) or role YAML `toolPolicies`. Values `allow`/`ask`/`never`; `gate_signal` is team-lead-only.
- **Per-role model / thinking override** → role YAML `model` + `thinkingLevel`. See [per-role-model-overrides.md](docs/design/per-role-model-overrides.md).
- **Pin agent model at spawn** → `RpcBridgeOptions.initialModel`/`initialThinkingLevel` → `--model`/`--thinking` via `buildAgentArgs`.
- **Archived session footer model** → `buildArchivedStateData()` on archived `auth_ok`.

### MCP
- **MCP meta-tool aggregation (server → sub-namespace → op)** → `parseMcpToolName()` in `src/server/mcp/mcp-meta.ts`; aggregation in `tool-activation.ts` keyed by `(server, sub)`; `mcpPolicyKeys(name) → {group, tool}` (tool-key wins). See [mcp-meta-tools.md](docs/mcp-meta-tools.md).
- **MCP meta-tool kind tagging** → `computeEffectiveAllowedTools()` returns `EffectiveTool[]` = `{kind:"yaml"|"mcp", name}[]`; `kind:"yaml"` resolves via `ToolManager.getToolProviders()`, `kind:"mcp"` via `mcpExtensionPaths` (proxy extensions). `computeToolActivationArgs` dispatches on `kind`; never re-flatten to `string[]`. `tagAllowedTool()` lifts legacy strings at boundaries.

### Goals, workflows, gates
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [goals-workflows-tasks.md#git-handoff-fields](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Archive a goal (UI)** → `deleteGoal()` in `src/app/api.ts`; runs `teardownTeam()` before `DELETE /api/goals/:id`.
- **Cleanup remote branches on archive** → `deleteRemoteGoalBranches`; `session-eager-branch-delete.ts`. See [orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).

### Proposals
- **Edit a proposal mid-session** → `view_proposal` / `edit_proposal`; per-rev snapshots under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`. See [editable-proposals.md](docs/design/editable-proposals.md).
- **Dismiss/restore invariant** → `{goal,role,project}Draft.restore` gate on `isProposalDismissedTyped`; dismiss does NOT delete the draft. `staff`/`tool`/`workflow` proposals are transient.
- **Project-proposal "Changes Saved" (registered mode)** → `state.projectProposalAcceptedBySessionId`; set in `acceptRegisteredProjectProposal()`; persisted via `projectDraft`. See [project-proposal-saved-state.md](docs/design/project-proposal-saved-state.md).

### Worktree (operational)
- **Pool worktree under `<projectDir>-wt/` instead of `<repoRoot>-wt/`** → `WorktreePool` ctor must resolve `repoPath` to git toplevel; ditto both `initWorktreePoolForProject` sites. Pinned by `tests/worktree-pool-nested-rootpath.test.ts`.

### Preview / HTML / images
- **Preview HTML with sibling assets** → `preview_open({ html | file, assets?, manifest? })`; bare `file` copies only the entry HTML; snapshot marker `__preview_snapshot_v3__`. See [preview-architecture.md](docs/preview-architecture.md).
- **Author HTML output** → [`defaults/docs/html-rendering.md`](defaults/docs/html-rendering.md). Use theme tokens (`--background`, `--card`, `--chart-1..6`, `--positive`/`--negative`/`--warning`/`--info`).
- **Generate an image** → `generate_image` → `POST /api/image-generation/generate`.

## Debugging

Keyword index — full diagnostic walkthroughs live in [docs/debugging.md](docs/debugging.md). **One line per entry.** All entries: see `debugging.md` (or named design doc) for the checklist.

### Session / status / steer
- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **Stop button stuck visible / duplicate user message on second send** — `_state.status` write outside `case "session_status"`/`"state"`/`reset()`, or server `session.status` write outside `broadcastStatus()`. See [unify-session-status.md](docs/design/unify-session-status.md).
- **`lastActivity` reads "just now" after restart** — `isUserVisibleActivity` filter in `session-manager.ts`.
- **Live-steer lost / duplicated after Stop** — single `_dispatchSteer()` + shadow ledger `inFlightSteerTexts`; never re-add `PromptQueue.dispatched`. See [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Session wedged after errored turn** — implicit unstick; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`.
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry; `abortAllWaits()` from `deliverLiveSteer`.
- **Streaming dedup/reorder** — `seq`+`ts` envelope, `{type:"resume", fromSeq}` on reconnect.
- **WS overflow guard** — `decideOverflowAction` in `src/server/ws/ws-overflow-guard.ts`.
- **Stale messages / dups / out-of-order widgets on session navigate** — reducer in `src/app/message-reducer.ts`.
- **Messages disappear from chat and reappear after another prompt** — H3 snapshot/live race. Server splices via `spliceInFlightMessage()`; client `_order > snapshotMaxOrder` guard. See [docs/design/snapshot-live-race-fix.md](docs/design/snapshot-live-race-fix.md).
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`.
- **Continue-Archived button missing** — needs archived + no `goalId` + no `delegateOf` + project still registered.
- **Continued session missing earlier transcript** — confirm cloned `.jsonl` at `agentSessionFile` path.
- **Resumed reviewer terminated ~46ms after restart** — await `waitForStreaming` before `waitForIdle`.
- **Duplicate `model_change` event at session startup** — spawn site must route through `resolveBridgeOptions`.

### Worktree / sandbox / projects
- **Worktree setup not running** — single source of truth `runComponentSetups()` in `src/server/skills/worktree-setup.ts`.
- **"Setting up worktree…" banner missing for first session / preparing UX absent** — `_lastStatusVersion` must start at `-1`; `RemoteAgent.onStatusChange` must call `agentInterface.requestUpdate()` for `preparing`/`starting`.
- **Slow first-session worktree on cold boot** — `runBootBackgroundTasks` runs sweeper and pool init concurrently. `BOBBIT_SKIP_WORKTREE_POOL=1` bypasses pool.
- **Pool worktree placed under `<projectDir>-wt/` instead of `<repoRoot>-wt/`** — nested-rootPath bug; `WorktreePool` must resolve repo toplevel. Pinned by `tests/worktree-pool-nested-rootpath.test.ts`.
- **Sandbox status / project container** — `GET /api/sandbox-status`; label `bobbit-project=<projectId>`.
- **Synthetic system project / `projectId: "system"`** — registered at startup; `hidden: true`; anchored at `<bobbitStateDir>/system-project/`.
- **Symlinked project root rejected with `code: symlink_root`** — `POST /api/projects` returns 400; re-submit with `acceptCanonical: true`.
- **`findByCwd` returns undefined for symlinked cwd** — must canonicalise via `realpathSync`. `getByPath()` is intentionally NOT canonicalised.
- **Monorepo subprojects not detected** — `src/server/agent/monorepo-scan.ts`; cap 30 candidates.
- **Legacy JSON-string `project.yaml` field rejected (HTTP 400)** — send structured arrays.
- **400 "projectId required"** — splash buttons gated on `state.projects.length`; system tool-assistants pass `projectId: "system"`.
- **Orphan remote branches** — `deleteRemoteGoalBranches` (goals); `session-eager-branch-delete.ts` (sessions). See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).

### MCP
- **MCP server unavailable / partial outage** — stub meta extension at `<stateDir>/mcp-extensions/…`.
- **MCP per-op `never` policy not enforced** — two layers: `mcpPolicyKeys` (Layer A) + `resolveGrantPolicy` (Layer B, `/api/internal/mcp-call`).
- **MCP gateway server collapses sub-namespaces into one tool** — callsite parsing names with own `indexOf("__", …)` instead of `parseMcpToolName()`. Check `(server, sub)` aggregation in `tool-activation.ts`.
- **Spurious `[tool-activation] Tool "mcp_…" has no provider … skipping` warns on session start** — regression that re-flattens `EffectiveTool[]` to `string[]` between `computeEffectiveAllowedTools` and `computeToolActivationArgs`. Producer tags `kind:"mcp"` at source; consumer must skip them in YAML provider-lookup. Pin: `tests/tool-activation-mcp-warn.test.ts`.
- **MCP server dropdown reads "Allow (default)" but agent denied** — historical bug from `mcp__playwright`/`mcp__nano-banana` builtin denials; removed in policy parity.
- **Tools page "MCP" section missing/empty** — `GET /api/mcp-servers`; `renderMcpSection()`.

### Models / AI gateway
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw, no silent fallback.
- **`x-opencode-session` header / `models.json`** — `writeAigwModelsJson`, `BOBBIT_SESSION_ID` env, `startupAigwCheck`.
- **Archived session footer shows placeholder model** — `buildArchivedStateData` must run after `session_title`.

### Gates / verification / team
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification`.
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`.
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`.
- **Auto-nudge flooding** — `nudgePending` guard in `TeamManager`.
- **Reviewer spuriously nudges team-lead** — `kind: "reviewer"` filter in `resubscribeTeamEvents` / `notifyTeamLead`.
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`.

### Search / config / skills
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` post-filters orphans.
- **Search index location** — FlexSearch at `.bobbit/state/search.flex/`; delete to rebuild.
- **`system-prompt.md` customisation not taking effect** — `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts`.
- **Tool-guard extension ParseError** — quoting slip in template-literal generator.
- **Skill chip / autonomous activation / resource manifest** — `src/server/skills/`.
- **Sidebar child loading** — server BFS enrichment; archived-goals `archivedSessions`.

### UI / scroll / proposals
- **Scroll snaps back / tail-chat lost / false-positive Jump** — two-flag `_isAtBottom`/`_escapedFromLock` in `AgentInterface`; never re-add `_programmaticEchoes`/`_settleWindow*`/`_suppressJumpUntilTs`. See [tail-chat-redesign.md](docs/design/tail-chat-redesign.md).
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag` flag.
- **Proposal panel empty after reload** — `_bufferedProposalEvents` in `src/app/remote-agent.ts`.
- **Proposal panel doesn't update after `edit_proposal`** — check WS `proposal_update` frame + structured error code.
- **Inline-comment annotations on proposals missing** — ephemeral `proposalBackend` in `src/ui/components/review/proposal-annotations.ts`.
- **"Send feedback" button missing on proposal panel** — gated on annotation count > 0 AND not streaming.
- **"Open proposal" on old card destroys later edits** — check `__proposal_rev_v1__:<n>` marker.
- **Stale project-proposal panel** — shallow-merge in `onProjectProposal`.
- **Dismissed proposal reappears after reload** — `goalDraft.restore` / `roleDraft.restore` must consult `isProposalDismissedTyped`.
- **"No project selected for this goal" toast in re-attempt assistant** — `goalProposalPanel()` / `goalPreviewPanel()` in `src/app/render.ts`.
- **Page chunk fails to load on first navigation** — `lazyPage()` in `src/app/render.ts`.
- **Lazy tool renderer placeholder sticks / Open button never appears** — `TOOL_RENDERER_LOADED_EVENT` in `src/ui/tools/renderer-registry.ts`.
- **Markdown not rendering in chat / proposal panel** — call `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts`.
- **Header toast vs proposal toast testid collision** — `header-toast` vs `proposal-toast`; two slots in `src/app/render.ts`.
- **Mobile annotation popover doesn't open** — `_onMobileAddComment` must set `_popoverReferenceRect` before mount.

### QA / preview / tier-2.5 / images
- **QA screenshot token bloat** — extension must emit `[screenshot_file]` not `[screenshot_base64]`.
- **Preview Open button broken / v1/v2 markers** — `tool_result` must carry `__preview_snapshot_v3__`.
- **Preview iframe shows broken images / 404 on assets** — asset must be declared in `preview_open`'s `assets[]` / `manifest` (bare `file` copies only the entry HTML).
- **`/preview/<sid>/...` returns 401 in a new tab** — `bobbit_session` cookie missing/scoped wrong.
- **Preview iframe shows 'No preview yet' indefinitely** — SSE event must carry `entry`.
- **Tier 2.5 report missing / ffmpeg failed** — set `FFMPEG_PATH` or install ffmpeg; only when `RECORDSCREEN=1`.
- **Image generation failure** — `400` malformed input, `500 { error }` provider-side; never `502`/`503`.
- **Large file writes freezing** — `truncateLargeToolContent()` at >32 KB; check `.jsonl` exists.

### Misc
- **`read_session` returns `permission_denied`** — cross-project read; check `x-bobbit-session-id` header.
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=`.
- **Bundle-size assertion fails** — `tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json`; 600 kB main / 500 kB per-chunk.

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. It must stay a keyword index, not a knowledge base. Rules for edits:

- **One line per entry.** If a Recipe or Debugging item needs more than one sentence, the detail goes in the linked `docs/` page; the entry here is just the keyword + symbol + link.
- **Don't duplicate** a Recipe and a Debugging entry for the same fix. Pick one (Recipe = "how to do X", Debugging = "X is broken").
- **Don't inline schema, code, or step-by-step prose.** YAML field semantics, error-shape walkthroughs, race-condition explanations all belong in `docs/`.
- **Per-section size budget:** if a Debugging subsection grows past ~12 entries, split it; don't let the section blur into a continuous wall.
- New Recipe/Debugging entries should be net-zero: replace or extend an existing entry where possible.

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

[docs/internals.md](docs/internals.md) (tool policies, search, MCP, sandbox, config, disk state, goals, multi-project) · [docs/debugging.md](docs/debugging.md) (full diagnostics) · [docs/dev-workflow.md](docs/dev-workflow.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/blocking-tools.md](docs/blocking-tools.md) · [docs/non-blocking-ask.md](docs/non-blocking-ask.md) · [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md) · [docs/design/snapshot-live-race-fix.md](docs/design/snapshot-live-race-fix.md) · [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md) · [docs/design/unify-session-status.md](docs/design/unify-session-status.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md)
