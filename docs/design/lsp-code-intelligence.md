# LSP Code Intelligence

**Status:** Draft (design doc — pre-implementation)
**Goal:** `goal-lsp-code-i-6a314817`
**Owner:** team-lsp

## 1. Motivation & success criteria

Today an agent that needs to "find every caller of `foo()`" runs `rg foo\\(` and
then `read`s 5–15 files. A post-edit safety check runs `npm run check` (20–30s,
full project). Both flows are expensive in tokens, latency, and correctness
(grep matches strings/comments; `tsc --noEmit` cannot answer "where is this
symbol defined?").

LSP replaces these with sub-second, scoped, authoritative queries against a
warm language server that already holds a parsed program graph.

**Per non-trivial turn (target):**

| Workflow              | Today (grep+read / tsc) | LSP        | Speedup |
| --------------------- | ----------------------- | ---------- | ------- |
| Find references       | 5–15k tokens, 2–5s      | ~50 tokens, <500ms | ~100× tokens |
| Go to definition      | 2–5k tokens, 1–3s       | ~50 tokens, <500ms | ~50–100× |
| Post-edit diagnostics | 20–30s `npm run check`  | <500ms warm | ~50× latency |

**Cost budget:** ~300–800MB RSS per warm `tsserver`, per active worktree.
Hard-capped + LRU-evicted by the supervisor (§3).

**Done when:**

- 7 `lsp_*` tools available to every coder/tester/reviewer role.
- TS/JS works out of the box. Pyright auto-detected.
- Pre-warm fires on session attach; warm-call latency p95 < 500ms.
- All tests pass: unit + E2E + manual integration. No flaky tests.
- `tests/tool-description-budget.test.ts` extended to cover the new group.

---

## 2. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ Gateway process (src/server/)                                          │
│                                                                        │
│   src/server/lsp/                                                      │
│   ├── supervisor.ts        ← one supervisor, owns all servers          │
│   ├── server-process.ts    ← spawns a single LSP child, JSON-RPC wire  │
│   ├── language-detect.ts   ← worktree → languages[]                    │
│   ├── client.ts            ← LspClient interface (per-language adapter)│
│   ├── clients/                                                         │
│   │   ├── typescript.ts    ← typescript-language-server adapter        │
│   │   └── pyright.ts       ← pyright-langserver adapter (optional v1)  │
│   ├── docs.ts              ← maps tool names → method dispatch         │
│   ├── error.ts             ← LspError taxonomy + retry policy          │
│   └── types.ts             ← Position, Location, Diagnostic, etc.      │
│                                                                        │
│   defaults/tools/lsp/                                                  │
│   ├── extension.ts         ← registers 7 lsp_* tools via pi extension  │
│   ├── lsp_definition.yaml                                              │
│   ├── lsp_references.yaml                                              │
│   ├── lsp_hover.yaml                                                   │
│   ├── lsp_diagnostics.yaml                                             │
│   ├── lsp_document_symbols.yaml                                        │
│   ├── lsp_workspace_symbol.yaml                                        │
│   └── lsp_rename.yaml                                                  │
│                                                                        │
│   integration hooks (see §4):                                          │
│   • src/server/agent/session-setup.ts::executePlan / executeWorktreeAsync
│       → call supervisor.preWarm(worktrees[], projectId)                │
│   • src/server/agent/session-manager.ts::addTerminationListener        │
│       → release supervisor refcount on session terminate / archive     │
│   • src/server/agent/worktree-pool.ts::cleanup paths                   │
│       → supervisor.shutdownForWorktree(worktreePath)                   │
└────────────────────────────────────────────────────────────────────────┘
                            │ JSON-RPC stdio
                            ▼
                ┌────────────────────────┐
                │ typescript-language-     │  one process per
                │ server (or pyright)      │  (worktree, language)
                └────────────────────────┘
```

**Wire protocol:** `vscode-jsonrpc` (framing) + `vscode-languageserver-protocol`
(types). Both are stable, MIT-licensed, ~50KB combined.

**Process model:** one supervisor singleton in the gateway process. Each
`(absoluteWorktreePath, language)` pair gets at most one child server. The
supervisor is the only thing that spawns LSP children; tools never spawn
their own.

**Tool surface:** `provider: bobbit-extension` via `defaults/tools/lsp/extension.ts` (§5). We considered an out-of-process
MCP server (separate `node mcp-lsp-server.js` started per session) and
rejected it — see §5.3.

**No vendoring of `typescript-language-server`.** We declare it as a
`dependencies` entry in `package.json` and `require.resolve` the binary at
runtime. Pyright is declared as `optionalDependencies` so its absence does
not break installs.

---

## 3. Supervisor

### 3.1 Type sketch

```ts
// src/server/lsp/supervisor.ts
export interface LspSupervisorOptions {
  /** Hard cap on concurrent LSP child processes. Default 4. */
  maxServers?: number;
  /** Idle TTL (ms). Server is shut down N ms after last tool call. Default 10 min. */
  idleTtlMs?: number;
  /** Project config store, queried for pre_warm_lsp + overrides. */
  projectConfig?: ProjectConfigStore;
  /** Optional sandbox bridge — when set, LSP children are spawned via docker exec. */
  sandbox?: SandboxBridge;
}

export interface ServerKey { worktreePath: string; language: Language; }
export type Language = "typescript" | "python" /* gopls/rust later */;

export class LspSupervisor {
  /** Lazy start; resolves once `initialized` notification has fired. */
  ensure(key: ServerKey): Promise<LspClient>;

  /** Best-effort, non-blocking. Returns immediately; errors logged not thrown. */
  preWarm(worktreePath: string, projectId?: string): void;

  /** Called on session terminate; decrements refcount. May trigger idle shutdown. */
  release(worktreePath: string): void;

  /** Called on worktree cleanup. Force-stop every server rooted here. */
  shutdownForWorktree(worktreePath: string): Promise<void>;

  /** Stats endpoint for diagnostics (GET /api/lsp/stats). */
  stats(): LspStats;

  /** Graceful shutdown of every child. Called on gateway shutdown. */
  shutdownAll(): Promise<void>;
}
```

### 3.2 Lifecycle states

```
  cold ──spawn──► starting ──initialized──► warm ──idle-N-min──► idle
                                              │                    │
                                              │                    └─shutdown─►cold
                                              │
                                              └──crash──► restarting ──► warm
```

- **cold**: no process exists.
- **starting**: process spawned, `initialize` JSON-RPC request in flight.
  Inbound tool calls are queued.
- **warm**: ready to serve. `lastActivityAt` updated on every call.
- **idle**: not strictly a separate state; the idle timer is `setTimeout(idleTtlMs)`
  that re-fires `lastActivityAt`. When it elapses, transition to cold (shutdown).
- **restarting**: triggered by `tsconfig.json`/`package.json` change or crash.
  Calls queue against a `Promise<LspClient>` resolved by the new instance.

### 3.3 LRU eviction

- `maxServers` defaults to **4** (configurable via project config
  `lsp_max_servers`).
- On `ensure()` with cap reached: pick least-recently-used (smallest
  `lastActivityAt`), `shutdown(graceful=true)`, then spawn new.
- Eviction is logged at info level (`[lsp] evicting <key> to make room for <key>`)
  so the operator can adjust if it churns.

### 3.4 Config-file watching

- For each warm server, watch `tsconfig.json`, `tsconfig.*.json`,
  `package.json`, `jsconfig.json` (TS), and `pyproject.toml`/`pyrightconfig.json`
  (Pyright) within the worktree root using `chokidar` (already a dep, used in
  search-service).
- Debounce 1500ms. On change → graceful shutdown → next call lazily respawns.
  We deliberately do **not** auto-respawn (eager respawn churns RAM during
  branch-switch flurries).

### 3.5 Crash handling

- Spawn child with `{ stdio: ["pipe","pipe","pipe"] }`. Capture stderr to a
  ring buffer (last 64KB).
- On unexpected `exit`: mark cold, increment `crashCount[key]`. If
  `crashCount[key] > 3` within 60s, **disable** the server for the worktree
  (return `LspUnavailableError` from tools) and surface stderr tail in the
  error message. Reset counter after 5 min.

### 3.6 Pre-warm

- `preWarm(worktreePath)` is fire-and-forget. It runs
  `detectLanguages(worktreePath)` (cheap synchronous check for
  `tsconfig.json`/`package.json` and `pyproject.toml`/`requirements.txt`),
  then schedules `ensure(...)` for each detected language on a microtask.
- Errors are logged at warn, never thrown. Pre-warm must not affect session
  ready latency.
- Pre-warm is **gated** by project config `pre_warm_lsp` (default `true`).
  Set `false` for low-RAM environments.

---

## 4. Worktree lifecycle integration

### 4.1 Pre-warm hooks

| Site                                                            | When                                                 | Call                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `src/server/agent/session-setup.ts::executePlan`                | end of `spawnAgent()` (line ~830+, after `postSpawn`) | `lspSupervisor.preWarm(session.cwd, plan.projectId)` |
| `src/server/agent/session-setup.ts::executeWorktreeAsync`       | after worktree is created (line ~640, around `worktreeCwd` resolution) | same |
| `src/server/agent/worktree-pool.ts::_fill()`                     | after a pool entry is created                       | optional, behind `lsp_pool_prewarm: false` default — pools have unknown future use, opt-in only |
| `src/server/agent/goal-manager.ts` (goal start)                  | inside the goal-start path that materializes the goal worktree | `lspSupervisor.preWarm(goalWorktreePath)` |

For **multi-repo** sessions, `session.repoWorktrees[]` is populated; pre-warm
fires once per component repo.

### 4.2 Teardown hooks

| Site                                                                  | When                  | Call                                                |
| --------------------------------------------------------------------- | --------------------- | --------------------------------------------------- |
| `src/server/agent/session-manager.ts::addTerminationListener` callback | session terminated / archived / purged | `lspSupervisor.release(session.cwd)` (and each repoWorktree) |
| `src/server/agent/session-setup.ts::handleSetupFailure`               | session setup failed  | `lspSupervisor.release(plan.worktreePath)` if it was pre-warmed |
| `src/server/skills/git.ts::cleanupWorktree`                           | worktree directory removed | `lspSupervisor.shutdownForWorktree(worktreePath)` **before** rm — otherwise the child holds open fds that block `rm -rf` on Windows |
| `src/server/agent/worktree-pool.ts::cleanupWorktree(...)` callers     | pool entry evicted    | same |

`release()` decrements a refcount per `worktreePath`. If the count hits 0 the
idle timer starts ticking. If a second session attaches to the same worktree
later, the server is still warm and no respawn happens.

### 4.3 Wiring (SessionManager constructor)

```ts
// session-manager.ts construction
this.lspSupervisor = new LspSupervisor({
  maxServers: projectConfigStore?.get("lsp_max_servers") ? Number(...) : 4,
  idleTtlMs: 10 * 60_000,
  projectConfig: projectConfigStore,
  sandbox: sandboxManager ? new SandboxLspBridge(sandboxManager) : undefined,
});
this.addTerminationListener((sessionId, info) => {
  // NOTE: terminateSession() deletes the session from the map *before*
  // firing listeners, so we must read cwd/repoWorktrees from the listener
  // info object (captured before deletion), not from this.store.get().
  if (!info.cwd) return;
  this.lspSupervisor.release(info.cwd);
  for (const r of info.repoWorktrees ?? []) this.lspSupervisor.release(r.worktreePath);
});
```

---

## 5. MCP tool surface

### 5.1 Provider choice — `provider: bobbit-extension`

> **Note:** The YAMLs shipped with `provider.type: builtin` but were silently
> dropped by `tool-activation.ts` (which only handles `builtin` for `bash` and
> the six file tools). Fixed in commit `4535a8d9` — all 7 YAMLs now use
> `provider.type: bobbit-extension` so the extension actually loads in agents.

The 7 tools register as **pi extension tools** through
`defaults/tools/lsp/extension.ts` (parallel to `defaults/tools/shell/extension.ts`).
The extension imports the supervisor by going through the gateway HTTP API
(`src/server/lsp/http.ts` — a thin internal endpoint, behind the standard
`Authorization: Bearer $BOBBIT_TOKEN` header), the same pattern `bash_bg` uses
to reach the gateway from inside a sandbox.

Why HTTP over a direct in-process call:

1. **Sandbox transparency.** Inside Docker the agent process cannot call
   gateway TypeScript directly anyway — `bash_bg`, `mount`, `preview` all reach
   back via HTTP. Doing the same here means **the same code path works in
   sandboxed and non-sandboxed sessions**.
2. **One LSP process per worktree, shared across sessions.** Multiple sessions
   on the same goal worktree (coder + reviewer + tester) hit the same warm
   server, paying the cost once.
3. **Out-of-process MCP server (rejected)** would mean per-session LSP
   children, defeating the warm-share win, and would re-add ~80MB RSS per
   agent for the Node MCP wrapper.

The extension exposes seven tools, each thinly wrapping a POST to
`/api/lsp/<method>` on the gateway. The gateway handler calls
`supervisor.ensure(...).then(client => client.<method>(...))`.

### 5.2 Tool signatures

All `line`/`character` are **0-indexed** to match LSP semantics natively. The
tool docs explicitly say this (and contrast with `read`'s 1-indexed `offset`).

| Tool                     | Params                                                            | Result                                                  |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `lsp_definition`         | `path:string, line:number, character:number`                       | `{ path, range: { start, end } } \| null`               |
| `lsp_references`         | `path, line, character, includeDeclaration?:boolean=true`         | `Location[]`                                            |
| `lsp_hover`              | `path, line, character`                                            | `{ contents: string /* markdown */, range? } \| null`   |
| `lsp_diagnostics`        | `path?:string` (omit → workspace)                                  | `Diagnostic[]` (`{ path, range, severity, message, source }`) |
| `lsp_document_symbols`   | `path`                                                             | `DocumentSymbol[]` (tree)                               |
| `lsp_workspace_symbol`   | `query:string`                                                     | `SymbolInformation[]` (max 100)                         |
| `lsp_rename`             | `path, line, character, newName:string`                            | `WorkspaceEdit` — agent applies via `edit`               |

All `path` values are **relative to session cwd** on input and output, to
round-trip with `read`/`edit`. The supervisor normalises to absolute paths
inside the LSP wire layer.

### 5.3 Sample tool YAML — `lsp_definition.yaml`

Budget pins: `description ≤ 150 chars`, every param description `≤ 80 chars`.
The pinning test (`tests/tool-description-budget.test.ts`) is extended to
include the `lsp` group.

```yaml
name: lsp_definition
description: "Jump to symbol definition. Returns file path + range; 0-indexed line/char"
summary: "Go to definition (LSP)"
params: [path, line, character]
provider:
  type: bobbit-extension
  extension: extension.ts
group: LSP
renderer: src/ui/tools/renderers/LspRenderer.ts
docs: |-
  100× cheaper than grep + read. line/character are **0-indexed** (LSP-native). Prefer over grep for symbol lookups.
detail_docs: >-
  ## Purpose

  Resolve the definition of the symbol at `(path, line, character)` using the
  language server attached to your worktree. Returns the canonical declaration
  site — for TypeScript, this follows `import` chains and type aliases.

  ## Parameters

  | Name | Type | Required | Description |
  |------|------|----------|-------------|
  | `path` | string | **Yes** | File path relative to session cwd. |
  | `line` | number | **Yes** | **0-indexed** line. (Note: `read` uses 1-indexed `offset`.) |
  | `character` | number | **Yes** | **0-indexed** column in the line. |

  ## When to Use

  - Before editing a call site, jump to the function's declaration to see its signature.
  - Following a chain of re-exports without manual grep.

  ## When NOT to Use

  - To find *callers* — use `lsp_references` instead.
  - For pure text search (string literals, comments) — `grep` is correct.

  ## Cold start

  First call against a new worktree may take 3–8s while `tsserver` loads the
  project. The tool emits a "starting language server…" status line during the
  wait. Subsequent calls are <500ms. Pre-warm fires on session attach, so most
  cold-start happens in the background before the agent starts coding.

  ## Notes

  - 0-indexed line/character matches LSP semantics. `read` uses 1-indexed `offset`
    for historical reasons; **be careful when round-tripping**.
  - If the supervisor cannot start a server (e.g. `typescript-language-server`
    not installed), the call returns `{ error: "lsp_unavailable", ... }` rather
    than throwing. The agent should fall back to grep in that case.
```

The other six YAMLs follow the same shape and are budgeted identically. The
extension file mirrors `defaults/tools/shell/extension.ts`:

```ts
// defaults/tools/lsp/extension.ts
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp_definition",
    description: "Jump to symbol definition. Returns file path + range; 0-indexed line/char",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to session cwd." }),
      line: Type.Number({ description: "0-indexed line (LSP-native; differs from read.offset)." }),
      character: Type.Number({ description: "0-indexed column in the line." }),
    }),
    async handler({ path, line, character }) {
      return callGatewayLsp("definition", { path, line, character, cwd: process.cwd() });
    },
  });
  // … six more registerTool() calls …
}
```

`callGatewayLsp` is a thin POST helper that reads `BOBBIT_TOKEN` +
`BOBBIT_GATEWAY_URL` from env (already injected for sandboxed sessions; same
mechanism `bash_bg` uses) and posts `{ method, params }` to
`/api/lsp/:method`. The response shape mirrors the gateway-side LSP types
verbatim.

### 5.4 Progress signalling

The pi extension API supports emitting tool **status lines** mid-call (the
same mechanism `bash` uses for its "running…" frame). When the gateway-side
handler observes the supervisor's state is `starting` for the worktree, it
streams a status line `"starting typescript-language-server (≈3s)…"` so the
UI shows progress instead of an apparent hang.

---

## 6. Sandbox awareness

In Docker mode (`sandbox: docker`), the gateway exposes a `SandboxLspBridge`
(`src/server/lsp/sandbox-bridge.ts`) that the supervisor uses when configured
with `{ sandbox }`. The bridge runs the LSP child inside the project's pool
container via `docker exec`, with stdin/stdout piped back to the gateway.

### Path translation

The bridge performs two-way path translation between host and container paths:

- **Host → container:** `toContainerPath(hostPath)` strips the host worktree-root
  prefix and replaces it with `/workspace-wt`, producing a path the language
  server inside the container can open. The mapping is purely lexical — no
  filesystem I/O — using `path.relative(hostWorktreeRoot, hostPath)`.
- **Container → host:** `toHostPath(containerPath)` reverses the same prefix
  substitution. Results from the language server (`definition.path`,
  `references[].path`, etc.) pass through this reverse map before being
  re-relativised against `session.cwd`, so the agent only ever sees cwd-relative
  paths.

The TypeScript adapter holds a **stable per-client bridge reference** (bound at
`spawn()` time) and applies `toHostPath` consistently to:
- `textDocument/definition` results
- `textDocument/references` results
- `textDocument/publishDiagnostics` URIs (which arrive as `file://` URIs from
  the language server and must be stripped and reverse-translated)
