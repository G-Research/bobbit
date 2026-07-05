---
name: orient
description: Locate code cheaply in the large Bobbit repo without reading whole god-objects (server.ts is 16k lines). Use when you need "where is X / what calls Y / where does Z live / what's coupled to W" before editing.
---

# /orient

Orient precisely and cheaply — never read a god-object end-to-end just to find something.

1. **LSP first (exact, cheapest).** Use the `LSP` tool: `workspaceSymbol` to find a symbol, then `goToDefinition` / `findReferences` / `incomingCalls` / `outgoingCalls` to trace. TS LSP is available (`typescript-language-server` installed).
2. **graphify code-graph (structural, cross-file).** A 10k-node / 26k-edge AST graph is at `src/graphify-out/graph.json`. If the `graphify` MCP is wired, use its `query_graph` / `get_neighbors` / `shortest_path` tools. Otherwise from the repo root: `graphify query "<question>"` (broad BFS context), `graphify path "SymbolA" "SymbolB"` (link between two), `graphify explain "Node"`.
3. **codemap (coupling / hotspots).** `~/Documents/dev/bobbit-fable-refactor/raw/codemap-coupling.json` — god-objects (server.ts coupling 144, session-manager, verification-harness), fan-in/out, and the 83 import cycles. Read this before touching structure.
4. **audit findings.** `~/Documents/dev/bobbit-fable-refactor/FINDINGS.md` + `findings-index.json` — grep by file or ID to see if an area already has a verified finding + fix sketch.

Return the precise `file:line` locations. Prefer targeted reads (offset/limit) over whole-file reads.

## Graph freshness (added 2026-07-05)

The graph is a SNAPSHOT — it does not auto-update as code changes. `src/graphify-out/` is gitignored (11MB artifact), so:
- **Manual refresh**: `npm run graph:refresh` (= `graphify update src --force`, no LLM needed; `--force` is required when files were deleted).
- **Automatic refresh**: `.githooks/post-merge` and `.githooks/post-checkout` (branch switches) run the same refresh in the background after a merge/pull or branch switch. Opt in once per clone/worktree with `./scripts/setup-githooks.sh` (not on by default — no `postinstall`). No-ops silently if `graphify` isn't on PATH.
- **In a fresh worktree/clone** the graph is absent until one of the above has run — either trigger the refresh once, or fall back to LSP + `rg` (steps 1/3/4 work without it).
- The MCP wiring lives in `.mcp.json` (committed; the `command` path is machine-specific to AJ's uv install — adjust per machine).
- If the CLI warns `skill is from graphify X, package is Y`, run `graphify install` to update the skill (writes to your home skill dir by default, not the repo).
- See [docs/dev-workflow.md — Code graph (graphify)](../../../docs/dev-workflow.md#code-graph-graphify) for the full picture (why it's valuable, the merge-driver N/A verdict, etc.).
