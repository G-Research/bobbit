# Bobbit — Agent Guide

## Commands

```bash
npm run build          # Build server + UI
npm run dev:harness    # Gateway + vite dev
npm run restart-server # Rebuild & restart after server changes
npm run check          # Type-check server + web
npm run test:unit      # Vitest unit/DOM/gateway, fixed 3-worker cap
npm run test:browser   # Playwright fixtures + normal app journeys
npm run test:e2e       # Real Git/worktree/Docker/MCP/restart fidelity
npm run test:manual    # Real model/agent/external services; gate-exempt
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
- **Tests**: one convention-owned `tests/` root; placement and lane rules live in [docs/testing-strategy.md](docs/testing-strategy.md), with executable policy in `scripts/testing/layout-policy.mjs`.
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. **`rg "<symbol-or-symptom>" docs/ tests/ src/`** — design constraints, rationale, and pinning tests live there. Read the hits before coding.
2. **Look for a pinning test.** Tests enforce invariants, not prose. If you break one, fix the bug, not the test. If a regression isn't caught by a test, the missing test IS the bug; add it.
3. **Search for "never reintroduce" / "single source of truth" / "pinned by"** in source comments around what you're touching.
4. **`docs/debugging.md`** has full diagnostic walkthroughs indexed by symptom — search there before guessing.

## Engineering principle

Treat every new branch, state owner, transformation, API, or abstraction as defect surface: prefer composing existing well-tested code when its contract, ownership, and lifecycle fit, but do not force reuse or mechanical DRY across unrelated semantics.

## Testing

| Semantics | Canonical location | Lane |
|---|---|---|
| Pure or singleton-isolated unit | `tests/unit/{core,isolated}/` with `.unit.test.ts` or `.isolated.test.ts` | `test:unit` |
| DOM or in-process gateway | `tests/dom/**/*.dom.test.ts` or `tests/integration/gateway/**/*.gateway.test.ts` | `test:unit` |
| Deterministic Chromium fixture or visible journey | `tests/browser/{fixtures,journeys}/` with `.fixture.spec.ts` or `.journey.spec.ts` | `test:browser` |
| Real Git/worktree/process/API/browser fidelity | `tests/e2e/{node,vitest,api,browser}/` with its matching semantic suffix | `test:e2e` |
| Real model, agent, or external service | `tests/manual/**/*.manual.spec.ts` | `test:manual` only |
| Non-runnable shared support | `tests/support/{harnesses,helpers,fixtures,data,templates}/<lane>/` or lane-local `_helpers/` | imported only |

- Create tests with `npm run test:new -- <semantic> <name>`; there is no registry step. `npm run test:layout` rejects wrong directories, suffixes, runners, browser/API boundaries, duplicates, and orphans. See [docs/testing-strategy.md](docs/testing-strategy.md).
- Gate phases are `test:unit` → `test:browser` → `test:e2e`; qualify with `BOBBIT_V2_RETRY_FREE=1`. Every user-facing feature needs a normal browser journey covering navigation, happy path, durable reload, and cleanup.
- Every automated coordinator owns its run root. Use harness temp paths, never checkout `.bobbit/`; never background a server from shell—use `bash_bg`; never junction/symlink `node_modules` across worktrees. See [cross-OS authoring](docs/testing-v2/cross-os-test-authoring.md).

## Git conventions

Primary branch is **`main`** — verify with `git symbolic-ref refs/remotes/origin/HEAD`; never assume `master` (a stale divergent `origin/master` still exists and gives the wrong base).

**Line endings**: LF everywhere except `*.cmd`/`*.bat`/`*.ps1` (CRLF), pinned via `.gitattributes`. Windows: set `git config --global core.autocrlf false`.

**Worktrees**: dev server runs from the **primary worktree** on `main`; sessions use separate worktrees under `<project-root>-wt/<branch>/`. Always edit in your session worktree, never the primary one. For infra files: edit here → commit → push → `cd <primary-worktree> && git pull origin main` (pushing to remote `main` does NOT update the dev server).

**Forks**: open PRs against the fork's default branch (`main`), not the upstream repo.

See [docs/dev-workflow.md](docs/dev-workflow.md).

## Maintaining this file

AGENTS.md is loaded into **every** agent turn. Keep it small and general.

- **No specific recipes or debugging entries.** Symptom→fix lookups belong in `docs/debugging.md`; how-to-do-X in the relevant `docs/<topic>.md`. Agents find them via the "Before editing" search step above.
- **No invariant prose pretending to prevent regressions.** Write the test that pins it instead.
- Keep it small; new content usually belongs in `docs/`.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/logging.md](docs/logging.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/nested-goals.md](docs/nested-goals.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md) · [docs/extension-host-authoring.md](docs/extension-host-authoring.md) · [docs/support-assistant.md](docs/support-assistant.md)

**Driving the gateway from an agent**: prefer the `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tools over hand-rolled `curl` where their tool-groups are enabled. See [docs/bobbit-gateway-tool.md](docs/bobbit-gateway-tool.md).