- `workspace/symbol` results
- `textDocument/rename` `WorkspaceEdit` keys

### `BOBBIT_HOST_CWD`

The LSP extension (`defaults/tools/lsp/extension.ts`) reads the agent's
current working directory from `BOBBIT_HOST_CWD` (injected by
`session-setup.ts`) rather than `process.cwd()`. Inside a sandbox,
`process.cwd()` returns the container path; the gateway endpoint expects
the host path so it can normalise file arguments correctly.

### Refcount leak fix

The termination listener in `session-manager.ts` used to re-look up the
session by ID to find its `cwd`. Because `terminateSession()` removes the
session from the in-memory map *before* firing listeners, the lookup returned
`undefined` and `lspSupervisor.release()` never ran — leaking language-server
processes. The fix captures `cwd`, `worktreePath`, and `repoWorktrees` from
the session *before* deletion and passes them through the listener info object.

### `sandboxCmd` support in server-process.ts

`src/server/lsp/server-process.ts` accepts an optional `sandboxCmd` option.
When present, the child process is spawned as `sandboxCmd.cmd(binaryAndArgs)`
(a function supplied by `DockerSandboxLspBridge`) rather than calling the
binary directly. This is how `docker exec` is injected into the spawn path
without the bridge having to know about the JSON-RPC framing.

