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

## Graph freshness (updated 2026-07-05)

The graph is a SNAPSHOT — it does not auto-update as code changes. `src/graphify-out/` is gitignored (11MB artifact), so:
- **One shared graph**: the primary checkout owns `src/graphify-out/`; lane worktrees share it via a symlink (`src/graphify-out -> <primary>/src/graphify-out`). Give a new worktree the same symlink (`ln -sfn <primary>/src/graphify-out "$WORKTREE/src/graphify-out"`); preserve existing symlinks (never replace with a real dir), and **never run `graphify update` from a worktree** — refreshes run only from the primary.
- **Manual refresh**: `npm run graph:refresh` from the **primary** repo root (= `scripts/graphify-refresh.sh --force`, no LLM needed; refuses to run from a linked worktree).
- **Automatic refresh**: `.githooks/post-merge`, `.githooks/post-checkout` (branch switches, including `git worktree add`), and `.githooks/post-commit` all delegate to `scripts/graphify-refresh.sh --hook` in the background after the corresponding git operation. Opt in once per clone with `./scripts/setup-githooks.sh` (not on by default — no `postinstall`). No-ops silently if `graphify` isn't on PATH, **or when not in the primary checkout** (git-dir != git-common-dir) — critical because the symlinks make `graph.json` look present in every worktree, and a worktree-triggered refresh would rebuild the shared graph (we run 10+ worktrees concurrently). Concurrent triggers coalesce via a stale-lock-tolerant lock instead of stacking rebuilds.
- **In a worktree without the symlink / a fresh clone** the graph is absent — add the symlink (worktree) or run the refresh once in the primary (clone), or fall back to LSP + `rg` (steps 1/3/4 work without it).
- The MCP wiring lives in `.mcp.json` (committed; `command` is the portable `scripts/graphify-mcp.sh` wrapper, which resolves the graphify interpreter via PATH/`$GRAPHIFY_PYTHON` and the graph via the local or primary checkout — see [docs/dev-workflow.md — MCP wiring](../../../docs/dev-workflow.md#mcp-wiring)).
- If the CLI warns `skill is from graphify X, package is Y`, run `graphify install` to update the skill (writes to your home skill dir by default, not the repo).
- See [docs/dev-workflow.md — Code graph (graphify)](../../../docs/dev-workflow.md#code-graph-graphify) for the full picture (why it's valuable, the merge-driver N/A verdict, etc.).
