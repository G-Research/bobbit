# Bobbit Improvement Goals

This document converts the findings in [comparison.md](comparison.md) into actionable goals for Bobbit. **Each goal below is a self-contained section that can be copy-pasted into Bobbit as a project goal.** Sections include problem statement, scope, implementation approach, files to touch, interface sketches, acceptance criteria, and a test plan.

Reference implementations in Claude Code and Hermes Agent are cited where directly portable.

---

## North Star

Bobbit should have two clearly different operating modes:

1. **Lean Coding Mode** for normal development tasks: minimal prompt, minimal workflow ceremony, fast file/search/edit tools, strong context controls.
2. **Managed Goal Mode** for team/gate/project workflows: current Bobbit strengths — roles, gates, worktrees, reviews, visible orchestration.

Most goals below either build the lean mode, or import context-discipline mechanics from Claude Code / Hermes that benefit both modes.

## Effort & Impact Legend

| Effort | Meaning | Impact | Meaning |
|---|---|---|---|
| XS | < 1 day | ⭐ | Modest |
| S | 1–3 days | ⭐⭐ | Significant |
| M | 1–2 weeks | ⭐⭐⭐ | Substantial |
| L | 2–4 weeks | ⭐⭐⭐⭐ | Step-change |
| XL | 1–2 months | | |

## Section Verification

Verified on 2026-05-01: every `## Goal` section in this document is intended to be copy-pasteable into Bobbit as an implementation goal. Each goal includes:

- `Impact rationale` — why the star rating was chosen, expected user impact, and expected LLM context/cost impact.
- `Problem` — what is wrong or inefficient today.
- `Approach` — the proposed implementation shape.
- `Files to touch` — likely source/config areas to inspect or modify.
- `Acceptance criteria` — concrete definition of done.
- `Test plan` — how to verify the goal after implementation.

Small `XS` goals are intentionally shorter than large architecture goals, but they still include enough implementation detail to hand to an agent or developer without needing the comparison document open.

---

# Priority 0: Measure Before Optimising

Without observability, every other change is guesswork. These goals establish the dashboards needed to validate later milestones.

## Goal 0.1 — Section-by-section prompt budget

**Criterion:** F5 Observability · A1 Baseline context efficiency
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because it unlocks every later optimization by showing exactly where prompt tokens go. **User impact:** users can see why a session feels expensive and choose leaner modes. **Context/cost impact:** indirect but high; it identifies the biggest prompt sections to cut and prevents blind optimization.
**Reference:** Hermes character-proxy approach (≈ 4 chars / token)

**Problem.** Bobbit assembles the system prompt from many sources (global prompt, AGENTS.md, CLAUDE.md, Claude Code memories, role prompt, goal/task spec, workflow context, tool docs). There is currently no visibility into which section contributes how much. Optimisation work cannot prioritise without this.

**Approach.** Instrument `src/server/agent/system-prompt.ts` so that every assembled section returns `{name, content, chars, tokens_estimate}`. Aggregate into a single `PromptBudget` object passed through with the prompt. Use a simple `Math.ceil(chars / 4)` token estimator (good enough for budgeting; refine later if needed).

**Files to touch.**
- `src/server/agent/system-prompt.ts` — return budget alongside content
- `src/server/agent/rpc-bridge.ts` — accept and store the budget
- `src/server/api/routes.ts` (or equivalent) — expose `/api/sessions/:id/prompt-budget`
- `src/ui/components/SessionDetail.tsx` (or equivalent) — render

**Interface sketch.**
```ts
type PromptSection = {
  name: 'global' | 'agents-md' | 'claude-md' | 'memories' | 'role' | 'goal' | 'task' | 'workflow' | 'tools' | 'personality';
  content: string;
  chars: number;
  tokensEstimate: number;
  enabled: boolean;
};
type PromptBudget = {
  sections: PromptSection[];
  totalChars: number;
  totalTokensEstimate: number;
};
```

**Acceptance criteria.**
- Every assembled prompt has a `PromptBudget` artifact persisted with the session.
- A debug endpoint or CLI command returns the budget for any past session.
- The UI shows section sizes for the current session.

**Test plan.**
- Snapshot an existing managed-mode session and assert section sums match measured prompt size ±2 %.
- Verify disabled sections (e.g., personality when none selected) report `enabled: false, chars: 0`.

---

## Goal 0.2 — Persisted prompt diagnostics

**Criterion:** F5 Observability
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because it makes prompt-budget data durable and comparable across sessions. **User impact:** developers can inspect regressions after the fact. **Context/cost impact:** indirect; it enables before/after measurement but does not reduce tokens by itself.

**Problem.** Assembled prompts are already written to `.bobbit/state/session-prompts/`. There is no parallel record of how those prompts were composed.

**Approach.** Alongside each saved prompt file, write `<session-id>.budget.json` containing the `PromptBudget` from Goal 0.1, plus the active toolset, mode, and role. Backfill from the latest run only; older sessions remain untouched.

**Files to touch.**
- `src/server/agent/system-prompt.ts` (or wherever prompt persistence lives)
- `.bobbit/state/session-prompts/` storage layout

**Acceptance criteria.**
- Every new session writes both `<id>.prompt.txt` and `<id>.budget.json`.
- Developers can diff budget JSON across sessions to spot bloat regressions.

**Test plan.**
- Run a smoke session in lean mode and a session in managed mode. Diff the two budget files. Confirm tool-doc and workflow-context sections differ as expected.

---

## Goal 0.3 — UI warnings for bloated sessions

**Criterion:** F5 Observability
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because it gives users immediate feedback when a session starts bloated. **User impact:** users can switch modes or trim context before spending money. **Context/cost impact:** moderate indirect savings by preventing accidentally expensive sessions.

**Problem.** Users have no visibility into when a session starts expensive.

**Approach.** Read the `PromptBudget` from Goal 0.1 at session-start time. If `totalChars` exceeds a configurable threshold (default 32 KB warn, 64 KB error), emit a UI banner. Show the top 3 contributing sections by char count.

**Files to touch.**
- UI session detail view
- `src/ui/utils/prompt-budget.ts` (new) — formatting helpers
- `.bobbit/config/system-prompt.md` settings: `prompt_budget_warn_chars`, `prompt_budget_error_chars`

**Acceptance criteria.**
- Banner appears at session start when over warn threshold.
- Banner lists "tool docs: 18k chars", "workflow context: 12k chars", etc.
- Threshold configurable via session config or env var.

**Test plan.**
- Force a managed-mode session over the warn threshold; confirm banner.
- Lean session under threshold; confirm no banner.

---

## Goal 0.4 — Cache-hit metric

**Criterion:** A3 Prompt-cache strategy · F5 Observability
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because cache visibility is required to validate cache-related work. **User impact:** users can understand why repeat sessions are cheaper or not. **Context/cost impact:** indirect but important; it exposes missed cache savings and provider differences.
**Reference:** CostTracker already records `cacheReadTokens`, `cacheWriteTokens`

**Problem.** Bobbit's CostTracker captures cache-read and cache-write token counts but does not expose the resulting hit rate prominently. Without visibility, work in Goal 10.* (cache strategy) cannot be evaluated.

**Approach.** Add `cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)` per session. Surface as a column in the session list and as a per-session dashboard tile. Aggregate per-project and per-mode.

**Files to touch.**
- `src/server/cost/cost-tracker.ts` (or equivalent)
- UI session list and detail

**Acceptance criteria.**
- Session UI shows `cacheHitRate` as a percentage.
- Dashboard shows project-level and mode-level averages over the last 30 days.

**Test plan.**
- Two sessions on the same project: one fresh, one immediate repeat. Hit rate should jump on the second.

---

## Goal 0.5 — Per-turn output budget meter

**Criterion:** A4 Per-turn output budget · F5 Observability
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because turn-level output bloat is a common hidden cost. **User impact:** users get warnings when tools flood the conversation. **Context/cost impact:** indirect until paired with persistence, but it reveals expensive turns and guides truncation work.
**Reference:** Hermes `MAX_TURN_BUDGET_CHARS = 200_000` in `tools/tool_result_storage.py`

**Problem.** Many medium tool outputs in a single turn can sum to over 100 KB without anyone noticing. There is no per-turn metric.

**Approach.** Track aggregate tool-output bytes per turn at the session level. After each turn completes, log `{turnIndex, toolCount, totalBytes, perToolBytes[]}`. Warn when over `200 KB` (configurable).

**Files to touch.**
- `src/server/agent/rpc-bridge.ts` — observe tool-result events
- `src/server/state/session-stats.ts` (new)

**Acceptance criteria.**
- Per-turn tool-output bytes available in session stats.
- Warning surfaced in UI when threshold exceeded.

**Test plan.**
- Synthetic session that emits five 50 KB tool results in one turn — confirm warning fires once.

---

# Priority 1: Lean Coding Mode

Bobbit's biggest cost driver is using one heavy posture for all tasks. Lean Mode is the central goal of the entire roadmap.

## Goal 1.1 — `mode: coding` vs `mode: managed`

**Criterion:** G1 Product fit · A1 Baseline · E3 Workflow
**Effort:** M · **Impact:** ⭐⭐⭐⭐
**Impact rationale:** ⭐⭐⭐⭐ because separating lean and managed modes is the central architectural fix. **User impact:** everyday coding becomes faster and less noisy while managed workflows remain available. **Context/cost impact:** very high; lean sessions can avoid gates, team prompts, memory protocol, and broad tool docs.

**Problem.** Every Bobbit session, even "fix this typo," ships full managed-mode machinery: gates, team flow, memory protocol, design-doc reminders. This makes everyday coding expensive and noisy.

**Approach.** Add a `mode: 'lean' | 'managed'` flag at session creation. Wire it through prompt assembly (Goal 1.2), tool selection (Goal 2.3), and gate activation (Goal 1.3). Default detection in Goal 1.5.

**Files to touch.**
- `src/server/agent/types.ts` — add `mode` to session config
- `src/server/agent/system-prompt.ts` — branch on `mode`
- `src/server/agent/tool-manager.ts` — branch on `mode`
- `src/server/api/sessions.ts` — accept `mode` on create
- `src/ui/dialogs/CreateSession.tsx` — mode selector

**Interface sketch.**
```ts
type SessionMode = 'lean' | 'managed';
interface SessionConfig {
  mode: SessionMode;
  // existing fields...
}
```

**Acceptance criteria.**
- Session create API accepts `mode`.
- Lean sessions start without gate/team/memory instructions.
- Managed sessions behave identically to today.

**Test plan.**
- Snapshot test: lean-mode prompt is < 50 % of managed-mode prompt size on the same repo with identical task.
- Existing managed-mode test suite passes unchanged.

---

## Goal 1.2 — `coder-lean.yaml` role

**Criterion:** G1 · A1
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because the coder role is a major always-on prompt contributor. **User impact:** the agent behaves more like a focused coding assistant on small tasks. **Context/cost impact:** high direct savings from removing managed-mode instructions from lean sessions.

**Problem.** `coder.yaml` is ~1.5 KB and pushes gates, design docs, branches, commits, pushes, memory, previews, delegated work — all of which are managed-mode concerns.

**Approach.** Split `.bobbit/config/roles/coder.yaml` into:
- `coder-lean.yaml` — minimal: identity, code style, "use tools well," concise output. Target ≤ 4 KB rendered.
- `coder-managed.yaml` — current contents (renamed).

System prompt assembly picks the role based on `mode` (Goal 1.1).

**Files to touch.**
- `.bobbit/config/roles/coder.yaml` → `coder-managed.yaml`
- `.bobbit/config/roles/coder-lean.yaml` (new)
- `src/server/agent/system-prompt.ts` — role selection branches on mode

**Acceptance criteria.**
- Lean role ≤ 4 KB rendered.
- Lean role contains no gate/team/git-commit reminders.
- Existing managed sessions unchanged.

**Test plan.**
- Render both roles; assert size budget; assert keyword absence (`gate`, `team`, `branch`) in lean.

---

## Goal 1.3 — Make gates opt-in for small tasks

**Criterion:** E3 · A1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because gate tools are valuable only in workflow contexts. **User impact:** small tasks stop getting gate-first ceremony. **Context/cost impact:** moderate direct savings by removing gate schemas/instructions from lean prompts.

**Problem.** Gate tools (`gate_list`, `gate_status`, gate-related instructions) appear in every session, even when not in a goal/workflow context.

**Approach.** In `src/server/agent/tool-manager.ts`, gate-tool exposure becomes conditional on:
1. Active goal/workflow context, **or**
2. Explicit user request via session flag, **or**
3. Lean mode disabled.

When excluded, neither the schemas nor the prompt instructions reach the model.

**Files to touch.**
- `src/server/agent/tool-manager.ts`
- `.bobbit/config/tools/gates/*` — gate group metadata: `requires: ['workflow-context']`

**Acceptance criteria.**
- Lean session with no goal: zero gate tools, zero gate prompt text.
- Lean session inside a goal: gate tools available.
- Managed sessions unchanged.

**Test plan.**
- Three scenarios: lean-no-goal, lean-with-goal, managed. Snapshot tool list and prompt for each.

---

## Goal 1.4 — Disable mandatory memory workflow in lean mode

**Criterion:** E4 · A1
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because mandatory memory calls are wasteful for quick edits. **User impact:** fewer irrelevant memory lookups and less surprising behavior. **Context/cost impact:** moderate direct savings from not injecting memory instructions/files unless relevant.