### Current limitations

- Cross-sandbox path round-trips have not been hardened against every edge
  case (Windows host with Linux container, multi-mount worktrees). If absolute
  container paths leak into agent output, the bridge's `toHostPath` is the
  area to investigate.
- `typescript-language-server` must be installed inside the sandbox image.
  The Docker image (`docker/`) ships it pre-installed.

---

## 7. Language detection & pluggable adapters

### 7.1 Detection

`src/server/lsp/language-detect.ts`:

```ts
export function detectLanguages(worktreePath: string): Language[] {
  const out: Language[] = [];
  if (existsAny(worktreePath, ["tsconfig.json", "jsconfig.json", "package.json"]))
    out.push("typescript");
  if (existsAny(worktreePath, ["pyproject.toml", "requirements.txt", "setup.py"]))
    out.push("python");
  return out;
}
```

The supervisor exposes `supervisor.detect(worktreePath)` so callers (pre-warm,
tool dispatch) can ask which language a path belongs to. Per-file dispatch
(below) uses extension → language mapping (`.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts`
→ typescript; `.py` → python).

### 7.2 Adapter interface

```ts
// src/server/lsp/client.ts
export interface LspClient {
  readonly language: Language;
  readonly worktreePath: string;
  readonly state: "starting" | "warm" | "stopping" | "stopped";

  ensureDocOpen(absPath: string): Promise<void>; // textDocument/didOpen on first touch
  definition(absPath: string, line: number, character: number): Promise<Location | null>;
  references(absPath: string, line: number, character: number, includeDecl: boolean): Promise<Location[]>;
  hover(absPath: string, line: number, character: number): Promise<HoverResult | null>;
  diagnostics(absPath?: string): Promise<Diagnostic[]>;
  documentSymbols(absPath: string): Promise<DocumentSymbol[]>;
  workspaceSymbol(query: string): Promise<SymbolInformation[]>;
  rename(absPath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit>;

  shutdown(graceful: boolean): Promise<void>;
}

export interface LspClientFactory {
  language: Language;
  isInstalled(): boolean;
  spawn(opts: SpawnOpts): Promise<LspClient>;
}
```

