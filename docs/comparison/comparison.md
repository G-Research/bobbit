# Bobbit vs Claude Code vs Hermes Agent

A source-grounded comparison of three coding harnesses.

**Source inspected:**

- Bobbit: `/Users/aj/Documents/dev/bobbit`
- Claude Code: `/Users/aj/Documents/dev/claude-code`
- Hermes Agent: `/Users/aj/Documents/dev/hermes-agent`

Scoring uses the rubric in [criteria.md](criteria.md). Each axis is 1–10; higher is better.

---

## Executive Summary

For pure code-development efficiency, the source-inspection ranking is:

1. **Claude Code** — strongest dedicated coding harness. Native tools for read/edit/glob/grep, an LSP tool with full symbol/reference/call-hierarchy operations, deferred tool schemas, microcompaction, autocompaction with circuit breakers, file-state cache, fork-subagent with byte-exact prompt sharing, and plan-mode. Defaults are calibrated for fast iteration on a single repo.
2. **Hermes Agent** — strong general-purpose agent with surprisingly good coding tools. Its file stack is much closer to Claude Code than Bobbit: read dedup with loop blocker, fuzzy-strategy patching, V4A multi-file patches, ripgrep search modes, cross-agent file-state registry with per-path locks, large-output persistence, structured compaction with a failure cooldown, and seven sandbox backends. Its weakness is breadth: skills, memory providers, gateways, browser tools, RL/datagen, voice, and cron all live in the same tree and inflate the tool/prompt surface even when narrowed.
3. **Bobbit** — strongest visible workflow/orchestration UI, but the weakest as a compact code harness. It eagerly assembles a global prompt + project docs + Claude Code memories + role prompt + goal/task spec + workflow context + tool docs, has no LSP, no auto-compaction, no read dedup, no per-turn budget, no plan mode, no prompt-injection scanning, and no read-before-edit enforcement at its layer. It wins decisively on goals/gates/team coordination and on user-editable YAML configuration.

The three harnesses are not on the same axis. Bobbit is optimised around **visible orchestration**; Claude Code around **the coding loop**; Hermes around **breadth as a platform**.

---

## Overall Scores by Criterion

Scores rate harness behaviour, not model quality. Rubric and definitions in [criteria.md](criteria.md).