**Problem.** The current prompt instructs the agent to search and save memory at session boundaries. This is wasted context and tool calls when the user is doing a quick edit.

**Approach.** In lean mode, drop the "always search memory at start, save at end" prompt section and avoid auto-loading Claude Code memories from `~/.claude/projects/.../memory/*.md`. Memory becomes available on-demand only.

**Files to touch.**
- `src/server/agent/system-prompt.ts` — memory section conditional on mode
- `.bobbit/config/system-prompt.md` (or wherever memory protocol lives)

**Acceptance criteria.**
- Lean prompt contains no memory search/save instructions.
- Managed prompt unchanged.
- Memory tools still available if user invokes them.

**Test plan.**
- Snapshot diff between lean and managed prompts; only memory section should differ.

---

## Goal 1.5 — Auto-detect lean candidacy

**Criterion:** G2 First-time-user friction
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because users should not have to remember to choose lean mode. **User impact:** sensible defaults make the product feel faster immediately. **Context/cost impact:** moderate direct savings by routing more sessions into lean mode automatically.

**Problem.** Even with Goal 1.1 done, users have to remember to choose lean mode. Most everyday tasks should default to it.

**Approach.** Heuristic: when creating a session, default to lean if:
- No goal is selected, **and**
- No team context is set, **and**
- No workflow is active.

Otherwise default to managed. User can override.

**Files to touch.**
- `src/server/api/sessions.ts` — apply default before creation
- `src/ui/dialogs/CreateSession.tsx` — show derived default; allow override

**Acceptance criteria.**
- Personal-repo session with no goal → lean by default.
- Team-context session or active goal → managed by default.
- Override always wins.

**Test plan.**
- Unit-test the default function across the four context combinations.

---

## Goal 1.6 — UI mode badge

**Criterion:** F5 · G2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it is mostly visibility, not core harness behavior. **User impact:** users know which mode they are in and can correct mistakes. **Context/cost impact:** low direct impact, but it prevents accidental managed-mode spend.

**Problem.** Once modes exist, users need to see at a glance which one they're in.

**Approach.** Show a `LEAN` / `MANAGED` badge in session header. Provide one-click toggle (with a "this session" vs "always for this project" choice).

**Files to touch.**
- UI session header component
- Session config persistence

**Acceptance criteria.**
- Badge always visible.
- Toggle works mid-session (next turn picks up new mode).
- Per-project default persists.

**Test plan.**
- Manual UX check; e2e test toggling and verifying tool list updates.

---

# Priority 2: Lazy Tool Documentation

## Goal 2.1 — Replace eager YAML docs with lazy docs

**Criterion:** A2 Tool loading efficiency
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because eager tool docs are one of Bobbit's biggest prompt costs. **User impact:** agents still have tools but sessions start cleaner and faster. **Context/cost impact:** high direct savings by replacing full docs with summaries and on-demand lookup.
**Reference:** Claude Code `src/tools/ToolSearchTool/`

**Problem.** `src/server/agent/tool-manager.ts` re-renders all tool documentation in every system prompt. For ~40 tools this can be 10–20 KB.

**Approach.** Change initial render to emit only `name + one-line summary` per tool. Add two RPC tools:
- `tool_help(name)` → returns full schema and description for a single tool.
- `tool_search(query)` → returns up to 5 tool names matching query (keyword + `select:tool1,tool2` syntax).

The agent calls these on demand.

**Files to touch.**
- `src/server/agent/tool-manager.ts`
- `src/server/agent/rpc-bridge.ts` — register `tool_help`, `tool_search`
- `.bobbit/config/tools/<tool>/extension.yaml` — ensure each has `summary: <one line>`

**Interface sketch.**
```yaml
# Initial system-prompt render
tools:
  - name: read
    summary: Read a file with optional offset/limit
  - name: edit
    summary: Replace exact text in a file
  - name: tool_search
    summary: Search for tools by query or load by name
  - name: tool_help
    summary: Get full schema + description for a tool by name
```

**Acceptance criteria.**
- Initial tool-doc section size ≤ 25 % of current.
- `tool_search` and `tool_help` return correct data.
- Agent successfully completes coding tasks using lazy fetch.

**Test plan.**
- Compare prompt size on 10 sample sessions before/after.
- Agent regression suite: no task fails because the model could not find a tool.

---

## Goal 2.2 — Cache parsed tool YAML

**Criterion:** A2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it improves server efficiency more than model efficiency. **User impact:** faster session/tool list preparation. **Context/cost impact:** low direct token impact; mainly reduces CPU/latency from repeated YAML parsing.

**Problem.** `getAvailableTools()` re-scans `.bobbit/config/tools/` and re-parses YAML on every call.

**Approach.** Cache by file mtime. Invalidate per file when mtime changes. Use a simple `Map<path, {mtime, parsed}>`.

**Files to touch.**
- `src/server/agent/tool-manager.ts`

**Acceptance criteria.**
- Repeat `getAvailableTools()` calls do not re-scan unchanged YAML.
- Editing a YAML file is picked up on next call without restart.

**Test plan.**
- Time `getAvailableTools()` 100 times in a tight loop; assert sub-millisecond after first call.
- Edit a YAML; confirm next call reflects change.

---

## Goal 2.3 — Group tools by mode

**Criterion:** A2 · G1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because mode-scoped tool groups reduce irrelevant tool surface. **User impact:** agents see fewer distracting tools. **Context/cost impact:** moderate direct savings by hiding browser/team/workflow/memory schemas from lean sessions.

**Problem.** Browser, team, workflow, and memory tools currently appear in every coding session.

**Approach.** Define toolset groups in YAML metadata: `code-core`, `code-extra` (lsp, mcp), `code-browser`, `team`, `workflow`, `memory`, `delegate`. Lean mode includes `code-core` only by default; opt in to others. Managed mode includes all.

**Files to touch.**
- `.bobbit/config/tools/<tool>/extension.yaml` — add `group:` field
- `src/server/agent/tool-manager.ts` — filter by mode + active groups

**Acceptance criteria.**
- Lean mode shows only `code-core` group by default.
- Per-session opt-in adds groups.
- Managed mode unchanged.

**Test plan.**
- Snapshot tool list for: lean (default), lean+browser, managed.

---

## Goal 2.4 — Mark heavy tools `defer`

**Criterion:** A2
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because heavy schemas should not be always loaded. **User impact:** specialized tools remain discoverable without cluttering normal tasks. **Context/cost impact:** moderate direct savings, especially once LSP/MCP/browser schemas grow.
**Reference:** Claude Code `shouldDefer: true` on `LSPTool`, `EnterPlanModeTool`, `EnterWorktreeTool`, `ConfigTool`, `ListMcpResourcesTool`, `NotebookEditTool`

**Problem.** Some tools have large schemas that bloat the base prompt even when not used (LSP, MCP, plan-mode, browser, notebook).

**Approach.** Add `defer: true` to YAML. Deferred tools appear in initial tool list as name + summary only; full schema fetches via `tool_search` (Goal 2.1).

**Files to touch.**
- `.bobbit/config/tools/<tool>/extension.yaml` — `defer:` field
- `src/server/agent/tool-manager.ts` — handle `defer`

**Acceptance criteria.**
- Marked tools render as `<deferred>` stub.
- `tool_search` returns full schema on demand.

**Test plan.**
- Mark LSP and browser tools deferred; assert prompt size drop.

---

## Goal 2.5 — Cap tool-doc section size

**Criterion:** A1 · A2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it is a guardrail rather than a full strategy. **User impact:** prevents pathological tool-doc bloat. **Context/cost impact:** low-to-moderate direct savings only when tool docs exceed the cap.

**Problem.** Even after group filtering, a busy project's toolset can still bloat.

**Approach.** Hard cap at e.g. 8 KB. If the tool-doc section exceeds the cap, emit only names + summaries plus a sentence directing the agent to `tool_search` for details.

**Files to touch.**
- `src/server/agent/tool-manager.ts`

**Acceptance criteria.**
- Tool-doc section never exceeds configured cap (default 8 KB lean, 16 KB managed).
- Cap configurable via session config.

**Test plan.**
- Force large toolset; assert cap enforced and `tool_search` hint emitted.

---

# Priority 3: Upgrade File Read & Search

## Goal 3.1 — Read deduplication

**Criterion:** A5 Read deduplication
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because repeated unchanged reads are pure context waste. **User impact:** agents stop re-reading the same content and can move faster. **Context/cost impact:** high direct savings on refactors and debugging sessions with repeated file reads.
**Reference:** Hermes `tools/file_tools.py:485–596`; Claude Code `FileReadTool` file-state cache

**Problem.** Re-reading the same file (common during multi-step refactors) re-injects the full content every time, costing context for zero new information.

**Approach.** Track `Map<sessionId, Map<absPath, {offset, limit, mtime, lastReadAt, sha?}>>`. On `read`:
1. Resolve absolute path.
2. Compute current mtime.
3. If `(path, offset, limit, mtime)` matches cache → return short stub: `Already read this file with these params and it is unchanged. Use offset to read more.`
4. Otherwise read fresh and update cache.

Reset cache on compaction events (Goal 6.6).

**Files to touch.**
- `src/server/agent/file-state.ts` (new)
- Wherever `read` extension lives

**Interface sketch.**
```ts
interface ReadCacheEntry {
  offset: number;
  limit: number;
  mtime: number;
  lastReadAt: number;
}
class FileStateRegistry {
  private cache = new Map<string /*sessionId*/, Map<string /*path*/, ReadCacheEntry>>();
  recordRead(sessionId: string, path: string, offset: number, limit: number, mtime: number): void;
  isUnchangedReread(sessionId: string, path: string, offset: number, limit: number): boolean;
  resetSession(sessionId: string): void;
}
```

**Acceptance criteria.**
- Identical re-read of unchanged file returns short stub (< 200 chars), not content.
- mtime change forces re-read.
- Different offset/limit forces re-read.

**Test plan.**
- Read same file twice; second call returns stub.
- Touch the file; next read returns full content.
- Different offset; returns full content.

---

## Goal 3.2 — Repeated-call loop guards

**Criterion:** B5 Search/read loop guards
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because looped reads/searches can burn entire turns. **User impact:** weak or stuck agents get forced out of unproductive loops. **Context/cost impact:** high direct savings by blocking repeated identical tool output.
**Reference:** Hermes `tools/file_tools.py:633–644` (warn @ 3, block @ 4)

**Problem.** A confused or weak model can grind on identical reads or searches indefinitely. There is currently no guard.

**Approach.** Track consecutive identical calls per session: `Map<sessionId, Map<callKey, count>>` where `callKey` is a hash of `(toolName, args)`. Increment on identical, reset on different tool call.
- At count = 3: return tool result with a warning prepended.
- At count = 4: hard-block with explicit message.

**Files to touch.**
- `src/server/agent/loop-guard.ts` (new)
- Wrappers for `read`, `grep`, `find`, `bash` (read-only invocations)

**Interface sketch.**
```ts
class LoopGuard {
  observe(sessionId: string, toolName: string, args: unknown): 'ok' | 'warn' | 'block';
  reset(sessionId: string, toolName?: string): void;
}
```

**Acceptance criteria.**
- 3rd identical call returns warning + result.
- 4th identical call returns hard-block message, no result.
- Intervening different tool call resets count.

**Test plan.**
- Synthetic loop: same `grep "foo"` 5 times. Confirm escalation on calls 3 and 4.
- Intersperse a `read`; confirm grep counter resets.

---

## Goal 3.3 — Truncation flags

**Criterion:** B1 · B2 · B4
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because knowing output is truncated changes agent behavior. **User impact:** fewer wrong conclusions from partial results. **Context/cost impact:** moderate indirect savings by encouraging pagination or narrower searches instead of broad retries.

**Problem.** `read`/`grep`/`find` currently truncate silently. The agent doesn't know it has full results.

**Approach.** Always return `{truncated: bool, totalCount?: number, nextOffset?: number}` in tool output. Only emit `truncated: true` on actual truncation (avoid wasted boilerplate).

**Files to touch.**
- `read`, `grep`, `find` extensions

**Acceptance criteria.**
- `truncated: true` only when output was clipped.
- `nextOffset` present when pagination available.
- Existing parsers tolerate the new field.

**Test plan.**
- Read a file shorter than the limit: no truncation flag.
- Read a file longer than the limit: truncation flag + nextOffset.

---

## Goal 3.4 — Upgrade grep tool

**Criterion:** B2 Code content search
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because content search is one of the highest-frequency coding operations. **User impact:** faster, more precise code discovery. **Context/cost impact:** high direct savings through files-only/count modes, limits, offsets, and narrower result sets.
**Reference:** Claude Code `src/tools/GrepTool/GrepTool.ts` (`head_limit = 250`); Hermes `tools/file_tools.py:943–1010`

**Problem.** Bobbit's grep is rg-backed but lacks output modes, pagination, context lines, and proper dash-prefix pattern handling.

**Approach.** Extend the schema:
- `output_mode`: `content` (default) | `files_with_matches` | `count`
- `head_limit`: default 250, `0` for unlimited
- `offset`: pagination
- `type`: `--type` filter (e.g., `ts`, `py`)
- `glob`: `--glob` filter
- `context`: integer for `-A`/`-B`/`-C N` (or separate before/after)
- Robust pattern handling: pass via `-e` to allow leading dashes
- Relative paths in output
- `appliedLimit` only on truncation (not boilerplate)

**Files to touch.**
- `.bobbit/config/tools/grep/extension.ts` and YAML

