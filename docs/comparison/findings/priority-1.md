# Priority 1 — Lean Coding Mode

Source pins: Bobbit `master @ a3a9cc7` (per `audits/bobbit.md`); Claude Code and Hermes paths as in `audits/claude-code.md`, `audits/hermes.md`.

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 1.1 | Add `mode: 'lean' \| 'managed'` flag — Bobbit has only one heavy posture today | **real** | high |
| 1.2 | Split `coder.yaml` (~1.5 KB, managed-heavy) into `coder-lean` / `coder-managed` | **real** | high |
| 1.3 | Make gate tools/instructions opt-in (currently unconditional in coder role + prompts) | **real** | high |
| 1.4 | Drop mandatory memory search/save protocol in lean sessions | **real** | high |
| 1.5 | Auto-detect lean candidacy from goal/team/workflow context | **real** | high |
| 1.6 | UI mode badge with one-click toggle (no mode UX exists today) | **real** | medium |

All six goals describe genuine, non-existent functionality in audited Bobbit master. None are hallucinated or already-done. Verdicts are "real"; the cross-harness "reference impl" is loose because lean/managed is a Bobbit-specific concept — Claude Code's plan-mode and per-subagent-type built-ins are the closest analogue, Hermes's per-delegation-role tool gating is a weaker analogue.

---

## Goal 1.1 — `mode: coding` vs `mode: managed`

**Doc claim.** Every Bobbit session ships full managed-mode machinery. Add a `mode` flag at session creation that branches prompt assembly, tool selection, and gate activation.

**Bobbit reality.** No mode concept exists. Audit confirms: there is no `SessionMode` type, no `mode: 'lean'|'managed'`, no branching in `system-prompt.ts` or `tool-manager.ts`.
- `audits/bobbit.md` "## Context › System prompt assembly" (lines describing `assembleSystemPrompt` 154-217) — single unconditional pipeline.
- `src/server/agent/system-prompt.ts:154-217` — `PromptParts` interface and `assembleSystemPrompt()` have no mode field; sections (memory hint, goal/role merge, tool docs, task, workflow context) are appended whenever each input is present, never gated by mode.
- `src/server/agent/tool-manager.ts:175-237` — `getToolDocsForPrompt()` filters only by `allowedTools`, not by mode.
- Direct grep confirmation: `grep -rn "SessionMode\|'lean'\|\"lean\"\|mode: 'managed'" src/` returns no Bobbit-defined enum/type — all hits are unrelated (`saveSessionModel`, `prefSessionModel`, etc., which are *model* selectors, not mode flags).

