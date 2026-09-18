# Cross-suite test runtime design

## Why this exists

The unit-runtime extraction is the reliability foundation for all automated workflow gates, not an isolated Vitest optimization. Unit, DOM, integration, browser, and legacy E2E coordinators can overlap in one checkout or on one machine. Their default user/config/cache locations otherwise collide, and timing fixes only hide that ownership bug.

The design assigns mutable state to one coordinator run. It complements the detailed [authoring rules](cross-os-test-authoring.md) and the [unit operating model](unit-gate.md).

## Run construction

Before Bobbit discovery, server imports, or child spawning, each coordinator:

1. captures the intentional machine-global ledger location and installed Playwright browser registry from the host environment;
2. allocates and canonicalizes one run root and records its owner process and opaque run ID;
3. sanitizes its inherited environment; and
4. replaces all owned temp, home, Bobbit/config, agent, credential, application-data, XDG, browser profile, cache, report, output, socket, database, and artifact roots with paths beneath that root.

The same policy is used by Vitest, the browser coordinator, the v2 E2E coordinator, and the legacy Playwright E2E wrapper. A nested legacy coordinator receives its own child root; it never receives a sibling cache or parent cleanup authority. Successful coordinator cleanup happens only after reporters and children close. Workers can clean their own children but cannot remove a coordinator or sibling root; failed roots remain for inspection.

The concurrency ledger is the sole machine-global **mutable** resource. It is captured before temp redirection so all coordinators share the same capacity accounting. All other mutable resources are run-owned. The Playwright browser registry is captured as a read-only installed dependency before HOME is isolated.

## Sanitized environment boundary

The shared policy starts from a copy of the host environment, removes credential families and ambient Bobbit runtime/discovery inputs, then writes canonical owned values. It denies pack discovery, gateway/session/token inputs, command adapters, CLI/command overrides, and GitHub command selection. On Windows, lookup, deletion, and replacement of environment keys are case-insensitive.

`BOBBIT_TEST_*` and `BOBBIT_V2_*` names remain available as deliberate suite controls unless they name denied ambient runtime input or a harness-owned root. A fixture can set an explicit local override after sanitization, but a harness-owned root always replaces it. Coordinators and child spawns must copy this prepared environment rather than merge `process.env` back in later.

## Suite-specific wiring

### Unit, DOM, and integration

Vitest installs run isolation before server prebundling, collection, and worker fork. Its transform and coverage output live below the root; integration gateways allocate their state through the same helper. The normal developer configuration may retain its configured retry behavior, while qualification explicitly runs retry-free.

The DOM project uses Node 26-safe happy-dom storage setup. It obtains the actual per-file happy-dom window through its owner symbol, installs that window's local and session storage on the runtime global, clears both for each test, then restores prior descriptors. This avoids Node-global aliases that are not browser storage.

Host-independent fixtures are part of the same contract: explicit fixture HOME/Git configuration and line endings; local MCP/gateway stubs; file-tree marketplace and `SKILL.md` fixtures; explicit config roots/YAML; scoped credential state; and canonical LF/CRLF assertions. Tests seed conflicting ambient inputs where relevant and prove their injected fixture input wins.

### Browser and E2E

Browser and E2E wrappers allocate an owned Playwright report/output/profile/transform-cache/V8-cache environment before Playwright loads. Browser global setup and E2E consumers enter `ensureDistBuild()` rather than reading or rebuilding `dist` independently. In a full E2E run, A and D use the coordinator environment directly; B then C run serially in a serial-cache environment under the same coordinator-owned root. B processes write distinct PID-scoped cache slots. After B exits, the coordinator creates a contained snapshot from completed slots, and each C process seeds its own fresh PID-scoped slot from that snapshot. No writable slot crosses a process or phase boundary. The B-only dist-prebundle setting is removed before the handoff and C start.

Focused B/C runs do not use that prebundle or handoff; they clear outer cache variables and invoke the nested legacy wrapper. The outer coordinator removes its successful full-run root after children and reporters settle and retains failures. `BOBBIT_KEEP_PWTEST_CACHE=1` applies only to the successful legacy-wrapper root. See the [safe-gains E2E close-out](../e2e-performance/speed-up-e2e-332a47cc/close-out.md) for performance evidence rather than inferring results from this lifecycle design.

`ensureDistBuild()` takes a worktree-local mutex for both readers and builders. It validates build inputs and required artifacts while holding the lock, handles stale owners and acquisition intent recovery with tokenized ownership, removes an old manifest before a destructive build, and atomically publishes a fresh manifest only after required artifacts exist. Concurrent consumers therefore use one valid publication rather than observing a partial build or rebuilding it destructively.

Legacy E2E harnesses create worker state below their coordinator root. Worktree aliases are checked against current ownership before repair or cleanup. Docker containers and volumes use the validated E2E run ID in names and labels; creation, lookup, stale removal, remount/recreation, and teardown require that same run/project ownership. A Docker remount is one queued ownership operation, so it cannot select or destroy another concurrent run's resources.

## Observable lifecycle rule

Tests wait for a named, externally observable lifecycle fact rather than elapsed time: server health, route/hydration readiness, a mutation registered immediately before the action, correlated stream markers and settled growth, process/terminal close, or media/focus completion. Cross-platform geometry assertions use semantic boundaries rather than exact font metrics.

Retry-free qualification establishes first-attempt reliability for every gate. Test authors must not add sleeps, polling, retries, skips, `force-exit`, timeout increases, blind reloads, or weaker assertions. When a test flakes, repair run ownership, fixture construction, teardown, or the precise event that demonstrates completion.
