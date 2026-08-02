# Getting Started

## What is Bobbit?

Bobbit is a tool that lets you run an AI coding agent on your machine and control it from any browser — your laptop, phone, or tablet. You type what you want done, and the agent reads your code, edits files, runs commands, and explains what it's doing — all in a chat interface.

## Prerequisites

- **Node.js 22.19 or later** (check with `node --version`) — required by the bundled `@earendil-works/pi-*` runtime
- A modern browser (Chrome, Firefox, Safari, Edge)

## Installation

The quickest way to try Bobbit:

```bash
npx bobbit
```

This downloads and runs Bobbit in one step. It will scaffold a server `.bobbit/` directory, create the built-in **Headquarters** workspace for the current run directory, and start the server.

If you'd prefer a permanent install:

```bash
npm install -g bobbit
bobbit
```

## First launch

On the default loopback bind, Bobbit starts without enforcing token authentication. The terminal output looks like this:

```
Bobbit Gateway v<version>
  Listening:  http://localhost:3001
  Agent CWD:  <current directory>
  UI:         http://localhost:3001/

  Token authentication is disabled on this loopback bind.
  Any local process can access the gateway. Use --auth to require the token.
```

Your browser should open automatically at the untokenized UI URL. If it doesn't, copy that URL from the terminal. Because the gateway is local-only but any local process can access it, use `--auth` when you want Bobbit to enforce its token:

```bash
bobbit --auth
```

With `--auth`, the banner prints the auth token and secrecy warning, and the browser opens a tokenized URL. The token is generated once and saved in `.bobbit/state/token`. Bobbit also enforces token authentication automatically on non-loopback binds; see [Networking](networking.md) for remote-access guidance.

## Your first session

1. **Create a session** — Click **Quick Session**. On a fresh server this starts in **Headquarters**, the built-in workspace for the server run directory.
2. **Send a prompt** — Type what you want the agent to do. For example: "Add a README to this project" or "Fix the failing tests".
3. **Watch it work** — The agent will read files, run commands, and edit code. You'll see each step in real time.
4. **Steer if needed** — If the agent goes in the wrong direction, type a follow-up message to guide it.

That's it. The agent has full access to the selected workspace directory, so it can do anything you'd do from the terminal. Add more projects when you want Bobbit to manage multiple repos from the same browser.

## Key concepts

Here's a quick overview of the main ideas in Bobbit. Don't worry about memorising these — you can always come back here.

- **Headquarters** — The built-in server workspace. It appears automatically on first launch, uses the server run directory, and is where server-level configuration lives.

- **Sessions** — Each session is a separate conversation with an AI agent. You can have multiple sessions running at once, each working on different things.

- **Goals** — A way to track larger pieces of work. Goals have a title, description, and state (to-do, in-progress, complete). You can attach sessions to goals and track progress.

- **Roles** — Roles define what an agent can do — its system prompt and which tools it has access to. Bobbit includes built-in roles like coder, reviewer, and tester. You can create custom ones too.

- **Workflows** — Workflows define the stages a goal goes through, like design → implement → test → review. They enforce order and quality by requiring each stage to pass before the next begins. See [goals-workflows-tasks.md](goals-workflows-tasks.md) for the full details.

- **Tools** — These are the capabilities available to agents — file editing, shell commands, web search, browser automation, and more. You can view and configure them in the Tools page.

## Where to go next

Once you're comfortable with the basics, explore these references:

- [Headquarters project](headquarters.md) — Built-in server workspace behavior
- [REST API](rest-api.md) — Full API reference for programmatic access
- [WebSocket Protocol](websocket-protocol.md) — Real-time communication protocol
- [Security Model](security.md) — How Bobbit keeps your machine safe
- [Networking](networking.md) — Remote access, TLS, and multi-device setup
- [Build Structure](build-structure.md) — How the project is organised
- [Goals, Workflows & Tasks](goals-workflows-tasks.md) — Advanced task tracking and automation
- [Prompt Queue](prompt-queue.md) — How message queuing works

## Development

Want to contribute to Bobbit or hack on the code? See the [development workflow guide](dev-workflow.md) for how to set up a dev environment, run tests, and make changes.
