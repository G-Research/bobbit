# Bobbit — Agent Guide

## What is this?

A remote gateway for AI coding agents. Wraps pi-coding-agent in a WebSocket server with a browser-based chat UI. The user runs `bobbit` on a dev machine and interacts with the agent from any browser.

For architecture details, REST API, WebSocket protocol, and feature documentation, see [README.md](README.md).

## Repo layout

```
src/
├── server/          # Node.js gateway (HTTP + WebSocket + child process management)
│   ├── cli.ts       # Entry point, arg parsing, NordLynx detection, TLS setup, system prompt resolution
│   ├── server.ts    # HTTP server, REST API, static serving, WS upgrade
│   ├── harness.ts   # Dev server wrapper (watches sentinel file, auto-restarts)
│   ├── harness-signal.ts  # Touches sentinel to trigger harness restart
│   ├── index.ts     # Server barrel export
│   ├── bobbit-dir.ts # Resolves .bobbit/ directory paths (config, state, global auth)
│   ├── scaffold.ts  # First-run scaffolding — creates .bobbit/ with defaults
│   ├── pi-dir.ts    # @deprecated — use bobbit-dir.ts instead
│   ├── watchdog.ts  # Process health watchdog
│   ├── defaults/    # Bundled default templates (roles, workflows, personalities, system-prompt)
│   ├── agent/       # Session lifecycle, RPC bridge, persistence, goals, teams, title generation
│   │   ├── assistant-registry.ts       # Registry of assistant types (goal, role, tool)
│   │   ├── bg-process-manager.ts       # Background process lifecycle management
│   │   ├── color-store.ts              # Per-session color index persistence (.bobbit/state/session-colors.json)
│   │   ├── cost-tracker.ts             # Per-session token/cost tracking
│   │   ├── event-buffer.ts             # Circular buffer for tool_execution_update replay on reconnect
│   │   ├── gate-store.ts                # Gate state and signal history (.bobbit/state/gates.json)
│   │   ├── goal-assistant.ts           # System prompt for the goal creation assistant
│   │   ├── goal-manager.ts             # Goal CRUD operations
│   │   ├── goal-store.ts               # Disk persistence (.bobbit/state/goals.json)
│   │   ├── name-generator.ts           # Random name generator for team agents
│   │   ├── personality-assistant.ts    # System prompt for personality assistant
│   │   ├── prompt-queue.ts             # Server-side prompt queue with priority sorting
│   │   ├── role-assistant.ts           # System prompt for role assistant
│   │   ├── role-manager.ts             # Role definitions, tool access, and management
│   │   ├── role-store.ts               # Role persistence (YAML files in roles/)
│   │   ├── rpc-bridge.ts               # JSONL stdin/stdout bridge to agent subprocess
│   │   ├── session-manager.ts          # Create/destroy/restore sessions, broadcast events, force abort
│   │   ├── session-store.ts            # Disk persistence (.bobbit/state/sessions.json)
│   │   ├── staff-assistant.ts          # System prompt for staff agent assistant
│   │   ├── staff-manager.ts            # Staff agent lifecycle management
│   │   ├── staff-store.ts              # Staff agent persistence (.bobbit/state/staff.json)
│   │   ├── staff-trigger-engine.ts     # Staff agent trigger evaluation engine
│   │   ├── system-prompt.ts            # Assemble system prompt from global + AGENTS.md + goal spec
│   │   ├── task-manager.ts             # Task CRUD and state transitions
│   │   ├── task-store.ts               # Disk persistence (.bobbit/state/tasks.json)
│   │   ├── team-manager.ts             # Team lifecycle (spawn/dismiss agents, start/complete/teardown)
│   │   ├── team-names.ts               # Themed name lists for team agents
│   │   ├── team-store.ts               # Disk persistence (.bobbit/state/team-state.json)
│   │   ├── title-generator.ts          # Auto-generate session titles via Claude Haiku
│   │   ├── tool-activation.ts          # Tool activation/deactivation logic
│   │   ├── tool-assistant.ts           # System prompt for tool management assistant
│   │   ├── tool-manager.ts             # Tool CRUD with renderer discovery
│   │   ├── tool-manager.ts              # Tool CRUD, YAML scanning from tools/<group>/*.yaml
│   │   ├── personality-manager.ts       # Personality definitions and management
│   │   ├── personality-store.ts        # Personality persistence (YAML files in personalities/)
│   │   ├── verification-harness.ts     # Async gate verification (command + LLM review)
│   │   ├── workflow-manager.ts         # Workflow CRUD, DAG validation, cloning
│   │   └── workflow-store.ts           # Workflow persistence (YAML files in workflows/)
│   ├── auth/        # Token auth, rate limiting, TLS, OAuth, DNS
│   │   ├── desec.ts       # deSEC dynamic DNS updates on startup
│   │   ├── oauth.ts       # OAuth flow (start, complete, status)
│   │   ├── rate-limit.ts  # IP-based rate limiting for auth failures
│   │   ├── tls.ts         # Self-signed TLS certificate generation (.bobbit/state/tls/)
│   │   └── token.ts       # Load/create/validate auth tokens (.bobbit/state/token)
│   ├── ws/          # WebSocket protocol types and message handler
│   │   ├── protocol.ts   # ClientMessage / ServerMessage type unions
│   │   └── handler.ts    # Auth handshake, command routing, skill dispatch
│   └── skills/      # Reusable skill definitions with isolated sub-agent execution
│       ├── types.ts           # Skill interface
│       ├── registry.ts        # In-memory skill definition registry
│       ├── sub-agent.ts       # Spawn isolated agent subprocesses for skill execution
│       ├── git.ts             # Git worktree helpers
│       ├── definitions-sync.ts  # Export definitions to .bobbit/state/skill-definitions.json
│       ├── index.ts           # Barrel export + auto-registration of built-in skills
│       └── definitions/       # Built-in skill templates
│           ├── code-review.ts       # Correctness, security, and design review skills
│           └── test-suite-report.ts # Test suite analysis skill
├── ui/              # Lit web components (forked from pi-web-ui, NOT an npm dep)
│   ├── ChatPanel.ts # Top-level UI orchestrator
│   ├── app.css      # Global application styles
│   ├── index.ts     # UI barrel export
│   ├── speech-recognition.d.ts  # Web Speech API type declarations
│   ├── components/  # MessageList, StreamingMessageContainer, AgentInterface, etc.
│   │   ├── AgentInterface.ts              # Bridges agent events to UI state
│   │   ├── AttachmentTile.ts              # File attachment preview tile
│   │   ├── BgProcessPill.ts              # Background process status pill
│   │   ├── ConsoleBlock.ts                # Console output display block
│   │   ├── CustomProviderCard.ts          # Custom AI provider card
│   │   ├── DiffBlock.ts                   # Diff visualization component
│   │   ├── ErrorMessage.ts                # Error display component
│   │   ├── ExpandableSection.ts           # Collapsible content section
│   │   ├── GitStatusWidget.ts             # Git status display widget
│   │   ├── Input.ts                       # Chat input with attachments
│   │   ├── LiveTimer.ts                   # Live elapsed-time timer
│   │   ├── MessageEditor.ts               # Inline message editing
│   │   ├── MessageList.ts                 # Renders state.messages (completed messages)
│   │   ├── Messages.ts                    # User, Assistant, Tool message renderers
│   │   ├── ProviderKeyInput.ts            # API key input field
│   │   ├── SandboxedIframe.ts             # Sandboxed iframe container
│   │   ├── StreamingMessageContainer.ts   # Renders state.streamMessage (in-progress)
│   │   ├── ThinkingBlock.ts               # AI thinking/reasoning display
│   │   ├── ToolGroup.ts                   # Groups related tool calls
│   │   ├── message-renderer-registry.ts   # Custom message type renderers
│   │   └── sandbox/                       # Sandboxed iframe runtime providers
│   │       ├── ArtifactsRuntimeProvider.ts    # Artifact rendering in sandbox
│   │       ├── AttachmentsRuntimeProvider.ts  # Attachment handling in sandbox
│   │       ├── ConsoleRuntimeProvider.ts      # Console capture in sandbox
│   │       ├── FileDownloadRuntimeProvider.ts # File download from sandbox
│   │       ├── RuntimeMessageBridge.ts        # Parent-iframe message bridge
│   │       ├── RuntimeMessageRouter.ts        # Routes messages between providers
│   │       └── SandboxRuntimeProvider.ts      # Base sandbox runtime provider
│   ├── dialogs/     # ModelSelector, Settings, Sessions, AttachmentOverlay
│   │   ├── ApiKeyPromptDialog.ts      # API key entry dialog
│   │   ├── AttachmentOverlay.ts       # Full-screen attachment viewer
│   │   ├── CustomProviderDialog.ts    # Custom provider configuration
│   │   ├── ModelSelector.ts           # AI model selection dropdown
│   │   ├── PersistentStorageDialog.ts # Storage permission dialog
│   │   ├── ProvidersModelsTab.ts      # Provider/model settings tab
│   │   ├── SessionListDialog.ts       # Session list/management dialog
│   │   └── SettingsDialog.ts          # App settings dialog
│   ├── prompts/
│   │   └── prompts.ts    # Default prompt templates
│   ├── tools/       # Tool call renderers
│   │   ├── extract-document.ts    # Document text extraction
│   │   ├── index.ts               # Tool renderer registration
│   │   ├── javascript-repl.ts     # JavaScript REPL support
│   │   ├── renderer-registry.ts   # Tool name → renderer mapping
│   │   ├── types.ts               # Tool renderer type definitions
│   │   ├── renderers/             # Per-tool renderers
│   │   │   ├── BashRenderer.ts            # Shell command renderer
│   │   │   ├── BgProcessRenderer.ts       # Background process tool renderer
│   │   │   ├── BrowserClickRenderer.ts    # Browser click tool renderer
│   │   │   ├── BrowserEvalRenderer.ts     # Browser eval tool renderer
│   │   │   ├── BrowserNavigateRenderer.ts # Browser navigate tool renderer
│   │   │   ├── BrowserTypeRenderer.ts     # Browser type tool renderer
│   │   │   ├── BrowserWaitRenderer.ts     # Browser wait tool renderer
│   │   │   ├── CalculateRenderer.ts       # Calculator tool renderer
│   │   │   ├── DefaultRenderer.ts         # Fallback tool renderer
│   │   │   ├── DelegateRenderer.ts        # Delegate/sub-agent renderer
│   │   │   ├── EditRenderer.ts            # File edit renderer with diff
│   │   │   ├── FindRenderer.ts            # File find renderer
│   │   │   ├── GetCurrentTimeRenderer.ts  # Time tool renderer
│   │   │   ├── GrepRenderer.ts            # Grep results renderer
│   │   │   ├── HtmlRenderer.ts            # HTML preview renderer
│   │   │   ├── LsRenderer.ts             # Directory listing renderer
│   │   │   ├── PersonalityToolRenderers.ts # Personality management tool renderers
│   │   │   ├── ReadRenderer.ts            # File read renderer
│   │   │   ├── ScreenshotRenderer.ts      # Screenshot display renderer
│   │   │   ├── SvgRenderer.ts             # SVG preview renderer
│   │   │   ├── TaskToolRenderers.ts       # Task management tool renderers
│   │   │   ├── TeamToolRenderers.ts       # Team management tool renderers
│   │   │   ├── WebFetchRenderer.ts        # Web fetch results renderer
│   │   │   ├── WebSearchRenderer.ts       # Web search results renderer
│   │   │   ├── WriteRenderer.ts           # File write renderer
│   │   │   ├── delegate-cards.ts          # Delegate status card components
│   │   │   └── image-utils.ts             # Image processing utilities
│   │   └── artifacts/             # Artifact display components
│   │       ├── ArtifactElement.ts         # Base artifact element
│   │       ├── ArtifactPill.ts            # Compact artifact indicator
│   │       ├── Console.ts                 # Console artifact display
│   │       ├── DocxArtifact.ts            # Word document artifact
│   │       ├── ExcelArtifact.ts           # Excel spreadsheet artifact
│   │       ├── GenericArtifact.ts         # Generic file artifact
│   │       ├── HtmlArtifact.ts            # HTML artifact with live preview
│   │       ├── ImageArtifact.ts           # Image artifact display
│   │       ├── MarkdownArtifact.ts        # Markdown artifact renderer
│   │       ├── PdfArtifact.ts             # PDF document artifact
│   │       ├── SvgArtifact.ts             # SVG artifact display
│   │       ├── TextArtifact.ts            # Plain text artifact
│   │       ├── artifacts-tool-renderer.ts # Artifact tool integration
│   │       ├── artifacts.ts               # Artifact type definitions
│   │       └── index.ts                   # Artifact exports
│   ├── storage/     # IndexedDB persistence (settings, provider keys, sessions)
│   │   ├── app-storage.ts                       # App-level storage manager
│   │   ├── store.ts                             # Generic store base class
│   │   ├── types.ts                             # Storage type definitions
│   │   ├── backends/
│   │   │   └── indexeddb-storage-backend.ts      # IndexedDB storage backend
│   │   └── stores/
│   │       ├── command-history-store.ts          # Command history persistence
│   │       ├── custom-providers-store.ts         # Custom AI provider persistence
│   │       ├── goal-draft-store.ts              # Goal draft persistence
│   │       ├── provider-keys-store.ts           # API key persistence
│   │       ├── role-draft-store.ts              # Role draft persistence
│   │       ├── sessions-store.ts                # Session metadata persistence
│   │       ├── personality-draft-store.ts        # Personality draft persistence
│   │       └── settings-store.ts                # App settings persistence
│   └── utils/       # Formatting, auth token, model discovery, i18n
│       ├── ansi.ts              # ANSI escape code processing
│       ├── attachment-utils.ts  # File attachment helpers
│       ├── auth-token.ts        # Auth token management
│       ├── format.ts            # Text formatting utilities
│       ├── i18n.ts              # Internationalization helpers
│       ├── model-discovery.ts   # AI model discovery and listing
│       ├── proxy-utils.ts       # Proxy configuration helpers
│       └── test-sessions.ts     # Test session utilities
├── app/             # Browser entry point (connects to gateway)
│   ├── api.ts                   # REST API client helpers
│   ├── app.css                  # Global app styles
│   ├── custom-messages.ts       # Custom message type definitions
│   ├── cwd-combobox.ts          # Working directory combobox component
│   ├── dialogs.ts               # App-level dialog helpers
│   ├── goal-dashboard.css       # Goal dashboard styles
│   ├── goal-dashboard.ts        # Goal dashboard page
│   ├── main.ts                  # Bootstrap, routing, session sidebar, QR code, OAuth
│   ├── mobile-header.ts         # Mobile responsive header
│   ├── oauth.ts                 # Browser-side OAuth flow
│   ├── preview-panel.ts         # Live preview panel (split-pane HTML preview)
│   ├── proposal-parsers.ts      # Parse assistant proposals (goal, role, tool)
│   ├── qrcode.d.ts              # QR code library type declarations
│   ├── remote-agent.ts          # WebSocket ↔ Agent interface adapter (critical file)
│   ├── render-helpers.ts        # Shared rendering helpers
│   ├── render.ts                # App-level render functions
│   ├── role-manager-dialog.ts   # Role creation/edit dialog
│   ├── role-manager-page.ts     # Role management page
│   ├── role-manager.css         # Role manager page styles
│   ├── routing.ts               # Hash-based routing
│   ├── session-colors.ts        # Session color assignment
│   ├── session-manager.ts       # Client-side session management
│   ├── sidebar.ts               # Desktop session sidebar
│   ├── state.ts                 # App-level state management
│   ├── storage.ts               # Client-side storage helpers
│   ├── personality-manager-page.ts # Personality management page
│   ├── personality-manager.css  # Personality manager page styles
│   ├── staff-page.ts           # Staff agent management page
│   ├── tool-manager-page.ts     # Tool management UI (list + detail views)
│   ├── tool-manager.css         # Tool management page styles
│   ├── workflow-page.ts         # Workflow list and detail/edit page
│   └── workflow-page.css        # Workflow page styles
docs/
├── bobbit-sprites.md    # Bobbit pixel art, animation & accessory system reference
├── dev-workflow.md      # Development workflow guide
├── goals-workflows-tasks.md  # Goals, workflows, tasks & gates architecture
└── prompt-queue.md      # Prompt queue architecture
```

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
npm run test:unit      # Unit tests (Playwright file:// fixtures)
npm run test:e2e       # E2E tests (auto-starts sandboxed gateway via Playwright webServer)
```

### Dev server harness

When developing Bobbit itself, use `npm run dev:harness` instead of `npm run dev`. The harness wraps the server process and watches a sentinel file (`.bobbit/state/gateway-restart`). When an agent finishes making server-side changes, it runs `npm run restart-server` to trigger:

1. Kill the running server
2. Wait for the port to clear
3. `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence (`.bobbit/state/sessions.json`).

