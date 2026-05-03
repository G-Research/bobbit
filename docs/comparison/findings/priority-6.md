# Priority 6 — Tool-Result Context Control

## Verdict summary

| goal | claim | verdict | confidence |
|------|-------|---------|------------|
| 6.1 | No per-result persistence: oversized single tool result dumps full content into context | **real** | high |
| 6.2 | No per-turn aggregate budget: many medium results sum past 100 KB unchecked | **real** | high |
| 6.3 | No microcompact of old tool results | **real** | high |
| 6.4 | Compaction is "manual-only via compact() RPC; no auto-trigger" | **partial** (claim is overstated — auto-compaction exists via pi-coding-agent; what's missing is configurable threshold/buffer + user override) | high |
| 6.5 | No compaction failure cooldown / circuit breaker | **real** | high |
| 6.6 | After compaction, read-dedup cache still says "already read" | **real** (but blocked on Goal 3.1: Bobbit has no read-dedup cache to reset yet; the compaction event hook does already exist) | high |

---

## Goal 6.1 — Per-result persistence

**Doc claim.** Single tool calls (long shell, large grep) dump tens of thousands of chars into context. Need per-tool `max_result_chars`, persist over-cap to `.bobbit/state/tool-results/<session>/<id>.txt`, return preview + `<persisted-output>` envelope.

**Bobbit reality.** No tool-result spillover layer. Truncation lives **inside individual tool implementations**:
- bash extension caps stdout/stderr at `MAX_BYTES = 50 * 1024` / `MAX_LINES = 2000` (`.bobbit/config/tools/shell/extension.ts:23-24`, per audits/bobbit.md:82). Truncation is **destructive in-line**: trailing notice + temp-file path, but no `<persisted-output>` envelope, no agent-discoverable preview-then-read-full pattern.
- `read`, `grep`, `find` truncated by upstream `pi-coding-agent`'s `dist/core/tools/truncate.js:11-13` (`DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50*1024`).
- No `src/server/agent/tool-result-store.ts`, no `truncate-large-content.ts`, no `/api/sessions/:id/tool-content/...` endpoint:
  ```
  $ grep -rn "tool-results\|persisted-output\|maxResultSize\|max_result_size" src/ .bobbit/
  (no matches)
  ```
- No per-tool `max_result_chars` field in any `.bobbit/config/tools/**/extension.yaml`.

**Claude Code reality.** Native pipeline:
- `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` (`src/constants/toolLimits.ts:13`).
- Per-tool `maxResultSizeChars` declared on every tool (`Tool.ts:357` schema; e.g. Read pinned at `Infinity`, `FileReadTool.ts:282`).
- `getPersistenceThreshold()` (`src/utils/toolResultStorage.ts:55-78`) clamps per-tool overrides to the global default.
- Over-cap results written to `<projectDir>/<sessionId>/tool-results/<toolUseId>.{txt|json}` (`toolResultStorage.ts:106-112`); model gets a 2 KB preview (`PREVIEW_SIZE_BYTES = 2000`) wrapped in `<persisted-output>...</persisted-output>` (`toolResultStorage.ts:30-31`).
- BashTool spills outputs up to `MAX_PERSISTED_SIZE = 64 MB` (`BashTool.tsx:734`).

**Hermes reality.** `tools/tool_result_storage.py` is the explicit reference cited in the goal:
- `maybe_persist_tool_result` (`:116-172`) — per-tool threshold from `BudgetConfig.resolve_threshold(name)`; default 100 000 chars; `read_file` pinned to `inf` so it never persists (`budget_config.py:13`).
- Writes via `env.execute()` heredoc into the **active backend's** tmpdir (`${TMPDIR}/hermes-results/<tool_use_id>.txt`, `tool_result_storage.py:43-87`) so it works on local/Docker/SSH/Modal/Daytona.
- Returns `<persisted-output>` block with original size, file path, and 1500-char preview (`generate_preview`, `:60-69`; `_build_persisted_message`, `:90-114`).

**Verdict.** **real** — Bobbit has only inline tool-internal truncation. No spillover-to-disk + preview-with-path envelope. Both reference impls (CC and Hermes) match the goal's design almost identically.

**Minimal proof of gap.**

Bobbit (no spillover layer; tool truncates in place):
```ts
// .bobbit/config/tools/shell/extension.ts:23-24 (per audits/bobbit.md:82)
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
// truncation produces an inline notice + temp-file path, but the full content
// is not addressed by a per-tool persistence threshold / <persisted-output> tag
// and no other tools persist at all.
```

Hermes (reference):
```python
# tools/tool_result_storage.py:144-162
if len(content) <= effective_threshold:
    return content
storage_dir = _resolve_storage_dir(env)
remote_path = f"{storage_dir}/{tool_use_id}.txt"
preview, has_more = generate_preview(content, max_chars=config.preview_size)
if env is not None:
    if _write_to_sandbox(content, remote_path, env):
        return _build_persisted_message(preview, has_more, len(content), remote_path)
```

**Scope-down notes.** None. Goal as written tracks closely with Hermes's implementation; would only suggest adopting the `read` opt-out (`Infinity` threshold) to prevent persist→read→persist loops — both CC and Hermes guard this and the goal's spec doesn't mention it.

---

## Goal 6.2 — Per-turn aggregate budget

**Doc claim.** No per-turn cap; many medium outputs in one turn sum past 100 KB. Need 200 KB aggregate budget; persist largest-first.

**Bobbit reality.** No aggregate accounting. `src/server/agent/rpc-bridge.ts` has no turn-end size summation (`grep -rn "turn.budget\|TURN_BUDGET" src/server/` returns nothing). Each tool independently truncates inline; there is no cross-tool budget.

**Claude Code reality.** `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000` (`src/constants/toolLimits.ts:48`, per audits/claude-code.md:177,287). When N parallel tool results in one user message exceed this, the **largest are persisted first** through the same `toolResultStorage.ts` pipeline.

**Hermes reality.** Goal's reference is exact: `enforce_turn_budget` (`tools/tool_result_storage.py:178-226`); `DEFAULT_TURN_BUDGET_CHARS = 200_000` (`tools/budget_config.py:19`). Largest-first persistence pattern — identical to CC.

**Verdict.** **real** — Bobbit has no analogue at the gateway layer. Both reference impls are at the same number (200 000) using the same biggest-first algorithm.

**Minimal proof of gap.**

Bobbit:
```bash
$ grep -rn "MAX_TURN_BUDGET\|enforce_turn_budget\|MAX_TOOL_RESULTS_PER_MESSAGE" src/
(no matches)
```

Hermes (reference, `tools/budget_config.py:19`):
```python
DEFAULT_TURN_BUDGET_CHARS = 200_000
```
+ `enforce_turn_budget(...)` at `tool_result_storage.py:178-226` — sums result sizes after a turn's tool calls complete and persists largest-first via `maybe_persist_tool_result` until under budget.

**Scope-down notes.** None. Builds directly on 6.1 — must land 6.1 first.

---

## Goal 6.3 — Microcompact old tool results

**Doc claim.** Periodic sweep replaces old `read`/`grep`/`find`/`bash`/`edit`/`write`/`patch` tool results with one-line summaries; preserve metadata.

**Bobbit reality.** No microcompact. The compaction layer Bobbit inherits from `@mariozechner/pi-coding-agent` (`dist/core/compaction/compaction.js`) is **whole-conversation summarisation gated on token-window proximity** (`shouldCompact` at `:142-146`) — it has no per-message tool-result rewriting pass. There is no `src/server/agent/microcompact.ts`. `grep -rn "microcompact\|prune_old_tool" src/` returns nothing.

**Claude Code reality.** `src/services/compact/microCompact.ts` (cited by the goal). Two paths:
1. Time-based (`:166`): if gap to last assistant message exceeds threshold (server cache expired anyway), content-clear old tool results before sending. Placeholder `[Old tool result content cleared]` (`:35`).
2. Cached microcompact (`:185`): uses Anthropic cache-editing API to remove tool results from the server cache without invalidating the prefix (`pinCacheEdits`, `cachedMicrocompact.ts`).

Compactable tool set (`microCompact.ts:39-49`): `FILE_READ`, `SHELL_TOOL_NAMES` (Bash/PowerShell), `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Edit`, `Write`.

**Hermes reality.** `_prune_old_tool_results` (`agent/context_compressor.py:494-668`), no LLM call:
- Pass 1 (`:602-624`) — md5-dedupe identical tool results, replace older copies with `"[Duplicate tool output — same content as a more recent call]"`.
- Pass 2 — replace old tool results (>200 chars, outside protected tail) with informative one-line shape summaries via `_summarize_tool_result` (`:204-310`); knows `terminal`, `read_file`, `write_file`, `search_files`, `patch`, `browser_*`, `web_search`, `web_extract`, `delegate_task`, `execute_code`, `vision_analyze`, `memory`, `todo`, …

**Verdict.** **real**. Two strong reference impls.

**Minimal proof of gap.**

Bobbit (only whole-session summarisation, not per-old-result):
```js
// node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js:142-146
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
```

Claude Code (reference):
```ts
// src/services/compact/microCompact.ts:39-49
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME, GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME,
])
```

**Scope-down notes.** Doc proposes "every N turns or before compaction." Reference impls run microcompact *every turn* (CC time-based; Hermes inside `compress`); cheaper per call than the doc's batch model. Recommend matching reference impls.

---

## Goal 6.4 — Auto-compaction trigger

**Doc claim.** "Compaction is manual-only via `compact()` RPC. Long sessions blow context unless the user types a command."

**Bobbit reality.** Auto-compaction **does** exist at the underlying-agent layer (audits/bobbit.md:247 explicitly flags this as a comparison.md discrepancy):
- `auto_compaction_start` / `auto_compaction_end` events handled at `src/server/agent/session-manager.ts:487-491`.
- `shouldCompact()` in `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js:142-146` triggers when `contextTokens > contextWindow − reserveTokens`.
- Defaults: `reserveTokens: 16384`, `keepRecentTokens: 20000` (`compaction.js:61-62`). Bobbit does **not** override these and exposes no user-facing knob.

What's missing relative to the doc's design:
- No `auto_compact_threshold_pct` / `auto_compact_buffer_tokens` session-config field (`grep -rn "auto_compact\|threshold_pct" src/server/` finds nothing in Bobbit code).
- No env override (CC has `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`).
- The manual `compact()` RPC at `rpc-bridge.ts:146-148` exists alongside the auto path; the goal's framing ("manual-only") is **wrong**.

**Claude Code reality.** `src/services/compact/autoCompact.ts`:
- `AUTOCOMPACT_BUFFER_TOKENS = 13_000` (`:62`).
- Threshold = effective context window − buffer (`getAutoCompactThreshold`, `:73`).
- Env overrides `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`:80-83`).
- Tracks `consecutiveFailures` for the circuit breaker (Goal 6.5).

**Hermes reality.** 75 % threshold inside `agent/context_compressor.py`; protect first 3 + last 20 messages; rebuilds system prompt only after compaction (`run_agent.py:4737-4742`).

**Verdict.** **partial.** The "trigger" itself already fires in Bobbit (via pi-coding-agent), so the goal's premise that compaction is manual-only is incorrect. The real, surviving deltas are:
1. Make threshold configurable per-session (% of window or buffer-tokens) — doc spec is right on this point.
2. Surface user override / disable.
3. Document/expose the existing knob (`reserveTokens=16384` defaults).

**Minimal proof of gap (scoped).**

Bobbit (auto-compact wires through but no Bobbit-level config):
```ts
// src/server/agent/session-manager.ts:487-491
} else if (event.type === "auto_compaction_start") {
    session.isCompacting = true;
} else if (event.type === "auto_compaction_end") {
    session.isCompacting = false;
    if (!event.aborted) this.refreshAfterCompaction(session);
}
```
```js
// node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js:61-62
reserveTokens: 16384,
keepRecentTokens: 20000,
```
No code path lets a Bobbit user override these.

Claude Code (configurable trigger):
```ts
// src/services/compact/autoCompact.ts:62, 80-83
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
```

**Scope-down notes.** Rewrite the goal's "Problem" line. Real problem is **non-configurable, non-surfaceable** auto-compact threshold, not "manual-only." Acceptance criteria #1 ("Threshold breach triggers compaction automatically") is already satisfied today; only #2/#3 (override, disable) remain.

---

## Goal 6.5 — Compaction failure cooldown

**Doc claim.** Failed `compact()` (model error) without a cooldown can loop. Need 600 s cooldown + 3-strike circuit break.

**Bobbit reality.** No cooldown / circuit breaker at the gateway:
- `src/server/ws/handler.ts:262-283` handles compact failures by broadcasting `compaction_end success:false` and logging — **no last-failure timestamp, no consecutive-failure counter**:
  ```ts
  // src/server/ws/handler.ts:278-283
  } catch (err) {
      console.error(...);
      broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: false, error: err.message } });
  ...
  ```
- `grep -rn "cooldown\|FAILURES\|consecutive" src/server/agent/ src/server/ws/` only matches the **watchdog** for HTTP probes (`src/server/watchdog.ts:120,316`) — unrelated to compaction.

**Claude Code reality.** `src/services/compact/autoCompact.ts:65-70`:
```ts
// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```
+ `consecutiveFailures` field on `AutoCompactTrackingState` (`:50-58`).