Adding gopls / rust-analyzer later is a matter of dropping a new factory in
`src/server/lsp/clients/` and registering it. No supervisor changes.

### 7.3 v1 adapters

- **`clients/typescript.ts`** — required. Spawns
  `typescript-language-server --stdio`, sends `initialize` with
  `rootUri = file://<worktreePath>`, capabilities for definition, references,
  hover, diagnostics (pull-mode + publishDiagnostics fallback),
  documentSymbol, workspaceSymbol, rename. Caches the resolved
  `node_modules/typescript` location via `initializationOptions.tsserver.path`.
- **`clients/pyright.ts`** — optional v1. Spawns `pyright-langserver --stdio`.
  Same wiring; skipped silently when the binary is not in `PATH`.

---

## 8. Configuration

All keys live in `project.yaml` under the existing `ProjectConfigStore` flat
namespace. Defaults are baked into `LspSupervisor`.

| Key                 | Type     | Default | Notes                                                          |
| ------------------- | -------- | ------- | -------------------------------------------------------------- |
| `pre_warm_lsp`      | bool     | `true`  | Pre-warm on session attach. Set `false` on low-RAM machines.   |
| `lsp_max_servers`   | number   | `4`     | Hard cap on concurrent LSP children, gateway-wide.             |
| `lsp_idle_ttl_ms`   | number   | `600000` (10 min) | Idle shutdown timer.                                 |
| `lsp_languages`     | csv      | `auto`  | Force-enable languages, e.g. `typescript,python`. `auto` (default) uses detection. |
| `lsp_pool_prewarm`  | bool     | `false` | Pre-warm in worktree pool (off by default — pool worktrees may never be used). |
| `lsp_disabled`      | bool     | `false` | Kill switch; all `lsp_*` tools return `lsp_unavailable`.       |

