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

**Run tests before committing.** After any code change, run the project's type-checker and test suite.

**No flaky tests.** Every test failure is a real bug — in the code under test or in the test itself. Do not dismiss intermittent failures; stop, find the root cause, fix it. Infrastructure failures (timeouts, port conflicts, missing deps) are also our job to resolve — fix the infra, adjust timeouts, add retries, or restructure the test until the suite reliably passes.

**Add or update tests** for every new feature or bug fix.

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
- **Symlink-aware project registration** → `detectSymlinkRoot()` + `SymlinkProjectRootError` in `src/server/agent/project-registry.ts`. `register()` takes `acceptCanonical?: boolean` — when the supplied `rootPath` differs from `realpathSync(rootPath)` it throws unless the caller opts in. `POST /api/projects` reads `body.acceptCanonical` and on the throw returns `{ error, code: "symlink_root", rootPath, canonical }` with HTTP 400; the add-project dialog catches this via `SymlinkRootError` from `src/app/api.ts` and shows a confirm modal (`data-testid="symlink-confirm"` / `confirm-use-canonical`) before retrying with `acceptCanonical: true`. `registerProvisional()` and `registerSystemProject()` auto-accept canonical silently — they're assistant-internal callsites with no user prompt. `findByCwd()` canonicalises both sides via `realpathSync` (try/catch fallback to textual on EPERM/ENOENT) before the prefix comparison so a `cwd` reaching the server through a symlink still resolves; `getByPath()` is intentionally NOT canonicalised — it's the duplicate-path guard at registration time. Existing symlinked projects are not migrated. See [docs/internals.md — Symlinked project rootPath handling](docs/internals.md#symlinked-project-rootpath-handling).
- **Modal error-details disclosure** → `src/ui/components/ErrorDetails.ts` is a light-DOM Lit element that renders `{ message, code?, stack? }` as a readable description, muted-monospace code, and a collapsible `<details>` "Show stack trace" disclosure (hidden when `stack` is absent). `showConnectionError(title, message, opts?: { code?, stack? })` in `src/app/dialogs.ts` takes the optional third arg and renders the body via `<error-details>`; existing call sites are unchanged. Audited surfaces are modals only: `showProjectDialog()` symlink confirm, OAuth error step, gateway-URL prompt, `CustomProviderDialog.testError`. **Out of scope:** chat-transcript `ErrorMessage` banner, REST-error toasts, tool-result error renderers — those continue to render as before.
- **Add a WebSocket command** → `ClientMessage` in `ws/protocol.ts`, handle in `ws/handler.ts`, add `RpcBridge` method.
- **Add a UI component** → `src/ui/components/`, export from `src/ui/index.ts`.
- **Add a tool renderer** → `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`. See `ProposalRenderer.ts`.
- **Add a route-level page (lazy-loaded)** → page module under `src/app/`, then add a `lazyPage("<key>", () => import("./<page>.js"), "<exportName>")` branch to `mainArea()` in `src/app/render.ts`. CSS belongs inside the page module so it travels with the chunk. The `lazyPage()` / `lazyPageCall()` / `loadingPlaceholder()` helpers cache the resolved module and call `renderApp()` once the dynamic `import()` resolves. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Add a heavy tool renderer (lazy)** → `registerLazyToolRenderer(name, async () => { const m = await import("./renderers/Foo.js"); return new m.FooRenderer(); })` in `src/ui/tools/index.ts`. The registry shows a card-shaped placeholder (standard `bg-card` wrapper + `renderHeader("inprogress", FileQuestion, toolName)` + a disabled "Loading…" button row) so layout is stable across the lazy boundary. On resolve, `startLoad()` dispatches `TOOL_RENDERER_LOADED_EVENT` (`"bobbit-tool-renderer-loaded"`, `detail: { toolName }`) on `document` — `<tool-message>` and `<tool-group>` listen for it and `requestUpdate()`, so the swap happens even when the parent `renderApp()` short-circuits. On loader rejection the registry installs a `makeLoadFailureRenderer` fallback ("Renderer failed to load — refresh to retry") instead of leaving a spinner forever. Existing lazy entries: `gate_inspect`, `verification_result`, `preview_open`, `extract_document`, `javascript_repl`, `read_session`. Keep light renderers eager (Bash/Read/Write/etc.) — round-trip per-tool feels laggy. See `src/ui/tools/renderer-registry.ts`.
- **Defer a heavy library (lazy load)** → for custom-element side-effect imports, follow `src/ui/lazy/markdown-block.ts` (`ensureMarkdownBlock()`): a one-shot `import("…/MarkdownBlock.js")` called from each consumer's `connectedCallback()` or first `render()`. For value imports (pdfjs-dist, docx-preview), use `await import()` inside the function that needs the module — see `src/ui/utils/attachment-utils.ts`. Lit tolerates async custom-element upgrade, so brief unstyled flash on first encounter is acceptable.
- **Bundle-size budget assertion** → `tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json` to find the entry chunk and asserts ≤ 600 kB gzipped, plus ≤ 500 kB gzipped for any non-worker chunk. Auto-runs in `npm run test:unit`. Run `npm run test:bundle` to build and assert in one shot. Skips cleanly if `dist/ui/assets/` is missing.
- **SW route-chunk pre-cache** → the `bobbitSwVersion` Vite plugin in `vite.config.ts` reads `dist/ui/.vite/manifest.json` at `closeBundle` time and replaces the `/*__BOBBIT_PRECACHE_CHUNKS__*/` marker in `public/sw.js` with the hashed paths of the most-likely-next-route chunks. Requires `build.manifest: true`. Add a chunk to the warm set by extending the manifest lookup in the plugin.
- **Add a tool** → builtin: `defaults/tools/<group>/`. Project override: `.bobbit/config/tools/<group>/`. MCP auto-discovered from `.mcp.json`.
- **MCP meta-tool aggregation / two-level grouping (server → sub-namespace → op)** → single source of truth for parsing is `parseMcpToolName()` in `src/server/mcp/mcp-meta.ts` — strip `mcp__<server>__`, split remainder on the FIRST `__` → `{server, sub?, op}`. Meta-tool generator `generateMcpMetaExtension(server, ops, unavailable?, sub?)` and aggregation maps in `src/server/agent/tool-activation.ts` (`computeEffectiveAllowedTools`, `computeToolPolicies`, `writeMcpProxyExtensions`) are keyed by `(server, sub)`, so a gateway server emitting `mcp__gr__ai-adoption__*` and `mcp__gr__jira__*` produces two meta-tools (`mcp_gr__ai-adoption`, `mcp_gr__jira`). Policy keys: `mcpPolicyKeys(name) → {group, tool}` covers all four name shapes; `mcp__<server>` is the group key, `mcp__<server>__<sub>` (or `mcp__<server>` for flat) is the tool key, tool-key beats group-key. Dispatcher unchanged (`/api/internal/mcp-call` still receives `mcp__<server>__<sub>__<op>`). Tools page (`src/app/tool-manager-page.ts::renderMcpSection`) renders one server header + per-sub-namespace tool row + read-only ops, each with its own policy `<select>` (testids: `mcp-server-policy`, `mcp-tool-policy`). Discovery tool `mcp_describe` (`defaults/tools/mcp/`) routes through `POST /api/internal/mcp-describe`. See [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) and [docs/design/mcp-meta-tool-aggregation.md](docs/design/mcp-meta-tool-aggregation.md).
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
- **Mutate session status / add a session-status reader** → server: `broadcastStatus()` in `src/server/agent/session-status.ts` is the single writer for `session.status` + monotonic `statusVersion` bump + WS broadcast. Never assign `session.status = …` directly outside session-creation init and final `shutdown()` cleanup. A 15s heartbeat timer at the `SessionManager` level (one timer, not per-WS) re-emits the current `session_status` frame WITHOUT bumping `statusVersion` so any client that missed a transition self-heals within ≤15s. Client: `_state.status` on `RemoteAgent` is the canonical field; `isStreaming` / `isArchived` / `isPreparing` are derived getters installed via `Object.defineProperty` in the constructor. `case "session_status"` is the sole writer of `_state.status` (plus `case "state"` on attach and `reset()` on session navigate). Idempotent on `statusVersion <= _lastStatusVersion`; on a gap (`> _lastStatusVersion + 1`) the client applies the frame AND sends `{type:"status_resync"}` to force a fresh baseline. `agent_start` / `agent_end` / `error` are signals only — they fire side effects (beep, favicon badge, `taskStartTime`, `streamingMessage` cleanup, error append) but must NOT write `_state.status`. Why: prevents the legacy two-flag divergence between `_state.isStreaming` (client-local) and `gatewaySessions[i].status` (REST-polled) that produced stuck-Stop-button and duplicate-message bugs. See [docs/design/unify-session-status.md](docs/design/unify-session-status.md).
- **Modify steer / queue dispatch** → single dispatch site is `SessionManager._dispatchSteer()` in `src/server/agent/session-manager.ts`; rows are removed from `promptQueue` *before* `await rpcClient.steer()`, then pushed onto the per-session shadow ledger `inFlightSteerTexts`. Echo cleanup in `_consumeSteerEcho` (text-match splice on `message_end(role:user)`); abort reconciliation in `_reconcileAfterAbort` (re-enqueue ledger entries at front via `enqueueAtFront`). `PromptQueue` has no `dispatched` flag and no `markDispatched`/`removeDispatched`/`resetDispatched` — do not reintroduce them. See [docs/prompt-queue.md — Force-kill recovery flow](docs/prompt-queue.md#abort-and-force-kill-recovery) and [docs/design/steer-subsystem-rewrite.md](docs/design/steer-subsystem-rewrite.md).
- **Continue an archived session** → footer button → `POST /api/sessions/:archivedId/continue`. Lossless: server clones the source `.jsonl`. See [docs/design/lossless-continue-archived.md](docs/design/lossless-continue-archived.md).
- **Re-attempt a goal** → sidebar/dashboard "Re-attempt" button → `POST /api/sessions { reattemptGoalId }` → `buildReattemptContext()`. Visible whenever the goal has no active team and no live (non-terminated) session — works for fresh, shelved, stopped-team, archived, and merged goals. See [docs/internals.md — Goal re-attempt flow](docs/internals.md#goal-re-attempt-flow).
- **Archive a goal (UI)** → trash button is rendered on every unarchived goal in both sidebar (`src/app/render-helpers.ts`) and goal dashboard (`src/app/goal-dashboard.ts`); never disabled. Both call sites funnel through `deleteGoal()` in `src/app/api.ts`, which detects an active team via the `team-lead` session heuristic, adapts the confirm-modal copy ("Stop team and archive goal?" + "Stop & Archive" label when active), and on confirm runs `teardownTeam()` first then `DELETE /api/goals/:id`. Centralising the team-detection + teardown sequencing in `deleteGoal()` keeps both entry points in sync — do not gate the buttons on team state.
- **Server-side read/unread state** → `lastReadAt` on `PersistedSession`; `POST /api/sessions/:id/mark-read`. See [docs/internals.md — Read/unread state](docs/internals.md#readunread-state).
- **Config cascade** → builtin → server → project, for **roles, tools, tool-group-policies, and `system-prompt.md`**. `system-prompt.md` resolves at runtime via `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` (user override at `.bobbit/config/system-prompt.md` wins, else shipped `defaults/system-prompt.md`); the file is no longer scaffolded on startup — users opt in via Settings → General → "Customise system prompt" (`POST /api/system-prompt/customise`). Workflows are project-scoped, not cascaded. See [docs/internals.md — Config cascade](docs/internals.md#config-cascade).
- **Change tool access policy** → `defaults/tool-group-policies.yaml` or `.bobbit/config/tool-group-policies.yaml`. Per-role: role YAML `toolPolicies`. Values: `allow`/`ask`/`never`. `gate_signal` is team-lead-only. **MCP server groups default to `allow`** like every other tool group — `defaults/tool-group-policies.yaml` ships no `mcp__*` denials. Opt out per-server via the user/project YAML or the Tools page; per-role overrides still work (e.g. `defaults/roles/qa-tester.yaml` sets `mcp__playwright: never`). See [docs/internals.md — Tool access policies](docs/internals.md#tool-access-policies).
- **Per-role model / thinking-level override** → role YAML `model: "<provider>/<modelId>"` and `thinkingLevel`. Edit via Model tab in role-manager page. See [docs/design/per-role-model-overrides.md](docs/design/per-role-model-overrides.md).
- **Pin agent model at spawn time / debug duplicate `model_change` events** → `RpcBridgeOptions.initialModel`/`initialThinkingLevel` translate to `--model`/`--thinking` CLI flags via `buildAgentArgs` (`src/server/agent/rpc-bridge.ts`). Resolution: role override → `default.sessionModel` (or `default.reviewModel` for verification sub-sessions) → `undefined` (aigw fallback runs post-spawn). All non-pool spawn paths participate; pool-claim too (the pool only pre-creates worktrees). Post-spawn helpers (`tryAutoSelectModel`, `applyReviewModelOverrides`) pass `skipSetModel: true` when the spawn already pinned, but still run `getState()` read-back — hard-fail-on-mismatch contract preserved via `applyModelString` in `review-model-override.ts`. See [docs/internals.md — Spawn-time model pinning](docs/internals.md#spawn-time-model-pinning).
- **Archived session footer model** → `buildArchivedStateData()` in `src/server/ws/handler.ts` sent on archived `auth_ok` (and reused by `get_state`). Includes model + `imageGenerationModel` so the footer shows the real model on first connect. UI hook: `data-testid="footer-model-id"`. See [docs/internals.md — Archived-session state push on auth](docs/internals.md#archived-session-state-push-on-auth).
- **Change message rendering** → `src/ui/components/Messages.ts` (standard), `message-renderer-registry.ts` (custom).
- **Modify message transcript ordering** → all transcript mutations route through `reduce(state, action)` in `src/app/message-reducer.ts`. Never push directly into `state.messages`. See [docs/design/unified-message-ordering-reducer.md](docs/design/unified-message-ordering-reducer.md).
- **Modify proposal panel streaming UX** → flag in `state.proposalStreamingByTag`; scroll preserved via `reconcileFollowTail` in `src/app/follow-tail.ts`.
- **Sidebar font-size scale (`--sidebar-font-scale`)** → user setting in System Settings → General → Appearance picks one of 5 stops (Smallest 0.85 / Small 0.92 / Default 1.00 / Large 1.10 / Largest 1.22) with a "Reset to Default" link; per-browser persistence via localStorage key `bobbit:sidebar-font-scale`; `applySidebarFontScaleVar(loadSidebarFontScale())` runs at module load in `src/app/state.ts` to avoid FOUC. Both sidebar roots (`data-testid="sidebar-expanded"` in `src/app/sidebar.ts` and the mobile root in `src/app/render.ts::renderMobileLanding`) carry the `sidebar-root` class which sets `font-size: calc(0.75rem * var(--sidebar-font-scale, 1))` (defined in `src/ui/app.css`). All hard-coded sizes inside the sidebar are em-relative inline styles (`0.5em` / `0.6667em` / `0.75em` / `0.8333em` / `0.9167em` / `1.1667em` / `1.3333em`) so they scale off the container; activity dot uses rem-based `calc(0.375rem * var(--sidebar-font-scale, 1))` (= 6 px at Default scale) to avoid em-compounding inside an already-scaled parent. Pure helpers (`SIDEBAR_FONT_SCALE_KEY`, `SIDEBAR_FONT_SCALE_STOPS`, `clampSidebarFontScale`, `loadSidebarFontScale`, `applySidebarFontScaleVar`, `nearestStop`) live in `src/app/sidebar-font-scale.ts`. Setting affects sidebar only — chat transcript, header, footer, modals, and settings page are unchanged. Tests: `tests/sidebar-font-scale.test.ts` (unit) and `tests/e2e/ui/sidebar-font-scale.spec.ts` (E2E with mobile-viewport coverage).
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `src/server/skills/git-status-native.ts`. Pill segments: `~N ↓N ↑N +X -Y <PR icon>` — `+X` (green) / `-Y` (red) are committed-vs-`origin/<primary>` plus uncommitted-vs-HEAD line counts (untracked excluded — `~N` covers them), via `parseShortstat()` over two parallel `git diff --shortstat` calls in Phase B; suppressed on primary or when both are 0. See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).
- **Sidebar text doesn't scale / FOUC on reload / mobile sidebar unchanged** — verify the affected element is inside a `sidebar-root` container (desktop `src/app/sidebar.ts`, mobile `src/app/render.ts::renderMobileLanding`). Tailwind px-based classes like `text-[9px]` don't inherit — they must be converted to em-relative inline styles per the table in `tests/sidebar-font-scale.test.ts` (which also includes a regex guard against duplicate `style=` attributes from manual conversion). Activity dots and other small chrome must use `calc(<rem> * var(--sidebar-font-scale, 1))` (e.g. `0.375rem` = 6 px at Default) to avoid em-compounding inside an already-scaled parent. The em-conversion table for Tailwind px classes lives in the design doc on the goal — `tests/sidebar-font-scale.test.ts` only contains the duplicate-`style=` regex guard plus stop-value, clamp, and load assertions. FOUC means `applySidebarFontScaleVar(loadSidebarFontScale())` isn't running at module load — check `src/app/state.ts`.
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Preview an HTML file with sibling assets** → `preview_open({ html | file, assets?, manifest? })`. Asset inclusion is **explicit opt-in**: bare `file` copies only the entry HTML — sibling CSS/images/scripts must be declared via `assets: ["styles.css", "img/*.png"]` or a `manifest: "preview-manifest.json"` JSON file (`{ "assets": [...] }`, both relative to the entry's dir). Single-segment `*`/`?` globs only (`**`/`[...]`/`{a,b}` rejected). Why: bare-`file` no longer leaks sibling drafts/`.env`/WIP into the served mount, and removing the old 25 MiB BFS cap unblocks real-worktree use. No size cap — the agent declares what it needs. See [docs/preview-architecture.md — Explicit asset opt-in](docs/preview-architecture.md#explicit-asset-opt-in-file-form). Both arguments populate the same per-session content mount at `<stateDir>/preview/<sid>/`, served at `/preview/<sid>/<entry>` with cookie auth. Mount endpoint: `POST /api/preview/mount?sessionId=<sid>` with `{html}` or `{file, assets?, manifest?}` returns `{url, path, entry, mtime, assets?}`. Hot reload via `GET /api/sessions/:id/preview-events` (SSE). Snapshot marker: v3 (`__preview_snapshot_v3__` carrying `{kind:"preview",url,path}`) is constant ~150 B; v1/v2 are read-only legacy in `PreviewRenderer.ts` — v2 reopen will lose siblings under the new contract (acceptable: archived/legacy only). See [docs/preview-architecture.md](docs/preview-architecture.md).
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

- **Session persistence** — `.bobbit/state/sessions.json`; missing `.jsonl` skips restore. See [debugging.md#session-persistence](docs/debugging.md#session-persistence).
- **`system-prompt.md` customisation not taking effect** — `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts`. See [debugging.md#system-promptmd-not-customised](docs/debugging.md#system-promptmd-not-customised).
- **`lastActivity` reads "just now" after restart** — `isUserVisibleActivity` filter in `session-manager.ts`. See [debugging.md#lastactivity-reads-just-now-after-restart](docs/debugging.md#lastactivity-reads-just-now-after-restart).
- **Sandbox status / project container** — `GET /api/sandbox-status`; label `bobbit-project=<projectId>`. See [debugging.md#sandbox-sessions](docs/debugging.md#sandbox-sessions).
- **Stop button stuck visible while sprite is idle / duplicate user message on second send** — symptom of the legacy two-flag divergence between `_state.isStreaming` and `gatewaySessions[i].status`. Fixed by the canonical-status refactor: divergence is now structurally impossible because `isStreaming` is a derived getter over `_state.status`, and `_state.status` is healed within ≤15s by the server-side heartbeat (`broadcastStatus`-shaped frame re-emitted WITHOUT bumping `statusVersion`). If you see this regression, check that no new code path writes `_state.status` outside `case "session_status"` / `case "state"` / `reset()` on the client, and that no server site writes `session.status` outside `broadcastStatus()` in `src/server/agent/session-status.ts`. See [docs/design/unify-session-status.md](docs/design/unify-session-status.md) and `tests/e2e/ui/session-status-recovery.spec.ts`.
- **Stuck gate verification** — `POST /api/goals/:id/gates/:gateId/cancel-verification`. See [debugging.md#gates](docs/debugging.md#gates).
- **Worktree setup not running** — single source of truth `runComponentSetups()` in `src/server/skills/worktree-setup.ts`. See [debugging.md#worktree-setup-hook-not-running](docs/debugging.md#worktree-setup-hook-not-running).
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
- **Stale messages / dups / out-of-order widgets on session navigate** — reducer in `src/app/message-reducer.ts`. See [debugging.md#stale-messages-trailing-after-newer-ones-on-session-navigate](docs/debugging.md#stale-messages-trailing-after-newer-ones-on-session-navigate).
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
- **OAuth callback never completes** — poll `GET /api/oauth/flow-status?flowId=&provider=` directly. See [debugging.md#oauth-callback-never-completes](docs/debugging.md#oauth-callback-never-completes).

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