**Interface sketch.**
```yaml
parameters:
  pattern: { type: string, required: true }
  path: { type: string, default: "." }
  output_mode: { type: enum, values: [content, files_with_matches, count], default: content }
  head_limit: { type: integer, default: 250 }
  offset: { type: integer, default: 0 }
  type: { type: string }
  glob: { type: string }
  context: { type: integer, default: 0 }
  case_insensitive: { type: boolean, default: false }
```

**Acceptance criteria.**
- All parameters work as documented.
- Patterns starting with `-` (e.g., `-foo`) match correctly.
- Truncation flag set only when results exceed `head_limit`.

**Test plan.**
- Per-mode unit tests with fixture repo.
- Pattern with leading dash matches expected lines.
- Pagination round-trip: `offset+head_limit` then `offset+head_limit*2` covers all results without overlap.

---

## Goal 3.5 — Upgrade find tool

**Criterion:** B1 File discovery
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because file discovery matters often but is less costly than content search. **User impact:** agents find likely files faster. **Context/cost impact:** moderate savings by reducing directory scans and irrelevant file reads.
**Reference:** Hermes mtime-sorted file search

**Problem.** Bobbit's `find` does basic glob; results unordered and may not respect `.gitignore`.

**Approach.** Use `rg --files --sortr=modified` when `rg` is available; fallback to `find` with manual `git check-ignore` filtering. Add params: `glob`, `limit`, `offset`, `since` (mtime threshold).

**Files to touch.**
- `.bobbit/config/tools/find/extension.ts` and YAML

**Acceptance criteria.**
- Recently modified files appear first.
- `.gitignore` respected.
- `limit` and `offset` work.

**Test plan.**
- Touch one file; assert it sorts first.
- Add a `node_modules` entry; assert it's excluded by default.

---

## Goal 3.6 — Device-file blocklist

**Criterion:** F1 · B4
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because device reads are rare but severe when they happen. **User impact:** avoids hung sessions. **Context/cost impact:** moderate protective impact by preventing runaway or blocking tool calls rather than routine token savings.
**Reference:** Hermes `tools/file_tools.py:69–78`

**Problem.** Reading `/dev/zero`, `/dev/random`, `/dev/stdin`, etc. can hang the agent indefinitely.

**Approach.** Block list:
- `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/full`
- `/dev/stdin`, `/dev/tty`, `/dev/console`, `/dev/stdout`, `/dev/stderr`
- `/dev/fd/0`, `/dev/fd/1`, `/dev/fd/2`

Reject in `read` with explicit error.

**Files to touch.**
- `read` extension

**Acceptance criteria.**
- Read of any blocked path returns immediate error.
- Error message names the path.

**Test plan.**
- Try each path in unit tests; assert error.

---

## Goal 3.7 — Secret redaction in tool output

**Criterion:** F1 Safety/security
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because leaked secrets in context are a serious safety issue. **User impact:** less risk of credentials appearing in transcripts. **Context/cost impact:** moderate; redaction may slightly reduce output size but its main value is safety.
**Reference:** Hermes `agent/redact.py`

**Problem.** API keys, JWTs, AWS creds, PEM blocks can flow into context via reads, search results, or shell output.

**Approach.** Apply a redactor to `read`, `grep`, `find`, `bash` outputs. Patterns to mask:
- AWS access key (`AKIA[0-9A-Z]{16}`)
- AWS secret (40-char base64-ish near `aws_secret`)
- GitHub token (`ghp_…`, `gho_…`, `ghs_…`)
- OpenAI key (`sk-…`)
- Anthropic key (`sk-ant-…`)
- Generic JWT (three base64 segments separated by `.`)
- PEM block (`-----BEGIN .* PRIVATE KEY-----` … `-----END …`)
- Slack webhook (`https://hooks.slack.com/…`)

Replace with `[REDACTED:<type>]`. Configurable opt-out per session.

**Files to touch.**
- `src/server/security/redact.ts` (new)
- Wrap tool outputs in `read`, `grep`, `find`, `bash`

**Acceptance criteria.**
- All listed patterns masked.
- Redaction applied before truncation/persistence.
- Configurable opt-out works.

**Test plan.**
- Synthetic file containing each secret type; confirm redacted in tool output.
- Performance: large output (~1 MB) redacts in < 100 ms.

---

# Priority 4: Semantic Code Navigation (LSP)

## Goal 4.1 — LSP tool surface

**Criterion:** B3 Code-flow discovery
**Effort:** L · **Impact:** ⭐⭐⭐⭐
**Impact rationale:** ⭐⭐⭐⭐ because LSP changes code discovery from text search to semantic navigation. **User impact:** the agent answers definition/reference questions much faster and more accurately. **Context/cost impact:** very high savings by replacing broad grep/read cycles with concise symbol results.
**Reference:** Claude Code `src/tools/LSPTool/LSPTool.ts`

**Problem.** Bobbit has no semantic navigation. Every "where is X used?" requires broad grep + reads.

**Approach.** Implement an LSP tool exposing operations:
- `definition(file, line, column)`
- `references(file, line, column)` (option `includeDeclaration`)
- `document_symbols(file)`
- `workspace_symbols(query)`
- `implementation(file, line, column)`
- `hover(file, line, column)`
- `prepare_call_hierarchy(file, line, column)`
- `incoming_calls(item)`
- `outgoing_calls(item)`

Mark `defer: true` (Goal 2.4). Return concise formatted results: file paths relative, line numbers, snippets capped to 3 lines per result.

**Files to touch.**
- `.bobbit/config/tools/lsp/extension.ts` (new)
- `.bobbit/config/tools/lsp/extension.yaml` (new)
- `src/server/lsp/manager.ts` (new) — see Goal 4.2

**Acceptance criteria.**
- All 9 operations work on TypeScript and Python projects.
- Results capped to 100 entries with truncation flag.
- Tool deferred by default.

**Test plan.**
- E2E: TS project — `definition` on a function; `references` returns all usages.
- Python project — same flow with pyright.

---

## Goal 4.2 — LSP server lifecycle

**Criterion:** B3
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because LSP lifecycle is required plumbing for Goal 4.1. **User impact:** semantic tools become reliable instead of flaky. **Context/cost impact:** moderate indirect savings by keeping LSP available and reducing fallback grep usage.

**Problem.** LSP servers must be started, kept alive, and restarted on crash.

**Approach.** Implement `LSPManager`:
- One server per (workspace, language).
- Servers detected by file presence (tsconfig.json → tsserver; pyproject.toml/requirements.txt → pyright).
- Health-check via periodic `noop` request.
- Restart with backoff on crash.
- Shutdown on session end.

**Files to touch.**
- `src/server/lsp/manager.ts` (new)
- `src/server/lsp/clients/typescript.ts` (new)
- `src/server/lsp/clients/python.ts` (new)

**Interface sketch.**
```ts
class LSPManager {
  async getOrStart(workspace: string, language: 'typescript' | 'python'): Promise<LSPClient>;
  async shutdown(workspace?: string): Promise<void>;
  status(workspace: string): { language: string; alive: boolean; lastError?: string }[];
}
```

**Acceptance criteria.**
- Servers reused across sessions in the same workspace.
- Crash → restart → next call succeeds.
- Status endpoint shows server health.

**Test plan.**
- Kill a server externally; confirm next tool call restarts it.

---

## Goal 4.3 — Search-order guidance

**Criterion:** B3 · A1
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because tools only help if the model chooses them. **User impact:** agents use the right discovery method more often. **Context/cost impact:** moderate indirect savings by steering away from broad searches.

**Problem.** Even with LSP available, an agent may default to broad grep.

**Approach.** Add a one-paragraph instruction to lean coder role: "Use LSP tools first for symbol lookups (definition, references, document/workspace symbols). Use grep for text searches and unknown identifiers. Use find for filename lookups."

**Files to touch.**
- `.bobbit/config/roles/coder-lean.yaml`
- `.bobbit/config/roles/coder-managed.yaml`

**Acceptance criteria.**
- Both lean and managed coder roles include the guidance.
- Guidance is < 500 chars.

**Test plan.**
- Manual: agent on a TS project asks "where is X used?" — confirm it tries LSP `references` before grep.

---

## Goal 4.4 — Mark LSP tool deferred

**Criterion:** A2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it prevents the new LSP tool from reintroducing prompt bloat. **User impact:** LSP remains available without clutter. **Context/cost impact:** low-to-moderate direct savings from deferring a large schema.
**Depends on:** Goal 2.4

**Problem.** LSP schemas are large (9 operations + types). Always-on inclusion bloats the prompt.

**Approach.** Mark `defer: true` in `lsp/extension.yaml`. The agent discovers via `tool_search('lsp')` or `tool_search('definition')`.

**Files to touch.**
- `.bobbit/config/tools/lsp/extension.yaml`

**Acceptance criteria.**
- Initial tool list shows LSP as deferred stub.
- `tool_search` returns full schema.

**Test plan.**
- Snapshot tool list; LSP appears as `<deferred>`.

---

## Goal 4.5 — Graceful LSP fallback

**Criterion:** B3 · E5
**Effort:** S · **Impact:** ⭐
**Impact rationale:** ⭐ because it improves robustness rather than baseline speed. **User impact:** LSP failures are understandable and recoverable. **Context/cost impact:** low direct impact, but avoids wasted retries after unavailable LSP calls.

**Problem.** Without graceful failure, LSP errors confuse the agent.

**Approach.** When LSP is unavailable for a language or operation:
- Return a structured error: `{error: 'lsp_unavailable', language, hint: 'Try grep instead.'}`.
- Suggest the right grep query when possible (e.g., `grep -n "function <name>"` for definition).

**Files to touch.**
- `src/server/lsp/manager.ts`
- LSP tool extension result formatter

**Acceptance criteria.**
- Unsupported language returns structured error with hint.
- Crashed server returns structured error during restart.

**Test plan.**
- Call LSP on a Rust file (no rust-analyzer configured); assert structured error with grep hint.

---

# Priority 5: Edit Safety and Capability

## Goal 5.1 — Read-before-edit enforcement

**Criterion:** C1 Edit behavior
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because blind edits are a major correctness risk. **User impact:** fewer bad edits and fewer recovery turns. **Context/cost impact:** moderate-to-high indirect savings by preventing failed edits and repair loops.
**Reference:** Claude Code `FileEditTool` mtime check; Hermes `file_state.check_stale`

**Problem.** Edit tool currently trusts the agent's memory of file contents. If the agent never read the file (or read it long ago), edits can be wrong.

**Approach.** In edit/write extensions, check the FileStateRegistry (Goal 7.1):
- If never read: error `must_read_first` with hint to call `read` on the file.
- If read but mtime drifted: error `file_changed_since_read` with mtime delta.

**Files to touch.**
- `.bobbit/config/tools/edit/extension.ts`
- `.bobbit/config/tools/write/extension.ts` (existing-file path)
- `src/server/agent/file-state.ts`

**Acceptance criteria.**
- Edit on un-read file fails with `must_read_first`.
- Edit on file modified since read fails with `file_changed_since_read`.
- New-file write unaffected.

**Test plan.**
- Edit without reading first → error.
- Read, then edit → success.
- Read, touch externally, edit → error.

---

## Goal 5.2 — Stale-file detection

**Criterion:** C1 · C4
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because stale reads cause overwritten user or sibling changes. **User impact:** safer collaboration and fewer corrupt edits. **Context/cost impact:** moderate-to-high indirect savings by avoiding rollback/debug cycles.
**Reference:** Hermes 4-case staleness in `file_state.py:142–215`

**Problem.** Even with read-before-edit, files can drift between read and write within a single turn.

**Approach.** At edit time, re-stat the file just before applying. Compare mtime with the cached read mtime. Refuse with `stale` error if changed. Provide observed mtime in error so model can `read` again.

**Files to touch.**
- `.bobbit/config/tools/edit/extension.ts`
- `src/server/agent/file-state.ts`

**Acceptance criteria.**
- mtime drift between read and edit refused.
- Error includes both timestamps.

**Test plan.**
- Read, sleep 1 ms, modify externally, edit → error.

---

## Goal 5.3 — `replace_all` + multi-edit

**Criterion:** C1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because batched replacements reduce repeated edit calls. **User impact:** common rename/refactor tasks are simpler. **Context/cost impact:** moderate direct savings by collapsing many edits into one tool call.

**Problem.** Bobbit edit replaces only first occurrence. Renaming or batched replacements need many tool calls.

**Approach.**
1. Add `replace_all: bool` (default `false`) to edit schema.
2. Add a new `multi_edit` tool that takes `edits: Array<{old_string, new_string, replace_all?}>` applied sequentially with all-or-nothing semantics (rollback on any failure).

**Files to touch.**
- `.bobbit/config/tools/edit/extension.ts`
- `.bobbit/config/tools/multi_edit/extension.ts` (new)

**Interface sketch.**
```yaml
multi_edit:
  parameters:
    file_path: { type: string, required: true }
    edits:
      type: array
      items: { old_string, new_string, replace_all }
```

**Acceptance criteria.**
- `replace_all: true` replaces every occurrence.
- `multi_edit` applies all edits or none.

**Test plan.**
- Replace 5 occurrences in one call; expect all replaced.
- Multi-edit with one bad old_string in the middle; expect file unchanged.

---

## Goal 5.4 — V4A multi-file patch

**Criterion:** C2 Multi-file / atomic patches
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because atomic multi-file patches are a step up for real refactors. **User impact:** cross-file changes become faster and safer. **Context/cost impact:** high direct savings by replacing many edit/write calls and repeated diffs with one structured patch.
**Reference:** Hermes `tools/file_tools.py:847–940`