These are read by the supervisor at construction time and again on
`ProjectConfigStore` change events (the store already emits change
notifications consumed by session-manager).

---

## 9. Testing plan

### 9.1 Unit (`tests/lsp/*.spec.ts`)

Fixture: a tiny TS project under `tests/fixtures/lsp-ts/` —

```
package.json (no deps)
tsconfig.json
src/math.ts        // export function add(a:number,b:number)
src/index.ts       // import { add } from "./math"; const x = add(1,2);
```

Tests (Node test runner, no harness, <5s each):

- `definition()` on `add` in `index.ts` resolves to `math.ts:0:16`.
- `references()` on `add` declaration returns 2 hits (decl + 1 call) with
  `includeDeclaration:true`, 1 hit without.
- `hover()` on `add` returns markdown containing `function add(a: number, b: number)`.
- `documentSymbols()` on `math.ts` returns 1 function symbol.
- `rename()` of `add` → `sum` produces a `WorkspaceEdit` with 2 file edits.
- Edit `math.ts` to introduce a type error; `diagnostics("src/math.ts")`
  returns 1 error within 1s; revert; diagnostics empty within 1s.

Helper `withWarmServer(language, worktree, fn)` starts a supervisor,
pre-warms, runs `fn(client)`, shuts down. No real session, no docker, no
sandbox — just the supervisor + child.