### Group A — Context Economics

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| A1 | Baseline context efficiency | 4 | 9 | 7 | [0.1](bobbit-improvements.md#goal-01-section-by-section-prompt-budget), [1.1](bobbit-improvements.md#goal-11-mode-coding-vs-mode-managed), [1.2](bobbit-improvements.md#goal-12-coder-leanyaml-role), [2.1](bobbit-improvements.md#goal-21-replace-eager-yaml-docs-with-lazy-docs), [14.2](bobbit-improvements.md#goal-142-summarise-gate-context-by-default), [14.3](bobbit-improvements.md#goal-143-workflow-context-budget) |
| A2 | Tool loading efficiency | 5 | 9 | 7 | [2.1](bobbit-improvements.md#goal-21-replace-eager-yaml-docs-with-lazy-docs), [2.2](bobbit-improvements.md#goal-22-cache-parsed-tool-yaml), [2.3](bobbit-improvements.md#goal-23-group-tools-by-mode), [2.4](bobbit-improvements.md#goal-24-mark-heavy-tools-defer), [2.5](bobbit-improvements.md#goal-25-cap-tool-doc-section-size) |
| A3 | Prompt-cache strategy | 3 | 8 | 8 | [0.4](bobbit-improvements.md#goal-04-cache-hit-metric), [10.1](bobbit-improvements.md#goal-101-stable-prefix-vs-volatile-suffix), [10.2](bobbit-improvements.md#goal-102-cache-system-last-n-pattern), [10.3](bobbit-improvements.md#goal-103-provider-aware-cache-control), [10.4](bobbit-improvements.md#goal-104-cache-hit-reporting) |
| A4 | Per-turn output budget | 3 | 7 | 9 | [0.5](bobbit-improvements.md#goal-05-per-turn-output-budget-meter), [5.7](bobbit-improvements.md#goal-57-concise-diffs-in-tool-output), [6.1](bobbit-improvements.md#goal-61-per-result-persistence), [6.2](bobbit-improvements.md#goal-62-per-turn-aggregate-budget), [9.4](bobbit-improvements.md#goal-94-structured-delegate-results) |
| A5 | Read deduplication | 2 | 9 | 9 | [3.1](bobbit-improvements.md#goal-31-read-deduplication), [3.2](bobbit-improvements.md#goal-32-repeated-call-loop-guards), [6.6](bobbit-improvements.md#goal-66-read-state-reset-post-compaction) |
| A6 | Context compaction | 3 | 9 | 8 | [6.3](bobbit-improvements.md#goal-63-microcompact-old-tool-results), [6.4](bobbit-improvements.md#goal-64-auto-compaction-trigger), [6.5](bobbit-improvements.md#goal-65-compaction-failure-cooldown), [6.6](bobbit-improvements.md#goal-66-read-state-reset-post-compaction) |

### Group B — Code Discovery and Comprehension

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| B1 | File discovery | 6 | 8 | 8 | [3.3](bobbit-improvements.md#goal-33-truncation-flags), [3.5](bobbit-improvements.md#goal-35-upgrade-find-tool) |
| B2 | Code content search | 6 | 9 | 8 | [3.2](bobbit-improvements.md#goal-32-repeated-call-loop-guards), [3.3](bobbit-improvements.md#goal-33-truncation-flags), [3.4](bobbit-improvements.md#goal-34-upgrade-grep-tool) |
| B3 | Code-flow discovery | 3 | 9 | 3 | [4.1](bobbit-improvements.md#goal-41-lsp-tool-surface), [4.2](bobbit-improvements.md#goal-42-lsp-server-lifecycle), [4.3](bobbit-improvements.md#goal-43-search-order-guidance), [4.4](bobbit-improvements.md#goal-44-mark-lsp-tool-deferred), [4.5](bobbit-improvements.md#goal-45-graceful-lsp-fallback) |
| B4 | Read behavior | 5 | 9 | 9 | [3.1](bobbit-improvements.md#goal-31-read-deduplication), [3.3](bobbit-improvements.md#goal-33-truncation-flags), [3.6](bobbit-improvements.md#goal-36-device-file-blocklist), [3.7](bobbit-improvements.md#goal-37-secret-redaction-in-tool-output) |
| B5 | Search/read loop guards | 2 | 6 | 9 | [3.2](bobbit-improvements.md#goal-32-repeated-call-loop-guards), [3.1](bobbit-improvements.md#goal-31-read-deduplication) |

### Group C — Code Modification

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| C1 | Edit behavior | 5 | 9 | 8 | [5.1](bobbit-improvements.md#goal-51-read-before-edit-enforcement), [5.2](bobbit-improvements.md#goal-52-stale-file-detection), [5.3](bobbit-improvements.md#goal-53-replaceall-multi-edit), [5.5](bobbit-improvements.md#goal-55-fuzzy-match-fallback), [5.6](bobbit-improvements.md#goal-56-preserve-line-endings) |
| C2 | Multi-file / atomic patches | 3 | 6 | 9 | [5.4](bobbit-improvements.md#goal-54-v4a-multi-file-patch), [7.2](bobbit-improvements.md#goal-72-per-path-locks-for-writeedit) |
| C3 | Write/create behavior | 6 | 8 | 8 | [5.1](bobbit-improvements.md#goal-51-read-before-edit-enforcement), [5.6](bobbit-improvements.md#goal-56-preserve-line-endings), [5.8](bobbit-improvements.md#goal-58-post-write-byte-compare), [11.3](bobbit-improvements.md#goal-113-sensitive-path-write-deny), [11.4](bobbit-improvements.md#goal-114-env-controlled-write-root) |
| C4 | Concurrency safety | 5 | 8 | 9 | [7.1](bobbit-improvements.md#goal-71-process-wide-file-state-registry), [7.2](bobbit-improvements.md#goal-72-per-path-locks-for-writeedit), [7.3](bobbit-improvements.md#goal-73-sibling-agent-stale-warnings), [7.4](bobbit-improvements.md#goal-74-four-case-staleness-detection) |
| C5 | Post-edit verification | 4 | 7 | 8 | [5.8](bobbit-improvements.md#goal-58-post-write-byte-compare), [5.9](bobbit-improvements.md#goal-59-auto-syntax-check-on-patch), [13.1](bobbit-improvements.md#goal-131-auto-syntax-check-on-patch) |

### Group D — Execution and Verification

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| D1 | Shell/process handling | 7 | 8 | 9 | [6.1](bobbit-improvements.md#goal-61-per-result-persistence), [8.2](bobbit-improvements.md#goal-82-permission-classifier), [13.3](bobbit-improvements.md#goal-133-test-output-structuring) |
| D2 | Background process supervision | 7 | 7 | 8 | [0.5](bobbit-improvements.md#goal-05-per-turn-output-budget-meter), [6.1](bobbit-improvements.md#goal-61-per-result-persistence), [12.1](bobbit-improvements.md#goal-121-backend-abstraction) |
| D3 | Verification support | 6 | 8 | 8 | [5.9](bobbit-improvements.md#goal-59-auto-syntax-check-on-patch), [13.1](bobbit-improvements.md#goal-131-auto-syntax-check-on-patch), [13.2](bobbit-improvements.md#goal-132-verify-tool), [13.3](bobbit-improvements.md#goal-133-test-output-structuring) |
| D4 | Sandbox/isolation backends | 4 | 6 | 9 | [12.1](bobbit-improvements.md#goal-121-backend-abstraction), [12.2](bobbit-improvements.md#goal-122-docker-backend), [12.3](bobbit-improvements.md#goal-123-ssh-backend), [12.4](bobbit-improvements.md#goal-124-vercelmodaldaytona-backends) |
| D5 | Approval/danger gates | 5 | 7 | 8 | [8.2](bobbit-improvements.md#goal-82-permission-classifier), [9.6](bobbit-improvements.md#goal-96-auto-deny-dangerous-in-delegates), [11.3](bobbit-improvements.md#goal-113-sensitive-path-write-deny), [11.4](bobbit-improvements.md#goal-114-env-controlled-write-root) |

### Group E — Coordination and Long-Horizon Work

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| E1 | Delegation/subagents | 7 | 9 | 8 | [9.1](bobbit-improvements.md#goal-91-lightweight-delegate-mode), [9.2](bobbit-improvements.md#goal-92-context-fork-option), [9.3](bobbit-improvements.md#goal-93-concurrent-spawning), [9.4](bobbit-improvements.md#goal-94-structured-delegate-results), [9.5](bobbit-improvements.md#goal-95-delegate-toolset-restriction), [9.6](bobbit-improvements.md#goal-96-auto-deny-dangerous-in-delegates) |
| E2 | Plan / read-only mode | 2 | 9 | 4 | [8.1](bobbit-improvements.md#goal-81-plan-mode-toggle), [8.2](bobbit-improvements.md#goal-82-permission-classifier), [8.3](bobbit-improvements.md#goal-83-ui-affordance) |
| E3 | Workflow governance | 9 | 6 | 7 | [14.1](bobbit-improvements.md#goal-141-keep-managed-goal-mode-intact), [14.2](bobbit-improvements.md#goal-142-summarise-gate-context-by-default), [14.3](bobbit-improvements.md#goal-143-workflow-context-budget), [14.4](bobbit-improvements.md#goal-144-make-team-lead-less-eager) |
| E4 | Memory/skills discipline | 4 | 8 | 7 | [1.4](bobbit-improvements.md#goal-14-disable-mandatory-memory-workflow-in-lean-mode), [14.5](bobbit-improvements.md#goal-145-memory-ranking-for-managed-mode) |
| E5 | Failure recovery | 4 | 8 | 7 | [4.5](bobbit-improvements.md#goal-45-graceful-lsp-fallback), [6.5](bobbit-improvements.md#goal-65-compaction-failure-cooldown), [7.4](bobbit-improvements.md#goal-74-four-case-staleness-detection) |

### Group F — Trust, Safety, Extensibility

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| F1 | Safety/security posture | 5 | 8 | 9 | [3.7](bobbit-improvements.md#goal-37-secret-redaction-in-tool-output), [8.2](bobbit-improvements.md#goal-82-permission-classifier), [11.3](bobbit-improvements.md#goal-113-sensitive-path-write-deny), [11.4](bobbit-improvements.md#goal-114-env-controlled-write-root) |
| F2 | Prompt-injection defense | 2 | 6 | 9 | [11.1](bobbit-improvements.md#goal-111-context-file-scanner), [11.2](bobbit-improvements.md#goal-112-yaml-frontmatter-strip), [11.5](bobbit-improvements.md#goal-115-streaming-context-fence-scrubber) |
| F3 | Configurability/extensibility | 9 | 7 | 9 | Preserve current strength; extend with [2.3](bobbit-improvements.md#goal-23-group-tools-by-mode), [2.4](bobbit-improvements.md#goal-24-mark-heavy-tools-defer), [12.1](bobbit-improvements.md#goal-121-backend-abstraction) |
| F4 | Provider abstraction | 4 | 7 | 9 | [10.3](bobbit-improvements.md#goal-103-provider-aware-cache-control), [12.1](bobbit-improvements.md#goal-121-backend-abstraction), [12.4](bobbit-improvements.md#goal-124-vercelmodaldaytona-backends) |
| F5 | Observability | 6 | 7 | 7 | [0.1](bobbit-improvements.md#goal-01-section-by-section-prompt-budget), [0.2](bobbit-improvements.md#goal-02-persisted-prompt-diagnostics), [0.3](bobbit-improvements.md#goal-03-ui-warnings-for-bloated-sessions), [0.4](bobbit-improvements.md#goal-04-cache-hit-metric), [0.5](bobbit-improvements.md#goal-05-per-turn-output-budget-meter), [10.4](bobbit-improvements.md#goal-104-cache-hit-reporting) |

### Group G — Product Fit

| # | Criterion | Bobbit | Claude Code | Hermes Agent | Bobbit improvement goals |
|---|---|---:|---:|---:|---|
| G1 | Product fit for everyday coding | 5 | 9 | 7 | [1.1](bobbit-improvements.md#goal-11-mode-coding-vs-mode-managed), [1.2](bobbit-improvements.md#goal-12-coder-leanyaml-role), [1.3](bobbit-improvements.md#goal-13-make-gates-opt-in-for-small-tasks), [1.4](bobbit-improvements.md#goal-14-disable-mandatory-memory-workflow-in-lean-mode), [2.3](bobbit-improvements.md#goal-23-group-tools-by-mode) |
| G2 | First-time-user friction | 6 | 8 | 5 | [1.5](bobbit-improvements.md#goal-15-auto-detect-lean-candidacy), [1.6](bobbit-improvements.md#goal-16-ui-mode-badge), [8.3](bobbit-improvements.md#goal-83-ui-affordance) |

### Aggregate

| Metric | Bobbit | Claude Code | Hermes Agent |
|---|---:|---:|---:|
| Mean across all 33 axes | **4.7** | **7.7** | **7.6** |
| Median | 5 | 8 | 8 |
| Coding-loop subset (A1–A6, B*, C*, D1–D3) | **4.5** | **8.2** | **7.8** |
| Orchestration subset (E*, F3) | **6.6** | **7.7** | **7.0** |

Hermes and Claude Code score nearly identically in aggregate, but they get there from different directions: Claude Code dominates the coding loop, Hermes dominates safety/concurrency/sandbox breadth, and Bobbit dominates visible workflow governance. Bobbit's mean is dragged down primarily by Group A (context economics) and B3/B5 (code-flow discovery and loop guards).

---

## Harness Profiles

| Harness | Best At | Weakest At | Coding-Efficiency Verdict |
|---|---|---|---|
| Bobbit | Managed workflows, visible goals/gates, role-based teams, UI orchestration, configurable prompts/tools. | Lean context use, precise code-flow navigation, low-ceremony single-task coding, prompt-injection defense. | Strong orchestration shell around an agent, but too heavy by default for fast coding. |
| Claude Code | Tight coding loop, source discovery, edit safety, context survival, LSP-assisted navigation, deferred tools, plan mode. | Product-level workflow governance and user-editable orchestration. | Best pure coding harness of the three. |
| Hermes Agent | General-purpose agent platform with strong file/search/patch/shell tooling, subagents, memory, skills, gateway, cron, sandbox backends, prompt-injection defense. | Code-flow discovery via LSP and avoiding broad tool/prompt surface. | Stronger than Bobbit for code mechanics; less specialized and lean than Claude Code. |

---

## Detailed Findings by Harness

### Bobbit

Bobbit is architected as a gateway/session/team/workflow layer around `@mariozechner/pi-coding-agent`. The bridge launches the coding agent in RPC mode at [src/server/agent/rpc-bridge.ts](../bobbit/src/server/agent/rpc-bridge.ts) and selects builtin/custom tools. The agent process owns the actual coding loop; Bobbit orchestrates it.

**Prompt assembly** ([src/server/agent/system-prompt.ts:201–301](../bobbit/src/server/agent/system-prompt.ts)). Sections concatenated with `\n\n---\n\n`:
1. Global system prompt from `.bobbit/config/system-prompt.md`
2. `AGENTS.md` + `CLAUDE.md` (recursively expanded `@`-references)
3. Claude Code memory files from `~/.claude/projects/{encodedCwd}/memory/*.md` — capped at **20 files / ~16 KB total** ([line 134](../bobbit/src/server/agent/system-prompt.ts:134)), filtered to `user`/`feedback`/`project` types
4. Memory Context hint with graphiti `group_id`
5. Goal spec (title, state, role prompt, tool restrictions)
6. Personalities (name + snippet)
7. Tool documentation (re-rendered each turn)
8. Task context (type, title, spec, dependencies)
9. Workflow upstream-gate context

There is **no overall token budget**. The 16 KB memory cap is the only soft cap; everything else is included if present. The default coder role at [.bobbit/config/roles/coder.yaml](../bobbit/.bobbit/config/roles/coder.yaml) is workflow-heavy (~1.5 KB on its own): gates, design docs, git branches, commits, pushes, memory, previews, delegated/team work. This is appropriate for managed projects but expensive for "fix this bug."

**Tool docs**. [src/server/agent/tool-manager.ts](../bobbit/src/server/agent/tool-manager.ts:53-200) re-scans `.bobbit/config/tools/` and re-parses YAML on every `getAvailableTools()` call. Tool docs are emitted eagerly in the prompt; there is no `tool_search` or schema deferral.

**Delegate** ([.bobbit/config/tools/agent/extension.ts:237–384](../bobbit/.bobbit/config/tools/agent/extension.ts)). Supports `parallel: [...]` with `Promise.all` over child sessions. Output is truncated at **3000 chars per parallel result** and **5000 chars for single delegation**. Each delegate is a fresh session with full prompt assembly.

**Shell** ([.bobbit/config/tools/shell/extension.ts](../bobbit/.bobbit/config/tools/shell/extension.ts)). Caps: **50 KB / 2000 lines, tail-truncated** ([line 23-24](../bobbit/.bobbit/config/tools/shell/extension.ts:23)). Default timeout **300 s**. `bash_bg` exposes `create`/`logs`/`kill`/`list` actions for FD-safe background processes via the gateway API. This is one of Bobbit's better implementation pieces.

**Compaction**. [src/server/agent/rpc-bridge.ts:146–148](../bobbit/src/server/agent/rpc-bridge.ts:146) exposes a manual `compact(timeoutMs=120_000)` RPC. There is **no auto-trigger** in the gateway; the agent process manages its own context, but there is no observable threshold-driven compaction at the Bobbit layer.

**LSP / symbol navigation**: not present. Bobbit relies on MCP tools (`codebase-memory-mcp` mentioned in `AGENTS.md`) for graph queries; no native LSP integration.

**Lean coding mode**: not present. There is no toggle that suppresses gates/team/memory machinery for direct coding sessions.

**Prompt-injection scanning of context files**: not present at the Bobbit layer. `AGENTS.md`/`CLAUDE.md`/memory files are concatenated verbatim.

The strengths of Bobbit are real: visible team/goal/gate UI, YAML-editable roles and tools, structured task DAG with `.bobbit/state/tasks.json` and an outcomes DB feeding an Observer self-improver, parallel `delegate`, and the `bash_bg` extension. The weaknesses are concentrated in baseline context economy and fast-coding ergonomics.

### Claude Code

Claude Code is the most code-specialised harness. The base tool pool lives at [src/tools.ts](../claude-code/src/tools.ts), with native `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash`, `Agent`, `TodoWrite`, plus optional `LSP`, `MCP`, `ToolSearch`, plan-mode, worktree, and other tools.

**Context efficiency** is layered:

- **Tool deferral**. [src/tools/ToolSearchTool/](../claude-code/src/tools/ToolSearchTool) loads schemas on demand. Tools marked `shouldDefer: true`: `ConfigTool`, `EnterWorktreeTool`, `EnterPlanModeTool`, `ExitWorktreeTool`, `ExitPlanModeTool`, `LSPTool`, `ListMcpResourcesTool`, `NotebookEditTool`. These are advertised by name only; full schemas fetch lazily.
- **Microcompaction** ([src/services/compact/microCompact.ts](../claude-code/src/services/compact/microCompact.ts)). Strips old tool results from `FILE_READ`, `SHELL`, `GREP`, `GLOB`, `WEB_SEARCH`, `WEB_FETCH`, `FILE_EDIT`, `FILE_WRITE`. Time-based purge of stale results; cached state with pinned-edit re-injection on cache hits ([lines 71–117](../claude-code/src/services/compact/microCompact.ts:71)).
- **Autocompaction** ([src/services/compact/autoCompact.ts](../claude-code/src/services/compact/autoCompact.ts)). `AUTOCOMPACT_BUFFER_TOKENS = 13000` ([line 62](../claude-code/src/services/compact/autoCompact.ts:62)), warning + error thresholds at `20000` ([lines 63–64](../claude-code/src/services/compact/autoCompact.ts:63)), and **`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`** circuit breaker ([line 70](../claude-code/src/services/compact/autoCompact.ts:70)). Env overrides for window, percent, and blocking limit.
- **Memoised base context** ([src/context.ts](../claude-code/src/context.ts)) is relatively compact.

**Read** ([src/tools/FileReadTool/limits.ts](../claude-code/src/tools/FileReadTool/limits.ts)). Dual budget: **256 KB by bytes** and **25 000 tokens** ([line 18](../claude-code/src/tools/FileReadTool/limits.ts:18)). Env override `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` ([line 25](../claude-code/src/tools/FileReadTool/limits.ts:25)) and GrowthBook flag `tengu_amber_wren` ([line 56](../claude-code/src/tools/FileReadTool/limits.ts:56)) gate experimental limits. File-state cache returns an unchanged stub for repeated reads of the same range ([src/tools/FileReadTool/FileReadTool.ts](../claude-code/src/tools/FileReadTool/FileReadTool.ts)). Image, PDF (≤20 pages per call), and Jupyter notebook handling. Binary-extension and device-file blocks.

**Grep** ([src/tools/GrepTool/GrepTool.ts](../claude-code/src/tools/GrepTool/GrepTool.ts)). Default `head_limit = 250` ([line 108](../claude-code/src/tools/GrepTool/GrepTool.ts:108)), `head_limit = 0` for unlimited. `offset` for pagination. Output modes `content` / `files_with_matches` / `count`. Context lines via `-A`/`-B`/`-C`. `appliedLimit` reported only when truncation actually occurred ([line 126](../claude-code/src/tools/GrepTool/GrepTool.ts:126)) — the model does not pay for "you have full results" boilerplate.

**Edit** ([src/tools/FileEditTool/FileEditTool.ts](../claude-code/src/tools/FileEditTool/FileEditTool.ts)). Exact-match `old_string`/`new_string`, `replace_all` flag, validates input pre-execution. `FILE_UNEXPECTEDLY_MODIFIED_ERROR` ([line 55](../claude-code/src/tools/FileEditTool/FileEditTool.ts:55)) signals stale-file. **1 GiB** safety cap on edit file size. Post-edit git-diff fetched for verification.

**LSP** ([src/tools/LSPTool/LSPTool.ts](../claude-code/src/tools/LSPTool/LSPTool.ts)). Operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`. Marked `shouldDefer: true` ([line 136](../claude-code/src/tools/LSPTool/LSPTool.ts:136)) and gated on `isLspConnected()` ([line 138](../claude-code/src/tools/LSPTool/LSPTool.ts:138)).

**Agent / fork** ([src/tools/AgentTool/AgentTool.tsx](../claude-code/src/tools/AgentTool/AgentTool.tsx) + [forkSubagent.ts](../claude-code/src/tools/AgentTool/forkSubagent.ts)). Implicit fork when `subagent_type` omitted and the `FORK_SUBAGENT` feature is enabled. Fork children get the full parent conversation + system prompt (byte-exact for cache reuse) plus a `FORK_BOILERPLATE_TAG` to prevent recursive fork. Worktree isolation supported. Async by default with a 120-s auto-background path.

**Plan mode** ([src/tools/EnterPlanModeTool](../claude-code/src/tools/EnterPlanModeTool)). User toggles `plan` mode; permission classifier dynamically blocks mutation tools while allowing reads and exploration. Distinct from a static blocklist — the classifier evaluates per-call.

**Memory** ([src/memdir/](../claude-code/src/memdir)). `MEMORY.md` entrypoint, **200 lines / 25 KB** ([lines 35–38](../claude-code/src/memdir/memdir.ts:35)). Type filter `user`/`feedback`/`project`. Semantic relevance via `findRelevantMemories.ts`; freshness signals via `memoryAge.ts`.

**Bash** ([src/tools/BashTool/](../claude-code/src/tools/BashTool)). `run_in_background`, configurable timeout, env override for default/max. Tail-based truncation similar to Bobbit.

The main downside of Claude Code is complexity and feature gating. Some best behaviour depends on enabled LSP, GrowthBook flags, or environment support; it is less user-editable than Bobbit/Hermes.

### Hermes Agent

Hermes is broader than a code harness: CLI/TUI, gateway messaging, cron, memory providers, skills, plugins, browser tools, sandbox backends, RL/research tooling. For coding, though, its file stack is unusually strong.

**Prompt assembly** ([agent/prompt_builder.py](../hermes-agent/agent/prompt_builder.py)). Identity (default at [lines 134–142](../hermes-agent/agent/prompt_builder.py:134)), context-file injection scanner ([lines 36–73](../hermes-agent/agent/prompt_builder.py:36)) covering 13 threat patterns (ignore-instructions, system override, hidden Unicode `U+200B–U+202E`, exfil curls, secret-file reads such as `~/.env` `~/.netrc` `~/.pgpass`, hidden HTML), YAML frontmatter stripping ([lines 113–127](../hermes-agent/agent/prompt_builder.py:113)), skills indexing, optional memory guidance.

**Prompt cache** ([agent/prompt_caching.py:41–72](../hermes-agent/agent/prompt_caching.py:41)). Strategy `system_and_3` — marks system + last 3 non-system messages with `cache_control: {"type": "ephemeral"}`. TTL default 5 minutes (configurable to 1 hour at [line 59](../hermes-agent/agent/prompt_caching.py:59)).

**Tool registry** ([tools/registry.py](../hermes-agent/tools/registry.py)). Dynamic discovery via AST scan of `tools/*.py` for `registry.register()` calls ([lines 57–74](../hermes-agent/tools/registry.py:57)). Per-tool `max_result_size_chars` override ([line 370](../hermes-agent/tools/registry.py:370)). Toolsets composed via `includes` ([toolsets.py:68](../hermes-agent/toolsets.py:68)). MCP integration with auto-reload on config change. **No equivalent of Claude's deferred-schema `tool_search`** — schemas filter by toolset but ship in full.

**Read** ([tools/file_tools.py](../hermes-agent/tools/file_tools.py)). Default cap **100 000 chars** ([line 35](../hermes-agent/tools/file_tools.py:35)), default per-read line cap **500** (max **2000** at [line 1034](../hermes-agent/tools/file_tools.py:1034)). Read dedup keyed by `(path, offset, limit, mtime)` ([lines 485–596](../hermes-agent/tools/file_tools.py:485)); stub return after 2 hits, **warning at 3, hard block at 4** ([lines 633–644](../hermes-agent/tools/file_tools.py:633)). Device blocklist `/dev/zero` `/dev/random` `/dev/urandom` `/dev/full` `/dev/stdin` `/dev/tty` `/dev/console` `/dev/stdout` `/dev/stderr` `/dev/{fd/0,1,2}` ([lines 69–78](../hermes-agent/tools/file_tools.py:69)). Secret redaction post-read.

**Search** ([tools/file_tools.py:943–1010](../hermes-agent/tools/file_tools.py:943)). Ripgrep-backed; `target='content'` or `target='files'` (mtime-sorted). Modes `content` / `files_only` / `count`. Pagination with explicit next-offset hints ([lines 1005–1007](../hermes-agent/tools/file_tools.py:1005)). Same loop blocker as `read_file`. Glob filters via `--type`/`--glob`. Results subject to secret redaction.

**File state** ([tools/file_state.py](../hermes-agent/tools/file_state.py)). Per-agent read stamps (`{task_id: {path: (mtime, read_ts, partial)}}`), global last-writer map, **per-path `threading.Lock`** for serialised read→modify→write ([line 307](../hermes-agent/tools/file_state.py:307)). Bounds **`_MAX_PATHS_PER_AGENT = 4096`** ([line 53](../hermes-agent/tools/file_state.py:53)), **`_MAX_GLOBAL_WRITERS = 4096`** ([line 56](../hermes-agent/tools/file_state.py:56)), LRU on overflow. Four staleness cases detected: sibling-subagent write, external mtime drift, partial-read-before-overwrite, write-without-read. Subagent writes appended to delegate result for parent awareness.

**Patch** ([tools/file_tools.py:847–940](../hermes-agent/tools/file_tools.py:847) and [tools/file_operations.py:755+](../hermes-agent/tools/file_operations.py:755)). Modes: `replace` (find-and-replace with **9 fuzzy strategies**) and `patch` (V4A multi-file with `*** Update File:` markers). Multi-file patches lock paths in **sorted order** to prevent deadlock on overlapping edits ([lines 883–885](../hermes-agent/tools/file_tools.py:883)). Post-write byte-for-byte read-back ([lines 798–806](../hermes-agent/tools/file_operations.py:798)). Auto syntax check by extension: `.py` (`python -m py_compile`), `.js` (`node --check`), `.ts` (`npx tsc --noEmit`), `.go` (`go vet`), `.rs` (`rustfmt --check`).

**Tool result storage** ([tools/tool_result_storage.py](../hermes-agent/tools/tool_result_storage.py)). Two-layer:

- **Per-result**: `maybe_persist_tool_result` ([lines 116–172](../hermes-agent/tools/tool_result_storage.py:116)) — if a single tool's output exceeds its registered max, persist to `/tmp/hermes-results/{tool_use_id}.txt`, return preview (`DEFAULT_PREVIEW_SIZE_CHARS = 1500`) plus the path.
- **Per-turn**: `enforce_turn_budget` ([lines 175–226](../hermes-agent/tools/tool_result_storage.py:175)) — `MAX_TURN_BUDGET_CHARS = 200_000`. After all tool results collect, persist largest-first until under budget.

**Compaction** ([agent/context_compressor.py](../hermes-agent/agent/context_compressor.py)). Trigger at **75 % of context length** (`threshold_percent = 0.75` in [agent/context_engine.py:59](../hermes-agent/agent/context_engine.py:59)). Protect head (first 3 messages) and tail (last 20). Summary scaled to 20 % of compressed-content tokens, min 2 K, max 12 K. **Failure cooldown 600 s** ([line 74](../hermes-agent/agent/context_compressor.py:74)). Image token estimate 1 600 tokens/image. Token-level dedup of duplicate outputs.

**Shell** ([tools/terminal_tool.py](../hermes-agent/tools/terminal_tool.py)). Backends via `TERMINAL_ENV` env: `local`, `docker` (`TERMINAL_DOCKER_IMAGE`), `modal`, `ssh` (`TERMINAL_SSH_HOST`), `singularity` (`TERMINAL_SINGULARITY_IMAGE`), `daytona`, `vercel_sandbox`. Approval gates via `prompt_dangerous_approval`; subagent workers default to auto-deny (configurable to auto-approve via `delegation.subagent_auto_approve`). Process registry + interrupt support.

**Memory** ([agent/memory_manager.py](../hermes-agent/agent/memory_manager.py)). Singleton with always-on `BuiltinMemoryProvider` (`MEMORY.md`/`USER.md`) plus **at most one** external provider (Honcho, Mem0, Hindsight, graphiti, …) — enforced to prevent tool-schema bloat. Provider lifecycle: `initialize` / `system_prompt_block` / `prefetch` (background) / `sync_turn` (async post-turn) / `handle_tool_call` / `shutdown`. Streaming context-fence scrubber prevents leaked memory tags in deltas.

**Delegation** ([tools/delegate_tool.py](../hermes-agent/tools/delegate_tool.py)). `ThreadPoolExecutor` for parallel children. Children get fresh conversation, own `task_id`, restricted toolset (excludes `delegate_task`, `clarify`, `memory`, `send_message`, `execute_code`), focused system prompt. Sibling stale-file warnings appended via `file_state.writes_since`.

**Safety** ([agent/file_safety.py](../hermes-agent/agent/file_safety.py)). Write deny-list: `~/.ssh/*`, `~/.pgpass`, `~/.netrc`, `/etc/sudoers`, `/etc/passwd`, `~/.bashrc`, `~/.zshrc`, `~/.config/gh`, `~/.docker`, `~/.azure`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/systemd`, `/etc/sudoers.d`. Optional `HERMES_WRITE_SAFE_ROOT` env to constrain all writes to a subtree. Read blocks on Hermes' own cached skill index to prevent injection via cached YAML.

The main coding gap vs Claude Code is **code-flow discovery**: there is no native LSP. The other weakness is **breadth** — `agent/prompt_builder.py` can include identity/SOUL, memory guidance, session search guidance, skill guidance, tool-use enforcement, skills index, context files, environment/platform hints, provider/model metadata. It is much better controlled than Bobbit, but heavier than Claude Code.

---

## Code Discovery Comparison

| Capability | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Find files by name | `find` tool, basic glob behaviour | `Glob` with relative paths and mtime sorting; 100-result cap, `truncated` flag | `search_files(target='files')`, rg-backed, mtime sort via `--sort modified` |
| Search text | `grep`, rg-backed, simpler; documented dash-prefix limitation | Rich `Grep`: modes (`content`/`files_with_matches`/`count`), type/glob filters, `head_limit=250` default, `offset`, context lines, `appliedLimit` reported only on truncation | Rich `search_files`: same modes, context lines, pagination with next-offset hints, rg→grep fallback |
| Read files | 2000-line / 50 KB cap, offset/limit | Line-numbered, deduped unchanged reads, binary/device guards, image/PDF/notebook support; **256 KB / 25 K-token** dual budget | Line-numbered, deduped reads, **loop-blocker (warn @3, block @4)**, device/binary guards, large-read rejection, secret redaction |
| Symbol navigation | Not native (relies on optional MCP) | **LSP tool**: definitions, references, document/workspace symbols, implementations, call hierarchy, hover | Not native (relies on `search_files` + `read_file`) |
| Repeated-read guard | None | File-state cache stub for unchanged reads | Tracker per-task; warn at 3, hard-block at 4 identical calls |
| Repeated-search guard | None | None | Same tracker as read; reset by intervening tool calls |
| Large output handling | Tool-specific tail truncation | Microcompact + autocompact + tool-result cleanup | Per-result + per-turn persistence to sandbox file with previews |

---

## Edit / Write Comparison

| Capability | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Targeted edit | Exact replacement, first occurrence | Exact replacement, uniqueness/stale checks, `replace_all` | **Fuzzy replacement (9 strategies)** + `replace_all`; `replace` mode |
| Multi-file edit | Repeated edit/write or shell | Multiple tool calls; no atomic batch | **V4A patch**: `*** Update/Add/Delete File:` headers, sorted-lock acquisition, multi-file atomic |
| Stale-file protection | Not visible at Bobbit layer | `FILE_UNEXPECTEDLY_MODIFIED_ERROR` via mtime check | Per-task mtime tracker + cross-agent registry with 4 staleness cases |
| Concurrent-edit protection | Worktree isolation between roles; per-file guard not visible | File-state cache + stale checks | **Per-path `threading.Lock`**; sibling subagent stale detection appended to delegate result |
| Post-edit validation | Prompt/tool driven | LSP / editor / shell-driven | **Auto syntax check** (`.py`/`.js`/`.ts`/`.go`/`.rs`) + post-write byte-compare |
| Write file caps | None visible | Edit file ≤1 GiB safety cap | Same dedup/state coordination as read |
| Line-ending preservation | Not visible | Implicit via exact-match | Implicit via exact-match; byte-compare catches divergence |

---

## Context Model Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| System prompt size tendency | High. Many sections injected eagerly. | Low–moderate. Compact base, many tools deferred. | Moderate. Broad guidance/skills/memory, but cached and configurable. |
| Tool docs | YAML re-rendered every turn; eagerly serialised | **Deferred ToolSearch** for large/optional tools | OpenAI-format schemas filtered by toolset; **no schema deferral** |
| Memory injection | 20 files / ~16 KB; type-filtered; no relevance ranking | `MEMORY.md` ≤ 200 lines / 25 KB; semantic relevance via `findRelevantMemories`; freshness via `memoryAge` | One always-on builtin + at most one external provider; structured `prefetch` per turn |
| Compaction | Manual `compact()` RPC only; no auto-trigger at gateway layer | `microcompact` (continuous) + `autocompact` (13 K buffer, 20 K warn/error, 3-failure circuit breaker) | 75 % threshold; protect first 3 + last 20; 600 s failure cooldown |
| Per-turn budget | None visible | None at the harness level (compaction is reactive) | **`MAX_TURN_BUDGET_CHARS = 200 000`** with largest-first persistence |
| Cache strategy | None visible | Byte-exact prompt sharing on fork; cache-friendly assembly | `cache_control: ephemeral` on system + last 3 messages, 5 min TTL (1 h configurable) |
| Small-task overhead | High. Roles/gates/team/process appear even when unused. | Low. Defaults are coding-loop oriented. | Medium. Toolsets can be narrowed; default platform is broad. |

---

## Compaction & Failure Recovery Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Auto-trigger | None at gateway | At `AUTOCOMPACT_BUFFER_TOKENS=13K` from limit | At 75 % of context length |
| Manual trigger | `compact()` RPC | `/compact` slash command | `/compress` command |
| What gets pruned | Delegated to underlying agent | `FILE_READ`, `SHELL`, `GREP`, `GLOB`, `WEB_SEARCH`, `WEB_FETCH`, `FILE_EDIT`, `FILE_WRITE` results | Old tool results + token-level dedup |
| Protected regions | Not visible | Not explicit; cache-pinned edits replayed | First 3 + last 20 messages |
| Summary structure | Delegated | Compaction message inserted | "[CONTEXT COMPACTION — REFERENCE ONLY]" + Active Task + tail anchor |
| Failure handling | None visible | **Circuit breaker**: 3 consecutive failures disables auto-compact | **600 s cooldown** after failed summarisation |
| Read-state reset post-compaction | Not applicable | File-state cache replayed pinned edits | Implicit via fresh read after compaction |

---

## Subagent / Delegation Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Spawn model | Sessions via gateway; sequential or parallel via `Promise.all` | Native `Agent` tool with optional fork; async with 120-s auto-background | `ThreadPoolExecutor` for parallel children |
| Context inheritance | Fresh; `context: {key: value}` map only | **Fork** passes full parent conversation + system prompt byte-exactly for cache reuse | Fresh conversation; restricted toolset |
| Toolset isolation | Per-role YAML | `subagent_type` selects pool | `DELEGATE_BLOCKED_TOOLS` excludes `delegate_task`, `clarify`, `memory`, `send_message`, `execute_code` |
| Worktree isolation | Yes for team roles | Yes via `EnterWorktreeTool` | No native worktree support |
| Sibling-edit safety | Worktree-level; per-file not visible | File-state cache shared | **Sibling stale-file warning** in delegate result |
| Result format | Truncated prose (3 K parallel / 5 K single) | Free-form prose via parent | Prose; can be structured per delegate config |
| Concurrency cap | Configurable | Implicit | `ThreadPoolExecutor` default workers; configurable |

---

## Shell / Process Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Default timeout | 300 s | configurable; env override | configurable |
| Output cap | 50 KB / 2000 lines, **tail** | tail-based | persisted to file when over per-tool/per-turn budget |
| Truncation strategy | Tail | Tail | Persistence with preview |
| Background mode | `bash_bg` (`create`/`logs`/`kill`/`list`) via gateway | `run_in_background` | Process registry + interrupt support |
| Sandbox/backends | Local only | Local only (worktree for fs isolation) | local / docker / ssh / modal / daytona / singularity / vercel_sandbox |
| Approval gates | git-commit gating; otherwise minimal | Per permission classifier (especially in plan mode) | `prompt_dangerous_approval` + subagent auto-deny |
| Streaming | Not visible | `onUpdate` for background events | Possible via interrupt/event handling |

---

## Safety / Security Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Sensitive-path write deny | Implicit (relies on shell behaviour) | Implicit | Explicit list (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/sudoers`, …) |
| Prompt-injection scan of context files | None | Some patterns in user-message handling | **13 patterns** in `prompt_builder.py` (ignore-instructions, hidden Unicode `U+200B–U+202E`, exfil curls, secret-file reads, hidden HTML divs) |
| Secret redaction in tool output | Not visible | Limited | `agent/redact.py` applied post-read and on search results |
| Env-controlled write root | None | None | `HERMES_WRITE_SAFE_ROOT` |
| Subagent auto-deny default | Manual | N/A (fork inherits) | Default; opt-in to `subagent_auto_approve` |

---

## Provider / Adapter Comparison

| Dimension | Bobbit | Claude Code | Hermes Agent |
|---|---|---|---|
| Anthropic | Yes (via underlying agent) | Native | Native + `anthropic_adapter.py` |
| OpenAI / Codex / Copilot | Limited | Limited | Adapters: `codex_responses_adapter.py`, `copilot_acp_client.py` |
| Bedrock | No | No | `bedrock_adapter.py` |
| Gemini | No | No | `gemini_native_adapter.py`, `gemini_cloudcode_adapter.py`, `google_code_assist.py` |
| Other | — | — | LMStudio, Moonshot, Nous (rate guard) |
| Provider rate-limit awareness | None visible | Some | `rate_limit_tracker.py`, `nous_rate_guard.py` |
| Credential management | Env-based | Env-based + OAuth for some providers | `credential_pool.py`, `credential_sources.py`, OAuth helpers |

Hermes is the clear winner here. Claude Code is calibrated for the Anthropic API and does not need broad coverage; Bobbit inherits whatever the wrapped agent supports.

---

## Where Each Wins

| Winner | Category | Why |
|---|---|---|
| Bobbit | Visible team/workflow governance | Goals, gates, task DAG, role sessions, worktrees, team-lead flow are first-class. |
| Bobbit | User-editable orchestration | YAML roles/tools/prompts make behaviour easy to reshape without source changes. |
| Claude Code | Pure coding-loop efficiency | Best combination of search, read, edit, LSP, context deferral, microcompaction, autocompaction with circuit breaker. |
| Claude Code | Code-flow discovery | LSP gives semantic navigation that the others lack. |
| Claude Code | Plan / read-only mode | First-class enter/exit with dynamic permission classifier. |
| Claude Code | Fork-subagent | Byte-exact prompt sharing for cache-friendly delegation. |
| Hermes Agent | General agent platform depth | Strong coding tools + messaging, cron, memory providers, skills, browser, cloud/local terminal backends. |
| Hermes Agent | File concurrency safety | Process-wide file-state registry, per-path locks, four-case staleness detection. |
| Hermes Agent | Multi-file atomic patches | V4A format with sorted-lock acquisition. |
| Hermes Agent | Sandbox/backend breadth | Seven runtime backends behind the same shell tool. |
| Hermes Agent | Prompt-injection defense | 13-pattern context-file scan + secret redaction. |
| Hermes Agent | Provider abstraction | Anthropic, OpenAI, Gemini, Bedrock, Copilot, etc. with rate-limit awareness. |
| Hermes Agent | Per-turn output budget | Largest-first persistence keeps turns under 200 KB. |

---

## Where Bobbit Specifically Bleeds Context

Ordered by approximate per-task cost:

1. **No LSP** — every symbol is triangulated via grep + read. Compounds across a session.
2. **Static tool catalog** — every session ships every tool's full doc. ToolSearch-style deferral is the cheapest single win available.
3. **No read deduplication** — re-reading the same file (common during multi-step refactors) re-injects the full content every time.
4. **Eager prompt assembly** — global prompt + project docs + memories + role + goal + task + workflow + tool docs concatenate even when most are irrelevant to the current turn.
5. **Manual-only compaction** — long sessions blow the context window unless the user types `compact`.
6. **No per-turn budget** — many medium tool outputs can sum to over a hundred KB without anyone noticing.
7. **No diff/multi-edit** — N call-sites = N edit calls, each re-shipping its `oldText` envelope.
8. **No memory ranking** — all qualifying memory files included regardless of relevance.
9. **No prompt-cache awareness** — `AGENTS.md` + `CLAUDE.md` + memories re-read on every session start; not structured to be cache-friendly.
10. **Tail-only bash truncation** — early build errors lost when noise follows.
11. **No repeated-call loop guards** — a confused agent can grep the same pattern indefinitely.
12. **No prompt-injection scan** — `AGENTS.md` and similar files trusted blindly.

---

## Where Bobbit Holds Up Well

- **Workflow governance**: goals/gates/tasks/roles/teams are best-in-class for managed multi-agent projects.
- **`bash_bg` extension**: FD-safe background that avoids the pipe-hang pattern; cleaner than improvising `&` in CC's BashTool.
- **Task DAG**: `tasks.json` with explicit dependencies, sub-tasks, outcomes DB feeding the Observer self-improver is more structured than CC's flat `TodoWrite`.
- **Parallel `delegate`**: first-class array of parallel sub-tasks with separate cost accounting per delegate.
- **YAML-editable roles/tools/prompts**: lower friction than editing TypeScript/Python source.
- **Provider-agnostic by virtue of pi-coding-agent**: not a Bobbit feature per se, but an inherited one.

---

## Main Conclusions

1. Bobbit is **not "less efficient Claude Code."** It is optimised around a different centre of gravity: visible orchestration and project governance. That is genuinely valuable for managed multi-agent workflows, but it imposes too much context and ceremony on normal code development.
2. Hermes lands **between Bobbit and Claude Code**. It has many of the file/search/edit/context protections Bobbit lacks, plus concurrency-safety and sandbox features beyond Claude Code. But because it is a broad platform, it still carries more tool and prompt surface than Claude Code.
3. The clearest path for Bobbit is **not to copy every Claude/Hermes feature**. It should add:
   - A **lean coding mode** that suppresses gates/team/memory machinery when the user is doing direct coding.
   - The highest-leverage mechanics from Claude Code (lazy tool docs, read dedup, autocompact, plan mode, LSP).
   - The highest-leverage mechanics from Hermes (per-turn budget with persistence, file-state registry with per-path locks, repeated-call loop guards, prompt-injection scan, post-patch syntax check).
4. Hermes's biggest deficit relative to Claude Code is **LSP**. Bobbit's biggest deficit is everything in **Group A (context economics)** plus **B3 (code-flow discovery)** plus **F2 (prompt-injection defense)**. Bobbit's strongest assets are **E3 (workflow governance)** and **F3 (configurability)** — both worth preserving.
5. The aggregate score gap between Bobbit (4.7) and the others (~7.6) is large but **structurally addressable**: the dominant losers are six axes (A1, A2, A5, A6, B3, B5, F2) where retro-fit work is well-understood. See [bobbit-improvements.md](bobbit-improvements.md) for a delivery plan.
