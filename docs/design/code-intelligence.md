# Code Intelligence — giving agents IDE superpowers (find, edit, verify)

Status: design accepted, not started. Workstream **CI** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

> **Execution authority:** implement from
> [code-intelligence-implementation-plan.md](code-intelligence-implementation-plan.md).
> **Alternatives & evidence:** every engine/library pick below is justified against its
> competitors, with citations, in
> [code-intelligence-alternatives.md](code-intelligence-alternatives.md) — read it before
> swapping any component.

**The problem:** Bobbit agents are "an LLM with grep". 56% of tool calls are bash
(time-and-token-cost-efficiency.md §3), discovery is multi-round grep cascades, edits are text
patches whose correctness is only discovered at gate time, and nothing understands symbols,
types, or structure. Peers are converging on the same answer (Serena, Octocode, Aider's
repo-map, graphify): pair fast lexical search with **structural (AST), semantic (LSP),
spatial (repo map), and truth (diagnostics) layers**.

**Design stance (from owner interview, 2026-06-11):**

1. **Native first-party tool groups, not MCP-first.** Observed reality: agents underuse
   generic MCP tools. First-party groups get budgeted outputs, custom renderers, tool-guard
   policies, and prompt guidance — that's why `team_*` gets used and random MCP servers
   don't. External engines may sit *behind* a tool group; they are not the model-facing
   surface.
2. **Best solution first, swappable forever.** Every layer is addressed through an
   extension-platform **capability name** (extension-platform.md §3.1):
   `code.structural-search`, `code.symbol-nav`, `code.map`, `code.diagnostics`. Reference
   implementations ship as built-in packs that *provide* those capabilities; tools and
   prompt sections *consume* capabilities, never concrete packs. Swapping engines later =
   installing a different provider pack — zero tool-surface change.
3. **Per-worktree everything.** Indexes, caches, and language-server instances are keyed by
   worktree root, stored as derived gitignored state, rebuilt per checkout. Nothing derived
   is ever committed; nothing stores absolute paths (the exact failure class graphify hit
   across worktrees).