**Claude Code reality.** Has a first-class `permissionContext.mode` ("default"/"plan"/"bypass"), plus per-`subagent_type` built-in agents (`Explore`, `Plan`, `general-purpose`) selected via `Agent` tool's `subagent_type` parameter — both functionally similar to the proposed lean/managed split.
- `audits/claude-code.md:128-134, 267-269` — Plan mode is a first-class state with `prePlanMode` saved for restoration.
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36, 91` (per audit) — switches `toolPermissionContext.mode` to `'plan'` via `applyPermissionUpdate`.
- `src/tools/AgentTool/AgentTool.tsx:50, 1356` — uses `ONE_SHOT_BUILTIN_AGENT_TYPES` to gate behaviour per agent type.

**Hermes reality.** No first-class plan/lean mode toggle on the main agent (`audits/hermes.md:253-256, 300`). Closest analogue is `delegation.role="leaf"`'s blocked-tool list (`tools/delegate_tool.py:38-46`), which restricts subagents only.

**Verdict.** **real.**

**Reasoning.** The Bobbit gap is unambiguous: no mode flag, no branching in either of the two files the doc names (`system-prompt.ts`, `tool-manager.ts`). The proposed feature has direct precedent in CC's plan-mode and per-subagent-type machinery; Hermes lacks a comparable runtime mode but the CC reference is sufficient.

**Minimal proof of gap.**

Bobbit (`src/server/agent/system-prompt.ts:154-186`) — `PromptParts` has no mode field; pipeline is monolithic:
```ts
export interface PromptParts {
    baseSystemPromptPath?: string;
    cwd: string;
    goalTitle?: string;
    goalSpec?: string;
    rolePrompt?: string;
    /* ... no `mode` ... */
    workflowContext?: string;
}
```

Claude Code (`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36, 91` per `audits/claude-code.md:131`):
```
EnterPlanMode tool switches toolPermissionContext.mode to 'plan' via applyPermissionUpdate.
tool_result instructs the model to explore-only, no edits.
src/types/permissions.ts: 'default | plan | bypass | ...' — plan mode is a first-class state.
```

---

## Goal 1.2 — `coder-lean.yaml` role

**Doc claim.** `coder.yaml` is ~1.5 KB and pushes gates, design docs, branches, commits, pushes, memory, previews, delegation. Split into a lean variant ≤ 4 KB rendered without those reminders.

**Bobbit reality.** Single role file, exactly as described. `/Users/aj/Documents/dev/bobbit/.bobbit/config/roles/coder.yaml` is 115 lines / ~5 KB on disk; no `coder-lean.yaml`, no `coder-managed.yaml`. The `promptTemplate:` block embeds gate, design-doc, sub-branch, commit, merge, push, expect-failure-gate, and team-coordination instructions — all managed-mode scaffolding.
- `roles/` directory listing: `assistant assistant.yaml coder.yaml docs-writer.yaml general.yaml reviewer.yaml team-lead.yaml test-engineer.yaml ux-designer.yaml` — single coder, no lean variant.
- `coder.yaml:6-12` (allowedTools) lists `gate_list`, `gate_status`, `task_list`, `task_update` unconditionally.
- `coder.yaml:43-86` (promptTemplate) walks through "gate_list() → gate_status(gate_id='design-doc')", sub-branch git workflow, "Always check gates before coding", "Command-Format Gates (e.g. reproducing-test)", "Expect-Failure Gates" — all managed-mode concerns.

**Claude Code reality.** Roles are encoded as **subagent_type** built-ins, not as a YAML cascade. Each is a different prompt/toolset preset.
- `audits/claude-code.md:101` — `Explore`, `Plan` are one-shot built-in types in `ONE_SHOT_BUILTIN_AGENT_TYPES` (`constants.ts:9`); `general-purpose` lives at `built-in/generalPurposeAgent.ts`.
- `src/tools/AgentTool/AgentTool.tsx:49-50` (verified) — imports `GENERAL_PURPOSE_AGENT` and `ONE_SHOT_BUILTIN_AGENT_TYPES`.

**Hermes reality.** No directly analogous role split. `prompt_builder.py:134-142` ships a single default identity; tool-surface narrowing happens via `delegation.role="leaf"` blocked tools (`audits/hermes.md:215`), not by switching role files.

**Verdict.** **real.**

**Reasoning.** The cited file exists at the cited size with the cited managed-mode content; no lean variant exists. CC's per-subagent-type prompt presets are the closest reference for "different role-prompt for different intent." Effort is genuinely small (S) as claimed — it's a YAML split.

**Minimal proof of gap.**

Bobbit (`/Users/aj/Documents/dev/bobbit/.bobbit/config/roles/coder.yaml:43-86`):
```yaml
promptTemplate: |
  ## Tools
  - **gate_list** — List all workflow gates with their status. Use this to find the design doc and other upstream context.
  - **gate_status** — Get a gate's full detail including content. Read the design doc gate to understand what to build.
  - **task_list** — List all tasks. Check your assigned task for details.
  - **task_update** — Update your task's state or add results. Use this to mark your task complete.
  **Always check gates before coding.** Run `gate_list()` then `gate_status(gate_id="design-doc")` ...
  ## Git Workflow
  1. `git checkout {{GOAL_BRANCH}} && git pull` ...
  2. Create a sub-branch: `git checkout -b {{GOAL_BRANCH}}/task-<name>` ...
