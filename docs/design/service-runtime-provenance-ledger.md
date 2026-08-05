# PR #820 provenance replay ledger

**Recorded:** 2026-08-05
**Base:** `55583bdc1` (`Correct Hindsight PR provenance plan`)
**Method:** each literal §2 source SHA was invoked individually and in listed order. Merge commits use `git cherry-pick -m 1`; feature commits use ordinary `git cherry-pick`. Source SHAs are provenance inputs; non-empty results name the reachable commits on the reconciled replay chain. The excluded old-master merges were not invoked.

This is an absorption ledger, not an endorsement of #820's old Compose-only/deployment-mode/UI design. `empty` means the invocation encountered a conflict and was deliberately reconciled to the current-main implementation or deferred scope; it is not a silently omitted source SHA. Legacy `tests/` layout files were removed rather than revived. Assertions retained from this inventory must be ported to registered `tests2/` coverage by the owning implementation slices.

| # | Source SHA | Parents | Invocation | Result | Conflict | Initial reconciliation disposition |
|---:|---|---:|---|---|---|---|
| 1 | `55adc255c0498155bdd61e49dcaa79f9b87da567` | 2 | `cherry-pick -m 1` | `00e7cdc22` | yes | Retained contained runtime contribution loading and descriptor/reference files; generic schema-2 validation supersedes the old runtime contract. |
| 2 | `1a8883d9fc468c44e4d09b32ddf5c555ccea26df` | 2 | `cherry-pick -m 1` | `92a090098` | yes | Retained isolated supervisor/reference implementation; rejected obsolete server REST wiring in favour of current gateway construction seams. |
| 3 | `966d20e4457cae85c202b9482f6f638ae9c6c699` | 2 | `cherry-pick -m 1` | empty | yes | Rejected deployment-mode/provider/UI branching; current scope context and mode-free contract are authoritative. |
| 4 | `f9f1f18ba2c5811d4d42e72293eca99450abaa97` | 2 | `cherry-pick -m 1` | empty | yes | Deferred private runtime panel work. |
| 5 | `1bece5624d63762da8afb6796268abbb4b420591` | 2 | `cherry-pick -m 1` | empty | yes | Deferred Hindsight agent tools. |
| 6 | `a942784d4799a46f217b4dbcdc8f06392d79a838` | 1 | `cherry-pick` | `3acacf162` | yes | Retained useful descriptor/readiness/image/data-plane reference changes; legacy tests removed. |
| 7 | `0b43d508a45d7bceaec6decb4f6ea7ca75e89961` | 1 | `cherry-pick` | `a4ca0e917` | yes | Retained read-only status/log and health timing behavior; rejected old server mode/remap endpoints. |
| 8 | `127a44cf49f959f39111080ba2d181536bfc9ec7` | 1 | `cherry-pick` | `ccba6d9a4` | yes | Retained read-only teardown/log safety changes; deferred panel and legacy tests. |
| 9 | `d522dd26d79c30132460e005d31dcc999a0d8ced` | 1 | `cherry-pick` | `ad5a5aba8` | no | Retained compatible registered `tests2` Node 26 timeout hardening. |
| 10 | `39eb11771e0fc20cf06c55c43c54ef4b97019d5d` | 1 | `cherry-pick` | empty | yes | Legacy test-layout-only change; current registered coverage remains authoritative. |
| 11 | `346b0e9b0d93bce532fa6124df4f514c06ef8b2b` | 1 | `cherry-pick` | empty | yes | Deferred legacy consent UI; read-only stop behavior is retained by row 8. |
| 12 | `157f4f2c19795d3df75199c90fc8986d5ef3a159` | 1 | `cherry-pick` | empty | yes | Current #1099 scope-context and provider behavior win over old runtime/tool coupling. |
| 13 | `8bb19b84c9dcc34198c8022aa880566f2340238a` | 1 | `cherry-pick` | empty | yes | Current scoped recall/provider behavior wins; old lifecycle coupling deferred. |
| 14 | `ea3f957244d307080ff82dae3601efc03b449e5d` | 1 | `cherry-pick` | empty | yes | Deferred old runtime UI identity/capability cache. |
| 15 | `7f9fce9b1c776150ba7726a0a32ade3f15911466` | 1 | `cherry-pick` | empty | yes | Rejected implicit/on-enable runtime start; explicit control is required. |
| 16 | `d0bc4358293142e6d7a856be2cdee14a88a28324` | 1 | `cherry-pick` | empty | yes | Rejected deployment-surface/provider mode coupling. |
| 17 | `6552422c461c875204fc57f6b7dcf94e754bb31c` | 1 | `cherry-pick` | empty | yes | Rejected raw-contribution deployment-surface branch; future supervisor resolves typed descriptors. |
| 18 | `083cd3143488d66a717017fab678128145784993` | 1 | `cherry-pick` | empty | yes | Superseded old managed-runtime documentation. |
| 19 | `cd0eddea994b25f8511ee5f03c7027795e222313` | 2 | `cherry-pick -m 1` | empty | yes | Deferred UX child integration; preserved current durable/session behavior. |
| 20 | `06e49da1ef8b64aef664fe85cef6a917ac7e9e1c` | 1 | `cherry-pick` | empty | yes | Current Hindsight client/provider bounds win. |
| 21 | `f32685dcdc696d7028fed04122a059bc56c4a406` | 1 | `cherry-pick` | empty | yes | Current recall limit behavior wins. |
| 22 | `e68904e4928940a4d2d90eba11a232356bbce250` | 2 | `cherry-pick -m 1` | empty | yes | Deferred old Marketplace/panel integration. |
| 23 | `429647d3a95478d5e04bcb5221e1f3aa4e455fca` | 1 | `cherry-pick` | empty | yes | Current session-menu migration already owns entrypoints. |
| 24 | `537b878c74c1e6973490f9f65f8b7b19e3c581e4` | 1 | `cherry-pick` | empty | yes | Legacy panel E2E layout removed. |
| 25 | `9ddfccdcb9476083f847e1fb1b2ddaa18d5957b2` | 1 | `cherry-pick` | empty | yes | Current activation/store semantics win. |
| 26 | `7d2b051e8ef3485a687d12097ad27e77dbfdfab1` | 2 | `cherry-pick -m 1` | empty | yes | Deferred Marketplace UI merge. |
| 27 | `0557a9b17d3b5225ee1de78b1f69806571acb8bf` | 2 | `cherry-pick -m 1` | empty | yes | Deferred old runtime UI integration. |
| 28 | `30686ca90c50bd7c698b147f1c020421e082779a` | 2 | `cherry-pick -m 1` | empty | yes | Deferred memory-v2/tools/panel integration. |
| 29 | `ec15bc0b51119cf5b23750db15666fb7f2e82b6c` | 1 | `cherry-pick` | empty | yes | Current Hindsight client error/bound handling wins. |
| 30 | `dc040696c8936e3f939ece4aff0dd00817e2a2b8` | 2 | `cherry-pick -m 1` | empty | yes | Deferred memory surface/dashboard integration. |
| 31 | `ff8342bac403f7f7ea891ccd3da51993f2e783e1` | 1 | `cherry-pick` | empty | yes | Legacy dashboard E2E layout removed. |
| 32 | `cbef9bc281498f1cc17162a3ccbdfa288fc89a5c` | 1 | `cherry-pick` | empty | yes | Deferred dashboard UI. |
| 33 | `767ab4f542d3445350b3634305d71e58543fb380` | 2 | `cherry-pick -m 1` | empty | yes | Deferred memory-v2 integration; current lifecycle and #1099 scope behavior retained. |
| 34 | `35ce99587c2e719dab2bc843c27fd98291ffd8e4` | 1 | `cherry-pick` | empty | yes | Current #1106 durable failure/read semantics remain authoritative. |
| 35 | `83e279db85be72b000ac18b69a5d85962b0a09c0` | 1 | `cherry-pick` | empty | yes | Legacy E2E layout removed. |
| 36 | `6b4188c9042d541637e469e2a9251d8e895b6ea2` | 1 | `cherry-pick` | empty | yes | Deferred private configuration UI. |
| 37 | `44eaceb3e6ec93b1245de719061ab53e09c96011` | 2 | `cherry-pick -m 1` | empty | yes | Deferred agent-tool scope guidance. |
| 38 | `a084cf344a0b6fc259fa09b63aa1388e53e04e34` | 2 | `cherry-pick -m 1` | empty | yes | Deferred retain auto-tags/tool integration. |

## Reconciliation checkpoint

The retained #820 code is an assertion/reference inventory only. Follow-on runtime slices must replace the old `src/server/runtime`/`src/server/runtimes` Compose-specific contract with the public `src/server/service-runtime` nucleus described in `service-extension-runtime.md`; no consumer may acquire a provider mode branch or a lifecycle-starting read path during that transition.
