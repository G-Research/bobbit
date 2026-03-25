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

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full development workflow, including the restart harness and hot-reload setup.

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

- **Sessions** — Each session is a running agent with its own conversation, persistence, and multi-device support.
- **Goals & Tasks** — Track larger work items with state, specs, and task boards.
- **Teams** — Coordinate multiple agents working together on a goal with roles (coder, reviewer, tester).
- **Workflows & Gates** — Define quality stages (design → implement → test → review) with enforced ordering.
- **Roles & Personalities** — Customise agent behaviour, tool access, and communication style.
- **Skills** — Reusable templates for isolated sub-agents (code review, test reports).
- **Cost Tracking** — Per-session token usage and cost, aggregated to goal and task level.

See [docs/features.md](docs/features.md) for detailed feature documentation.

**Technical reference:** [REST API](docs/rest-api.md) · [WebSocket Protocol](docs/websocket-protocol.md) · [Security](docs/security.md) · [Networking](docs/networking.md) · [Goals & Workflows](docs/goals-workflows-tasks.md)

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

Run `npm run check` (type-check), `npm test` (unit tests), and `npm run test:e2e` (E2E tests). See [AGENTS.md](AGENTS.md) for details.

## Contributing

See [docs/dev-workflow.md](docs/dev-workflow.md) for the development workflow. For repo layout and common tasks, see [AGENTS.md](AGENTS.md). Build structure is documented in [docs/build-structure.md](docs/build-structure.md). The [bobbit mascot](docs/bobbit-sprites.md) is a pixel-art blob with animations, colour identities, and role-based accessories.