### 9.2 E2E API (`tests/e2e/lsp.spec.ts`)

Uses the in-process harness:

1. Spawn a session in `tests/fixtures/lsp-ts/`.
2. Await pre-warm via `GET /api/lsp/stats` polling for `warm` state (timeout 15s).
3. Call `lsp_diagnostics` via the MCP tool — empty.
4. Use `edit` to introduce a type error.
5. Call `lsp_diagnostics` — non-empty within 1s (assertion: `< 1000ms`).
6. Revert via `edit`; assert empty again.

### 9.3 Manual integration (`tests/manual-integration/lsp-prewarm.spec.ts`)

Real session in real Docker:

1. Create a new goal on a TS project; record `t0`.
2. Hit `GET /api/lsp/stats` every 100ms until the goal worktree's supervisor
   entry transitions to `warm`. Assert this happens **before** the session
   first goes `idle` (i.e. pre-warm raced ahead of model load).
3. From the agent, call `lsp_definition` once. Assert latency < 500ms (warm).
4. Tear down session; assert supervisor entry transitions to cold within
   `lsp_idle_ttl_ms` (we lower TTL to 5s for the test).

### 9.4 Budget test

Extend `tests/tool-description-budget.test.ts::EXTENSION_FILES` with
`"lsp"`. The new YAMLs are checked the same way as every other group.

