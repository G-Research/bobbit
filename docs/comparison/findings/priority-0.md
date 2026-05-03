# Priority 0 — Measure Before Optimising

Source trees inspected (read-only):
- Bobbit: `/Users/aj/Documents/dev/bobbit`
- Claude Code: `/Users/aj/Documents/dev/claude-code`
- Hermes Agent: `/Users/aj/Documents/dev/hermes-agent`

Phase-A audits cross-referenced: `audits/bobbit.md` lines 165–183, `audits/claude-code.md` 188–229, `audits/hermes.md` 139–167.

## Verdict summary

| Goal | Claim | Verdict | Confidence |
|---|---|---|---|
| 0.1 | No section-by-section prompt budget visibility | partial | high |
| 0.2 | No `<id>.budget.json` persisted alongside prompts | real | high |
| 0.3 | No UI warning when prompt is bloated at session start | real | high |
| 0.4 | CostTracker captures cache R/W tokens but no `cacheHitRate` is surfaced | partial | high |
| 0.5 | No per-turn aggregate tool-output byte metric or warning | real | high |

---

## Goal 0.1 — Section-by-section prompt budget

**Doc claim.** Bobbit assembles the system prompt from many sources and has no visibility into which section contributes how much; instrument `system-prompt.ts` to return `{name, content, chars, tokensEstimate}` per section, aggregated into a `PromptBudget`.

**Bobbit reality.** Section-level decomposition already exists. `getPromptSections(parts)` returns a labelled `PromptSection[]` covering exactly the sections the doc lists (system prompt, AGENTS.md, CLAUDE.md, Claude Code memories, memory hint, goal, role, tool-restrictions, personality, tools, task, workflow context). The HTTP endpoint `GET /api/sessions/:id/prompt-sections` already exposes them, and the UI consumes it via `SystemPromptDialog`.

```ts
// src/server/agent/system-prompt.ts:307-310
export function getPromptSections(parts: PromptParts): PromptSection[] {
  const sections: PromptSection[] = [];
  ...
}
// src/server/server.ts:2974
const promptSectionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-sections$/);
// src/ui/dialogs/SystemPromptDialog.ts:41
const resp = await gatewayFetch(`/api/sessions/${this.sessionId}/prompt-sections`);
```

What is **missing** vs the doc: each `PromptSection` carries only `{label, source, content}` — no `chars`, no `tokensEstimate`, no aggregated `PromptBudget`, no persisted artifact, no `enabled` flag.

**Claude Code reality.** Has the richer per-section breakdown the goal describes, with token counts (not char counts) computed via the provider's `countTokensWithFallback`:

```ts
// src/utils/analyzeContext.ts:152-156, 305-309
export interface SystemPromptSectionDetail { name: string; tokens: number }
...
const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map(
  (entry, i) => ({ name: entry.name, tokens: systemTokenCounts[i] || 0 }),
);
```

Section names extracted from first markdown heading (`extractSectionName`, `analyzeContext.ts:259-269`). Static-vs-dynamic boundary already encoded as `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`src/constants/prompts.ts:114-115`).

**Hermes reality.** No per-section budget object, but ships the exact `chars/4` token estimator the doc proposes:

```py
# agent/model_metadata.py:1434-1444
def estimate_tokens_rough(text: str) -> int:
    if not text: return 0
    return (len(text) + 3) // 4
```

Plus `estimate_request_tokens_rough(messages, system_prompt, tools)` which sums system+messages+tools (`model_metadata.py:1453-1480`) — the closest analogue to a coarse `PromptBudget.totalTokensEstimate`.

**Verdict.** **partial.** The decomposition layer the doc asks for already exists and is even already exposed over HTTP and rendered in the UI; only the per-section size metadata and the aggregated `PromptBudget` envelope are missing.

**Reasoning.** The "no visibility into which section contributes" framing is too strong — the section split is in-tree. The genuine gap is "annotate each section with `chars` + `tokensEstimate` and surface a `PromptBudget` aggregate".

**Minimal proof of gap.**
```ts
// Bobbit src/server/agent/system-prompt.ts:165-170
export interface PromptSection {
  label: string;
  source: string;
  content: string;     // ← no chars, no tokensEstimate, no enabled flag
}
```
vs Claude Code `SystemPromptSectionDetail { name; tokens }` (`analyzeContext.ts:152`) — same idea with the missing metric attached.

**Scope-down notes.** Reframe goal as "annotate the existing `PromptSection` with `chars` and `tokensEstimate` and add a `PromptBudget` wrapper". Skip the new endpoint/UI work — both already exist; just extend the wire format. Use Hermes' `(len+3)//4` estimator verbatim.

---

## Goal 0.2 — Persisted prompt diagnostics

**Doc claim.** Assembled prompts are saved to `.bobbit/state/session-prompts/<id>.md`; write a parallel `<id>.budget.json` capturing the `PromptBudget`, toolset, mode, role.

**Bobbit reality.** Confirmed: prompts are persisted, no budget sidecar.

