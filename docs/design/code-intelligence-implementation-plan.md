# Code Intelligence — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **CI** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [code-intelligence.md](code-intelligence.md) (WHAT/WHY + the layer model and
design stance — its §7 worktree contract and §1 capability names are LAW).

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
ast-grep binary wiring in `binaries/` + `binaries.versions.json` + checksums (copy an
existing entry's pattern end-to-end, incl. `scripts/` download/verify step); NEW
`src/server/agent/ast-grep-runner.ts`; NEW `tests/ast-grep-runner.test.ts`,
`tests/e2e/ast-tools.spec.ts`; budget rows in `tests/tool-description-budget.test.ts`.

**Steps**

1. Runner: `runAstGrep({pattern, rewrite?, lang?, paths?, cwd})` → execFile the pinned
   binary with `--json`; map results to `{file, line, column, text}[]` (relative paths
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
each parser: raw output → `{tool, file, line, code?, severity, message}[]`; result =
summary counts + first N (default 50) diagnostics + spill ref; unknown checker ⇒ capped
raw fallback, never an error. Renderer: grouped-by-file list. Verification-harness
consumption is a recorded follow-up (do NOT touch `verification-harness.ts` here — CE-G3.3
/ CE-G5.2 own it per §1.4).

**Tests:** parser fixtures (each: real captured output → exact typed rows); resolution
matrix unit test; e2e on a fixture project with a planted type error → structured row.

**Acceptance:** a failing `tsc` run produces ≤2 KB of tool result instead of the raw log;
ledger note recorded in the doc.

## CI-3 — LSP supervisor + `code_*` symbol tools *(contract level; the big one)*

Contracts: design §2. **Owned (new):** `src/server/agent/lsp/`
(`lsp-supervisor.ts`, `lsp-client.ts` JSON-RPC, `language-registry.ts` detection rules,
descriptor schema); `defaults/tools/code/{code_definition,code_references,code_symbols,
code_hover,code_rename,code_diagnostics}.yaml`; descriptor data for TypeScript + Python.

Invariants (each gets a pinning test):

1. Supervisor = idempotent ensure with in-flight dedupe (`sandbox-manager.ts` shape);
   key `(worktreeRoot, languageId)`; idle-shutdown default 10 min; max concurrent servers
   (default 4, config); crash ⇒ restart with backoff, surfaced non-fatally (tool returns
   "language server unavailable — falling back" guidance, never hangs the turn).
2. Tools degrade gracefully: no descriptor for the file's language ⇒ structured "not
   covered; detected language X; install lsp-X pack" result (feeds CI-4's UX), never an
   exception.
3. `code_rename` is preview-diff → apply through the file-edit path (CI-1 step 3 pattern).
4. All positions/paths relative; budget + spill on every result.
5. Lifecycle: worktree removal (goal cleanup) disposes servers + caches — hook the
   existing worktree-cleanup path; Caretaker sweep (MC) catches leaks.

Tests: supervisor unit with a fake LS binary (spawn/dedupe/idle/crash); e2e against
typescript-language-server on a fixture project: definition/references/rename round-trip;
uncovered-language fallback; worktree-dispose kills the server (process poll).

**Acceptance:** on the Bobbit repo itself, `code_references` on a core symbol returns in
<2 s warm, and the supervisor shows 0 servers after idle timeout.

## CI-4 — Language packs + autodiscovery UX *(contract level)*

Descriptor-as-pack: `market-packs/lsp-<lang>/` containing one `descriptor.yaml`
(server binary acquisition: npm/pip/download+checksum; args; init options; health probe;
file-detection globs) — data only, no code. Bundle `lsp-typescript`, `lsp-python` as
built-ins (band per `builtin-packs.ts`); **cards** (checklist rows, not yet specced):
`lsp-go`, `lsp-rust`, `lsp-csharp` (Roslyn), `lsp-fsharp` (FsAutoComplete), `lsp-jvm`
(JDT-LS), `lsp-clangd`, `lsp-kotlin`. Autodiscovery surfaces uncovered detected languages
through the CI-6 chip + a marketplace deep-link. Acceptance: installing `lsp-go` on a Go
fixture makes `code_definition` work with zero config; uninstalling degrades gracefully.

## CI-5 — `code_map` budgeted repo map *(contract level; after CI-1)*

`code_map(path?, depth?)`: directory → file → public symbols/signatures from ast-grep
parse output; content-hash cache per worktree under the design-§7 cache dir; hard result
budget (default 2 KB, arg-raisable to 8 KB); relative paths pin. When EP G1.3 (prompt
sections via providers) is merged, add the provider that contributes a "Repo Map" section
under the same budget — the tool stays for on-demand deeper maps. Acceptance: on the
Bobbit repo, default call ≤2 KB and a cold→warm rebuild is ≥10× faster (cache test).

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
