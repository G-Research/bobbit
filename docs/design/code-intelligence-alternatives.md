# Code Intelligence — alternatives considered & evidence (research annex)

Status: research record, 2026-06-11. Companion to [code-intelligence.md](code-intelligence.md)
(design) and [code-intelligence-implementation-plan.md](code-intelligence-implementation-plan.md)
(execution). This doc exists so future maintainers know **what else was on the table, why the
proposed option won, and which facts that judgment rests on** — re-verify the dated facts
before overturning a decision.

---

## §1 The market moved our way (validation of the core stance)

The design's bet — *first-party LSP-backed tools in the harness, not MCP add-ons* — is now
the shipped pattern across terminal agents:

- **Claude Code** shipped a native LSP tool in v2.0.74 (2025-12-19): go-to-definition,
  references, hover, workspace symbols, call hierarchies, **automatic post-edit diagnostics**;
  servers configured via plugins (11 official language plugins), binaries installed separately
  ([changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
  [tools reference](https://code.claude.com/docs/en/tools-reference)).
- **GitHub Copilot CLI** shipped LSP support (8 operations incl. rename + call hierarchy) with
  repo/plugin/user JSON config and an "LSP Setup skill" for ~14 languages
  ([blog, 2026-06-10](https://github.blog/ai-and-ml/github-copilot/give-github-copilot-cli-real-code-intelligence-with-language-servers/)).
- **OpenCode** preconfigures LSP for 18+ languages. **Codex CLI and Gemini CLI** still lack it
  — their top-voted open feature requests ([codex#8745](https://github.com/openai/codex/issues/8745)).
- IDE agents (Cursor, Windsurf, Zed) expose at most a *diagnostics* tool to the model and lean
  on retrieval indexes — Cursor 2.0 even "simplified the agent to use the LSP less."

Implications adopted: (a) config-not-binaries plugin model = exactly our `lsp-<lang>`
descriptor packs; (b) Claude Code's early bugs (zombie servers, stale pre-edit diagnostics,
gitignored files in references, missing `didOpen`, command injection in binary detection) are
a free checklist — each becomes a CI-3 invariant/test; (c) **post-edit auto-diagnostics** is
table stakes — added to CI-3 scope; (d) differentiation is real: nobody ships a budgeted
ranked repo map, typed multi-checker `code_check`, worktree-keyed supervision, or
capability-swappable engines.

## §2 LSP engine: build on `vscode-jsonrpc` — vs Serena, bridges, Python libs

| Option | Verdict | Decisive facts |
|---|---|---|
| **vscode-jsonrpc 9 + vscode-languageserver-protocol 3.18** (npm) — **CHOSEN** | Build the supervisor on these | Microsoft-maintained, republished 2026-06-03, ~10M+ downloads/wk each; protocol README: "tool independent… usable in any node application". coc.nvim (~25k★) is the proven reference for the lifecycle layer. Protocol plumbing ≈ 500–1000 lines / 1–2 wks; the hard part (lifecycle) we own under any option |
| `vscode-languageclient` | Rejected | `engines.vscode` — runs only inside the VS Code extension host (verified package.json) |
| **Serena** (oraios/serena, MIT, ~25k★) | Design reference + fallback pack, not the engine | Python 3.13 + uv runtime per workspace; MCP indirection; live reliability battle in its tracker: 30 GB RAM ([#944](https://github.com/oraios/serena/issues/944)), init hangs ([#1390](https://github.com/oraios/serena/issues/1390), [#937](https://github.com/oraios/serena/issues/937)), stdio init races ([#900](https://github.com/oraios/serena/issues/900)), LS termination loops ([#634](https://github.com/oraios/serena/issues/634)). **Port its designs**: solidlsp's synchronous wrapper + two-tier symbol cache (100–500 ms → <10 ms), auto-download of server binaries |
| multilspy (Microsoft) | N/A directly | Python-only research library (13 langs); its 2026 fix history (server hangs, orphaned processes) confirms lifecycle is where the bodies are buried |
| MCP bridges (mcp-language-server 1.5k★, lsmcp, cclsp, lsproxy) | Rejected | All single-maintainer; most dormant ≥10 months (mcp-language-server since 2025-06, lsmcp since 2025-08); single-root designs; none do worktree-aware pooling. lsproxy (REST, Rust, multi-server pool) is the closest design reference |

### §2.1 The Serena question, in full ("why not one LSP to rule them all, wrapped and fixed?")

Owner asked this directly (2026-06-11); recording the complete argument since it's the most
tempting future re-litigation. Compare the two stacks:

```
Wrap Serena:   agents → MCP protocol → Serena (Python 3.13 + uv sidecar) → solidlsp → language servers
Proposed:      agents → first-party code_* tools → LSP supervisor (in the gateway, TS)   → language servers
```

1. **The valuable part of Serena is the part we'd rewrite anyway.** Its worth is the bottom
   layer — server lifecycle + symbol caching — and its tracker shows that battle ongoing
   (§2 table: #944 30 GB RAM, #1390/#937 init hangs, #900 stdio races, #634 re-init loops).
   The fixes Bobbit needs most — **per-(worktree, language) pooling, idle eviction, disposal
   wired into goal-worktree cleanup** — are absent from Serena's one-project-one-session
   architecture. That's not a wrapper-sized change; it's the design.
2. **The protocol layer — the part that looks scary — is the cheap part.** Microsoft's
   `vscode-jsonrpc` + `vscode-languageserver-protocol` give the full typed client off the
   shelf; the lifecycle layer is ~500–1000 lines with coc.nvim as reference. So "buy Serena"
   saves the *easy* part while charging a Python-3.13/uv runtime, a sidecar process per
   workspace, and a second supervisor-in-a-different-language to debug when it wedges.
3. **The MCP surface is the already-observed failure mode.** Generic MCP tools = no token
   budgets, no `file:line` renderers, no tool-guard tiers, no prompt guidance — and Serena's
   rename writes files directly, bypassing the preview-diff → review flow. The model-facing
   UX, where tool adoption is won or lost, is precisely what a wrapper can't fix.
4. **Serena still pays us twice.** We port its two best designs (synchronous two-tier symbol
   cache; auto-download of server binaries, both also in multilspy), and because everything
   sits behind the `code.symbol-nav` capability, a Serena-backed pack remains a legitimate
   community alternative — and the **escape hatch**: if the CI-3 supervisor stalls in its
   wave, wrapping Serena behind the same capability is roughly a week's work, not a rewrite.

One-sentence verdict: *Serena is the right idea delivered as the wrong dependency — keep the
idea (supervised language servers behind symbol tools), delete the Python/MCP middle, build
the thin lifecycle layer natively where Bobbit's budgets, renderers, review flow, and
worktree model already live.*

## §3 Per-language servers (research-corrected picks)

Two picks **changed** from the original draft: TS/JS `typescript-language-server` → **vtsls**;
Python `pyright` → **basedpyright**.

| Language | Pick | Why / acquisition | Caveats to engineer for |
|---|---|---|---|
| TS/JS | **vtsls** | Wraps VS Code's TS extension (feature parity); Zed's default ([zed#13140](https://github.com/zed-industries/zed/pull/13140)); npm install | tsserver under the hood: plan multi-GB RSS, set max old-space (Zed uses 8 GiB) |
| Python | **basedpyright** | Pyright fork with Pylance-only features (find-implementations, semantic tokens) reimplemented in the open server ([docs](https://docs.basedpyright.com/dev/benefits-over-pyright/pylance-features/)); self-contained pip wheel, no Node needed | `openFilesOnly` default limits analysis — configure workspace-wide; references can be incomplete for unopened files |
| Go | gopls | Canonical; `go install` | Needs Go toolchain + `go.mod`; note gopls ≥0.20 has a built-in experimental MCP server — possible shortcut, evaluate at CI-4 |
| Rust | rust-analyzer | Prebuilt single binaries on GH releases (rustup shim caveat: [rustup#3846](https://github.com/rust-lang/rustup/issues/3846)) | **Worktrees**: set `CARGO_TARGET_DIR` per worktree + `rust-analyzer.cargo.targetDir` or instances serialize on cargo locks ([#10684](https://github.com/rust-lang/rust-analyzer/issues/10684)); weakest multi-root — one instance per cargo workspace; watcher walks all worktrees ([#16534](https://github.com/rust-lang/rust-analyzer/issues/16534)) |
| C# | **razzmatazz/csharp-language-server first**; Microsoft Roslyn LS later | csharp-ls: `dotnet tool install -g csharp-ls`, standard stdio LSP, active. Roslyn LS is what VS Code uses but: Azure-DevOps-feed acquisition, nonstandard named-pipe handshake, custom `workspace/projectInitializationComplete` readiness signal | OmniSharp effectively dead — do not use |
| F# | FsAutoComplete | `dotnet tool install fsautocomplete`; Ionide-maintained | Needs restorable solution (MSBuild project load) |
| Java | JDT-LS | Standard; tarball + **JDK 21+** | Heaviest warm-up (Maven/Gradle import; progress sticks); per-project `-data` workspace dirs; 1–2 GB+ heap |
| Kotlin | JetBrains kotlin-lsp — **defer (alpha)** | Official, but alpha, partially closed-source, IntelliJ-class memory, init timeouts on large projects; community fwcd server deprecated | Ship the card last; document degraded support |
| C/C++ | clangd | Prebuilt zips on GH releases | Practically requires `compile_commands.json` — descriptor should auto-suggest `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` / `bear` |

**Operational invariants the supervisor must encode** (each cited in research; all promoted to
CI-3 pinning tests): strict `initialize`→`initialized` ordering; advertise `workspaceFolders`
capability *and* still pass rootUri (claude-code [#27220](https://github.com/anthropics/claude-code/issues/27220));
**didOpen-before-query document tracker** (typescript-ls returns empty without it,
[#89](https://github.com/typescript-language-server/typescript-language-server/issues/89)) and
didChange/didClose on disk changes (server must not re-read opened docs); **position encoding**
— negotiate `utf-8` via `general.positionEncodings`, else convert UTF-16 code units (the
"bottom emoji breaks rust-analyzer" class); **readiness gating** — no standard signal exists;
consume `$/progress` + per-server signals (rust-analyzer `experimental/serverStatus.quiescent`,
Roslyn `projectInitializationComplete`) with per-descriptor `startupTimeout`; **client-side
file watching** — honor `workspace/didChangeWatchedFiles` registrations or servers go stale on
git checkouts (gopls depends on it); pass `processId` AND reap on our side (servers commonly
ignore parent-death); `shutdown` → `exit` → wait → SIGKILL; **diagnostics settle** before
`code_diagnostics` returns (push model is async); memory caps + idle eviction + orphan sweep
(the oh-my-opencode jdtls-leak system-freeze failure mode).

## §4 Structural engine: ast-grep — vs Semgrep, comby, GritQL, srgn, raw tree-sitter

| Engine | Verdict | Decisive facts |
|---|---|---|
| **ast-grep** — **CHOSEN** | Ship `@ast-grep/cli` as npm dep | MIT, ~14.5k★, very active (sole-maintainer risk noted; mitigated by capability seam). 25–31 langs + custom grammars. `--json=stream` NDJSON with metavariable captures; rewrite with diff preview; YAML rule system. **npm-native**: `@ast-grep/cli` (~569k dl/wk) resolves prebuilt platform binaries via optionalDependencies — no custom shipping; `@ast-grep/napi` (~2M dl/wk) for in-process use (repo map). De-facto agent choice (official MCP + Claude skill; Codemod jssg; oh-my-opencode) |
| Semgrep CE / Opengrep | Rejected for embedding | Python front-end + OCaml core subprocess — needs a Python runtime; seconds of per-invocation startup; rules relicensed restrictively Dec 2024 (engine still LGPL); security-lint-shaped, not edit-shaped. Opengrep fork (Jan 2025, 10+ vendors) is the safer governance if ever needed |
| comby | Rejected | Right interface (single binary, `-json-lines`) but last release June 2022; "v2 prep" commits June 2026 are a flicker, not a maintenance signal |
| GritQL | Rejected | Survived Honeycomb acquisition only by donation to Biome (Dec 2025); volunteer-paced; lives on as Biome's plugin language |
| srgn | Rejected | MIT single binary but 7 languages, no JSON output, beta CLI churn. (Claims that Codex bundles it: **unverified/likely false** — codex-universal ships ripgrep/fd/universal-ctags) |
| raw web-tree-sitter | Used for the repo map, not the tool | It's a parsing primitive — we'd rebuild matching/rewrite/CLI ergonomics ast-grep already has |

## §5 Repo map: Aider-style ranked map — vs ctags, SCIP, stack-graphs, packers, embeddings

**Upgrade adopted from research:** the map is not just "files → symbols"; it is a **ranked**
map — defs+refs graph with personalized PageRank, which is what makes 2–8 KB budgets effective.

- **Aider's mechanism** (the model): tree-sitter `tags.scm` queries → def/ref tags per file →
  `MultiDiGraph` (referencer file → definer file, weight `√refs` × multipliers: ×10 chat-mentioned
  idents, ×10 well-named long idents, ×0.1 private `_`/defined-in->5-files, ×50 in-chat
  referencing file) → personalized PageRank seeded by chat files → rank split across edges to
  definitions → binary-search the tag count to the token budget (default 1k, up to 4k on
  large-context models; ~2–8× expansion when no files in chat) → render signature lines only;
  mtime-keyed disk cache ([repomap blog](https://aider.chat/2023/10/22/repomap.html),
  [repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)).
- **Evidence it pays**: RepoGraph (ICLR'25, [arXiv:2410.14684](https://arxiv.org/abs/2410.14684))
  — def/ref graph plug-in lifts SWE-bench-Lite resolve rates across four harnesses (≈+2–2.7 pts
  absolute, ≈+33% relative avg); Agentless ([arXiv:2407.01489](https://arxiv.org/abs/2407.01489))
  shows cheap structural repo views rival full agentic exploration; CodePlan (FSE'24) likewise.
  Aider itself publishes no ablation — the academic record carries the claim.
- **Node implementation path**: tag extraction via **web-tree-sitter + `tree-sitter-wasms`
  prebuilt grammars** reusing Aider's vendored `tags.scm` queries (MIT; battle-tested across
  100+ languages), or `@ast-grep/napi` kind-queries where grammars overlap — decide at CI-5
  with a spike; ranking via `graphology` PageRank; cache by content hash per worktree.
- Rejected: **universal-ctags** (defs only — no refs ⇒ no ranking graph; the reason Aider left
  it), **SCIP** (compiler-accurate but per-language indexers + build required; scip-typescript
  last released Oct 2024), **stack-graphs** (archived 2025-09-09 — dead; GitHub itself fell
  back to tree-sitter tag search), **CodeQL** (license bars closed-source analysis; minutes of
  DB build), **repomix/packers** (one-shot dumps, unranked, token cost scales with repo).
- **Embeddings**: genuinely contested. Cursor's eval claims +12.5% avg agent accuracy from
  semantic search; Anthropic found agentic search "outperformed RAG by a lot" and ships none;
  continue.dev deprecated its embeddings `@codebase`. Both headline numbers are
  vendor-interested. Decision: **not in v1** (infra + staleness + privacy cost; weaker fit for
  our worktree-keyed model); the `code.map`/search capability seam leaves room for an optional
  embeddings pack later if BENCH shows orientation gaps on very large repos.

## §6 Diagnostics: custom rdjson-shaped schema + errorformat fallback — vs SARIF-internal

- **Native structured output exists for most of the fleet**: ESLint `--format json`; Biome
  `--reporter=rdjson|sarif`; ruff `--output-format json|rdjson|sarif` (best in class); mypy
  `--output=json` (≥1.11); `go vet -json` / `go test -json` (compile errors arrive as text in
  Output events — caveat); cargo `--message-format=json` (gold standard, includes fixes);
  dotnet via `-p:ErrorLog=out.sarif`. **tsc has no JSON** ([TS#46340](https://github.com/microsoft/TypeScript/issues/46340))
  — but `--pretty false` output has been regex-stable for a decade. **pytest**: use built-in
  `--junitxml`; the json-report plugin is third-party/lightly maintained. **javac/gradle/maven**:
  weakest — text parsing territory.
- **Canonical internal schema: our own minimal record** `{tool,file,line,endLine?,col?,code,
  severity,message,fix?}` — essentially a flattened **rdjsonl** (reviewdog diagnostic format).
  ruff and Biome already emit rdjson natively, validating the shape. **SARIF is an input, not
  the model**: deeply nested, 90% of its surface irrelevant to an agent loop; one SARIF→internal
  adapter unlocks dotnet, semgrep, clang, CodeQL at once.
- **Bundle reviewdog's `errorformat`** (single static Go binary, ~50+ preset parsers + user
  `-efm` patterns, emits rdjsonl): the universal fallback that covers javac/gradle and the
  long tail without writing parsers. This one *does* ship via the `binaries/` mechanism.
- Peer check: Claude Code feeds raw hook stderr text; Cursor pipes LSP diagnostics (uneven by
  language); Codex/Devin read raw logs. A typed multi-checker `code_check` is ahead of all of
  them; LSP pull-diagnostics is a later fast path (CLI checkers stay source-of-truth because
  they reflect project task orchestration — nx/turbo configs, generated code).

## §7 Memory layer (branch-level check, settles the EP G2 bet)

Researched because the PR branch commits to Hindsight (EP G2). **Bet validated, framing
sharpened**: vectorize-io/hindsight is MIT, very active (v0.8.1 June 2026), Node SDK, hybrid
retrieval (semantic+BM25+graph+temporal), Postgres+pgvector, and the Nous Hermes agent
integration proves the exact daemon-autostart-pack pattern. Alternatives are worse fits: mem0
(cloud-leaning, disputed benchmarks), Zep (self-hosted CE discontinued), cognee (no TS SDK),
Letta (a competing harness). **But** the 2026 production trend is text-first (Claude Code
CLAUDE.md/auto-memory, Devin Knowledge, Cursor memories) — so: **markdown staff memory stays
authoritative** for procedural knowledge; Hindsight is the *optional* episodic-memory pack,
gated on Docker/Postgres availability, an LLM key per `retain` priced in. This nuance is
recorded against EP G2 here rather than rewriting the EP doc. **Superseded for depth:** the
full memory decision record — sessions-vs-Hindsight layering, the comparison table with
reasons, and the bank-topology decision (one shared tag-scoped bank) — now lives in
[agent-memory.md](agent-memory.md).

## §8 Net changes applied to the CI docs after this research

1. CI-3 engine named: `vscode-jsonrpc` + `vscode-languageserver-protocol`; coc.nvim as
   lifecycle reference; solidlsp's sync+cache and multilspy's binary auto-download as ported
   designs; §3's operational invariants promoted into CI-3 tests; **post-edit auto-diagnostics**
   added to CI-3 scope (match Claude Code).
2. Server picks: **vtsls**, **basedpyright**, **csharp-ls-first**, kotlin deferred (alpha);
   per-worktree `CARGO_TARGET_DIR`; clangd compile-commands hint in descriptor.
3. CI-1 shipping: `@ast-grep/cli` npm dependency (platform optionalDependencies) instead of
   the custom `binaries/` route; `--json=stream`.
4. CI-2: rdjsonl-shaped internal schema; `errorformat` bundled as fallback; SARIF adapter;
   pytest via junitxml; tsc regex parser.
5. CI-5: upgraded from flat symbol listing to **ranked** def/ref-graph map (personalized
   PageRank, session-aware seeds), with the RepoGraph/Agentless evidence as rationale.