## Development workflow

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full guide on running modes, when to restart the server, and how to make changes safely.

**Quick reference**: UI changes (`src/ui/`, `src/app/`) hot-reload automatically. Server changes (`src/server/`) require `npm run restart-server` to rebuild and restart. Always run `npm run check` to verify types before triggering a restart.

## Testing

**Run tests before committing.** After any code change, run type-check and relevant tests. Pipe Playwright output through the test filter to keep context lean — it outputs just pass/fail counts and failure details:

```bash
# Type check first
npm run check

# Unit tests (fast, no server needed)
npx playwright test --config tests/playwright.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs

# E2E tests (starts sandboxed gateway on port 3099 automatically)
npm run build:server && npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
```

The test filter accepts verbosity flags you can use when debugging failures:
- `--failures` — summary + failure details only (default)
- `--verbose` — lists every test with OK/FAIL/SKIP status
- `--full` — raw JSON pass-through

If you only changed UI code (`src/ui/`, `src/app/`), unit tests are sufficient. Server changes (`src/server/`) need E2E tests too. The E2E `npm run build:server` step recompiles automatically.

**Test structure:**

- **Unit tests** (`tests/*.spec.ts`): Playwright with `file://` fixtures — plain HTML/JS files that test logic without a build step. See `tests/mobile-header.spec.ts` for the pattern.
- **E2E tests** (`tests/e2e/*.spec.ts`): Run against a real sandboxed gateway on port 3099, auto-started by Playwright's `webServer` config. Covers REST API, WebSocket protocol, session lifecycle, and agent tool invocations.

