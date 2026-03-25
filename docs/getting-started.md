# Getting Started

## What is Bobbit?

Bobbit is a tool that lets you run an AI coding agent on your machine and control it from any browser — your laptop, phone, or tablet. You type what you want done, and the agent reads your code, edits files, runs commands, and explains what it's doing — all in a chat interface.

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- A modern browser (Chrome, Firefox, Safari, Edge)

## Installation

The quickest way to try Bobbit:

```bash
npx bobbit
```

This downloads and runs Bobbit in one step. It will scaffold a `.bobbit/` directory in your current project and start the server.

If you'd prefer a permanent install:

```bash
npm install -g bobbit
bobbit
```

## First launch

When Bobbit starts, you'll see output like this in your terminal:

```
🔑 Auth token: abc123...
🌐 http://localhost:3001
```

Your browser should open automatically. If it doesn't, copy the URL from the terminal.

The **auth token** is like a password — it keeps your Bobbit instance private. It's generated once and saved in `.bobbit/state/token`. You'll need it if you connect from another device.

## Your first session

1. **Create a session** — Click the "+" button in the top bar (or the "New session" button on mobile).
2. **Send a prompt** — Type what you want the agent to do. For example: "Add a README to this project" or "Fix the failing tests".
3. **Watch it work** — The agent will read files, run commands, and edit code. You'll see each step in real time.
4. **Steer if needed** — If the agent goes in the wrong direction, type a follow-up message to guide it.

That's it! The agent has full access to your project directory, so it can do anything you'd do from the terminal.

## Key concepts

Here's a quick overview of the main ideas in Bobbit. Don't worry about memorising these — you can always come back here.

- **Sessions** — Each session is a separate conversation with an AI agent. You can have multiple sessions running at once, each working on different things.

- **Goals** — A way to track larger pieces of work. Goals have a title, description, and state (to-do, in-progress, complete). You can attach sessions to goals and track progress.

- **Roles** — Roles define what an agent can do — its system prompt and which tools it has access to. Bobbit includes built-in roles like coder, reviewer, and tester. You can create custom ones too.

- **Personalities** — Optional modifiers that change how an agent communicates — its style, thoroughness, and approach. Apply them when you want a specific tone or working style.

- **Workflows** — Workflows define the stages a goal goes through, like design → implement → test → review. They enforce order and quality by requiring each stage to pass before the next begins. See [goals-workflows-tasks.md](goals-workflows-tasks.md) for the full details.

- **Tools** — These are the capabilities available to agents — file editing, shell commands, web search, browser automation, and more. You can view and configure them in the Tools page.

## Where to go next

Once you're comfortable with the basics, explore these references:

- [REST API](rest-api.md) — Full API reference for programmatic access
- [WebSocket Protocol](websocket-protocol.md) — Real-time communication protocol
- [Security Model](security.md) — How Bobbit keeps your machine safe
- [Networking](networking.md) — Remote access, TLS, and multi-device setup
- [Build Structure](build-structure.md) — How the project is organised
- [Goals, Workflows & Tasks](goals-workflows-tasks.md) — Advanced task tracking and automation
- [Prompt Queue](prompt-queue.md) — How message queuing works

## Development

Want to contribute to Bobbit or hack on the code? See the [development workflow guide](dev-workflow.md) for how to set up a dev environment, run tests, and make changes.
