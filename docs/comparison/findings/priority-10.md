# Priority 10 — Prompt-Cache Strategy

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 10.1 | Bobbit's prompt structure is not cache-friendly; reorder system prompt into stable prefix + volatile suffix | **partial** | high |
| 10.2 | Cache `system + last-N` messages — Bobbit currently caches only the system prompt within a session | **partial** | high |
| 10.3 | Provider-aware cache control (Anthropic / OpenAI / Gemini / others) | **partial** | medium |
| 10.4 | Per-provider / per-mode / per-project cache-hit reporting | **real** | high |

---

## Goal 10.1 — Stable prefix vs volatile suffix

**Doc claim.** Bobbit's prompt structure is not cache-friendly; AGENTS.md / memories sit before the stable parts; need to reorder into stable prefix (identity + AGENTS.md + tool docs + role stub) and volatile suffix (goal/task/workflow/personality).

**Bobbit reality.**
- Section assembly order in `src/server/agent/system-prompt.ts:201-291`:
  1. global system prompt
  2. AGENTS.md (resolves `@file.md` refs inline, line 24's `resolveMarkdownRefs`)
  3. CLAUDE.md
  4. Claude Code memories (line 110-153, capped 16 KB / 20 files)
  5. memory `group_id` hint
  6. Goal section (`goalSpec` + role + tool restrictions, line 238-251) ← **volatile, before tool docs**
  7. Personalities
  8. Tool docs
  9. Task context
  10. Workflow upstream-gate context
- Combined into one string (`sections.join("\n\n---\n\n")`, line 296) and written to `<bobbitStateDir>/session-prompts/<sessionId>.md`, then handed to pi-ai as `params.system` (single text block per `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:482-491`).
- Bobbit-side code never emits `cache_control` markers (`grep -rn cache_control src/server` → 0 matches; audit `bobbit.md:179-180`). Anthropic provider attaches **one** `cache_control: ephemeral` to the whole system text + one to the last user message.

**Claude Code reality.**
- `prompts.ts:107` inserts a literal `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker; everything before is `scope: 'global'` and statically cacheable across orgs, everything after is per-session/dynamic (audit `claude-code.md:188`).
- Tool-list ordering is deterministic (built-ins alphabetical, MCP after, `tools.ts:303-316`) so the tool prefix stays cache-stable when MCP tools change (`claude-code.md:228`).
- Cache breakpoints are placed on tool definitions, system prompt prefix, and final user message (`claude.ts:603-663`).

**Hermes reality.**
- System prompt is built **once per session** and only rebuilt after compaction (`run_agent.py:4737-4742`, audit `hermes.md:139,163`). Stable across all turns → maximises prefix-cache hits regardless of section order.
- Cache marker via `agent/prompt_caching.py:42-72` (4 breakpoints).

**Verdict.** **partial.**

**Reasoning.** The doc's framing ("not cache-friendly because volatile content sits before stable parts") is wrong as a cache-mechanics claim — the entire system prompt is one Anthropic text block with a single `cache_control` marker, so internal section order does not change cache behavior unless Bobbit *splits* the system prompt into multiple text blocks with breakpoints. What is true:
- Goal spec / task / workflow context **are** glued into the same string as AGENTS.md and tool docs, so any goal-spec edit busts the entire prefix on the next request.
- The fix is real (split into multiple blocks with cache_control on the stable boundary, like CC's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`), but the *user-visible* "AGENTS.md not cached" symptom doesn't exist today — it gets cached as part of the single system block when no goal/task changes.