**Writing new tests**: Prefer `file://` fixtures with plain HTML/JS that simulate the logic under test. Extract state machine logic into testable functions where possible. For tests that need a real server (WebSocket, API integration), add to `tests/e2e/` — they use the `webServer` pattern in `playwright-e2e.config.ts`.

**Test isolation**: All tests must operate in isolation. Avoid using centralised or non-ephemeral systems and dependencies. E2E tests run with `BOBBIT_DIR` set to `.e2e-bobbit-<id>/` (a gitignored temp directory), so the test server's state files (sessions, goals, tasks, costs, tokens) are fully separated from the real dev server's `.bobbit/`. Never read from or write to `.bobbit/` in tests — use the isolated directory via `readE2EToken()` from `tests/e2e/e2e-setup.ts`. Unit tests should use `file://` fixtures with no external dependencies.

**Do NOT start background servers manually** from bash (`node server.js &`, `nohup`, etc.) — the bash tool waits for all stdout/stderr pipes to close, so backgrounded processes that inherit those FDs cause the bash tool to hang forever and crash the agent session. Always use Playwright's `webServer` config instead.

## Common tasks

**Add a new REST endpoint**: Edit `src/server/server.ts` `handleApiRoute()`.

**Add a new WebSocket command**: Add to `ClientMessage` union in `src/server/ws/protocol.ts`, handle in `src/server/ws/handler.ts` switch, add convenience method on `RpcBridge` if it maps to an agent command.