**Problem.** Cross-file refactors require N edit calls today. Each call re-ships context.

**Approach.** Add a `patch` tool that accepts the V4A format:
```
*** Begin Patch
*** Update File: path/to/a.ts
@@ <hunk>
- old line
+ new line
*** Update File: path/to/b.ts
@@ <hunk>
…
*** Add File: path/to/new.ts
+ contents
*** Delete File: path/to/old.ts
*** End Patch
```

Implementation:
- Parse patch into per-file operations.
- Acquire per-path locks (Goal 7.2) **in sorted path order** to avoid deadlock.
- Validate all changes can apply (read each file, dry-run hunks).
- Apply in a single critical section.
- On any failure, roll back all files.

**Files to touch.**
- `.bobbit/config/tools/patch/extension.ts` (new)
- `src/server/agent/v4a-parser.ts` (new)
- `src/server/agent/file-state.ts`

**Acceptance criteria.**
- Multi-file patches succeed atomically or fail with all files unchanged.
- Sorted-lock acquisition demonstrably avoids deadlock under concurrent patches.

**Test plan.**
- 3-file patch: applies cleanly.
- 3-file patch with hunk-conflict in file 2: all 3 unchanged after error.
- Two concurrent patches touching overlapping files: serialise correctly.

---

## Goal 5.5 — Fuzzy match fallback

**Criterion:** C1
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because fuzzy fallback reduces needless failed exact-match retries. **User impact:** edits succeed despite minor whitespace drift. **Context/cost impact:** moderate savings by avoiding repeated read/edit attempts.
**Reference:** Hermes 9-strategy fuzzy in `file_operations.patch_replace`

**Problem.** Exact-match edits fail on minor whitespace/indent drift, even when the intent is clear.

**Approach.** When exact match fails, try in order:
1. Whitespace-tolerant: collapse runs of whitespace.
2. Indent-tolerant: strip common leading whitespace before compare.
3. Newline-normalised: CRLF/LF agnostic.
4. Trailing-whitespace tolerant.
5. Comment-tolerant: ignore inline comments at the line level.

Surface which strategy succeeded so the model knows it was fuzzy.

**Files to touch.**
- `src/server/agent/edit-strategies.ts` (new)
- `.bobbit/config/tools/edit/extension.ts`

**Acceptance criteria.**
- Exact match wins when available.
- Fuzzy fallback succeeds on whitespace/indent drift.
- Result reports `match_strategy: 'exact' | 'whitespace' | 'indent' | …`.

**Test plan.**
- Each strategy has a positive and negative test.

---

## Goal 5.6 — Preserve line endings

**Criterion:** C3
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it mostly reduces diff noise in specific files. **User impact:** cleaner diffs and fewer accidental rewrites. **Context/cost impact:** low direct savings, except avoiding huge CRLF/LF diffs.

**Problem.** Editing a CRLF file can rewrite it to LF, producing massive noisy diffs.

**Approach.** Detect existing line endings on read; remember per-file. When writing/editing, normalise output to match.

**Files to touch.**
- `src/server/agent/file-state.ts` — store line ending
- `read`/`edit`/`write` extensions

**Acceptance criteria.**
- CRLF file remains CRLF after edit.
- LF file remains LF after edit.

**Test plan.**
- Edit a CRLF fixture; assert no spurious line-ending changes in `git diff`.

---

## Goal 5.7 — Concise diffs in tool output

**Criterion:** A4 · C1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because large diffs can dominate context after edits. **User impact:** edit results stay readable. **Context/cost impact:** moderate direct savings by capping inline diff output and persisting large diffs.

**Problem.** Edit tool output can dump full file contents or large diffs.

**Approach.** Return a unified diff capped to ~200 lines. If larger, persist full diff via Goal 6.1 and return preview + path. Always include before/after byte count.

**Files to touch.**
- `.bobbit/config/tools/edit/extension.ts`
- `.bobbit/config/tools/patch/extension.ts`

**Acceptance criteria.**
- Diffs ≤ 200 lines inline; larger persisted.
- Result includes `bytes_before`, `bytes_after`.

**Test plan.**
- Small edit → inline diff.
- 500-line edit → preview + path.

---

## Goal 5.8 — Post-write byte-compare

**Criterion:** C5 Post-edit verification
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because silent write failures are uncommon but expensive to debug. **User impact:** users learn immediately if a write did not land. **Context/cost impact:** moderate indirect savings by avoiding later investigation turns.
**Reference:** Hermes `tools/file_operations.py:798–806`

**Problem.** Silent write failures (disk full, permission, etc.) currently surface only on next read.

**Approach.** Immediately after write/edit/patch, re-read the file and compare to expected content. Mismatch → tool error with diff summary.

**Files to touch.**
- `src/server/agent/file-state.ts` — `verifyWrite(path, expected)` helper
- `edit`/`write`/`patch` extensions

**Acceptance criteria.**
- All edit-family tools verify post-write.
- Mismatch reported as structured error.

**Test plan.**
- Mock filesystem layer to drop a byte on write; assert mismatch error.

---

## Goal 5.9 — Auto syntax check on patch

**Criterion:** C5 · D3
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because syntax errors should be caught immediately. **User impact:** faster feedback after edits. **Context/cost impact:** moderate indirect savings by reducing test/debug repair loops.
**Reference:** Hermes `tools/file_operations.py:261–267`

**Problem.** Syntax errors are caught only when the agent runs build/test, often turns later.

**Approach.** After successful patch/edit/write, run an extension-specific check:
- `.py`: `python -m py_compile <file>`
- `.js` / `.jsx`: `node --check <file>`
- `.ts` / `.tsx`: `npx tsc --noEmit --isolatedModules <file>` (slow; cache result; consider per-project tsserver)
- `.go`: `go vet <file>`
- `.rs`: `rustfmt --check <file>`
- `.json`: native parse
- `.yaml`: parse via the same library used elsewhere

Return `syntax_ok: bool` with first error line/column on failure. Skip silently for unsupported extensions. Configurable opt-out.

**Files to touch.**
- `src/server/agent/syntax-check.ts` (new)
- `edit`/`write`/`patch` extensions

**Acceptance criteria.**
- Patch result includes `syntax_ok` for supported extensions.
- Skipped extensions report `syntax_ok: null`.

**Test plan.**
- Inject bad Python syntax; expect `syntax_ok: false` with line.
- Valid TS edit; expect `true`.

---

# Priority 6: Tool-Result Context Control

## Goal 6.1 — Per-result persistence

**Criterion:** A4 · A1
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because oversized single tool results are a major context killer. **User impact:** sessions stay responsive even after huge commands. **Context/cost impact:** high direct savings by replacing large outputs with previews and file paths.
**Reference:** Hermes `tools/tool_result_storage.py:116–172`

**Problem.** Single tool calls (long shell output, large grep) can dump tens of thousands of chars into context.

**Approach.** Per-tool `max_result_chars` in YAML. When result exceeds threshold:
1. Write full result to `.bobbit/state/tool-results/<session_id>/<tool_use_id>.txt`.
2. Return preview (first ~1500 chars + last ~500 chars + path).
3. Include `<persisted-output path="…" full_size="…">` envelope so agent can re-read with `read`.

**Files to touch.**
- `src/server/agent/tool-result-store.ts` (new)
- `src/server/agent/rpc-bridge.ts` — wrap all tool calls
- `.bobbit/config/tools/<tool>/extension.yaml` — `max_result_chars` field

**Interface sketch.**
```ts
interface PersistedResult {
  preview: string;
  fullPath: string;
  fullSize: number;
}
async function persistIfOversize(
  sessionId: string,
  toolUseId: string,
  content: string,
  maxChars: number
): Promise<string | PersistedResult>;
```

**Acceptance criteria.**
- Results over threshold replaced with preview + path.
- Agent can `read` the path to retrieve full content.
- Per-tool thresholds respected.

**Test plan.**
- 200 KB shell output → preview + path.
- Read the path → full content.

---

## Goal 6.2 — Per-turn aggregate budget

**Criterion:** A4
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because many medium outputs can be as bad as one huge output. **User impact:** multi-tool turns stay readable. **Context/cost impact:** high direct savings by enforcing a hard per-turn context budget.
**Reference:** Hermes `MAX_TURN_BUDGET_CHARS = 200_000`

**Problem.** Many medium-sized tool outputs in one turn can sum past 100 KB without anyone noticing.

**Approach.** After all tool calls in a turn complete:
1. Sum result sizes.
2. If total > budget (default 200 KB), persist results largest-first using Goal 6.1 until under budget.
3. Persisted ones replaced with preview + path in-place.

**Files to touch.**
- `src/server/agent/rpc-bridge.ts` — turn-end hook
- `src/server/agent/turn-budget.ts` (new)

**Acceptance criteria.**
- Turn never injects more than configured budget.
- Largest results persist first; smallest stay inline.

**Test plan.**
- Fire 5 × 60 KB tool calls in one turn (300 KB total). Assert 2–3 largest persisted; total ≤ 200 KB.

---

## Goal 6.3 — Microcompact old tool results

**Criterion:** A6
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because old tool outputs accumulate in long sessions. **User impact:** long conversations remain usable. **Context/cost impact:** high direct savings by replacing stale bulky results with summaries.
**Reference:** Claude Code `src/services/compact/microCompact.ts`

**Problem.** Old tool results pile up in long sessions, taking context for no current value.

**Approach.** Periodic sweep (every N turns or before compaction): replace tool results from `read`, `grep`, `find`, `bash`, `edit`, `write`, `patch` older than M turns with a one-line summary `[microcompacted: <tool> <key args>]`. Preserve metadata (path, command).

**Files to touch.**
- `src/server/agent/microcompact.ts` (new)
- Hook into the turn loop

**Acceptance criteria.**
- Tool results older than M turns replaced with summaries.
- Tool metadata preserved.
- Recent tool results untouched.

**Test plan.**
- 30-turn session; assert results from turns 1–10 microcompacted, 21–30 inline.

---

## Goal 6.4 — Auto-compaction trigger

**Criterion:** A6
**Effort:** M · **Impact:** ⭐⭐⭐⭐
**Impact rationale:** ⭐⭐⭐⭐ because automatic compaction prevents context-window failures. **User impact:** fewer manual interventions and fewer lost sessions. **Context/cost impact:** very high savings by keeping long sessions below context limits.
**Reference:** Claude Code `AUTOCOMPACT_BUFFER_TOKENS = 13000`; Hermes 75 % threshold

**Problem.** Compaction is manual-only via `compact()` RPC. Long sessions blow context unless the user types a command.

**Approach.** Monitor estimated context length per turn. When usage > 75 % of model window (or window − 13K tokens, whichever is tighter), trigger `compact()` automatically. Allow user override threshold.

**Files to touch.**
- `src/server/agent/rpc-bridge.ts`
- `src/server/agent/auto-compact.ts` (new)
- Session config: `auto_compact_threshold_pct`, `auto_compact_buffer_tokens`

**Acceptance criteria.**
- Threshold breach triggers compaction automatically.
- User can override threshold.
- Configurable disable.

**Test plan.**
- Synthetic context-fill session; assert auto-compact fires at threshold.

---

## Goal 6.5 — Compaction failure cooldown

**Criterion:** E5
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because failed compaction loops are costly and confusing. **User impact:** fewer repeated errors after compact failure. **Context/cost impact:** moderate protective impact by preventing repeated failed summarization calls.
**Reference:** Hermes 600 s cooldown; Claude Code `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`

**Problem.** A failed `compact()` (e.g., model error) without a cooldown can loop.

**Approach.** After failed `compact()`:
- Track last-failure timestamp; do not retry for 600 s.
- Track consecutive failures; circuit-break after 3 (disable auto-compact for the session, surface error).

**Files to touch.**
- `src/server/agent/auto-compact.ts`

**Acceptance criteria.**
- Failed compact does not retry within 600 s.
- After 3 consecutive failures, auto-compact disabled and user notified.

**Test plan.**
- Mock compact failure; confirm 600 s cooldown and 3-strike circuit break.

---

## Goal 6.6 — Read-state reset post-compaction

**Criterion:** A5 · A6
**Effort:** XS · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because dedup must not point to content that compaction removed. **User impact:** agents do not get misleading read stubs after compaction. **Context/cost impact:** moderate correctness impact; it may spend tokens intentionally to restore needed file context.

**Problem.** After compaction, file content may no longer be in context, yet the read-dedup cache (Goal 3.1) still says "already read."

**Approach.** Subscribe to compaction start/end events. On end, clear read-dedup cache for the session.

**Files to touch.**
- `src/server/agent/file-state.ts`
- `src/server/agent/auto-compact.ts`

**Acceptance criteria.**
- First read after compaction returns full content.
- Cache rebuilds normally afterward.

**Test plan.**
- Read file → compact → read again → full content (not stub).

---

# Priority 7: Concurrency Safety

## Goal 7.1 — Process-wide file-state registry

**Criterion:** C4 Concurrency safety
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because shared file state is foundational for safe parallel work. **User impact:** fewer clobbered edits across sessions/delegates. **Context/cost impact:** moderate indirect savings by avoiding repair and rework after conflicts.
**Reference:** Hermes `tools/file_state.py` (full reference impl)

**Problem.** Bobbit has no cross-session file-state coordination. Parallel delegates can clobber each other's edits.

