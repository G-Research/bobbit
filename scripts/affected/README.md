# Trustworthy affected Vitest feedback

`npm run test:affected` is the default local feedback command for unit-owned Vitest tests. It maps the effective Git change set to an auditable selection plan, reuses only valid local PASS results, and fails closed to the complete unit inventory when it cannot prove a smaller set is safe.

It is an optimization, not a merge gate. `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e` remain authoritative qualification. See the [unit gate operating model](../../docs/testing-v2/unit-gate.md) and [testing strategy](../../docs/testing-strategy.md).

## Usage

```bash
npm run test:affected
npm run test:affected -- --dry
npm run test:affected -- --base origin/main
npm run test:affected -- --changed src/ui/components/GitStatusWidget.ts
npm run test:affected -- --changed package.json --base HEAD
npm run test:affected -- --all --no-cache
```

The default command resolves the remote primary through `origin/HEAD`, computes its merge base with `HEAD`, and includes committed, staged, unstaged, and untracked changes. Use:

- `--base <ref>` to require a specific merge-base comparison. An invalid or shallow base is an error, never a zero-test result.
- `--changed <path,...>` to probe explicit repository-relative inputs. Add `--base <ref>` when semantic before/after content matters, such as `package.json`.
- `--dry` to print the plan without invoking Vitest.
- `--json` for the complete machine-readable plan and counts.
- `--no-cache` to disable local cache reads and writes.
- `--all` to request an explicit cache-bypassing full unit run.

Browser specs are reported as `browserAffected` only. Run them through `npm run test:browser`; the affected command never passes Playwright or E2E-owned files to Vitest.

## Plan and output contract

Every change produces one of three plans:

| Plan | Meaning | Cache |
|---|---|---|
| `SKIP-ALL` | Every changed input is known, unclaimed documentation; selected and executed counts are zero. | No verdict lookup is needed. |
| `BOUNDED` | The changed inputs have a nonzero or browser-only known dependency closure smaller than the unit inventory. | Eligible for per-file PASS hits. |
| `RUN-ALL` | A suite-wide input changed or the selector cannot prove a bound. Every unit-owned file is passed to Vitest. | Reads are bypassed, even if the cache is warm. |

A bounded plan whose every selected file has a valid PASS is displayed as `CACHE-HIT-ALL`; its underlying plan is still bounded. Human output deliberately distinguishes all cases:

```text
SKIP-ALL reason=..., selected=0, run=0
BOUNDED selected=X, cache-hit=H, run=R
CACHE-HIT-ALL selected=X, cache-hit=X, run=0
RUN-ALL reason=..., selected=<unit total>, cache=bypassed, run=<unit total>
```

`RUN-ALL` never means “select everything, then remove cache hits.” It bypasses cache partitioning and executes the complete authoritative inventory.

## Dependency model

`graph.mjs` takes runnable unit membership from `tests2/tests-map.json` through the same execution-map loader used by the full unit gate. It then builds one dependency closure from:

- transitive repository-local imports;
- safe, statically resolved repository file reads;
- Vitest-owned setup edges for the core, DOM, integration, and isolated projects;
- audited recursive scans, computed source readers, dynamic imports, workers, copied directories, and other indirect executable inputs;
- declared shipped-input owners and direct loader, policy, prompt, and budget canaries.

The declared shipped families include built-in role and tool YAML, tool policies and extensions, shipped skills, prompt/authoring inputs, marketplace packs, workflow templates, and committed config-cascade inputs. Repository inventory tests reject a new qualifying family with no owner, a family with no unit consumer, a missing canary, or an undeclared dynamic repository read. This is why Markdown such as `AGENTS.md`, a skill manifest, or a marketplace-pack README may select tests while ordinary documentation skips them.

The same `testDeps` closure drives both reverse selection and per-test content hashing. A non-code input therefore cannot select a test without also invalidating that test's cached PASS.

### Server and UI boundaries

Gateway-boot tests depend on the actual repository-source closure of the server runtime entry, not a `src/server/**` prefix. The resolver is shared with server prebundling, so an imported `src/shared/**` dependency selects gateway tests while unrelated server or UI sources do not gain that bucket merely by directory name.

DOM tests retain a declared UI-entry boundary. UI changes are bounded to the DOM and direct-reader closures, but the set can still be large because the application is coupled. Narrower domain-level attribution requires the separate production-domain extraction described in the [suite speed analysis](../../docs/testing-v2/suite-speed-analysis.md).

## Conservative whole-suite boundaries

The selector runs all unit tests and bypasses cache reads for:

- supported root lockfiles;
- root `tsconfig*.json` files;
- `vitest.config.*` and every repository source in its transitive configuration closure, including run isolation, environment policy, and reporters;
- affected-selector/cache implementation and shared unit-runtime resolver changes;
- a `package.json` execution projection change: dependency sets and peer metadata, overrides/resolutions, workspaces/package-manager topology, module type/imports/exports, runtime engines, and platform constraints;
- unavailable or malformed semantic before/after content;
- an execution-map algorithm change or unsupported ownership-table syntax;
- unresolved deletes, unresolved rename sources, invalid paths, and unknown executable or infrastructure inputs.