**Add a new UI component**: Add to `src/ui/components/`, export from `src/ui/index.ts`.

**Add a new tool renderer**: Create in `src/ui/tools/renderers/`, register in `src/ui/tools/index.ts`.

**Add a new skill definition**: Create in `src/server/skills/definitions/`, import and register in `src/server/skills/index.ts`. Define a `Skill` object with id, instructions, isolation level, and expected output. Run `exportDefinitions()` to sync to disk.

**Add a goal-related feature**: Goal CRUD is in `goal-manager.ts`/`goal-store.ts`. REST endpoints in `server.ts`. Goal assistant prompt in `goal-assistant.ts`. Client-side proposal parsing in `remote-agent.ts` `_checkForGoalProposal()`.

**Add/edit tool documentation**: Navigate to `#/tools`, click a tool, edit the Description/Group/Docs fields, and Save. Or launch a Tool Assistant session for AI-guided documentation. Server-side: tool metadata lives in `tools/<group>/*.yaml` files, managed by `tool-manager.ts`, API routes in `server.ts`.

**Add a new tool**: Create a YAML file in the appropriate `tools/<group>/` directory (e.g. `tools/filesystem/my_tool.yaml`). Define `name`, `description`, `summary`, `group`, `provider`, and optionally `renderer` and `docs`. If the tool needs a custom extension, add code to the group's `extension.ts`. Register a renderer in `src/ui/tools/renderers/` if needed.