**Approach.** Implement `FileStateRegistry`:
- `Map<absPath, {locks, lastWriter: {sessionId, ts}, perSessionReads: Map<sessionId, {mtime, ts, partial}>}>`.
- Bound 4096 paths per session, 4096 global writers, LRU eviction.
- Methods: `recordRead`, `recordWrite`, `checkStale`, `writesSince(sessionId, sincePath)`, `lockPath(path)`.

**Files to touch.**
- `src/server/agent/file-state.ts` (consolidates all earlier file-state work)

**Interface sketch.**
```ts
class FileStateRegistry {
  recordRead(sessionId: string, path: string, mtime: number, partial: boolean): void;
  recordWrite(sessionId: string, path: string): void;
  checkStale(sessionId: string, path: string): StaleReason | null;
  writesSince(sessionId: string, path: string, sinceTs: number): WriteRecord[];
  lockPath(path: string): Promise<() => void>; // returns unlock fn
}
type StaleReason =
  | { case: 'sibling_wrote', writer: string, ts: number }
  | { case: 'mtime_drift', expected: number, observed: number }
  | { case: 'partial_read', readOffset: number, readLimit: number }
  | { case: 'no_prior_read' };
```

**Acceptance criteria.**
- All four staleness cases detected.
- Bounds enforced; LRU eviction works.
- Locks reentrant within a session, mutually exclusive across sessions.

**Test plan.**
- Race two sessions on the same file; assert serialised.
- Fill with 5K paths; assert eviction.

---

## Goal 7.2 — Per-path locks for write/edit

**Criterion:** C4
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because locks make write safety enforceable. **User impact:** concurrent edits serialize safely. **Context/cost impact:** moderate indirect savings by preventing corrupted files and retry cycles.
**Depends on:** Goal 7.1

**Problem.** Without locks, two concurrent edits to the same file can race.

**Approach.** Use Goal 7.1 locks. Wrap `edit`, `write`, `patch` (per-file) operations:
```ts
const unlock = await registry.lockPath(absPath);
try { /* read → modify → write → verify */ }
finally { unlock(); }
```

For multi-file `patch` (Goal 5.4), acquire locks in **sorted path order**.

**Files to touch.**
- `edit`/`write`/`patch` extensions

**Acceptance criteria.**
- Concurrent edits serialise.
- Multi-file patches deadlock-free under stress.

**Test plan.**
- Stress test: 10 concurrent edits + 5 concurrent patches; assert no corruption, no deadlock.

---

## Goal 7.3 — Sibling-agent stale warnings

**Criterion:** C4 · E1
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because parent/sibling awareness is critical in delegated work. **User impact:** agents know when to re-read after a delegate changes a file. **Context/cost impact:** high indirect savings by preventing stale follow-up edits.

**Problem.** When a delegate writes a file the parent (or another sibling) read, the parent has no awareness.

**Approach.** When a delegate completes, call `registry.writesSince(parentSessionId, path, parentDelegateStartTs)` for each path the parent read. Append warnings to delegate result:
```
[file-state] Sibling sessions wrote these files since you last read them:
  - src/foo.ts (by delegate-3 at 14:02:11)
  - src/bar.ts (by delegate-3 at 14:02:14)
You should re-read before editing.
```

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts` (delegate)
- `src/server/agent/file-state.ts`

**Acceptance criteria.**
- Delegate result includes sibling-write warnings when relevant.
- Empty list when no overlap.

**Test plan.**
- Parent reads `a.ts`, delegate writes `a.ts`, parent receives warning.

---

## Goal 7.4 — Four-case staleness detection

**Criterion:** C1 · C4
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because precise stale errors lead to the right recovery action. **User impact:** clearer tool failures and safer edits. **Context/cost impact:** moderate indirect savings by avoiding ambiguous retries.
**Depends on:** Goal 7.1

**Problem.** Different staleness causes need distinct messages so the agent can react correctly.

**Approach.** On every edit/write, call `registry.checkStale(sessionId, path)`. If non-null, refuse the operation with a structured error matching one of:
- `sibling_wrote`: include writer and timestamp; advise re-read.
- `mtime_drift`: include observed mtime; advise re-read.
- `partial_read`: read used offset/limit; advise full read before overwrite.
- `no_prior_read`: advise read first.

**Files to touch.**
- `edit`/`write`/`patch` extensions
- Error type taxonomy

**Acceptance criteria.**
- Each case has a distinct error code.
- Each case observed in tests.

**Test plan.**
- Four scenarios, each producing the right error.

---

# Priority 8: Plan / Read-Only Mode

## Goal 8.1 — `plan` mode toggle

**Criterion:** E2 Plan / read-only mode
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because read-only exploration is a common safety need. **User impact:** users can ask for analysis without risking file changes. **Context/cost impact:** moderate indirect savings by avoiding accidental edits and rollback work.
**Reference:** Claude Code `EnterPlanModeTool`

**Problem.** Exploration sessions risk side effects; users want a "look, don't touch" mode.

**Approach.** Add `enter_plan` and `exit_plan` tools (or a session flag). In plan mode, mutating tools are blocked or routed to dry-run. Distinct from lean mode: plan can apply within either lean or managed.

**Files to touch.**
- `.bobbit/config/tools/plan/extension.ts` (new)
- `src/server/agent/permissions.ts` (new — see Goal 8.2)

**Acceptance criteria.**
- Plan mode blocks `write`, `edit`, `patch`, mutating `bash`.
- Read-only tools work normally.
- Exit returns to previous mode.

**Test plan.**
- Enter plan → attempt edit → blocked.
- Exit plan → edit succeeds.

---

## Goal 8.2 — Permission classifier

**Criterion:** E2 · F1
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because plan mode depends on accurate call classification. **User impact:** safer command/tool behavior. **Context/cost impact:** moderate indirect savings by blocking expensive/dangerous side effects before they happen.

**Problem.** A static blocklist doesn't capture that `bash rm` is dangerous but `bash ls` isn't.

**Approach.** Per-call classifier maps `(tool, args)` → `{readOnly, mutating, executes, dangerous}`. In plan mode, only `readOnly` is allowed. In lean mode, all permitted; `dangerous` triggers approval (Goal 11.3-related).

**Files to touch.**
- `src/server/agent/permissions.ts`

**Interface sketch.**
```ts
type CallClass = 'read' | 'mutate' | 'exec_safe' | 'exec_dangerous';
function classify(tool: string, args: unknown): CallClass;
```

**Acceptance criteria.**
- Classifier covers all built-in tools.
- Bash commands classified by parsing first token + flags (e.g., `rm -rf` → dangerous).
- Override via session config.

**Test plan.**
- Per-tool unit tests.
- Bash command corpus (50 examples) covers expected classes.

---

## Goal 8.3 — UI affordance

**Criterion:** E2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it is UX support for an underlying safety mode. **User impact:** users can see and trust plan mode state. **Context/cost impact:** low direct impact, but prevents mistaken mode usage.

**Problem.** Plan mode changes what the agent is allowed to do. If the UI does not make that state obvious, users may assume edits are happening when they are blocked, or assume the agent is read-only when it is actually allowed to mutate files. This creates both confusion and safety risk.

**Approach.** Add a persistent visual affordance for plan mode in every session surface:
- Session header badge: `PLAN MODE` when active, absent when inactive.
- Optional tooltip/click target: "Read-only exploration is active. Mutating tools are blocked."
- One-key or one-click toggle that calls the same session-mode mutation used by Goal 8.1.
- When entering plan mode, append a short system/session event visible in transcript: `[plan-mode] Mutating tools are now blocked.`
- When exiting plan mode, append: `[plan-mode] Mutating tools are enabled again.`

The UI should not rely only on transcript text, because transcript events scroll away. The badge must remain visible while plan mode is active.

**Files to touch.**
- `src/ui/components/SessionHeader.tsx` or equivalent — render badge and tooltip.
- `src/ui/keybindings.ts` or equivalent — add toggle shortcut.
- `src/server/api/sessions.ts` — expose `PATCH /api/sessions/:id/plan-mode` if not already covered by Goal 8.1.
- Session state store — persist `planMode: boolean` and broadcast updates over websocket.

**Interface sketch.**
```ts
type PlanModeState = {
  enabled: boolean;
  changedAt: string;
  changedBy: 'user' | 'agent' | 'api';
};
```

**Acceptance criteria.**
- Badge visible while in plan mode.
- Badge updates within one websocket tick after mode changes.
- One-key or one-click toggle works and is reflected in session state.
- Transcript gets an explicit enter/exit event.
- Plan-mode state survives refresh/reconnect.

**Test plan.**
- Unit test: render header with `planMode=true`; assert badge text exists.
- E2E test: toggle plan mode, attempt an edit, verify edit blocked and badge visible.
- E2E test: refresh UI while plan mode active; badge still visible.

---

# Priority 9: Delegation Efficiency

## Goal 9.1 — Lightweight delegate mode

**Criterion:** E1 Delegation/subagents
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because full delegates are overkill for small discovery tasks. **User impact:** faster parallel exploration. **Context/cost impact:** moderate direct savings by using a small prompt/toolset/result cap for simple subagents.

**Problem.** `delegate` currently spins up a full session; overhead is high for "tell me what's in this folder" questions.

**Approach.** Add `delegate({mode: 'lite'})`. Lite delegates:
- Use a minimal system prompt (just identity + tool list).
- Use `code-core` toolset only (read, find, grep).
- Have a strict result cap (e.g., 2 KB).
- Cannot recursively delegate.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`
- New `delegate-lite` role or inline minimal role

**Acceptance criteria.**
- Lite delegate completes simple read-only tasks in noticeably fewer tokens than current delegate.
- Recursion blocked.

**Test plan.**
- "Find all TODOs in src/": lite vs full delegate; assert lite uses ≤ 30 % tokens.

---

## Goal 9.2 — Context-fork option

**Criterion:** E1
**Effort:** L · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because forked context prevents delegates from rediscovering known facts. **User impact:** delegates are more useful with less instruction. **Context/cost impact:** high savings through prompt-cache reuse and less repeated exploration.
**Reference:** Claude Code `forkSubagent.ts` (byte-exact prompt sharing)

**Problem.** Lite delegates start cold; they don't know what the parent has already discovered. Re-explaining costs tokens.

**Approach.** Support `delegate({fork_context: true})`. Fork:
- Parent's compacted conversation is included as a `[FORKED CONTEXT]` block.
- System prompt shared byte-exactly for cache-hit benefit.
- Strict result cap.
- Marks fork in turn boundaries to prevent infinite recursion.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`
- `src/server/agent/fork.ts` (new)

**Acceptance criteria.**
- Forked delegate sees parent context.
- Cache reuse measurable in cost-tracker (parent vs fork share cache).
- Recursion guard prevents nested fork.

**Test plan.**
- Parent reads file A and grep'd for X; fork asked "summarise findings" without re-reading.
- Cache hit rate verified on second fork in the same parent session.

---

## Goal 9.3 — Concurrent spawning

**Criterion:** E1
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it improves wall-clock latency more than token use. **User impact:** parallel delegation actually feels parallel. **Context/cost impact:** low direct cost impact; mainly reduces waiting.

**Problem.** Verify the existing `Promise.all` path actually starts all children concurrently. If it serialises session creation, parallelism is illusory.

**Approach.** Audit `parallel: [...]` path in `agent/extension.ts`. Ensure session creation happens concurrently (e.g., `await Promise.all(specs.map(createSession))`) before the wait.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`

**Acceptance criteria.**
- 3 children with 1 s spec-creation each complete in ~1 s wall clock, not 3 s.

**Test plan.**
- Instrument session creation; assert overlap.

---

## Goal 9.4 — Structured delegate results

**Criterion:** A4 · E1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because structured results prevent verbose delegate dumps. **User impact:** parent agents and users can scan outputs quickly. **Context/cost impact:** moderate direct savings by capping prose and persisting large details.

**Problem.** Delegate output is free-form prose, often verbose.

**Approach.** Standard return shape:
```json
{
  "summary": "<= 500 chars",
  "files_read": ["..."],
  "files_changed": ["..."],
  "tests_run": [{"name": "...", "ok": true}],
  "blockers": [],
  "artifacts": [{"name": "...", "path": "..."}]
}
```

Free-form prose persisted to artifacts only. Cap summary; persist anything longer via Goal 6.1.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`
- Delegate result formatter

**Acceptance criteria.**
- All delegate results have the shape.
- Long prose persisted; preview + path returned.

**Test plan.**
- Delegate that lists 100 files: result clean and structured.

---

## Goal 9.5 — Delegate toolset restriction

**Criterion:** E1
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because it is a safety/default-scope improvement. **User impact:** delegates stay focused and avoid unwanted side effects. **Context/cost impact:** low-to-moderate savings by removing unnecessary tools from child prompts.
**Reference:** Hermes `DELEGATE_BLOCKED_TOOLS`

**Problem.** Default delegate inherits all tools, including `delegate` itself (recursion risk) and memory/messaging.

**Approach.** Default delegate toolset excludes:
- `delegate` / `delegate_lite` (recursion)
- `memory_*` (cross-session bleed)
- `send_message` (delegate shouldn't talk to humans)
- Browser tools (off-task by default)

Opt-in to add back via `delegate({tools: [...]})`.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`

**Acceptance criteria.**
- Default delegate cannot call any blocked tool.
- Opt-in works.

**Test plan.**
- Confirm blocked tools absent from delegate's tool list.

---

## Goal 9.6 — Auto-deny dangerous in delegates

