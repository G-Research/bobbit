# Code Intelligence — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **CI** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [code-intelligence.md](code-intelligence.md) (WHAT/WHY + the layer model and
design stance — its §7 worktree contract and §1 capability names are LAW) and
[code-intelligence-alternatives.md](code-intelligence-alternatives.md) (the research annex:
why each engine/library below beat its alternatives, with citations and the operational
invariants their issue trackers taught us — **read its §3 before implementing CI-3**).

> **Anchor baseline:** fable-docs @ 2026-06-11 (master parent `6ec8c8f9`). Locate by symbol
> name; missing symbol ⇒ STOP, re-derive from the cited pattern — never improvise.
>
> **Precision policy:** CI-1/CI-2 file/function level; CI-3…CI-7 contract level (re-verify
> anchors; CI-3's supervisor is the largest new component in the program — its goal text
> includes extra invariants).
>
> **Universal rules:** [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
> + [fable-program-execution-plan.md §1](fable-program-execution-plan.md). **Seams:**
> tool-activation in `session-setup.ts` (shared — confine to named functions); `binaries/`
> shipping (`binaries.versions.json`, checksums — copy the existing binary's wiring);
> EP G8 capabilities (CI consumes when it lands; until then a thin local registry shim,
> see CI-7).

---

## Goal map

```
CI-1 ast-grep tools ──→ CI-5 repo map (reuses CI-1 engine)
CI-2 structured diagnostics (independent)
CI-3 LSP supervisor + code_* tools (TS+Py) ──→ CI-4 language packs + autodiscovery UX
CI-1..CI-5 ──→ CI-6 services chip + graphify viz pack ──→ CI-7 capability swap + BENCH
```

## CI-1 — `ast_search` / `ast_rewrite` tool group

**Outcome:** structural search and preview-diff rewrites across the worktree; regex/sed
edits become obsolete.

**Owned files:** NEW `defaults/tools/ast/{ast_search.yaml,ast_rewrite.yaml,extension.ts}`;
`@ast-grep/cli` added as a pinned npm dependency (prebuilt platform binaries via
optionalDependencies — no `binaries/` wiring needed; resolve the binary path via
`require.resolve`); NEW `src/server/agent/ast-grep-runner.ts`; NEW
`tests/ast-grep-runner.test.ts`, `tests/e2e/ast-tools.spec.ts`; budget rows in
`tests/tool-description-budget.test.ts`.

**Steps**

1. Runner: `runAstGrep({pattern, rewrite?, lang?, paths?, cwd})` → execFile the resolved
   binary with `--json=stream` (NDJSON); map results to `{file, line, column, text}[]`
   plus metavariable captures (relative paths
   ONLY — pin per design §7); output cap + spill via `truncateLargeToolContent`
   (`src/server/agent/truncate-large-content.ts`).
2. `ast_search`: tool YAML per the `defaults/tools/team/` anatomy; renderer lists matches
   as clickable `file:line` rows (copy a search-style renderer from
   `src/ui/tools/renderers/`).
3. `ast_rewrite`: runner in diff mode → unified diff returned as the tool result rendered
   by the existing diff renderer; `apply: true` arg performs the write through the normal
   file-edit path (so git-status/review flows observe it). Default is preview.
4. Prompt guidance: one paragraph in the CE-G7.1 discovery section (if landed; else the
   tool's `docs:` field carries it): "prefer ast_search over grep for code shapes; prefer
   ast_rewrite over sed always".

**Tests (author first; RED):** runner unit (json mapping, relative-path pin, cap+spill,
unknown lang error); e2e — search finds a planted pattern; rewrite previews a diff without
mutating; `apply: true` mutates and git-status reflects it; budget rows.

**Acceptance:** suites green; manual: an agent in a scratch project completes a
rename-shaped change via ast_rewrite preview→apply with zero bash sed.

## CI-2 — `code_check` structured diagnostics

**Outcome:** one tool returns typed diagnostics from the project's checkers; gates can
consume the same parsers.

**Owned files:** NEW `defaults/tools/code/code_check.yaml` (group seeds the `code` group
early; CI-3 adds siblings) + extension wiring; NEW `src/server/agent/diagnostics/`
(`runner.ts` + `parsers/{tsc,eslint,pytest,go}.ts`); NEW unit tests per parser with
captured-output fixtures; e2e.

**Steps:** checker set resolution (project config override → autodiscovery by manifest:
`tsconfig.json`⇒tsc+eslint, `pyproject.toml`⇒pytest/ruff if present, `go.mod`⇒go vet);
schema = flattened rdjsonl: `{tool, file, line, endLine?, col?, code?, severity, message,
fix?}[]`; per-tool strategy (annex §6): native JSON for eslint / ruff‑rdjson / mypy
`--output=json` / cargo `--message-format=json` / `go vet -json` (NB compile errors arrive
as text inside `go test -json` Output events); stable regex for `tsc --pretty false`
(`^path(line,col): error TSnnnn: msg`); `--junitxml` for pytest (not the json plugin);
one SARIF→internal adapter (covers dotnet `-p:ErrorLog=…sarif`, semgrep, clang); bundled
reviewdog **`errorformat`** static binary via the `binaries/` mechanism as universal
fallback (preset parsers + user `-efm` from project config). Result = summary counts +
first N (default 50) diagnostics + spill ref; unknown checker ⇒ capped raw fallback, never
an error. Renderer: grouped-by-file list. Verification-harness
consumption is a recorded follow-up (do NOT touch `verification-harness.ts` here — CE-G3.3
/ CE-G5.2 own it per §1.4).

**Tests:** parser fixtures (each: real captured output → exact typed rows); resolution
matrix unit test; e2e on a fixture project with a planted type error → structured row.

**Acceptance:** a failing `tsc` run produces ≤2 KB of tool result instead of the raw log;
ledger note recorded in the doc.

## CI-3 — LSP supervisor + `code_*` symbol tools *(contract level; the big one)*

Contracts: design §2; **annex §§2–3 are required reading** (engine rationale + the
operational invariants harvested from rust-analyzer/gopls/tsserver/Serena/Claude Code
issue trackers). **Owned (new):** `src/server/agent/lsp/` (`lsp-supervisor.ts`;
`lsp-client.ts` on **`vscode-jsonrpc` + `vscode-languageserver-protocol`** — coc.nvim's
client layer is the reference implementation; `language-registry.ts` detection rules;
descriptor schema); `defaults/tools/code/{code_definition,code_references,code_symbols,
code_hover,code_rename,code_diagnostics}.yaml`; descriptor data for TypeScript (**vtsls**)
+ Python (**basedpyright**, workspace-wide analysis configured, not `openFilesOnly`).

Invariants (each gets a pinning test):

1. Supervisor = idempotent ensure with in-flight dedupe (`sandbox-manager.ts` shape);
   key `(worktreeRoot, languageId)`; idle-shutdown default 10 min; max concurrent servers
   (default 4, config) + per-server memory ceilings; crash ⇒ restart with backoff,
   surfaced non-fatally (tool returns "language server unavailable — falling back"
   guidance, never hangs the turn).
2. Protocol correctness: strict `initialize`→`initialized` ordering; advertise
   `workspaceFolders` *and* pass `rootUri`; pass `processId` AND reap our side
   (`shutdown`→`exit`→wait→SIGKILL); negotiate `general.positionEncodings: utf-8`, else
   convert UTF-16 code units at the client boundary.
3. Document lifecycle tracker: `didOpen` before any query against a file (tsserver returns
   empty otherwise); `didChange`/`didClose` when our edit tools or git change disk; honor
   server `didChangeWatchedFiles` registrations (forward our watcher events) or servers go
   stale on checkouts.
4. Readiness gating: per-descriptor warm-up signal (`$/progress` settle, rust-analyzer
   `experimental/serverStatus.quiescent`, Roslyn `projectInitializationComplete`) +
   `startupTimeout`; `code_diagnostics` waits for the push-diagnostics settle window.
5. Tools degrade gracefully: no descriptor for the file's language ⇒ structured "not
   covered; detected language X; install lsp-X pack" result (feeds CI-4's UX), never an
   exception.
6. `code_rename` is preview-diff → apply through the file-edit path (CI-1 step 3 pattern);
   references results exclude gitignored paths (Claude Code regression #26051 class).
7. All positions/paths relative; budget + spill on every result.
8. Lifecycle: worktree removal (goal cleanup) disposes servers + caches — hook the
   existing worktree-cleanup path; Caretaker sweep (MC) catches leaks/orphans (the
   jdtls-leak failure mode). Per-worktree env isolation lives in the descriptor (e.g.
   rust: `CARGO_TARGET_DIR=<worktree>/.bobbit-cache/target`).
9. **Post-edit diagnostics push**: after our edit tools touch a covered file, fresh (not
   stale pre-edit) diagnostics are injected into the turn, capped; per-descriptor
   `diagnostics: false` opt-out. Port Serena's solidlsp symbol cache (two-tier, content-
   keyed) for hot `code_symbols`/`code_definition` paths.

Tests: supervisor unit with a fake LS binary (spawn/dedupe/idle/crash/handshake-order/
encoding negotiation); e2e against vtsls on a fixture project: definition/references/
rename round-trip + post-edit diagnostics; uncovered-language fallback; worktree-dispose
kills the server (process poll); stale-diagnostics pin (edit → old diagnostics never
delivered after new edit).

**Acceptance:** on the Bobbit repo itself, `code_references` on a core symbol returns in
<2 s warm, and the supervisor shows 0 servers after idle timeout.

## CI-4 — Language packs + autodiscovery UX *(contract level)*

Descriptor-as-pack: `market-packs/lsp-<lang>/` containing one `descriptor.yaml`
(server binary acquisition: npm/pip/download+checksum; args; init options; readiness
signal; health probe; file-detection globs; per-worktree env) — data only, no code.
Bundle `lsp-typescript` (vtsls), `lsp-python` (basedpyright) as built-ins (band per
`builtin-packs.ts`); **cards** (checklist rows, not yet specced), server picks per annex
§3: `lsp-go` (gopls — evaluate its built-in MCP server as a shortcut), `lsp-rust`
(rust-analyzer + CARGO_TARGET_DIR isolation), `lsp-csharp` (**csharp-ls first**, Microsoft
Roslyn LS as a later upgrade — nonstandard handshake), `lsp-fsharp` (FsAutoComplete),
`lsp-jvm` (JDT-LS, JDK 21+, per-project `-data` dirs), `lsp-clangd` (descriptor suggests
generating `compile_commands.json`), `lsp-kotlin` (**last** — kotlin-lsp is alpha).
Autodiscovery surfaces uncovered detected languages through the CI-6 chip + a marketplace
deep-link. Acceptance: installing `lsp-go` on a Go fixture makes `code_definition` work
with zero config; uninstalling degrades gracefully.

## CI-5 — `code_map` budgeted **ranked** repo map *(contract level; after CI-1)*

Aider's algorithm, in Node (annex §5 has the full mechanism + evidence): tag extraction
(defs **and** refs) via web-tree-sitter + `tree-sitter-wasms` prebuilt grammars reusing
Aider's MIT `tags.scm` queries — spike vs `@ast-grep/napi` kind-queries first, pick one —
→ def/ref file graph (edge weight `√refs` × multipliers: boost session-mentioned idents
and in-context files, damp `_`-private and defined-everywhere idents) → personalized
PageRank (`graphology`) seeded by session state → signature-only rendering, binary-search
tag count to budget. `code_map(path?, depth?, budget?)`: hard result budget (default 2 KB,
max 8 KB); content-hash cache per worktree under the design-§7 cache dir; relative paths
pin. When EP G1.3 (prompt sections via providers) is merged, add the provider that
contributes a "Repo Map" section under the same budget — the tool stays for on-demand
deeper maps. Acceptance: on the Bobbit repo, default call ≤2 KB, ranking test (a hub
module outranks a leaf util), and cold→warm rebuild ≥10× faster (cache test).

## CI-6 — Context-services chip + graphify visualization pack *(contract level)*

- **Chip** (core UI): chat-header widget next to `<git-status-widget>` showing session
  scope (global/project/worktree) + active code-intel services from a new generic
  `GET /api/sessions/:id/services` (supervisor + pack-runtime sourced — generic shape so
  EP runtimes plug in later). Popover: status/restart/open-panel/install-suggestion.
  Browser E2E: chip renders per scope; restart works; suggestion deep-links marketplace.
- **Graphify pack** (marketplace, NOT built-in): wraps graphify per worktree into
  `graphify-out/` (gitignored), panel at `#/ext/graphify` rendering its `graph.html`;
  install-time doc notes the absolute-path caveat and pins output as derived cache
  (never committed; design §4). Pack-litmus tests only — graphify itself is not under test.

## CI-7 — Capability seam + BENCH validation *(contract level)*

Until EP G8 lands: a 30-line local registry
(`src/server/agent/code-intel-capabilities.ts`) mapping the four capability names →
implementing module; tools resolve through it (pin: no direct cross-module imports of
engines from tool extensions). When EP G8 merges, swap the shim for pack capabilities
(one PR, the shim's API is G8's `ctx.capabilities.call` shape). Then: run the CE BENCH
suite (CE-G0.3) with CI tools on vs off; record token/turn deltas in
code-intelligence.md §8; this is the workstream's exit gate.

---

Checklist rows (mirrored in the execution plan §4): CI-1 · CI-2 · CI-3 · CI-4 (+7 language
cards) · CI-5 · CI-6 · CI-7.
