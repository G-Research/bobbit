# E2E profiling and qualification manifests

The profiling seam is observational and opt-in. It adds a Playwright reporter and child-process telemetry through environment variables; it does not change test argv, group order, worker caps, retries, isolation, cleanup, or Docker/external-service handling.

## Identity

Every profile records two different SHAs:

- `sha` is the product revision being measured. For the baseline this must be `3a90cf55ab5226249529b00ecb874be4a79d5e54`.
- `instrumentationSha` is the checked-out revision containing the observational reporter. A baseline worktree may contain this profiling-only commit while still declaring the unchanged product baseline through `BOBBIT_V2_E2E_PRODUCT_SHA`.

Do not treat a profile as candidate evidence merely because its instrumentation SHA is newer. Qualification validation matches samples and profiles on product SHA, OS, and cold/warm state.

## Profile environment

Set these before the exact command:

```text
BOBBIT_V2_RETRY_FREE=1
BOBBIT_V2_E2E_PROFILE_DIR=<profiles>/<os>/<cold-or-warm>/<sample-id>
BOBBIT_V2_E2E_DIST_STATE=cold|warm
BOBBIT_V2_E2E_PRODUCT_SHA=<40-character measured product SHA>
```

Then run exactly:

```bash
npm run test:e2e
```

The runner writes `group-B.json` and `group-C.json` plus raw child-process and hook artifacts below the requested directory. Each group manifest includes per-spec wall time, lifecycle attribution, activity overlays, attempts/retries/failures, diagnostic group subtree CPU, peak process count, and `(pid, creation)` identities. The Playwright reporter first records attempt boundaries; after the phase process closes, the outer E2E coordinator rebuilds child and loopback-gateway overlays from exit-flushed artifacts. Unmatched child starts, missing gateway observations, or hook owners without an exit flush make the profile ineligible. Activity overlays may overlap lifecycle time.

Use `profile:build-cache:npm-lock-only` and `profile:build-cache:npm-ci` as the Playwright step labels for the two packaged-consumer npm phases. Both are attributed to `buildCache` without changing their command arguments.

A focused `--group` run is diagnostic only and is explicitly marked ineligible. Baseline/candidate qualification uses the full exact command.

## Cold and warm preparation

Provision Chromium and the Linux Docker image before measurement. Use one runner and sibling worktrees with the same setup fingerprint. Remove prior run roots/results before every sample and never share profile or bundle roots.

For a cold sample, remove `dist/`, its manifest, and `.profiles/testing-v2/ensure-dist-build.lock` before starting the prewarm meter. For a warm sample, run the following before either meter:

```bash
node scripts/testing-v2/ensure-dist.mjs
```

The measured lifecycle is always the unchanged packed-consumer prewarm followed by the exact command. The prewarm itself calls `ensureDistBuild()`. It therefore owns the cold build in a cold-state sample; the succeeding `npm run test:e2e` performs its own `ensure-dist` check as a post-prewarm cache hit. With the current lifecycle, a command-only meter cannot contain a cold build. Do not label that exact-command component a cold-build sample or omit prewarm to manufacture one.

Capture prewarm first on POSIX:

```bash
rm -rf dist
rm -f .profiles/testing-v2/ensure-dist-build.lock
node scripts/testing-v2/measure-subtree.mjs prewarm prewarm-meter.json -- node scripts/testing-v2/prewarm-packed-consumer-cache.mjs
```

Then set the retry-free profile identity and capture the exact command:

```bash
export BOBBIT_V2_RETRY_FREE=1
export BOBBIT_V2_E2E_PROFILE_DIR="docs/e2e-performance/speed-up-e2e-332a47cc/profiles/linux/cold/pair-01-baseline"
export BOBBIT_V2_E2E_DIST_STATE=cold
export BOBBIT_V2_E2E_PRODUCT_SHA=3a90cf55ab5226249529b00ecb874be4a79d5e54
node scripts/testing-v2/measure-subtree.mjs exact-command command-meter.json -- npm run test:e2e
```

The equivalent PowerShell sequence is:

```powershell
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Remove-Item -Force .profiles/testing-v2/ensure-dist-build.lock -ErrorAction SilentlyContinue
node scripts/testing-v2/measure-subtree.mjs prewarm prewarm-meter.json -- node scripts/testing-v2/prewarm-packed-consumer-cache.mjs
$env:BOBBIT_V2_RETRY_FREE = "1"
$env:BOBBIT_V2_E2E_PROFILE_DIR = "docs/e2e-performance/speed-up-e2e-332a47cc/profiles/win32/cold/pair-01-baseline"
$env:BOBBIT_V2_E2E_DIST_STATE = "cold"
$env:BOBBIT_V2_E2E_PRODUCT_SHA = "3a90cf55ab5226249529b00ecb874be4a79d5e54"
node scripts/testing-v2/measure-subtree.mjs exact-command command-meter.json -- npm run test:e2e
```

For warm samples, omit the removals and perform the explicit warm-state `ensure-dist` preparation before the prewarm meter. In both states, measure prewarm and the exact command separately so the sample proves:

```text
totalSubtreeCpuMinutes = prewarmCpu + exactCommandCpu
```

The combined row includes both meters, so cold combined accounting includes the prewarm's build even though its exact-command component is post-prewarm. The sample manifest must retain both authoritative reports: `timing.prewarm` and `timing.exactCommand` each include their `rootProcess` and full `processes` list with both PID and creation identity. The derived `timing.combined` row names those two contributing meters, sums their CPU, and uses their combined wall boundary and maximum peak process count.

`measure-subtree.mjs` is the authoritative outer boundary. Its reports declare `accounting.authority=outer`, `boundary=spawned-command-subtree`, and `method=pid-creation-subtree`. The E2E runner's whole-run and per-group samplers are explicitly diagnostic because they exclude npm/ensure-dist wrappers; never compare, sum, or substitute their CPU values for the outer meters. A qualification sample marks its combined row `outer-derived` and names the prewarm and exact-command meters that contribute to it. Preserve the same setup fingerprint, committed capacity caps, retry-free requirement, Docker capability state, and zero-retry/zero-failure rules for both meters and every pair. The [safe-gains close-out](close-out.md) records the available diagnostics without claiming the missing qualification matrix.

Repeat at least three alternating baseline/candidate pairs for each state on Linux, Windows, and macOS. Store sample manifests under `samples/<os>/<cold|warm>/` and validate the aggregate with:

```bash
node scripts/testing-v2/e2e-qualification-manifest.mjs docs/e2e-performance/speed-up-e2e-332a47cc/qualification.json
```

The validator fails closed for incomplete B/C profiles, mismatched product SHA/state/OS, missing accounting, changed caps/argv, retries or failures, leaks, absent Docker/install evidence, increased median CPU, and candidate wall time at or above 300 seconds.
