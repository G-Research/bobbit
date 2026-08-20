# Independent `build:server` Emit Cache

`build:server` now has a persistent TypeScript emission cache without changing the
canonical server compiler policy or sharing the cache used by `npm run check`.
The cache makes repeated server emits fast while treating emitted files—not a
buildinfo file—as the source of truth.

## Design

`tsconfig.server.json` remains non-incremental. The build-only wrapper at
`scripts/build-server.mjs` invokes the repository-local compiler with these
build-only options:

```text
node node_modules/typescript/bin/tsc -p tsconfig.server.json --incremental --tsBuildInfoFile .profiles/build-server.tsbuildinfo
```

The package script retains its post-emit work and fail-fast order:

```text
node scripts/build-server.mjs && shx chmod +x dist/server/cli.js && shx rm -rf dist/server/defaults && node scripts/copy-defaults.mjs && shx rm -rf dist/server/builtin-packs && node scripts/copy-builtin-packs.mjs
```

`npm run build` remains ordered as `build:packs && build:server && build:ui`.
Therefore packs are still built before their copy step, the CLI still receives
its executable mode, and defaults and built-in packs are still replaced after
TypeScript emits. The wrapper inherits compiler output and propagates its exit
code or signal. A compiler failure consequently preserves the old `&&` behavior:
it prevents chmod and both copy steps from running.

A dedicated build config or direct incremental flags in the package script would
not be sufficient. TypeScript can legitimately reuse buildinfo after `dist/`
has been removed, which can result in no files being emitted; neither alternative
can retire artifacts from a removed source. The wrapper is the smallest
cross-platform design that can validate and reconcile the output tree while
leaving compiler strictness, module, target, lib, declarations, source maps, and
source selection in the canonical config.

## Separate profiles

The build emitter owns only these ignored files:

- `.profiles/build-server.tsbuildinfo`
- `.profiles/build-server-state.json`

The state sidecar is atomically published after a successful compiler run. It
contains a schema version, a fingerprint of `tsconfig.server.json`,
`package.json`, and `package-lock.json`, the buildinfo fingerprint, and the
previous successful emitted-output list.

Checks retain exactly their existing independent profiles:

- `.profiles/check-server.tsbuildinfo`
- `.profiles/check-web.tsbuildinfo`
- `.profiles/check-tests2.tsbuildinfo`

`npm run check` never reads or writes either build profile, and `build:server`
never reads or writes a check profile. This separation prevents a retained
analysis-only cache from suppressing an emit and ensures build activity cannot
change the web or `tests2` check state.

## Recovery and confinement

Before invoking TypeScript, the wrapper parses the canonical server config with
the installed TypeScript API. That produces the authoritative source list and
expected `.js`, `.js.map`, `.d.ts`, and `.d.ts.map` paths—there is no duplicate
include glob to drift from the compiler. It validates every existing output-tree
component before TypeScript can write: a linked `dist`, expected-output parent,
or expected-output leaf hard-fails before TypeScript emission.

The buildinfo is discarded and the invocation cold-recovers when the buildinfo
or sidecar is missing, empty, malformed, schema-incompatible, fingerprint
mismatched, or inconsistent with current or previously recorded outputs. In
particular, a warm `npm run build:server` after manually deleting `dist/` emits
the complete TypeScript tree again; the normal copy tail then restores defaults
and built-in packs. Corrupt profiles and an interruption after `tsc` but before
sidecar publication take the same safe recovery path. A failed compiler run
never publishes a new successful sidecar.

A missing, malformed, or otherwise unrecoverable sidecar has no trustworthy
manifest of old outputs. Before the cold emit, the manifest-free reset scans
stable, canonical configured output/include roots without following symlinks,
junctions, or other reparse points, including when an entire included source root
has become empty. It preserves copied trees and current expected files (including
their existing modes), while removing obsolete artifacts so deleted or renamed
sources cannot survive merely because no prior manifest is available.

After a successful emit, the wrapper retires recorded outputs that are no longer
expected. Deleting or renaming a TypeScript source therefore removes its former
`.js`, `.js.map`, `.d.ts`, and `.d.ts.map` artifacts. It does not retire files
under the copied `defaults/` or `builtin-packs/` trees; those remain owned by
the existing copy commands.

