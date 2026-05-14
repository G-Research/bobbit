# LSP Code Intelligence

> All coding-role agents receive a short symbol-lookup hint in their system prompt summarising when to use `lsp_*` vs `grep` — see also AGENTS.md for project-specific nuance.

Bobbit ships a Language Server Protocol (LSP) integration so coding agents can ask IDE-grade questions about a worktree — go-to-definition, find-references, hover, diagnostics, document/workspace symbols, rename — without falling back to `grep` + multi-file `read` or full-project `tsc` runs.

> Design contract: [docs/design/lsp-code-intelligence.md](design/lsp-code-intelligence.md). This page is the operator/agent-facing reference; the design doc is the architectural source of truth.

## Motivation

A typical "find every caller of `foo()`" turn used to cost 5–15k tokens (`rg` + 5–10 `read`s) and 2–5s. A post-edit safety check ran `npm run check` — 20–30s on a project this size. Both are expensive in tokens *and* unreliable: grep matches strings and comments; `tsc --noEmit` cannot answer "where is this symbol defined?".

LSP replaces those flows with sub-second, scoped, authoritative queries against a warm language server:

| Workflow              | Pre-LSP                | LSP                | Speedup |
| --------------------- | ---------------------- | ------------------ | ------- |
| Find references       | 5–15k tokens, 2–5s     | ~50 tokens, <500ms | ~100× tokens |
| Go to definition      | 2–5k tokens, 1–3s      | ~50 tokens, <500ms | ~50–100× |
| Post-edit diagnostics | 20–30s `npm run check` | <500ms warm        | ~50× latency |

Cost: ~300–800MB RSS per warm `tsserver` per active worktree. The supervisor LRU-evicts at a hard cap so this is bounded.

## Supported languages

| Language | Server | Status |
| --- | --- | --- |
| TypeScript / JavaScript | `typescript-language-server` | **Production.** Shipped in the Docker sandbox image; auto-installed via package deps; detected from `tsconfig.json` / `jsconfig.json` / `package.json`. |
| Python | `pyright-langserver` | **Stub only** (v1). The factory at `src/server/lsp/clients/pyright.ts` exists and detects projects via `pyproject.toml` / `requirements.txt` / `setup.py`, but `isInstalled()` returns `false` so every Python LSP call falls back to `lsp_unavailable`. Flip `isInstalled()` and finish the spawn path when the adapter lands. |

The adapter interface (`LspClient` / `LspClientFactory` in `src/server/lsp/client.ts`) is pluggable. Adding gopls or rust-analyzer is a matter of dropping a new factory into `src/server/lsp/clients/` and registering it with the supervisor — no supervisor changes required.

## The seven tools

All seven tools are registered via the pi-extension loader from `defaults/tools/lsp/extension.ts`, which POSTs to `/api/lsp/<method>` on the gateway — the same pattern used by `bash_bg`, `browser_*`, `web_*`, and other extension-backed tool groups. Paths are **relative to session `cwd`** on both input and output. `line` and `character` are **0-indexed** (LSP-native), which differs from `read`'s 1-indexed `offset` — be careful when round-tripping.

| Tool | Params | Result | Typical use |
| --- | --- | --- | --- |
| `lsp_definition` | `path, line, character` | `{ path, range }` or `null` | Jump to a function's declaration before calling it. |
| `lsp_references` | `path, line, character, includeDeclaration?` | `Location[]` | Find every caller of a function. |
| `lsp_hover` | `path, line, character` | `{ contents: string /* markdown */, range? }` or `null` | Read a symbol's type + doc comment without opening the file. |
| `lsp_diagnostics` | `path?` | `Diagnostic[]` (each `{ path, range, severity, message, source?, code? }`) | Post-edit type-check loop. Omit `path` to aggregate across open docs. |
| `lsp_document_symbols` | `path` | `DocumentSymbol[]` (tree) | Outline a file before editing. |
| `lsp_workspace_symbol` | `query` | `SymbolInformation[]` (≤100) | Fuzzy symbol search across the worktree. |
| `lsp_rename` | `path, line, character, newName` | `WorkspaceEdit` (`{ changes: { [path]: edits[] } }`) | Cross-file rename. Agent applies the returned edits via `edit`. |