```ts
// src/server/agent/system-prompt.ts:6
const PROMPTS_DIR = path.join(bobbitStateDir(), "session-prompts");
// src/server/agent/system-prompt.ts:296-300
const promptPath = path.join(PROMPTS_DIR, `${sessionId}.md`);
fs.writeFileSync(promptPath, combined, "utf-8");
return promptPath;
```

`grep -rn "budget.json\|PromptBudget\|sectionBudget\|tokensEstimate" src` returns zero matches. Audit confirms: `audits/bobbit.md:177-180` only describes the prompt file and section composition, no diagnostics file.

**Claude Code reality.** Computes the equivalent diagnostic (`analyzeContextUsage` in `src/utils/analyzeContext.ts`) but does **not** persist it as a sidecar — it is rendered live in the `/context` UI. So the persistence pattern is novel; only the data model is portable.

**Hermes reality.** No prompt-sidecar file. System prompt is cached on `self._cached_system_prompt` and rebuilt only on compaction (`run_agent.py:4737-4742`, audit hermes.md:139). Session-level token estimates are computed but not written to a sidecar JSON.

**Verdict.** **real** (small).

**Reasoning.** Goal is genuinely unimplemented in Bobbit; the comparison harnesses don't have the exact sidecar pattern but both have the underlying data model that would populate it. Scope is XS as the doc says — depends on Goal 0.1.

**Minimal proof of gap.** `find /Users/aj/Documents/dev/bobbit/.bobbit/state/session-prompts -maxdepth 1 -name "*.budget.json"` returns nothing in any audit; no code path writes it.

**Scope-down notes.** Bundle with 0.1 — once the `PromptBudget` exists in memory, persisting it is a one-liner.

---

## Goal 0.3 — UI warnings for bloated sessions

**Doc claim.** No banner today; emit one when `totalChars > 32 KB` (warn) / `64 KB` (error), listing top 3 contributing sections.

**Bobbit reality.** No threshold or banner anywhere. `grep -rn "warn.threshold\|prompt_budget\|budget_warn\|bloated" src .bobbit` (any extension) returns no matches. The cost popover (`src/ui/components/CostPopover.ts`) shows post-hoc spend, not pre-flight prompt size.

**Claude Code reality.** Has `autoCompactThreshold` and `isAutoCompactEnabled` driven from the same context analysis (`analyzeContext.ts:213-214`):

```ts
// src/utils/analyzeContext.ts:213-214
readonly autoCompactThreshold?: number
readonly isAutoCompactEnabled: boolean
```

Surfaced via the `/context` slash command and the auto-compact UI. Different shape (compaction trigger, not a session-start banner) but same idea — pre-emptive warning when token use is high.

**Hermes reality.** Pre-flight checks via `estimate_request_tokens_rough` (`model_metadata.py:1453-1480`); used at request time to refuse oversized requests. Not a UI banner — but the policy primitive (compute total, compare to threshold) is in-tree.

**Verdict.** **real.**

**Reasoning.** Bobbit ships nothing in this space. CC and Hermes both have the underlying threshold-and-warn concept; the goal's specific UI shape is novel and well-scoped (XS).

**Minimal proof of gap.**
```
// Bobbit: no match for prompt_budget_warn_chars / banner
$ grep -rn "prompt_budget_warn\|prompt_budget_error" src .bobbit
(no output)
```
vs CC `autoCompactThreshold` (`analyzeContext.ts:213`).

**Scope-down notes.** Trivial once 0.1 lands. Default thresholds (32 KB / 64 KB) are aggressive — most managed-mode prompts already exceed 32 KB once AGENTS.md is included; consider 64 KB / 128 KB or token-based thresholds.

---

## Goal 0.4 — Cache-hit metric

**Doc claim.** CostTracker captures `cacheReadTokens`/`cacheWriteTokens` but the resulting hit rate is not surfaced; add `cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)`, show as session-list column and dashboard tile.

**Bobbit reality.** Confirmed: per-session cache-R/W token totals exist, hit-rate ratio does not.

```ts
// src/server/agent/cost-tracker.ts:7-10
export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}
// src/ui/components/CostPopover.ts:108-111  (rendered as raw token rows, not as a hit-rate %)
if (agg.cacheReadTokens) rows.push({ label: "Cache read", tokens: agg.cacheReadTokens });
if (agg.cacheWriteTokens) rows.push({ label: "Cache write", tokens: agg.cacheWriteTokens });
```

`grep -rn "cacheHitRate\|hit.rate\|hitRate" src` returns no matches. Audit `bobbit.md:179-181` already noted the cache layer is provider-driven (pi-ai 2-breakpoint default), not Bobbit-driven, so this metric is the only feasible feedback loop short of writing a Bobbit-side cache strategy.

**Claude Code reality.** Aggregates the same primitives at model granularity:

```ts
// src/bootstrap/state.ts:713-717
return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
...
return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
// src/utils/stats.ts:333-335
modelUsageAgg[model]!.cacheReadInputTokens += ...
```

