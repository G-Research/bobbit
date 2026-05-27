# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Full build (server + UI)
npm run dev:harness    # Gateway via restart harness + vite (use this for dev)
npm run restart-server # Rebuild & restart after server changes
npm run check          # Type-check server + web (no emit)
npm run test:unit      # Unit — file:// fixtures + Node runner (<30s)
npm run test:e2e       # E2E — API (in-process) + browser (spawned gateway)
npm run test:manual    # Manual integration — real agents + Docker (~5 min)
SCREENSHOTS=1 npm run test:manual  # + browser screenshots + HTML report
```

UI changes (`src/ui/`, `src/app/`) hot-reload under `npm run dev:harness`. Server changes (`src/server/`) require `npm run restart-server`. Always `npm run check` before restarting. Sessions survive restarts via `.bobbit/state/sessions.json`.

## Architecture map

Where things live. Use this to orient, then `rg` for the symbol.

- **Server REST/WS**: `src/server/` — REST in `server.ts::handleApiRoute()`, WebSocket in `src/server/ws/`.
- **Agent runtime**: `src/server/agent/` — sessions, manager, status, steer, respawn, store, project context.
- **MCP / tools**: `src/server/mcp/`, `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). Tool descriptions are budget-pinned by `tests/tool-description-budget.test.ts`.
- **Skills**: `.claude/skills/<name>/SKILL.md`.
- **UI shell**: `src/app/` — state, render, message-reducer, dialogs, follow-tail.
- **UI components**: `src/ui/` — components, `tools/renderers/`, `lazy/`.
- **Tests**: `tests/` (unit), `tests/e2e/` (API), `tests/e2e/ui/` (browser), `tests/manual-integration/` (real agents + Docker).
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. **`rg "<symbol-or-symptom>" docs/ tests/ src/`** — design constraints, rationale, and pinning tests live there. Read the hits before writing code.
2. **Look for a pinning test.** Tests are how invariants are enforced — not prose. If you break one, fix the bug, not the test. If a regression isn't caught by a test, the missing test IS the bug; add it.
3. **Search for "never reintroduce" / "single source of truth" / "pinned by"** in source comments around what you're touching.
4. **`docs/debugging.md`** has full diagnostic walkthroughs indexed by symptom — search there before guessing.

## Testing

- **UI-only changes** → `test:unit`. **Server changes** → `test:unit` + `test:e2e`. **Session lifecycle / sandbox / worktree / restart** → also `test:manual`.
- **Test types**: unit (`tests/*.spec.ts`, file:// fixtures), API E2E (`tests/e2e/*.spec.ts`, in-process gateway via `./in-process-harness.js`), browser E2E (`tests/e2e/ui/*.spec.ts`, spawned gateway via `../gateway-harness.js`).
- Tests run in isolation — never read/write `.bobbit/` directly; use the isolated dir from `e2e-setup.ts`.
- **Never start background servers from bash** (`node server.js &`) — pipes hang the agent. Use Playwright `webServer` config or `bash_bg`.
- Prefer `file://` fixtures for new tests; use E2E only when you need a real server.
- **Every user-facing feature MUST have a browser E2E** covering navigation, happy path, persistence across reload, cleanup/undo. Pattern: `tests/e2e/ui/settings.spec.ts`.
- **Run tests before committing.** **No flaky tests** — every failure is a real bug.
- See [docs/testing-strategy.md](docs/testing-strategy.md), [docs/testing-coverage.md](docs/testing-coverage.md).

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

**Line endings**: LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows: `git config --global core.autocrlf false` (phantom "modified" entries on fresh checkout = `core.autocrlf=true`).

**Worktrees**: dev server runs from the **primary worktree** on `master`. Sessions use separate worktrees under `<project-root>-wt/<branch>/` (single-repo) or `<project-root>-wt/<branch>/<repo>/` (multi-repo). Branch namespaces: `pool/_pool-<id>`, `session/<id8>`, `goal/<slug>-<id>`, `staff-<name>-<id>`. Multi-repo invariant: every component repo gets a sibling worktree on the same branch. Start-point for new worktrees is the project's `base_ref` when set, else the remote primary — see [docs/design/base-ref.md](docs/design/base-ref.md).

**Always edit files in your session worktree, never in the primary worktree.** For infra files: edit here → commit → push → pull from primary. Pushing to remote `master` does NOT update the dev server — `cd <primary-worktree> && git pull origin master`.

**Never `git stash` in a session worktree** — the stash stack is shared across all worktrees of one repo, so another agent's `stash pop` can grab your WIP. Commit a throwaway instead. [docs/dev-workflow.md — Worktree-stash hazard](docs/dev-workflow.md#worktree-stash-hazard--never-git-stash-inside-a-session-worktree).

See [docs/dev-workflow.md](docs/dev-workflow.md) for the full worktree story.

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. Keep it small and general.

- **No specific recipes or debugging entries.** Symptom→fix lookups belong in `docs/debugging.md`; how-to-do-X belongs in the relevant `docs/<topic>.md`. Agents discover them via the "Before editing" search step above.
- **No invariant prose pretending to prevent regressions.** Tests prevent regressions; prose hopes the next agent reads it. If something needs to be invariant, write the test that pins it.
- Keep this file under ~5 KB. If it grows, the new content probably belongs in `docs/`.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/dev-workflow.md](docs/dev-workflow.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md)
