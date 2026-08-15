# Code Intelligence

Code Intelligence is an optional built-in pack for syntax-aware search, component-scoped graph queries, and declared language-server capability status. It helps agents narrow investigation without treating an index or a language declaration as proof. The pack is disabled by default so a server operator explicitly chooses where its tools and panel are exposed.

For implementation and ownership detail, see [the integration design](design/code-intelligence-integration.md), [AST structural search](ast-structural-search.md), [language LSP intelligence](language-lsp-intelligence.md), and [the Graphify correctness foundation](graphify-correctness-foundation.md).

## Enablement and the import boundary

Complete Add Project normally. v1 has no Code Intelligence decision in the import flow and does not infer enablement from detected files. This keeps importing a project separate from enabling optional tooling.

After import, go to **Marketplace → Installed** and enable **Code Intelligence**. This is a **server-scoped** built-in switch: it enables the pack's tools and panel for every project on that Bobbit server. It is not a per-project setting, does not install a toolchain, and does not start Graphify or a language server.

After enabling the pack, open a project session and visit `#/ext/code-intelligence`. **Load status** reads declared component status and bounded language evidence. Reloading preserves the server activation and route, but never starts an index build, installs a runtime, or changes an unavailable LSP into a ready one. Disable it using the same Marketplace switch; the pack's tools, provider, panel, and route disappear. Runtime cleanup is separately covered by linked-worktree tests.

## Three separate capabilities

| Capability | What it provides | What it does not provide |
|---|---|---|
| `ast_grep` | Read-only, syntax-aware matching in supported source languages. | Definitions, references, diagnostics, edits, or type-aware results. |
| Graph tools | Component-labelled relationship and impact leads. `graph_query` searches the code tier by default; `includeDocs: true` opts one query into the docs tier. | A current branch conclusion, a merged multi-repository graph, or source verification. |
| LSP | Declared read-only actions: definitions, references, hover, document/workspace symbols, and diagnostics when an exact worktree service is ready. | Automatic installation/startup, fallback to AST search, or host readiness as evidence of sandbox readiness. |

Detection is bounded and symlink-safe. It reports filename and root-marker evidence, but a marker alone does not prove a language server can run. A truncated scan is explicitly labelled; a language missing from that partial result is not proof of absence.

## Status and review workflow

The panel presents capability rows before graph status. Each detected language shows its structural-search state independently from its LSP state and named requirements. LSP states are honest: `disabled`, `requires-toolchain`, `ready`, `unavailable`, or `unsupported`. A language is `ready` only when explicit enablement, selected-runtime compatibility, and the exact project/component/canonical-worktree/service/version identity all match.

Graph status aggregates conservatively:

| Panel label | Meaning |
|---|---|
| **Current** | All published components are fresh. |
| **Updating** | At least one component is building and none is stale, failed, unpublished, or base fallback. |
| **Limited** | A component is using an explicit base fallback. |
| **Not current** | A component is stale, failed, or unpublished. |
| **No graph published** | No component has a published graph. |

A base fallback means the branch has no current graph; it uses the accepted base revision and may omit branch-only changes. A `stale` graph with `parent-advanced` retains its last accepted revision until rebuild, but is not current. A child never silently falls back to the primary branch.

Use the capabilities as leads, then verify the source:

1. Use the graph for breadth: candidate relationships, callers, or affected areas.
2. Use LSP only for precise navigation when its row says **Ready** in the active worktree.
3. Use `read` on every cited file and surrounding caller before changing or approving code.

A stale or base-fallback graph can help discovery, but cannot establish current impact.

> **Repository boundary:** `v1 has no cross-repo edges`. Component fan-out is not a merged graph: a result in one repository cannot prove a call into another.

## Language matrix

The pack language matrix is the source of truth for detection evidence, structural grammars, declared LSP servers, actions, and host/sandbox requirements.

| Languages | Structural search | LSP in v1 |
|---|---|---|
| Bash, CSS, Elixir, Haskell, HCL, HTML, JSON, Kotlin, Lua, Nix, PHP, Ruby, Scala, Solidity, Swift, YAML | Supported through declared ast-grep grammars. | Structural-search-only; no LSP server is declared. |
| TypeScript, TSX, JavaScript | Supported. | Declares TypeScript Language Server plus Node.js and TypeScript requirements. |
| Python | Supported. | Declares Pyright plus Node.js requirements. |
| Go | Supported. | Declares `gopls` plus the Go toolchain. |
| Rust | Supported. | Declares `rust-analyzer` plus the Rust toolchain. |
| Java | Supported. | Declares Eclipse JDT LS plus a Java runtime. |
| C and C++ | Supported. | Declares `clangd`. |
| C# | Supported. | Declares `csharp-ls` plus the .NET SDK. |