Plus `apiUsage.cache_read_input_tokens` / `cache_creation_input_tokens` in `analyzeContext.ts:226-230`. The percentage form isn't there as a single named field but the numerator/denominator are both surfaced and the `/cost` slash command exposes them.

**Hermes reality.** Tracks the raw numbers per turn for compaction trigger logic but does not compute or render a hit-rate ratio (`prompt_caching.py:42-72`; `system_and_3` strategy with up to 4 ephemeral breakpoints, audit hermes.md:161). No `hit_rate` field in source.

**Verdict.** **partial.**

**Reasoning.** The data is fully in-tree — only the derived ratio and its UI surface are missing. The framing "without visibility, work in Goal 10.* cannot be evaluated" is fair; but the work is one display formula plus a column.

**Minimal proof of gap.** Bobbit's cost model has the inputs but not the ratio (cost-tracker.ts:7-10 above). Adding it would be 5 lines.

**Scope-down notes.** Demote to XS. Don't need a new dashboard tile if the existing `CostPopover` can render `cacheHitRate %` next to the totals it already shows. Per-mode aggregation only useful once Goal 1.1 introduces `mode`.

---

## Goal 0.5 — Per-turn output budget meter

**Doc claim.** Many medium tool outputs in one turn can sum to 100 KB+ unnoticed; track per-turn aggregate tool-output bytes, log `{turnIndex, toolCount, totalBytes, perToolBytes[]}`, warn over 200 KB.

**Bobbit reality.** No per-turn aggregate metric. `grep -rn "turnIndex\|perTurn\|per_turn\|aggregateToolOutput\|MAX_TURN_BUDGET" src` returns zero matches. Truncation is per-tool (inside individual tool implementations and the bash extension) — `audits/bobbit.md:182-183` confirms `max_tokens` is set per-call by pi-ai, but no aggregate-tool-result accounting layer exists. There is no `src/server/state/session-stats.ts`.

**Claude Code reality.** Exact pattern with the same 200 KB limit:

```ts
// src/constants/toolLimits.ts:49
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
// src/utils/toolResultStorage.ts:13, 433
import { ..., MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, ... } from '../constants/toolLimits.js'
return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
```

Used to spill the largest results to `<projectDir>/<sessionId>/tool-results/<toolUseId>.{txt|json}` (audit claude-code.md:316). GrowthBook flag `tengu_hawthorn_window` allows runtime override (`toolLimits.ts:46-48`).

**Hermes reality.** Identical mechanism, identical constant, exact reference cited by the doc:

```py
# tools/budget_config.py:19
DEFAULT_TURN_BUDGET_CHARS: int = 200_000
# tools/tool_result_storage.py:175-205
def enforce_turn_budget(tool_messages, env=None, config=DEFAULT_BUDGET):
    ...
    if total_size <= config.turn_budget:
        return tool_messages
    candidates.sort(key=lambda x: x[1], reverse=True)
    for idx, size in candidates:
        ...
        replacement = maybe_persist_tool_result(...)
```

Largest-first persistence into the active sandbox tmpdir. Audit `hermes.md:165-167` and `claude-code.md:316` both confirm this is the exact pattern at parity (200 000 chars).

**Verdict.** **real.**

**Reasoning.** Bobbit ships nothing in this space; both reference impls have it implemented identically with the same magic number; the goal's spec ("log + warn") is even leaner than what CC/Hermes already do (which is "log + warn + persist + replace"). High-value, low-cost.

**Minimal proof of gap.**
```
$ grep -rn "MAX_TURN_BUDGET\|turn_budget\|MAX_TOOL_RESULTS_PER_MESSAGE" /Users/aj/Documents/dev/bobbit/src
(no output)
```
vs Hermes `tools/budget_config.py:19` (`DEFAULT_TURN_BUDGET_CHARS = 200_000`) and CC `src/constants/toolLimits.ts:49` (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`).

**Scope-down notes.** The doc limits this goal to "log + UI warning". Worth flagging that both reference harnesses pair the meter with a *response* (persist-largest-first) — the meter without the response captures the metric but doesn't reduce cost. Likely natural to land 0.5 with the meter and treat the response as Priority 6 (`comparison.md`'s A4 axis).

---

## Cross-cutting notes

- All five goals depend on a coarse token estimator. Hermes' `(len+3)//4` (`agent/model_metadata.py:1434-1444`) is exactly what the doc calls for; recommend adopting it verbatim and avoiding the more accurate provider-specific token API used by CC (`countTokensWithFallback`) for now — the goal's stated intent is "good enough for budgeting".
- Goals 0.1 and 0.2 are tightly coupled and could ship in one PR. 0.3 follows trivially.
- Goal 0.4 is the only Priority-0 item where the data already exists end-to-end; it is the highest-leverage XS task in the section.
- The audit's note (`bobbit.md:251-252`) that the comparison row "None visible" for A3 cache strategy is too strong applies to 0.4: the cache *primitive* is two ephemeral breakpoints from pi-ai; the *metric* is what's missing, which is exactly what 0.4 fixes.
