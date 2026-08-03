# Independent `build:server` Emit Cache

## Decision

Add a build-only Node wrapper, `scripts/build-server.mjs`, and retain
`tsconfig.server.json` as the canonical, non-incremental configuration. The
wrapper invokes the repository-local compiler with the canonical config plus:

```text
node node_modules/typescript/bin/tsc -p tsconfig.server.json --incremental --tsBuildInfoFile .profiles/build-server.tsbuildinfo
```

`package.json` changes only the first command in the existing `build:server`
chain:

```text
node scripts/build-server.mjs && shx chmod +x dist/server/cli.js && shx rm -rf dist/server/defaults && node scripts/copy-defaults.mjs && shx rm -rf dist/server/builtin-packs && node scripts/copy-builtin-packs.mjs
```

The post-emit commands and their order remain byte-for-byte equivalent to the
current chain. `build` remains `build:packs && build:server && build:ui`; in
particular, packs are still built before they are copied. The wrapper forwards
compiler stdout/stderr and the compiler's non-zero exit status, so `&&` still
prevents chmod/copy work after a type error.

The build profile is private to emission:

- `.profiles/build-server.tsbuildinfo`
- `.profiles/build-server-state.json`

The state file is an atomically published JSON sidecar containing a schema
version, an input fingerprint, and the previous successful emitted-output list.
It is not named `check-server.tsbuildinfo` and is never read or written by
`npm run check`. The three check caches remain exactly:
`check-server.tsbuildinfo`, `check-web.tsbuildinfo`, and
`check-tests2.tsbuildinfo`.

## Why this design

| Candidate | Preserves canonical compiler policy and current post-emit chain | Handles deleted `dist`, deleted/renamed sources, interruption, and corruption | Decision |
|---|---|---|---|
| A dedicated `tsconfig.server.build.json` with incremental options | Yes, if it extends the canonical config, but adds a second config surface | No by itself: a retained buildinfo can cause TypeScript to emit no files after `dist` is deleted, and it does not retire removed-source artifacts | Reject |
| Add `--incremental --tsBuildInfoFile` directly to the existing `tsc` package command | Yes for ordinary successful builds | No: it has the same missing-output and stale-output failure modes, and cannot fingerprint package inputs or recover an interrupted state deterministically | Reject |
| Cross-platform Node wrapper plus command-line options | Yes: it runs the same local `tsc` against the same canonical config and leaves chmod/default/pack operations in their current shell chain | Yes: it owns only the distinct build profile, validates it before reuse, and reconciles emitted artifacts after success | **Select** |

A build-specific config would only move the two command-line flags; it provides
none of the required output-recovery logic. Keeping them in the wrapper is the
smallest design and keeps all compiler strictness, module, target, lib,
declaration, and source-map policy in one canonical config.

The wrapper must use Node `fs`, `path`, and `child_process`, not shell tests or
platform-specific cache commands. It invokes `process.execPath` with the
repository-local TypeScript binary, uses inherited stdio, and returns the
child's exit code/signal outcome. This keeps Windows, POSIX, npm, diagnostics,
and command ordering behavior aligned.

## Cache and output safety contract

Before invoking `tsc`, the wrapper parses the canonical config through the
installed TypeScript API to derive its actual source list and expected emitted
`.js`, `.js.map`, `.d.ts`, and `.d.ts.map` paths. It reads the previous
successful state only if its JSON and schema are valid.

It discards `build-server.tsbuildinfo` before compilation when any of the
following is true:

1. the buildinfo or state sidecar is absent, empty, malformed, or has an unknown
   schema;
2. the state input fingerprint differs; the fingerprint covers
   `tsconfig.server.json`, `package.json`, and `package-lock.json` bytes;
3. any currently expected TypeScript output is missing; or
4. any output recorded by the previous successful state is missing.

This explicit missing-output reset is required. On the measured baseline,
retaining a TypeScript buildinfo, deleting `dist/`, then rerunning the same
incremental compiler command produced zero files and no `dist/server/cli.js`.
The wrapper must therefore never treat buildinfo as proof that artifacts still
exist.

After a successful compiler exit, and only then, the wrapper removes outputs
recorded in the prior state that are no longer expected (the four artifacts for
a removed or renamed source). It never traverses or deletes copied
`defaults/` or `builtin-packs/`; the existing subsequent commands continue to
replace those trees. It then atomically replaces the state sidecar with the
new output list and fingerprint. A compiler failure does not publish a new
state and returns before chmod/copy work, exactly as the old `&&` chain did.

An interrupted process can leave a partial output tree, a partially updated
TypeScript buildinfo, or an old state record. The next invocation validates the
state/output set, discards the buildinfo on any inconsistency, emits a complete
tree, then publishes state only after reconciliation. A corrupt buildinfo or
state follows the same cold-recovery path. This is fail-closed: reuse can make
a build faster, never make it claim an absent artifact exists.

A source addition is included through the canonical config's normal include
patterns. A changed import or shared type is left to TypeScript's normal
incremental dependency invalidation. The expected-output calculation is from
that same parsed config rather than a duplicate glob, so its include/exclude
semantics cannot drift.

