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
- **Assert tail-chat / scroll-pin behaviour in an E2E test** → import `expectLatestMessagePinned` and `disableScrollAnchoring` from `tests/e2e/ui/tail-chat-helpers.ts`. Outcome-only — reads `getBoundingClientRect()` of the latest message vs the scroll container; never asserts on `_stickToBottom` / `_programmaticEchoes` or any private field. Always call `disableScrollAnchoring(page)` first so Chromium ≡ Safari and the JS pin path is the single contract under test. Pattern reference: `tests/e2e/ui/tail-chat-real-stream.spec.ts`. See [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](docs/design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [docs/rest-api.md](docs/rest-api.md).
- **Add a project** → `POST /api/projects` or sidebar "Add Project". Key: `src/server/agent/project-registry.ts`, `project-context-manager.ts`. The project assistant designs all workflows — server seeds none. See [docs/internals.md — Project assistant](docs/internals.md#project-assistant).
- **Splash-screen new-session gating / system tool-assistant flow** → desktop empty-state and "Quick Session" button in `src/app/render.ts` are gated on `state.projects.length` (0 → "New Project" CTA via `showProjectDialog()`; 1 → bound session passing that project's id; ≥2 → splash project picker via the dedicated `state.splashProjectPickerOpen` flag — distinct from the sidebar's `state.rolePickerOpen`). System-scope tool-assistant sessions created from the Tools page (`src/app/tool-manager-page.ts::createToolAssistantSession()`) pass `projectId: "system"` so they land under the synthetic hidden system project registered at startup by `registerSystemProject()` in `src/server/agent/project-registry.ts` (called from `src/server/server.ts`). See [docs/internals.md — Synthetic system project](docs/internals.md#synthetic-system-project).
- **Remove a project** → settings → General → Remove. `DELETE /api/projects/:id`.
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method.
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Add a route-level page (lazy-loaded)** → page module under `src/app/`, then add a `lazyPage("<key>", () => import("./<page>.js"), "<exportName>")` branch to `mainArea()` in `src/app/render.ts`. CSS belongs inside the page module so it travels with the chunk. The `lazyPage()` / `lazyPageCall()` / `loadingPlaceholder()` helpers cache the resolved module and call `renderApp()` once the dynamic `import()` resolves. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Add a heavy tool renderer (lazy)** → `registerLazyToolRenderer(name, async () => { const m = await import("./renderers/Foo.js"); return new m.FooRenderer(); })` in `src/ui/tools/index.ts`. The registry shows a placeholder while loading and re-renders on resolve. Existing lazy entries: `gate_inspect`, `verification_result`, `preview_open`, `extract_document`, `javascript_repl`. Keep light renderers eager (Bash/Read/Write/etc.) — round-trip per-tool feels laggy. See `src/ui/tools/renderer-registry.ts`.
- **Defer a heavy library (lazy load)** → for custom-element side-effect imports, follow `src/ui/lazy/markdown-block.ts` (`ensureMarkdownBlock()`): a one-shot `import("…/MarkdownBlock.js")` called from each consumer's `connectedCallback()` or first `render()`. For value imports (pdfjs-dist, docx-preview), use `await import()` inside the function that needs the module — see `src/ui/utils/attachment-utils.ts`. Lit tolerates async custom-element upgrade, so brief unstyled flash on first encounter is acceptable.
- **Bundle-size budget assertion** → `tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json` to find the entry chunk and asserts ≤ 600 kB gzipped, plus ≤ 500 kB gzipped for any non-worker chunk. Auto-runs in `npm run test:unit`. Run `npm run test:bundle` to build and assert in one shot. Skips cleanly if `dist/ui/assets/` is missing.
- **SW route-chunk pre-cache** → the `bobbitSwVersion` Vite plugin in `vite.config.ts` reads `dist/ui/.vite/manifest.json` at `closeBundle` time and replaces the `/*__BOBBIT_PRECACHE_CHUNKS__*/` marker in `public/sw.js` with the hashed paths of the most-likely-next-route chunks. Requires `build.manifest: true`. Add a chunk to the warm set by extending the manifest lookup in the plugin.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`.
- **MCP meta-tool aggregation / one row per server** → server-side: helpers in `src/server/mcp/mcp-meta.ts`, extension generator `generateMcpMetaExtension` in `src/server/agent/tool-activation.ts`, dispatcher unchanged (`/api/internal/mcp-call` still receives `mcp__<server>__<op>`). Discovery tool `mcp_describe` (`defaults/tools/mcp/`) routes through new `POST /api/internal/mcp-describe`. Tools page renders one collapsible row per server in a dedicated "MCP" section. See [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) and [docs/design/mcp-meta-tool-aggregation.md](docs/design/mcp-meta-tool-aggregation.md).
- **Read another session's transcript (`read_session` tool)** → pure parser in `src/server/agent/transcript-reader.ts`; HTTP surface `GET /api/sessions/:id/transcript` in `src/server/server.ts`; tool YAML `defaults/tools/agent/read_session.yaml` + extension `defaults/tools/agent/extension.ts`; renderer `src/ui/tools/renderers/ReadSessionRenderer.ts` (lazy, with "Open full transcript" modal that lazy-fetches verbose pages). Params: `session_id`, `offset` (negative = from end), `limit` (default 20, clamped 1..200), `pattern` regex with `case_sensitive` + `context` (±N, max 5), `verbose`. Filter+window composition: regex builds the match list with ±context (deduplicated), then `offset`/`limit` slice over that list. Same-project authorization via the `x-bobbit-session-id` request header set by the extension. Structured error codes: `session_not_found`, `transcript_unavailable`, `invalid_regex`, `invalid_params`, `permission_denied`. Replaces the old `read-session-history` slash skill.
- **Copy session link button** → ghost icon next to "Prompt" in the session header (`src/app/render.ts`). Copies `${origin}/session/<id>` to the clipboard, shows a header toast via `showHeaderToast()` (`data-testid="header-toast"`, kept distinct from `proposal-toast`). Falls back to `CopyLinkFallbackDialog` (`src/ui/dialogs/CopyLinkFallbackDialog.ts`) when the clipboard write rejects. Browser E2E: `tests/e2e/ui/copy-session-link.spec.ts`.
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. Discovered skills auto-exposed for autonomous activation via `activate_skill`. Skills support `references/`, `scripts/`, `assets/` subdirs (Level-3 progressive disclosure). See [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Modify slash-skill expansion / chip rendering** → `src/server/skills/resolve-skill-expansions.ts`, `skill-sidecar.ts`, `src/ui/components/SkillChip.ts`.
- **Add an IndexSource** → implement `IndexSource` from `src/server/search/types.ts`. See [docs/design/portable-search.md](docs/design/portable-search.md).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager` (`src/server/agent/project-context-manager.ts`).
- **Add/modify session creation** → `session-setup.ts`, wrappers in `session-manager.ts`. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
- **Modify steer / queue dispatch** → single dispatch site is `SessionManager._dispatchSteer()` in `src/server/agent/session-manager.ts`; rows are removed from `promptQueue` *before* `await rpcClient.steer()`, then pushed onto the per-session shadow ledger `inFlightSteerTexts`. Echo cleanup in `_consumeSteerEcho` (text-match splice on `message_end(role:user)`); abort reconciliation in `_reconcileAfterAbort` (re-enqueue ledger entries at front via `enqueueAtFront`). `PromptQueue` has no `dispatched` flag and no `markDispatched`/`removeDispatched`/`resetDispatched` — do not reintroduce them. See [docs/prompt-queue.md — Force-kill recovery flow](docs/prompt-queue.md#abort-and-force-kill-recovery) and [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Continue an archived session** → footer button → `POST /api/sessions/:archivedId/continue`. Lossless: server clones the source `.jsonl`. See [docs/design/lossless-continue-archived.md](docs/design/lossless-continue-archived.md).
- **Re-attempt a goal** → sidebar/dashboard "Re-attempt" button → `POST /api/sessions { reattemptGoalId }` → `buildReattemptContext()`. Visible whenever the goal has no active team and no live (non-terminated) session — works for fresh, shelved, stopped-team, archived, and merged goals. See [docs/internals.md — Goal re-attempt flow](docs/internals.md#goal-re-attempt-flow).
- **Archive a goal (UI)** → trash button is rendered on every unarchived goal in both sidebar (`src/app/render-helpers.ts`) and goal dashboard (`src/app/goal-dashboard.ts`); never disabled. Both call sites funnel through `deleteGoal()` in `src/app/api.ts`, which detects an active team via the `team-lead` session heuristic, adapts the confirm-modal copy ("Stop team and archive goal?" + "Stop & Archive" label when active), and on confirm runs `teardownTeam()` first then `DELETE /api/goals/:id`. Centralising the team-detection + teardown sequencing in `deleteGoal()` keeps both entry points in sync — do not gate the buttons on team state.
- **Server-side read/unread state** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`. See [docs/internals.md — Read/unread state](docs/internals.md#readunread-state).
- **Config cascade** → builtin → server → project, for **roles, tools, tool-group-policies, and `system-prompt.md`**. `system-prompt.md` resolves at runtime via `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` (user override at `.bobbit/config/system-prompt.md` wins, else shipped `defaults/system-prompt.md`); the file is no longer scaffolded on startup — users opt in via Settings → General → "Customise system prompt" (`POST /api/system-prompt/customise`). Workflows are project-scoped, not cascaded. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` or `.bobbit/config/tool-group-policies.yaml`. Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. `gate_signal` is team-lead-only. See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).
- **Per-role model / thinking-level override** → role YAML `model: "<provider>/<modelId>"` and `thinkingLevel`. Edit via Model tab in role-manager page. See [docs/design/per-role-model-overrides.md](docs/design/per-role-model-overrides.md).
- **Pin agent model at spawn time / debug duplicate `model_change` events** → `RpcBridgeOptions.initialModel`/`initialThinkingLevel` translate to `--model`/`--thinking` CLI flags via `buildAgentArgs` (`src/server/agent/rpc-bridge.ts`). Resolution: role override → `default.sessionModel` (or `default.reviewModel` for verification sub-sessions) → `undefined` (aigw fallback runs post-spawn). All non-pool spawn paths participate; pool-claim too (the pool only pre-creates worktrees). Post-spawn helpers (`tryAutoSelectModel`, `applyReviewModelOverrides`) pass `skipSetModel: true` when the spawn already pinned, but still run `getState()` read-back — hard-fail-on-mismatch contract preserved via `applyModelString` in `review-model-override.ts`. See [docs/internals.md — Spawn-time model pinning](docs/internals.md#spawn-time-model-pinning).
- **Archived session footer model** → `buildArchivedStateData()` in `src/server/ws/handler.ts` sent on archived `auth_ok` (and reused by `get_state`). Includes model + `imageGenerationModel` so the footer shows the real model on first connect. UI hook: `data-testid="footer-model-id"`. See [docs/internals.md — Archived-session state push on auth](docs/internals.md#archived-session-state-push-on-auth).
- **Change message rendering** → `src/ui/components/Messages.ts` (standard), `message-renderer-registry.ts` (custom).
- **Modify message transcript ordering** → all transcript mutations route through `reduce(state, action)` in `src/app/message-reducer.ts`. Never push directly into `state.messages`. See [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify proposal panel streaming UX** → flag in `state.proposalStreamingByTag`; scroll preserved via `reconcileFollowTail` in `src/app/follow-tail.ts`.
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `src/server/skills/git-status-native.ts`. Pill segments: `~N ↓N ↑N +X -Y <PR icon>` — `+X` (green) / `-Y` (red) are committed-vs-`origin/<primary>` plus uncommitted-vs-HEAD line counts (untracked excluded — `~N` covers them), via `parseShortstat()` over two parallel `git diff --shortstat` calls in Phase B; suppressed on primary or when both are 0. See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Preview an HTML file with sibling assets** → `preview_open({ html | file })`. Both arguments populate the same per-session content mount at `<stateDir>/preview/<sid>/`, served at `/preview/<sid>/<entry>` with cookie auth. Sibling assets resolve via injected `<base href>`. Mount endpoint: `POST /api/preview/mount?sessionId=<sid>` with `{html}` or `{file}` returns `{url, path, entry, mtime}`. Hot reload via `GET /api/sessions/:id/preview-events` (SSE). Snapshot marker: v3 (`__preview_snapshot_v3__` carrying `{kind:"preview",url,path}`) is constant ~150 B; v1/v2 are read-only legacy in `PreviewRenderer.ts`. See [docs/preview-architecture.md](docs/preview-architecture.md).
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).
- **Add a multi-repo project / components / inline workflows** → components in `project.yaml::components[]`, workflows inline in `project.yaml::workflows`. See [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components) and [`defaults/workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md).
- **Cleanup remote branches on archive** → `deleteRemoteGoalBranches` in `server.ts` (goals); `session-eager-branch-delete.ts` (sessions). See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Per-project settings** → Settings → project tab. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent may call `propose_project` against the registered project; user accepts via `PUT /api/projects/:id/config`. See [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md).
- **Edit a proposal mid-session** → `view_proposal(type)` / `edit_proposal(type, old_text, new_text)`. Each successful write also writes a per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`. A `proposal_update` whose body changed also clears any pending inline comments on goal/role/staff panels (see next entry). See [docs/design/editable-proposals.md](docs/design/editable-proposals.md), [docs/design/proposal-revision-snapshots.md](docs/design/proposal-revision-snapshots.md).
- **Add inline comments to a markdown proposal field** → wrap with `<commentable-markdown>` (`src/ui/components/CommentableMarkdown.ts`); pass a stable `bucket` like `"proposal:goal"`. Backend is ephemeral (`src/ui/components/review/proposal-annotations.ts`) — no server persistence; cleared on dismiss, on `proposal_update` body diff, and on reload. See [docs/design/proposal-inline-comments.md](docs/design/proposal-inline-comments.md).
- **Dismiss/restore invariant for proposal panels** → `goalDraft.restore` / `roleDraft.restore` / `projectDraft.restore` in `src/app/session-manager.ts` gate slot rehydration on `isProposalDismissedTyped`. Dismiss does NOT delete the on-disk draft — it preserves form-mirror state and lets `edit_proposal` / "Open proposal" rehydrate cleanly. Only `goal`/`role`/`project` have draft persistence; `staff`/`tool`/`workflow` slots are transient.
- **Add QA testing** → set `qa_start_command` (and friends) on the relevant component's `config:` map in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md).
- **Add a verification reminder site** → see `src/server/agent/verification-harness.ts`. After dispatching the reminder, await `SessionManager.waitForStreaming(sessionId, 10_000).catch(() => {})` before racing `waitForIdle`.
- **Create a design mockup** → `/mockup` skill (canonical body lives at `defaults/docs/design-mockups.md`; resolved by the skill itself).
- **Author HTML output (reports / dashboards / mockups / charts)** → single source of truth: [`defaults/docs/html-rendering.md`](defaults/docs/html-rendering.md). Covers the surface-selection rule (one artefact, one surface — never both inline file *and* `preview_open`), full theme-token reference (`--background`, `--card`, `--chart-1..6`, `--positive` / `--negative` / `--warning` / `--info`), defensive fallbacks for the bridge / HMR race, ready-to-paste patterns, iteration-loop guidance, and anti-patterns. The system prompt and the `/html` and `/mockup` skills all defer to it. The chart palette and semantic slots are seeded in `src/ui/app.css` for both `:root` and `.dark`.
- **Generate an image** → `generate_image` tool routes through `POST /api/image-generation/generate`. See [docs/internals.md — Image generation routing](docs/internals.md#image-generation-routing).
- **Add / debug per-provider OAuth** → `src/server/auth/oauth.ts`; REST endpoints at `/api/oauth/*`. See [docs/rest-api.md — OAuth](docs/rest-api.md#oauth).

## Debugging

Keyword index — full diagnostic walkthroughs live in [docs/debugging.md](docs/debugging.md).

- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore.
- **`system-prompt.md` customisation not taking effect** — resolver `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` only picks up the user override if `<bobbitConfigDir>/system-prompt.md` exists. Click "Customise system prompt" in Settings → General (or `POST /api/system-prompt/customise`) to copy the shipped default into place; restart the server to pick up edits.
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
- **MCP server unavailable / partial outage** — failed servers stay in error state but don't break the agent. Look for the stub meta extension at `<stateDir>/mcp-extensions/[<hash>/]<server>.ts` whose execute returns "MCP server '<name>' is unavailable: <reason>". Per-call timeouts: 10 s on `tools/list`, 30 s on `tools/call` (constants in `src/server/mcp/mcp-manager.ts`). Schema-validation drops malformed ops via `isValidOperationSchema` from `src/server/mcp/mcp-meta.ts` — sibling ops on the same server stay usable.
- **MCP per-op `never` policy not enforced** — Layer A (model-facing) collapses N×M ops into one `mcp_<server>` meta-tool, so per-op grants flow through `mcpPolicyPrefix` regex (extended to match BOTH `mcp__pw__snap` and `mcp_pw`). Layer B enforcement happens server-side in `POST /api/internal/mcp-call`: `resolveGrantPolicy(tool, …)` runs before `mcpManager.callTool` and returns 403 on `never`. If a per-op policy isn't taking effect, check both layers.
- **Tools page "MCP" section missing or empty** — `GET /api/mcp-servers` returns the structured list (`{name,status,toolCount,tools[]}`); `src/app/tool-manager-page.ts::renderMcpSection()` filters them out of normal group rendering and shows one row per server. Empty section means `getMcpManager()` returned no configs — check `discoverServers()` cascade in `src/server/mcp/mcp-manager.ts`.
- **Auto-nudge flooding** — `nudgePending` guard in TeamManager.
- **Reviewer session triggers spurious team-lead nudge** — `kind: "reviewer"` filter in `resubscribeTeamEvents()` and `notifyTeamLead()`.
- **Duplicate `model_change` event at session startup** — confirm spawn site routes through `resolveBridgeOptions` and post-spawn helper passes `skipSetModel: true` when `session.spawnPinnedModel` matches. The aigw cold-cache fallback legitimately emits two; pool-claim is NOT in that bucket. See [docs/debugging.md — Duplicate `model_change` event at session startup](docs/debugging.md#duplicate-model_change-event-at-session-startup).
- **Archived session footer shows `claude-opus-4-6` placeholder** — server failed to push `state` frame on archived `auth_ok`. Fix is `buildArchivedStateData` called after `session_title`. See [docs/debugging.md — Archived session footer shows placeholder model](docs/debugging.md#archived-session-footer-shows-placeholder-model).
- **Resumed reviewer terminated ~46ms after restart** — await `waitForStreaming` before `waitForIdle` race.
- **`x-opencode-session` header missing or shared** — `writeAigwModelsJson` / `BOBBIT_SESSION_ID` env.
- **`models.json` stale after gateway upgrade** — `startupAigwCheck` rewrites on next gateway start.
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw (no silent fallback).
- **Live-steer lost / duplicated after Stop** — every steer must route via `SessionManager.deliverLiveSteer()` → single `_dispatchSteer()` site. Exactly-once at the transcript level relies on the shadow ledger (`SessionInfo.inFlightSteerTexts`) being pushed on dispatch, spliced on echo (`_consumeSteerEcho`), and drained at every abort (`_reconcileAfterAbort` runs in both `agent_end while wasAborting` and `forceAbort` *after* `rpcClient.stop()` — the ledger is Bobbit-owned in-process state, so it survives the bridge teardown either way; the post-kill placement is fine because the ledger isn't read from the dying agent). Re-introducing a `PromptQueue.dispatched` flag or the `removeDispatched`/`resetDispatched` triplet brings back the duplicate-on-Stop bug. See [docs/debugging.md — Abort, steer & queue](docs/debugging.md#abort-steer--queue) and [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Session wedged after errored turn** — implicit unstick clears `lastTurnErrored`; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`.
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry, `abortAllWaits()`.
- **Large file writes freezing** — `truncateLargeToolContent()` at >32KB; check `.jsonl` exists.
- **Preview Open button broken** — `tool_result` must include a `__preview_snapshot_v3__` block carrying `{kind:"preview",url,path}` (`defaults/tools/html/snapshot.ts::buildPreviewSnapshotV3Block`). v1/v2 markers still parse (read-only legacy in `src/ui/tools/renderers/PreviewRenderer.ts`, tagged `Do not extend`); their reopen path POSTs `{html}`/`{file}` to `/api/preview/mount`, and a `400`/`404` on that POST surfaces as "File no longer available". See [docs/preview-architecture.md](docs/preview-architecture.md).
- **Preview iframe shows broken images / 404 on assets** — diagnostic order: (1) confirm the per-session mount exists at `<stateDir>/preview/<sid>/` with the entry file present; (2) confirm the iframe request carries the `bobbit_session` cookie (DevTools → Network → request headers) — missing cookie returns `401` from the content route; (3) check the MIME table in `src/server/preview/mime.ts` covers the asset extension; (4) check path-traversal rejection in `src/server/preview/path-guard.ts` (`403`) or the 25 MiB / 100 MiB caps (`413`). See [docs/preview-architecture.md](docs/preview-architecture.md).
- **`/preview/<sid>/...` returns 401 in a new tab** — (1) check the response `Set-Cookie` from the parent UI request — the `bobbit_session` cookie is minted by `issueIfMissing()` in `src/server/auth/cookie.ts` only after a successful Bearer-token request; (2) confirm cookie `Path=/` so it is sent for the `/preview/...` origin; (3) outside localhost the cookie is `Secure` — plain HTTP will discard it (use the localhost short-circuit or HTTPS); (4) the bearer-token bootstrap (`?token=…` on first load) only authenticates that single request — the cookie is what carries subsequent traffic. See [docs/preview-architecture.md](docs/preview-architecture.md#cookie-auth).
- **Preview iframe shows 'No preview yet' indefinitely after `preview_open`** — the SSE event must carry an `entry` field for the panel to seed `state.previewPanelEntry`. Diagnostic order: (1) confirm `broadcastPreviewChanged()` in `src/server/server.ts` is called with `{entry, mtime, url, path}` after every successful `POST /api/preview/mount`; (2) confirm the SSE handler's bootstrap-on-connect block (also in `src/server/server.ts`) emits a synthetic `preview-changed` when `mountDir(sid)` already has files — fixes the race where the broadcast fires between EventSource open and the listener registration; (3) call `GET /api/preview/mount?sessionId=<sid>` directly — a `404` means the mount is empty / missing; (4) inspect SSE traffic in DevTools → Network → the `preview-events` request → EventStream tab. See [docs/preview-architecture.md](docs/preview-architecture.md#sse--get-apisessionssidpreview-events).
- **Streaming dedup/reorder** — events carry `seq`+`ts`; `{type:"resume", fromSeq}` on reconnect. See [docs/design/streaming-dedup-reorder.md](docs/design/streaming-dedup-reorder.md).
- **WS overflow guard** — `decideOverflowAction` in `ws-overflow-guard.ts`; transient spike tolerated via deferred re-check.
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`; `seq`-based LRU dedupe.
- **Scroll snaps back / vibration / tail-chat lost** — `AgentInterface` is a vanilla-TS port of [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom) (731⭐, powers bolt.new). Two-flag intent model: `_isAtBottom` (toggleable, default `true`) + `_escapedFromLock` (true ONLY after a user-driven scroll-up that exits the 70 px near-bottom band). Re-pin invariant (`_pinIfSticking`): programmatic re-pin runs only when `_isAtBottom && !_escapedFromLock`. Defenses, in order:
  - **`STICK_TO_BOTTOM_OFFSET_PX = 70`** near-bottom band. `_isNearBottom()` getter dominates: a 30-px scroll-up auto-relocks on the next content growth without requiring a Jump click. WHY: prevents the "tiny reflow lost the tail" class of regressions where a sub-pixel layout shift used to escape the lock permanently.
  - **`_resizeDifference`** set by RO callback, reset via `rAF + setTimeout(1 ms)`. Deferred scroll handler bails when non-zero (resize-vs-scroll disambiguation). WHY: a `scroll` event fired during an in-flight resize is otherwise indistinguishable from a real user scroll — Bug B in the issue analysis.
  - **Synchronous user-intent listeners** on the scroll container — `wheel` + `touchstart` → `_handleUserIntent`, `keydown` (PageUp/Down/ArrowUp/Down/Home/End) → `_handleScrollKeydown`. Each stamps `_lastUserGestureTs = performance.now()`, cancels any in-flight spring, and (for unambiguous up gestures) flips `_isAtBottom = false` synchronously BEFORE the resulting browser scroll event is dispatched. WHY: lets geometry never have to second-guess intent.
  - **Deferred scroll handler** `_handleScroll` → `setTimeout(0)` body — snapshots `(scrollTop, _ignoreScrollToTop, _lastUserGestureTs)` and `_lastScrollTop` synchronously then runs the body in the next macrotask so RO has a chance to set `_resizeDifference` first. Body order: resize-bail → echo-latch → gesture-freshness gate → up/down classify (against `_lastScrollTop`) → near-bottom override → refresh button. Coalesced (only one timer in flight).
  - **`_ignoreScrollToTop` single-value latch** set by `_writeScrollTop()` immediately before any programmatic `scrollTop = …` write, consumed by the deferred handler.
  - **`_lastUserGestureTs` freshness gate** (`USER_GESTURE_WINDOW_MS = 500`) — distinguishes a real user-driven scroll from a programmatic `el.scrollTop = X` issued by another component or test harness. Without the gate, every non-echo scroll event would escape the lock and break tail-chat-jump-button-false-positive.
  - **RO callback** — records `_resizeDifference`, overscroll-clamps `scrollTop > targetScrollTop` (Bug E), on positive growth pins synchronously via `_scrollToBottomNow({ animate: false })` when sticky, on negative shrink relocks `_isAtBottom = true` if near-bottom and not escaped.
  - **Spring `_scrollToBottomNow({ animate: true })`** — used only by the jump-to-bottom click landing (damping 0.7, stiffness 0.05, mass 1.25; upstream defaults; rAF loop until `|delta| < 0.5 && |velocity| < 0.5`, re-reads target each tick so RO growth during the animation moves the goalpost). All other call sites use the synchronous `animate: false` fast path.
  - **Capture-phase `_imageLoadHandler`** on the scroll container — NOT redundant with RO `delta>0`: image/iframe decode + paint can land on the same task as the layout commit BEFORE the next RO microtask tick, causing a single-frame visible drift on Safari/iOS PWA where `overflow-anchor` has limited availability. The RO branch catches it eventually but the load-listener pins synchronously and avoids the intermediate frame.
  - **`overflow-anchor: none`** inline style on `agent-interface .overflow-y-auto` retained — single contract. Chromium ≡ Safari. JS pin path is the only thing keeping the viewport at the tail; nothing here relies on browser scroll-anchoring.
  - **Jump-button visibility** — `!_isAtBottom && (dist > 0.5 × clientHeight)`. Recomputed at every deferred-handler tick (including bail paths) — closes the original Bug A loophole where the echo-path early-return left `_showJumpToBottom = true` stranded at the tail.

  **Do NOT re-add these deleted defenses** — the new algorithm subsumes each one, and re-introducing any of them brings back a race the port specifically eliminated:
  - `_programmaticEchoes` ring buffer (4-entry) — replaced by `_ignoreScrollToTop` single-value latch. Within one task only one programmatic write commits, so the ring was always over-spec. (A no-op `_programmaticEchoes` array shim is preserved for E2E test setup that still `.push()`es to it.)
  - `_lastProgrammaticScrollTop` / `_lastProgrammaticScrollHeight` echo-latch pair — folded into `_ignoreScrollToTop`.
  - `_settleWindowActive` / `_settleWindowDeadline` / `_lastSettleScrollHeight` / `_settleQuietTickCount` — the 2–3 s session-load settle window and its RO re-pin loop. The `_isAtBottom = true` reset on `setupSessionSubscription` plus RO `delta>0` re-pin handle session-navigate cleanly.
  - `_suppressJumpUntilTs` (600 ms post-jump-click window) — jump button is now a pure function of `!_isAtBottom + dist`, recomputed every tick; no need to suppress.
  - `_wasAtBottomAtLastUserScroll` carry-over — the geometry path that needed it (geometry-flip-in-`_handleScroll`) is gone; intent is mutated only by observed user gestures and the near-bottom override.
  - `_isAutoScrolling` timer — predates f8c9dece; never re-added, do not.
  - Triple-rAF chain in `setupSessionSubscription` — replaced by single `updateComplete.then(_pinIfSticking)`.

  See [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](docs/design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port) for the full algorithm walkthrough, design trade-offs, and sensitivity matrix. Backward-compat shims `_stickToBottom` getter/setter and `_programmaticEchoes` array exist for E2E test setup that pokes them directly — production code paths use `_isAtBottom`/`_escapedFromLock` directly.
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag[<tag>_proposal]` flag.
- **Inline-comment annotations on goal/role/staff proposals not appearing / disappearing unexpectedly** — ephemeral backend `proposalBackend` in `src/ui/components/review/proposal-annotations.ts`, keyed by `(sessionId, "proposal:<type>")`. Cleared by the `proposal_update` body-diff hook in `src/app/session-manager.ts` (look for `extractProposalBody` + `clearProposalAnnotations`), by dismiss/`proposal_cleared`, and never persisted across reload. The `commentable: true` flag on `GoalFormConfig` is set ONLY at the goal-proposal-panel call site (`goalPreviewPanel()`), not the goal-dashboard reuse, so dashboard markdown stays read-only.
- **"Send feedback" button missing on a proposal panel** — only renders when annotation count > 0 AND the proposal is not streaming (`isProposalStreaming("<tag>_proposal")` false). Badge has the same gating in Preview mode.
- **"Open proposal" on old card destroys later edits** — check for `__proposal_rev_v1__:<n>` marker; legacy archived sessions intentionally fall back.
- **Proposal panel doesn't update after `edit_proposal`** — check WS `proposal_update` frame and structured error code.
- **"No project selected for this goal" toast in re-attempt assistant** — `goalProposalPanel()` *and* `goalPreviewPanel()` in `src/app/render.ts` both derive `state.previewProjectId` (when empty) from the active session's `projectId` → original goal's `projectId` (via `reattemptGoalId`) → proposal `cwd` matching a registered `project.rootPath`. The + New Goal picker is no longer the only populator; the existing guard remains as a last-line safety net. See [docs/debugging.md — Re-attempt project binding](docs/debugging.md#re-attempt-project-binding).
- **Dismissed proposal reappears after reload** — `goalDraft.restore` / `roleDraft.restore` / `projectDraft.restore` in `src/app/session-manager.ts` must consult `isProposalDismissedTyped` before populating `state.activeProposals.<type>`. Draft is intentionally preserved on disk so future `edit_proposal` or "Open proposal" tool-card clicks can rehydrate cleanly. See [docs/debugging.md — Dismissed proposal restored on reload](docs/debugging.md#dismissed-proposal-restored-on-reload).
- **Stale messages on session navigate / dup messages / out-of-order widgets** — handled by reducer in `src/app/message-reducer.ts`.
- **Continue-Archived button missing** — only renders when archived AND no `goalId` AND no `delegateOf` AND project still registered.
- **Continued session missing earlier transcript** — confirm cloned `.jsonl` at `agentSessionFile` path; worktree-backed sources are rebased onto worktree-cwd slug-dir in `executeWorktreeAsync`.
- **Archived session footer shows wrong model** — archived `auth_ok` branch must push `state` frame via `buildArchivedStateData()`.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`.
- **400 "projectId required"** — fires when a request truly carries no `projectId` and no `cwd` matching a registered project. The two known user-visible 400 paths are now closed: splash-screen "New Session"/"Quick Session" buttons are gated on `state.projects.length` (see Recipe), and system-scope tool-assistants route through `projectId: "system"` (the hidden synthetic project). If you still see this, the request is hand-rolled or a regression — pass `projectId` or `cwd` inside a registered project. See [docs/debugging.md — Multi-project / per-project state](docs/debugging.md#multi-project--per-project-state).
- **Synthetic system project / `projectId: "system"`** — registered at startup in `src/server/server.ts` via `projectRegistry.registerSystemProject(<bobbitStateDir>/system-project)` and marked `hidden: true` so `GET /api/projects` filters it out (it never appears in `state.projects`). Anchored at a dedicated `system-project/` subdir under the global state dir — **must not** collide with any user-project's `stateDir`, otherwise the system context loads the same `goals.json`/`sessions.json` as the colliding user project (the trap that broke qa-seed mid-implementation: a user project rooted at the install dir shared state with the system context). Used as the persistence anchor for system-scope tool-assistant sessions. See [docs/internals.md — Synthetic system project](docs/internals.md#synthetic-system-project).
- **Orphan remote branches** — see [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Bundle-size assertion fails** — check `dist/ui/.vite/manifest.json` exists and ensure `npm run build:ui` ran first; the test reads gzipped sizes directly from `dist/ui/assets/`. Budget (600 kB main / 500 kB per-chunk) is in `tests/bundle-size.test.ts`; the `pdf.worker.min-*.mjs` chunk is whitelisted. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Markdown not rendering in chat / proposal panel** — `<markdown-block>` is lazy-loaded; the consumer must call `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts` in its `connectedCallback()` or first `render()`. Lit upgrades the custom element asynchronously when the chunk lands. Symptom of forgetting: markdown shows as raw text until something else triggers the load.
- **Page chunk fails to load on first navigation** — `lazyPage()` in `src/app/render.ts` returns `loadingPlaceholder()` while `import()` resolves, then caches the module and calls `renderApp()`. If the chunk 404s the placeholder sticks; check Network panel for the failed `dist/ui/assets/<page>-*.js` and the chunk name in the `lazyPage()` call.
- **Proposal panel empty after reload** — `proposal_update` events that arrive before the proposal panel UI binds its handler are buffered in `_bufferedProposalEvents` inside `src/app/remote-agent.ts` (getter/setter on the handler property). If rehydrate-on-attach races ahead of UI wiring and entries are lost, that buffer is the entry point.
- **Image generation failure** — `400` for malformed input, `500 { error }` for provider-side; never `502`/`503`.
- **Header toast vs proposal toast testid collision** — the session-header toast (e.g. "Link copied" from the Copy-link button) uses `showHeaderToast()` / `data-testid="header-toast"`; the proposal-panel toast uses `showProposalToast()` / `data-testid="proposal-toast"`. Two separate state slots and two separate `<div class="review-toast">` instances in `src/app/render.ts` — do NOT collapse them onto a shared testid; E2E selectors in `tests/e2e/ui/copy-session-link.spec.ts` and `tests/e2e/ui/proposal-inline-comments.spec.ts` would alias.
- **`read_session` returns `permission_denied`** — caller and target session belong to different projects. Check `x-bobbit-session-id` header (set automatically by the tool extension) and the two sessions' `projectId`s. Cross-project transcript reads are intentionally blocked; see [Read another session's transcript](#recipes) recipe.
- **Mobile annotation popover doesn't open after tapping "Add comment"** — `_onMobileAddComment` in `src/ui/components/review/ReviewDocument.ts` must set `_popoverReferenceRect` from the current selection range before mounting the bottom-sheet popover; the `updated()` reaction keys off that field. Symptom after the singleton refactor was an empty render because the rect stayed `null`.
- **Tier 2.5 report missing / ffmpeg failed** — set `FFMPEG_PATH` or install ffmpeg; report only emitted when `RECORDSCREEN=1`.
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=` directly.

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

### Line endings

All text files in this repo are stored and checked out with **LF** line endings, pinned via `.gitattributes` (`* text=auto eol=lf`). Windows-native script files (`*.cmd`, `*.bat`, `*.ps1`) are the only exception and are checked out with CRLF. LF everywhere else keeps diffs, hashes, and tooling output identical across Linux, macOS, Windows, and Docker — and avoids spurious "modified" churn when the same file is touched from different platforms.

**Windows contributors:** the Git for Windows installer defaults to `core.autocrlf=true`, which rewrites LF→CRLF on checkout and overrides `.gitattributes`. Symptoms: phantom "modified" entries in `git status` even on a fresh checkout, and "LF will be replaced by CRLF" warnings on `git add`. Disable it once globally:

```bash
git config --global core.autocrlf false
# verify — should print `false` (or nothing)
git config --get core.autocrlf
```

If you already have CRLF in your working tree from a previous checkout, renormalize after fixing the setting:

```bash
git rm --cached -r .
git reset --hard
```

(or simply re-clone). A plain `git checkout -- .` is usually enough if `git status` is clean.

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
- [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md) — single dispatch site, shadow-ledger reconciliation, exactly-once steer
