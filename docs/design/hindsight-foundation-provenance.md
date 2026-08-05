# Hindsight Foundation Provenance Audit

**Status: blocked — the claimed 20-commit source inventory is unavailable.** This appendix deliberately does not invent commit identifiers or classify nearby Hindsight history as the audited package.

## Audit boundary

The approved design names the source package, but not its individual generic-foundation commits:

| Field | Recorded value |
|---|---|
| Source root | `05158df267fd8635843a4e3ef1504e4a6b279f17` |
| Semantic reference tree | `60103cd8610b618574eba022a7d66e80be9ac6f0` |
| Final source head | `3207eb9fcd117e62fd82f8aeef82b5cea1a703ce` |
| Claimed bundle digest | `d3c5d24b96835607a7d4c97902e7a37bdc531f823a20dd685f2c1756294c81d9` |
| Claimed inventory | 20 generic-foundation commits, each mapped exactly once to GF-01…GF-10 |
| Design authority | `docs/design/service-extension-runtime.md` §7, committed as `4628ff7ec` |
| Original audit memo | `/Users/aj/Documents/dev/bobbit-goals-todo/hindsight-improvements.md` §3.2/§3.4 |

The original audit memo independently confirms the 37-commit linear series, the three anchors and bundle digest, and the 20-generic/17-feature split. It does **not** list the 20 individual SHAs, source paths, or assertions; it is therefore corroborating metadata, not a substitute ledger.

## Source availability evidence

The following checks were run from the H-3 worktree when this document was created:

| Source | Result | Consequence |
|---|---|---|
| Local object database — `git cat-file --batch-check` for all three source commits | Each object is `missing`. | The reference tree, parents, diffs, and commit messages cannot be inspected locally. |
| Cited directory — `/persist/code/bobbit-diffs/hindsight/safe-slice-a/` | Directory is absent. | No local bundle or ledger can establish the 20 SHA inventory. |
| GitHub commit search — `gh api -H 'Accept: application/vnd.github+json' 'search/commits?q=<sha>'` for each source commit | `total_count: 0` for each SHA. | The public remote does not expose these source objects. |
| Closed PR #820 — `gh api repos/G-Research/bobbit/pulls/820` | Reachable, but its base is `7459c10b…`, its head is `9f1e01ab…`, and its compare range has 254 commits. | It is a separate managed-runtime lineage, not evidence of the claimed 37-commit/20-generic source package. |

The design’s statement that this is a semantic reference rather than a cherry-pick series does not remove the requirement to identify every reference SHA. The 20 rows cannot be reconstructed from outcome descriptions, current code, PR #820, dangling objects, or commit-message similarity without fabricating provenance.

## Current-main comparisons that are independently verified

These are confirmed current contracts, not a substitute reference inventory.

| GF | Current implementation / landed commit | Exact registered regression IDs | Classification | Evidence |
|---|---|---|---|---|
| GF-01 | `73da91431468a43f549969dc6dbf3e1dbf813169` (#1106); `src/server/extension-host/pack-store.ts` exposes lossless `read`/`readSync` and preserves legacy lossy `get`/`getSync`. | `tests2/core/extension-host-pack-store.test.ts` — `createPackStore — UH-1 tri-state durable reads (reproducing contract)`: `reports only proven ENOENT as absent while retaining valid stored-empty values`; `reports injected EACCES as retryable I/O instead of false empty`; `reports injected EIO as retryable I/O instead of false empty`; `reports corrupt/truncated current envelopes as recoverable errors, never false empty`. `tests2/core/hindsight-provider.test.ts` — `retry queue: queue read failure rejects without replacing an unknown snapshot`; `unknown queue blocks both drains and status never reports it as empty`. | delivered independently | Source commit mapping remains unknown; these tests prove the #1106 boundary required by GF-01. |
| GF-02 | `4aba79b60fb29639f899f5451b5fea8eee221b8d` (#1091); `market-packs/hindsight/src/provider.ts` reports an unsuccessful durable enqueue rather than returning success. | `tests2/core/hindsight-provider.test.ts` — `UH-2: remote retain and queue persistence failure rejects with a sanitized diagnostic`; `retry queue: successful durable enqueue remains non-fatal`; `retry queue: failed error-record write does not negate a durable enqueue`; `retry queue: drain head keeps the durable queue unchanged when save fails`; `retry queue: shutdown drain keeps all durable entries when save fails`. | delivered independently | Source commit mapping remains unknown; these tests prove the #1091 boundary required by GF-02. |
| GF-03…GF-10 | No source SHA, source path, source assertion, or current-commit mapping can be stated truthfully until the source inventory is restored. | Not applicable until the matching reference assertion is available. | unresolved / GF-11 | The approved outcome labels are insufficient to identify one of 20 reference commits exactly once. |

`tests2/tests-map.json` registers both named core files (`tests2/core/extension-host-pack-store.test.ts` and `tests2/core/hindsight-provider.test.ts`) as `v2-core`/Vitest/core. The exact future GF-03…GF-06 test IDs and resulting implementation SHAs must be added only after their owners merge their work and the source assertions are available.

## Unresolved GF-11 inventory

| Expected entries | Identified entries | Missing entries | Blocking evidence required |
|---:|---:|---:|---|
| 20 | 0 | 20 | The authoritative bundle/ledger, or Git objects reachable from one of the three recorded source commits, containing each SHA plus its source path and assertion. |

Until that evidence is supplied, **GF-11 is non-empty**. This is intentional: marking GF-11 empty or attaching arbitrary Hindsight commits would falsely certify the finite provenance requirement.

## Completion procedure after source restoration

1. Verify the supplied bundle against the recorded digest and anchors above.
2. Extract the 20 generic-foundation SHAs from the authoritative ledger; reject duplicate or unclassified entries.
3. For every SHA, record its reference path/assertion, exactly one GF-01…GF-10 row, current-main comparison, classification rationale, resulting current commit(s), and exact registered `tests2` IDs.
4. Re-run the #1091/#1106 focused tests listed above and the GF-03…GF-06 tests introduced by the implementation owners.
5. Set GF-11 to empty only after the 20-row count and uniqueness check pass.