`Diagnostic.severity` is one of `error | warning | info | hint`. `Range` is LSP-native (`{ start: { line, character }, end: { line, character } }`, all 0-indexed).

### Error envelope

When the supervisor cannot serve a call, the tool returns a structured error rather than throwing:

- `lsp_unavailable` — server not installed, disabled by project config, crashed (3-in-60s cooldown), or unsupported language. Agent should fall back to `grep` / `read`.
- `lsp_capacity` — every supervisor slot is in-flight and a new call cannot evict an LRU victim. Retry; raise `lsp_max_servers` if persistent.
- `lsp_route_missing` — the `/api/lsp/<method>` route is not registered in the gateway (`handleApiRoute()` regression). This is a deployment bug, not a missing binary. The extension caches this per-method for the process lifetime to avoid repeated 404 round-trips. Notify the operator.
- `lsp_gateway_unreachable` — the extension could not connect to the gateway at all (ECONNREFUSED / network error). Check that the gateway process is running.

Path inputs are clamped to live inside `cwd` — absolute or upward-traversing paths are rejected with `lsp_unavailable`.

## Configuration

All keys live in `project.yaml` and are read through `ProjectConfigStore`. Defaults are baked into `LspSupervisor`.

| Key | Type | Default | When to change |
| --- | --- | --- | --- |
| `pre_warm_lsp` | bool | `true` | Set `false` on low-RAM machines (saves 300–800MB RSS per worktree until first explicit LSP call). |
| `lsp_max_servers` | number | `4` | Hard cap on concurrent LSP children, gateway-wide. Raise if you see `[lsp] evicting …` log spam on heavy multi-goal days. |
| `lsp_idle_ttl_ms` | number | `600000` (10 min) | Idle shutdown timer. Lower for memory-constrained environments; the cost is a re-warm (3–8s) on the next LSP call to that worktree. |
| `lsp_disabled` | bool | `false` | Kill switch — every `lsp_*` tool returns `lsp_unavailable`. Use when the language server itself is misbehaving and you want to force the grep fallback for the whole project. |

**Reserved for v1.x:** `lsp_languages` (force-enable a specific subset rather than auto-detect) and `lsp_pool_prewarm` (pre-warm in worktree-pool entries that may never be claimed) appear in the design doc but are not honoured by the current supervisor. Don't rely on them.

## Architecture (brief)

```
┌─ Gateway process ─────────────────────────────────────────────┐
│  LspSupervisor (singleton in SessionManager)                  │
│    ├── factories: { typescript, python(stub) }                │
│    ├── entries:    Map<(worktreePath, language), Entry>       │
│    ├── crashState: Map<key, { count, lastAt, disabledUntil }> │
│    └── sandbox?:   SandboxLspBridge                           │
│         POST /api/lsp/<method>                                │
│         GET  /api/lsp/stats                                   │
│         GET  /api/lsp/state                                   │
│                                  │ JSON-RPC stdio             │
│                                  ▼                            │
│                        typescript-language-server             │
│                        (one per worktree × language)          │
└───────────────────────────────────────────────────────────────┘
```

Key behaviours (all live in [`src/server/lsp/supervisor.ts`](../src/server/lsp/supervisor.ts)):

- **Lazy spawn.** `ensure({ worktreePath, language })` is called by the HTTP dispatch on first use; subsequent calls reuse the warm client.
- **LRU eviction.** When `entries.size >= maxServers` the least-recently-used entry with zero in-flight calls is gracefully shut down. If every entry is busy, the new call rejects with `lsp_capacity`. Evictions log `[lsp] evicting <key> to make room`.
- **Idle TTL.** When `refcount` *and* `inFlight` both hit zero, an `setTimeout(idleTtlMs)` fires; if nothing reactivates the entry, the child is shut down.
- **Refcount.** `acquire(worktreePath)` / `release(worktreePath)` are called from session lifecycle hooks so a long-running session keeps its server warm even between tool calls. The session-manager termination listener releases on every terminate / archive.
- **Pre-warm.** `preWarm(worktreePath)` is best-effort and fire-and-forget. It runs `detectLanguages()` (cheap synchronous check for `tsconfig.json`, `package.json`, `pyproject.toml`, etc.) and schedules `ensure()` on a microtask. Errors are logged at warn, never thrown — pre-warm cannot block session ready.
- **Crash backoff.** Unexpected child exits increment a per-key crash counter. ≥3 crashes inside 60s arms a 5-minute cooldown during which `ensure()` rejects with `lsp_unavailable`. Crash state is intentionally stored outside `entries` so the counter survives the dead entry's deletion.
- **`fs.watch` debounced restart.** Each TypeScript entry installs a non-persistent `fs.watch` on its worktree dir, filtering for `tsconfig.json`, `tsconfig.*.json`, `jsconfig.json`, and `package.json`. Changes are debounced 1500ms (configurable), then the entry is gracefully shut down — the *next* tool call lazily respawns. Eager respawn during branch-switch flurries would churn RAM; lazy is cheaper.

