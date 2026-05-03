# Priority 9 — Delegation Efficiency

Source citations refer to:
- Bobbit:       `/Users/aj/Documents/dev/bobbit`
- Claude Code:  `/Users/aj/Documents/dev/claude-code`
- Hermes:       `/Users/aj/Documents/dev/hermes-agent`

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 9.1 | Lightweight delegate mode (minimal prompt/toolset/cap) | **real** | high |
| 9.2 | Context-fork option with byte-exact prompt sharing | **real** | high |
| 9.3 | Concurrent spawning (verify session creation overlaps) | **real** (creation is serial; only waits are parallel) | high |
| 9.4 | Structured delegate results | **real** | high |
| 9.5 | Default delegate toolset excludes `delegate`, `memory_*`, `send_message`, browser | **partial** (recursion blocked; other categories not blocked) | high |
| 9.6 | Auto-deny dangerous in delegates | **real** | high |

---

## Goal 9.1 — Lightweight delegate mode

**Doc claim.** `delegate` always spawns a full session; should add `delegate({mode:'lite'})` with minimal prompt, `code-core` toolset only, strict result cap (~2 KB), no recursion.

**Bobbit reality.** Single delegate path. Every call goes through `createDelegateSession` → full `POST /api/sessions` with `delegateOf`, which spins a real Bobbit session (full system prompt, full tool surface, full agent harness). Truncation is per-result only:
- single delegate: `result.output.length > 5000 ? slice(0, 5000) + "\n...(truncated)"` (`.bobbit/config/tools/agent/extension.ts:368`)
- parallel delegate: `length > 3000 ? slice(0, 3000) + "\n...(truncated)"` (`extension.ts:333`)

There is no `mode` param on the tool schema (`extension.ts:222–231`). No "lite" code path or alternate role.

**Claude Code reality.** `Agent` tool exposes `subagent_type` plus a synthetic `FORK_AGENT` (gated). Different `subagent_type`s pick different tool pools and prompts (`AgentTool.tsx:80–117`, `agentToolUtils.ts:227+`). One-shot built-ins skip parts of the result trailer. Closest to the proposal is per-`subagent_type` tool-pool gating via `assembleToolPool`/`filterDeniedAgents` (`AgentTool.tsx:219, 569–577`).

**Hermes reality.** `delegate_task` accepts `toolsets[]` (default inherits parent) and `role` (`"leaf"` / `"orchestrator"`) — leafs are restricted (`tools/delegate_tool.py:1816–1900`). The blocked-tools list (`:40–46`) plus `role` flag give an effective "lite leaf mode" out of the box.

**Verdict.** **real.** Bobbit has exactly one delegate code path, no toolset restriction, no minimal-prompt mode.

**Minimal proof of gap.**

```ts
// /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts:222–231
parameters: Type.Object({
  instructions: Type.Optional(Type.String(...)),
  parallel: Type.Optional(Type.Array(...)),
  context: Type.Optional(Type.Record(Type.String(), Type.String(), ...)),
  timeout_minutes: Type.Optional(Type.Number(...)),
}),
```

```python
# /Users/aj/Documents/dev/hermes-agent/tools/delegate_tool.py:38–46
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task", "clarify", "memory", "send_message", "execute_code",
])
```

**Scope-down notes.** A proper "lite" mode in Bobbit will need a separate role (no team/gate/goal prompt) and a server-side path to skip session-state (gates, worktree). Today's `delegate` always carries the full coder system prompt because each call is a full gateway session.

---

## Goal 9.2 — Context-fork option

**Doc claim.** Add `delegate({fork_context:true})` that injects parent's compacted conversation + shares system prompt byte-exact for cache reuse, with recursion guard.

**Bobbit reality.** No fork path. `createDelegateSession` POSTs only `{ delegateOf, instructions, cwd, title, context }` (`extension.ts:85–103`). The receiving session is constructed fresh; nothing in `session-manager.createDelegateSession` (`src/server/agent/session-manager.ts:1296–1343`) clones or replays the parent's transcript. No `cache_control` markers on shared prompt prefixes.

**Claude Code reality.** Implemented in `src/tools/AgentTool/forkSubagent.ts`. Quote (`:46–66`):

