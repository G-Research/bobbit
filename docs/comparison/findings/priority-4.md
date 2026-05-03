# Priority 4 — Semantic Code Navigation / LSP

Investigated against Bobbit (`/Users/aj/Documents/dev/bobbit`, master @ `a3a9cc7`),
Claude Code (`/Users/aj/Documents/dev/claude-code`), and Hermes Agent
(`/Users/aj/Documents/dev/hermes-agent`). Phase-A audit files
(`audits/{bobbit,claude-code,hermes}.md`) cross-referenced and confirmed.

## Verdict summary

| Goal | Claim | Verdict | Confidence |
|---|---|---|---|
| 4.1 LSP tool surface | Bobbit has no semantic-navigation tool; add a 9-op LSP tool modelled on CC's `LSPTool`. | **real** | high |
| 4.2 LSP server lifecycle | Need an `LSPManager` to spawn / health-check / restart language servers per workspace. | **real** | high |
| 4.3 Search-order guidance | Coder role lacks "use LSP first, grep second" guidance. | **real (conditional on 4.1)** | high |
| 4.4 Mark LSP tool deferred | Defer the LSP schema so it does not bloat the base prompt. | **real (conditional on 2.4 + 4.1)** | high |
| 4.5 Graceful LSP fallback | Return a structured `lsp_unavailable` error with a grep hint when LSP can't be used. | **real (conditional on 4.1)** | high |

Note: 4.2–4.5 are all downstream of 4.1. None of the described infrastructure exists in Bobbit today, so the gaps are real, but only 4.1 is independently shippable. Hermes also has no LSP — so the only reference implementation for any of these is Claude Code.

---

## Goal 4.1 — LSP tool surface

**Doc claim.** Bobbit has no semantic navigation; add an LSP tool exposing 9 operations (`definition`, `references`, `document_symbols`, `workspace_symbols`, `implementation`, `hover`, `prepare_call_hierarchy`, `incoming_calls`, `outgoing_calls`). Reference: CC `src/tools/LSPTool/LSPTool.ts`.

**Bobbit reality.** No LSP tool, no LSP client, no language-server plumbing.
- `ls /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/` lists only `agent / browser / filesystem / html / shell / tasks / team / web` — no `lsp/` directory.
- `find /Users/aj/Documents/dev/bobbit -type d -name lsp` returns nothing.
- `grep -ril "lsp\|tsserver\|pyright\|language.server"` across `src/server/` and `.bobbit/` returns no LSP-related code; only incidental string hits (`"semantic" in design-mockup docs`, etc.).
- The only code-navigation guidance in the prompt is `/Users/aj/Documents/dev/bobbit/.bobbit/config/system-prompt.md:143`: *"For code navigation: Use grep, read, and find for searching code."*
- Phase-A Bobbit audit confirms the gap (`audits/bobbit.md:245`: *"Bobbit has no LSP, no auto-compaction, …"*).

**Claude Code reality.** Full implementation exists.
- Tool defined at `src/tools/LSPTool/LSPTool.ts:60`, name + description in `prompt.ts`, schemas in `schemas.ts`, formatters in `formatters.ts`.
- All 9 operations in `LSPTool.ts:64-72`:
  ```ts
  operation: z.enum([
    'goToDefinition', 'findReferences', 'hover',
    'documentSymbol', 'workspaceSymbol', 'goToImplementation',
    'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls',
  ])
  ```
- Inputs `{ operation, filePath, line, character, ... }` (`LSPTool.ts:60-89`); 10 MB file cap (`MAX_LSP_FILE_SIZE_BYTES = 10_000_000`, `:54`).
- Phase-A CC audit: `audits/claude-code.md:41-46`.

**Hermes reality.** No LSP. Per-language CLI linters only (`tools/file_operations.py:261-267` — `LINTERS = {'.py': 'python -m py_compile …', '.js': 'node --check …', '.ts': 'npx tsc --noEmit …', …}`). Phase-A Hermes audit explicitly says *"no LSP client; lint via per-language CLI subprocess only"* (`audits/hermes.md:223`, `:316`).