`npm clean` must remove both `dist/` and the two build-profile files. Repository
cleanup may instead remove `.profiles/` wholesale. Either form is safe: if a
user manually removes only `dist/`, the wrapper's missing-output check removes
the retained buildinfo before compiling. Check cleanup continues to remove only
its three check profiles, and cannot affect the build profile.

## Baseline measurement

These are fresh measurements of the actual `origin/main`
`5c7c2e4997ba78cb7c9268443a52a6427a97ca17` server compiler command, not the
historical check-cache roadmap numbers.

- Host: Apple M5 Max, 128 GiB RAM; macOS 27.0.0 Darwin arm64.
- Toolchain: Node 26.0.0, npm 11.12.1, TypeScript 5.9.3.
- Input revision: `origin/main` was the current checked-out ancestor; no source,
  config, or script changes were present.
- Timing method: a Node ESM harness called `spawnSync(process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"])` and
  measured each child with `process.hrtime.bigint()`. Each sample used a fresh
  compiler process. This measures the real TypeScript server emit, deliberately
  excluding the unchanged chmod/default-copy/pack-copy tail.
- Cold-output samples removed `dist/` before each trial. Warm samples retained
  the completed `dist/` tree and ran consecutively. `sync` is available, but
  macOS's `/usr/sbin/purge` needs administrator permission (`sudo -n purge`
  exited 1), so an unprivileged process cannot truthfully force a kernel page
  cache flush. “Cold” below means a cold output tree; ordinary source/dependency
  filesystem caching was not claimed to be cold.

| Group | Samples (seconds) | Median | Mean | Sample SD | Range |
|---|---:|---:|---:|---:|---:|
| Cold output tree | 9.036, 8.562, 6.925 | 8.562 | 8.174 | 1.108 (13.5% CV) | 6.925–9.036 |
| Warm filesystem/output tree | 6.945, 6.670, 6.688 | 6.688 | 6.768 | 0.154 (2.3% CV) | 6.670–6.945 |

The 1.874-second median difference is ordinary repeated-process/filesystem
warmness on the un-cached baseline, not an incremental-cache result. The
variation in the cold-output group is material; performance acceptance must use
fresh samples on the candidate revision rather than extrapolate these values.

## Deterministic contract extension

Extend `scripts/testing-v2/check-cache-contract.mjs` rather than weakening its
existing separation assertions. It continues to build an isolated archive of
committed HEAD, symlink the repository-local dependencies, and never mutate the
checkout. Rename its description if useful, but keep its check-only fixtures
and assertions intact. Add the following build-emit cases against a separate
fixture/repository copy:

1. **Static separation.** Assert the canonical `tsconfig.server.json` has no
   incremental or buildinfo setting; `check` retains its exact three-cache
   command; `build:server` uses the wrapper and does not name a check profile;
   and `build` still orders packs, server, then UI.
2. **Cold then warm.** Delete `dist/` and the two build-profile files, run the
   real `npm run build:server`, assert every source counterpart plus executable
   CLI/defaults/first-party packs exists, then run it again with profiles kept.
   Require a non-empty valid buildinfo and sidecar after both runs.
3. **Output parity.** On equivalent clean archive copies, run the legacy
   baseline command and the candidate command. Compare a sorted `dist/`
   manifest of relative path and SHA-256 (plus executable mode for `cli.js` on
   POSIX). It must prove unchanged paths, bytes, declarations, and source maps.
4. **Deleted `dist`.** Warm the build, delete all of `dist/`, then run the real
   build. Assert every expected TypeScript artifact and copied artifact is
   present; this specifically catches TypeScript's otherwise silent no-emit
   cache hit.
5. **Source graph changes.** Add a source, change an imported/shared type, and
   confirm the next compiler run sees the change. Delete and rename a source
   after warming; assert each old `.js`, `.js.map`, `.d.ts`, and `.d.ts.map` is
   absent and every remaining/new expected output is present. Include a broken
   changed import/type assertion for non-zero diagnostic propagation and verify
   the copy tail did not run.
6. **Input changes.** Change `tsconfig.server.json` to introduce a known error,
   and separately change `package.json`/`package-lock.json` fixture bytes.
   Assert the state fingerprint changes and the buildinfo is recreated; the
   tsconfig case must surface its diagnostic rather than reuse a warm result.
7. **Corruption and interruption.** Replace each profile file with empty and
   malformed data and verify the next build recovers a complete manifest. Use a
   test-only, opt-in wrapper fault point after successful `tsc` but before state
   publication to simulate interruption; its following ordinary build must
   reconcile a complete, stale-free tree.
8. **Check/build interleaving.** Warm `npm run check`, snapshot its three
   profiles, run a build, and assert those snapshots are unchanged. Snapshot the
   build profile, run check, and assert the build profile is unchanged. Include
   a build after a warm check and a check after a warm build.

Run the focused contract with:

```bash
node scripts/testing-v2/check-cache-contract.mjs
```

The implementation gate additionally runs `npm run check`, three cold and three
warm `npm run build:server` samples using the monotonic harness above, and the
cold/warm/manual deletion cases. No unit, browser, or E2E selection or
concurrency setting changes are part of this work.