```

Claude Code (`src/tools/AgentTool/AgentTool.tsx:49-50`, per audit):
```ts
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';
// Built-in agent types: Explore, Plan (one-shot), general-purpose, verification.
```

---

## Goal 1.3 — Make gates opt-in for small tasks

**Doc claim.** Gate tools (`gate_list`, `gate_status`) and gate prompt instructions appear in every session even when no goal/workflow is active. Make exposure conditional on goal context, explicit user request, or non-lean mode.

**Bobbit reality.** Confirmed unconditional. Gate exposure is governed only by per-role `allowedTools`; there is no goal-context check anywhere in `tool-manager.ts`. The default coder role lists them. There is no `requires: ['workflow-context']` mechanism.
- `coder.yaml:9-10` — `gate_list`, `gate_status` in `allowedTools` unconditionally.
- `tool-manager.ts:175-237` — filters by `allowedTools` only; no `goalId`/`workflowId` predicate (`grep -n "gate_\|task_\|workflow\|goalId\|active.*goal" src/server/agent/tool-manager.ts` returns nothing).
- `audits/bobbit.md` "Tasks/Gates family" — confirms `gate_list`/`gate_status`/`gate_signal` registered as plain pi-tools with no context gate.

**Claude Code reality.** No "gates" concept (CC has no workflow gates). The closest pattern of *conditional* tool exposure is **deferred tools via `ToolSearchTool`** — heavy tools are not in the prompt until the model searches.
- `audits/claude-code.md:221` — "Deferred tools require a `ToolSearchTool` round-trip first; the tool returns `tool_reference` blocks naming tools to load (`ToolSearchTool.ts:481-492`). Auto-trigger char threshold per model: `getAutoToolSearchCharThreshold` (`src/utils/toolSearch.ts:115`)."

**Hermes reality.** No gates either. Per-role tool gating happens at delegation time only (`tools/delegate_tool.py:38-46`, blocked-tool list — `audits/hermes.md:215`).

**Verdict.** **real.**

**Reasoning.** Bobbit ships gate tools and instructions to every session whether or not a goal is active. The doc's proposal — gate `requires: ['workflow-context']` plus mode-aware prompt — has no equivalent today. Reference for "conditional tool exposure based on context" is CC's deferred/searchable tools.

**Minimal proof of gap.**

Bobbit (`.bobbit/config/roles/coder.yaml:6-12`):
```yaml
allowedTools:
  - read
  - write
  - edit
  - bash
  - web_search
  - web_fetch
  - gate_list      # <-- always exposed
  - gate_status    # <-- always exposed
  - task_list
  - task_update
