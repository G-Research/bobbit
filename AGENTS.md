# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Full build (server + UI)
npm run dev:harness    # Gateway via restart harness + vite (use this for dev)
npm run restart-server # Rebuild & restart after server changes
npm run check          # Type-check server + web (no emit)
npm run test:unit      # Unit phase → v2 fast tier (test:v2): vitest core/dom/integration ‖ Playwright browser (retries:0)
npm run test:e2e       # E2E phase → v2 real-fidelity (test:e2e:v2): real git/worktree/Docker/MCP/restart (retries:0, external-free)
npm run test:manual    # Manual integration — real agents/LLM + Docker (~5 min); ONLY gate-exempt path
```

UI changes (`src/ui/`, `src/app/`) hot-reload under `npm run dev:harness`. Server changes (`src/server/`) require `npm run restart-server`. Always `npm run check` before restarting. Sessions survive restarts via `.bobbit/state/sessions.json`.

## Architecture map

Where things live. Use this to orient, then `rg` for the symbol.

- **Server REST/WS**: `src/server/` — REST in `server.ts::handleApiRoute()`, WebSocket in `src/server/ws/`.
- **Agent runtime**: `src/server/agent/` — sessions, manager, status, steer, respawn, store, project context. `bash_bg` processes persist + re-attach across restart via `bg-process-{manager,store,runner}.ts`; state under `<stateDir>/bg-processes/`. See [docs/bg-process-persistence.md](docs/bg-process-persistence.md).
- **MCP / tools**: `src/server/mcp/`, `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). Tool descriptions are budget-pinned by `tests2/core/tool-description-budget.test.ts`.
- **Skills**: `.claude/skills/<name>/SKILL.md`.
- **Roles/tools/skills resolution**: unified `PackResolver` over one ordered pack list in `src/server/agent/pack-*.ts`; built-in packs in `market-packs/`. See [docs/marketplace.md](docs/marketplace.md).
- **UI shell**: `src/app/` — state, render, message-reducer, dialogs, follow-tail.
- **UI components**: `src/ui/` — components, `tools/renderers/`, `lazy/`.
- **Tests (v2)**: `tests2/{core,dom,integration}` (vitest), `tests2/browser` (Playwright), `tests2/tests-map.json` (buckets + `v2Path`); `tests/e2e/` relocate specs + harness = the `e2e:v2` tier; `tests/manual-integration/` (real agents). Guard: `tests2/core/guard-v2.test.ts` + `scripts/testing-v2/parity.mjs`.
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. **`rg "<symbol-or-symptom>" docs/ tests/ src/`** — design constraints, rationale, and pinning tests live there. Read the hits before writing code.
2. **Look for a pinning test.** Tests are how invariants are enforced — not prose. If you break one, fix the bug, not the test. If a regression isn't caught by a test, the missing test IS the bug; add it.
3. **Search for "never reintroduce" / "single source of truth" / "pinned by"** in source comments around what you're touching.
4. **`docs/debugging.md`** has full diagnostic walkthroughs indexed by symptom — search there before guessing.

## Testing (Test Suite v2)

- **New tests land in `tests2/`** (or the guard fails). `*.test.ts`⇒vitest (`core`/`dom`/`integration`); `*.spec.ts`⇒Playwright (`tests2/browser`). Register in `tests2/tests-map.json`. UI/server → `test:unit` (+`test:e2e`); worktree/Docker/MCP/restart → `e2e:v2` + `test:manual`.
- **`retries:0`** — a flake is a bug, fixed by architecture (DI seams, one-gateway-per-fork + `scope()` cleanup, observable-state waits). **No daily lane**; **external-free** (fenced runner+fetch). Concurrency via the ledger (`Σworkers≤cores`, N=1 bar).
- Isolation only via the harness temp dir — never touch `.bobbit/`. **Never bg-server from bash** — use `bash_bg`. Run tests before committing.
- Every user-facing feature needs a `tests2/browser` journey (nav, happy path, reload, cleanup). See [docs/testing-strategy.md](docs/testing-strategy.md), [docs/testing-coverage.md](docs/testing-coverage.md), [docs/testing-v2/](docs/testing-v2/).

## Git conventions

Primary branch is **`master`** (not `main`). Never create a `main` branch.

**Line endings**: LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows: set `git config --global core.autocrlf false`.

**Worktrees**: dev server runs from the **primary worktree** on `master`; sessions use separate worktrees under `<project-root>-wt/<branch>/`. Always edit files in your session worktree, never the primary one. For infra files: edit here → commit → push → `cd <primary-worktree> && git pull origin master` (pushing to remote `master` does NOT update the dev server).

**Forks**: open PRs against the fork's `master`, not the upstream repo.

Worktree details: [docs/dev-workflow.md](docs/dev-workflow.md).

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. Keep it small and general.

- **No specific recipes or debugging entries.** Symptom→fix lookups belong in `docs/debugging.md`; how-to-do-X belongs in the relevant `docs/<topic>.md`. Agents discover them via the "Before editing" search step above.
- **No invariant prose pretending to prevent regressions.** Write the test that pins it instead.
- Keep this file under ~5 KB. If it grows, the new content probably belongs in `docs/`.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/logging.md](docs/logging.md) · [docs/dev-workflow.md](docs/dev-workflow.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/nested-goals.md](docs/nested-goals.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md) · [docs/extension-host-authoring.md](docs/extension-host-authoring.md)
