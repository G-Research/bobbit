# Test Suite v2 — Legacy Inventory (Gate 1)

Machine-generated classification of every legacy test file into the v2 tier
buckets, plus the smoke-journey catalogue that consolidates the retired
browser-E2E specs. This document is the human-readable companion to
[`tests2/tests-map.json`](../../tests2/tests-map.json).

- **Generator:** `scripts/testing-v2/gen-inventory.mjs` (deterministic — re-run after any test add/remove/rename).
- **Validator (the gate):** `scripts/testing-v2/check-inventory.mjs` — exits non-zero on any orphan, phantom, duplicate, invalid bucket/method, or retired-without-replacement entry.
- **Shared census:** `scripts/testing-v2/lib-census.mjs` — enumerates `tests/**/*.{test,spec}.ts` exactly like the phase-invariant guard (`tests/test-phase-invariant.test.ts`): a recursive walk skipping `node_modules`.

Regenerate + validate:

```bash
node scripts/testing-v2/gen-inventory.mjs
node scripts/testing-v2/check-inventory.mjs   # must exit 0
```

## Census total: 1105 files

| Bucket | Count | Runner (target) | Migration method(s) |
|---|---:|---|---|
| `v2-core` | 499 | vitest, node env, `pool=forks`, `isolate:false` | codemod |
| `v2-dom` | 151 | vitest, happy-dom env | rewrite |
| `v2-integration` | 198 | vitest, node env, gateway-per-worker | adapter, codemod |
| `v2-browser` | 215 | Playwright, Chromium, `retries:0` | adapter, retire-with-mapping |
| `daily` | 42 | tier-3 daily lane (`npm run test:daily`) | relocate |
| **Total** | **1105** | | |

Per-method: `codemod` 500, `adapter` 259, `rewrite` 151, `retire-with-mapping` 153, `relocate` 42.

## Bucket boundaries & rationale

The generator applies these rules mechanically, in order, then a small curated
override set (see "Manual overrides" below).

1. **Curated daily overrides** (real-fidelity, see below) → `daily` / `relocate`.
2. **`tests/manual-integration/**`** → `daily` / `relocate`. The existing
   real-agent/LLM/Docker suite, already isolated; it simply moves under the
   tier-3 lane unchanged (13 files).
3. **`tests/contract/*.test.ts`** → `v2-core` / `codemod`, unless the file boots
   a real gateway (`createTestGateway`) → `v2-integration`. Only
   `gate-verification.test.ts` boots a gateway; `gateway-fixture.test.ts` is a
   pure-helper test.
4. **`tests/e2e/ui/*.spec.ts`** (184 browser E2E journeys):
   - Uses a precise geometry/interaction API (detector below) → **stays in
     Chromium** as `v2-browser` / `adapter` (31 specs).
   - Otherwise → `v2-browser` / **`retire-with-mapping`**, consolidated into one
     or more smoke journeys (153 specs).
5. **`tests/e2e/*.spec.ts`** (top-level API/integration) → `v2-integration` /
   `adapter` (gateway-per-worker).
6. **`tests/*.test.ts`** and any other `.test.ts` (node logic) → `v2-core` /
   `codemod`.
