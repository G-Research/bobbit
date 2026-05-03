# Priority 14 — Keep Bobbit's Orchestration Advantage

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 14.1 | Managed-mode regression gate to protect orchestration when lean mode lands | partial | med |
| 14.2 | Summarise gate context by default; full body on demand | real | high |
| 14.3 | Hard cap (≈4 KB) on injected workflow state with retrieval tools | real | high |
| 14.4 | Team-lead role over-encourages aggressive sub-agent spawning | real | high |
| 14.5 | Memory injection unranked — concatenated up to 16 KB cap | real | high |

---

## Goal 14.1: Keep managed goal mode intact

- **Doc claim:** Lean-mode work risks regressing managed mode (goals/gates/team). Need an explicit managed-mode regression gate (CI tests + prompt snapshots) so every PR touching prompt assembly, tool filtering, roles, delegation, gates, memory, or workflow context proves managed mode is unaffected.
- **Bobbit reality:** No `tests/managed-mode/` directory exists (`ls tests/` confirms). Tests like `tests/system-prompt.test.ts` and `tests/team-manager.test.ts` cover bits of the surface, but there is no consolidated managed-mode regression suite, no managed-prompt snapshot fixture, and no CI hook that gates lean-mode PRs against managed-mode behaviour. There is also no "lean mode" today (no `lean` / `LEAN` toggle anywhere in `src/`, `defaults/`, `.bobbit/config/` — confirmed by grep), so the protection target does not yet exist.
- **Claude Code reality:** Not directly comparable — Claude Code has a single mode, not a managed/lean split. Reference value here is preventive process, not a feature port.
- **Hermes reality:** Same — Hermes has no managed/lean split. Confirmed by `audits/hermes.md` (no managed-mode section).
- **Verdict:** partial.
- **Reasoning:** The *gap* (no dedicated managed-mode regression suite) is real and verifiable. But the *motivation* depends on lean mode existing or being on the way. Today there is no lean mode in master, so the goal is preventive scaffolding rather than fixing a present-day defect. Worth scoping down: build the managed-mode snapshot fixture **only when the first lean-mode PR is queued**, not now.
- **Minimal proof of gap:**
  - `tests/managed-mode/` absent (parent: `tests/` listed; no such dir).
  - `grep -rn "lean\b\|LEAN\b" src/ defaults/ .bobbit/config/` returns no managed-mode mode flag — only unrelated boolean variables.
- **Scope-down notes:** Park behind Priority 1 (lean mode). When lean mode is introduced, *that* PR adds a managed-mode snapshot (`assembleSystemPrompt` output for a fixture managed goal) and a smoke test that exercises `team_spawn` + `gate_signal` + workflow-context injection. Don't pre-build the suite.

---

## Goal 14.2: Summarise gate context by default

