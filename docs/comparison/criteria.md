# Coding Harness Comparison Criteria

This document defines the criteria used to compare **Bobbit**, **Claude Code**, and **Hermes Agent** as code-development harnesses. The comparison is grounded in source-code inspection of:

- Bobbit: `/Users/aj/Documents/dev/bobbit`
- Claude Code: `/Users/aj/Documents/dev/claude-code`
- Hermes Agent: `/Users/aj/Documents/dev/hermes-agent`

Scores in `comparison.md` use a 1–10 scale where 10 means the harness is strong, efficient, and well-protected for that dimension.

## Scope

The comparison is about coding-agent **harness behavior**, not general assistant quality or model intelligence. It focuses on:

- How the harness helps an agent **discover, understand, edit, and verify code**.
- How much **context it spends** to do that work.
- How safely it handles **file and shell side effects**.
- How well it supports **delegation and parallel work** without losing correctness.
- How much **product/workflow machinery** helps or hurts normal coding tasks.
- How resilient it is under **long sessions, failures, and adversarial inputs**.

The comparison is **not** a benchmark of model intelligence, latency, or exact token counts. It does not require running any of the harnesses; everything is sourced from the code as it sits in the working tree.

## Methodology Notes

- **Scoring is relative**: a 9 in one harness means that harness is best-in-class on that axis among the three; it does not mean the dimension is theoretically maxed out.
- **Source-only**: features gated by environment variables, runtime configuration, or feature flags are noted but only fully credited when the code path is reachable from a normal session.
- **Pragmatic granularity**: rather than a single "context efficiency" score, the criteria below split that concept into ~6 distinct dimensions (baseline assembly, tool docs, read dedup, output truncation, compaction, per-turn budget) so improvement levers are easier to identify.

## Criteria

### Group A — Context Economics

These criteria measure how much prompt/context the harness spends per unit of useful work.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| A1 | **Baseline context efficiency** | How much prompt/context the harness spends before any tool is called. | Small stable system prompt, lazy docs, compact project context, prompt caching, minimal always-on workflow text. |
| A2 | **Tool loading efficiency** | Whether tool schemas/docs are loaded only when useful. | Deferred tools, schema search, short initial tool list, cached tool definitions, toolset filtering. |
| A3 | **Prompt-cache strategy** | Whether the harness deliberately structures prompts so providers (Anthropic, OpenAI) hit cache aggressively. | Stable prefix, explicit `cache_control` markers, TTL configuration, system + recent-N pattern. |
| A4 | **Per-turn output budget** | Whether the harness caps the aggregate size of tool results in a single turn. | Aggregate budget across all tool calls in a turn, spillover to disk, predictable upper bound. |
| A5 | **Read deduplication** | Whether re-reading an unchanged file costs context. | mtime-keyed dedup, stub responses for repeat reads, reset after compaction, repeated-call loop blockers. |
| A6 | **Context compaction** | Recovering from long sessions without losing active work. | Automatic thresholds, tool-result pruning, structured summaries, failure handling, read-dedup reset after compaction, retry/cooldown logic. |

### Group B — Code Discovery and Comprehension

These criteria measure how efficiently the agent can find, understand, and trace code it has not seen.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| B1 | **File discovery** | Finding files by name, path, recency, project layout. | Glob/file search with `.gitignore`, mtime sorting, pagination, concise relative paths. |
| B2 | **Code content search** | Searching code text and narrowing results. | Ripgrep-backed search, output modes (content/files-only/count), file-type filters, offsets, limits, context lines, robust pattern handling. |
| B3 | **Code-flow discovery** | Understanding symbols, references, call graphs, definitions. | LSP or equivalent (definitions, references, document/workspace symbols, implementations, call hierarchy). |
| B4 | **Read behavior** | How efficiently and safely files enter context. | Pagination, line numbers, binary/device guards, dedup, large-read rejection, useful hints, image/PDF/notebook handling. |
| B5 | **Search/read loop guards** | Detecting and stopping the agent from grinding on identical lookups. | Counters per identical (path/pattern, params); warn → block escalation. |

