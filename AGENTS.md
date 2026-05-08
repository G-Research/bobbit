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
- **Initialise / read client-side session status on a fresh attach** → `_lastStatusVersion` starts at `-1` in `src/app/remote-agent.ts`; first `session_status` frame is always applied. Both `case "state"` and `case "session_status"` may write `_state.status`. UI re-renders for `preparing`/`starting`/`aborting`/`idle` via explicit `requestUpdate()` in `src/app/session-manager.ts::onStatusChange`.

### UI
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Show a server error in a modal** → `<error-details>` (`src/ui/components/ErrorDetails.ts`) renders message + optional code + collapsible stack. API wrappers in `src/app/api.ts` parse `await res.json()`, attach `code`/`stack` to the thrown `Error`, and forward both to `showConnectionError(title, message, { code, stack })` in `src/app/dialogs.ts`. The background polling site in `refreshSessions()` (`src/app/api.ts`) is intentionally silent.
- **Add a route-level page (lazy-loaded)** → add a `lazyPage(...)` branch in `mainArea()` in `src/app/render.ts`. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Add a heavy tool renderer (lazy)** → `registerLazyToolRenderer()` in `src/ui/tools/index.ts`; placeholder + `TOOL_RENDERER_LOADED_EVENT` swap.
- **Defer a heavy library (lazy load)** → `src/ui/lazy/markdown-block.ts::ensureMarkdownBlock()` pattern; or `await import()` for value imports.
- **Change message rendering** → `src/ui/components/Messages.ts` (standard); `message-renderer-registry.ts` (custom).
- **Modify message transcript ordering** → all transcript mutations route through `reduce(state, action)` in `src/app/message-reducer.ts`. Never push directly into `state.messages`. See [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify snapshot ↔ live merge / `getMessages` splice** → server holds the in-flight `message_update` payload on `SessionInfo.latestMessageUpdate` (set on `message_update`, cleared on `message_end` / `agent_end` / `process_exit`) and every snapshot-return site (`get_messages`, `refreshAfterCompaction`, role-switch refresh, title generation) splices via `spliceInFlightMessage()` in `src/server/agent/splice-inflight-message.ts` — without this a snapshot taken mid-stream drops the in-flight row because the agent flushes to `.jsonl` only on `message_end`. Client survivor filter in `case "snapshot"` enforces the structural invariant: live rows with `_order > snapshotMaxOrder` survive (the H3 guard, scoped to `_order > 0`); plain-text dedup is multiset (`Map<key,count>`), not Set, so N identical-text rows aren't collapsed; prior-snapshot artifacts (`_origin: "server"` with `_order <= 0` not represented by the new snapshot) are dropped — handles abandoned-partial pivots from streaming text to `tool_use` without a closing `message_end`. See [docs/design/snapshot-live-race-fix.md](docs/design/snapshot-live-race-fix.md).
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
- **Project-proposal "Changes Saved" state after Apply Changes (registered mode)** → `state.projectProposalAcceptedBySessionId` flag, set in `acceptRegisteredProjectProposal()`, persisted via `projectDraft.serialize/restore`, cleared in the unified `onProposal` callback and all `activeProposals.project` cleanup sites. Terminate button shares `terminateProjectAssistantSession()` with the provisional path. See [docs/design/project-proposal-saved-state.md](docs/design/project-proposal-saved-state.md).

### Worktree (operational)
- **Pool worktree placed under `<projectDir>-wt/` instead of `<repoRoot>-wt/`** → `WorktreePool` constructor in `src/server/agent/worktree-pool.ts` resolves `opts.repoPath` to git toplevel; both `initWorktreePoolForProject` sites in `src/server/server.ts` also resolve. Pinned by `tests/worktree-pool-nested-rootpath.test.ts`.

### Preview / HTML / images
- **Preview HTML with sibling assets** → `preview_open({ html | file, assets?, manifest? })`. **Explicit opt-in**: bare `file` copies only the entry HTML; siblings declared via `assets: [...]` or a `manifest` JSON. Snapshot marker: `__preview_snapshot_v3__`. Re-opening the same `file` (including paths that resolve inside the mount itself) is safe — `mountFile()` stages into a sibling tmp dir and atomically swaps. See [docs/preview-architecture.md](docs/preview-architecture.md).
- **Author HTML output** → [`defaults/docs/html-rendering.md`](defaults/docs/html-rendering.md). One artefact, one surface. Use theme tokens (`--background`, `--card`, `--chart-1..6`, `--positive`/`--negative`/`--warning`/`--info`).
- **Generate an image** → `generate_image` → `POST /api/image-generation/generate`.

## Debugging

Keyword index — full diagnostic walkthroughs live in [docs/debugging.md](docs/debugging.md). All entries below: see `debugging.md` (or the named design doc) for the full checklist.

### Session / status / steer
- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **`system-prompt.md` customisation not taking effect** — `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts`. See [debugging.md#system-promptmd-not-customised](docs/debugging.md#system-promptmd-not-customised).
- **`lastActivity` reads "just now" after restart** — `isUserVisibleActivity` filter in `session-manager.ts`. See [debugging.md#lastactivity-reads-just-now-after-restart](docs/debugging.md#lastactivity-reads-just-now-after-restart).
- **Sandbox status / project container** — `GET /api/sandbox-status`; label `bobbit-project=<projectId>`. See [debugging.md#sandbox-sessions](docs/debugging.md#sandbox-sessions).
- **Stop button stuck visible while sprite is idle / duplicate user message on second send** — symptom of the legacy two-flag divergence between `_state.isStreaming` and `gatewaySessions[i].status`. Fixed by the canonical-status refactor: divergence is now structurally impossible because `isStreaming` is a derived getter over `_state.status`, and `_state.status` is healed within ≤15s by the server-side heartbeat (`broadcastStatus`-shaped frame re-emitted WITHOUT bumping `statusVersion`). If you see this regression, check that no new code path writes `_state.status` outside `case "session_status"` / `case "state"` / `reset()` on the client, and that no server site writes `session.status` outside `broadcastStatus()` in `src/server/agent/session-status.ts`. See [docs/design/unify-session-status.md](docs/design/unify-session-status.md) and `tests/e2e/ui/session-status-recovery.spec.ts`.
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification`. See [debugging.md#gates](docs/debugging.md#gates).
- **Worktree setup not running** — single source of truth `runComponentSetups()` in `src/server/skills/worktree-setup.ts`. See [debugging.md#worktree-setup-hook-not-running](docs/debugging.md#worktree-setup-hook-not-running).
- **"Setting up worktree…" banner missing for first session / preparing UX absent** — `_lastStatusVersion` must initialise to `-1` so the first `session_status` frame (server uses `statusVersion: 0`) is applied; `case "session_status"` only writes `_state.status`, but `RemoteAgent.onStatusChange` must also call `agentInterface.requestUpdate()` for `"preparing"`/`"starting"` (Lit reference-equality misses same-object mutations). See `src/app/remote-agent.ts`, `src/app/session-manager.ts`.
- **Slow first-session worktree creation on cold boot** — `runBootBackgroundTasks` in `src/server/server.ts` runs sweeper and pool init concurrently (`Promise.all`); they operate on disjoint branch sets (sweeper skips `isPoolBranch`; `WorktreePool.reclaimOrphaned` only touches pool branches). Boot timing logs prefixed `[boot]`. `BOBBIT_SKIP_WORKTREE_POOL=1` still bypasses pool entirely.
- **Pool worktree placed under `<projectDir>-wt/` instead of `<repoRoot>-wt/`** — symptom of the nested-rootPath bug fixed in `WorktreePool` constructor. If you see this regression, check that `resolveRepoToplevel` in `src/server/agent/worktree-pool.ts` is intact and that both `initWorktreePoolForProject` call sites in `server.ts` still resolve via `getRepoRoot()` on the single-repo branch. Pinned by `tests/worktree-pool-nested-rootpath.test.ts`.
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`. See [debugging.md#gate-verification-baselines](docs/debugging.md#gate-verification-baselines).
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`. See [debugging.md#gate--task-tool-bloat](docs/debugging.md#gate--task-tool-bloat).
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` post-filters orphans. See [debugging.md#search-index](docs/debugging.md#search-index).
- **Search index location** — FlexSearch at `.bobbit/state/search.flex/`; delete to rebuild. See [debugging.md#search-index-location](docs/debugging.md#search-index-location).
- **Sidebar child loading** — server BFS enrichment; archived-goals `archivedSessions`. See [debugging.md#sidebar-child-loading](docs/debugging.md#sidebar-child-loading).
- **QA screenshot token bloat** — extension must emit `[screenshot_file]` not `[screenshot_base64]`. See [debugging.md#qa-screenshot-token-bloat](docs/debugging.md#qa-screenshot-token-bloat).
- **Stale project-proposal panel** — shallow-merge in `onProjectProposal`. See [debugging.md#stale-project-proposal-panel-after-propose_project](docs/debugging.md#stale-project-proposal-panel-after-propose_project).
- **Monorepo subprojects not detected** — `src/server/agent/monorepo-scan.ts`; cap 30 candidates. See [debugging.md#monorepo-subprojects-not-detected](docs/debugging.md#monorepo-subprojects-not-detected).
- **Legacy JSON-string `project.yaml` field rejected (HTTP 400)** — send structured arrays. See [debugging.md#legacy-json-string-projectyaml-field-rejected](docs/debugging.md#legacy-json-string-projectyaml-field-rejected).
- **Skill chip / autonomous activation / resource manifest** — `src/server/skills/`. See [debugging.md#skill-chip--autonomous-activation--resource-manifest](docs/debugging.md#skill-chip--autonomous-activation--resource-manifest).
- **Tool-guard extension ParseError** — quoting slip in template-literal generator. See [debugging.md#tool-guard-extension-parseerror-new-sessions-crash](docs/debugging.md#tool-guard-extension-parseerror-new-sessions-crash).
- **MCP server unavailable / partial outage** — stub meta extension at `<stateDir>/mcp-extensions/…`. See [debugging.md#mcp-server-unavailable--partial-outage](docs/debugging.md#mcp-server-unavailable--partial-outage).
- **MCP per-op `never` policy not enforced** — two layers: `mcpPolicyKeys` (returns `{group, tool}`, used at Layer A) + server-side `resolveGrantPolicy` (Layer B, `/api/internal/mcp-call`). `mcpPolicyPrefix` is the legacy group-only wrapper. See [debugging.md#mcp-per-op-never-policy-not-enforced](docs/debugging.md#mcp-per-op-never-policy-not-enforced).
- **MCP server dropdown reads "Allow (default)" but agent is denied** — historical bug from `mcp__playwright`/`mcp__nano-banana` builtin denials; removed in MCP policy parity. See [debugging.md#mcp-server-dropdown-reads-allow-default-but-agent-is-denied](docs/debugging.md#mcp-server-dropdown-reads-allow-default-but-agent-is-denied).
- **Tools page "MCP" section missing/empty** — `GET /api/mcp-servers`; `renderMcpSection()`. See [debugging.md#tools-page-mcp-section-missing-or-empty](docs/debugging.md#tools-page-mcp-section-missing-or-empty).
- **MCP gateway server collapses sub-namespaces into one tool** — a gateway emitting `mcp__gr__ai-adoption__list-articles` etc. should surface as ONE server row + one tool row per sub-namespace on the Tools page; the agent should see one meta-tool per sub-namespace (`mcp_gr__ai-adoption`, `mcp_gr__jira`). Single source of truth is `parseMcpToolName()` in `src/server/mcp/mcp-meta.ts` — a callsite parsing the name with its own `indexOf("__", …)` instead of routing through this helper breaks sub-namespace grouping at that callsite. Symptom: one giant `mcp_gr` meta-tool with a flat enum like `ai-adoption__list-articles, jira__get-queue, …`. Check the `(server, sub)` aggregation in `tool-activation.ts` and the two ad-hoc parse sites in `server.ts` (must call `parseMcpToolName`).
- **Auto-nudge flooding** — `nudgePending` guard in `TeamManager`. See [debugging.md#auto-nudge-flooding](docs/debugging.md#auto-nudge-flooding).
- **Reviewer spuriously nudges team-lead** — `kind: "reviewer"` filter in `resubscribeTeamEvents` / `notifyTeamLead`. See [debugging.md#reviewer-session-triggers-spurious-agent-finished-team-lead-nudge-after-restart](docs/debugging.md#reviewer-session-triggers-spurious-agent-finished-team-lead-nudge-after-restart).
- **Duplicate `model_change` event at session startup** — spawn site must route through `resolveBridgeOptions`. See [debugging.md#duplicate-model_change-event-at-session-startup](docs/debugging.md#duplicate-model_change-event-at-session-startup).
- **Archived session footer shows placeholder model** — `buildArchivedStateData` must run after `session_title`. See [debugging.md#archived-session-footer-shows-placeholder-model](docs/debugging.md#archived-session-footer-shows-placeholder-model).
- **Resumed reviewer terminated ~46ms after restart** — await `waitForStreaming` before `waitForIdle`. See [debugging.md#resumed-reviewer-terminated-46ms-after-server-restart-before-reminder-is-acted-on](docs/debugging.md#resumed-reviewer-terminated-46ms-after-server-restart-before-reminder-is-acted-on).
- **`x-opencode-session` header / `models.json`** — `writeAigwModelsJson`, `BOBBIT_SESSION_ID` env, `startupAigwCheck`. See [debugging.md#x-opencode-session-header--modelsjson](docs/debugging.md#x-opencode-session-header--modelsjson).
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw, no silent fallback. See [debugging.md#reviewnaming-model-mismatch-under-ai-gateway](docs/debugging.md#reviewnaming-model-mismatch-under-ai-gateway).
- **Live-steer lost / duplicated after Stop** — single `_dispatchSteer()` + shadow ledger `inFlightSteerTexts`; never re-add `PromptQueue.dispatched`. See [debugging.md#abort-steer--queue](docs/debugging.md#abort-steer--queue).
- **Session wedged after errored turn** — implicit unstick; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`. See [debugging.md#session-wedged-after-errored-turn](docs/debugging.md#session-wedged-after-errored-turn).
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry; `abortAllWaits()` from `deliverLiveSteer`. See [debugging.md#bash_bg-wait-not-interrupted-by-steer](docs/debugging.md#bash_bg-wait-not-interrupted-by-steer).
- **Large file writes freezing** — `truncateLargeToolContent()` at >32 KB; check `.jsonl` exists. See [debugging.md#large-file-writes-agent-writes-32kb](docs/debugging.md#large-file-writes-agent-writes-32kb).
- **Preview Open button broken / v1/v2 markers** — `tool_result` must carry `__preview_snapshot_v3__`. See [preview-architecture.md#snapshot-v3-marker](docs/preview-architecture.md#snapshot-v3-marker).
- **Preview iframe shows broken images / 404 on assets** — first check: did the agent declare the asset in `preview_open`'s `assets[]` or `manifest`? Bare `file` copies *only* the entry HTML; undeclared siblings are not in the mount and will 404. Then check cookie auth, MIME, path-guard. See [preview-architecture.md#explicit-asset-opt-in-file-form](docs/preview-architecture.md#explicit-asset-opt-in-file-form) and [preview-architecture.md#content-origin-previewsidrel-path](docs/preview-architecture.md#content-origin-previewsidrel-path).
- **`/preview/<sid>/...` returns 401 in a new tab** — `bobbit_session` cookie missing/scoped wrong. See [preview-architecture.md#cookie-auth](docs/preview-architecture.md#cookie-auth).
- **Preview iframe shows 'No preview yet' indefinitely** — SSE event must carry `entry`. See [preview-architecture.md#sse--get-apisessionssidpreview-events](docs/preview-architecture.md#sse--get-apisessionssidpreview-events).
- **Streaming dedup/reorder** — `seq`+`ts` envelope, `{type:"resume", fromSeq}` on reconnect. See [debugging.md#streaming-dedup--reorder](docs/debugging.md#streaming-dedup--reorder).
- **WS overflow guard** — `decideOverflowAction` in `src/server/ws/ws-overflow-guard.ts`. See [debugging.md#ws-overflow-guard](docs/debugging.md#ws-overflow-guard).
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`. See [debugging.md#verification-log-duplicated-nx-multi-listener](docs/debugging.md#verification-log-duplicated-nx-multi-listener).
- **Scroll snaps back / tail-chat lost / false-positive Jump** — `AgentInterface` ports `use-stick-to-bottom`; two-flag `_isAtBottom`/`_escapedFromLock`; never re-add `_programmaticEchoes`/`_settleWindow*`/`_suppressJumpUntilTs`. See [design/tail-chat-redesign.md](docs/design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag` flag. See [debugging.md#proposal-panel-button-enabled-mid-stream--scroll-resets-on-delta](docs/debugging.md#proposal-panel-button-enabled-mid-stream--scroll-resets-on-delta).
- **Inline-comment annotations on proposals missing** — ephemeral `proposalBackend` in `src/ui/components/review/proposal-annotations.ts`. See [debugging.md#inline-comment-annotations-on-goalrolestaff-proposals](docs/debugging.md#inline-comment-annotations-on-goalrolestaff-proposals).
- **"Send feedback" button missing on a proposal panel** — gated on annotation count > 0 AND not streaming. See [debugging.md#send-feedback-button-missing-on-a-proposal-panel](docs/debugging.md#send-feedback-button-missing-on-a-proposal-panel).
- **"Open proposal" on old card destroys later edits** — check `__proposal_rev_v1__:<n>` marker. See [debugging.md#open-proposal-on-old-card-destroys-later-edits](docs/debugging.md#open-proposal-on-old-card-destroys-later-edits).
- **Proposal panel doesn't update after `edit_proposal`** — check WS `proposal_update` frame + structured error code. See [debugging.md#proposal-panel-doesnt-update-after-edit_proposal](docs/debugging.md#proposal-panel-doesnt-update-after-edit_proposal).
- **"No project selected for this goal" toast in re-attempt assistant** — `goalProposalPanel()` / `goalPreviewPanel()` in `src/app/render.ts`. See [debugging.md#re-attempt-project-binding](docs/debugging.md#re-attempt-project-binding).
- **Dismissed proposal reappears after reload** — `goalDraft.restore` / `roleDraft.restore` must consult `isProposalDismissedTyped`. See [debugging.md#dismissed-proposal-restored-on-reload](docs/debugging.md#dismissed-proposal-restored-on-reload).
- **Stale messages / dups / out-of-order widgets on session navigate** — reducer in `src/app/message-reducer.ts`.
- **Messages disappear from chat transcript and reappear after sending another prompt** — H3 snapshot/live race. Symptom most reliable on WS drop+reconnect mid-stream and on two-tab visibility resync (both tabs converge on the same missing rows — diagnostic that the snapshot itself is missing data, not a per-client display glitch). Root cause: agent flushes to `.jsonl` only on `message_end`, so `getMessages` snapshots taken mid-turn don't represent in-flight rows; client survivor filter previously stripped them. Fixed by server-side `spliceInFlightMessage()` + reducer `_order > snapshotMaxOrder` guard + multiset plain-text dedup + `_order <= 0` prior-artifact drop. Regression test: `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts`. See [docs/design/snapshot-live-race-fix.md](docs/design/snapshot-live-race-fix.md).
- **Continue-Archived button missing** — only when archived AND no `goalId` AND no `delegateOf` AND project still registered. See [debugging.md#continue-archived-button-missing](docs/debugging.md#continue-archived-button-missing).
- **Continued session missing earlier transcript** — confirm cloned `.jsonl` at `agentSessionFile` path. See [debugging.md#continued-session-missing-earlier-transcript](docs/debugging.md#continued-session-missing-earlier-transcript).
- **Archived session footer shows wrong model** — archived `auth_ok` must push `state` via `buildArchivedStateData()`. See [debugging.md#archived-session-footer-shows-placeholder-model](docs/debugging.md#archived-session-footer-shows-placeholder-model).
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`. See [debugging.md#stale-draft-resurrection](docs/debugging.md#stale-draft-resurrection).
- **400 "projectId required"** — splash buttons gated on `state.projects.length`; system tool-assistants pass `projectId: "system"`. See [debugging.md#multi-project--per-project-state](docs/debugging.md#multi-project--per-project-state).
- **Synthetic system project / `projectId: "system"`** — registered at startup; `hidden: true`; anchored at `<bobbitStateDir>/system-project/`. See [internals.md#synthetic-system-project](docs/internals.md#synthetic-system-project).
- **Symlinked project root rejected with `code: symlink_root`** — `POST /api/projects` returns 400 `{ code: "symlink_root", rootPath, canonical }` when `rootPath` is a symlink. UI auto-prompts and re-submits with `acceptCanonical: true`; CLI/scripted callers must do the same or pass the canonical path directly. See `detectSymlinkRoot()` in `src/server/agent/project-registry.ts` and [debugging.md#symlinked-project-root-rejected-with-code-symlink_root](docs/debugging.md#symlinked-project-root-rejected-with-code-symlink_root).
- **`findByCwd` returns undefined for a symlinked cwd** — should not happen post-fix; `findByCwd()` canonicalises both sides via `realpathSync` with a try/catch fallback (Windows EPERM falls back to the textual path). If you see this regression, verify the canonicalisation block in `src/server/agent/project-registry.ts::findByCwd` is intact and that `getByPath()` is still NOT canonicalised (it's the duplicate-path guard). See [debugging.md#findbycwd-returns-undefined-for-a-symlinked-cwd](docs/debugging.md#findbycwd-returns-undefined-for-a-symlinked-cwd).
- **Orphan remote branches** — `deleteRemoteGoalBranches` (goals); `session-eager-branch-delete.ts` (sessions). See [design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Bundle-size assertion fails** — `tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json`; budget 600 kB main / 500 kB per-chunk. See [debugging.md#bundle-size-assertion-fails](docs/debugging.md#bundle-size-assertion-fails).
- **Markdown not rendering in chat / proposal panel** — call `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts`. See [debugging.md#markdown-not-rendering-in-chat--proposal-panel](docs/debugging.md#markdown-not-rendering-in-chat--proposal-panel).
- **Page chunk fails to load on first navigation** — `lazyPage()` in `src/app/render.ts`. See [debugging.md#page-chunk-fails-to-load-on-first-navigation](docs/debugging.md#page-chunk-fails-to-load-on-first-navigation).
- **Lazy tool renderer placeholder sticks / Open button never appears** — `TOOL_RENDERER_LOADED_EVENT` in `src/ui/tools/renderer-registry.ts`; listener in `<tool-message>` / `<tool-group>`. See [debugging.md#lazy-tool-renderer-placeholder-sticks](docs/debugging.md#lazy-tool-renderer-placeholder-sticks).
- **Proposal panel empty after reload** — `_bufferedProposalEvents` in `src/app/remote-agent.ts`. See [debugging.md#proposal-panel-empty-after-reload](docs/debugging.md#proposal-panel-empty-after-reload).
- **Image generation failure** — `400` malformed input, `500 { error }` provider-side; never `502`/`503`. See [debugging.md#image-generation-failure](docs/debugging.md#image-generation-failure).
- **Header toast vs proposal toast testid collision** — `header-toast` vs `proposal-toast`; two slots in `src/app/render.ts`. See [debugging.md#header-toast-vs-proposal-toast-testid-collision](docs/debugging.md#header-toast-vs-proposal-toast-testid-collision).
- **`read_session` returns `permission_denied`** — cross-project read; check `x-bobbit-session-id` header. See [debugging.md#read_session-returns-permission_denied](docs/debugging.md#read_session-returns-permission_denied).
- **Mobile annotation popover doesn't open** — `_onMobileAddComment` must set `_popoverReferenceRect` before mount. See [debugging.md#mobile-annotation-popover-doesnt-open-after-tapping-add-comment](docs/debugging.md#mobile-annotation-popover-doesnt-open-after-tapping-add-comment).
- **Tier 2.5 report missing / ffmpeg failed** — set `FFMPEG_PATH` or install ffmpeg; only when `RECORDSCREEN=1`. See [debugging.md#tier-25-report-missing--ffmpeg-failed](docs/debugging.md#tier-25-report-missing--ffmpeg-failed).
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=`.

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
