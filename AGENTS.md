# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Build server + UI
npm run dev:harness    # Gateway + vite dev
npm run restart-server # Rebuild & restart after server changes
npm run check          # Type-check server + web
npm run test:unit      # Vitest tier-1, fixed 3-worker cap
npm run test:browser   # Playwright browser-v2
npm run test:e2e       # E2E v2: git/worktree/Docker/MCP/restart
npm run test:manual    # Real agents/LLM + Docker (~5 min); ONLY gate-exempt path
```

UI changes (`src/ui/`, `src/app/`) hot-reload under `npm run dev:harness`. Server changes (`src/server/`) require `npm run restart-server`. Run `npm run check` first. Sessions survive restarts via `.bobbit/state/sessions.json`.

## Architecture map

Orient here, then `rg` for the symbol.

- **Server REST/WS**: `src/server/` — REST in `server.ts::handleApiRoute()`, WS in `src/server/ws/`.
- **Agent runtime**: `src/server/agent/` — sessions, manager, status, steer, respawn, store, project context. See [docs/bg-process-persistence.md](docs/bg-process-persistence.md) for `bash_bg`.
- **MCP / tools**: `src/server/mcp/`, `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). Descriptions budget-pinned by `tests2/core/tool-description-budget.test.ts`.
- **Skills**: `.claude/skills/<name>/SKILL.md`.
- **Roles/tools/skills resolution**: unified `PackResolver` over one ordered pack list in `src/server/agent/pack-*.ts`; built-in packs in `market-packs/`. See [docs/marketplace.md](docs/marketplace.md).
- **UI shell**: `src/app/` — state, render, message-reducer, dialogs, follow-tail.
- **UI components**: `src/ui/` — components, `tools/renderers/`, `lazy/`.
- **Tests (v2)**: `tests2/{core,dom,integration}` (vitest), `tests2/browser` (Playwright), `tests2/tests-map.json`; `tests/e2e/` = `e2e:v2`; `tests/manual-integration/` (real agents).
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. **`rg "<symbol-or-symptom>" docs/ tests/ src/`** — design constraints, rationale, and pinning tests live there. Read the hits before coding.
2. **Look for a pinning test.** Tests enforce invariants, not prose. If you break one, fix the bug, not the test. If a regression isn't caught by a test, the missing test IS the bug; add it.
3. **Search for "never reintroduce" / "single source of truth" / "pinned by"** in source comments around what you're touching.
4. **`docs/debugging.md`** has full diagnostic walkthroughs indexed by symptom — search there before guessing.

## Testing (Test Suite v2)

- **New tests land in `tests2/`** (or the guard fails). `*.test.ts`⇒Vitest (`core`/`dom`/`integration`, with explicit isolated exceptions); `*.spec.ts`⇒Playwright (`tests2/browser`). Register in `tests2/tests-map.json`. Three sequential gate phases: `test:unit` → `test:browser` → `test:e2e`; worktree/Docker/MCP/restart coverage belongs to E2E or `test:manual`.
- **Unit gate** — one direct Vitest run, fixed three-worker cap, `retry: 3`, subprocess guard, and hard 25 s solo file budget. See [docs/testing-v2/unit-gate.md](docs/testing-v2/unit-gate.md).
- Isolate only via the harness temp dir — never touch `.bobbit/`. **Never bg-server from bash** — use `bash_bg`. Run tests before committing.
- Every user-facing feature needs a `tests2/browser` journey (nav, happy path, reload, cleanup). See [docs/testing-v2/](docs/testing-v2/).

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

**Line endings**: LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows: set `git config --global core.autocrlf false`.

**Worktrees**: dev server runs from the **primary worktree** on `master`; sessions use separate worktrees under `<project-root>-wt/<branch>/`. Always edit in your session worktree, never the primary one. For infra files: edit here → commit → push → `cd <primary-worktree> && git pull origin master` (pushing to remote `master` does NOT update the dev server).

**Forks**: open PRs against the fork's `master`, not the upstream repo.

See [docs/dev-workflow.md](docs/dev-workflow.md).

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. Keep it small and general.

- **No specific recipes or debugging entries.** Symptom→fix lookups belong in `docs/debugging.md`; how-to-do-X in the relevant `docs/<topic>.md`. Agents find them via the "Before editing" search step above.
- **No invariant prose pretending to prevent regressions.** Write the test that pins it instead.
- Keep it small; new content usually belongs in `docs/`.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/logging.md](docs/logging.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/nested-goals.md](docs/nested-goals.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md) · [docs/extension-host-authoring.md](docs/extension-host-authoring.md) · [docs/support-assistant.md](docs/support-assistant.md)

**Driving the gateway from an agent**: prefer the `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tools over hand-rolled `curl` where their tool-groups are enabled. See [docs/bobbit-gateway-tool.md](docs/bobbit-gateway-tool.md).
