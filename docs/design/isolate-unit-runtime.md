# Cross-Suite Test Runtime Isolation

> **Test registry history notice:** All references to `tests2/tests-map.json` or `tests-map.json` in this document describe the completed pre-convention implementation. The registry has been deleted; those references are not current test-authoring instructions.

## Decision

Reconstruct only the coherent final-state reliability changes from
`796dd376cfa406f8e2fe2aba927de49088ef4009`; do not cherry-pick its historical
series or reuse PR #1068. This goal turns the existing unit-runtime extraction
into one isolation contract for unit, browser, integration, and legacy E2E
workflow coordinators running concurrently in the same worktree.

Every mutable test resource is owned by one coordinator run. The sole exception
is the explicitly captured machine-global concurrency ledger. A child may use
its coordinator's run root but never remove it or a sibling. Dist is a
worktree-shared publication and is protected separately by its own mutex.

## Boundaries

Included: owned roots and environment construction; Vitest and Playwright
wrappers; `ensure-dist`; legacy E2E harness, sweeper fixtures, Docker
namespacing; and focused test-side lifecycle/readiness corrections.

Excluded: the broad project path identity/case algorithm, verification
process-tree ownership/restart recovery, and broad product UI, session, or
terminal behavior. A production change is permitted only when it is the small,
direct ownership or lifecycle counterpart required for an extracted test to be
valid (for example Docker labels and a run suffix). Generic
project/workflow-command environments are not sanitized by this contract.

## Canonical run environment

`tests2/harness/run-isolation.ts` is the shared root and environment policy.
Before any Bobbit discovery/server import or owned child spawn, its coordinator
entry point:

1. captures `BOBBIT_V2_LEDGER_DIR` (or `<host-temp>/bobbit-test-v2-ledger`) and
   the installed `PLAYWRIGHT_BROWSERS_PATH` from the unmodified host;
2. creates and canonicalizes one `mkdtemp` root, then exports the generated
   `BOBBIT_V2_RUN_ROOT`, owner PID, and run ID; callers do not choose them;
3. creates only children of that root for `tmp`, `home`, `bobbit`, `agent`,
   `secrets`, `appdata`, `xdg`, browser profiles/transform cache, V8 cache,
   reports, output, sockets, databases, and artifacts; and
4. constructs the child environment from the sanitized snapshot, replaces
   owned roots with those canonical children, and preserves only the captured
   ledger and browser binary registry as machine-level inputs.

