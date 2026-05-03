# Priority 1 — findings-summary

All six Lean Coding Mode goals (1.1–1.6) verdict **real**: Bobbit master @ `a3a9cc7` has no mode flag, no lean role variant, unconditional gate/memory protocol, no auto-default, and no mode UI badge.

# Priority 8 — findings-summary

All three Plan / Read-Only Mode goals (8.1–8.3) verdict **real**: Bobbit has no plan-mode state, no `(tool, args)` permission classifier, and no UI affordance; CC reference is `EnterPlanModeTool` / `ExitPlanModeV2Tool` + per-tool `isReadOnly(input)` (Hermes also lacks plan mode).

# Priority 10 — findings-summary

Goals 10.1–10.3 **partial** (Bobbit inherits 2-breakpoint pi-ai cache and has no Bobbit-side `cache_control` code in `src/server/`; doc cites paths that don't exist). Goal 10.4 **real**: `cost-tracker.ts` `SessionCost` is flat — no provider/model/mode/project dimensions, no cache-hit-rate API.

# Priority 9 — findings-summary

Five of six Delegation goals **real**: Bobbit's `.bobbit/config/tools/agent/extension.ts` has no lite mode (9.1), no fork (9.2), serial session creation in the parallel path (9.3 confirmed at `:273–290`), prose-only results (9.4), and no danger classifier for delegates (9.6, depends on 8.2). Goal 9.5 **partial** — recursion guard via `BOBBIT_DELEGATE_OF` (`:200–205`) is already in place; memory/messaging/browser stripping is not.

# Priority 12 — findings-summary

All four Sandbox/Isolation Backend goals (12.1–12.4) verdict **real**: Bobbit master has no execution abstraction (`spawn` directly from `.bobbit/config/tools/shell/extension.ts:14-35`), no Docker/SSH/Modal/Daytona/Vercel backends, no `src/server/exec/` directory. Hermes is the canonical reference (`tools/environments/base.py:267` `BaseEnvironment` ABC + 7 concrete backends); Claude Code is partial reference only (OS-level sandbox-exec/landlock, internal teleport remote sessions, no container/cloud).

# Priority 11 — findings-summary

11.1 (context-file scanner) and 11.3/11.4 (write deny-list + `BOBBIT_WRITE_SAFE_ROOT`) **real** — direct ports from Hermes `agent/prompt_builder.py:36-72` and `agent/file_safety.py:1-93`; Bobbit has zero equivalent. 11.2 (frontmatter strip) **partial** — Bobbit's `parseMemoryFile` already strips frontmatter from Claude Code memories but not from AGENTS.md/CLAUDE.md. 11.5 (streaming fence scrubber) **unverifiable** — Bobbit emits markdown headings, not `<memory>`/`<context>` fence tags; no demonstrated leak path.

# Priority 14 — findings-summary

Goals 14.2/14.3 **real** (single root cause: `team-manager.ts:471-490` `buildDependencyContext` + `system-prompt.ts:289-291` inject upstream-gate content unbounded — no cap, no summary mode, no retrieval-on-demand; CC/Hermes both spill via `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` / `MAX_TURN_BUDGET_CHARS=200_000`). 14.4 **real** — `.bobbit/config/roles/team-lead.yaml:49-55` explicitly tells the lead to "spawn many agents in parallel ... use that capacity aggressively"; Hermes defaults `delegation.max_spawn_depth=2` and blocks recursion for leaf roles. 14.5 **real** — `system-prompt.ts:118-134` ranks Claude Code memories *alphabetically* (`.sort().slice(0,20)`) up to 16 KB, no relevance/recency/type weighting; CC reference is `findRelevantMemories.ts:40-60` (LLM picker, top-5). 14.1 **partial** — managed-mode regression suite truly absent (no `tests/managed-mode/`), but lean mode itself doesn't yet exist in master, so the protection target is preventive scaffolding to ship alongside Priority 1.

# Priority 13 — findings-summary

All three Verification goals **real** — Bobbit ships zero post-edit syntax check (13.1; audit `bobbit.md:210` confirms; Hermes is canonical ref at `tools/file_operations.py:261-267, 853-883`), no project-detecting `verify` tool (13.2; `.bobbit/config/tools/` has no `verify` group; CC's `verify` is an ant-only prompt skill `src/skills/bundled/verify.ts:13-15`, not a tool — reference impl is weak), and no per-runner test-output parser (13.3; neither CC nor Hermes ships one either, so the "retrofit" framing is wrong but the gap is genuine).