**Criterion:** E1 · F1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because dangerous delegated shell commands are high-risk. **User impact:** safer background/subagent work. **Context/cost impact:** moderate indirect savings by preventing destructive mistakes and recovery work.

**Problem.** Background delegates running shell can execute destructive commands without parent oversight.

**Approach.** Subagents default to auto-deny dangerous (per classifier in Goal 8.2). Opt-in via `delegate({approve_dangerous: true})` or session-level `subagent_auto_approve`.

**Files to touch.**
- `.bobbit/config/tools/agent/extension.ts`
- `src/server/agent/permissions.ts`

**Acceptance criteria.**
- `rm -rf`, `git push --force`, `kubectl delete` etc. blocked in delegate by default.
- Opt-in works.

**Test plan.**
- Delegate attempts `rm -rf`; expect blocked with clear error.

---

# Priority 10: Prompt-Cache Strategy

## Goal 10.1 — Stable prefix vs volatile suffix

**Criterion:** A3 Prompt-cache strategy
**Effort:** M · **Impact:** ⭐⭐⭐⭐
**Impact rationale:** ⭐⭐⭐⭐ because prompt-cache structure can materially change recurring-session cost. **User impact:** repeat project sessions become cheaper and often faster. **Context/cost impact:** very high direct savings through stable-prefix cache hits.
**Reference:** Hermes `agent/prompt_caching.py`

**Problem.** Bobbit's prompt structure is not cache-friendly. AGENTS.md / CLAUDE.md / memories re-read on every session; same content but no cache hit because volatile content sits before the stable parts.

**Approach.** Reorder system prompt assembly:

**Stable prefix (cache-controlled):**
1. Identity + global system prompt
2. AGENTS.md + CLAUDE.md
3. Tool-doc stubs (lean) or full tool docs (managed)
4. Role prompt stub

**Volatile suffix (not cached):**
5. Active goal / task spec
6. Active workflow context
7. Current memory (bounded, ranked — Goal 14.5)
8. Personality fragment

Mark stable block with provider-appropriate cache-control hints.

**Files to touch.**
- `src/server/agent/system-prompt.ts`

**Acceptance criteria.**
- Repeat sessions on the same project hit cache for stable block.
- Cost tracker shows cache reads.

**Test plan.**
- Two consecutive lean sessions on the same project; assert second has high cache-read tokens.

---

## Goal 10.2 — Cache `system + last-N` pattern

**Criterion:** A3
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because caching recent messages improves repeated turns in-session. **User impact:** lower cost during active work. **Context/cost impact:** moderate direct savings where providers support cache markers.
**Reference:** Hermes `system_and_3` strategy

**Problem.** Within a single session, only the system prompt benefits from cache; conversation history doesn't.

**Approach.** Mark system prompt + last 3 non-system messages with `cache_control: ephemeral`. TTL default 5 min, configurable to 1 h.

**Files to touch.**
- `src/server/agent/rpc-bridge.ts` (or wherever messages are sent to provider)

**Acceptance criteria.**
- Anthropic provider sees 4 cache markers per request (system + 3 messages).
- TTL configurable.

**Test plan.**
- Inspect outgoing API request payload.

---

## Goal 10.3 — Provider-aware cache control

**Criterion:** A3 · F4
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because cache hints must match provider behavior. **User impact:** fewer provider-specific failures or missed savings. **Context/cost impact:** moderate direct savings by enabling cache where supported and no-oping elsewhere.

**Problem.** Different providers (Anthropic, OpenAI) have different cache semantics.

**Approach.** Detect provider; emit appropriate cache hints:
- Anthropic: `cache_control: {type: 'ephemeral'}` blocks.
- OpenAI: rely on automatic prefix caching; ensure stable prefix exists.
- Gemini: similar to OpenAI implicit caching.
- Others: no-op.

**Files to touch.**
- `src/server/agent/providers/*` (per-provider adapters)

**Acceptance criteria.**
- Each supported provider gets correct hint.
- Non-supporting providers no-op gracefully.

**Test plan.**
- Mock outbound request per provider; assert correct shape.

---

## Goal 10.4 — Cache-hit reporting

**Criterion:** F5
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because reporting does not itself reduce cost. **User impact:** users can see which provider/mode is cost-effective. **Context/cost impact:** low direct impact, but it guides cache optimization decisions.

**Problem.** Goal 0.4 exposes cache hit rate at the session level, but optimization decisions also need provider-level and mode-level breakdowns. Without this, Bobbit cannot tell whether Anthropic cache-control hints, OpenAI automatic prefix caching, or mode-specific prompt assembly changes are actually paying off.

**Approach.** Extend the cache metrics model with dimensions:
- `provider`
- `model`
- `projectPath`
- `mode` (`lean` / `managed`)
- `role`
- `dateBucket`

Compute:
- `cacheReadTokens`
- `cacheWriteTokens`
- `inputTokens`
- `cacheHitRate = cacheReadTokens / max(1, cacheReadTokens + inputTokens)`
- `estimatedSavingsUsd` when pricing metadata is available

Add dashboard tiles:
- "Best cache hit rate by provider"
- "Lean vs managed cache hit rate"
- "Worst projects by cache miss volume"
- "Cache trend over last 30 days"

**Files to touch.**
- `src/server/cost/cost-tracker.ts` — persist dimensional cache stats.
- `src/server/api/cost.ts` or equivalent — aggregate endpoint.
- UI dashboard/session analytics component.

**Interface sketch.**
```ts
type CacheMetricsBucket = {
  provider: string;
  model: string;
  projectPath: string;
  mode: 'lean' | 'managed';
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  estimatedSavingsUsd?: number;
};
```

**Acceptance criteria.**
- Per-provider, per-mode, and per-project cache hit rate is visible.
- Dashboard can filter to last 7 / 30 / 90 days.
- Sessions with no cache support show `not supported`, not `0 %`.
- Cache metrics exportable as JSON for offline analysis.

**Test plan.**
- Mock cost events for two providers; verify aggregation.
- Run sessions across 2 providers; verify breakdown shows distinct metrics.
- Provider with no cache fields should be excluded from hit-rate denominator.

---

# Priority 11: Prompt-Injection Defense

## Goal 11.1 — Context-file scanner

**Criterion:** F2 Prompt-injection defense
**Effort:** M · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because context-file injection can compromise every session. **User impact:** safer work on unfamiliar repositories. **Context/cost impact:** moderate indirect savings by preventing malicious or irrelevant injected instructions from steering long tool loops.
**Reference:** Hermes `agent/prompt_builder.py:36–73` (13 patterns)

**Problem.** Bobbit injects AGENTS.md, CLAUDE.md, READMEs, memory files verbatim. A malicious commit to one of these (or a user accidentally cloning a repo with one) could pivot the agent.

**Approach.** Scan all context files before injection for these patterns:

| Pattern | Detection |
|---|---|
| "ignore previous instructions" / "disregard above" | Case-insensitive substring |
| "system prompt override" | Substring |
| Hidden Unicode | Codepoints `U+200B`–`U+202E`, `U+2060`–`U+2064`, `U+FEFF` |
| Exfil curl/wget | Regex for `curl … -d`, `wget … --post-data` |
| Secret-file reads | `cat ~/.env`, `cat ~/.netrc`, `cat ~/.pgpass`, `cat ~/.aws/credentials`, etc. |
| Hidden HTML divs | `<div style="display:none"`, `<span style="visibility:hidden"` |
| Translate-then-execute | "translate … then run" patterns |
| Instructions to delete | Imperatives followed by `rm -rf`, `DROP TABLE`, etc. |
| Hidden HTML comments containing instructions | `<!-- … instruction -->` (heuristic: comment > 100 chars with imperatives) |
| Base64-encoded shell | `base64 -d \| bash`, `echo … \| base64 -d \| sh` |
| Reverse shell idioms | `bash -i >& /dev/tcp/…` |
| Credential-grabbing pipes | `cat … \| curl …` |
| Environment-variable exfil | `env \| curl`, `printenv \| nc` |

On match, default to **warn-and-strip** (replace match with `[STRIPPED: prompt-injection-pattern]`); allow override to `warn-only` or `block-session-load`. Log all detections with file path and pattern name.

**Files to touch.**
- `src/server/security/injection-scan.ts` (new)
- `src/server/agent/system-prompt.ts` — call before each context-file inclusion

**Acceptance criteria.**
- All 13 patterns detected.
- Default mode strips and warns; configurable.
- Log every detection.

**Test plan.**
- Corpus of 13+ adversarial fixtures, one per pattern.
- Negative corpus (legitimate content) → no false positives.

---

## Goal 11.2 — YAML frontmatter strip

**Criterion:** F2
**Effort:** XS · **Impact:** ⭐
**Impact rationale:** ⭐ because frontmatter is a small but easy-to-remove context source. **User impact:** less metadata noise. **Context/cost impact:** low direct savings, with some safety benefit.

**Problem.** Frontmatter on AGENTS.md/CLAUDE.md/memory files reaches the model verbatim. It often contains metadata the model doesn't need and could be a vector for hidden instructions.

**Approach.** Detect leading `---`-fenced YAML; strip before injection (preserve to a metadata field if needed by other code).

**Files to touch.**
- `src/server/agent/system-prompt.ts` — frontmatter strip helper

**Acceptance criteria.**
- Leading frontmatter removed from injected content.
- Metadata still accessible via session debug.

**Test plan.**
- File with frontmatter → injected content has no frontmatter.

---

## Goal 11.3 — Sensitive-path write deny

**Criterion:** F1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because sensitive-path protection prevents severe mistakes. **User impact:** credentials and shell config are safer. **Context/cost impact:** moderate indirect savings by preventing high-cost recovery events.
**Reference:** Hermes `agent/file_safety.py`

**Problem.** Without explicit denials, an agent error (or injection) could overwrite SSH keys, credentials, shell rcfiles.

**Approach.** Static deny list:
```
~/.ssh/*
~/.aws/credentials
~/.aws/config
~/.gnupg/*
~/.kube/config
~/.docker/config.json
~/.azure/*
~/.config/gh/*
~/.netrc
~/.pgpass
~/.bashrc
~/.zshrc
~/.profile
/etc/sudoers
/etc/sudoers.d/*
/etc/passwd
/etc/shadow
/etc/systemd/*
```

Apply in `write`, `edit`, `patch` extensions. Refuse with structured error.

**Files to touch.**
- `src/server/security/sensitive-paths.ts` (new)
- `write`/`edit`/`patch` extensions

**Acceptance criteria.**
- All listed paths refused on write.
- Glob patterns match correctly.
- Configurable additions per project.

**Test plan.**
- Try writing each path; expect error.

---

## Goal 11.4 — Env-controlled write root

**Criterion:** F1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because write-root confinement is valuable in hardened environments. **User impact:** safer CI/gateway deployments. **Context/cost impact:** moderate indirect savings by preventing out-of-scope writes and repairs.
**Reference:** Hermes `HERMES_WRITE_SAFE_ROOT`

**Problem.** In CI/sandbox/gateway-hardened environments, all writes should be confined to a subtree.

**Approach.** Env var `BOBBIT_WRITE_SAFE_ROOT`. When set, all `write`/`edit`/`patch` operations check the resolved path is within the root. Refuse otherwise.

**Files to touch.**
- `src/server/security/sensitive-paths.ts`
- `write`/`edit`/`patch` extensions

**Acceptance criteria.**
- Set var → writes outside subtree refused.
- Unset → no behaviour change.
- Symlink escape blocked (resolve real path).

**Test plan.**
- Set var to `/tmp/sandbox`; attempt write to `/etc/passwd` → refused.
- Symlink in `/tmp/sandbox` pointing to `/etc/passwd` → refused.

---

## Goal 11.5 — Streaming context-fence scrubber

**Criterion:** F2
**Effort:** S · **Impact:** ⭐
**Impact rationale:** ⭐ because streaming tag leaks are edge cases but confusing. **User impact:** cleaner output and fewer internal details exposed. **Context/cost impact:** low direct impact.

**Problem.** When emitting deltas, internal fence tags (`<memory>...</memory>`, `<context>...</context>`) can leak into user-visible output if a delta boundary splits a tag.

**Approach.** Streaming scrubber that buffers across boundaries until a complete tag is parsed; strip the entire tagged region before emitting.

**Files to touch.**
- `src/server/agent/streaming.ts` (or equivalent)

**Acceptance criteria.**
- No internal tags appear in final user output.
- Streaming latency overhead < 5 %.

**Test plan.**
- Synthetic stream with a tag split across 3 deltas; assert clean output.

---

# Priority 12: Sandbox / Isolation Backends

## Goal 12.1 — Backend abstraction

**Criterion:** D4 Sandbox/isolation backends
**Effort:** L · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because an execution abstraction enables future sandboxing. **User impact:** shell behavior becomes more portable. **Context/cost impact:** low direct token impact; indirect cost/safety benefits through better isolation.
**Reference:** Hermes `tools/terminal_tool.py` (7 backends)

**Problem.** All shell execution is `local` only. Sandbox/cloud execution requires a clean abstraction.

**Approach.** Define `Environment` interface and refactor existing shell extension to route through it.

**Interface sketch.**
```ts
interface Environment {
  readonly kind: 'local' | 'docker' | 'ssh' | 'modal' | 'daytona' | 'vercel';
  cwd(): Promise<string>;
  env(): Promise<Record<string, string>>;
  exec(command: string, opts: ExecOpts): Promise<ExecResult>;
  background(command: string, opts: BackgroundOpts): Promise<{ id: string }>;
  kill(id: string): Promise<void>;
  logs(id: string, tail?: number): Promise<string>;
}
```