Set every relevant spelling: `TMPDIR`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`,
`BOBBIT_DIR`, `BOBBIT_PI_DIR`, `BOBBIT_AGENT_DIR`, `PI_CODING_AGENT_DIR`,
`BOBBIT_SECRETS_DIR`, `APPDATA`, `LOCALAPPDATA`, `XDG_STATE_HOME`,
`XDG_CONFIG_HOME`, and the owned Playwright/V8 cache variables. `PATH`, locale,
and explicit suite controls remain available.

`createRunChild()` and artifact helpers reject paths outside the canonical run
root. Only the process that allocated the root may call the root cleanup after
its reporters and children settle; worker cleanup is restricted to children it
owns. Failed coordinator roots remain as diagnostics; successful roots are
removed only by that coordinator. This contract applies equally to the Vitest
coordinator, `run-browser-v2.mjs`, `run-e2e-v2.mjs`, and
`run-playwright-e2e.mjs`. Nested legacy E2E receives a child root, never a
sibling cache or the outer coordinator's cleanup authority.

### Ambient-input policy

The sanitizer is shared by `tests2/harness/run-isolation.ts` and
`scripts/run-playwright-e2e.mjs`, and runs before imports **and** when copying a
child environment. It removes provider credentials plus ambient Bobbit runtime
and discovery controls, including `BOBBIT_BUILTIN_PACKS_DIR`,
`BOBBIT_GATEWAY_URL`, `BOBBIT_TOKEN`, session IDs/secrets,
`BOBBIT_GH_COMMAND`, and Bobbit command, adapter, CLI, and command-override
inputs. Matching is case-insensitive on Windows.

It preserves intentional `BOBBIT_TEST_*` and `BOBBIT_V2_*` controls unless a
name is itself a discovery/runtime input or a harness-owned root; the harness
then writes the canonical root/ledger values. A fixture that needs one of these
inputs supplies it in its local config or explicit child environment and
restores it. No fixture may depend on a developer shell value.

`tests2/core/run-isolation.test.ts` seeds credentials and every named ambient
input, proves removal in coordinators and child environments, proves Windows
case handling and preserved suite controls, and proves a fixture-local explicit
override remains visible only in that fixture.

## Suite wiring and data flow

### Unit and DOM

`vitest.config.ts` calls `installRunIsolation()` before server prebundle, test
collection, or discovery. Vitest forks inherit its root; coverage reports go to
an owned run child. The fixed worker cap and normal developer `retry: 3` remain,
but qualification always passes `--retry=0`.

`tests2/harness/gateway.ts` obtains per-gateway state through `createRunChild()`
and restores the run-owned HOME, Bobbit, agent, and secrets roots when a test
resets runtime singletons. Source-pack staging remains an explicit
`GatewayConfig` input, not ambient discovery.

`tests2/harness/v2-dom-environment.ts` obtains happy-dom's actual window through
`document[PropertySymbol.window]`, exposes and clears that window's local and
session storage on `globalThis`, then restores prior descriptors after each
test. It does not use `document.defaultView`, `window`, or `self`, which can
alias Node globals on Node 26.

#### Host-independent fixture contract

Mutable fixture trees are created below the active run by
`createRunChild()` (or passed as an explicit test-local path); fixtures never
consult a developer HOME, global Git config, network service, or checkout
state. `tests2/harness/git-template.ts` supplies the Git template with an empty
fixture HOME, `GIT_CONFIG_NOSYSTEM`, fixed identity, disabled maintenance, and
LF `.gitattributes`; `tests2/harness/with-env.ts` scopes and restores config and
credential overrides; and `tests2/harness/fenced-fetch.ts` permits only explicit
fixtures or loopback requests. Tests use injected runners, local `file://`
pack trees, or in-process loopback servers rather than host executables or
remote services.

Focused coverage keeps all required families host-independent: Git template
and line-ending behavior in `tests2/core/git-template-copy.test.ts` and
`tests2/core/gitattributes-lf.test.ts`; MCP stubs/local gateway behavior in
`tests2/core/marketplace-mcp-gateway.test.ts` and
`tests2/integration/mcp-meta-call.test.ts`; marketplace file-tree fixtures in
`tests2/core/marketplace-install.test.ts` and
`tests2/core/marketplace-source-builtin.test.ts`; temporary `SKILL.md` trees in
`tests2/core/skill-resolve.test.ts`; explicit temporary config roots in
`tests2/core/config-directories.test.ts` and
`tests2/core/project-config-store-native-yaml.test.ts`; scoped credential state
in `tests2/core/bobbit-tool-credentials.test.ts` and
`tests2/core/run-isolation.test.ts`; and canonical LF/CRLF text assertions in
`tests2/core/text-selection.test.ts`. Each regression seeds conflicting host
values where applicable, proves only its explicit fixture input is observed,
and restores process state before the next test.

### Browser and integration

`scripts/testing-v2/run-browser-v2.mjs` owns one browser coordinator root,
creates its JSON report and Playwright outputs beneath it, starts Playwright
with only `createBrowserRunEnvironment()`, waits for the Playwright reporter,
runs `assert-budget.mjs` against that exact report, then cleans only a passing
run root. A failure retains that root. `playwright-v2.config.ts` captures the
ledger/browser registry before worker imports, obtains the inherited run root,
and puts `outputDir`, its JSON report, and private transform/V8/profile caches
under owned artifacts. Coordinator roots and cache paths are internal outputs,
not caller-selected shared locations.