**Change how messages render**: `src/ui/components/Messages.ts` for standard roles, `src/ui/components/message-renderer-registry.ts` for custom types.

## Debugging tips

**Debug duplicate messages**: The deferred message pattern in `remote-agent.ts` is subtle. `MessageList` renders `state.messages` (completed), `StreamingMessageContainer` renders `state.streamMessage` (in-progress). They must never show the same message. Tool-call messages stay in streaming until the next message starts. Check `flushDeferredMessage()` and `_deferredAssistantMessage`.

**Debug session persistence**: Check `.bobbit/state/sessions.json` for persisted session data. Sessions restore on startup via `session-manager.ts` `restoreSessions()`. If an agent's `.jsonl` session file is missing, that session is skipped. Failed restores create dormant entries that revive on client connect.

**Debug compaction issues**: Check `_isCompacting`, `_compactionSyntheticMessages`, and `_usageStaleAfterCompaction` in `remote-agent.ts`. The `compacting_placeholder` message must be filtered out and re-added correctly across server refreshes. Manual compaction is fire-and-forget from the WS handler's perspective.

**Debug gates**: Gate state is stored in `GateStore` (`.bobbit/state/gates.json`). Gate dependencies are enforced — if a signal fails, check gate status via `GET /api/goals/:id/gates`.