The adapter shape ([`src/server/lsp/clients/typescript.ts`](../src/server/lsp/clients/typescript.ts)) handles the LSP wire protocol: `initialize` handshake, `textDocument/didOpen` on first touch of a doc, capability negotiation, `publishDiagnostics` accumulation, and the seven method dispatches the supervisor exposes.

## Sandbox awareness

When a project runs sessions inside Docker, the supervisor accepts a `SandboxLspBridge` (`src/server/lsp/sandbox-bridge.ts`). The bridge:

- Translates host worktree paths (`/Users/aj/.../wt/goal-…`) to container paths (`/workspace-wt/…`) via the existing `toDockerPath()` helper shared with `docker-args.ts`.
- Reverses container paths back to host paths on return values (definition `path`, references, diagnostics) so the agent only ever sees paths relative to its `cwd`.
- Spawns the LSP child via `docker exec` inside the project's pool container, mirroring how `rpc-bridge.ts::spawnDockerExec` reaches into the sandbox for other processes.

The Bobbit Docker sandbox image ships with `typescript-language-server` pre-installed (see `docker/`). Hosts running sessions without a container — e.g. host-only sessions, the unit-test fixture project — get a **host spawn fallback**: when the bridge cannot resolve a container id for the worktree, the supervisor invokes the factory's plain `spawn()` path against the host filesystem. This is the path that ships today (added in the host-spawn-fallback fix).

> **Scope honesty.** The container ↔ host path translation is wired and exercised by the dispatch helper, but cross-sandbox path round-trips have not been hardened against every edge case (Windows host with Linux container, multi-mount worktrees, etc.). If you see absolute container paths leaking into agent output, that's the area to look at.

## Lifecycle integration

The hooks land in two files:

- [`src/server/agent/session-setup.ts`](../src/server/agent/session-setup.ts) — calls `supervisor.preWarm(session.cwd, projectId)` after a worktree is resolved, and `supervisor.acquire(worktreePath)` once the session is bound to it. Multi-repo sessions pre-warm each component worktree.
- [`src/server/agent/session-manager.ts`](../src/server/agent/session-manager.ts) — the termination listener calls `supervisor.release()` on every `session.cwd` and `session.repoWorktrees[].worktreePath` so the idle timer can arm.

The gateway exposes three routes for diagnostics and the in-tool progress signal:

| Route | Returns |
| --- | --- |
| `POST /api/lsp/<method>` | The dispatched tool result, normalised to cwd-relative paths. |
| `GET /api/lsp/stats` | Supervisor-wide snapshot: caps, per-entry state, refcount, in-flight, crash count, `evictedTotal`. |
| `GET /api/lsp/state` | Single-key state (`cold | starting | warm | stopping | stopped`) used by the tool progress-line emitter so the UI shows "starting typescript-language-server…" instead of an apparent hang. |

## When to use vs not use

**Prefer LSP for:**

- Symbol lookups — `lsp_definition` / `lsp_references` over `rg <name>(`. Grep matches strings, comments, and unrelated identifiers; LSP follows imports, type aliases, and re-exports.
- Post-edit verification in the iteration loop — `lsp_diagnostics(path)` settles in <1s against a warm server; `npm run check` takes 20–30s and re-checks the whole monorepo every time.
- Cross-file rename — `lsp_rename` returns a `WorkspaceEdit` you apply via `edit`, picking up every reference including ones inside JSDoc `@link` tags. Sed/grep replace will miss those *and* hit unrelated string literals.

**Stick with the old tools for:**