### 9.5 No browser E2E

LSP is an agent-facing tool surface, not a UI feature, so no
`tests/e2e/ui/lsp.spec.ts`. (We will surface a minimal supervisor-stats
indicator later; that earns its own browser test when it lands.)

---

## 10. Docs plan

- **New: `docs/lsp.md`** — single page covering: supported languages, how
  pre-warm works, configuration keys, troubleshooting (server crashed →
  inspect stderr ring buffer; cold-start latency expectations; how to disable).
- **AGENTS.md** — extend the "Before editing" section with one line:
  > Prefer `lsp_definition` / `lsp_references` over `grep` for symbol lookup;
  > prefer `lsp_diagnostics` over `npm run check` for post-edit verification.
  Plus a `· [docs/lsp.md](docs/lsp.md)` link in the Reference docs list.
- **`docs/internals.md`** — short subsection under a new "LSP" heading
  pointing at this design doc and `src/server/lsp/supervisor.ts`.

---

## 11. Risks & open questions

### 11.1 RAM ceiling on busy gateways

Typical dev machine: 16–32GB. Four warm TS servers ≈ 1.5–3GB. Within budget.
A heavy team with 8 active goals × 2 worktrees each = 16 worktrees but cap
of 4 means LRU churn. If churn shows up in `lsp_evicted_total`, raise
`lsp_max_servers` per project.