**Verdict.** **real** (high confidence).

**Reasoning.** The doc accurately describes Bobbit's gap and Claude Code's reference implementation. Hermes is not a reference for this goal. Building a full LSP integration is a substantial L-effort task that matches the doc's classification.

**Minimal proof of gap.**
- Bobbit (no LSP tool registry entry):
  ```
  $ ls /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/
  agent  browser  filesystem  html  shell  tasks  team  web
  $ grep -rin "lsp" /Users/aj/Documents/dev/bobbit/src/server/  # no hits
  ```
- Claude Code (`LSPTool.ts:60-72`, `:54`, `:130-140`):
  ```ts
  // src/tools/LSPTool/LSPTool.ts
  const MAX_LSP_FILE_SIZE_BYTES = 10_000_000   // :54
  const inputSchema = lazySchema(() => z.strictObject({
    operation: z.enum([
      'goToDefinition','findReferences','hover','documentSymbol',
      'workspaceSymbol','goToImplementation','prepareCallHierarchy',
      'incomingCalls','outgoingCalls',
    ]),
    filePath: z.string(),
    line: z.number().int().positive(),
    character: z.number().int().positive(),
  }))                                            // :60-89
  …
  shouldDefer: true,                             // :136
  isEnabled() { return isLspConnected() },       // :137
  ```

**Scope-down notes.** None for Phase-1 ambition; reasonable to pilot with TypeScript only (`tsserver`) and add Python (`pyright`) in a follow-up. The doc already lists exactly these two languages.

---

## Goal 4.2 — LSP server lifecycle

**Doc claim.** Need `LSPManager` that starts/keeps-alive/restarts language servers per (workspace, language); detect via `tsconfig.json` → tsserver, `pyproject.toml`/`requirements.txt` → pyright.

**Bobbit reality.** No `src/server/lsp/` directory, no manager, no language-server clients. (Same searches as 4.1.)

**Claude Code reality.** Full lifecycle infrastructure:
- `src/services/lsp/manager.ts:18-22` — singleton manager with `'not-started' | 'pending' | 'success' | 'failed'` initialization state and a generation counter to prevent stale init promises (`:34`).
- `src/services/lsp/LSPServerManager.ts:13-46` — manager interface: `init`, `getServerForFile`, `ensureServerStarted`, `getAllServers`, plus `didOpen`/`didChange`/`didSave`/`didClose` synchronization.
- `src/services/lsp/LSPServerInstance.ts` — per-instance lifecycle (spawn/restart/exit).
- `src/services/lsp/LSPClient.ts` — JSON-RPC client.
- `src/services/lsp/passiveFeedback.ts` — `registerLSPNotificationHandlers` for diagnostics push.
- Notification integration into Edit tool: `audits/claude-code.md:61` documents `didChange + didSave` notifications wired from `FileEditTool.ts:373-388`.

**Hermes reality.** None — confirmed in audit.

**Verdict.** **real** (high confidence).

**Reasoning.** Plumbing matches CC's design. Doc's interface sketch (`getOrStart`, `shutdown`, `status`) is a faithful subset of CC's `LSPServerManager`.

**Minimal proof of gap.**
- Bobbit: no `src/server/lsp/` directory exists.
- Claude Code (`src/services/lsp/manager.ts:13-44`):
  ```ts
  type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'
  let lspManagerInstance: LSPServerManager | undefined
  let initializationState: InitializationState = 'not-started'
  let initializationGeneration = 0           // prevents stale promises updating state
  ```
  and (`src/services/lsp/LSPServerManager.ts:16-39`):
  ```ts
  export type LSPServerManager = {
    init(): Promise<void>
    getServerForFile(filePath: string): LSPServerInstance | undefined
    ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
    sendRequest<T>(filePath: string, method: string, params: any): Promise<T>
    syncDidOpen / syncDidChange / syncDidSave / syncDidClose
    isFileOpen(filePath: string): boolean
  }
  ```

**Scope-down notes.** Doc's "periodic noop health-check" is not how CC does it (CC relies on instance-level exit handling and on-demand `ensureServerStarted`). Implementing CC's pattern is simpler — drop the noop polling unless reliability turns out to be poor in practice.