- Pure text search — string literals, comments, regex patterns, log messages: `grep` is the right tool.
- Files outside any project root (orphan scripts, top-level config) — there's no LSP server to ask.
- **Release gating** — `npm run check` remains authoritative across the whole monorepo (project references, multiple `tsconfig.*.json`, full re-check). Use `lsp_diagnostics` to iterate fast, then run `npm run check` once before commit. They occasionally disagree (different TS versions, project-reference boundaries); the design doc has more on why.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `{ error: "lsp_route_missing" }` on every LSP call | `handleApiRoute()` in `server.ts` is missing the `/api/lsp/<method>` dispatch block — typically a merge regression that dropped route wiring while leaving the supervisor, YAMLs, and extension intact | Run `npx playwright test tests/e2e/lsp-routes.spec.ts` — if any `POST /api/lsp/<method>` returns 404, the route block was dropped. Restore the `/api/lsp/<method>` handler block in `src/server/server.ts::handleApiRoute()`. |
| `lsp_diagnostics` reports a stale type — you edited `tsconfig.json` and the new path mapping isn't picked up | `fs.watch` debounce hasn't fired yet, or your editor wrote a temp file rather than touching `tsconfig.json` | `touch tsconfig.json` (or any matching `tsconfig.*.json`) — within 1.5s the supervisor gracefully shuts the entry down and the next LSP call respawns against the new config. |
| Every LSP call returns `{ error: "lsp_unavailable" }` | Server not installed, disabled by config, or crash-cooldown active | Check `GET /api/lsp/stats` — look at `entries[].crashCount` and `disabledUntil`; if it's the cooldown, wait 5 min. If `disabled: true`, set `lsp_disabled: false` in `project.yaml`. If `entries` is empty and no factory error, install the relevant language server (Docker image ships it; on host installs `npm i` in the project pulls `typescript-language-server` via deps). |
| `{ error: "lsp_capacity" }` under load | All `lsp_max_servers` entries have in-flight calls; no LRU victim available to evict | Retry once. If persistent, raise `lsp_max_servers` (default `4`) in `project.yaml`. Each warm server costs ~300–800MB RSS — size accordingly. |
| Pre-warm doesn't fire — first LSP call takes 3–8s even for the dominant language | `pre_warm_lsp: false` in `project.yaml`, OR the worktree has no detectable language markers (`detectLanguages()` returned empty) | Confirm `pre_warm_lsp` is unset or `true`. Confirm the worktree root has `tsconfig.json` / `jsconfig.json` / `package.json` for TypeScript detection. The supervisor walks up from `cwd` via `findProjectRoot`, so a deeply-nested `cwd` is fine as long as a project marker exists at some ancestor. |
| Warm-call latency >500ms (design target) | Cold-start race — pre-warm scheduled but not yet completed when the agent's first call lands | Expected on session attach. Pre-warm runs on a microtask, so a very early tool call can overtake it. Subsequent calls hit the warm path. If warm-state calls (verify via `GET /api/lsp/state`) still exceed 500ms, profile the adapter — `typescript.ts::diagnostics` settles via `publishDiagnostics` notifications and may wait briefly on a recently-opened file. |
| `[lsp] config change in …` log spam during a `git checkout` | `fs.watch` is firing once per touched config file in the branch swap | Harmless — the debounce coalesces within 1.5s and the entry restarts lazily. If the churn is disruptive, raise `configChangeDebounceMs` (constructor option). |
| Container-path leak — agent sees `/workspace-wt/...` in a result | The sandbox bridge's reverse-translation missed an edge case | File a bug with the originating call and `GET /api/lsp/stats` output. Workaround: rerun with `lsp_disabled: true` and fall back to grep. |
| Server keeps crashing — `crashCount` climbs to 3 and the 5-min cooldown trips | The language server hit a project it can't load (corrupt `tsconfig.json`, missing `node_modules/typescript`, OOM) | Inspect the gateway log — the adapter writes the child's stderr ring buffer on exit. Fix the underlying project; the cooldown self-clears after 5 min, or restart the gateway to reset crash state. |

## UI renderers

Every `lsp_*` tool has a custom UI renderer that replaces the raw JSON dump with IDE-style output. Without renderers, results from tools like `lsp_document_symbols` (which can return deeply nested trees) fell through to `DefaultRenderer.ts` and were nearly unreadable. The renderers make the output scannable at a glance — the same information a human would see in an IDE sidebar or problems pane.

