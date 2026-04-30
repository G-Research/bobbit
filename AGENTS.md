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
- **Modify slash-skill expansion / chip rendering** → server resolver `src/server/skills/resolve-skill-expansions.ts` (snapshot semantics, prefix-only vs inline scan), sidecar persistence `src/server/skills/skill-sidecar.ts`, system-prompt section in `src/server/agent/system-prompt.ts`, autonomous-activation tool `defaults/tools/skills/activate_skill.yaml` + `defaults/tools/skills/extension.ts`. UI chip `src/ui/components/SkillChip.ts`, splice into user bubble in `src/ui/components/Messages.ts`, tool-call rendering in `src/ui/tools/renderers/ActivateSkillRenderer.ts`. See [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Label multi-line bash calls** → pass `description` to `bash` (mirrors `bash_bg`'s required `name`). See `defaults/tools/shell/bash.yaml`.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`. See [docs/internals.md — MCP servers](docs/internals.md#mcp-servers).
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`; later REST call resolves it. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. See [docs/internals.md — Config scan directories](docs/internals.md#config-scan-directories).
  - Discovered skills are auto-exposed to the agent (level-1 progressive disclosure): name + description are listed in the system prompt under "Available Skills" and the agent can self-activate via the `activate_skill` tool. Skills with `disable-model-invocation: true` (or roles with `Skills: never` policy) stay user-invocable only. User-typed `/name args` renders as a clickable chip in the chat bubble while the model still receives the fully expanded body. See [docs/internals.md — Skill chip rendering & autonomous activation](docs/internals.md#skill-chip-rendering--autonomous-activation).
  - **Multi-file skills (Level-3 progressive disclosure):** SKILL.md authors can include `references/`, `scripts/`, and `assets/` subdirs. On activation, the agent receives a synthetic header with the skill root absolute path and a one-level-deep resource manifest, then reads referenced files on demand using the relative paths the SKILL.md author wrote. `@path` markdown refs in skill bodies are NOT auto-inlined — Claude Code parity. Built-in and personal skills emit a degraded header inside the Docker sandbox; see [docs/internals.md — Sandbox skill visibility](docs/internals.md#sandbox-skill-visibility).
- **Add an IndexSource** → implement `IndexSource` from `src/server/search/types.ts`; wire into `SearchService`. See [docs/design/portable-search.md](docs/design/portable-search.md).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager`. See [docs/internals.md — Store resolution](docs/internals.md#store-resolution-pattern).
- **Add/modify session creation** → plan/execute in `session-setup.ts`, wrappers in `session-manager.ts`. Four modes: normal, worktree, delegate, continue-archived. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Continue an archived session** → footer button in `AgentInterface.ts` → `ContinueSessionChooser.ts` → `POST /api/sessions/:archivedId/continue`. Server: `src/server/agent/continue-archived.ts`. See [docs/internals.md — Continue-Archived sessions](docs/internals.md#continue-archived-sessions).
- **Server-side read/unread state** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`. Client uses `markSessionVisited` / `hasUnseenActivity` in `src/app/render-helpers.ts`. Legacy `localStorage` map migrated once via `migrateLegacyVisitedMap` from `src/app/main.ts`. See [docs/internals.md — Read/unread state](docs/internals.md#readunread-state).
- **Config cascade** → builtin → server → project. Modules: `builtin-config.ts`, `config-cascade.ts`. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).
- **Add a config type to the cascade** → loader in `BuiltinConfigProvider`, `resolveX()` in `ConfigCascade`, REST endpoint, UI scope row (`config-scope.ts`).
- **Debug review/naming model picking the wrong model under AI Gateway** → `applyReviewModelOverrides` in `src/server/agent/review-model-override.ts` parses `default.reviewModel`/`default.namingModel` as `provider/modelId`, calls `rpc.setModel`, then `rpc.getState()` and throws on mismatch (accepts both `{success,data:{model}}` and `{model}` shapes). Naming fallback: `title-generator.ts::pickFallbackAigwNamingModel` tiers haiku→sonnet→opus. See [docs/debugging.md](docs/debugging.md).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` (builtin) or `.bobbit/config/tool-group-policies.yaml` (project). Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).
- **Per-role model / thinking-level override** → role YAML `model: "<provider>/<modelId>"` and `thinkingLevel`. Edit via the **Model** tab on the role-manager page (`src/app/role-manager-page.ts`). Bound at session start by `tryAutoSelectModel` / `tryApplyDefaultThinkingLevel` in `session-manager.ts` via the new `applyModelString` helper in `review-model-override.ts`. Verification reviewer/QA sessions check the role first in `verification-harness.ts`, then fall back to `default.reviewModel`. Cascades project > server > builtin like `toolPolicies`. Spec: [docs/design/per-role-model-overrides.md](docs/design/per-role-model-overrides.md); summary: [docs/internals.md — Per-role model & thinking-level overrides](docs/internals.md#per-role-model--thinking-level-overrides).
- **Change message rendering** → `src/ui/components/Messages.ts` (standard), `message-renderer-registry.ts` (custom).
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `AgentInterface.ts`, `src/app/session-manager.ts`, `src/app/goal-dashboard.ts`, `src/app/git-status-refresh.ts`, `src/app/api.ts`, `src/server/server.ts` (`batchGitStatus`). See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md) and [docs/internals.md — Git status cache & client resilience](docs/internals.md#git-status-cache--client-resilience).
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Applied in `session-setup.ts`/`session-manager.ts`. Renderers: `WriteRenderer.ts`, `PreviewRenderer.ts`. Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`. See [docs/internals.md — Large content truncation](docs/internals.md#large-content-truncation).
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).
- **Add a multi-repo project / components / inline workflows** → components live in `project.yaml::components[]` (the only collection); workflows live inline in `project.yaml::workflows`. Default-component name = project name. Data-only components (no `commands`) declare a repo for the multi-repo invariant without contributing workflow steps. Workflow `type: command` step shapes: `{component, command}` | `{component, run}` | `{run}`; no `cwd:` field. Authoring patterns in [`defaults/workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md). Full reference: [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components).
- **Cleanup remote branches on archive** → goal archive snapshots agent branch list before teardown then push-deletes via `deleteRemoteGoalBranches` in `server.ts`; session archive eagerly push-deletes merged `session/*` via `session-eager-branch-delete.ts` from `session-manager.ts::terminateSession`. All push-deletes gated by `shouldSkipRemotePush()` in `skills/git.ts`. See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md) and [docs/internals.md — Remote branch cleanup](docs/internals.md#remote-branch-cleanup).
- **Maintenance cleanup** → Settings → Maintenance. Scan/preview/execute pattern. Hosts Search Index panel. See [docs/internals.md — Semantic search](docs/internals.md#semantic-search).
- **Per-project settings** → Settings → project tab. Inherits from System. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent can call `propose_project` against the current registered project; the user reviews a diff in a "Project" tab in the preview panel and accepts via `PUT /api/projects/:id/config` without ending the session. Key: `session-manager.ts::acceptProjectProposal` (dispatches provisional vs registered), `render.ts::projectProposalPanel`, `propose_project` tool, `PUT /api/projects/:id/config`. Spec: [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md); summary in [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Add QA testing** → `qa_start_command` in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md). Screenshots: agent uses `<img src="file:///<path>">` from `[screenshot_file]` (NOT base64 — bloats transcript). Server inlines file:// refs to data URIs on report submission.
- **Create a design mockup** → `/mockup` skill or [.bobbit/config/docs/design-mockups.md](.bobbit/config/docs/design-mockups.md).
- **Generate an image** → agent calls `generate_image` (`defaults/tools/images/generate_image.yaml` + `extension.ts`, sharing `defaults/tools/_shared/gateway.ts` for gateway URL/token resolution); gateway routes via `POST /api/image-generation/generate` to provider helpers in `src/server/agent/image-generation.ts`. Per-session model selection lives in the footer picker (`src/ui/dialogs/ImageModelSelector.ts`) → WS `set_image_model` (`src/server/ws/handler.ts`) → `imageModelProvider` + `imageModelId` on the session row. System default preference key `default.imageModel`, edited in Settings → Models → Image. Agent routing rules (DALL-E ids vs `openai/gpt-image-2` vs Google ids) live in `defaults/system-prompt.md`. See [docs/internals.md — Image generation routing](docs/internals.md#image-generation-routing) and [docs/rest-api.md — Image generation](docs/rest-api.md#image-generation).
- **Add / debug per-provider OAuth** → `src/server/auth/oauth.ts` (`oauthStartExternal`, `oauthComplete`, `oauthStatus`, `oauthFlowStatus`); REST endpoints `GET /api/oauth/status?provider=`, `POST /api/oauth/start`, `POST /api/oauth/complete`, `GET /api/oauth/flow-status?flowId=&provider=` (all keyed by `provider` — `anthropic` and `openai-codex`). UI lives in Settings → Account (`src/app/settings-page.ts`); the per-row Re-auth button uses the module-scoped `accountReauthing` flag in that file to disable siblings while one flow is in flight. See [docs/rest-api.md — OAuth](docs/rest-api.md#oauth).

## Debugging

See [docs/debugging.md](docs/debugging.md) for full checklists. Keyword index for common symptoms:

- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **`lastActivity` reads as "just now" after server restart** — `restoreSession` in `src/server/agent/session-manager.ts` replays historical rpc events into the session; the `session.lastActivity = Date.now()` bump is gated on the existing `restoring` flag so replay events don't clobber the persisted timestamp. The dormant-session path (`addDormantSession`) preserves `ps.lastActivity` directly. See [docs/internals.md — Read/unread state](docs/internals.md#readunread-state) (`lastActivity` preservation across restart).
- **Sandbox status** — `GET /api/sandbox-status`; container label `bobbit-project=<projectId>`.
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification` or dashboard Cancel.
- **Worktree setup not running on pool / staff** — `components[*].worktreeSetupCommand` is the single source of truth. Pool `_fill()`, staff wake refresh, and session-setup all route through `runComponentSetups()` (`src/server/skills/worktree-setup.ts`). The legacy top-level `worktree_setup_command` is read only by `state-migration/migrate-project-yaml.ts`; reads outside that file are forbidden and guarded by a unit test in `tests/worktree-pool.test.ts`. Pool fills log `[worktree-pool] running setup for components: <names>`. See [docs/debugging.md — Worktree setup hook not running](docs/debugging.md#worktree-setup-hook-not-running) and [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Gate verification baselines** — pre-impl gates don't diff; impl+ diff against `origin/<primary>...HEAD`. See [docs/goals-workflows-tasks.md — Gate verification baselines](docs/goals-workflows-tasks.md#gate-verification-baselines).
- **Gate/task tool bloat** — use `?view=summary`; drill via `gate_inspect`. See [docs/rest-api.md — Summary views](docs/rest-api.md#summary-views-viewsummary).
- **Dead/ghost search results** — `ProjectContextManager.searchAll()` post-filters orphans. See [docs/internals.md — Orphan filtering & stale-click safety net](docs/internals.md#orphan-filtering--stale-click-safety-net).
- **Search index** — FlexSearch at `.bobbit/state/search.flex/`; delete to force rebuild. Meta mismatch auto-rebuilds. See [docs/internals.md — Semantic search](docs/internals.md#semantic-search).
- **Sidebar child loading** — check server BFS enrichment, archived-goals `archivedSessions`, on-demand fallback guard. See [docs/debugging.md](docs/debugging.md) "Paginated archives".
- **QA screenshot token bloat** — verify extension emits `[screenshot_file]` not `[screenshot_base64]`. See [docs/qa-testing.md — Screenshots in QA reports](docs/qa-testing.md#screenshots-in-qa-reports).
- **Skill resource manifest (Level-3)** — SKILL.md `@path` markdown refs are no longer auto-inlined; agents read referenced files on demand. An activation header (HTML comment fence `<!-- skill-activation-header -->…<!-- /skill-activation-header -->`) is prepended to model-facing `expanded` with the skill root + one-level manifest of `references/`/`scripts/`/`assets/` (2 KB cap, alphabetical truncation). `SkillChip.displayBody` strips the header so the chat-bubble disclosure shows only the SKILL.md body the author wrote. Inside the Docker sandbox, built-in/personal skill roots aren't mounted → degraded header (no manifest); project-local skills work. Key files: `src/server/skills/skill-manifest.ts`, `resolve-skill-expansions.ts`, `slash-skills.ts`, `src/ui/components/SkillChip.ts`. See [docs/internals.md — Sandbox skill visibility](docs/internals.md#sandbox-skill-visibility) and [docs/debugging.md — Skill references not loading](docs/debugging.md#skill-references-not-loading).
- **Skill chip / autonomous activation** — user-typed `/name args` keeps its literal text in the chat bubble; resolved expansions ride alongside in `skillExpansions[]` (sidecar at `<stateDir>/skill-sidecar/<sessionId>.jsonl`) and render as `<skill-chip>` elements. Model-facing prompt is byte-equal to the legacy expanded form. Agent-side autonomous activation goes through `activate_skill` (tool group `Skills`, list capped at 4 KB in the system prompt). Old sessions with no sidecar render as plain text — backward compatible. Key files: `src/server/skills/resolve-skill-expansions.ts`, `src/server/skills/skill-sidecar.ts`, `src/server/ws/handler.ts` (must include `skillExpansions` in the user-message echo — regression risk), `src/server/agent/system-prompt.ts`, `defaults/tools/skills/`, `src/ui/components/SkillChip.ts`. See [docs/debugging.md — Skill chip not rendering](docs/debugging.md#skill-chip-not-rendering) and [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Tool-guard extension ParseError** — new sessions crash for roles with a `never`-policy tool; quoting slip in the template-literal generator in `tool-guard-extension.ts`. Guarded by `tests/tool-guard-extension.test.ts`. See [docs/debugging.md](docs/debugging.md).
- **Auto-nudge flooding** — `nudgePending` guard in TeamManager.
- **Review/naming models under AI Gateway** — reviewer/QA bind via `applyReviewModelOverrides` (`src/server/agent/review-model-override.ts`); any failure throws → hard gate failure (no silent fallback). A role-level `model` field, when set, takes precedence over `default.reviewModel` for verification sub-sessions of that role (bound via the sibling `applyModelString` helper from `verification-harness.ts`). Naming model is unaffected and auto-picks cheapest-tier Claude via `pickFallbackAigwNamingModel` when no explicit pref. Settings → Models shows red "Unavailable" badge for stale prefs + per-row Test button (`POST /api/models/test`).
- **Live-steer lost after Stop** — must route through `SessionManager.deliverLiveSteer()`, which persists to `promptQueue` before calling `rpcClient.steer()`. Repro: `PI-25b`/`PI-25c` in `tests/e2e/abort-status-e2e.spec.ts`.
- **Session wedged after errored turn** — a new prompt/steer to a session with `lastTurnErrored=true` now implicitly unsticks it (clears the flag, prepends a `[SYSTEM: previous turn failed…]` prefix, dispatches fresh intent — no retry of the failed turn). Capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3` so a persistently broken upstream can't be re-triggered on every nudge; beyond the cap, messages park until a human clicks Retry (which bypasses the cap). TeamManager no longer suppresses nudges to errored team leads. See [docs/debugging.md — Session wedged after errored turn](docs/debugging.md#session-wedged-after-errored-turn).
- **`bash_bg wait` not interrupted by steer** — steers must go via `deliverLiveSteer`; `BgProcessManager.waits` registry aborted by `abortAllWaits()`. See [docs/internals.md — Steer-interruptible bash_bg wait](docs/internals.md#steer-interruptible-bash_bg-wait).
- **Large file writes freezing** — `truncateLargeToolContent()` at >32KB. If lazy-load fails, check `.jsonl` exists.
- **Preview Open button broken** — `tool_result` must include the `__preview_snapshot_v1__` marker block; truncated snapshots hydrate via `GET /api/sessions/:id/tool-content/:mi/:bi`; flip panel via PATCH `{preview:true}` → POST `/api/preview`.
- **Streaming dedup/reorder** — events carry `seq`+`ts`; client sends `{type:"resume", fromSeq}` on reconnect; `resume_gap` falls back to `get_messages`. See [docs/design/streaming-dedup-reorder.md](docs/design/streaming-dedup-reorder.md).
- **Verification log Nx duplication** — streaming verification output (`<verification-output-modal>`, `<gate-verification-live>`) printing each line N× (where N tracks open sessions per goal in the tab, +1 per dashboard mount). Cause: every `RemoteAgent` owns its own session WS and `broadcastToGoal` fan-outs the same `gate_verification_*` event to all of them; each used to dispatch `gate-verification-event` on `document` independently. Fix: server stamps a monotonic `seq` on every gate verification event (`verification-harness.ts`, `ws/protocol.ts`); all dispatchers (`remote-agent.ts`, `goal-dashboard.ts`) funnel through `src/app/verification-event-bus.ts`, which dedupes by `(eventType, signalId, stepIndex, seq)` with a bounded LRU set. Listener-side, `VerificationOutputModal` + `GateVerificationLive` use `AbortController` so Lit re-renders/teardown can't leak duplicate listeners, and the modal tracks a bootstrap high-water `seq` to drop live events ≤ that mark when reopened mid-stream. See [docs/internals.md — Verification event dedupe](docs/internals.md#verification-event-dedupe) and [docs/debugging.md — Verification log duplicated Nx](docs/debugging.md#verification-log-duplicated-nx).
- **Scroll snaps back / vibration in idle session** — `AgentInterface` ResizeObserver only auto-scrolls on `delta > 0`; user intent is detected via explicit `wheel`/`touchstart`/`keydown` listeners and a programmatic-scroll echo filter (captured `scrollTop`/`scrollHeight`), never timer-based heuristics. 5px stick-to-bottom tail. See [docs/debugging.md — Scroll snap-back / vibration](docs/debugging.md#scroll-snap-back--vibration-in-idle-session) and [docs/internals.md — Chat scroll lock invariant](docs/internals.md#chat-scroll-lock-invariant).
- **Stale messages trailing after newer ones on session navigate** — `RemoteAgent` `messages` snapshot handler builds a `serverIds` set, drops client-bucket entries already in the snapshot (id-based, with synthetic-compaction-marker text fallback), then stable-sorts the merged result by `(timestamp, insertionOrder)`. Server snapshot is authoritative. See [docs/debugging.md — Stale messages on session navigate](docs/debugging.md#stale-messages-trailing-after-newer-ones-on-session-navigate) and [docs/internals.md — Snapshot merge invariant](docs/internals.md#snapshot-merge-invariant).
- **Continue-Archived button missing** — only renders when archived AND no `goalId` AND no `delegateOf` AND project still registered.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects writes with older `gen`; client must increment `gen` per change, tombstone carries highest.
- **400 "projectId required"** on `POST /api/goals|/api/sessions|/api/staff` — pass `projectId` or a `cwd` inside a registered project; no default fallback. See [docs/rest-api.md — Project resolution contract](docs/rest-api.md#project-resolution-contract).
- **Orphan remote branches / leaked `goal/`, `session/`, `goal-goal-*-<role>-*`, `staff-*`** — goal archive: `server.ts::deleteRemoteGoalBranches` snapshots agent branch names *before* `teamManager.teardownTeam` mutates `entry.agents` (otherwise per-role branches leak). Session archive: `session-manager.ts::terminateSession` fire-and-forgets `eagerDeleteRemoteSessionBranch` from `session-eager-branch-delete.ts` for non-delegate `session/*` branches that are fully merged into `origin/<primary>`; unmerged or non-`session/` branches defer to the 7-day `purgeOneSession` worktree cleanup. Staff: `cleanupWorktree(..., deleteBranch=true)` in `skills/git.ts` already push-deletes. Every push-delete (existing and new) is gated by `shouldSkipRemotePush()` so test mode (`BOBBIT_TEST_NO_PUSH=1`) never touches the remote. See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md) and [docs/debugging.md — Leaked remote branches](docs/debugging.md#leaked-remote-branches).
- **Image generation failure** — `POST /api/image-generation/generate` returns `400` for malformed input (`Missing prompt`, `prompt exceeds 8192 chars`, `n must be 1..4`) or `500 { error: "<provider message>" }` for any provider-side failure (missing credentials, Codex `n=1` clamp, `remote image exceeds 25 MB cap`, upstream HTTP error — never `[object Object]`). The endpoint never emits `502` or `503`. Codex driver model resolution: env var `BOBBIT_OPENAI_CODEX_IMAGE_DRIVER_MODEL` falls back through `gpt-5.5 → gpt-5 → gpt-4o`. Strict `unknown image model` validation lives on the WS `set_image_model` path, not the REST endpoint. See [docs/rest-api.md — Image generation](docs/rest-api.md#image-generation) for the full contract and [docs/internals.md — Image generation routing](docs/internals.md#image-generation-routing) for the data flow.
- **OAuth callback never completes** — user clicks "Connect" in Settings → Account, browser redirects, but the UI keeps showing the spinner. First check: poll `GET /api/oauth/flow-status?flowId=<id>&provider=<id>` directly (`curl -sk "$GW/api/oauth/flow-status?flowId=…&provider=anthropic"`). A `404 flow not found` either means the flow expired (check `expiresAt`) **or** the `provider` query param does not match the stored flow's provider — cross-provider polling is intentionally treated as not-found (defence in depth). If `complete: true` with `error: …`, the provider rejected the code. If `complete: false` past `expiresAt`, the browser-redirect handler never fired — check that `oauthStartExternal` constructed `flow.loginPromise` with the real promise (not a placeholder) and that `pendingFlows.set` happened **after** the auth URL was issued. See [docs/rest-api.md — OAuth](docs/rest-api.md#oauth).

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Committing with a dirty working copy

When asked to commit, other unstaged/staged changes may exist from another agent or the user. **Never discard, stash, or reset those changes.** Stage only the files you modified (`git add <your-files>`) and commit. If your changes overlap and can't be cleanly separated, ask the user.

### Worktrees

Dev server runs from the **primary worktree** on `master`. All sessions use separate worktrees under `<project-root>-wt/<branch>/` (single-repo) or `<project-root>-wt/<branch>/<repo>/` (multi-repo). The default parent is `<rootPath>-wt/`; override with the project-level `worktree_root` field. Assistant sessions (goal/project/tool assistants) don't edit code and don't get worktrees.

**Branch namespaces:** `pool/_pool-<id>` (pool pre-builds, was `session/_pool-*` pre-Phase 3), `session/<slug>-<id>` (live regular sessions after first prompt), `goal/<slug>-<id>` (goals), `staff-<name>-<id>` (staff). See [docs/dev-workflow.md — Worktree branch namespaces](docs/dev-workflow.md#worktree-branch-namespaces).

**Multi-repo invariant:** in multi-repo projects, every configured component repo (including data-only ones) gets a sibling worktree on the same branch. The agent's cwd is the per-branch container (`<rootPath>-wt/<branch>/`), mirroring the primary `rootPath` structure. See [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components) for the project model and [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees) for layout, pool claim, and rename-on-first-prompt mechanics.

**Always edit files in your session worktree, never in the primary worktree.** Editing the primary worktree risks merge conflicts during rebase, corruption of in-progress work by other agents, and breaking the running dev server. Even for infra files that need to end up in primary, the correct flow is: edit here → commit → push → pull from primary. See [docs/dev-workflow.md](docs/dev-workflow.md) for the full rationale.

**Pushing to remote `master` does NOT update the dev server.** Pull into the primary worktree:

```bash
cd <primary-worktree> && git pull origin master
```

You cannot `git checkout master` from a goal worktree — push to remote and pull from primary instead.

### Worktree setup command (per-component)

Configured **per component** via `components[*].worktree_setup_command` in `project.yaml`. Runs at the component's root path (`<worktree>/<component.repo>/<component.relative_path>`) with `SOURCE_REPO` env var pointing at the matching primary path. 2-minute timeout per component, non-fatal, `sh -c`. **No deduplication** — if multiple components in the same repo each define `worktree_setup_command`, it runs once per component.

```yaml
components:
  - name: myapp
    repo: "."
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    # or: cp -r "$SOURCE_REPO/node_modules" node_modules
    commands: { build: npm run build, test: npm test }
```

Components without `worktree_setup_command` (including all data-only components) are silently skipped. Staff agent worktrees are auto-refreshed on each wake cycle — rebased onto primary and per-component setup re-run. `runComponentSetups()` exported from `src/server/skills/worktree-setup.ts`. Sandboxed staff skip host-side refresh.

**`components[*].worktreeSetupCommand` is the single source of truth.** Every worktree-creation site routes through `runComponentSetups()`: the pool's `_fill()` (single-repo and multi-repo), staff wake refresh, and session-setup (which pulls `opts.setupCommand` from `components[0]`). The pool logs `[worktree-pool] running setup for components: <names>` on every fill so a silent regression — like the one where three call sites still read the migrated-away top-level `worktree_setup_command` and no-oped — is immediately visible. A regression-guard unit test (`tests/worktree-pool.test.ts`) fails if any source file outside `state-migration/migrate-project-yaml.ts` reads the legacy top-level key. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees) and [docs/debugging.md — Worktree setup hook not running](docs/debugging.md#worktree-setup-hook-not-running).

## Reference docs

- [docs/internals.md](docs/internals.md) — tool policies, search, MCP, sandbox, config, disk state, goals, multi-project
- [docs/debugging.md](docs/debugging.md) — scannable debugging checklists
- [docs/dev-workflow.md](docs/dev-workflow.md) — running modes, restart workflow, worktree rationale
- [docs/testing-strategy.md](docs/testing-strategy.md) — test architecture and harness APIs
- [docs/testing-coverage.md](docs/testing-coverage.md) — per-area test coverage (prompt interactions, sidebar, sessions, resilience)
- [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) — goal/workflow/gate data model
- [docs/blocking-tools.md](docs/blocking-tools.md) — blocking-tool pattern (`verification_result`)
- [docs/non-blocking-ask.md](docs/non-blocking-ask.md) — non-blocking `ask_user_choices` flow