**Minimal proof of gap.**
Bobbit (`src/server/agent/system-prompt.ts:200-298`) — single combined string:
```ts
const sections: string[] = [];
// ... pushes global prompt, AGENTS.md, goal, tool docs, task, workflow ...
const combined = sections.join("\n\n---\n\n") + "\n";
fs.writeFileSync(promptPath, combined, "utf-8");
return promptPath;
```
Pi-ai applies one breakpoint to that whole text (`node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:482-491`):
```js
params.system = [{
  type: "text",
  text: sanitizeSurrogates(context.systemPrompt),
  ...(cacheControl ? { cache_control: cacheControl } : {}),
}];
```
CC splits at a known boundary (`prompts.ts:107`, audit `claude-code.md:188`):
> Prompt is split with the marker `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. Everything before is statically cacheable across orgs (`scope: 'global'`), everything after is per-session/dynamic.

**Scope-down notes.** Reframe goal as "split system prompt into ≥2 text blocks with cache_control on the stable boundary" rather than "reorder sections". Volatile-suffix benefit is only visible if Bobbit moves goal/task/workflow text *out of* the single `--system-prompt` blob (or out of the system text block) — currently a goalSpec edit invalidates the cache for AGENTS.md and tool docs too.

---

## Goal 10.2 — Cache `system + last-N` pattern

**Doc claim.** Within a session only the system prompt benefits from cache; conversation history does not. Mark system + last 3 non-system messages with `cache_control: ephemeral`, TTL 5 min default and 1 h configurable.

**Bobbit reality.**
- Pi-ai (`node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:471-488`) attaches `cache_control: { type: "ephemeral" }` to **two** breakpoints: the system text block and the **last user message** (audit `bobbit.md:179`). It does not mark the last 3 non-system messages.
- TTL is hard-coded to default `ephemeral` (no `ttl` field). No 1 h knob exposed in `src/server/`.

**Claude Code reality.**
- `addCacheBreakpoints` on user/assistant messages (`claude.ts:600-665`) marks the last content block of the most recent user/assistant pair with `cache_control: { type: 'ephemeral', ttl?: '1h', scope?: 'global' }`.
- `should1hCacheTTL` (`claude.ts:401`) gates 1 h TTL on user-eligibility + GrowthBook allowlist; latched in bootstrap state for session stability so mid-session flips don't bust cache (`claude.ts:413-422`, audit `claude-code.md:193`).

**Hermes reality.**
- `agent/prompt_caching.py:42-72` — `system_and_3` strategy: up to **4** breakpoints (system + last 3 non-system). TTL `5m` default, `1h` opt-in (`:60-62`). Native-Anthropic vs OpenAI-completions formats handled in `_apply_cache_marker` (`:14-39`).

**Verdict.** **partial.**

**Reasoning.** Bobbit already has 2 breakpoints (system + last user), inherited from pi-ai. The gap is real — only 2 of the 4 Anthropic breakpoints are used, and 1 h TTL is unreachable — but the doc overstates it by saying "conversation history doesn't" benefit (the last user message *does* hit cache).

**Minimal proof of gap.**
Bobbit/pi-ai (`anthropic.js:471-488`) — only system gets a breakpoint here; last user msg gets one elsewhere. No multi-message marking.
Hermes (`agent/prompt_caching.py:60-72`):
```python
marker = {"type": "ephemeral"}
if cache_ttl == "1h": marker["ttl"] = "1h"
if messages[0].get("role") == "system":
    _apply_cache_marker(messages[0], marker, ...)
    breakpoints_used += 1
remaining = 4 - breakpoints_used
non_sys = [i for i in range(len(messages)) if messages[i].get("role") != "system"]
for idx in non_sys[-remaining:]:
    _apply_cache_marker(messages[idx], marker, ...)