## Git conventions

The primary branch is **`master`** (not `main`). If the user refers to "main", treat it as `master`. Never create a `main` branch.

## Disk state summary

All per-project state lives under `<project-root>/.bobbit/`:

### `.bobbit/config/` — user-facing configuration (version controlled)

| File / Directory | Owner | Purpose |
|---|---|---|
| `system-prompt.md` | `cli.ts` | Global system prompt for agent sessions |
| `roles/*.yaml` | `RoleStore` | Role definitions and tool access |
| `workflows/*.yaml` | `WorkflowStore` | Workflow templates (gate DAGs, verification configs) |
| `personalities/*.yaml` | `PersonalityStore` | Personality definitions |


### `.bobbit/state/` — runtime state (gitignored)

| File / Directory | Owner | Purpose |
|---|---|---|
| `token` | `token.ts` | Auth token (mode 0600) |
| `sessions.json` | `SessionStore` | Session metadata (id, title, cwd, agentSessionFile, wasStreaming) |
| `goals.json` | `GoalStore` | Goal definitions (title, spec, cwd, state) |
| `tasks.json` | `TaskStore` | Task definitions, state, assignments |
| `gates.json` | `GateStore` | Gate state and signal history |
| `team-state.json` | `TeamStore` | Team state (agents, roles, goal associations) |
| `staff.json` | `StaffStore` | Staff agent definitions and state |
| `session-costs.json` | `CostTracker` | Per-session token and cost data |
| `session-colors.json` | `ColorStore` | Session → color index (0-13) mapping |
| `skill-definitions.json` | `definitions-sync.ts` | Exported skill definitions for agent discovery |
| `session-prompts/` | `system-prompt.ts` | Assembled per-session prompt files (cleaned up on terminate) |
| `tls/` | `tls.ts` | TLS certificates and keys |
| `gateway-url` | `cli.ts` | Last-started gateway base URL (e.g. `https://100.x.x.x:3001`) |
| `gateway-restart` | `harness.ts` | Sentinel file for dev server restart |
| `desec.json` | `desec.ts` | deSEC dynDNS config (domain + API token) |
| `rpc-debug.log` | `rpc-bridge.ts` | Debug log of all RPC events |

### `.bobbit/extensions/` — pi-coding-agent extension resolution directory

Retained for pi-coding-agent's `user-extension` resolution (delegate, browser, web tools). Bobbit-owned extensions now live in `tools/<group>/extension.ts`.

### Global state (not per-project)

| File | Owner | Purpose |
|---|---|---|
| `~/.pi/agent/auth.json` | `oauth.ts` | API auth credentials — global, not per-project |

## Goals, workflows, tasks & gates

Goals can optionally have a **workflow** — a DAG of gates with dependency ordering, quality criteria, and automated verification. Workflows are YAML templates snapshotted into the goal at creation.

**Tasks** link to workflow gates via `workflowGateId` (output) and `inputGateIds` (context inputs). **Context injection** feeds passed upstream gate content into agent prompts automatically — at spawn time (`team_spawn`) or prompt time (`team_prompt`).

For the full architecture — data models, context injection mechanics, verification lifecycle, REST API, and worked examples — see [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