**Files to touch.**
- `src/server/exec/environment.ts` (new)
- `src/server/exec/local.ts` (new — wraps current shell behaviour)
- `.bobbit/config/tools/shell/extension.ts` — route through `Environment`

**Acceptance criteria.**
- All shell flows route through `Environment`.
- No behaviour change vs current local execution.

**Test plan.**
- Existing shell tests pass unchanged.

---

## Goal 12.2 — Docker backend

**Criterion:** D4
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because Docker is the most practical sandbox backend. **User impact:** safer execution for untrusted repos and reproducible environments. **Context/cost impact:** low direct token impact, moderate indirect savings from fewer environment-specific failures.

**Problem.** Sometimes shell needs to run in a clean Docker container (CI, untrusted code).

**Approach.** Implement `DockerEnvironment` using `docker run` (or persistent container per session). Image set via `BOBBIT_DOCKER_IMAGE`; mount cwd; preserve env-var allow-list.

**Files to touch.**
- `src/server/exec/docker.ts` (new)
- Session config: `exec_backend: 'local' | 'docker' | …`

**Acceptance criteria.**
- `mode: sandbox` runs all shell in Docker.
- File writes inside container materialise on host (mount).
- Container teardown on session end.

**Test plan.**
- Docker available test env; smoke test `ls`, `pip install`, `pytest`.

---

## Goal 12.3 — SSH backend

**Criterion:** D4
**Effort:** M · **Impact:** ⭐
**Impact rationale:** ⭐ because SSH is useful but narrower than Docker. **User impact:** remote development workflows become possible. **Context/cost impact:** low direct token impact; mainly execution flexibility.

**Problem.** Some users want to run agent commands on a remote host.

**Approach.** Implement `SSHEnvironment` over `ssh user@host` with key auth. Configurable via env vars: `BOBBIT_SSH_HOST`, `BOBBIT_SSH_USER`, `BOBBIT_SSH_KEY`.

**Files to touch.**
- `src/server/exec/ssh.ts` (new)

**Acceptance criteria.**
- Configurable; connection-pool reused.
- Same shell-tool UX.

**Test plan.**
- Mock SSH server; smoke test.

---

## Goal 12.4 — Vercel/Modal/Daytona backends

**Criterion:** D4
**Effort:** XL · **Impact:** ⭐
**Impact rationale:** ⭐ because cloud backends are powerful but optional and high effort. **User impact:** serverless/managed execution becomes possible for specialized users. **Context/cost impact:** low direct LLM-context impact; may reduce infra setup friction but not prompt size.

**Problem.** Docker and SSH cover many local/remote workflows, but they do not cover serverless or managed sandbox execution. Hermes supports multiple cloud/sandbox backends; Bobbit can reach parity gradually by treating each cloud backend as a plugin implementing the `Environment` interface from Goal 12.1.

**Approach.** Implement cloud execution backends as optional plugins, not hard dependencies:

- `exec-modal`: start/resume a Modal sandbox, run commands, stream logs, persist workspace where supported.
- `exec-daytona`: create/resume Daytona workspace, run commands through its API, surface workspace URL/artifacts.
- `exec-vercel`: create Vercel Sandbox session, run command with runtime constraints, persist files through supported filesystem API.

Each backend must implement the same `Environment` interface:
- `exec(command, opts)`
- `background(command, opts)`
- `logs(id, tail)`
- `kill(id)`
- `cwd()`
- `shutdown()`

Configuration should be per session:
```yaml
execution:
  backend: modal | daytona | vercel
  image: node:22
  cpu: 2
  memory_mb: 4096
  persistent: true
```

Backends should be disabled unless credentials are configured. If credentials are missing, tool availability should clearly explain setup steps instead of failing at command time.

**Files to touch.**
- `plugins/exec-modal/`
- `plugins/exec-daytona/`
- `plugins/exec-vercel/`
- `src/server/exec/environment.ts`
- `src/server/exec/registry.ts` — backend discovery/registration.
- Session config schema and UI backend selector.

**Acceptance criteria.**
- Each backend implements the full interface.
- Configurable selection per session.
- Missing credentials disable the backend cleanly with a setup hint.
- Background process logs can be polled through the same UI as local/Docker.
- A cloud-backend failure does not crash the Bobbit server; it returns structured error.

**Test plan.**
- Unit tests using mocked provider SDK clients for each backend.
- CI smoke tests behind credentials: `echo`, `pwd`, `write file`, `read file`, `background sleep`.
- Manual test: run `npm test` in each backend on a small fixture project.
- Credential-missing test: backend appears unavailable with actionable setup message.

---

# Priority 13: Verification Support

## Goal 13.1 — Auto-syntax check on patch

**Criterion:** C5 · D3
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because immediate syntax feedback reduces repair loops. **User impact:** bad edits are caught at the source. **Context/cost impact:** moderate indirect savings by avoiding later test/debug turns.

**Problem.** Bobbit can apply an edit that introduces a syntax error, then only discover the issue several turns later when the agent happens to run tests. This wastes context and creates avoidable repair loops. Syntax feedback should be attached directly to the edit result.

**Approach.** After any successful `edit`, `write`, or `patch`, run a fast syntax check for modified files with known extensions. This is the same implementation as Goal 5.9, but it is listed here as a verification deliverable because it should be tracked in the verification milestone too.

Checks:
- `.py`: `python -m py_compile <file>`
- `.js` / `.jsx`: `node --check <file>`
- `.ts` / `.tsx`: prefer project TypeScript checker if cheap; otherwise skip with reason `typescript_project_check_required`
- `.json`: parse JSON in-process
- `.yaml` / `.yml`: parse YAML with the same library Bobbit already uses
- `.go`: `go test`/`go vet` is project-level; for single file, run `gofmt -w?` only in dry-run/check mode or skip with reason
- `.rs`: `rustfmt --check <file>` if available

Return shape:
```json
{
  "edit_ok": true,
  "syntax": [
    {
      "path": "src/foo.ts",
      "status": "ok | failed | skipped",
      "command": "node --check src/foo.js",
      "summary": "Unexpected token at line 12",
      "details_path": ".bobbit/state/tool-results/..."
    }
  ]
}
```

Syntax checks must be best-effort and bounded. They should never hang the edit tool indefinitely. Use a short timeout (default 30 s) and persist long outputs through Goal 6.1.

**Files to touch.**
- `src/server/agent/syntax-check.ts` (new)
- `.bobbit/config/tools/edit/extension.ts`
- `.bobbit/config/tools/write/extension.ts`
- `.bobbit/config/tools/patch/extension.ts`
- Tool-result persistence from Goal 6.1 for long check output.

**Acceptance criteria.**
- Edit results include a `syntax` array for modified files.
- Supported valid files return `status: ok`.
- Supported invalid files return `status: failed` with concise first error.
- Unsupported files return `status: skipped` with a reason.
- Syntax check timeout returns `status: skipped` or `failed` with `reason: timeout`, not a hanging tool call.

**Test plan.**
- Patch valid Python file; expect `ok`.
- Patch invalid Python file; expect `failed` with line number.
- Patch JSON with malformed trailing comma; expect `failed`.
- Patch unsupported `.md`; expect `skipped`.
- Simulate long checker; expect timeout handling and no server hang.

---

## Goal 13.2 — `verify` tool

**Criterion:** D3
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because verification is frequently skipped or inconsistent. **User impact:** agents can run the right checks without guessing. **Context/cost impact:** moderate savings from fewer failed/irrelevant commands and more structured results.

**Problem.** "Did the change work?" today requires the agent to remember a project's check command. Often forgotten.

**Approach.** A `verify` tool detects project type and runs the project's standard check command:
- `package.json` with `scripts.typecheck` → `pnpm typecheck` (or `npm run typecheck`)
- `package.json` with `scripts.test` → `pnpm test`
- `pyproject.toml` → `ruff check . && pytest -q`
- `Cargo.toml` → `cargo check`
- `go.mod` → `go vet ./... && go test ./...`

Each check returns structured `{name, ok, durationMs, summary, details_path?}`.

**Files to touch.**
- `.bobbit/config/tools/verify/extension.ts` (new)

**Acceptance criteria.**
- Detects project type from manifest files.
- Runs the right command.
- Returns structured results.
- Config override per project.

**Test plan.**
- Each project type fixture; assert correct command runs.

---

## Goal 13.3 — Test-output structuring

**Criterion:** D3
**Effort:** S · **Impact:** ⭐
**Impact rationale:** ⭐ because it compresses test output but depends on Goal 13.2/6.1 for full value. **User impact:** failing tests are easier to understand. **Context/cost impact:** low-to-moderate direct savings by reducing raw test logs.

**Problem.** Test runners output thousands of lines; the model wades through irrelevant detail.

**Approach.** Recognise common runners (jest, vitest, pytest, go test) by output shape; extract pass/fail counts and failing test names. Return structured data with raw output persisted via Goal 6.1.

**Files to touch.**
- `src/server/agent/test-parsers.ts` (new)
- `verify` and `bash` post-processors

**Acceptance criteria.**
- Per-runner parsers cover the common cases.
- Structured output 5–10× smaller than raw.

**Test plan.**
- Fixture for each runner; assert correct extraction.

---

# Priority 14: Keep Bobbit's Orchestration Advantage

## Goal 14.1 — Keep managed goal mode intact

**Criterion:** E3
**Effort:** S · **Impact:** ⭐⭐⭐
**Impact rationale:** ⭐⭐⭐ because preserving Bobbit's core managed workflow is strategically important. **User impact:** users get lean mode without losing existing goal/team behavior. **Context/cost impact:** indirect; it prevents regressions rather than reducing tokens.

**Problem.** Many roadmap items intentionally remove prompt/tool/process overhead from lean mode. If those changes accidentally affect managed mode, Bobbit could lose its core advantage: goal/gate/team orchestration. Managed mode must be treated as a protected compatibility surface.

**Approach.** Create an explicit managed-mode regression gate. Every PR that touches prompt assembly, tool filtering, roles, delegation, gates, memory, or workflow context must prove managed mode still behaves as before.

Add a regression checklist:
- Goal creation still creates expected workflow state.
- `team-lead` can inspect gates and spawn role agents.
- Role agents get their managed role prompt, not lean prompt.
- Gate dependency injection still works.
- Worktree branch naming still works.
- Delegate/team sessions still report back to team lead.
- Managed-mode prompts still include required gate/team/git guidance.
- Lean-mode exclusions do not leak into managed sessions.

Where possible, convert checklist items into automated tests. For items that require UI or external services, keep manual smoke tests documented.

**Files to touch.**
- CI configuration.
- Existing managed-mode test suite.
- `tests/managed-mode/` (new) with fixture goal/workflow.
- `.github/workflows/ci.yml` or equivalent.

**Acceptance criteria.**
- Managed-mode regression suite runs in CI on every PR.
- Failure blocks merge.
- Each lean-mode prompt/tool change includes at least one managed-mode snapshot test.
- Managed prompt snapshots are intentionally updated only when the PR states why.

**Test plan.**
- Automated fixture: create a managed goal with design-doc gate, reviewer gate, coder role, and team lead.
- Assert managed session tool list contains workflow/team/gate tools.
- Assert managed prompt contains gate/team guidance that lean prompt omits.
- Assert lean prompt/tool changes do not alter managed snapshots.

---

## Goal 14.2 — Summarise gate context by default

**Criterion:** E3 · A1
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because full gate context can become large in managed mode. **User impact:** agents see the current workflow state without drowning in artifacts. **Context/cost impact:** moderate direct savings by injecting summaries instead of full gate data.

**Problem.** Managed mode injects full gate state (sometimes 10+ KB of past gate artifacts). Most of it is irrelevant on a given turn.

**Approach.** Inject a summary by default (gate IDs, current statuses, last action timestamp). Provide `gate_status(id, full=true)` for full retrieval.

**Files to touch.**
- `src/server/agent/system-prompt.ts` — workflow context section
- `.bobbit/config/tools/gates/*` — extend `gate_status` schema

**Acceptance criteria.**
- Default workflow context section ≤ 4 KB.
- Full details retrievable on demand.

**Test plan.**
- Compare prompt sizes before and after on a managed session with active gates.

---

## Goal 14.3 — Workflow-context budget

**Criterion:** A1 · E3
**Effort:** S · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because workflow state can grow with large goals. **User impact:** large goals stay manageable. **Context/cost impact:** moderate direct savings via a hard workflow-context cap.

**Problem.** Workflow state can balloon when goals have many tasks/dependencies.

**Approach.** Hard cap on injected workflow state (default 4 KB). When over cap, inject summary + IDs; provide `goal_detail`, `task_detail`, `workflow_state` tools for retrieval.

**Files to touch.**
- `src/server/agent/system-prompt.ts`

**Acceptance criteria.**
- Workflow context section never exceeds budget.
- Retrieval tools work.

**Test plan.**
- Goal with 50 tasks; assert summary, IDs in prompt; full state retrievable.

---

## Goal 14.4 — Make team lead less eager

**Criterion:** E3
**Effort:** S · **Impact:** ⭐
**Impact rationale:** ⭐ because it trims over-delegation but does not change core tools. **User impact:** fewer unnecessary subagents and less workflow noise. **Context/cost impact:** low-to-moderate savings by reducing needless spawned sessions.

**Problem.** Team-lead role currently encourages aggressive spawning of sub-agents.

**Approach.** Add a `planner` mode for team lead: think first, spawn only when necessary. Spawn threshold configurable.