```ts
// FORK_AGENT — synthetic agent definition for the fork path. Not registered
// in builtInAgents — used only when `!subagent_type` and the experiment is
// active. tools: ['*'] with useExactTools means the fork child receives the
// parent's exact tool pool (for cache-identical API prefixes).
// ...
// The getSystemPrompt here is unused: the fork path passes
// override.systemPrompt with the parent's already-rendered system prompt
// bytes, threaded via toolUseContext.renderedSystemPrompt. Reconstructing
// by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
// bust the prompt cache; threading the rendered bytes is byte-exact.
```

Recursion guard: `isInForkChild` scans messages for the `FORK_BOILERPLATE_TAG` (`forkSubagent.ts:78–88`). Note: gated by `FORK_SUBAGENT` GrowthBook flag (`isForkSubagentEnabled`, `:32–40`).

**Hermes reality.** No byte-exact fork. Subagents always start fresh (`tools/delegate_tool.py:103` "fresh conversation, own task_id"). Closest is the `context` field copied verbatim into the child prompt.

**Verdict.** **real.** Direct implementation gap; CC's `forkSubagent.ts` is the named reference and the cited file/symbol exists.

**Minimal proof of gap.**

```ts
// Bobbit: /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts:85–103
export async function createDelegateSession(
  parentSessionId, instructions, cwd, opts?: { title?; context? },
): Promise<string> {
  const resp = await gatewayFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ delegateOf: parentSessionId, instructions, cwd,
                          title: opts?.title, context: opts?.context }),
  });
  ...
}
```

```ts
// CC: /Users/aj/Documents/dev/claude-code/src/tools/AgentTool/forkSubagent.ts:60–66
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  tools: ['*'], maxTurns: 200, model: 'inherit',
  permissionMode: 'bubble', source: 'built-in', baseDir: 'built-in',
  getSystemPrompt: () => '',                // unused — bytes threaded in
} satisfies BuiltInAgentDefinition
```

**Scope-down notes.** Cache-hit benefit only matters if Bobbit forwards `cache_control` ephemeral markers to providers. Confirm cache-control plumbing (Priority 10) is in place before betting on the cost-saving claim.

---

## Goal 9.3 — Concurrent spawning

**Doc claim.** Verify `parallel: [...]` actually starts children concurrently. If session creation is serialised, parallelism is illusory.

**Bobbit reality.** The parallel path creates sessions **sequentially**, then waits in parallel:

```ts
// /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts:273–290
for (let i = 0; i < params.parallel.length; i++) {
  const p = params.parallel[i];
  try {
    const sid = await createDelegateSession(parentSessionId, p.instructions, cwd, {
      title: p.instructions.split("\n")[0].slice(0, 60),
      context: { ...params.context, ...p.context },
    });
    sessionIds[i] = sid;
    if (onUpdate) onUpdate(buildProgressUpdate());
  } catch (err: any) { ... }
}

// :294–321 — Promise.all is only for the wait phase
const promises = sessionIds.map((sid, i) => {
  if (!sid) return Promise.resolve();
  return waitForDelegate(sid, timeoutMs, signal).then(...)
});
await Promise.all(promises);
```

So if `createDelegateSession` takes ~1 s each (HTTP + worktree setup), three children incur ~3 s before the first one starts running. This matches the doc's hypothesis.

**Claude Code reality.** Spawns via `spawnTeammate` (`AgentTool.tsx:290`); for in-process forks each agent runs concurrently via the model loop without a per-spawn HTTP setup hop.

**Hermes reality.** `ThreadPoolExecutor(max_workers=max_children)` submits all tasks at once (`tools/delegate_tool.py:1985–1995`); creation and execution overlap.

**Verdict.** **real.** The doc's suspicion is confirmed by source: serial session-creation loop with `await` inside.

**Minimal proof of gap.** See excerpts above. Fix is `await Promise.all(params.parallel.map(p => createDelegateSession(...)))`.

```python
# Hermes reference: /Users/aj/Documents/dev/hermes-agent/tools/delegate_tool.py:1985–1995
with ThreadPoolExecutor(max_workers=max_children) as executor:
    futures = {}
    for i, t, child in children:
        future = executor.submit(_run_single_child, task_index=i, ...)
        futures[future] = i
```

