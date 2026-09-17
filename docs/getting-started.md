# Getting Started

## What is Bobbit?

Bobbit is a tool that lets you run an AI coding agent on your machine and control it from any browser — your laptop, phone, or tablet. You type what you want done, and the agent reads your code, edits files, runs commands, and explains what it's doing — all in a chat interface.

## Prerequisites

- **Node.js 22.19 or later** (check with `node --version`) — required by the bundled `@earendil-works/pi-*` runtime
- A modern browser (Chrome, Firefox, Safari, Edge)

## Installation

The quickest way to try Bobbit:

```bash
npx @gresearch/bobbit
```

This downloads and runs Bobbit in one step. It will scaffold a server `.bobbit/` directory, create the built-in **Headquarters** workspace for the current run directory, and start the server.

If you'd prefer a permanent install:

```bash
npm install -g @gresearch/bobbit
bobbit
```

## First launch

Bobbit requires token authentication by default, including on the default loopback bind. The terminal output prints the token and opens the browser at a tokenized bootstrap URL:

```
Bobbit Gateway v<version>
  Listening:  http://localhost:3001
  Auth token: <token>
  Agent CWD:  <current directory>

  ⚠ This token grants full shell access to this machine.
  Keep it secret. Regenerate with --new-token.

┏━ BOBBIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
┃
┃     ▄█████▄       ●  UI READY
┃   ▄█████████
┃   ███ ██ ███      OPEN THIS LINK IN YOUR BROWSER
┃   ▀████████▀
┃     ▀▀▀▀▀▀        ➜  http://localhost:3001/?token=<token>
┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The connection panel appears as soon as the UI can accept requests and is printed again with `✓  STARTUP COMPLETE` after every background boot task finishes, keeping the link easy to find below intervening startup logs. Terminals without Unicode or colour support receive a plain ASCII version. The browser exchanges the bootstrap token for its normal authenticated session. The token is generated once and saved in Bobbit's private OS-user secrets directory; `bobbit --show-token` prints it when needed.

For isolated local troubleshooting only, `bobbit --no-auth` enables credential-free access when the complete gateway policy and actual client are both loopback. Any local process can then control Bobbit, and sandboxed agents are unavailable until the gateway is restarted without `--no-auth`. Non-loopback configurations always require authentication. See [Networking](networking.md) for remote-access guidance.

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