`scripts/testing-v2/run-e2e-v2.mjs` makes one equivalent coordinator environment
for Groups A through D. Groups A, C, and D inherit that environment; Group B
first removes outer cache variables and invokes `scripts/run-playwright-e2e.mjs`
to allocate a nested legacy root. It never re-merges `process.env` during
spawns. The nested wrapper removes only its own successful root, retains a
failed root, and retains a successful root when `BOBBIT_KEEP_PWTEST_CACHE=1`.
Both `playwright-v2.config.ts` projects and `playwright-e2e.config.ts` use
normal developer `retries: 3` and set retries to zero only when
`BOBBIT_V2_RETRY_FREE=1`; Group A has no retry mechanism.

Integration tests use the same Vitest owner and `tests2/harness/gateway.ts`;
they therefore receive the same roots and scrubber rather than inventing a
second integration environment.

### Legacy E2E and Docker

`scripts/run-playwright-e2e.mjs` owns the outer legacy root and creates its
`tmp/bobbit-e2e` compatibility child, home/config roots, secrets, reports, and
per-run Playwright transform cache before Playwright loads. `tests/e2e/gateway-harness.ts`,
`tests/e2e/in-process-harness.ts`, and
`tests/e2e/in-process-harness-realpush.ts` allocate worker state beneath that
root. `tests/e2e/e2e-teardown.ts` does not clean filesystems: the wrapper owns
run-root cleanup. It performs only Docker cleanup, discovering resources by the
generated `bobbit-e2e-run=<run-id>` label and accepting only matching validated
container/volume namespaces. It never sweeps a temp parent, checkout state, or
unlabelled Docker resource.

`src/server/agent/docker-args.ts` validates the E2E run ID and derives
`bobbit-workspace-<project>-e2e-<run>` and
`bobbit-worktrees-<project>-e2e-<run>` only for E2E; production names remain
unchanged. `src/server/agent/project-sandbox.ts` explicitly creates both
run-namespaced volumes with `bobbit-e2e-run=<run>` and project labels before
container creation, adds the run label to the container, and looks up an
existing container using both labels. Destruction and
`tests/e2e/e2e-teardown.ts` discover by that label and additionally validate
the name prefix/suffix before removal. This keeps creation and lookup atomic
for one run and ensures teardown can remove labelled volumes even if a test has
already removed its container.

#### Docker sandbox remount ownership

A sandbox remount/recreation (including `refreshAgentModelMount()` after an
atomic `models.json` publication, stale agent/state mounts, or a stale image)
uses the same validated `BOBBIT_E2E_RUN_ID` captured for that lifecycle
operation. While `ProjectSandbox` holds its lifecycle queue, it resolves the
current run's two namespaced volumes through `projectSandboxVolumeNames()` and
locates a reusable container with both `bobbit-project=<project>` and
`bobbit-e2e-run=<run>` filters. It must never fall back to a project-only
container or production volume when an E2E run ID is present. Before the
replacement `docker run`, `e2eSandboxVolumeCreateArgs()` explicitly creates (or
selects the already-created) current-run labelled volumes; the replacement is
then mounted only with those names and labels.

The queue serializes lookup, stale-container removal, labelled-volume creation,
and replacement creation as one ownership operation. Thus a concurrent
coordinator with the same project but a different run ID cannot be selected,
remounted, or destroyed. Teardown continues to enumerate by the run label and
accepts only its validated namespace, so a failed remount cannot broaden
cleanup. `tests/e2e/sandbox-recovery.spec.ts` adds the focused remount/run
ownership case: two run IDs for one project are seeded, an atomic model-file
replacement forces recreation for one run, and the observed Docker lookup and
mount names must remain that run's while the sibling-labelled container and
volumes survive. `tests2/core/docker-args.test.ts` and
`tests2/core/run-isolation.test.ts` pin the pure volume/label selection and
labelled teardown halves without requiring a daemon.

The narrow `src/server/agent/worktree-sweeper.ts` companion change canonicalizes
E2E fixture-owned aliases before classification, then rereads current ownership
synchronously immediately before repair or cleanup. Unknown aliases fail closed
for that sweep. It is not a general project-path identity redesign.

## Dist publication