7. **`.spec.ts` browser fixtures** under `tests/`, `tests/search/`,
   `tests/ui-fixtures/` (file:// fixtures): geometry match → `v2-browser` /
   `adapter`; otherwise → `v2-dom` / `rewrite` (render under happy-dom).

### Geometry / interaction-API criteria

A `.spec.ts` fixture or an `e2e/ui` spec stays in a real browser (Chromium)
when the spec itself, its sibling `.html` fixture, or an explicitly referenced
`tests/**-entry.ts` / `tests/**.html` fixture uses an API-shaped real-browser
signal:

```
getBoundingClientRect() | .boundingBox() |
scrollTop / scrollLeft / scrollHeight / scrollWidth |
.scrollIntoView() / .scrollBy() / .scrollTo() / .scroll() |
ResizeObserver | IntersectionObserver | visualViewport | matchMedia |
getAnimations() | <canvas> / createElement("canvas") / HTMLCanvasElement |
CanvasRenderingContext2D / getContext() / toDataURL() / drawImage() |
mouse.wheel() | dataTransfer / dragstart / dragover / dragend / drop |
IME / compositionstart / compositionend / compositionupdate
```

Bare substrings such as `scroll` in prose, `canvas` in an unrelated identifier,
or `requestAnimationFrame` used only as a render-flush helper do **not** match.
Everything else is assertable against a rendered DOM without geometry, so it
moves to the far cheaper happy-dom (`v2-dom`) tier or is consolidated into a
journey.

## Smoke-journey catalogue (retired browser E2E → journeys)

The 153 non-geometry `e2e/ui` specs are consolidated into the following
multi-feature journeys. Journey assignment is deterministic (first-match keyword
rules in the generator); a spec may be reassigned by hand later. Every retired
spec names at least one journey — the validator enforces this and that each
journey ID exists in the catalogue. 31 journeys are defined; `journey-pr-walkthrough`
is currently unused because all PR-walkthrough `e2e/ui` specs use geometry APIs
and stay in Chromium — it is retained for the consolidated PR-walkthrough smoke.

| Journey ID | Domain | Retired specs |
|---|---|---|
| `journey-sidebar-nav-search-keyboard` | Sidebar nav/filters/search/keyboard/resize | 21 |
| `journey-project-onboarding` | Add-project, project management, splash | 13 |
| `journey-prompt-interaction` | Prompt send, at-mention, queue, steer/abort, tool/skill policy | 11 |
| `journey-proposals` | Goal/project proposal panel flows, revisions | 12 |
| `journey-stories-registry` | Story-registry driven UI stories | 7 |
| `journey-marketplace-packs` | Marketplace, packs, skills, extension host | 8 |
| `journey-staff` | Staff sidebar/roles/triggers/inbox/indicators | 5 |
| `journey-app-smoke` | Cross-cutting catch-all | 6 |
| `journey-goal-editing` | Goal create/edit/form/tabs/metadata | 5 |
| `journey-project-settings` | Settings cascade, system-prompt, agent-dir, maintenance | 5 |
| `journey-bg-wait-steer` | Background-process wait/steer flows | 4 |
| `journey-session-sharing` | Copy/open session link, new window/tab, page title | 5 |
| `journey-dashboard-fanout` | Dashboard fanout, mutation-pending, status widgets | 4 |
| `journey-crash-restart` | Restart/reconnect/resilience/persistence-across-reload | 5 |
| `journey-project-assistant` | Project/role assistant, reattempt/binding recovery | 4 |
| `journey-subgoals` | Subgoal create/nesting/parent-picker/toggle | 4 |
| `journey-notification-policy` | Notification policy, unseen activity, auto-retry, error modal | 4 |
| `journey-team-delegate` | Team delegate, child cascade, archived children | 4 |
| `journey-debug-tools` | Debug-mode, instant loader, tool renderers | 4 |
| `journey-workflow-editor` | Workflow editor/page, optional steps, gate status/bypass | 4 |
| `journey-preview-artifacts` | Preview panel, artifacts, image attach/model | 3 |
| `journey-compaction` | Compaction, pre-compaction history, persistence | 2 |
| `journey-cost-tracking` | Cost popover/cache, tree cost rollup, prompt stats | 3 |
| `journey-multi-repo` | Multi-repo flow and per-repo git status | 3 |
| `journey-session-lifecycle` | Session create/actions/status/fork/navigate | 2 |
| `journey-dynamic-panels` | Side/dynamic panel tabs, tab wiring | 1 |
| `journey-headquarters` | Headquarters view and staff inbox | 1 |
| `journey-mobile-layout` | Mobile layout smoke, mobile tabs, PWA lifecycle | 1 |
| `journey-goal-team-gates-verification` | Goal → team → gates → verification dashboard | 1 |
| `journey-review-commenting` | Review pane, inline comments | 1 |
| `journey-pr-walkthrough` | PR-walkthrough panel and pack | 0 (geometry specs kept in Chromium) |

The exact spec→journey assignment for every retired file lives in each entry's
`replacement` array in `tests2/tests-map.json`.

## Tier-3 daily lane (real fidelity)

42 files run in the once-daily tier-3 lane: 13 existing `manual-integration`
specs plus 29 curated real-fidelity relocations. These genuinely require real
subprocess / container / OS fidelity that **cannot** be faked in tier-1/tier-2,
and each was confirmed by reading the file:

**Real git worktree pool / lifecycle (unit):** `worktree-pool.test.ts`,
`worktree-pool-base-ref.test.ts`, `worktree-pool-multi.test.ts`,
`worktree-pool-nested-rootpath.test.ts`, `worktree-sweeper.test.ts`,
`worktree-idempotent.test.ts`, `worktree-set-polyrepo.test.ts`,
`unborn-head-worktree.test.ts`, `system-project-pool-leak.test.ts` — all run
real `git init` / worktree add/remove against real repos.

**Real spawned OS process trees:** `spawn-tree-shutdown-survival.test.ts`.

**Real docker/sandbox mount (unit):** `sandbox-mount-root.test.ts` (real
`git init` to compute mount roots).

**Real git worktree pool / continue-archived cluster (e2e):**
`continue-archived-worktree*.spec.ts` (×4), `continue-archived-multi-repo`,
`per-project-worktree-pool`, `pool-flow`, `pool-claim-restart-resume`,
`multi-repo-pool`, `unborn-worktree-session`, `worktree-root-override`,
`goal-archive-branch-cleanup` (real bare-repo branch cleanup),
`port-auto-increment` (real port race), `remove-boot-respawn-restart`.

**Real Docker container runtime (e2e):** `sandbox-recovery.spec.ts` (container health monitor, forced `docker rm -f`, recovery, and worktree/container validation).

**Real MCP subprocess (e2e):** `mcp-integration.spec.ts`, `marketplace-mcp.spec.ts`,
`mcp-tool-permission.spec.ts` (all spawn `process.execPath` MCP servers).

## Known edge cases / manual overrides

Filenames matching `sandbox|docker|worktree|spawn|mcp` are **not** automatically
daily. The following were deliberately kept in the fast tiers after reading
them, because they use mocks / injected git probes / canned command output /
pure functions rather than real subprocesses:

- **`worktree-inventory.test.ts`, `worktree-sweeper-multi.test.ts`** → `v2-core`.
  Pure classification of canned `git worktree list --porcelain` output.
- **`worktree-support.test.ts`, `worktree-paths.test.ts`,
  `session-worktree.test.ts`, `worktree-setup-fallback.test.ts`** → `v2-core`.
  Injected git probes / string math / static source-lint (no real git).
- **`docker-args.test.ts`, `docker-args-sanitize.test.ts`,
  `verification-docker-blast-radius.test.ts`, `verification-sandbox-exec.test.ts`,
  `project-sandbox-agent-dir-mounts.test.ts`, `sandbox-guard.test.ts`,
  `sandbox-*-auth.test.ts`, `sandbox-cpu-allocation.test.ts`,
  `sandbox-clone-source.test.ts`, `sandbox-restore.test.ts` (unit),
  `staff-sandboxed-persistence.test.ts`** → `v2-core`. Pure arg-building /
  predicate / mocked container init / source-string analysis; no docker daemon.
- **`team-manager-boot-respawn.test.ts`, `session-manager-respawn-provider-bridge.test.ts`**
  → `v2-core`. Use `node:test` mocks + temp fs, no real git spawn.
- **`continue-archived-clone.test.ts`** → `v2-core`. Cross-realm copy-error
  logic, no real git clone.
- **`mcp-meta-call.spec.ts`** → `v2-integration`. Boots the harness with
  `BOBBIT_SKIP_MCP=1`; constructs `McpManager` with seeded state, no real
  subprocess. **`marketplace-mcp-gateway.test.ts` /
  `marketplace-mcp-contributions.test.ts`** → `v2-core` (parse YAML, no spawn).
- **`gateway-fixture.test.ts`** → `v2-core` (pure polling-helper test), while
  **`gate-verification.test.ts`** → `v2-integration` (boots a gateway).
- **Former daily sandbox-keyword files moved to `v2-integration`:**
  `bg-process-sandbox-guard`, `host-agents-sandbox-inheritance`,
  `sandbox`, `sandbox-archive`, `sandbox-branch-reconcile`,
  `sandbox-delegate`, `sandbox-pentest`, `sandbox-persistence`,
  `sandbox-restore`, `sandbox-security`, and `sandbox-token`. Their headers or
  bodies state they use the in-process harness, mocks, REST/config/status checks,
  or Docker-unavailable/intercepted paths — not a real Docker runtime.
- **Re-audited browser false positives:** `bg-wait-timer.spec.ts` moved to
  `v2-dom` because it is a LiveTimer text fixture; `context-cost-stats.spec.ts`
  moved to `v2-dom` because `getContextTotalCostText` is a helper name, not
  canvas `getContext()`; requestAnimationFrame-only fixtures such as
  `render-debounce.spec.ts` and `streaming-message-container-set-message.spec.ts`
  moved to `v2-dom`. Non-geometry `e2e/ui` entries from the re-audit list now
  retire into their smoke journeys instead of staying as standalone Chromium
  specs.

To reclassify a file, edit the override maps at the top of
`scripts/testing-v2/gen-inventory.mjs` (`CLASSIFICATION_OVERRIDES`,
`DAILY_OVERRIDES`, `CONTRACT_INTEGRATION`, or the `JOURNEY_RULES`) and re-run
the generator — never hand-edit the JSON.

## Baselines

The measured baselines used by later parity gates already exist under
`docs/testing-metrics/` (`baseline-unit-node.json`, `baseline-unit-browser.json`,
`baseline-e2e-full.json`, `baseline-coverage.json`, plus e2e API/browser and
slice baselines). This gate does **not** modify or lower them.
