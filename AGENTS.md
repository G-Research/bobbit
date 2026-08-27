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

UI changes hot-reload under `npm run dev:harness`; server changes require `npm run restart-server`. Run `npm run check` first. Sessions persist across restarts.

## Architecture map

Orient here, then `rg` for the symbol.

- **Server REST/WS**: `src/server/` — REST routing in `server.ts`, WS in `ws/`.
- **Agent runtime**: `src/server/agent/` — session lifecycle, store, project context. See [background processes](docs/bg-process-persistence.md).
- **MCP/tools**: `src/server/mcp/`, `defaults/tools/<group>/`; project overrides in `.bobbit/config/tools/<group>/`.
- **Skills**: `.claude/skills/<name>/SKILL.md`.
- **Pack resolution**: `PackResolver` in `src/server/agent/pack-*.ts`; built-ins in `market-packs/`. See [marketplace](docs/marketplace.md).
- **UI**: `src/app/` owns shell/state; `src/ui/` owns components and renderers.
- **Tests**: one convention-owned `tests/` root; placement and lane rules live in [docs/testing-strategy.md](docs/testing-strategy.md), with executable policy in `scripts/testing/layout-policy.mjs`.
- **Docs**: `docs/` (reference + design notes), `docs/design/` (per-feature design docs), `docs/debugging.md` (full diagnostic checklists), `docs/internals.md` (config cascade, sandbox, search, MCP).

## Before editing anything non-trivial

1. Run `rg "<symbol-or-symptom>" docs/ tests/ src/`; read design constraints and pinning tests before coding.
2. Preserve pinning-test invariants. Fix broken behavior, not the test; add missing regression coverage.
3. Search nearby comments for `never reintroduce`, `single source of truth`, and `pinned by`.
4. Search [debugging](docs/debugging.md) by symptom before guessing.

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

Verify the primary branch with `git symbolic-ref refs/remotes/origin/HEAD`; never infer it from another remote branch.

Use LF except for `*.cmd`/`*.bat`/`*.ps1` (CRLF). On Windows, set `core.autocrlf=false`.

Edit only in your session worktree. The dev server uses the primary worktree, which must pull changes after they are pushed. Fork PRs target the fork's default branch. See [dev workflow](docs/dev-workflow.md).

## Maintaining this file

Every agent turn loads this file. Keep detail in `docs/`, debugging in `docs/debugging.md`, and invariants in tests.

## Reference docs

[docs/internals.md](docs/internals.md) · [docs/debugging.md](docs/debugging.md) · [docs/logging.md](docs/logging.md) · [docs/testing-strategy.md](docs/testing-strategy.md) · [docs/architecture.md](docs/architecture.md) · [docs/goals-workflows-tasks.md](docs/goals-workflows-tasks.md) · [docs/nested-goals.md](docs/nested-goals.md) · [docs/rest-api.md](docs/rest-api.md) · [docs/preview-architecture.md](docs/preview-architecture.md) · [docs/mcp-meta-tools.md](docs/mcp-meta-tools.md) · [docs/qa-testing.md](docs/qa-testing.md) · [docs/extension-host-authoring.md](docs/extension-host-authoring.md) · [docs/support-assistant.md](docs/support-assistant.md)

**Driving the gateway from an agent**: prefer the `bobbit_read`/`bobbit_orchestrate`/`bobbit_admin` tools over hand-rolled `curl` where their tool-groups are enabled. See [docs/bobbit-gateway-tool.md](docs/bobbit-gateway-tool.md).
