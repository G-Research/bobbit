# Bobbit

**Your AI dev team, running on your machine, controlled from your browser.**

Bobbit is a command centre for AI coding agents. Spin up teams — leads that plan, coders that build in parallel, reviewers and testers that enforce quality — and point them at anything from a quick bug fix to a full-stack feature. Watch every agent work in real time, steer them mid-task, and stay in control of what ships.

<!-- TODO: Add a demo GIF showing a full session — prompt → agent reading files → editing → running tests → done -->

## Quick start

```bash
npx bobbit
```

That's it. Bobbit scaffolds a `.bobbit/` config directory, starts a gateway on `http://localhost:3001`, and opens your browser. Send your first prompt and watch it work.

For a detailed walkthrough of your first session, see the **[Getting Started guide](docs/getting-started.md)**.

## Quick start (from source)

If you have a Bobbit source checkout, use the `run` script to launch it against any project directory — no global install needed.

```bash
git clone <repo> bobbit

# From your project directory:
/path/to/bobbit/run                    # Linux/macOS
C:\path\to\bobbit\run.cmd              # Windows
```

On first run, the script auto-installs dependencies and builds (`npm install && npm run build`). On subsequent runs, it detects when source files have changed since the last build and rebuilds automatically — so `git pull && ./run` just works.

Each project gets its own `.bobbit/` state directory, and ports auto-increment so you can run multiple instances side by side. All CLI flags are forwarded:

```bash
/path/to/bobbit/run --host 0.0.0.0 --port 3005 --no-tls
```

See **[Run from Checkout](docs/run-from-checkout.md)** for full details, PATH integration, and troubleshooting.

### CLI flags

```
bobbit [options]

--host <addr>       Bind address (default: localhost)
--port <n>          Port (default: 3001)
--nord              Bind to NordLynx mesh IP (remote access via NordVPN meshnet)
--tls / --no-tls    Override TLS auto-detection
--cwd <dir>         Working directory for agent sessions (default: .)
--agent-cli <path>  Path to pi-coding-agent cli.js
--static <dir>      Serve a custom UI build directory
--no-ui             Gateway-only mode (no UI)
--new-token         Force-generate a new auth token
--show-token        Print the current token and exit
```

### From source

```bash
git clone <repo> && cd bobbit
npm install
npm run build     # compile server + bundle UI
npm start         # start gateway on :3001
```

### From global install

```bash
npm install -g bobbit
bobbit
```

## Why Bobbit?

Most AI coding tools are either locked inside an IDE or limited to a terminal. Bobbit is different:

- **Use any device** — Work from your laptop, phone, or tablet. Start a task on your desktop, check progress from your phone. Multiple devices can connect to the same session simultaneously.
- **Full agent power** — The agent has real shell access. It reads your codebase, edits files, runs builds and tests, searches the web, and automates browsers. No copy-pasting code snippets.
- **Watch everything happen** — Every file read, shell command, and edit streams to your browser in real time with rich tool-call renderers. You see exactly what the agent is doing and can steer it at any point.
- **Sessions survive everything** — Sessions persist to disk. Restart the server, close your browser, lose your connection — pick up right where you left off.
- **Zero config** — `npx bobbit` and you're running. No API keys to configure (uses your existing `~/.pi/` credentials), no Docker, no cloud setup.

## Features

### Sessions
Each session is a running agent with its own conversation and persistence. Run multiple sessions in parallel, each working on different parts of your project. Connect from multiple devices at once.

### Goals & Tasks
Track larger work items with structured goals. Each goal has a title, spec, state, and optional task board. Goals can create dedicated git worktrees for isolated work.

### Teams
Coordinate multiple agents working together. A team lead spawns role agents (coder, reviewer, tester) that work on tasks in parallel, each in their own git worktree.

### Workflows & Gates
Define quality stages — design, implement, test, review — as a DAG of gates. Each gate has criteria and enforced ordering. No cutting corners: the agent can't skip ahead.

### Roles & Personalities
Control what agents can do (tool access, system prompts) and how they communicate (tone, thoroughness, style). Use built-in roles or create your own.

### Skills
Reusable templates for isolated sub-agents: code review, security review, test reports. Invoke them from any session for structured, repeatable outputs.

### Cost Tracking
Per-session token usage and cost, aggregated to goal and task level. Always know what you're spending.

### The Bobbit Mascot
A squishy pixel-art blob that lives in the UI — animated, expressive, and drawn entirely with CSS box-shadows. Each session gets its own colour identity. Role accessories (crown, magnifying glass, bandana) show what the agent is doing at a glance. See the [sprite system docs](docs/bobbit-sprites.md).

## Documentation

| Guide | Description |
|---|---|
| [Getting Started](docs/getting-started.md) | First session walkthrough and key concepts |
| [Features](docs/features.md) | Detailed feature reference |
| [Architecture](docs/architecture.md) | System design, layers, and dependencies |
| [Development & Testing](docs/dev-workflow.md) | Dev environment, hot reload, testing |
| [Goals & Workflows](docs/goals-workflows-tasks.md) | Task tracking, gates, and verification |
| [Bobbit Sprites](docs/bobbit-sprites.md) | Pixel-art mascot, animations, and accessories |

**Technical reference:** [REST API](docs/rest-api.md) · [WebSocket Protocol](docs/websocket-protocol.md) · [Security](docs/security.md) · [Networking](docs/networking.md)

## Contributing

See the [development workflow guide](docs/dev-workflow.md) for dev setup, and [AGENTS.md](AGENTS.md) for repo layout and common tasks.
