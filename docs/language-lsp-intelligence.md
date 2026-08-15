# Language LSP Intelligence

## Status

The Code Intelligence pack contains a **dormant**, disabled-by-default language-LSP slice. It supplies pack-local declarations, bounded detection, status derivation, request validation, sandbox-requirement derivation, and six read-only tool *contracts*. When the Code Intelligence pack is enabled, its existing structural-search and graph tools plus status panel are live; this does **not** make the LSP contracts live. The LSP slice does not start a language server, install a toolchain, create an import offer, or expose a live LSP client.

The current post-import enablement is a server-scoped Marketplace switch, not a per-project or per-language decision. The enabled panel can display bounded language evidence and the derived LSP state, but it cannot turn detection into consent or readiness. This separation preserves truthful capability reporting while the Extension Platform adds the public settings, decision, and managed-service contracts that own activation and lifecycle. See [Code Intelligence](code-intelligence.md) for the user-facing status and review workflow, or [the design document](design/language-lsp-intelligence.md) for implementation ownership.

## Capability model

The pack-owned language matrix is the single data source for each language's:

- file globs, root-marker evidence, and minimum file count;
- structural-search declaration and ast-grep grammar, if any;
- optional LSP server command/arguments, supported read-only actions, and version constraint;
- separately declared host toolchain requirements and sandbox image-layer requirements.

Structural search and LSP are independent declarations. An ast-grep grammar only permits syntax-aware pattern matching; it does not provide definitions, references, hover information, symbols, or diagnostics. Conversely, an LSP declaration is not evidence that structural search is supported. Root markers help identify a component but never prove a server can start.

### Status meanings

| LSP status | Meaning |
|---|---|
| `disabled` | The language has an LSP declaration but has not been explicitly enabled. Toolchain and service readiness do not override this state. |
| `requires-toolchain` | An enabled language lacks one or more named, compatible requirements in the selected runtime, including required version evidence. |
| `unavailable` | The language declares LSP, but its managed service is absent, starting, stopped, failed, mismatched to the requested identity, or version-incompatible. It is never a fallback to structural search. |
| `ready` | Only a future platform integration may report this: all selected-runtime requirements must have compatible platform probe facts and a matching, compatible managed-service snapshot. |

Structural-search-only languages report LSP as `unsupported`; their structural-search status remains independently visible. The request contract can additionally report `starting` or `failed` where a future managed service supplies that fact.

## Detection and identity

Detection operates per configured component, using only matrix-declared filename and root-marker evidence. Its traversal is bounded, deterministic within the scanned portion, and symlink-safe. It neither executes an executable nor changes configuration or project files.

Every detection result includes component-local evidence. If the traversal reaches its budget, each result explicitly carries `evidence.truncated: true`; absence of a language from that partial result is therefore not proof that the component lacks it.

A prospective LSP request resolves a canonical linked-worktree component root and rejects absolute paths, traversal, symlinks, non-files, and paths outside that root. Its service identity is the exact combination of project, configured component, canonical linked-worktree component root, and language. A readiness snapshot for another project, component, worktree, language, server, or server version cannot establish `ready`. The primary checkout and a generic workspace root are not substitutes.

Toolchain availability is also runtime-specific. The capability adapter consumes bounded, platform-provided facts for the selected `host` or `sandbox` runtime: requirement ID, reported version when constrained, and compatibility. It does not inspect `PATH`, run a version command, or infer sandbox availability from a host probe (or vice versa).

## Inert LSP tool contracts

The pack defines contracts for `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols` (document or workspace), `lsp_diagnostics`, and `lsp_status`. They are read-only and validate component, language, file path, position, or symbol query as appropriate. Results are shaped as LSP results with a capability label, action, component, language, status, and bounded, sanitized reason.

These contracts are inert by default: without platform-injected linked-worktree context, no tool is registered. Even with test-injected context, the request adapter only validates and serializes a prospective managed-service request; it never launches or installs anything and currently returns `service-unavailable`. Diagnostics must come from a future service's published diagnostics; the contract must not invent a clean result.

## Sandbox requirements

For explicitly enabled, detected languages, the sandbox adapter derives generic, matrix-declared layer requirements. It deduplicates by declared layer identifier while retaining each language's attribution and reason. The result is data only: no shell command, Dockerfile fragment, mount, image mutation, or build invocation is produced.

A future integration may pass these declarations through the existing generic `buildSandboxImage` path after the platform accepts a general image-requirement contract. There is no LSP-specific sandbox build or toolchain installation path today.

## Why live LSP activation remains blocked

Runtime and UI activation waits for three public Extension Platform contracts:

1. **Typed settings:** data-driven per-language enablement and a per-worktree service declaration, with a safe disabled default.
2. **Import decision:** an import-compatible EP-11 decision event that carries detected-language data for an explicit operator offer.
3. **Managed worktree service:** an EP-8 lifecycle keyed by project, component, worktree, and language, with platform-owned caps, idle shutdown, cleanup, and fresh `service.manage` fencing.

Until those contracts are root-published and adopted, the pack must not create private settings, grants, decisions, prompt injections, import UI hooks, sandbox builders, process tables, detached children, or `BgProcessManager` fallbacks. In particular, there is no per-project browser enablement offer, saved per-language choice, live client, server process, or automatic install to document as available.

## Adding a language

Add one declarative record to the Code Intelligence language matrix. Populate stable language metadata and evidence, then independently declare structural search and, only where supported, LSP server/actions plus named host and sandbox requirements. Requirements need a visible install hint; constrained requirements need a version constraint; sandbox requirements need a generic layer identifier.

Do not add language-specific branching to detection, status derivation, request serialization, or sandbox derivation. Add or update matrix and fixture coverage to demonstrate the intended asymmetry, evidence, requirement compatibility, and layer attribution. A language may be structural-search-only or LSP-only if the matrix makes that distinction explicit.

## Validation present today

The registered Test Suite v2 coverage validates the dormant slice rather than simulating unavailable platform behavior:

- Core tests validate matrix data, structural-search/LSP asymmetry, bounded and truncation-aware component detection, runtime-specific compatible probe facts, exact readiness identity, inert tool registration, request containment and reason sanitization, and pure sandbox-layer derivation.
- Linked-worktree E2E coverage creates a real Git worktree, verifies that detection and serialized URIs use its component root rather than the primary checkout, rejects an escape attempt, and removes the worktree without LSP-owned state.
- Docker-gated E2E coverage uses the ordinary project sandbox and linked worktree. It verifies that Go remains structurally searchable while named Go and `gopls` sandbox requirements degrade honestly, with no LSP process, private state, or checkout mutation.
- The integrated browser journey activates the pack at server scope after a normal import, displays TypeScript and Go as non-ready declared capabilities, performs a real structural query and source read, reloads, then disables and cleans up. It does not simulate a live LSP or a per-language enablement choice.

Run the unit suite with `npm run test:unit`, the browser journey with `npm run test:browser`, and real worktree/Docker coverage with `npm run test:e2e`.