`ensureDistBuild()` in `scripts/testing-v2/ensure-dist.mjs` is the only browser
and E2E dist reader/builder entry point, used by browser global setup and the
E2E coordinator. It hashes the complete build inputs and validates
`dist/.build-manifest.json` plus `dist/server/cli.js` and `dist/ui/index.html`.

A worktree-local mutex at
`.profiles/testing-v2/ensure-dist-build.lock` serializes **both readers and
builders**. An acquirer writes a tokenized exclusive acquisition intent, then
an exclusive PID/token lock. Stale recovery takes its own exclusive recovery
claim, drains or safely reaps dead intents, rereads the stale owner, and removes
only that dead token's lock. A waiter recomputes its key and validates only after
holding the lock; it consumes the first builder's valid publication instead of
rebuilding. Before a destructive build the old manifest is removed; after the
required artifacts exist, a temp manifest is renamed atomically. Thus no
consumer accepts a stale manifest paired with partial `dist` output.

`tests2/core/ensure-dist-build-key.test.ts` covers key inputs, cache hits,
reader/builder serialization, stale owners/acquisition intents, atomic
publication, and concurrent same-worktree consumers.

## Fixture reliability corrections

Only test/harness corrections with observable lifecycle ownership belong here:

- `tests2/browser/e2e/{source-vite-runtime-helpers,packaged-runtime-helpers}.ts`
  wait for concrete health/readiness and process close; their test-local cleanup
  starts while root ownership is live and does not target a departed numeric
  identity.
- `tests2/browser/e2e/terminal-pack.spec.ts` waits for terminal dispatch and
  close completion rather than a paste/sleep assumption.
- Browser source/packaged runtime specs observe route/hydration ownership and
  teardown completion rather than blind reloads or incidental fetch handlers.
- Proposal tests install a `MutationObserver` immediately before the action and
  await the exact mutation. `tests2/browser/e2e/tail-chat-real-stream.spec.ts`
  registers marker correlation before send, samples settled post-repin growth,
  and requires exact observed phases.
- Sidebar/font/focus tests assert semantic geometry/focus boundaries tolerant
  of platform metrics. Audio and badge tests await completion events. No test
  adds a sleep, polling loop, timeout increase, retry masking, skip, or weaker
  assertion.

Focused regressions live with those helpers/specs and in
`tests2/core/ensure-dist-build-key.test.ts`,
`tests2/core/worktree-sweeper-multi.test.ts`,
`tests2/core/docker-args.test.ts`, `tests2/core/run-isolation.test.ts`, and the
Docker-gated `tests/e2e/sandbox-recovery.spec.ts` remount case.
`tests2/core/run-isolation.test.ts` covers coordinator and nested-root
construction, environment scrubbing, Windows key handling, and retry-free
wiring. Only this goal's entries are added to `tests2/tests-map.json`.

## Qualification

`.github/workflows/build-unit-gate.yml` runs native Windows, Linux, and macOS
Node 22 plus Ubuntu Node 26, then builds, type-checks, and runs the standard
unit gate once. `tests2/core/build-unit-gate-ci.test.ts` pins that structure.
CI also runs the native matrix and CodeQL required by the goal.

Before publication run `npm run check`, then run the unit command and qualify
browser/E2E without retries:

```bash
npm run test:unit -- --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- --retries=0
BOBBIT_V2_RETRY_FREE=1 npm run test:e2e
```

In PowerShell, set the same control before each browser/E2E command:

```powershell
$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:browser -- --retries=0
$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:e2e
```

Also run three overlapping retry-free unit coordinators from separate
worktrees, and where resources permit two concurrent browser and E2E
coordinators. Verify each retained failure artifact is under its own run root,
concurrent same-worktree dist consumers never see partial output, and E2E
teardown removes only matching labelled Docker resources.

Document the ownership model and cross-OS authoring constraints in
`docs/testing-v2/cross-os-test-authoring.md`,
`docs/testing-v2/cross-os-unit-gate-design.md`, `docs/testing-v2/unit-gate.md`,
and `docs/testing-strategy.md`; retain only a one-line pointer in `AGENTS.md`.