4. **Cost is a feature.** Every tool here exists to replace a more expensive pattern
   (grep cascade → one `code_references`; 50 KB test log → 12 structured diagnostics;
   read-five-files orientation → one budgeted map section). Each lands with a CE-ledger
   measurement expectation (CE-G7.2's rationale, now executed).
5. **Verifiability is a feature.** Structural rewrites preview as diffs through the
   existing review flow before applying; every edit path ends in `code_check`; nothing
   mutates silently.

---

## §1 The layer model (what exists, what's new)

| Layer | Question it answers | Bobbit today | This workstream adds | Capability |
|---|---|---|---|---|
| Lexical | "where is this string?" | bash grep/rg (uncapped, 56% of calls) | nothing new — CE-G2 caps it, CE-G7.1 steers it | — |
| **Structural** | "find/replace this syntax shape" | ❌ regex/sed via bash | `ast_search` / `ast_rewrite` tools (ast-grep engine) | `code.structural-search` |
| **Symbol/semantic** | "definition? references? rename? type?" | ❌ | `code_*` LSP tool group + gateway LS supervisor + per-language packs | `code.symbol-nav` |
| **Spatial** | "what's here and how does it connect?" | ❌ (session search ≠ code) | budgeted repo-map (tool now, prompt section when EP providers land); graphify pack for *visualization* | `code.map` |
| **Truth** | "did my change actually work?" | gates run commands, agents read raw logs | `code_check` structured diagnostics (typed results, gate-consumable) | `code.diagnostics` |
| Temporal | "what did we learn before?" | staff memory; FlexSearch sessions | **already planned elsewhere**: Hindsight pack = EP G2; session-memory = EP G1.6; profile = GA-R5 | `memory` (EP) |

Graphify-vs-Hindsight, settled: **different layers, complementary, both already placed.**
Graphify-shaped tools are spatial (structure of *this checkout, now*); Hindsight is temporal
(what the agent/team *learned over time*) and is literally EP G2. CI adds the spatial layer;
it does not duplicate the temporal one.

## §2 Symbol layer — native LSP tool group

- **Surface:** `defaults/tools/code/` — `code_definition`, `code_references`,
  `code_symbols` (document/workspace), `code_hover`, `code_rename` (preview-diff →
  review-flow apply), `code_diagnostics`. Budgeted outputs (cap + spill per CE-G2),
  renderers that show locations as clickable `file:line`.
- **Engine:** a gateway-side **LSP supervisor** (`lsp-supervisor.ts`) built on
  `vscode-jsonrpc` + `vscode-languageserver-protocol` (Microsoft-maintained, standalone-
  capable; coc.nvim is the reference lifecycle implementation): spawns language servers per
  `(worktree, language)`, idle-shutdown (default 10 min), capped concurrent servers,
  health-restart — the `sandbox-manager.ts` idempotent-ensure shape. Servers are *processes
  the gateway owns*; agents never talk LSP directly. The supervisor also pushes **post-edit
  diagnostics** into the turn (the Claude Code v2.0.74 pattern — fix without a separate
  build step). The operational invariants (didOpen tracking, position-encoding negotiation,
  readiness gating, client-side file watching, orphan reaping…) are enumerated in
  [code-intelligence-alternatives.md §3](code-intelligence-alternatives.md) and are CI-3
  pinning tests.
- **Language autodiscovery:** a detection registry maps manifest/file signals →
  language-server descriptor (`tsconfig.json`/`package.json` → **vtsls**;
  `pyproject.toml` → **basedpyright**; `go.mod` → gopls; `Cargo.toml` → rust-analyzer
  (per-worktree `CARGO_TARGET_DIR`); `.csproj` → csharp-ls; `.fsproj` → FsAutoComplete;
  `pom.xml`/`build.gradle*` → JDT-LS; `CMakeLists.txt`/compile-commands → clangd; Kotlin
  deferred — kotlin-lsp is alpha). Descriptors ship as **per-language packs**
  (`lsp-typescript`, `lsp-python`, …): the descriptor is data (binary acquisition, args,
  init options, health probe), so adding a fleet language = a pack, not core code. v1
  bundles TypeScript + Python; the rest are cards (CI-4) — autodiscovery *detects* an
  uncovered language and surfaces "install the lsp-go pack" in the UI instead of failing.
  This config-not-binaries pack model is the same shape Claude Code (LSP plugins) and
  Copilot CLI (`.github/lsp.json`) converged on independently.
- **Why not Serena/MCP as the surface:** same capability, but token-opaque outputs, no
  renderer, no tool-guard tiers, Python runtime baggage per worktree, and the observed
  MCP-underuse problem. Serena remains the design reference and the escape hatch — a
  Serena-backed pack behind the same `code.symbol-nav` capability is ~a week's work if the
  supervisor stalls. Full argument:
  [code-intelligence-alternatives.md §2.1](code-intelligence-alternatives.md).

## §3 Structural layer — ast-grep tools

`ast_search(pattern, lang?, paths?)` and `ast_rewrite(pattern, rewrite, …)` over
**ast-grep** (MIT, the de-facto structural engine for agents), shipped as the
`@ast-grep/cli` npm dependency — prebuilt per-platform binaries via optionalDependencies,
no custom shipping; per-call execution with `--json=stream`, nothing to supervise, ~25–31
languages + custom tree-sitter grammars. `ast_rewrite` never writes directly: it returns a unified diff rendered through
the existing diff renderer; applying goes through the normal edit path so review-pane and
git-status flows see it. This is the single biggest verifiability upgrade over regex/sed —
and the first goal to land (CI-1).

## §4 Spatial layer — repo map + visualization

Two deliberately separate concerns:

- **Prompt/orientation path (in-house, small):** `code_map` — an Aider-style budgeted
  **ranked** map: tree-sitter tag extraction (defs **and** refs) → file/symbol graph →
  personalized PageRank seeded by session state (files in context, identifiers mentioned in
  the goal) → signature-only rendering, binary-searched down to a **hard token budget**
  (default 2 KB tool result, arg-raisable to 8 KB; later an EP provider contributes a
  prompt section under the same budget machinery as the skills catalog). Content-hash
  cached per worktree. The ranking is what makes a 2 KB map useful — flat symbol dumps
  aren't (evidence: RepoGraph ICLR'25 ≈+33% relative on SWE-bench-Lite; details and the
  Aider algorithm in [code-intelligence-alternatives.md §5](code-intelligence-alternatives.md)).
  Owner asked "isn't in-house overkill?" — no: extraction reuses tree-sitter/ast-grep
  machinery and Aider's MIT `tags.scm` queries; the *graph database* part of graphify is
  precisely what we don't need for prompts. Deterministic, relative-path-only,
  worktree-safe by construction. Embeddings indexing: deliberately not in v1 (contested
  evidence, real infra cost — annex §5); the capability seam leaves room for a pack.
