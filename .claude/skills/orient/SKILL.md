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