```

**Scope-down notes.** The actual change has to land in pi-ai (or in a Bobbit-side wrapper of the provider params) since `src/server/` never sees the request body. Either fork/PR pi-ai or move to a Bobbit-controlled adapter. The 1 h TTL knob is the cheap half; the +2 breakpoints requires intercepting the message array.

---

## Goal 10.3 — Provider-aware cache control

**Doc claim.** Detect provider and emit Anthropic `cache_control: ephemeral`, rely on OpenAI automatic prefix caching, similar for Gemini, no-op others.

**Bobbit reality.**
- Bobbit has no per-provider cache logic in `src/server/`. All cache hints are inside pi-ai (`anthropic.js:471-488`, `openai-completions.js:363-385` — the Anthropic-routed OpenAI-Completions adapter also injects `cache_control`). For OpenAI/Gemini providers, pi-ai relies on automatic prefix caching (no markers); since the system prompt is one stable string the prefix should hit, but Bobbit does not measure or guarantee this.
- No `src/server/agent/providers/` directory exists (`ls src/server/agent` confirms — providers come from pi-ai upstream).

**Claude Code reality.**
- Provider-aware: `getCacheControl` (`claude.ts:359-373`) returns `{type:'ephemeral', ttl?, scope?}` for Anthropic; the Bedrock branch in `should1hCacheTTL` (`claude.ts:395-405`) gates the 1 h TTL on `getAPIProvider() === 'bedrock'` and a Bedrock-specific env var.

**Hermes reality.**
- `agent/prompt_caching.py:14-39` `_apply_cache_marker` branches on `native_anthropic` (true Anthropic SDK) vs OpenAI-completions message shape (audit `hermes.md:162`). For non-Anthropic providers Hermes simply doesn't call `apply_anthropic_cache_control`.

**Verdict.** **partial.**

**Reasoning.** Bobbit "no-ops" for non-Anthropic providers today (because pi-ai only emits markers on Anthropic adapters), which is *technically* the desired behaviour for OpenAI/Gemini. The real gap is two-fold: (a) the file path the doc cites (`src/server/agent/providers/*`) does not exist — the work has to land in pi-ai or a wrapper; (b) Bobbit has no provider-aware *strategy selection* (e.g. choose `system_and_3` vs `system_only`) because everything is delegated to pi-ai's hard-wired 2-breakpoint logic.

**Minimal proof of gap.** No `src/server/agent/providers/` directory; `grep -rn "cache_control\|getCacheControl" src/server` returns 0 matches. CC has a dedicated `getCacheControl` (`claude.ts:359-373`):
```ts
export function getCacheControl({ scope, querySource } = {}): {
  type: 'ephemeral'; ttl?: '1h'; scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

**Scope-down notes.** Re-target file paths to "pi-ai upstream PR or Bobbit-side wrapper". No-op-for-others is mostly already free; the visible deliverable is exposing TTL/scope controls and ensuring OpenAI prefix caching isn't silently broken by the goal-spec-in-system-prompt issue from 10.1.

---

## Goal 10.4 — Cache-hit reporting

**Doc claim.** Extend cache metrics with dimensions (provider/model/projectPath/mode/role/dateBucket); compute cacheHitRate and estimated savings; add dashboard tiles.

**Bobbit reality.**
- `src/server/agent/cost-tracker.ts:5-30` — `SessionCost` is flat: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost}`. Stored as `Map<sessionId, SessionCost>` and persisted to `session-costs.json`.
- No provider/model/mode/projectPath/role dimensions on the cost record. `recordUsage(sessionId, usage)` (line 86-99) only sums into the per-session bucket.
- No aggregation API beyond `getSessionCost` and `getGoalCost(goalId, sessionIds)` (line 109-122). REST endpoint `server.ts:2870-2874` only returns the flat shape.
- No cache-hit-rate calculation, no `not supported` distinction, no JSON export endpoint, no dashboard tile.

**Claude Code reality.**
- CC instruments cache at request shape level (breakpoints on tool defs, system, last messages — `claude.ts:603-663`) and uses `cache_creation_tokens` from the response for fleet-level measurement (audit `claude-code.md:285` — "documented Big-Query measurement at FileReadTool.ts:380-388 — ~18% of Reads were same-file collisions, ~2.64% of fleet `cache_creation` tokens"). Reporting itself is not user-facing in the OSS code; the dimensional analysis happens off-line.

**Hermes reality.**
- `agent/account_usage.py` tracks usage but does not break out by provider×mode×project; closest match is `agent/prompt_caching.py` which emits cache markers but no per-dimension reporting was found.

**Verdict.** **real.**

**Reasoning.** Bobbit's `SessionCost` model is one-dimensional and there is no API or UI for cache hit rate broken out by provider / model / mode / project. The reference value (CC measures at fleet scale; Hermes tracks usage) shows the dimensional shape is achievable with the same data already arriving in `recordUsage`. Implementing this on top of the current code is concrete: enrich `SessionCost` with `{provider, model, projectPath, mode, role}` at recording time, persist as a list (or JSON-lines append log), and aggregate.

**Minimal proof of gap.**
Bobbit (`src/server/agent/cost-tracker.ts:5-30`):
```ts
export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}
// stored as Map<sessionId, SessionCost> — no provider/model/mode dimensions
```
`recordUsage` (line 86-99) — only sums numeric fields, no dimensions captured:
```ts
recordUsage(sessionId: string, usage: UsageData): SessionCost {
  const existing = this.costs.get(sessionId) ?? emptyCost();
  existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
  existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  // ...
}
```
CC fleet measurement reference (audit `claude-code.md:285`):
> documented Big-Query measurement at `FileReadTool.ts:380-388` — ~18 % of Reads were same-file collisions, ~2.64 % of fleet `cache_creation` tokens.

**Scope-down notes.** Acceptance bullet "Sessions with no cache support show `not supported`, not 0 %" requires knowing per-provider capability — easy: derive from provider name. "Dashboard filter by 7/30/90 days" requires per-record timestamps, which the current `Map<sessionId, SessionCost>` does not have — must migrate the persistence shape.