**Scope-down notes.** Concurrent creation will surface latent races in the gateway's session-setup (worktree creation per-session). Add a regression test that asserts `Date.now()` between `createDelegateSession` calls is < 100 ms apart.

---

## Goal 9.4 — Structured delegate results

**Doc claim.** Replace free-form prose with `{summary, files_read, files_changed, tests_run, blockers, artifacts}`. Persist long prose externally.

**Bobbit reality.** Result is plain truncated prose plus a per-delegate `details` block of `{id, sessionId, instructions, status, durationMs}` (`extension.ts:340–351, 376–384`). No content categorisation, no artifact channel. Truncation is naive `slice(0, N)`:

```ts
// extension.ts:331–334
if (r?.output) {
  const truncated = r.output.length > 3000 ? r.output.slice(0, 3000) + "\n...(truncated)" : r.output;
  lines.push("```\n" + truncated + "\n```");
}
```

**Claude Code reality.** `agentToolResultSchema` (`agentToolUtils.ts:227–258`) gives a structured outer envelope: `{agentId, agentType?, content[], totalToolUseCount, totalDurationMs, totalTokens, usage{...}}`. Output `content` is still text blocks but token/tool-use counts are first-class. Persisted-output spillover (`toolResultStorage.ts`) handles large results.

**Hermes reality.** `_run_single_child` returns a structured dict — `{task_index, status, summary, error, api_calls, duration_seconds, _child_role}` (`tools/delegate_tool.py:2017–2042`). Status set is `{completed, error, interrupted}` (`:2024–2042`). The summary is a free-form string but the envelope is structured.

**Verdict.** **real.** Bobbit's delegate output is the least structured of the three.

**Minimal proof of gap.**

```ts
// Bobbit: extension.ts:340–351 — only the prose is returned; `details`
//        is metadata for the UI, not a contract for the parent agent.
details.delegates.push({
  id: sid?.slice(0, 12) || "?",
  sessionId: sid || "",
  instructions: params.parallel[i].instructions.split("\n")[0].slice(0, 100),
  status: r?.status || "failed",
  durationMs: r?.durationMs || 0,
});
```

```ts
// CC: agentToolUtils.ts:227–245
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({ ... }),
  }),
)
```

**Scope-down notes.** The full proposed shape (`files_read`, `files_changed`, `tests_run`) requires per-tool instrumentation in the delegate. A pragmatic first cut is CC-shaped (counts + usage + content) and lets the delegate produce the categorised lists in `summary`/`artifacts` if it wants.

---

## Goal 9.5 — Delegate toolset restriction

**Doc claim.** Default delegate toolset excludes `delegate`/`delegate_lite`, `memory_*`, `send_message`, and browser tools. Opt-in via `delegate({tools:[...]})`.

**Bobbit reality.** Recursion is blocked via env guard:

```ts
// /Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts:200–205
const extension: ExtensionFactory = (pi) => {
  // Prevent recursive delegation — delegate sessions should not spawn more delegates
  if (process.env.BOBBIT_DELEGATE_OF) {
    return; // Don't register the delegate tool in delegate sessions
  }
  ...
```

`BOBBIT_DELEGATE_OF` is set when the delegate session is spawned (`src/server/agent/session-manager.ts:1296`). Good.

**However**, no other tools are stripped. The delegate runs whatever role it was assigned (default: `coder`), which exposes the full `coder.yaml` toolset including memory tools, team tools, gate tools, browser tools, web tools, and `bash`/`bash_bg`. There is no per-call `tools:[...]` override on the `delegate` tool schema (`extension.ts:222–231`). The `context` field is just key-value strings; it does not narrow the tool surface.

**Claude Code reality.** `subagent_type` selects an agent definition whose `tools: [...]` field gates the pool (`loadAgentsDir.ts:86`, `assembleToolPool` in `AgentTool.tsx:577`). `permissions.filterDeniedAgents` enforces deny rules per-agent (`AgentTool.tsx:219, 342`).

**Hermes reality.** Direct match for the proposal:

```python
# /Users/aj/Documents/dev/hermes-agent/tools/delegate_tool.py:38–46
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # no recursive delegation
    "clarify",         # no user interaction
    "memory",          # no writes to shared MEMORY.md
    "send_message",    # no cross-platform side effects
    "execute_code",    # children should reason step-by-step
])
```

`_strip_blocked_tools` enforces it on the resolved child toolset (`tests/tools/test_delegate_toolset_scope.py:12`).

**Verdict.** **partial.** The recursion-guard half of the proposal is already done in Bobbit (cleanly, via env). The rest — stripping memory/messaging/browser by default — is not implemented.

**Minimal proof of gap.**

Bobbit delegate tool: schema has no `tools`/`toolsets` parameter (`extension.ts:222–231`). Compare to Hermes' `tools/delegate_tool.py:1816–1830` which exposes `toolsets: List[str]` and pre-filters via `_strip_blocked_tools`.

**Scope-down notes.** Frame the goal as **"port `DELEGATE_BLOCKED_TOOLS` and add an opt-in `tools:[...]` schema field"**, since recursion is already covered. Bobbit's tools don't currently include a `memory_*` family — verify the actual default-coder toolset before declaring memory exclusion as required.

---

## Goal 9.6 — Auto-deny dangerous in delegates

**Doc claim.** Default delegates auto-deny dangerous shell (per Goal 8.2 classifier). Opt-in via `delegate({approve_dangerous:true})` or session-level `subagent_auto_approve`.

**Bobbit reality.** No permissions module exists at the cited path:

```bash
$ find /Users/aj/Documents/dev/bobbit/src -name 'permissions*'
(empty)
```

`grep -r dangerous /Users/aj/Documents/dev/bobbit/src/server/` returns no hits. There is no command classifier, no per-session `auto_approve_dangerous` flag, no delegate-level approval inheritance. Tool-policies live in YAML role files but are not enforced as a runtime danger classifier.

The `delegate` tool spawns a session with full `bash`/`bash_bg` access (extension.ts as above) — `rm -rf /` would execute as the underlying shell allows it, with whatever approval policy the role's `bash` extension enforces. No delegate-specific deny.

**Claude Code reality.** `permissionMode: 'bubble'` (`AgentTool.tsx:613`, `runAgent.ts:443`) bubbles permission prompts to the parent terminal. Per-agent `permissionMode` declared in `loadAgentsDir.ts:86`. Combined with `permissions/permissions.ts` deny rules, dangerous commands route through a parent-visible approval path.

**Hermes reality.** Direct match for the proposal:

```python
# /Users/aj/Documents/dev/hermes-agent/tools/delegate_tool.py:69–80
def _subagent_auto_deny(command, description, **kwargs) -> str:
    logger.warning(
        "Subagent auto-denied dangerous command: %s (%s). "
        "Set delegation.subagent_auto_approve: true to allow.",
        command, description,
    )
    return "deny"
```

Wired via `ThreadPoolExecutor(initializer=_set_subagent_approval_cb, initargs=(cb,))` (`:1413` and the `:48–100` block) so every subagent worker thread inherits the auto-deny callback. Opt-in via `delegation.subagent_auto_approve: true` (`_get_subagent_approval_callback`, `:103–115`).

**Verdict.** **real.** Hermes' implementation is line-for-line the design the doc proposes; Bobbit has neither the classifier nor the delegate-specific deny pathway.

**Minimal proof of gap.** See Hermes excerpt above; Bobbit has no analogous file. Note: depends on Goal 8.2 (the classifier) actually landing — without a way to label commands "dangerous", auto-deny has no input.

**Scope-down notes.** Cannot ship 9.6 before 8.2 lands. Until then, the only quick win is per-delegate role with `bash` toolPolicy=`never` for destructive subcommands, which is partially achievable today via existing role YAML.

---

## Cross-cutting note

All six goals describe gaps in the **same file** (`/Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts`). A single pass over this extension can deliver 9.1, 9.3, 9.4, 9.5, and the opt-in surface for 9.2 and 9.6. The deeper-server work (forkSubagent, danger classifier) is what carries the token-cost wins.