- **Doc claim:** Managed mode injects full gate state (10+ KB of past gate artifacts). Most is irrelevant on a given turn. Inject summary by default; provide `gate_status(id, full=true)` for full retrieval.
- **Bobbit reality:** Gate content is injected *in full* into the system prompt, with no length cap or summarisation. `team-manager.ts:444-491` `buildDependencyContext` concatenates `gateState.currentContent` for every passed `injectDownstream` upstream gate, separated by `---`, with no ceiling:
  ```ts
  // src/server/agent/team-manager.ts:471-490
  for (const depId of inputIds) {
      const gateDef = goal.workflow.gates.find(g => g.id === depId);
      const gateState = gateStates.find(g => g.gateId === depId);
      if (gateDef && gateState && gateState.status === "passed"
          && gateDef.injectDownstream && gateState.currentContent) {
          parts.push(`## Gate: ${gateDef.name} (passed)\n\n${gateState.currentContent}`);
      }
  }
  // ...
  return "\n\n# Upstream Gates\n\nContent from passed upstream gates:\n\n"
      + parts.join("\n\n---\n\n");
  ```
  The result is appended verbatim by `system-prompt.ts:289-291` (`if (parts.workflowContext?.trim()) sections.push(parts.workflowContext.trim())`). The `gate_status` REST endpoint also returns the full body unconditionally — `server.ts:1474-1483` returns `{ ...gate, ..., content: def?.content }` with no `view=summary` mode.
- **Claude Code reality:** No direct gate-context analogue; the closest pattern is the result-spillover scheme that persists oversized tool results to disk and gives the model a 2 KB preview + filename pointer (`audits/claude-code.md:171-180`, `src/utils/toolResultStorage.ts:106-112`). Same shape: summary in prompt, full body fetchable.
- **Hermes reality:** Same shape — `tool_result_storage.py:178-226` enforces a per-turn aggregate budget and persists oversize results, with the LLM seeing a summary + path pointer (`audits/hermes.md:131,167`).
- **Verdict:** real.
- **Reasoning:** Bobbit's `buildDependencyContext` has no cap, no summary mode, and `gate_status` returns full content. Concretely large design-doc gates are dumped verbatim into every downstream agent's prompt. Both reference harnesses prove the pattern (summary in prompt, full body on demand) is well-trodden.
- **Minimal proof of gap (Bobbit ↔ CC):**
  - **Bobbit (no cap):** `team-manager.ts:471-490` excerpt above; result joined unbounded at line 490.
  - **Claude Code (preview + persisted-output):** `src/utils/toolResultStorage.ts:106-112` writes oversize results to `<projectDir>/<sessionId>/tool-results/<toolUseId>.{txt|json}` and the model receives a 2 KB preview + `<persisted-output>` tag; per-message cap `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` (`toolLimits.ts:48`).
- **Scope-down notes:** None — small change, well-scoped. Add a 4 KB default summary in `buildDependencyContext` and a `?view=full` query mode on `GET /api/goals/:goalId/gates/:gateId` (already wired through `tools/tasks/extension.ts:165-178`). Default summary should include gate id, name, status, content length, last signal timestamp, and optionally first 80 lines.

---

## Goal 14.3: Workflow-context budget

- **Doc claim:** Workflow state can balloon when goals have many tasks/dependencies. Hard cap on injected workflow state (default 4 KB); on overflow inject summary + IDs; provide `goal_detail`, `task_detail`, `workflow_state` retrieval tools.
- **Bobbit reality:** Same root cause as 14.2. `system-prompt.ts:289-291` appends `workflowContext` with no truncation; `team-manager.ts:490` builds it with no cap. There is no `goal_detail` / `task_detail` / `workflow_state` retrieval tool registered (no matches in `.bobbit/config/tools/tasks/extension.ts`). Tasks themselves are not auto-injected today, but every passed `injectDownstream` upstream gate's content is — for goals with many gates this scales linearly.
- **Claude Code reality:** No workflow concept (single-agent design) — but the persisted-output / preview pattern is the same idea (`audits/claude-code.md:171-180`).
- **Hermes reality:** No workflow concept either, but `MAX_TURN_BUDGET_CHARS = 200_000` aggregate budget with biggest-first persistence (`tools/budget_config.py:19`, `tool_result_storage.py:178-226` per `audits/hermes.md:131,167`) demonstrates the budget-then-spill pattern.
- **Verdict:** real.
- **Reasoning:** Workflow context is injected unbounded today. The fix overlaps heavily with 14.2 — both go through `buildDependencyContext`. Treat 14.2 and 14.3 as one piece of work (same cap, same retrieval surface), with 14.3 adding `task_detail`/`workflow_state` retrieval helpers.
- **Minimal proof of gap (Bobbit ↔ Hermes):**
  - **Bobbit (unbounded):** same `team-manager.ts:471-490` excerpt; `system-prompt.ts:289-291`:
    ```ts
    if (parts.workflowContext?.trim()) {
        sections.push(parts.workflowContext.trim());
    }
    ```
  - **Hermes (capped + spill):** `tools/budget_config.py:19` `DEFAULT_TURN_BUDGET_CHARS = 200_000`; `tool_result_storage.py:178-226` `enforce_turn_budget` persists biggest-first until under budget.
- **Scope-down notes:** Merge 14.2+14.3 into a single PR. Default cap 4 KB summary + lazy `gate_inspect` / `task_detail` REST endpoints. Skip a separate `workflow_state` tool initially — `gate_list` + `task_list` cover the common case.

---

## Goal 14.4: Make team lead less eager

- **Doc claim:** Team-lead role currently encourages aggressive spawning. Add a `planner` mode that thinks first, spawns only when necessary; threshold configurable.
- **Bobbit reality:** Confirmed verbatim in the role prompt. `.bobbit/config/roles/team-lead.yaml` is 21,721 bytes (323 lines) and the "Parallelism & Conflict Avoidance" section is unambiguously biased toward eager spawning:
  ```yaml
  # .bobbit/config/roles/team-lead.yaml:49-55
  ## Parallelism & Conflict Avoidance
  Your primary job is to **divide work into distinct, non-overlapping tasks**
  and **spawn many agents in parallel** to complete the goal quickly.
  You can run up to 12 agents concurrently — use that capacity aggressively.
  ...
  - **Spawn agents in parallel, not sequentially.**
  ...
  ```
  No "think first / spawn only when necessary" branch. No `planner` flag, no per-goal sizing heuristic.
- **Claude Code reality:** Not directly comparable — Claude Code's `AgentTool` is the closest analogue; spawning a subagent there is bracketed by feature flags (`isAgentSwarmsEnabled`, `isForkSubagentEnabled`) and the prompt does not encourage maximal concurrency by default (`audits/claude-code.md:95-117`).
- **Hermes reality:** Hermes' `delegate_task` defaults to `role="leaf"` with hard depth caps (`delegation.max_spawn_depth = 2`, `orchestrator_enabled` global kill switch — `audits/hermes.md:96-103`). No "spawn aggressively" framing in any documented system prompt fragment for the orchestrator role; orchestrator role is the *opt-in* path.
- **Verdict:** real.
- **Reasoning:** Bobbit's team-lead role prompt explicitly biases toward maximum concurrency. Both reference harnesses default to a more conservative posture (depth-capped, feature-flagged) and require an opt-in for aggressive delegation. The scope-down is purely a prompt edit + role config option.
- **Minimal proof of gap (Bobbit ↔ Hermes):**
  - **Bobbit (eager):** `.bobbit/config/roles/team-lead.yaml:49-55` excerpt above.
  - **Hermes (conservative + capped):** `tools/delegate_tool.py:38-46` blocks `delegate_task` for `role="leaf"` (no recursion); `delegation.max_spawn_depth` default 2 and `orchestrator_enabled` kill switch (`audits/hermes.md:100-103`).
- **Scope-down notes:** A pure `.bobbit/config/roles/team-lead.yaml` edit — no code changes needed. Reframe "spawn many agents in parallel" → "decompose only when work genuinely partitions; for ≤2 distinct file regions, do it yourself or sequence two agents". Add a `planner` flag that toggles between the current eager prompt and the conservative variant. Cheap, high-leverage.

---

## Goal 14.5: Memory ranking for managed mode

- **Doc claim:** Memory injection concatenates all qualifying files up to 16 KB cap, regardless of relevance. Score by keyword overlap × recency × type weighting (`feedback > project > user`); inject top-N within budget; provide `memory_search(query)` for on-demand. Reference: Claude Code `findRelevantMemories.ts`.
- **Bobbit reality:** Confirmed exactly as described. `system-prompt.ts:106-145` reads `~/.claude/projects/<encodedCwd>/memory/*.md`, sorts alphabetically (`.sort().slice(0, 20)`), filters by type (`allowedTypes = {user, feedback, project}`), and concatenates until 16 KB:
  ```ts
  // src/server/agent/system-prompt.ts:116-135
  const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith(".md") && f !== "MEMORY.md")
      .sort()
      .slice(0, 20);
  // ...
  for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
      const parsed = parseMemoryFile(content);
      if (!parsed || !allowedTypes.has(parsed.type)) continue;
      const entry = `### ${parsed.name}\n\n${parsed.body}`;
      if (totalLength + entry.length > 16000) break;
      parts.push(entry);
      totalLength += entry.length;
  }
  ```
  No relevance scoring, no recency weighting (sort is *alphabetical filename*, not mtime), no type weighting, no `memory_search` tool. The first 20 alphabetical files win.
- **Claude Code reality:** `src/memdir/findRelevantMemories.ts` ranks memories *via an LLM call* against the user query — different mechanism than the doc proposes (the doc proposes deterministic scoring). Selector picks ≤5 by name + description, with `alreadySurfaced` dedupe and tool-aware exclusion of usage docs:
  ```ts
  // src/memdir/findRelevantMemories.ts:40-60
  export async function findRelevantMemories(
      query: string, memoryDir: string, signal: AbortSignal,
      recentTools: readonly string[] = [],
      alreadySurfaced: ReadonlySet<string> = new Set(),
  ): Promise<RelevantMemory[]> {
      const memories = (await scanMemoryFiles(memoryDir, signal))
          .filter(m => !alreadySurfaced.has(m.filePath));
      if (memories.length === 0) return [];
      const selectedFilenames = await selectRelevantMemories(query, memories, signal, recentTools);
      // ... up to 5 returned
  }
  ```
  Uses a Sonnet `sideQuery` (system prompt at `findRelevantMemories.ts:18-24`).
- **Hermes reality:** Hermes uses a *frozen-snapshot* model with bounded character limits (MEMORY.md 2,200 chars; USER.md 1,375 chars — `website/docs/user-guide/features/memory.md`). No ranking needed because total size is already capped tight; agent self-curates via `memory` tool actions (`add` / `replace` / `remove`). External providers (Honcho, Mem0, etc.) "prefetch relevant memories before each turn" (`memory-providers.md`) but the prefetch logic is provider-internal — the relevant Hermes-style rule the doc cites ("single-active external memory provider") is enforced at config level (`memory-providers.md:9` "Only one external provider can be active at a time").
- **Verdict:** real.
- **Reasoning:** Gap exists exactly as the doc states — first-N-alphabetical with a hard byte cap is the entire ranking algorithm today. Reference implementation exists in CC (`findRelevantMemories.ts`), though it uses an LLM-side-query rather than the doc's heuristic scoring. Hermes' bounded-snapshot pattern is an alternative answer (cap memory tight enough that ranking is unnecessary).
- **Minimal proof of gap (Bobbit ↔ Claude Code):**
  - **Bobbit (alphabetical + bytecap):** `src/server/agent/system-prompt.ts:118-134` excerpt above.
  - **Claude Code (LLM-ranked, top-5):** `src/memdir/findRelevantMemories.ts:40-60` excerpt above; selector prompt at `findRelevantMemories.ts:18-24` instructs Sonnet to pick ≤5 by relevance.
- **Scope-down notes:** Two simpler options before building heuristic scoring + a new tool:
  1. Sort by `mtime` instead of filename and keep the 16 KB cap — low effort, addresses the alphabetical-bias half-bug.
  2. Adopt Hermes' tighter cap (≤4 KB total) and let the user/agent curate via a `memory` tool. Avoids a relevance scorer entirely.
  If full ranking is wanted, mirror CC's LLM picker rather than build keyword/recency heuristics — `findRelevantMemories.ts` is ~140 lines and the `sideQuery` infra is already proven.

---

## Cross-cutting observations

- 14.2 and 14.3 share a single root cause (`buildDependencyContext` + `system-prompt.ts:289-291` are unbounded). Implement together; one cap, one retrieval seam.
- 14.4 is the cheapest item in this priority and arguably the highest immediate impact — pure prompt edit, measurable in spawn-count telemetry.
- 14.1 is preventive scaffolding tied to Priority 1 (lean mode). Don't build until lean mode is actually queued.
- 14.5's "16 KB unranked" gap is real but the *fix shape* in the doc (heuristic scoring) diverges from the cited CC reference (LLM picker). Pick one approach explicitly.
