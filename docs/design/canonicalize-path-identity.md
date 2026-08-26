# Canonicalize Path Identity

## Purpose and boundary

Extract only the cross-platform path identity and filesystem-confinement patch from `e3051de63cf611143a989f7928bd9f9a7ed9beae` relative to current `origin/main`. The implementation changes are limited to:

- `src/server/agent/project-registry.ts`
- `src/server/agent/resolve-project.ts`
- `src/server/agent/transcript-sanitizer.ts`
- `src/server/agent/worktree-inventory.ts`
- `src/server/agent/yaml-store.ts`
- `src/server/extension-host/path-guard.ts`
- `src/server/preview/path-guard.ts`

This explicitly excludes process-tree ownership and recovery, generic command environments, test-runtime isolation, workflow/session races, terminal drain, and unrelated server/UI work. `worktree-inventory.ts` remains lexically normalized and asynchronous in this slice; do not import synchronous identity probing into inventory scans. Cleanup ownership must retain its current fail-closed treatment of unseen or stale aliases.

## Path identity contract

`project-registry.ts` owns project identity. Add/export:

- `ProjectPathIdentityOptions`, `CaseSemanticsCacheRecord`, `CASE_EVIDENCE_ENTRY_LIMIT`
- `canonicalProjectPath(rootPath, options)`
- `createProjectPathIdentity(options)`

Choose `path.posix` or `path.win32` from the *input spelling*, not from the host: drive-letter paths and backslash UNC paths use `win32`; POSIX paths use `posix`; on POSIX, `//...` remains POSIX. A foreign dialect is normalized lexically only, so cross-host comparison is deterministic without probing an impossible host path. Native-dialect paths may use filesystem evidence.

Normalize with the selected API, retain a filesystem root, normalize separators to `/`, and fold case only when the relevant directory has proven case-insensitive behavior. Never globally lowercase POSIX paths or all Windows paths: a case-sensitive child may exist below an insensitive parent.

For native paths, walk upward from the requested path until `realpathSync` succeeds. Canonicalize that longest existing prefix, then append the unresolved suffix unchanged unless the existing parent proves it is case-insensitive. This supports missing planned project/worktree paths and macOS `/var` to `/private/var` aliases without resolving an attacker-controlled nonexistent suffix. If no prefix can be resolved, return dialect-preserving lexical normalization.

`ProjectRegistry` receives an optional `pathIdentity` in its constructor, defaults it with `createProjectPathIdentity()`, and uses it consistently in `assertRootPathAvailable`, `getByPath`, `findByCwd`, Headquarters detection, and provisional registration. `findByCwd` first rejects mixed dialects, then uses that dialect's `relative()` containment predicate; longest containing root wins. The predicate accepts equality or a relative child and rejects `..`, `..${sep}...`, and absolute relatives.

### Case evidence and cache safety

For an existing entry, toggle one alphabetic character and resolve both spellings. `lstat` identity (`dev` and nonzero `ino`) must match before treating the spellings as aliases; a missing alternate or different identity proves sensitivity. This handles APFS where `realpath` can preserve input casing and preserves case-paired entries on NTFS/POSIX.

For a missing suffix, use these bounded sources in order:

1. a fixed-size read-only directory sample (`CASE_EVIDENCE_ENTRY_LIMIT`, eight names), with the same alternate `realpath` plus exact `lstat` identity check;
2. when that is inconclusive, a caller-owned, unique temporary directory probe, removed in `finally`;
3. conservative spelling preservation when evidence is unavailable or inconclusive.

Cache only non-mutating, proven sensitive/insensitive evidence and key it by dialect/path plus a directory fingerprint. Read the fingerprint before and after discovery and publish only if it is unchanged. A probe is never cached; use its result only if the parent's `dev:ino` is unchanged across probe creation/removal. Unknown, unreadable, unwritable, zero-inode, replaced, and mixed-version directories must not cause folding or stale cache publication. Each lookup does constant/bounded I/O, never a full directory scan.

