# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Build server + UI
npm run dev:harness    # Gateway + vite dev
npm run restart-server # Rebuild & restart after server changes
npm run check          # Layout + type checks
npm run test:layout    # Validate test conventions
npm run test:new -- <semantic> <name> # Scaffold canonical test
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
- **MCP / tools**: `src/server/mcp/`, `defaults/tools/<group>/` (project overrides under `.bobbit/config/tools/<group>/`). Descriptions budget-pinned by `tests/unit/core/tool-description-budget.unit.test.ts`.
- **Skills**: `.claude/skills/<name>/SKILL.md`.
- **Roles/tools/skills resolution**: unified `PackResolver` over one ordered pack list in `src/server/agent/pack-*.ts`; built-in packs in `market-packs/`. See [docs/marketplace.md](docs/marketplace.md).
- **UI shell**: `src/app/` — state, render, message-reducer, dialogs, follow-tail.
- **UI components**: `src/ui/` — components, `tools/renderers/`, `lazy/`.
- **Tests**: canonical directory plus semantic suffix determines runner ownership. See [docs/testing-strategy.md](docs/testing-strategy.md).
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. **`rg "<symbol-or-symptom>" docs/ tests/ src/`** — read design, rationale, and pinning-test hits before coding.
2. **Look for a pinning test.** Fix broken invariants, not tests; add missing regression coverage.
3. **Search for "never reintroduce" / "single source of truth" / "pinned by"** near the code.
4. Search **`docs/debugging.md`** by symptom before guessing.

## Engineering principle

Treat every new branch, state owner, transformation, API, or abstraction as defect surface: prefer composing existing well-tested code when its contract, ownership, and lifecycle fit, but do not force reuse or mechanical DRY across unrelated semantics.

## Testing

- **Test authoring** — use `npm run test:new -- <semantic> <name>`; runnable suites belong only in canonical `tests/{unit,dom,integration,browser,e2e,manual}/` destinations, where directory plus semantic suffix owns the runner and `test:layout` fails closed elsewhere. See [docs/testing-strategy.md](docs/testing-strategy.md#test-placement-and-automatic-discovery).
- **Test support** — put imported-only fixtures, data, helpers, harnesses, templates, and package fixtures in the purpose-first `tests/support/` topology; support code must not use a runnable suffix. See [docs/testing-strategy.md](docs/testing-strategy.md#test-placement-and-automatic-discovery).
- **Test isolation** — every automated coordinator owns its run root; qualify retry-free. See [docs/testing-v2/cross-os-test-authoring.md](docs/testing-v2/cross-os-test-authoring.md).
- Isolate only via the harness temp dir — never touch `.bobbit/`. **Never bg-server from bash** — use `bash_bg`. Run tests before committing.
- **Never junction/symlink a worktree's `node_modules` into a shared or primary tree.** See [docs/testing-v2/node-modules-corruption-rca.md](docs/testing-v2/node-modules-corruption-rca.md).
- Every user-facing feature needs a canonical browser journey covering navigation, happy path, durable reload, and cleanup. See [docs/testing-strategy.md](docs/testing-strategy.md#test-placement-and-automatic-discovery).

## Git conventions

Primary branch is **`main`** — verify with `git symbolic-ref refs/remotes/origin/HEAD`; never assume `master` (a stale divergent `origin/master` still exists and gives the wrong base).

**Line endings**: LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows: set `git config --global core.autocrlf false`.

**Worktrees**: dev server runs from the **primary worktree** on `main`; sessions use separate worktrees under `<project-root>-wt/<branch>/`. Always edit in your session worktree, never the primary one. For infra files: edit here → commit → push → `cd <primary-worktree> && git pull origin main` (pushing to remote `main` does NOT update the dev server).

**Forks**: open PRs against the fork's default branch (`main`), not the upstream repo.

See [docs/dev-workflow.md](docs/dev-workflow.md).

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. Keep it small and general.

- Put symptom lookups in `docs/debugging.md` and recipes in `docs/<topic>.md`.
- Pin invariants with tests, not prose.
- New detail usually belongs in `docs/`.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/logging.md](docs/logging.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/nested-goals.md](docs/nested-goals.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md) · [docs/extension-host-authoring.md](docs/extension-host-authoring.md) · [docs/support-assistant.md](docs/support-assistant.md)

**Driving the gateway from an agent**: prefer the `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tools over hand-rolled `curl` where their tool-groups are enabled. See [docs/bobbit-gateway-tool.md](docs/bobbit-gateway-tool.md).