- **Visualization path (reuse, optional):** a `graphify` **marketplace pack** (not built-in)
  wrapping graphify per worktree: output to a gitignored `graphify-out/`, rendered in a pack
  panel (`#/ext/graphify`). Known risk to verify at install: absolute-path leakage in
  `graph.json` across worktrees (reported upstream; verify against current release —
  treat the graph as per-worktree derived cache, never committed, which sidesteps the
  team-workflow/merge-driver features entirely).

## §5 Truth layer — structured diagnostics

`code_check(scope)` runs the project's known checkers (from project config; autodiscovered
defaults: `tsc --noEmit`, eslint, pytest, `go vet`/`go test`, `cargo check`) and returns
**typed results** — a flattened-rdjsonl record `{tool, file, line, endLine?, col?, code,
severity, message, fix?}[]` + summary counts — never raw logs (cap + spill for the rare
overflow). Parser strategy: native JSON where it exists (eslint, ruff/Biome rdjson, mypy,
cargo, go), stable-regex for `tsc --pretty false`, JUnit XML for pytest, a SARIF→internal
adapter (unlocks dotnet/semgrep/clang in one converter), and the bundled reviewdog
**`errorformat`** static binary as the universal fallback (~50 preset parsers + user `-efm`
patterns) — that one ships via the existing `binaries/` mechanism. Verification gates can
consume the same parser output, and the team-lead's "did it work" loop becomes data-driven.
Unknown checkers fall back to capped raw output (never block). No shipping agent harness
has this layer typed today — Claude Code feeds raw hook text, Codex/Devin read raw logs.

## §6 UX — "what's running, where?" (owner requirement)

Code-intel services are invisible infrastructure; the user must be able to see and steer
them from where they live — the chat:

- **Context services chip** in the chat header (next to the git-status widget): shows the
  active session's scope (global / project / worktree) and the live code-intel services for
  it (e.g. "TS ✓ · Py ✓ · map 4.2k"). Click → popover: per-service status, restart, open
  pack panel (graphify viz, map inspector), install-suggestion for detected-but-uncovered
  languages.
- Pack panels remain the deep-dive surface (`#/ext/…`); the chip is the discoverability
  bridge the platform currently lacks — designed here, generalized for all packs with
  runtimes/services as a follow-up card under EP (the chip reads a generic
  "active pack services for this session" endpoint, not CI-specific state).

## §7 Worktree semantics (the contract)

Everything in CI obeys: keyed by worktree root · derived state in
`<worktree>/.bobbit-cache/` or the server cache dir (both gitignored) · relative paths only
in any artifact · LS instances per worktree with pooling/idle-shutdown · goal worktree
cleanup also disposes CI state (Caretaker sweep covers leaks). A pinning test greps CI
artifacts for absolute paths — the graphify lesson, enforced.

## §8 Cost & verifiability acceptance (program-level)

- CE ledger (CE-G0.1) dimensions for CI tools; success = bash share of discovery calls
  falls materially (CE-G7.1 targets <40%; CI should push further), grep-cascade turns
  replaced by single-call lookups on the BENCH suite (CE-G0.3) at equal task success.
- Every mutating surface (`ast_rewrite`, `code_rename`) previews before applying; every
  CI tool result is budgeted; `code_check` closes every edit loop.

Cross-references: [code-intelligence-alternatives.md](code-intelligence-alternatives.md)
(alternatives, citations, research record),
[time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md) (CE-G2/G7),
[extension-platform.md](extension-platform.md) (capabilities §3.1, providers, runtimes),
[harness-gap-analysis.md](harness-gap-analysis.md) (peer evidence),
[mission-control.md](mission-control.md) (Caretaker sweep, flight recorder for service
lifecycle events).