These are declarations, not an installation claim. LSP is dormant unless an operator explicitly enables the language and the platform supplies a compatible, managed service at the selected linked-worktree component root. The selected host and sandbox runtimes are evaluated independently; for example, Go can remain structurally searchable while a sandbox honestly reports missing Go and `gopls` requirements.

## Graph storage and Graphify availability

Graph candidates, artifacts, cache, and metadata are host-side and outside every checkout. The runtime validates an external candidate before publication and retains the last known-good graph if validation fails. It does not write `graphify-out/`, install a hook, or mount graph state into a sandbox.

Together, the linked-worktree and fixture contracts prove a real primary → parent-derived → child chain, direct-parent staleness, rejection of both fixed traps (`ANCHOR_MISMATCH` and `CORPUS_DRIFT`), external-only output, and zero successful-invocation Graphify worktree-guard calls. The linked-worktree proof also rejects a source symlink that escapes the component root.

Installed Graphify was unavailable in the captured environment (`python3 -c 'import graphify'` failed). The checked-in measurements are therefore **contract-fixture evidence, not Graphify performance**:

| Scenario (7 samples) | Base build p50/p95 | Clone p50/p95 | No-cluster delta p50/p95 | Query p50/p95 | Graph |
|---|---:|---:|---:|---:|---|
| Code-only (`src`) | 70.972 / 75.666 ms | 0.704 / 0.782 ms | 62.392 / 84.948 ms | 0.004 / 0.007 ms | 115 bytes, 4 nodes, 3 edges |
| Code-plus-docs (`src`, `docs`, `tests2`, `defaults`) | 59.575 / 63.726 ms | 0.778 / 0.838 ms | 62.138 / 65.240 ms | 0.003 / 0.004 ms | 178 bytes, 7 nodes, 6 edges |

The [linked-worktree measurement record](../tests2/fixtures/graphify-benchmarks/linked-worktree-contract.json) preserves the environment, seven samples per operation, zero guard calls, and the unavailable-installed-Graphify caveat. The smaller [harness record](../tests2/fixtures/graphify-benchmarks/harness-contract.json) separately records base 18.561 ms, clone 16.734 ms, no-cluster delta 18.448 ms, size 1.637 ms (3,177 bytes), and query 3.048 ms (44 matches) for its contract fixture. Do not label either record as installed Graphify performance.

## Verification evidence

The integration is covered by these focused tests:

- `tests2/browser/journeys/code-intelligence-integration.journey.spec.ts`: normal import without a pack decision; server-scoped keyboard activation; TypeScript/Go capability display; a real `ast_grep` query followed by `read`; reload; disablement; and `finally` cleanup.
- `tests2/core/graphify-harness.test.ts`, `tests2/core/graphify-runner.test.ts`, and `tests2/integration/graphify-harness-integration.test.ts`: pinned roots, validation, add/modify/delete/rename closure, fixed rejection traps, direct-parent staleness, and measurement-record integrity.
- `tests/e2e/graphify-linked-worktree.spec.ts`: a real Git linked worktree, no checkout-local output, containment, direct-parent stale rejection, and live worktree-guard telemetry.
- `tests2/core/language-lsp-matrix.test.ts`, `tests2/core/language-lsp-detection.test.ts`, and `tests2/integration/language-lsp-worktree.test.ts`: matrix asymmetry, bounded evidence, exact linked-worktree identity, primary-checkout escape rejection, and no LSP-owned cleanup state.
- `tests2/integration/language-lsp-docker.test.ts`: Docker-linked-worktree Go structural-search degradation with named missing requirements, no LSP process/state, and a clean checkout.
- `tests2/dom/code-intelligence-activation.test.ts`, `tests2/dom/code-intelligence-panel.test.ts`, and `tests2/core/code-intelligence-provider.test.ts`: activation disclosure, status-panel honesty/accessibility, and bounded provider guidance.

Run the full integration validation with:

```sh
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

The E2E tier supplies the linked-worktree and Docker coverage when the environment supports it.

## Parent-PR integration summary

- The default-off Code Intelligence pack now exposes the real `ast_grep` tool and a server-scoped status panel after import; it does not claim per-project import enablement.
- The panel shares declared graph and language status with bounded session orientation, preserves repository and stale/fallback boundaries, and requires source verification.
- Graph breadth, LSP precision, and AST matching remain separate; `v1 has no cross-repo edges` is persistent.
- Browser, linked-worktree, Docker, and fixture measurements provide the integration evidence. Installed Graphify remains explicitly unavailable, so checked-in timings remain contract-fixture data.
