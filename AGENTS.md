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
- **Assert tail-chat / scroll-pin behaviour in an E2E test** → import `expectLatestMessagePinned` and `disableScrollAnchoring` from `tests/e2e/ui/tail-chat-helpers.ts`. Outcome-only — reads `getBoundingClientRect()` of the latest message vs the scroll container; never asserts on `_stickToBottom` / `_programmaticEchoes` or any private field. Always call `disableScrollAnchoring(page)` first so Chromium ≡ Safari and the JS pin path is the single contract under test. Pattern reference: `tests/e2e/ui/tail-chat-real-stream.spec.ts`. See [docs/design/tail-chat-redesign.md — Outcome of the redesign](docs/design/tail-chat-redesign.md#outcome-of-the-redesign).
- **Add a REST endpoint** → `handleApiRoute()` in `src/server/server.ts`. See [docs/rest-api.md](docs/rest-api.md).
- **Add a project** → `POST /api/projects` or sidebar "Add Project". Key: `src/server/agent/project-registry.ts`, `project-context-manager.ts`. The project assistant designs all workflows — server seeds none. See [docs/internals.md — Project assistant](docs/internals.md#project-assistant).
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
- **Add a blocking tool** → harness parks Promise keyed by `(sessionId, toolUseId)`. See [docs/blocking-tools.md](docs/blocking-tools.md). (`ask_user_choices` is non-blocking — see [docs/non-blocking-ask.md](docs/non-blocking-ask.md).)
- **Add a slash skill** → `SKILL.md` in `.claude/skills/<name>/` with YAML frontmatter. Discovered skills auto-exposed for autonomous activation via `activate_skill`. Skills support `references/`, `scripts/`, `assets/` subdirs (Level-3 progressive disclosure). See [docs/design/skill-ux-and-autonomous-activation.md](docs/design/skill-ux-and-autonomous-activation.md).
- **Modify slash-skill expansion / chip rendering** → `src/server/skills/resolve-skill-expansions.ts`, `skill-sidecar.ts`, `src/ui/components/SkillChip.ts`.
- **Add an IndexSource** → implement `IndexSource` from `src/server/search/types.ts`. See [docs/design/portable-search.md](docs/design/portable-search.md).
- **Add a goal feature** → `goal-manager.ts` / `goal-store.ts`, REST in `server.ts`, assistant in `goal-assistant.ts`. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Inter-agent git handoff** → tasks carry `baseSha`, `headSha`, `branch`. See [docs/goals-workflows-tasks.md — Git handoff](docs/goals-workflows-tasks.md#git-handoff-fields).
- **Modify a store constructor** → stores take `stateDir`/`configDir` params; never module-level globals. All resolution via `ProjectContextManager` (`src/server/agent/project-context-manager.ts`).
- **Add/modify session creation** → `session-setup.ts`, wrappers in `session-manager.ts`. See [docs/internals.md — Session worktrees](docs/internals.md#session-worktrees).
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
- **Git-status widget** → `src/ui/components/GitStatusWidget.ts`, `src/server/skills/git-status-native.ts`. See [docs/design/git-status-widget-reliability.md](docs/design/git-status-widget-reliability.md).
- **Large content truncation** → `truncate-large-content.ts` (>32KB). Lazy-load via `GET /api/sessions/:id/tool-content/:mi/:bi`.
- **Preview an HTML file with sibling assets** → `preview_open({ file })`. Server: `GET /api/preview/render` + `/api/preview/asset` (path-traversal-guarded via `src/server/preview/path-guard.ts`, 25 MiB asset cap). UI iframe uses `src=` (file mode) or `srcdoc=` (inline). Snapshot marker: v2 carries only `{kind, path}` (~250 B); v1 unchanged for backward compat. Sandboxed agents translate via `BOBBIT_HOST_CWD`, falling back to inline on 400. See [docs/preview-file-mode.md](docs/preview-file-mode.md).
- **Modify sandbox behavior** → `sandbox: "docker"` in `project.yaml`. Key: `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`. See [docs/internals.md — Docker sandbox](docs/internals.md#docker-sandbox).
- **Add a multi-repo project / components / inline workflows** → components in `project.yaml::components[]`, workflows inline in `project.yaml::workflows`. See [docs/internals.md — Multi-repo & components](docs/internals.md#multi-repo--components) and [`defaults/workflow-authoring-guide.md`](defaults/workflow-authoring-guide.md).
- **Cleanup remote branches on archive** → `deleteRemoteGoalBranches` in `server.ts` (goals); `session-eager-branch-delete.ts` (sessions). See [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Per-project settings** → Settings → project tab. REST: `GET/PUT /api/projects/:id/config`. See [docs/internals.md — Per-project config](docs/internals.md#per-project-config).
- **Mid-session project-config edits** → any agent may call `propose_project` against the registered project; user accepts via `PUT /api/projects/:id/config`. See [docs/design/mid-session-project-proposals.md](docs/design/mid-session-project-proposals.md).
- **PWA resume / iOS bootstrap perf** → diagnostics-first. User Timing wrapper in `src/app/perf.ts` (opt-in via `?perf=1` or `localStorage.bobbit-perf=1`; `window.__bobbitPerf.dump()` for digest); marks live in `src/app/main.ts`, `src/app/remote-agent.ts`, `src/app/session-manager.ts`. Currently shipped: B1 — WebSocket pre-warm for `/session/:id` route (`state.preWarmedAgent` constructed in `initApp` before `waitForGateway`, consumed by `connectToSession` if the sessionId matches); C1 — OPEN-but-dead WS detector (`_lastInboundFrameAt` + 3 s timer on visibility wake; force-close + reconnect if no inbound frame); A2 — `/api/preferences` fire-and-forget after auth; D1 — `mark("messages:applied")` after snapshot reducer apply; D2 — `markPaint("session:first-paint")` per session select. **Intentionally absent** (reverted PR #450 stack — do NOT reintroduce without diagnostic justification): persisted UI snapshot, inline CSS skeleton, `__bobbitPrepaint` inline bootstrap, render watchdog, heartbeat-gap bypass, `pageshow` force-close. E2E: `tests/e2e/ui/pwa-resume-v2.spec.ts`. See [docs/design/pwa-resume-v2-diagnostics.md](docs/design/pwa-resume-v2-diagnostics.md) and [docs/design/pwa-resume-v2-hotpath-analysis.md](docs/design/pwa-resume-v2-hotpath-analysis.md).
- **Edit a proposal mid-session** → `view_proposal(type)` / `edit_proposal(type, old_text, new_text)`. Each successful write also writes a per-rev snapshot under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/`. See [docs/design/editable-proposals.md](docs/design/editable-proposals.md), [docs/design/proposal-revision-snapshots.md](docs/design/proposal-revision-snapshots.md).
- **Dismiss/restore invariant for proposal panels** → `goalDraft.restore` / `roleDraft.restore` / `projectDraft.restore` in `src/app/session-manager.ts` gate slot rehydration on `isProposalDismissedTyped`. Dismiss does NOT delete the on-disk draft — it preserves form-mirror state and lets `edit_proposal` / "Open proposal" rehydrate cleanly. Only `goal`/`role`/`project` have draft persistence; `staff`/`tool`/`workflow` slots are transient.
- **Add QA testing** → set `qa_start_command` (and friends) on the relevant component's `config:` map in `project.yaml`. See [docs/qa-testing.md](docs/qa-testing.md).
- **Add a verification reminder site** → see `src/server/agent/verification-harness.ts`. After dispatching the reminder, await `SessionManager.waitForStreaming(sessionId, 10_000).catch(() => {})` before racing `waitForIdle`.
- **Create a design mockup** → `/mockup` skill (canonical body lives at `defaults/docs/design-mockups.md`; resolved by the skill itself).
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
- **Auto-nudge flooding** — `nudgePending` guard in TeamManager.
- **Reviewer session triggers spurious team-lead nudge** — `kind: "reviewer"` filter in `resubscribeTeamEvents()` and `notifyTeamLead()`.
- **Duplicate `model_change` event at session startup** — confirm spawn site routes through `resolveBridgeOptions` and post-spawn helper passes `skipSetModel: true` when `session.spawnPinnedModel` matches. The aigw cold-cache fallback legitimately emits two; pool-claim is NOT in that bucket. See [docs/debugging.md — Duplicate `model_change` event at session startup](docs/debugging.md#duplicate-model_change-event-at-session-startup).
- **Archived session footer shows `claude-opus-4-6` placeholder** — server failed to push `state` frame on archived `auth_ok`. Fix is `buildArchivedStateData` called after `session_title`. See [docs/debugging.md — Archived session footer shows placeholder model](docs/debugging.md#archived-session-footer-shows-placeholder-model).
- **Resumed reviewer terminated ~46ms after restart** — await `waitForStreaming` before `waitForIdle` race.
- **`x-opencode-session` header missing or shared** — `writeAigwModelsJson` / `BOBBIT_SESSION_ID` env.
- **`models.json` stale after gateway upgrade** — `startupAigwCheck` rewrites on next gateway start.
- **Review/naming models under AI Gateway** — `applyReviewModelOverrides`; failures throw (no silent fallback).
- **Live-steer lost after Stop** — must route via `SessionManager.deliverLiveSteer()`.
- **Session wedged after errored turn** — implicit unstick clears `lastTurnErrored`; capped at `MAX_CONSECUTIVE_ERROR_TURNS = 3`.
- **`bash_bg wait` not interrupted by steer** — `BgProcessManager.waits` registry, `abortAllWaits()`.
- **Large file writes freezing** — `truncateLargeToolContent()` at >32KB; check `.jsonl` exists.
- **Preview Open button broken** — `tool_result` must include either a `__preview_snapshot_v1__` (inline HTML) or `__preview_snapshot_v2__` (file-mode JSON `{kind:"file",path}`) marker block. For v2, a `404` from `POST /api/preview` means the file is gone — `PreviewRenderer.ts` shows "File no longer available" and disables Open. See [docs/preview-file-mode.md](docs/preview-file-mode.md).
- **Preview iframe shows broken images / 404 on assets** — file mode only. Diagnostic order: (1) confirm meta sidecar `<stateDir>/preview-<sid>.meta.json` exists with `kind:"file"` + `baseDir` + `entry`; (2) confirm `baseDir` is host-visible (sandboxed agents translate via `BOBBIT_HOST_CWD`; missing or out-of-mount paths fall back to inline mode); (3) check path-traversal rejection in `src/server/preview/path-guard.ts`; (4) check 25 MiB asset cap (`413`). See [docs/preview-file-mode.md](docs/preview-file-mode.md).
- **Streaming dedup/reorder** — events carry `seq`+`ts`; `{type:"resume", fromSeq}` on reconnect. See [docs/design/streaming-dedup-reorder.md](docs/design/streaming-dedup-reorder.md).
- **White screen / multi-second loading screen on iOS PWA resume** — diagnostics-first. Enable instrumentation with `?perf=1` (or `localStorage.bobbit-perf=1`) and call `window.__bobbitPerf.dump()` at the Safari Web Inspector console; the digest breaks down `pageshow` → `main:module` → `init:first-paint` → `ws:prewarm-start` → `messages:applied` → `session:first-paint`. Then check whether B1's pre-warm fired (`ws:prewarm-start` mark present and `state.preWarmedAgent` consumed in `connectToSession`) and whether C1's OPEN-but-dead detector force-closed a wedged socket (`_lastInboundFrameAt` stale > 3 s on visibility wake in `src/app/remote-agent.ts`). The previous stack's defenses (persisted UI snapshot, inline skeleton, `__bobbitPrepaint`, render watchdog, heartbeat-gap bypass, `pageshow` force-close) are intentionally absent — reintroducing any of them requires diagnostic justification per [docs/design/pwa-resume-v2-diagnostics.md](docs/design/pwa-resume-v2-diagnostics.md). Hot-path map: [docs/design/pwa-resume-v2-hotpath-analysis.md](docs/design/pwa-resume-v2-hotpath-analysis.md).
- **WS overflow guard** — `decideOverflowAction` in `ws-overflow-guard.ts`; transient spike tolerated via deferred re-check.
- **Verification log Nx duplication** — funnel through `src/app/verification-event-bus.ts`; `seq`-based LRU dedupe.
- **Scroll snaps back / vibration / tail-chat lost** — `AgentInterface` uses a single `_stickToBottom` flag (flipped false only by user gestures — `wheel`/`touchstart`/`keydown`; flipped true only at programmatic restore points), a programmatic-scroll echo ring buffer (`_programmaticEchoes`, capacity 4), and exactly one re-pin path (`_pinIfSticking`). Geometry never mutates the flag — `_handleScroll` only consumes echoes and recomputes jump-button visibility. The chat scroll container has inline `overflow-anchor: none` on `agent-interface .overflow-y-auto` so Chromium ≡ Safari (Safari has no CSS scroll-anchoring) and the JS pin path is the single contract — any regression must surface on both engines. **Deleted defenses (do NOT re-add):** settle window (`_settleWindowActive` et al.), `_wasAtBottomAtLastUserScroll` carry-over, 600 ms `_suppressJumpUntilTs`, triple-rAF chain in `setupSessionSubscription`, geometry-based intent flip in `_handleScroll`, 10 %/10 px stick-grace band, inner rAF re-assert in `_scrollToBottom`, and `_imageLoadHandler` (the capture-phase `load` listener — redundant with the always-on RO `delta>0` re-pin, which catches the same image/iframe-decode reflows the load-listener was added for). Each was masking a race introduced by an earlier layer; reaching for one means the bug is elsewhere. See [docs/internals.md — Chat scroll lock invariant](docs/internals.md#chat-scroll-lock-invariant).
- **Proposal panel button enabled mid-stream** — `state.proposalStreamingByTag[<tag>_proposal]` flag.
- **"Open proposal" on old card destroys later edits** — check for `__proposal_rev_v1__:<n>` marker; legacy archived sessions intentionally fall back.
- **Proposal panel doesn't update after `edit_proposal`** — check WS `proposal_update` frame and structured error code.
- **"No project selected for this goal" toast in re-attempt assistant** — `goalProposalPanel()` *and* `goalPreviewPanel()` in `src/app/render.ts` both derive `state.previewProjectId` (when empty) from the active session's `projectId` → original goal's `projectId` (via `reattemptGoalId`) → proposal `cwd` matching a registered `project.rootPath`. The + New Goal picker is no longer the only populator; the existing guard remains as a last-line safety net. See [docs/debugging.md — Re-attempt project binding](docs/debugging.md#re-attempt-project-binding).
- **Dismissed proposal reappears after reload** — `goalDraft.restore` / `roleDraft.restore` / `projectDraft.restore` in `src/app/session-manager.ts` must consult `isProposalDismissedTyped` before populating `state.activeProposals.<type>`. Draft is intentionally preserved on disk so future `edit_proposal` or "Open proposal" tool-card clicks can rehydrate cleanly. See [docs/debugging.md — Dismissed proposal restored on reload](docs/debugging.md#dismissed-proposal-restored-on-reload).
- **Stale messages on session navigate / dup messages / out-of-order widgets** — handled by reducer in `src/app/message-reducer.ts`.
- **Continue-Archived button missing** — only renders when archived AND no `goalId` AND no `delegateOf` AND project still registered.
- **Continued session missing earlier transcript** — confirm cloned `.jsonl` at `agentSessionFile` path; worktree-backed sources are rebased onto worktree-cwd slug-dir in `executeWorktreeAsync`.
- **Archived session footer shows wrong model** — archived `auth_ok` branch must push `state` frame via `buildArchivedStateData()`.
- **Stale draft resurrection** — `SessionStore.setDraft()` rejects older `gen`.
- **400 "projectId required"** — pass `projectId` or `cwd` inside a registered project.
- **Orphan remote branches** — see [docs/design/orphan-remote-branch-cleanup.md](docs/design/orphan-remote-branch-cleanup.md).
- **Bundle-size assertion fails** — check `dist/ui/.vite/manifest.json` exists and ensure `npm run build:ui` ran first; the test reads gzipped sizes directly from `dist/ui/assets/`. Budget (600 kB main / 500 kB per-chunk) is in `tests/bundle-size.test.ts`; the `pdf.worker.min-*.mjs` chunk is whitelisted. See [docs/design/ui-bundle-size-reduction.md](docs/design/ui-bundle-size-reduction.md).
- **Markdown not rendering in chat / proposal panel** — `<markdown-block>` is lazy-loaded; the consumer must call `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts` in its `connectedCallback()` or first `render()`. Lit upgrades the custom element asynchronously when the chunk lands. Symptom of forgetting: markdown shows as raw text until something else triggers the load.
- **Page chunk fails to load on first navigation** — `lazyPage()` in `src/app/render.ts` returns `loadingPlaceholder()` while `import()` resolves, then caches the module and calls `renderApp()`. If the chunk 404s the placeholder sticks; check Network panel for the failed `dist/ui/assets/<page>-*.js` and the chunk name in the `lazyPage()` call.
- **Proposal panel empty after reload** — `proposal_update` events that arrive before the proposal panel UI binds its handler are buffered in `_bufferedProposalEvents` inside `src/app/remote-agent.ts` (getter/setter on the handler property). If rehydrate-on-attach races ahead of UI wiring and entries are lost, that buffer is the entry point.
- **Image generation failure** — `400` for malformed input, `500 { error }` for provider-side; never `502`/`503`.
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