The sidecar is untrusted input. Before treating a recorded output as safe, and
again immediately before destructive stale-output cleanup, the wrapper verifies
lexical containment and the physical output tree. A linked `dist`,
expected-output parent, or expected-output leaf hard-fails before TypeScript
emission; recorded-output paths receive the same no-reparse-point check before
cleanup. This prevents a link inside `dist/` from redirecting emission or
stale-output removal outside the physical output tree. An unsafe or unprovable
state is not reused: the build profile cold-recovers without deleting the
external target; a stale removal that cannot be physically confined fails closed.

## Cleanup and manual reset

`npm clean` removes `dist/` and the two build profiles. It deliberately leaves
the three check profiles alone. To reset only server emission state manually on
all supported platforms, run:

```bash
npm exec shx -- rm -rf dist .profiles/build-server.tsbuildinfo .profiles/build-server-state.json
npm run build:server
```

Removing `.profiles/` wholesale is also safe; the next check and build recreate
only their own profiles. Removing only `dist/` is safe as well—the next server
build recognizes the missing artifacts, discards its retained buildinfo, and
rebuilds them rather than trusting a cache hit.

## Verification contract

Run the complete focused contract from a clean checkout:

```bash
node scripts/testing-v2/check-cache-contract.mjs
```

It uses isolated fixtures and an archive of committed `HEAD`, so it does not
modify the checkout. In addition to preserving the original check-cache
contract, it verifies:

- canonical non-incremental server config, exact check cache identities, build
  profile isolation, and unchanged `npm run build` order;
- cold and warm profile creation, output path/byte/mode parity with the legacy
  non-incremental emit, declarations, source maps, executable CLI, defaults,
  and built-in packs;
- a warm build after complete `dist/` deletion;
- source additions, deleted/renamed-source four-artifact retirement, changed
  imports/shared types, diagnostics, and fail-fast copy behavior;
- invalidation on server config, package manifest, or lockfile changes;
- empty/malformed buildinfo and state, the post-`tsc` interruption fault, and
  check/build interleaving snapshots; and
- physical stale-output containment through a symlink on POSIX or a junction on
  Windows, proving a poisoned sidecar cannot remove an external sentinel.

## Measurement record

The baseline was measured on `origin/main`
`5c7c2e4997ba78cb7c9268443a52a6427a97ca17`. The candidate was measured at
`8e1a6d701067808022b2acc06e41b7ffe2598b04` on Apple M5 Max, macOS 27.0 arm64,
Node 26.0.0, npm 11.12.1, and TypeScript 5.9.3.

Each sample used `process.hrtime.bigint()` around a fresh child process. The
baseline ran the repository-local direct command
`node_modules/typescript/bin/tsc -p tsconfig.server.json`; the candidate ran
`node scripts/build-server.mjs`. Both deliberately exclude the unchanged chmod,
default-copy, and built-in-pack-copy tail. Baseline cold-output trials removed
`dist/`; its warm trials retained it and ran consecutively. Candidate reset
trials removed `dist/` and both build profiles before every run; candidate warm
trials retained both and ran consecutively. No privileged macOS page-cache purge
was available, so “cold” means reset output/profile state, not a forced
kernel-cold filesystem.

| Revision and condition | Samples (s) | Median | Mean | Sample SD | CV | Range |
|---|---:|---:|---:|---:|---:|---:|
| Baseline direct `tsc`, cold output | 9.036, 8.562, 6.925 | 8.562 | 8.174 | 1.108 | 13.5% | 6.925–9.036 |
| Baseline direct `tsc`, warm filesystem/output | 6.945, 6.670, 6.688 | 6.688 | 6.768 | 0.154 | 2.3% | 6.670–6.945 |
| Candidate wrapper, reset output/profile | 17.077, 13.096, 10.306 | 13.096 | 13.493 | 3.403 | 25.2% | 10.306–17.077 |
| Candidate wrapper, warm cache | 2.182, 2.021, 2.050 | 2.050 | 2.084 | 0.086 | 4.1% | 2.021–2.182 |

Against the baseline medians, the candidate reset-profile result is 53.0% slower
and has high variance. That is not a like-for-like cache comparison: it includes
wrapper validation/reconciliation and was observed under different system state.
The candidate warm median is 69.3% lower than the baseline warm-filesystem
median, but this is an observed repeated-run result, not a claim that all of the
difference is incremental compilation work. The baseline’s 1.874-second
cold/warm gap already demonstrates ordinary process/filesystem warming; rerun
the method on the revision and machine under evaluation before making a
performance decision.