---

## Goal 4.3 — Search-order guidance

**Doc claim.** Even with LSP available, agents default to broad grep. Add a one-paragraph instruction to the lean and managed coder roles steering them to LSP first.

**Bobbit reality.** Coder role has no LSP guidance:
- `/Users/aj/Documents/dev/bobbit/.bobbit/config/roles/coder.yaml` lists tools `find`, `grep`, etc. (lines 25-26) but no LSP tool and no search-order text.
- The only code-navigation hint is in `system-prompt.md:143` (cited above), which says *"Use grep, read, and find"* — the opposite of LSP-first.
- The doc names `coder-lean.yaml` and `coder-managed.yaml`; neither file exists yet (`find /Users/aj/Documents/dev/bobbit -name "coder*.yaml"` returns only `coder.yaml`). This is consistent with Priority 1's goals to introduce lean/managed splits.

**Claude Code reality.** Search-order guidance is embedded in the LSP tool's own description (`src/tools/LSPTool/prompt.ts`, exported as `DESCRIPTION` and rendered into the tool docs). LSP being a deferred tool with `tool_search` discoverability is itself the steering mechanism.

**Hermes reality.** N/A (no LSP).

**Verdict.** **real**, conditional on Goal 4.1 shipping. Without an LSP tool, the guidance has nothing to steer toward.

**Reasoning.** The gap is real — the coder role currently steers toward grep — but the change is trivially small (a few hundred chars of YAML text) and only meaningful once 4.1 lands. Once 4.1 lands, the existing `system-prompt.md:143` line should also be updated, otherwise it actively contradicts the new role guidance.

**Minimal proof of gap.**
- Bobbit (`.bobbit/config/system-prompt.md:143`):
  ```
  - **For code navigation**: Use grep, read, and find for searching code. …
  ```
- Bobbit (`.bobbit/config/roles/coder.yaml:25-26`):
  ```yaml
  - find
  - grep
  ```
  No `lsp_*` tool listed; no search-order paragraph.
- Claude Code: see `LSPTool.ts:132-135` (`async description() { return DESCRIPTION }`) — guidance lives in `prompt.ts` shipped with the tool.

**Scope-down notes.** Update `system-prompt.md:143` at the same time. Files-to-touch list (`coder-lean.yaml` / `coder-managed.yaml`) presumes the Priority-1 lean/managed split has happened — if those files don't yet exist, fold the guidance into the existing `coder.yaml` for now.

---

## Goal 4.4 — Mark LSP tool deferred

**Doc claim.** Mark `defer: true` in `lsp/extension.yaml`. Initial tool list shows LSP as a deferred stub; full schema fetched via `tool_search`.

**Bobbit reality.** Bobbit has **no deferred-tool mechanism at all** today.
- `grep -rn "defer\|tool_search" /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/ /Users/aj/Documents/dev/bobbit/src/server/` returns no hits.
- Phase-A audit confirms: tools are loaded via YAML `summary/docs/detail_docs` and the entire schema ships in the prompt (`audits/bobbit.md:245` and the surrounding context describes a full-schema-always tool catalog). The Hermes Phase-A audit (`audits/hermes.md`) and `comparison.md:194` likewise contrast both Bobbit and Hermes against Claude Code's "deferred-schema `tool_search`" — neither has it.

**Claude Code reality.** Per-tool `shouldDefer: true` flag honoured by the prompt builder; LSP tool is one of the canonical deferrers (`LSPTool.ts:136`). Definition of the field at `src/Tool.ts:439-442`:
> *"When true, this tool is deferred (sent with `defer_loading: true`) and requires …"*

**Hermes reality.** No deferred-schema mechanism (`audits/hermes.md`; `comparison.md:194`).

**Verdict.** **real**, conditional on **Goal 2.4** (introduce deferred-tool mechanism + `tool_search`). The 4.4 line item itself is one-line YAML; the prerequisite is the heavy lift.

**Reasoning.** Doc explicitly states `Depends on: Goal 2.4`. Once 2.4 lands and 4.1 lands, 4.4 is genuinely a one-liner (`defer: true`). Real, but trivial — the value is gated by its dependencies.