### Group C — Code Modification

These criteria measure correctness, safety, and ergonomics of the edit path.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| C1 | **Edit behavior** | How reliably targeted edits apply. | Read-before-edit, stale checks, exact + fuzzy matching with uniqueness checks, replace-all, useful diffs. |
| C2 | **Multi-file / atomic patches** | Coordinated edits across multiple files. | Unified-diff or V4A-style patch, sorted-lock acquisition, partial-failure handling, rollback. |
| C3 | **Write/create behavior** | Safety and ergonomics for full-file writes and new files. | Existing-file safeguards, parent directory creation, atomicity, post-write read-back, line-ending preservation. |
| C4 | **Concurrency safety** | Avoiding conflicting parallel edits and unsafe tool batching. | Process-wide file-state registry, per-path locks, sibling-agent stale detection, safe parallel-read batching, write serialization. |
| C5 | **Post-edit verification** | How automatically the harness validates a change. | Read-back compare, syntax checks per language, lint hooks, compile/test triggers. |

### Group D — Execution and Verification

These criteria measure how well the harness drives shells, tests, builds, and long-running processes.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| D1 | **Shell/process handling** | Running tests, builds, servers, ad-hoc commands. | Timeouts, output caps, head+tail (not just tail), structured stderr/stdout, exit-code reporting, robust quoting. |
| D2 | **Background process supervision** | Running long-lived commands without breaking the session. | FD-safe background, log retrieval, kill/list operations, persistent process registry, interrupt support. |
| D3 | **Verification support** | How naturally the harness drives test/lint/build validation. | Auto-syntax check on patch, lint commands per language, structured test output, command guidance. |
| D4 | **Sandbox/isolation backends** | Ability to run in restricted, ephemeral, or remote environments. | Local + Docker + SSH + cloud sandbox backends with consistent UX, approval gates, deny lists. |
| D5 | **Approval/danger gates** | Catching destructive or sensitive commands before they run. | Pattern-based detection, allow/deny lists, interactive approval, subagent auto-deny, sensitive-path guards. |

### Group E — Coordination and Long-Horizon Work

These criteria measure how well the harness handles multi-step plans and multi-agent execution.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| E1 | **Delegation/subagents** | Splitting work across agents without wasting context or corrupting files. | Isolated or forked agents, bounded toolsets, structured summaries, progress tracking, concurrency caps, shared file-state safety. |
| E2 | **Plan / read-only mode** | A first-class exploration mode that cannot mutate state. | Tool blocklist, dynamic permission classifier, explicit enter/exit, distinct UI affordance. |
| E3 | **Workflow governance** | Support for goals, tasks, gates, reviews, role flows. | First-class gates/tasks/workflows, role-specific prompts, review handoffs, UI visibility, gate-state summarization. |
| E4 | **Memory/skills discipline** | Whether long-term knowledge helps without bloating current work. | Compact memory, relevance gating, on-demand skill loading, separation of facts vs procedures, single-active-provider enforcement. |
| E5 | **Failure recovery** | Resilience against compaction errors, tool errors, API errors. | Retry with backoff, compaction-failure cooldown, circuit breaker, graceful fallback, persisted partial state. |

### Group F — Trust, Safety, Extensibility

These criteria measure how the harness defends against adversarial inputs and how easily it can evolve.

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| F1 | **Safety/security posture** | Protection against destructive commands, sensitive paths, secret leakage. | Approval gates, deny lists, secret redaction, sensitive-path guards, env-controlled write roots. |
| F2 | **Prompt-injection defense** | Scanning context-files (AGENTS.md, CLAUDE.md, READMEs, SOULs) before injection. | Pattern detection for "ignore previous instructions", hidden Unicode, exfil curls, secret-file reads, hidden HTML. |
| F3 | **Configurability/extensibility** | How easily users can alter tools, roles, prompts, plugins, integrations. | YAML/plugin registries, MCP support, hook systems, toolsets, documented extension points, hot reload. |
| F4 | **Provider abstraction** | Cross-vendor support without leaking provider quirks into tools. | Adapter layers per provider (Anthropic, OpenAI, Gemini, Bedrock, Copilot, etc.), capability-aware behavior. |
| F5 | **Observability** | Whether developers can see *why* the harness spent context the way it did. | Section-by-section prompt diagnostics, cost/token tracking, persisted prompt artifacts, cache hit metrics. |