**Hermes reality.** `agent/context_compressor.py:74` `_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600`; checked at `:886-891` (`_summary_failure_cooldown_until`). Plus `_ineffective_compression_count >= 2` anti-thrashing skip (`:476-486`) — disables compaction with `/new` recommendation.

**Verdict.** **real.**

**Minimal proof of gap.**

Bobbit:
```ts
// src/server/ws/handler.ts:278-283  — failed compact silently retries on next trigger
} catch (err) {
    broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: false, error: err.message } });
}
```

Claude Code (reference):
```ts
// src/services/compact/autoCompact.ts:67-70
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

Hermes (reference):
```python
# agent/context_compressor.py:74
_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600
```

**Scope-down notes.** Implement both: a 600 s timestamp gate **and** a 3-strike counter. Hermes's anti-thrash guard (`_ineffective_compression_count`, two compactions saving <10 %) is also worth adopting — it catches the case where compaction "succeeds" but produces no headroom, distinct from a hard failure.

---

## Goal 6.6 — Read-state reset post-compaction

**Doc claim.** After compaction, file content may be gone but read-dedup cache (Goal 3.1) still says "already read" — agent gets misleading stubs. Subscribe to compact start/end; on end, clear read-dedup cache.

**Bobbit reality.**
- **No read-dedup cache exists yet** — audits/bobbit.md:193-196: "No dedup of identical `read` results, no loop-guard on repeated identical tool calls, no 'this file was just read' suppression." So the *symptom* the goal describes can't occur today.
- **The compaction event hook does already exist** — `src/server/agent/session-manager.ts:487-491` already handles `auto_compaction_end` and calls `this.refreshAfterCompaction(session)` (`:1428-1440`); easy place to fan out a `clearReadCache(session.id)` once Goal 3.1 lands.

**Claude Code reality.** Audit doesn't surface a dedicated post-compact dedup-clear (CC's read dedup is in `FileFreshnessTracker`); after `/compact`, the post-compact path in `compact.ts:122-130` actively re-injects up to 5 recently-edited files / 50 K tokens, which sidesteps the stale-read problem from the other direction.

**Hermes reality.** Explicit: `run_agent.py:8993-8994` (per audits/hermes.md:185):
```python
from tools.file_tools import reset_file_dedup
reset_file_dedup(task_id)
```
Fired immediately after `compress` finishes.

**Verdict.** **real**, but **strictly downstream of Goal 3.1**. The bug it prevents only exists once a read-dedup cache exists.

**Minimal proof of gap.**

Bobbit (post-compaction hook exists, nothing to clear yet):
```ts
// src/server/agent/session-manager.ts:489-491
} else if (event.type === "auto_compaction_end") {
    session.isCompacting = false;
    if (!event.aborted) this.refreshAfterCompaction(session);
}
```

Hermes (reference, paired with their read-dedup):
```python
# run_agent.py:8993-8994
from tools.file_tools import reset_file_dedup
reset_file_dedup(task_id)
```

**Scope-down notes.**
- Mark this dependent on Goal 3.1; do not start until 3.1 lands.
- Implementation is trivial (single line in the `auto_compaction_end` branch + an exported `clearReadCache(sessionId)` from `file-state.ts`). Effort tag XS is correct.
- Also wire it into the **manual** `compact` path (`src/server/ws/handler.ts:262-283`), which the doc's "Approach" implies but doesn't list — the manual path goes through the same `compact()` RPC and produces the same staleness window.