### Renderer files

All renderers live in `src/ui/tools/renderers/` and are registered in `src/ui/tools/index.ts`. Each tool's YAML (`defaults/tools/lsp/*.yaml`) declares a `renderer:` field pointing at its file.

| Tool | Renderer | What it shows |
| --- | --- | --- |
| `lsp_definition` | `LspDefinitionRenderer.ts` | `path:line` for each definition location. Handles both `Location` and `Location[]` from the server. Null result: "No definition found." |
| `lsp_references` | `LspReferencesRenderer.ts` | Collapsible list grouped by file with per-file count badges. Header: `N references in M files`. |
| `lsp_hover` | `LspHoverRenderer.ts` | `contents` rendered as markdown via `<markdown-block>` in a scrollable card. Loaded lazily via `ensureMarkdownBlock()` to avoid bundle bloat. Null result: "No hover info." |
| `lsp_diagnostics` | `LspDiagnosticsRenderer.ts` | Collapsible list grouped by file, sorted error → warning → info → hint. Each row: severity icon + colour + `:line:col` + message + optional source chip. Empty result: green "No diagnostics — file is clean." |
| `lsp_document_symbols` | `LspDocumentSymbolsRenderer.ts` | Collapsible symbol tree (max 3 levels deep). Top level expanded; nested children collapse per parent. Beyond depth 3: "(N more nested symbols)" with collapsed JSON fallback for power users. |
| `lsp_workspace_symbol` | `LspWorkspaceSymbolRenderer.ts` | Collapsible flat list in server-relevance order. Each row: kind icon + name + grey `path:line`. Header: `N symbols matching "<query>"`. |
| `lsp_rename` | `LspRenameRenderer.ts` | Summary card: `Rename → <newName>` + `in N files (M total edits)` + per-file edit count. Footer: "Preview only — agent applies via `edit`." |

### Shared module — LspShared.ts

`src/ui/tools/renderers/LspShared.ts` consolidates helpers reused across all seven renderers:

- **`symbolKindLabel(n)`** — maps LSP `SymbolKind` integer to `{ label, icon }` using lucide icons.
- **`severityLabel(s)`** / **`normaliseSeverity(s)`** — maps diagnostic severity (string or numeric) to `{ label, color, icon }`. Numeric severities from some servers (1=error … 4=hint per LSP spec) are normalised to strings before styling.
- **`renderLocationRow(loc)`** — renders a `path:line` span (1-indexed for display) with monospace font.
- **`renderLspErrorEnvelope(body)`** / **`isLspErrorEnvelope(body)`** — renders `lsp_unavailable`, `lsp_capacity`, and `lsp_timeout` errors as a calm amber warning box with a one-line fallback hint ("LSP unavailable — try grep."), not a destructive error.
- **`parseLspResult(result)`** — extracts and JSON-parses the text content from a `ToolResultMessage`.
- **`normalisePath(p)`** — strips `file://` URI prefixes (including Windows `file:///C:/…` form) that the rename tool can leak through.
- **`summariseDiagnostics(diags)`** — produces a human-readable summary string like "2 errors, 1 warning".
- **`renderSymbolTree(syms, depth)`** / **`renderSymbolRow(s)`** — recursive lit `html` symbol tree with depth cap and collapsed JSON fallback.

### Registration

Renderers are wired in two places:

1. **`src/ui/tools/index.ts`** — `registerToolRenderer("lsp_definition", new LspDefinitionRenderer())` (and six more). This is where the renderer is actually active at runtime.
2. **`defaults/tools/lsp/<name>.yaml`** — `renderer: src/ui/tools/renderers/<Name>.ts` field. This is informational (used by docs and the config UI); the `index.ts` registration is authoritative.

## See also

- [docs/design/lsp-code-intelligence.md](design/lsp-code-intelligence.md) — full design doc (supervisor lifecycle states, eviction edge cases, Windows path handling, testing plan).
- [`src/server/lsp/`](../src/server/lsp/) — supervisor, adapters, sandbox bridge.
- [`defaults/tools/lsp/`](../defaults/tools/lsp/) — tool YAMLs (budget-pinned by `tests/tool-description-budget.test.ts`).
- [docs/internals.md](internals.md) — cross-references to surrounding subsystems.