```

Claude Code (`src/tools/ToolSearchTool/ToolSearchTool.ts:481-492` per audit):
```
Deferred tools require a ToolSearchTool round-trip first; the tool returns
an array of tool_reference blocks naming the tools to load.
Auto-trigger char threshold per model: getAutoToolSearchCharThreshold
(src/utils/toolSearch.ts:115).
```

---

## Goal 1.4 — Disable mandatory memory workflow in lean mode

**Doc claim.** The current prompt instructs the agent to search and save memory at session boundaries, and auto-loads Claude Code memories from `~/.claude/projects/.../memory/*.md`. This is wasted context for quick edits.

**Bobbit reality.** Both behaviours present and unconditional.
- Always-on memory protocol: `.bobbit/config/system-prompt.md:136-150` — prescribes a `curl` to `localhost:8765/api/v1/memories/filter` at task start and a `POST` save at task end, plus `mcp__graphiti__search_memory_facts` / `add_memory` calls.
- Always-on Claude Code memory injection: `src/server/agent/system-prompt.ts:106-153` (`readClaudeCodeMemories`), invoked unconditionally at `system-prompt.ts:230-233` ("`if (memories.trim()) sections.push(memories);`"). Capped at ~16 KB / 20 files but never suppressed.
- Always-on memory `group_id` hint: `system-prompt.ts:235-236` — pushed for every session.

**Claude Code reality.** Memory is structured and ranked, not a mandatory protocol injected into every prompt.
- `audits/claude-code.md` (`comparison.md:180`) → `src/memdir/memdir.ts:35-38`: `MEMORY.md` capped at 200 lines / 25 KB, type filter, semantic relevance via `findRelevantMemories.ts`, freshness via `memoryAge.ts`.

**Hermes reality.** Has a disciplined memory layer: one always-on `BuiltinMemoryProvider` plus at-most-one external provider, with structured `prefetch`/`sync_turn` lifecycle — explicitly designed to prevent tool-schema bloat.
- `audits/hermes.md` "Memory" section (and `comparison.md:213, 257`) → `agent/memory_manager.py` enforces "at most one external provider"; `system_prompt_block`/`prefetch`/`sync_turn` are structured hooks rather than a free-form curl protocol.

**Verdict.** **real.**

**Reasoning.** Memory protocol is hard-coded into the global system prompt and unconditional Claude Code memory injection runs in `assembleSystemPrompt`. There is no mode/feature flag to turn either off. CC and Hermes both expose discipline mechanisms (relevance ranking, single-external-provider) that are stronger than what the doc proposes (just dropping the section in lean mode); the gap proposed is real and small.

**Minimal proof of gap.**

Bobbit (`/Users/aj/Documents/dev/bobbit/.bobbit/config/system-prompt.md:136-150`):
```md
# Memory
You have access to memory tools that help you learn from past work and share knowledge across sessions.
- **At task start**: Search for relevant prior learnings via bash:
  `curl -s -X POST http://localhost:8765/api/v1/memories/filter ...`
- **At task completion**: If you discovered something non-obvious, save it via bash:
  `curl -s -X POST http://localhost:8765/api/v1/memories/ ...`
```

Bobbit (`src/server/agent/system-prompt.ts:230-236`) — unconditional injection:
```ts
const memories = readClaudeCodeMemories(parts.cwd);
if (memories.trim()) {
    sections.push(memories);
}
const projectName = path.basename(parts.cwd);
const memoryHint = `# Memory Context\n\nWhen using graphiti tools, pass \`group_id: '${projectName}'\` ...`;
sections.push(memoryHint);
```

Claude Code (`src/memdir/memdir.ts:35-38` per audit):
```
MEMORY.md entrypoint, 200 lines / 25 KB. Type filter user/feedback/project.
Semantic relevance via findRelevantMemories.ts; freshness via memoryAge.ts.
```

---

## Goal 1.5 — Auto-detect lean candidacy

**Doc claim.** Even with 1.1, users have to remember to choose lean mode. Default to lean if no goal, no team, no workflow; managed otherwise.

**Bobbit reality.** Depends on 1.1, which doesn't exist. Session creation today (`src/server/agent/session-manager.ts`, `session-store.ts`) carries no mode field at all — there is nothing for a default function to compute. `grep -rn "SessionMode\|'lean'" src/server` returns no matches relevant to mode selection (the hits are `saveSessionModel`/`prefSessionModel` which are *model* (LLM) selectors, not mode).

**Claude Code reality.** Plan-mode is a session-level state with first-class entry/exit and saved `prePlanMode` (`audits/claude-code.md:131-134, 267-269`). CC does not auto-detect plan-mode either, but the toggle infrastructure exists.

**Hermes reality.** No mode toggle, so no auto-detection.

**Verdict.** **real.**

**Reasoning.** This goal is strictly a follow-on from 1.1; since 1.1's substrate is absent, the auto-detect code has nothing to default. Effort/impact rationale (S/⭐⭐) is reasonable.

**Minimal proof of gap.** Same as 1.1 — no `mode` field exists in session creation/persistence (`src/server/agent/system-prompt.ts:154-186` `PromptParts`; no `mode` field; session-store/session-manager carry no `SessionMode`). Reference: CC `permissionSetup.ts:602-641` (per `audits/claude-code.md:302`) shows a real mode-transition substrate that an auto-default could attach to.

---

## Goal 1.6 — UI mode badge

**Doc claim.** Once modes exist, users need a `LEAN` / `MANAGED` badge in the session header with one-click toggle and "this session vs always for this project" choice.

**Bobbit reality.** Depends on 1.1, which doesn't exist. Searched `src/ui/` and `src/app/` — there is no `LEAN`/`MANAGED` badge component (no matching grep hits for any mode badge). Session header currently shows model selector and other state, not a mode indicator.

**Claude Code reality.** Plan-mode is surfaced in the UI: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:147` (per `audits/claude-code.md:134`) reads a plan file, shows it to the user for approval, and restores `prePlanMode`. The plan-mode state is visible and toggleable.

**Hermes reality.** TUI-driven; no analogous lean/managed badge.

**Verdict.** **real** (confidence: medium — this is a UX-only addition; "real" because the badge does not exist and the mode state to badge does not exist).

**Reasoning.** Cannot ship a mode badge without a mode. The CC analogue is the plan-mode UX (entering/exiting plan mode is a visible state).

**Minimal proof of gap.**

Bobbit — no mode badge component exists; `grep -rn "LEAN\b\|MANAGED\b\|sessionMode" src/ui src/app` returns no UI badge for session mode (only `prefSessionModel` / `saveSessionModel` in `src/app/routing.ts` and `src/app/settings-page.ts`, which are *model-name* persistence, not session-mode persistence).

Claude Code (`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:147` per `audits/claude-code.md:134`):
```
ExitPlanModeV2 reads a plan file, shows it to the user for approval,
restores prePlanMode. Strict requirement that the plan be in the configured
plans directory.
```

---

## Cross-cutting note

Priority 1 is internally consistent: all six goals describe greenfield Bobbit work. None are hallucinations; the cited files (`src/server/agent/system-prompt.ts`, `tool-manager.ts`, `.bobbit/config/roles/coder.yaml`, `.bobbit/config/system-prompt.md`) exist and contain the cited content. The reference-impl framing is loose because lean/managed is a Bobbit-specific overlay rather than a port — Claude Code's plan-mode and per-subagent-type built-ins are the closest analogue and are sufficient evidence that "session-level mode toggles" are a viable pattern.