**Files to touch.**
- `.bobbit/config/roles/team-lead.yaml`

**Acceptance criteria.**
- Default behaviour produces fewer agents per goal.
- Aggressive mode still available via flag.

**Test plan.**
- Compare agent count on a fixed goal under planner vs aggressive.

---

## Goal 14.5 — Memory ranking for managed mode

**Criterion:** E4 · A1
**Effort:** M · **Impact:** ⭐⭐
**Impact rationale:** ⭐⭐ because memory relevance matters for managed sessions. **User impact:** agents get useful memory instead of arbitrary memory blobs. **Context/cost impact:** moderate direct savings by bounding/ranking memory injection.
**Reference:** Claude Code `findRelevantMemories.ts`

**Problem.** All qualifying memory files are concatenated up to the 16 KB cap, regardless of relevance.

**Approach.** Score each memory file by:
- Keyword overlap with current task spec / role / cwd basename.
- Recency (`memoryAge`).
- Type weighting (`feedback` > `project` > `user`).

Inject top-N within budget. Provide `memory_search(query)` for on-demand retrieval.

**Files to touch.**
- `src/server/agent/memory-ranker.ts` (new)
- `src/server/agent/system-prompt.ts`
- `.bobbit/config/tools/memory/extension.ts`

**Acceptance criteria.**
- Memory injection bounded and ranked.
- Retrieval tool reaches all memories.
- Single-active external memory provider rule (Hermes-style) enforced if more than one is configured.

**Test plan.**
- Synthetic memory set + task spec; verify top-N relevance.

---

# Suggested Delivery Plan

## Milestone 1 — Observability & Lean Mode (≈ 2–3 weeks)

Goals: 0.1, 0.2, 0.3, 0.4, 0.5, 1.1, 1.2, 1.3, 1.4, 1.6.

Expected impact: immediate, measurable reduction in baseline context. Establishes dashboards needed to validate later milestones.

## Milestone 2 — Tool Doc & Search/Read Efficiency (≈ 3 weeks)

Goals: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6.

Expected impact: 30–50 % reduction in tool-doc share of system prompt; loop-spinning agents stopped.

## Milestone 3 — Edit Safety (≈ 2–3 weeks)

Goals: 5.1, 5.2, 5.3, 5.6, 5.7, 5.8, 7.1, 7.2, 7.3, 7.4.

Expected impact: fewer bad edits; safe parallel delegation.

## Milestone 4 — Context Survival (≈ 2 weeks)

Goals: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 10.1, 10.2, 10.3, 10.4.

Expected impact: long sessions self-recover; per-session token cost drops sharply on repeat work in the same project.

## Milestone 5 — Semantic Navigation (≈ 3–4 weeks)

Goals: 4.1, 4.2, 4.3, 4.4, 4.5, 1.5.

Expected impact: large drop in broad scans on TS/Python projects.

## Milestone 6 — Multi-File Patches & Verification (≈ 2–3 weeks)

Goals: 5.4, 5.5, 5.9, 13.1, 13.2, 13.3.

Expected impact: cross-file refactors land in single tool calls with verification.

## Milestone 7 — Plan Mode & Delegation Refinement (≈ 2–3 weeks)

Goals: 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6.

Expected impact: safer exploration; cheaper, structured delegation.

## Milestone 8 — Safety Hardening (≈ 2 weeks)

Goals: 11.1, 11.2, 11.3, 11.4, 11.5, 3.7.

Expected impact: protection against context-file injection and credential leakage.

## Milestone 9 — Sandbox Breadth (≈ 4–6 weeks, optional)

Goals: 12.1, 12.2, 12.3, 12.4, 14.2, 14.3, 14.4, 14.5.

Expected impact: production-grade sandbox parity with Hermes; managed-mode discipline.

---

# Proposed Target Scores After Improvements

Targets calibrated assuming all priorities 0–11 land. Priority 12 is optional and would push D4 higher.

| Group / Criterion | Current Bobbit | Target Bobbit | Notes |
|---|---:|---:|---|
| **A1 Baseline context efficiency** | 4 | 8 | Lean mode + tool-doc deferral + workflow-context budget. |
| **A2 Tool loading efficiency** | 5 | 8 | `tool_search`, mode-grouped toolsets, deferred schemas. |
| **A3 Prompt-cache strategy** | 3 | 8 | Stable-prefix split + provider-aware cache control. |
| **A4 Per-turn output budget** | 3 | 8 | Per-result + per-turn persistence; concise diffs. |
| **A5 Read deduplication** | 2 | 9 | Mtime-keyed dedup + loop guards + post-compaction reset. |
| **A6 Context compaction** | 3 | 8 | Auto-trigger + microcompact + failure cooldown. |
| **B1 File discovery** | 6 | 8 | Mtime-sorted find + truncation flags. |
| **B2 Code content search** | 6 | 8 | Modes, head_limit, offset, type/glob, context lines. |
| **B3 Code-flow discovery** | 3 | 8 | LSP tool surface. |
| **B4 Read behavior** | 5 | 9 | Dedup + device blocklist + binary guards. |
| **B5 Search/read loop guards** | 2 | 9 | Warn-at-3, block-at-4. |
| **C1 Edit behavior** | 5 | 8 | Read-before-edit + stale checks + replace_all + fuzzy fallback. |
| **C2 Multi-file / atomic patches** | 3 | 8 | V4A + sorted-lock. |
| **C3 Write/create behavior** | 6 | 8 | Read-back + line-ending preservation. |
| **C4 Concurrency safety** | 5 | 8 | File-state registry + per-path locks + sibling warnings. |
| **C5 Post-edit verification** | 4 | 8 | Auto syntax check + byte-compare. |
| **D1 Shell/process** | 7 | 8 | Head+tail truncation, output structuring. |
| **D2 Background process supervision** | 7 | 8 | Already strong; minor polish. |
| **D3 Verification support** | 6 | 8 | `verify` tool, structured test output. |
| **D4 Sandbox/isolation backends** | 4 | 6 | Local + Docker (Priority 12 optional for further gain). |
| **D5 Approval/danger gates** | 5 | 8 | Subagent auto-deny + sensitive-path deny + context-injection scan. |
| **E1 Delegation/subagents** | 7 | 9 | Lightweight + context-fork + structured results. |
| **E2 Plan / read-only mode** | 2 | 8 | First-class plan mode. |
| **E3 Workflow governance** | 9 | 9 | Preserved with budget caps. |
| **E4 Memory/skills discipline** | 4 | 7 | Memory ranking + skill-loading discipline. |
| **E5 Failure recovery** | 4 | 8 | Compaction failure cooldown + circuit breaker. |
| **F1 Safety/security posture** | 5 | 8 | Sensitive-path deny + write root + redaction. |
| **F2 Prompt-injection defense** | 2 | 8 | 13-pattern context-file scan + frontmatter strip. |
| **F3 Configurability/extensibility** | 9 | 9 | Preserved. |
| **F4 Provider abstraction** | 4 | 5 | Mostly inherited from underlying agent. |
| **F5 Observability** | 6 | 8 | Section budgets + cache-hit metrics. |
| **G1 Product fit for everyday coding** | 5 | 8 | Lean mode aligned with everyday work. |
| **G2 First-time-user friction** | 6 | 8 | Sensible lean defaults. |
| **Aggregate mean** | **4.7** | **7.9** | Closes most of the gap to Claude Code (7.7) and Hermes (7.6). |

---

# Success Metrics

Concrete, measurable outcomes once the plan is delivered.

### Context economics

- Median lean-mode system prompt is **< 50 %** of current coder-session prompt size.
- Tool-doc section share of system prompt is **< 25 %** in lean mode.
- **≥ 60 %** of repeat sessions in the same project hit prompt cache for the stable prefix.
- Long sessions (> 30 turns) sustain mean tool-result-bytes-per-turn **< 200 KB** without manual `compact()`.

### Discovery efficiency

- Median refactor task in lean mode uses **< 4** broad grep calls (target down from current ~10–15).
- Repeated identical reads return stub on **2nd hit**; identical 4th hit blocked.
- LSP available + used on TS/Python repos for **≥ 70 %** of definition/reference lookups.

### Edit correctness

- **0** edits to externally modified files apply without warning.
- **≥ 95 %** of patches pass post-write byte-compare on first try.
- Auto syntax check catches **≥ 80 %** of syntax errors before the agent's next turn.

### Safety

- 13/13 prompt-injection patterns caught in test corpus.
- 0 successful writes to deny-listed paths in regression suite.
- Subagents default to auto-deny on destructive shell patterns.

### Workflow preservation

- Managed goal mode behaviour unchanged on existing test workflows.
- Single-file edits in lean mode receive **0** gate/team/workflow instructions.
- Memory injected only when relevance score above threshold or explicitly invoked.

---

# Out of Scope (Deliberately)

- **Replacing pi-coding-agent.** Bobbit's role is the wrapper. The improvements above all live at the wrapper layer.
- **Building a new model.** All targets are achievable with current frontier models.
- **Matching Hermes's full breadth** (browser, voice, RL, datagen, cron, gateway messaging). Bobbit's scope is narrower; only the coding-relevant subsets are imported.
- **Matching Claude Code's UX-level features** (slash commands, output styles, status line, IDE plugins). These are independent products. The harness improvements above are about the agent loop, not the chrome.
- **Eliminating managed-mode ceremony.** It is a feature for managed projects. Lean mode is added next to it; it is not a replacement.

---

# Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Lean mode causes regressions in managed workflows | Keep managed mode as default for goal-bound sessions; add explicit `mode` flag; test matrix on existing managed flows. |
| LSP server processes leak / hang | Health-check, timeouts, restart-on-crash, fallback to grep on failure. |
| Auto-compaction at wrong moment loses active context | Protect last N messages; failure cooldown; user-overridable threshold. |
| File-state registry adds latency | Per-path locks only on write/edit; reads stay lock-free unless about to be overwritten. |
| Prompt-injection false positives strip useful content | Warn rather than strip on borderline patterns; provide override via env var or session flag. |
| Context-fork delegate exposes secrets to children | Apply same redaction to forked context; deny secret paths in fork. |
| Provider-cache hints on a non-supporting provider | No-op fallback; detect provider before emitting hints. |

---

# Appendix: Mapping to Reference Implementations

| Bobbit Goal | Claude Code Reference | Hermes Reference |
|---|---|---|
| 1.1–1.6 Lean mode | Default mode = lean | n/a (always-on platform) |
| 2.1–2.5 Lazy tool docs | `src/tools/ToolSearchTool/`, `shouldDefer: true` | Toolset filtering (`toolsets.py`) |
| 3.1 Read dedup | `src/tools/FileReadTool/FileReadTool.ts` (file-state cache) | `tools/file_tools.py:485–596` |
| 3.2 Loop guards | n/a | `tools/file_tools.py:633–644` (warn @ 3, block @ 4) |
| 3.4 Grep upgrade | `src/tools/GrepTool/GrepTool.ts` (`head_limit=250`) | `tools/file_tools.py:943–1010` |
| 3.6 Device blocklist | `src/tools/FileReadTool/` | `tools/file_tools.py:69–78` |
| 3.7 Secret redaction | n/a | `agent/redact.py` |
| 4.* LSP | `src/tools/LSPTool/LSPTool.ts` | n/a |
| 5.1 Read-before-edit | `src/tools/FileEditTool/FileEditTool.ts` (`FILE_UNEXPECTEDLY_MODIFIED_ERROR`) | `tools/file_state.py` (`check_stale`) |
| 5.4 V4A patch | n/a | `tools/file_tools.py:847–940` |
| 5.8 Byte-compare | n/a | `tools/file_operations.py:798–806` |
| 5.9 Auto syntax check | n/a | `tools/file_operations.py:261–267` |
| 6.1 Per-result persist | n/a | `tools/tool_result_storage.py:116–172` |
| 6.2 Per-turn budget | n/a | `tools/tool_result_storage.py:175–226` (`MAX_TURN_BUDGET_CHARS=200_000`) |
| 6.3 Microcompact | `src/services/compact/microCompact.ts` | `agent/context_compressor.py` |
| 6.4 Auto-compaction | `src/services/compact/autoCompact.ts` (`AUTOCOMPACT_BUFFER_TOKENS=13K`) | `agent/context_compressor.py` (75 % threshold) |
| 6.5 Failure cooldown | `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` | `agent/context_compressor.py:74` (600 s) |
| 7.* File-state registry | File-state cache | `tools/file_state.py` (full reference impl) |
| 8.* Plan mode | `src/tools/EnterPlanModeTool/`, dynamic permission classifier | n/a |
| 9.2 Context fork | `src/tools/AgentTool/forkSubagent.ts` (byte-exact prompt sharing) | n/a |
| 9.5/9.6 Delegate restrictions | `subagent_type` toolset selection | `tools/delegate_tool.py` (`DELEGATE_BLOCKED_TOOLS`, auto-deny) |
| 10.* Cache strategy | Cache-friendly assembly, fork prompt sharing | `agent/prompt_caching.py` (`system_and_3`, 5 min/1 h TTL) |
| 11.* Injection scan | Limited | `agent/prompt_builder.py:36–73` (13 patterns), `agent/file_safety.py` |
| 12.* Backends | Local + worktree | `tools/terminal_tool.py` (7 backends) |
| 14.5 Memory ranking | `src/memdir/findRelevantMemories.ts`, `memoryAge.ts` | Single-active-provider rule (`agent/memory_manager.py`) |