**Mitigation:** ship a startup log line summarising effective limits and a
`GET /api/lsp/stats` endpoint exposing per-key state, RSS, lastActivity,
and an `evicted_total` counter for operator visibility.

### 11.2 Windows path quirks

- `vscode-jsonrpc` uses `file://` URIs; on Windows these are `file:///C:/...`.
  Supervisor normalises with `pathToFileURL()` / `fileURLToPath()` from
  `node:url`, **not** manual string concat.
- LSP returns drive-letter casing that may not match what `read`/`edit` see
  (`C:\` vs `c:\`). Normalise all paths via `path.normalize() + toLowerCase()`
  on the drive letter only.
- Pinning test: `tests/lsp/windows-paths.spec.ts` round-trips a definition
  result through `path.relative(cwd, ...)` on a synthetic Windows fixture
  (gated on `process.platform === "win32"` but the test file always lints).

### 11.3 Docker volume mount considerations

- The worktree is mounted at `/workspace-wt/<branchSlug>/` (multi-repo:
  `/workspace-wt/<branchSlug>/<repo>/`). The LSP child must be started with
  `cwd = <container path>`, not the host path. `SandboxLspBridge` performs
  this translation.
- `node_modules/typescript` must be **inside** the container for tsserver to
  find a sibling `typescript` package. We install `typescript` globally in
  the sandbox image (already present today as a build dep) and point
  `initializationOptions.tsserver.path` at the global resolution.

### 11.4 Eviction edge cases

- **Active call during eviction.** Eviction never targets the LRU entry if
  it has an in-flight request. If every entry has in-flight requests and we
  exceed the cap, the new `ensure()` rejects with `LspCapacityError` — the
  tool returns `{ error: "lsp_capacity" }` and the agent falls back. (Hitting
  this is "your machine is hosed" territory; the alternative — unbounded
  spawning — is worse.)
- **Restart-on-config-change collides with idle shutdown.** Coalesce:
  config-change cancels any pending idle timer, performs `shutdown(graceful)`,
  next `ensure()` triggers a clean restart.

### 11.5 Pyright availability

Pyright auto-detection is silent on miss. Open question: should we **warn**
the user once per session when a `pyproject.toml` is present but
`pyright-langserver` is not installed? Proposed: yes, as a single info-level
toast on first python LSP tool call. Defer to v1.1 if it adds scope.

### 11.6 Compatibility with project-wide `tsc --noEmit`

`lsp_diagnostics` and `npm run check` will, on rare occasions, disagree —
different TS versions, different `tsconfig` resolution, project references.
We document this in `docs/lsp.md` and recommend `npm run check` as the
**release-gate** check (slow but authoritative across the whole monorepo) and
`lsp_diagnostics` as the **iteration-loop** check (fast, file-scoped). They
are complements, not substitutes.

---

## 12. Implementation order (suggested)

1. Add deps; scaffold `src/server/lsp/` with empty modules and types.
2. Implement `typescript.ts` adapter + `supervisor.ts` (no sandbox path yet).
3. Wire `defaults/tools/lsp/` (7 tools, `provider.type: bobbit-extension` via `/api/lsp/*` endpoint).
4. Extend budget test; unit tests for adapter.
5. Wire pre-warm + teardown hooks in `session-setup.ts` and
   `session-manager.ts`. Add `release()` to `cleanupWorktree`.
6. Sandbox path (`SandboxLspBridge`) + Docker image deps; manual-integration test.
7. Pyright adapter (optional).
8. `docs/lsp.md`, AGENTS.md one-liner, internals pointer.

Each step is independently mergeable; only step 5 changes session lifecycle
and is the riskiest. Run `npm run check && npm run test:unit && npm run
test:e2e` between every step.

---

## 13. Out of scope (v1, re-confirmed)

- Completion / signature help / inline diagnostics overlay.
- Code actions beyond `rename`.
- UI: supervisor-status indicator. (A `GET /api/lsp/stats` endpoint exists
  for diagnostics, but no UI consumer ships in v1.)
- gopls / rust-analyzer adapters. (Architecture supports them; no
  implementation in v1.)