### Group G — Product Fit

| # | Criterion | What It Measures | Strong Evidence Looks Like |
|---|---|---|---|
| G1 | **Product fit for everyday coding** | Whether harness defaults align with fast everyday code work. | Minimal ceremony for small tasks, deep tooling for large tasks, clear modes for each. |
| G2 | **First-time-user friction** | How quickly a developer can productively use the tool. | Sensible defaults, low-config startup, helpful error messages, no required workflow setup. |

## Score Interpretation

| Score | Meaning |
|---:|---|
| 9–10 | Excellent. Purpose-built, robust, and efficient. Best-in-class among the three. |
| 7–8 | Strong. Good behavior with some gaps or mode-dependent weaknesses. |
| 5–6 | Adequate. Works, but has meaningful efficiency or safety tradeoffs. |
| 3–4 | Weak. Available but missing important mechanics for serious coding efficiency. |
| 1–2 | Poor or effectively absent. |

## Anti-Patterns That Lower a Score

To make scoring repeatable, the following observable anti-patterns subtract points regardless of feature presence:

- **Silent truncation**: tool result is clipped without a `truncated:true` flag or remaining-count hint.
- **Eager tool documentation**: every tool's full schema and description is shipped in every system prompt.
- **No read-before-edit enforcement**: edit tool will overwrite based on stale model memory of file contents.
- **Manual-only compaction**: long sessions blow the context window unless the user types a command.
- **Sequential-when-could-be-parallel**: independent searches or sub-agent spawns serialised needlessly.
- **No injection scanning of context files**: AGENTS.md / CLAUDE.md / READMEs trusted blindly.
- **Tail-only shell truncation**: when a long build prints errors first then noise, the early error is lost.
- **Memory dump**: all memory files concatenated regardless of relevance to the current turn.

## Bonus Patterns That Raise a Score

These patterns indicate genuinely thoughtful harness engineering and are credited above the baseline:

- **Differentiated cache control**: stable prefix marked `cache_control` so repeated sessions on the same project hit cache.
- **Schema deferral**: heavy tools (LSP, MCP, plan-mode) hidden behind a `tool_search` discovery tool until needed.
- **Per-turn budget**: not just per-tool; aggregate tool output is capped and biggest-first persisted to disk.
- **Sibling-agent stale detection**: parallel sub-agents cannot silently overwrite each other's edits.
- **Context-file injection scanning**: harness refuses or warns on prompt-injection patterns in repo docs.
- **Compaction failure cooldown**: a failed summarization does not retry-loop the model into oblivion.
- **Auto-syntax check on patch**: language-aware compile/check after every successful edit.
- **Single-active external memory provider**: prevents tool-schema bloat when multiple memory plugins are installed.

## Important Caveats

- **Bobbit** wraps `@mariozechner/pi-coding-agent`; much of its low-level coding behavior lives outside the Bobbit source tree. The Bobbit-specific scores emphasize its prompt-assembly, role, tool-activation, session, workflow, and orchestration layer — not pi-coding-agent's internal mechanics.
- **Claude Code** was evaluated from the available local source tree. Some features are gated by environment, configuration, or feature flags (LSP availability, fork-subagent gating, GrowthBook flags). Where a feature is conditional, it is noted.
- **Hermes Agent** is a broad general-purpose agent platform. Its scores here emphasize its **coding toolchain**, not its messaging, cron, voice, RL, datagen, or research-platform features.
- Product breadth can be good for some tasks and bad for context efficiency. The scoring deliberately distinguishes coding-loop efficiency (Group A–C) from workflow governance (E3) and platform breadth (F3, D4).
- Scores are **best-effort and source-grounded**, not benchmark-validated. They are calibrated to drive concrete improvement work, not to settle debates.
