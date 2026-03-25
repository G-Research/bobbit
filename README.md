# Bobbit

A remote gateway for AI coding agents. Run a coding agent on a powerful machine, control it from any browser — desktop, phone, or tablet.

Bobbit wraps [pi-coding-agent](https://github.com/nickarrow/nickarrow) in a WebSocket gateway with a browser UI built on Lit. You start the server, open the URL (or scan a QR code on your phone), and interact with a coding agent that has full shell access to the host machine.

## How it works

```
┌─────────────┐         ┌──────────────────────────┐
│  Browser UI  │◄──WS──►│     Bobbit Gateway        │
│  (any device)│         │                           │
└─────────────┘         │  ┌──────────────────────┐ │
                        │  │ pi-coding-agent (RPC) │ │
                        │  │  stdin/stdout JSONL    │ │
                        │  └──────────────────────┘ │
                        └──────────────────────────┘
```

1. **Gateway** (`src/server/`) — Node.js HTTP + WebSocket server. Manages agent sessions as child processes communicating over JSONL on stdin/stdout. Sessions persist to disk and survive server restarts. Serves the built UI as static files or runs headless behind a Vite dev server.
2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Desktop layout has a session sidebar; mobile has a landing page with session cards. Supports multi-device access and QR code sharing.
3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, specialised tool call renderers, model selection, settings, and more.

## Quick start

```bash
npx bobbit
```

That's it. Bobbit installs, builds, scaffolds a `.bobbit/` directory in your project, and starts the gateway on `http://localhost:3001`. Open the printed URL in your browser.

**Global install** (if you prefer):

```bash
npm install -g bobbit
bobbit
```

For a step-by-step walkthrough of your first session, see the **[Getting Started guide](docs/getting-started.md)**.

### How it binds

- **Default** (most users): Bobbit binds to `localhost:3001` with TLS disabled — plain HTTP, zero friction.
- **`--nord` flag**: Binds to the NordVPN mesh IP with HTTPS (self-signed cert). Enables remote access from any device on the meshnet.
- **Explicit host**: Pass `--host <addr>` to bind to a specific address. Non-loopback addresses default to HTTPS.

### From source

```bash
git clone <repo> && cd bobbit
npm install
npm run build     # compile server + bundle UI
npm start         # start gateway on :3001, serves UI
```

### Development

```bash
npm run build:server   # compile server TypeScript (required before first run)
npm run dev:harness    # gateway with auto-restart harness + vite dev server (recommended)
npm run dev            # gateway + vite without the harness
```

Both the gateway (`:3001`) and Vite (`:5173`) auto-bind to the NordLynx mesh IP. Vite proxies `/api` and `/ws` to the gateway. UI changes hot-reload instantly. Server changes require `npm run restart-server` to rebuild and restart.

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full development workflow.

### Dev server harness

Use `npm run dev:harness` when developing Bobbit itself. The harness wraps the server process and watches a sentinel file (`.bobbit/state/gateway-restart`). Running `npm run restart-server` triggers:

1. Kill the running server
2. Wait for the port to clear
3. Run `npm run build:server` to recompile TypeScript
4. Relaunch the server

The harness also auto-restarts on unexpected crashes. Sessions survive restarts thanks to disk persistence.

### CLI flags

```
bobbit [options]

--host <addr>       Bind address (default: localhost)
--port <n>          Port (default: 3001)
--nord              Bind to NordLynx mesh IP (enables remote access via NordVPN meshnet)
--tls / --no-tls    Override TLS auto-detection (default: TLS on for non-loopback, off for localhost)
--cwd <dir>         Working directory for agent sessions (default: .)
--agent-cli <path>  Path to pi-coding-agent cli.js (auto-resolved from node_modules)
--static <dir>      Serve a custom UI build directory
--no-ui             Don't serve any UI (gateway-only mode)
--new-token         Force-generate a new auth token
--show-token        Print the current token and exit
```

## Features

- **Sessions** — Each session is a running agent with its own conversation, persistence, and multi-device support. See [Features](#sessions-goals--more) below.
- **Goals & Tasks** — Track larger work items with state, specs, and task boards. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Teams** — Coordinate multiple agents working together on a goal with roles (coder, reviewer, tester).
- **Workflows & Gates** — Define quality stages (design → implement → test → review) with enforced ordering. See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md).
- **Roles & Personalities** — Customise agent behaviour, tool access, and communication style.
- **Skills** — Reusable templates for isolated sub-agents (code review, test reports).
- **Cost Tracking** — Per-session token usage and cost, aggregated to goal and task level.
- **REST API** — Full programmatic access. See [docs/rest-api.md](docs/rest-api.md).
- **WebSocket Protocol** — Real-time streaming events. See [docs/websocket-protocol.md](docs/websocket-protocol.md).
- **Security** — Token auth, TLS, rate limiting, PKCE OAuth. See [docs/security.md](docs/security.md).
- **Networking** — Mesh VPN, dynamic DNS, QR codes, multi-device. See [docs/networking.md](docs/networking.md).

### Sessions, Goals & More

Each session is a running `pi-coding-agent` child process with its own conversation history. Session metadata persists to disk and survives server restarts. Multiple browser tabs/devices can connect to the same session.

Goals are a task-tracking layer on top of sessions — with title, spec, working directory, state, optional git worktrees, and optional workflows for quality enforcement.

Teams coordinate multiple agent sessions on a goal, with a team lead that spawns role agents (coder, reviewer, tester). See [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) for the full architecture.

For the complete feature reference, see the [REST API](docs/rest-api.md) and [WebSocket Protocol](docs/websocket-protocol.md) docs.

## Dependencies

### Runtime

| Package | Purpose |
|---|---|
| `@lmstudio/sdk` | LM Studio local model integration |
| `@mariozechner/mini-lit` | Minimal Lit component library (buttons, dialogs, alerts, inputs) |
| `@mariozechner/pi-agent-core` | Agent interface types and event model |
| `@mariozechner/pi-ai` | AI model abstraction (providers, streaming, tool calling) |
| `@mariozechner/pi-coding-agent` | The coding agent (spawned as subprocess) |
| `@mariozechner/pi-tui` | Terminal UI utilities |
| `acme-client` | ACME/Let's Encrypt client for TLS certificates |
| `docx-preview` | DOCX document rendering in browser |
| `jszip` | ZIP file handling (used by document renderers) |
| `lit` | Web component framework |
| `lucide` | Icon library |
| `mkcert` | Local CA certificate generation |
| `ollama` | Ollama local model integration |
| `pdfjs-dist` | PDF rendering in browser |
| `qrcode` | QR code generation for mobile access |
| `ws` | WebSocket server |
| `xlsx` | Excel spreadsheet parsing |
| `yaml` | YAML parsing/serialisation (roles, personalities, workflows) |

### Development

| Package | Purpose |
|---|---|
| `@playwright/test` | Browser testing framework |
| `@tailwindcss/vite` | Tailwind CSS Vite plugin |
| `@types/node` | Node.js type definitions |
| `@types/ws` | WebSocket type definitions |
| `concurrently` | Run multiple processes (gateway + vite) |
| `shx` | Cross-platform shell commands |
| `typescript` | TypeScript compiler |
| `vite` | Frontend build tool and dev server |

## Testing

```bash
npm run check         # Type-check server + web without emitting
npm test              # Unit tests (Playwright with file:// fixtures)
npm run test:e2e      # E2E tests (auto-starts sandboxed gateway)
```

See [AGENTS.md](AGENTS.md) for detailed testing instructions, test structure, and how to write new tests.

## Build structure

See [docs/build-structure.md](docs/build-structure.md) for the full build output layout and TypeScript config details.

## Contributing / Development

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full development workflow — running modes, making changes, and the restart harness. For agent-facing context (repo layout, common tasks, debugging), see [AGENTS.md](AGENTS.md).

## Bobbit mascot

The bobbit is a pixel-art blob mascot rendered with CSS `box-shadow`, with idle/working/starting animations, 14 colour identities (via `hue-rotate`), and role-based accessories (hardhat, magnifying glass, test tube, crown, etc.).

See [docs/bobbit-sprites.md](docs/bobbit-sprites.md) for the full sprite reference, animation system, and accessory catalogue.