Package scripts, version/publication metadata, and similar non-execution fields are bounded to tests that consume `package.json`. A recognized data-only edit to the execution ownership tables selects the old/new named unit paths plus scheduling/inventory contract tests. `tests2/tests-map.json` ownership-record edits receive the same treatment. Algorithm edits fail closed.

Rename classification inspects both old and new paths. A known old dependency retains its attribution; an unknown non-documentation old side forces `RUN-ALL` rather than silently losing its former reverse edges.

## Local PASS cache

The checkout-local cache is `.profiles/test-cache/results.json`; it must never be uploaded, restored, or shared between jobs or machines.

A reusable record requires:

1. a `pass` verdict for that exact test file;
2. an unchanged hash of the test and its complete code/non-code dependency closure; and
3. the same runner fingerprint, including Node runtime identity, Vitest version, semantic package execution fields, lockfiles, TypeScript/Vitest configuration closure, execution-map ownership, selector/cache code, and the shared source resolver.

Verdicts are recorded per file. Passing siblings named by a failed batch remain reusable; named failures are removed. If a failed batch has no usable report, no selected file is certified. A zero-exit batch may certify all selected files even when its JSON report is unavailable because Vitest's process verdict covers the complete batch. Before Vitest starts, the runner snapshots the fingerprint and every selected dependency hash. It writes PASS only when those values are unchanged after execution, so a concurrent repository mutation cannot certify different bytes. Concurrent cache writers may lose an optimization, but they cannot turn an unverified result into a valid hit.

`RUN-ALL` does not read prior records. A successful full fallback may write fresh, post-validated per-file PASS records for later bounded runs. `--no-cache` disables both reads and writes and is the CI mode.

## CI and full qualification

Pull requests receive a separate Ubuntu/Node 22 affected-feedback job. Checkout uses full history, the job validates the explicit PR base SHA's merge base, and it runs:

```bash
npm run test:affected -- --base "$PR_BASE_SHA" --no-cache
```

This job is advisory fast feedback only. It has no persistent affected-result cache. The existing cross-platform build/type-check/full-`test:unit` job still runs on pull requests and pushes to the primary branch, and browser/E2E workflow gates are unchanged. Main and any periodic/nightly qualification must use the full authoritative commands, not local PASS records.

## Proof and correctness qualification

The fast historical proof computes selection plans over recent `origin/main` commits and the pinned acceptance sample:

```bash
npm run test:affected:proof -- 14 --json .profiles/affected-proof.json
```

It reports changed inputs, `SKIP-ALL`/`BOUNDED`/`RUN-ALL`, cache policy, selection time, and any graph-only diagnostic. It excludes skip, run-all, and zero rows from bounded averages. This is selection-only evidence; it does not execute historical tests.

A graph-only count shown beside `RUN-ALL` ignores broad triggers and is **non-executable**. In particular, PR #1071 changes `vitest.config.ts`, so its executable result remains `RUN-ALL` even when a static closure can be displayed for diagnosis.

The independent qualification is intentionally expensive:

```bash
npm run test:affected:correctness
npm run test:affected:correctness -- --only docs-only,ui-only
npm run test:affected:correctness -- --report .profiles/affected-correctness.json
```

For each immutable sample it creates one invocation-owned temporary root and detached worktree, runs a historical `npm ci`, compares the selected set with Vitest's native `--changed` observations, and runs the full retry-free unit suite. If the changed full run names failures, it lazily runs the clean parent/baseline and attributes only failures absent from that baseline. Required evidence is the union of directly changed unit tests, native-changed observations, and newly attributed failures. Any required file missing from the selection fails the qualification; over-selection is reported but allowed.

HOME, temp, Bobbit/config/secrets, npm cache, reports, and profiles are redirected below the owned root. Cleanup removes only that exact worktree/root in `finally`. The multi-sample command belongs in manual or periodic qualification because it performs installs and full unit runs per sample. Fast unit tests pin its comparator, report shape, failure attribution, environment isolation, and cleanup behavior.

## Limitations and maintenance

- Static resolution cannot infer arbitrary runtime data flow. Known indirect reads and scans must be declared; unknown infrastructure fails closed to `RUN-ALL`.
- Delete/rename precision is limited when the current graph cannot recover the old edge. Safety wins over selectivity.
- DOM and gateway boundaries remain broad, so many bounded plans still select hundreds of files.
- Browser selection is advisory and there is no affected E2E execution plan.
- The cache is an optimization for stable local inputs, not portable qualification evidence.
- Historical selection uses the current selector and graph rules; use the correctness harness for independent execution evidence.

When adding a shipped input family or a new computed/dynamic repository reader, add its production owner, direct canary, and inventory pin in the impact-rule registry. When changing execution ownership, preserve the data-only table shape or expect `RUN-ALL`. New tests still require registration in `tests2/tests-map.json` and must follow the [cross-OS authoring rules](../../docs/testing-v2/cross-os-test-authoring.md).