## Coupled containment behavior

- **`resolve-project.ts`**: replace one-shot realpath fallback with longest-existing-prefix canonicalization in `realOrResolved`; use `path.relative()` for `isSameOrDescendant`. This authorizes a persisted owned worktree through a legitimate `/var` alias while rejecting sibling-prefix confusion.
- **`transcript-sanitizer.ts`**: after an outside-root persisted `.jsonl` has passed regular-file, non-symlink, recognizable-content validation, record both its normalized lexical spelling and canonical real path in that policy's exact-file set. Read-only recovery accepts either form; sanitizer write/delete confinement does not expand.
- **`yaml-store.ts`**: `itemPath` rejects a relative result equal to `..`, starting `..${path.sep}`, or absolute. Do not use a string-prefix containment check.
- **`extension-host/path-guard.ts`**: require a candidate to be strictly inside either the lexical root or the root's realpath spelling *before* resolving the candidate. Then require its realpath to be strictly inside the canonical root. This permits `/var` aliases, rejects an in-root symlink escape, and rejects a mutable symlink lexically outside the pack even if it currently targets an in-pack file. A missing candidate is safe only after the spelling check; other resolution errors fail closed.
- **`preview/path-guard.ts`**: validate a missing asset against lexical `baseDir`, and an existing asset against canonical `baseReal`; both use `relative()` containment. Preserve 400 traversal versus 404 missing-file behavior and regular-file checks.
- **`worktree-inventory.ts`**: document/retain that inventory scans use asynchronous filesystem/Git probes and only lexical host-path normalization at their boundary. No new synchronous realpath or case-probe work belongs in this background traversal.

## Regression extraction

Copy only the directly coupled reference assertions, registered in the existing test map lanes:

- `tests/unit/core/project-registry-root-paths.unit.test.ts`: POSIX/drive/UNC dialects on every host; roots and separators; `/var`-style canonical aliases; existing and missing suffixes; sensitive, insensitive, and case-sensitive-descendant behavior; bounded read-only evidence; failed probe; cache invalidation; directory incarnation replacement; double-slash aliases; stale-alias-safe dedupe/containment.
- `tests/unit/core/project-registry-provisional-dedupe.unit.test.ts`: provisional and Headquarters dedupe under proven insensitive identity, and separation under sensitive identity.
- `tests/unit/core/extension-host-path-guard.unit.test.ts` and `tests/unit/core/preview-path-guard.unit.test.ts`: in-root, outside-root, canonical alias, missing, escaping symlink, and swapped outside symlink cases. Where link creation is unavailable, use a scoped `realpathSync` seam rather than skipping the security assertion.
- `tests/unit/core/transcript-sanitizer.unit.test.ts`: lexical/canonical trusted-file aliases, in-root symlink rejection, and CRLF transcript recognition before read-only trust.
- `tests/unit/core/component-path-traversal.unit.test.ts` and `tests/unit/core/project-preflight.unit.test.ts`: foreign separator/absolute component rejection and case-alias project preflight behavior.
- `tests/integration/gateway/base-ref-api.gateway.test.ts` and `tests/integration/gateway/project-ui-api.gateway.test.ts`: fixtures/assertions use canonical roots so API/base-ref expectations remain valid through TMPDIR aliases.

No tests from the reference's process ownership, runtime isolation, workflow/UI race, terminal, or command-environment clusters are included.

## Focused verification

Run `npm run check`, then the nine path-related core/integration files above with the project's retry-free Vitest invocation. Run the relevant registry/confinement tests repeatedly without retries, followed by the normal unit, browser, and E2E gates and native Linux, macOS, and Windows CI. Do not add skips, sleeps, polling, timeout increases, weakened assertions, or host-specific exclusions; unavailable symlink privileges require a narrow filesystem seam that exercises the production branch.