**Minimal proof of gap.**
- Bobbit: no `defer:` key anywhere in `.bobbit/config/tools/`.
- Claude Code (`src/tools/LSPTool/LSPTool.ts:130-140`):
  ```ts
  maxResultSizeChars: 100_000,
  isLsp: true,
  async description() { return DESCRIPTION },
  userFacingName,
  shouldDefer: true,                 // :136 — the deferred marker
  isEnabled() { return isLspConnected() },
  ```

**Scope-down notes.** Land alongside 4.1 to avoid the new tool ever shipping its full schema in the base prompt. Don't track as a separate goal once 2.4 + 4.1 are merged — fold into 4.1's PR.

---

## Goal 4.5 — Graceful LSP fallback

**Doc claim.** When LSP is unavailable for a language or operation, return a structured `{error: 'lsp_unavailable', language, hint: 'Try grep instead.'}` with a suggested grep query.

**Bobbit reality.** N/A — no LSP code at all to fail gracefully.

**Claude Code reality.** Implements gating, not the exact error structure described:
- `LSPTool.ts:137`: `isEnabled() { return isLspConnected() }` — tool is hidden from the model when no LSP server is running.
- `tools.ts:224`: `...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : [])` — env-gated.
- `LSPTool.ts:14-19` imports `getInitializationStatus`, `isLspConnected`, `waitForInitialization` from `manager.ts`. The doc's `lsp_unavailable` shape isn't a verbatim CC pattern — CC simply doesn't expose the tool when LSP is down. CC's manager `InitializationState` (`manager.ts:13`, `'not-started' | 'pending' | 'success' | 'failed'`) is what would back this.

**Hermes reality.** N/A.

**Verdict.** **real**, conditional on 4.1 + 4.2.

**Reasoning.** Once 4.1+4.2 exist, the failure-mode handling described in the doc is genuinely needed (e.g. user opens a Rust file but only TS/Python servers are configured). The doc's specific JSON shape goes slightly *beyond* CC — CC hides the tool entirely rather than emitting a structured error — but the doc's approach is reasonable for Bobbit because (a) Bobbit YAML-driven tools can't easily hide themselves per call, and (b) returning a hint that names the right grep query is plausibly higher-value to the model than an enable/disable toggle.

**Minimal proof of gap.**
- Bobbit: no LSP code to fall back from.
- Claude Code (`src/services/lsp/manager.ts:13`):
  ```ts
  type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'
  ```
  Plus `LSPTool.ts:137` (`isEnabled() { return isLspConnected() }`) which gates the tool when the server isn't healthy.

**Scope-down notes.** Drop the "suggest the right grep query" sub-clause from the v1 — it's a heuristic that will need per-operation logic and adds risk of misleading hints. v1 should just return `{error:'lsp_unavailable', language, hint:'Try grep -n …'}` with a generic hint string, and only operation-specific hints land in a follow-up. Also: implement state mirroring CC's `InitializationState` enum rather than ad-hoc booleans.

---

## Cross-goal observations

1. **All five goals are real but four of them depend on 4.1.** A faithful schedule is: 4.1+4.2+4.5 land together (one PR can't realistically ship LSP without the manager and the failure handler), 4.3 lands as a tiny copy-edit, 4.4 folds into 4.1.
2. **Hermes is not a reference for this priority.** Both audit files and the comparison narrative confirm Hermes has no LSP either (`audits/hermes.md:223,316`; `comparison.md:393`). All citations for "real" verdicts are Bobbit + Claude Code.
3. **`system-prompt.md:143` directly contradicts the goal direction** ("Use grep, read, and find for searching code"). When LSP lands, this line must be updated, not just the role files. Worth flagging in the 4.3 PR.
4. **CC's `LSPTool` is env-gated (`ENABLE_LSP_TOOL`)** (`tools.ts:224`). Even Anthropic ship this behind a flag. A Bobbit equivalent should similarly be opt-in (per-project config in `project.yaml`) rather than always-on, given the manager-spawning cost.
