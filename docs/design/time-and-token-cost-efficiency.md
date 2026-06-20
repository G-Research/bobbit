# Time & Token-Cost Efficiency — audit, findings, and remediation plan

Status: **investigation complete, remediation not started** · Audited: 2026-06-10 against
master @ `4e7fce1f`; **latency axis + architecture root-cause added 2026-06-19** (§9, from a
second 326-session snapshot — shapes corroborate §1). Workstream **CE** in
[fable-program-execution-plan.md](fable-program-execution-plan.md) (program sequencing +
master checklist).
Companion docs: [extension-platform-implementation-plan.md](extension-platform-implementation-plan.md)
(several goals here ride its pack surfaces), [comms-stack/04-current-state-and-backlog.md](comms-stack/04-current-state-and-backlog.md)
(overlapping retry findings).

**The question this answers:** Bobbit *feels* more expensive **and slower** per unit of work
than Claude Code or hermes-agent. Is it, why, and what do we change? (Cost: §1–§7. Wall-clock
latency and the inherent architectural root cause: **§9**.)

**The one-paragraph answer:** Prompt caching is working (only 0.008% of input tokens were
uncached across 246 sessions), so the spend is not a caching bug. The spend is
**resident-context size × API-request count × model price**: every tool-call round re-reads the
session's full context at cache-read price, Bobbit's resident context is large (18k–55k tokens
of system prompt before any conversation), tool results accumulate unbounded (no spill/truncation
tier), orchestration multiplies turns (idle nudges, verifier gates, repeated commands), and
every agent — lead, worker, reviewer — runs the same frontier model. Claude Code and Hermes are
cheaper because they cap tool output, spill large results to disk, keep resident prompts lean,
and (Hermes) summarize with a cheap auxiliary model. All of those are adoptable. The plan below
is instrumentation-first: we build the measurement/benchmark harness *before* the
behavior-affecting cuts, so every change is validated on data, not vibes.

---

## §0 Universal rules for executing this plan

Same rules as the extension-platform plan; restated because goals here will be handed off
independently:

1. **Test-first.** Every sub-goal lists pinning tests; write them RED before the fix where the
   spec says so. No flaky tests — a flaky test is a real bug.
2. **Locate code by symbol name, not line number.** Line anchors below were verified on
   master @ `4e7fce1f` and will drift. If a symbol is missing, STOP and re-derive from the
   pattern files, don't guess.
3. **Gates.** `npm run check` + `npm run test:unit` for everything; `npm run test:e2e` for
   server changes; `npm run test:manual` for session-lifecycle changes. Browser E2E for every
   user-facing surface (pattern: `tests/e2e/ui/settings.spec.ts`).
4. **Measurement gate (specific to this plan).** Goals marked **[BENCH-GATED]** change agent
   behavior (prompts, models, truncation). They may not merge on code review alone: run the
   benchmark suite (CE-G0.3) before and after on the same task set and attach the comparison to
   the PR. A regression in task success rate blocks the merge regardless of cost savings.
5. **Environment caveat.** Several SDK-layer findings below were verified against the *stale*
   `node_modules` (`@mariozechner/pi-* 0.67.5`) while `package.json` declares
   `@earendil-works/pi-* 0.77.0` and the fork's latest is **0.79.1**. CE-G1.0 re-verifies every
   SDK claim against the version actually adopted before any SDK-dependent goal starts.

---

## §1 Where the money actually goes (empirical)

All numbers measured 2026-06-10 from this machine. Reproduction recipes in §7. The owner notes
the codebase moves fast — re-measure before relying on any specific number; the *shapes* are the
durable findings.

### 1.1 Aggregate (`.bobbit/state/session-costs.json`, 246 sessions)

| Metric | Value |
|---|---|
| Total recorded spend | **$2,768.90** |
| Uncached input tokens | 284,670 (**0.008%** of input) |
| Cache-read tokens | **3,570,141,959** (3.57B) |
| Cache-write tokens | 125,505,474 |
| Output tokens | 8,097,011 |
| Median session cost | $4.37 |
| Top-10 sessions' share | **$1,420.50 (51%)** |

Verdict: **caching works**. The bill is dominated by cache *reads* — i.e., how big the resident
context is and how many API requests re-read it — plus output. Cache-read is ~10× cheaper than
fresh input, and we still spent ~$2.7k. Without working caching this history would have cost
five figures; with it, the levers left are context size, request count, and model price.

### 1.2 The outliers

| Session | Cost | cacheRead | cacheWrite | Output | What it is |
|---|---|---|---|---|---|
| `0dbda4f4` "Team Lead: Meg Abyte" | **$901.99** | 1,021M | 57.6M | 1.23M | team-lead orchestrator |
| `acce11b7` "Team Lead: Banksy" | $222.26 | 261M | 13.7M | 229k | team-lead orchestrator |
| `llm-review-69d1e3e3` | $46.73 | 77M | 1.0M | 77k | workflow gate verifier |
| `llm-review-0cd4b16b` | $41.14 | 63M | 1.1M | 90k | workflow gate verifier |
| (next 6, all llm-review or team) | $29–40 each | 37–64M | ~1M | 80–103k | — |

Two shapes account for the tail:

- **Long-lived team-leads.** The 35KB team-lead role + goal + AGENTS.md + tools is resident for
  the session's whole life; every coordination turn (nudge, status steer, gate event) re-reads
  it. 1.02B cache-read tokens ≈ thousands of API requests × a six-figure-token context.
- **`llm-review` verifiers** (`verification-harness.ts::runLlmReviewStep`, spawn at
  `verification-harness.ts:2542`). One-shot reviewers that re-ingest role + AGENTS.md + goal
  spec + the change under review, do tens of tool-call rounds each (each round = full
  context re-read), with up to 3 bounded retries — at $29–47 a pop in the tail, these run on
  every gated workflow step.

### 1.3 Resident prompt anatomy (`.bobbit/state/session-prompts/*-prompt.json`)

Recent sessions in this repo (tokens, from the persisted inspector snapshots):

| Section | Recent typical | Worst observed | Source |
|---|---|---|---|
| Role | 6,254 (code-reviewer) | **20,180** (older review session) | `defaults/roles/*.yaml` |
| Project AGENTS.md | **9,021** | 17,309 | `readAllAgentFiles()` cascade — *project-dependent*: the 9k example is another project's hand-written playbook; this repo's AGENTS.md is ~1.3k tokens |
| Tools | 5,600 | 6,565 | `toolManager.getToolDocsForPrompt()` |
| System Prompt | 3,855 | 3,855 | `.bobbit/config/system-prompt.md` (15.5KB) overriding `defaults/system-prompt.md` (18.8KB) |
| Goal | 650–2,100 | 7,856 | user-authored goal spec |
| Available Skills | 150 | ~2,000 | budget-capped (`SKILLS_CATALOG_BUDGET` 16KB) |
| Working Directory | 206 | 206 | template |
| **Total resident** | **~18k–26k** | **~55k** | before any conversation history |

Role files on disk: `team-lead.yaml` **35,491 chars** (~8.9k tokens — 40% of the whole
`defaults/roles/` corpus), `qa-tester` 9.9KB, `docs-writer` 6.7KB, `code-reviewer` 5.6KB.

Key ratio: **Role + AGENTS.md = 60–68% of resident prompt tokens** in the measured sessions.
The base system prompt everyone assumes is the problem is only ~7%.

### 1.4 Transcript anatomy (`~/.bobbit/agent/sessions/`, 971MB total; `.bobbit/state` 258MB)

Three representative sessions:

| Session | Size | Assistant msgs | Shape |
|---|---|---|---|
| `audit-subg-…` (goal work) | 18.0MB | 1,771 | bash = **56%** of 1,727 tool calls; `read` 233 calls / 747KB returned (max single read 41KB); grep up to 48KB per result |
| `nested-goa-…` (team) | 14.5MB | 2,644 | **30+ idle-agent nudge turns**; `git push … \| tail -3` executed **17× identically**; `npm run check` 9×; team_spawn/task churn |
| `session-_pool-…` (images) | 7.2MB | 19 | 3 `generate_image` results = **5.1MB of base64 (73% of the transcript)** |

These three patterns — uncapped tool results accumulating in history, coordination turns that
each re-read full context, and multi-MB base64 images living in context — are the per-turn
multiplier on top of the resident-prompt floor.

### 1.5 The SDK version situation

| Layer | Version | Note |
|---|---|---|
| `package.json` / lockfile | `@earendil-works/pi-* `**0.77.0** | the fork is already adopted on paper |
| `node_modules` (this machine) | `@mariozechner/pi-*` **0.67.5** | stale install — `src/` still imports `@mariozechner/*` paths in places (`rg "@mariozechner/pi" src/`) |
| Fork latest | **0.79.1** (2026-06-09) | github.com/earendil-works/pi |
| Upstream latest | 0.73.1 (2026-05-07) | effectively superseded by the fork |

Fork releases since 0.67 ship several fixes we currently pay for not having:

- **0.76.0** — `excludeFromContext` on the bash RPC command (keep command output out of model
  context); `retry.provider.maxRetries` honored with **SDK retries defaulting to 0** (this is
  the fix for the double-retry stack — Bobbit's ~1s retry racing the SDK's hidden 2s retry —
  catalogued as F5 in the comms-stack audit); better context-overflow detection.
- **0.77.0** — `--exclude-tools` (drop unused built-ins per session); session disposal aborts
  in-flight compaction/retry/bash; `streamingBehavior` on input events.
- **0.78.1** — `ctx.getSystemPromptOptions()` for extensions.
- **0.79.0** — **prompt cache-hit rate surfaced** (`CH` in pi's footer — the measurement we
  want, already computed SDK-side); compaction summarization prompt fix.
- **0.79.1** — Claude Fable 5 + adaptive thinking/`xhigh`.

---

## §2 The cost model (how to think about every change)

Per API request: `cost ≈ resident_tokens × p_cacheRead + new_tokens × p_cacheWrite + output_tokens × p_output`

Per session: `cost ≈ Σ_turns Σ_toolRounds(turn) [above]` — **each tool-call round inside a turn
is its own API request that re-reads everything**.

So there are exactly four levers, and every goal in §6 maps to one:

| Lever | Goals |
|---|---|
| **L1 — shrink resident context** (prompt diet, tool-result budgets, image-by-reference, compaction) | CE-G2, CE-G4, CE-G6 |
| **L2 — cut request count** (turn economy: nudges, repeated commands, verifier scoping, discovery efficiency) | CE-G3, CE-G7 |
| **L3 — cheaper price per token** (model/thinking tiering per role/stage) | CE-G5 |
| **L4 — stop paying twice** (retry dedup, SDK upgrade hygiene) | CE-G1 |

Worked example: an llm-review session with 63M cache-read tokens at ~150k resident context ≈
~420 API requests. Halving the resident context (L1) *and* running it on a model with ⅓ the
price (L3) is a ~6× cost reduction on that session class with zero reduction in rounds.

---

## §3 Findings (ranked, with evidence and difficulty)

Severity = estimated share of current spend addressable. Difficulty = engineering risk
including behavior change. Anchors verified on master @ `4e7fce1f`.

### F1 — No tool-result budget tier (HIGH, difficulty M)
Tool results enter history verbatim and stay there for the session's life; every later request
re-reads them. Largest observed: 48KB grep results, 41KB single reads, 13–51KB bash logs.
`truncateLargeToolContent()` exists (`src/server/agent/truncate-large-content.ts`, referenced at
`session-manager.ts:45`) but is applied opportunistically, not as a systematic policy. Neither
per-result spill-to-disk nor a per-turn aggregate budget exists. Compare Hermes' three-layer
system (§5). *Caveat: verify against pi 0.79.1 — fork may have added caps (CE-G1.0).*

### F2 — Resident prompt floor is 18k–55k tokens, dominated by Role + AGENTS.md (HIGH, difficulty M–L, behavior-affecting)
§1.3. `team-lead.yaml` alone is 8.9k tokens of always-resident prose, much of it recipe-style
content that could live in skills/docs loaded on demand. The AGENTS.md cascade
(`system-prompt.ts::readAllAgentFiles`, recursive `@ref` resolution, depth 5) has **no token
budget** — a verbose project playbook silently costs its tokens × every request of every
session in that project.

### F3 — Orchestration turn multiplication (HIGH for team sessions, difficulty M)
The two most expensive sessions ever are team-leads (§1.2). Contributors: idle-agent nudges
(30+ observed in one session; templates in `team-manager.ts` ~1165–1254, debounce exists —
`WORKER_IDLE_NUDGE_DEBOUNCE_MS = 5s`, exponential backoff for lead idle — but each nudge is
still a full turn at full resident context); worker status steers per task transition; gate
inspections (5 × ~13KB observed). The nudge *text* is small (~85 tokens); the **turn it forces
is not** — at a 100k-token resident context, every nudge turn costs ~$0.03–0.15 in cache reads
alone before the model does anything.

### F4 — Uniform frontier model everywhere (HIGH, difficulty S–M)
Workers, verifiers, and assistants inherit the lead's/session default model and thinking level.
The override *mechanism* exists (`review-model-override.ts::applyReviewModelOverrides`,
`clampReviewThinking` in `verification-harness.ts`; `initialModel` pin in
`session-setup.ts::resolveBridgeOptions`) but there are no tiered **defaults**: nothing says
"llm-review verifiers default to a cheap model" or "coder workers run one tier below the lead".
The owner already wants multi-model pipelines (extension-platform P8/P9 model-selector); this
finding is the static-default version of that.

### F5 — llm-review economics (MED-HIGH, difficulty M)
$29–47 per review at the tail (§1.2), and reviews run per gated workflow step with up to 3
bounded retry attempts (`verification-harness.ts:~2550`). Each reviewer re-ingests the full
resident stack even when the reviewed artifact is a small diff. No diff-scoped context, no
cheap-model default, no cap on tool-call rounds.

**Refinement (2026-06-19): verifier cache economics are *inverted* — write-bound, not
read-bound.** §1.1's headline ("the bill is cache reads") is a global average that does **not**
hold for the `llm-review` class. Measured on the 2026-06-19 snapshot (189 verifier sessions),
cache *writes* are 40–48% of each verifier's (write+read) tokens, vs a 3% global write/read
ratio. Converting to base-input-equivalent units (write ×1.25, read ×0.1, fresh ×1.0):

| Class | write share | read share | fresh share |
|---|---|---|---|
| Verifiers (`llm-review`, n=189) | **34%** | 51% | 15% |
| Work sessions (n=144) | 23% | 68% | 9% |

The cause is structural (see §9): each verifier is a **separate, short-lived OS process** that
writes the full resident stack *cold* and dies before the cache write amortises — it can never
inherit the lead's warm cache. **Remediation implication:** for verifiers the dominant lever is
cold-**write** bytes (shrink the resident context per spawn — CE-G8.2) and/or warm-cache reuse
(CE-G8.4), **not** request-count reduction as CE-G3.3 frames it. Re-scope CE-G3.3 accordingly.

### F6 — Images as base64 in context (MED overall, EXTREME per-incident, difficulty S)
One `generate_image` result = 2.4–2.7MB of base64 in the transcript and in context; 73% of a
$10.75 session was image bytes. Results should be written to disk and returned by reference
(path + dimensions + thumbnail for the UI), never inlined into model context.

### F7 — Repeated identical commands (MED, difficulty S)
`git push … | tail -3` ×17, `npm run check` ×9 in single sessions. Each repeat is a full
request round. No guard, hint, or memoization exists.

### F8 — Stale SDK + double retry billing (MED, difficulty S)
§1.5. Running 0.67.5 forfeits `excludeFromContext`, `--exclude-tools`, retry control, and
cache-hit telemetry. The SDK's hidden default-on retry (~2s) underneath Bobbit's own auto-retry
(`session-manager.ts:2594–2656`) can double-bill failed turns — fixed by fork 0.76.0's
`retry.provider.maxRetries` honoring, **if we upgrade and set it**.

### F9 — No per-turn cost instrumentation (BLOCKER for everything else, difficulty S–M)
`session-costs.json` (`cost-tracker.ts`, recorded from `message_end` usage at
`session-manager.ts:~3103`) is **cumulative per session only**. No per-turn deltas, no cache-hit
ratio surfaced in Bobbit's UI, no per-goal/per-project rollup, no compaction-cost attribution.
We cannot currently answer "what did this nudge/turn/verifier cost" without jq archaeology —
which is why this audit needed one.

### F10 — Discovery inefficiency: bash is 54–56% of all tool calls (MED, difficulty S–M)
Agents shell out for grep/find/cat instead of using capped tools with offsets; whole-file reads
of 41KB; no "grep -l first, then targeted read with offset/limit" discipline in prompts or
skills. Each inefficient discovery step is both a bigger result (L1) and often an extra round
(L2). pi's built-ins do include `grep`/`find`/`read` — the gap is output caps + guidance, not
tool existence. *(pi's `edit` is also reported as whole-file-rewrite at 0.67.5 — re-verify on
0.79.1; if still true it inflates output tokens on large files.)*

### F11 — Compaction is a cost black box (LOW-MED, difficulty S)
Compaction summarization calls aren't attributed in cost tracking, and Bobbit doesn't configure
a proactive policy or a cheap summarizer model (pi's `compaction-sidecar` defaults apply).

### F12 — Storage bloat (cosmetic, difficulty S)
112MB of `session-prompts/` snapshots and 971MB of transcripts — not an API-cost issue, but
prompt snapshots duplicate identical AGENTS.md/role content per session; worth content-hashing
during G0 work since the same code is being touched.

**Verified non-problems** (don't spend effort here): prompt caching (works, §1.1); per-turn
system-prompt mutation (none — written once at spawn, `--system-prompt` path, cache survives);
skills catalog (150 tokens, budget-capped); tool description budgets (pinned by
`tests/tool-description-budget.test.ts`); goal-tree serialization (only nesting stanzas ≤1.5k);
MCP tool docs (off-wire pointers already).

---

## §4 What Claude Code and Hermes do that we don't

From source study of `/Users/aj/Documents/dev/claude-code/src` and
`/Users/aj/Documents/dev/hermes-agent` (local checkouts, 2026-06-10):

| Technique | Claude Code | Hermes | Bobbit today | Adopting goal |
|---|---|---|---|---|
| Stable cache prefix w/ explicit static/dynamic boundary | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `cacheBreak` flags, system-reminders injected user-side | system prompt memoized; ephemeral prompt injected at API-time, outside cache | ✅ already good (prefix stable) | — |
| Read caps + offsets | 25k-token read cap, 256KB pre-read stat check, offset/limit params | `read_file` unbounded but spills | partial (no enforced cap) | CE-G2.1 |
| **Tool-result spill-to-disk** | success/error only for write/edit | **3-layer budget: per-tool cap → >100KB results persisted to disk w/ 1.5KB preview + path → 200KB per-turn aggregate spill** | ❌ | CE-G2.1 |
| Deferred tool loading | `defer_loading` + ToolSearch when tool docs >10% of context | ❌ (67 tools inline) | partial (MCP docs off-wire) | CE-G1.2 (`--exclude-tools`) |
| **Cheap auxiliary model for summarization** | ❌ (manual /compact) | **auto-compress at 50% context via cheap model, 20% summary ratio, last-20-messages protected, tool-result pruning pre-pass** | ❌ | CE-G6.1 |
| Lazy skills | partial | `skill_list`/`skill_view` split — full skill body loaded only on use | ✅ catalog is names+descriptions | — |
| Sub-agent economics | minimal task prompt, summary-only return | parent context compressed before sub-agent call | ❌ full resident stack per sub-agent | CE-G3.3, CE-G5 |
| File-read dedup | `fileStateCache` (path+mtime) | — | ❌ | CE-G7.1 (guidance) / later |
| Image budgeting | downsampling + flat 1,600-token estimate | flat per-image budget | ❌ base64 inline | CE-G2.2 |
| Cost attribution | per-request workload headers, cost tracker | per-call usage accumulation | per-session cumulative only | CE-G0.1 |

The headline gap is **Hermes' three-layer tool-result budget** and **auxiliary-model
compression** on the L1 lever, and Claude Code's **read caps/deferral** on L1/L2. Nothing
either tool does on caching is missing in Bobbit — confirming §1.1.

---

## §5 Design positions (settled — do not re-litigate during execution)

1. **Instrumentation before surgery.** CE-G0 lands first. Behavior-affecting goals are
   BENCH-GATED (§0 rule 4). The owner explicitly wants data-driven before/after validation,
   "not guessing".
2. **The benchmark harness is a product feature, not a dev script.** It ships as a first-class
   Bobbit capability ("run this task suite, compare cost/outcome between two configurations"),
   designed so the run-suite/report surfaces can later be packaged as an extension-platform
   pack (panel + provider) — but the core runner lives in the server like the verification
   harness does. This is the owner's "test/validation harness as an extension would be a
   massive win".
3. **Adopt the pi fork at latest (0.79.x), don't patch blind.** `@earendil-works/pi` is our
   patchable fork already declared in package.json; first move is *upgrade + re-verify*, and
   only then patch the fork where gaps remain (tool-result caps, edit semantics) — upstreaming
   into the fork rather than working around it in Bobbit when the fix is SDK-shaped.
4. **Spill, don't destroy.** Truncation policies always preserve the full artifact on disk with
   a preview + path in context, so the agent can re-read on demand. Never silently drop
   information (mirrors the "no silent caps" culture).
5. **Tiering is defaults, not hard-coding.** Model/thinking tiers live in role/project config
   with sane defaults; the extension-platform model-selector (P8/P9) later makes them dynamic.
   This plan must not conflict with that — it defines the *static* layer the selector overrides.
6. **Real measured numbers stay in this doc** with their date and machine context; re-measure
   rather than trust them after substantial changes.

---

## §6 Remediation plan — goals

Hand-off format matches `extension-platform-implementation-plan.md`: each sub-goal is
independently mergeable, master-green, with tests and acceptance criteria. Lanes: G0 and G1 are
parallel day-one lanes; G2/G3 depend on G1.0's re-verification; G4/G5 are BENCH-GATED on G0.3.

**Latency workstream (CE-G8)** lives in §9.5 — it targets *wall-clock*, not just dollars
(risk-proportional gates, slim sub-agent context, warm-cache reuse, latency instrumentation,
"solo fast" mode). CE-G8.1/G8.3 are the quick wins and can start day-one alongside G0/G1.

**Conflict hotspots:** `session-manager.ts` and `session-setup.ts` are also touched by the
comms-stack backlog (CS-R*) — coordinate merge order; `verification-harness.ts` is touched by
CE-G3.3 and CE-G5.2 (sequence them).

---

### CE-G0 — Instrumentation & benchmark harness *(lane A — start immediately)*

**Outcome:** every token and dollar is attributable (per turn, per session, per goal, per
project), visible in the UI, and comparable across runs of the same task.

#### CE-G0.1 Per-turn usage ledger (S)
- On every `message_end` with usage (existing hook: `trackCostFromEvent`,
  `session-manager.ts:~3103`), append a record to
  `.bobbit/state/session-usage/<sessionId>.jsonl`:
  `{ts, turnIndex, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, contextEstimate, trigger}` —
  `trigger` distinguishes `user-prompt | steer | nudge | auto-retry | verification | compaction`
  (plumb from the enqueue site; nudges/steers already flow through known call sites in
  `team-manager.ts` / `session-manager.ts::enqueuePrompt`).
- Attribute compaction summarization usage to the session (closes F11's blind spot).
- REST: `GET /api/sessions/:id/usage` (paginated), `GET /api/projects/:id/usage/rollup`
  (per-goal, per-role, per-trigger aggregates).
- **Tests:** unit — ledger append/rotation, trigger attribution table-driven; API E2E — rollup
  math over a fixture ledger. Pin: cumulative ledger total equals `session-costs.json` entry
  (±1 token) for a replayed fixture.

#### CE-G0.2 Cost lens UI (M)
- Session view: per-turn cost strip (cost, cache-hit %, trigger badge), session total with
  cacheR/cacheW/output breakdown. Goal/project view: rollup table (cost by role, by trigger
  class — "coordination" vs "work" vs "verification"), top-N expensive sessions.
- Surface the SDK's cache-hit rate once on ≥0.79 (CE-G1.1) instead of recomputing.
- **Tests:** browser E2E (navigation, rendering from fixture ledger, persistence across
  reload). UI-only → `test:unit` + the E2E.

#### CE-G0.3 Benchmark harness (L) — the BENCH gate
- New server module (pattern: `verification-harness.ts`): a **bench suite** is a YAML file of
  repeatable tasks — `{id, fixtureRepo (tests/fixtures or a pinned git ref), goalSpec, role,
  successCheck (command or llm-review rubric), maxCost, maxTurns}`.
- `POST /api/bench/run {suiteId, label, overrides}` runs each task as a normal (sandboxed,
  worktree-isolated) session, records outcome + the CE-G0.1 ledger, and produces a run report:
  `{task, success, costUsd, turns, toolCalls, wallClock, residentPromptTokens}`.
- `GET /api/bench/compare?a=<runId>&b=<runId>` → per-task and aggregate deltas; this comparison
  JSON (or its rendered table) is what BENCH-GATED PRs attach.
- CI never runs real-LLM benches (`tests/manual-integration/` is the only gate-exempt path);
  unit/E2E cover the runner with a stubbed agent.
- Seed suite `bench/suites/core-dev.yaml`: (1) scoped bugfix in a fixture repo, (2) small
  feature + tests, (3) code-review of a prepared diff, (4) a team goal with 2 workers —
  deliberately covering worker, reviewer, and orchestration cost shapes.
- **Extension hook (deliberate):** the report store and compare endpoint are plain REST + files
  so a future pack (extension-platform P1 surfaces: panel + entrypoint) can ship "Cost Lab" UI
  without core changes. Record this seam in the code.
- **Tests:** unit — suite parsing, report math, compare; API E2E — stubbed-agent run end to
  end; manual-integration — one real run of the smallest task.

---

### CE-G1 — SDK adoption & config hygiene *(lane B — start immediately)*

#### CE-G1.0 Upgrade to `@earendil-works/pi-*` latest 0.79.x and re-verify claims (M)
- `npm install` against latest fork; migrate any remaining `@mariozechner/pi*` imports in `src/`
  (`rg "@mariozechner/pi" src/` — UI and server hits listed in the audit); fix breakages;
  full gate run incl. `test:manual`.
- **Re-verify and document** (append a dated note to this doc's §1.5): does 0.79.x truncate
  tool results? what are `read`/`grep`/`bash` output caps? is `edit` still whole-file-rewrite?
  what does compaction default to? This report re-scopes CE-G2/G6/G7 before they start.
- Set `retry.provider.maxRetries` explicitly and align with Bobbit's auto-retry so exactly one
  layer retries (cross-ref comms-stack F5/CS backlog — same fix, coordinate).
- **Tests:** existing suites are the regression net; add a pinning test that Bobbit's spawn
  config sets the retry setting (no silent SDK-default regression on future upgrades).

#### CE-G1.1 Cache-hit telemetry adoption (S, after G1.0)
- Ingest the SDK's cache-hit rate / usage detail into the CE-G0.1 ledger instead of deriving it.

#### CE-G1.2 Context-exclusion adoption (S–M, after G1.0)
- Use `excludeFromContext` for every Bobbit-initiated bash whose output the model doesn't need
  (health probes, bookkeeping, the verification harness's own setup commands).
- Use `--exclude-tools` from role tool policy so sessions don't carry built-ins their role
  forbids (today the guard extension denies at call-time but the definitions still ship).
- **Tests:** unit — spawn args include exclusions per role fixture; E2E — excluded tool absent
  from the session's advertised tools.

---

### CE-G2 — Tool-output budget tier *(L1; after CE-G1.0 re-verification)*

#### CE-G2.1 Three-layer result budget with spill-to-disk (M–L)
Adopt Hermes' model, scoped to whatever 0.79.x doesn't already do:
- **Layer 1** per-tool caps (defaults, config-overridable): bash 20KB (head+tail split), grep
  20KB, read 50KB (with offset/limit guidance — see CE-G7.1), default 32KB.
- **Layer 2** any result over its cap → write full output to
  `.bobbit/state/tool-spill/<sessionId>/<n>.txt`, return preview (first ~1.5KB to a line
  boundary) + `[full output: <path>, <N> bytes — read with offset/limit if needed]`.
- **Layer 3** per-turn aggregate budget (~200KB): if a turn's results exceed it, spill the
  largest non-spilled results.
- Implementation seam: prefer the SDK layer (fork patch — it owns tool execution) with a
  Bobbit-side fallback in the tool wrappers; decide per CE-G1.0's report. Spill files are
  session-scoped and cleaned with session deletion.
- **Hermes' exact constants** (source: `hermes-agent/tools/budget_config.py`, verified
  2026-06-19) — adopt as starting defaults: `DEFAULT_RESULT_SIZE_CHARS = 100_000` (per-result),
  `DEFAULT_TURN_BUDGET_CHARS = 200_000` (per-turn aggregate), `DEFAULT_PREVIEW_SIZE_CHARS = 1_500`
  (inline snippet after spill). Resolution order: `pinned > tool_overrides > registry per-tool >
  default`. **Non-obvious gotcha to copy:** Hermes *pins* `read_file = inf` in `PINNED_THRESHOLDS`
  — a read tool that itself spills creates an infinite persist→read→persist loop, so the read path
  must be exempt from the budget (caps belong on `read` via offset/limit guidance — CE-G7.1 — not
  via spill).
- **Tests (write RED first):** unit — cap/preview/spill matrix per layer, path cleanup; E2E —
  oversized fixture command produces preview + readable spill file; pin that previews always
  carry the path (no silent truncation).

#### CE-G2.2 Images by reference (S)
- Any tool producing images (incl. `generate_image`) writes to disk and returns
  `{path, width, height, bytes}` + a one-line description in model context; the UI renderer
  loads from the path. Transcript stores the reference, not the base64.
- **Tests:** unit — renderer + reducer handle reference form; E2E — image tool round-trip
  shows the image in UI with context payload under 1KB. Expected effect: the §1.4 image
  session's shape ($10.75, 73% image bytes) becomes impossible.

---

### CE-G3 — Turn economy *(L2)*

#### CE-G3.1 Nudge & status batching (M)
- Coalesce per-agent status changes into one steer per quiet window (extend the existing 5s
  debounce to batch *content*, not just delay it); suppress idle nudges that carry no new
  actionable delta since the last one (track last-nudge state hash); keep the existing
  exponential backoff.
- Add `trigger` attribution (CE-G0.1) so the coordination share of team-session cost is a
  dashboard number; target: coordination turns <15% of team-session spend.
- **Tests:** unit — batching/suppression state machine (table-driven); E2E — fixture team
  session emits N status events → ≤1 steer per window.

#### CE-G3.2 Repeated-command guard (S)
- In the tool-guard path (`tool-guard-extension.ts` pattern — it already sees every
  `tool_call`), detect an identical read-only bash command (allowlisted prefixes: `git status`,
  `npm run check`, build/test commands) repeated within the same turn-window with no
  intervening file changes, and prepend a short note to the result:
  `[identical command run <N> ago — output unchanged? consider reusing]` — informational, never
  blocking (the 17× `git push` case had legitimate retries in it; we hint, not forbid).
- **Tests:** unit — detection window logic; fixture E2E — note appears on 3rd identical call.

#### CE-G3.3 llm-review scoping (M) **[BENCH-GATED]**
- Verifier sessions get a *review-scoped* context: the diff/artifact under review + acceptance
  criteria + a slim reviewer role — not the full AGENTS.md cascade by default (config flag to
  restore it for projects whose review genuinely needs it); cap tool-call rounds per attempt
  (default ~20, configurable per gate) with an explicit "out of budget → fail with reason"
  result instead of unbounded exploration.
- **Tests:** unit — context assembly for review sessions; E2E — round cap produces the
  structured failure; BENCH — review-task success rate unchanged on the bench suite's review
  task while cost drops.

---

### CE-G4 — Prompt diet *(L1; BENCH-GATED; the behavior-affecting tier)*

#### CE-G4.1 team-lead role rewrite: 35.5KB → ≤12KB (M–L, **highest-risk/highest-value**) **[BENCH-GATED]**
- Restructure `defaults/roles/team-lead.yaml`: keep identity, decision rules, and invariants
  resident; move recipes/walkthroughs (the bulk) into skills or `docs/` loaded on demand via
  the existing skills mechanism. Mechanical rule: anything the lead needs *every* turn stays;
  anything needed in specific situations becomes a discoverable skill.
- Run the bench team-task before/after (N=3 runs each, same model); ship only if success and
  coordination-quality metrics hold.
- **Tests:** pin a role-size budget test (like the tool-description budget) so it can't silently
  regrow: `defaults/roles/*.yaml` each ≤ a per-role budget, sum ≤ corpus budget.

#### CE-G4.2 AGENTS.md cascade budget (M) **[BENCH-GATED]**
- Token-budget `readAllAgentFiles()` output (default ~6k tokens, project-overridable):
  priority order (project AGENTS.md > global > referenced docs), truncate at section boundaries
  with an explicit `[truncated — full file at <path>; read on demand]` tail (spill rule, §5.4).
- Surface the measured size in prompt-sections (already visible) and warn in the UI when a
  project's cascade exceeds budget — make the cost of a 17k-token playbook *visible* to its
  author instead of silent.
- **Tests:** unit — budget/truncation boundary cases; pin the truncation-marker invariant.

#### CE-G4.3 Role corpus diet + lazy role docs (S–M) **[BENCH-GATED]**
- Apply the G4.1 treatment to `qa-tester` (9.9KB) and `docs-writer` (6.7KB); add the role-size
  budget test for all roles (delivered in G4.1).

---

### CE-G5 — Model & thinking tiering *(L3)*

#### CE-G5.1 Per-role model/thinking defaults (M) **[BENCH-GATED]**
- Extend role schema (role files + `role-store.ts`) with optional `model:` and `thinking:`;
  precedence: explicit session pin > role default > project default > server default.
  Resolution lives in `session-setup.ts::resolveBridgeOptions` (the pin mechanism exists;
  this adds the role/project layers).
- Ship conservative defaults: leads = project default (frontier); workers = one tier below
  unless role says otherwise; assistants = mid-tier. Show the resolved model per session in the
  UI (it's a cost-relevant fact users should see).
- Forward-compat: this is the static layer the extension-platform P8 model-selector proposes
  *overrides* to — keep the resolution function pure and injectable.
- **Tests:** unit — precedence matrix (table-driven); E2E — role fixture resolves expected
  model in spawn args; BENCH — worker-task success holds on the cheaper tier.

#### CE-G5.2 llm-review default model (S) **[BENCH-GATED]**
- Default verifier model = configurable `verification.reviewModel`, shipped as a mid-tier model;
  wire through the existing `applyReviewModelOverrides` path. With CE-G3.3, targets the
  $29–47 review tail directly.
- **Tests:** unit — override precedence incl. the new default; BENCH — review task quality holds.

---

### CE-G6 — Compaction & history hygiene *(L1)*

#### CE-G6.1 Proactive compaction policy + cost attribution (M)
- Configure pi's compaction proactively (threshold ~60–70% of context window — confirm exact
  knobs in CE-G1.0's report) with a **cheap summarizer model** if the SDK supports a separate
  compaction model (if not: fork patch, Hermes-style auxiliary model).
- Attribute compaction usage in the CE-G0.1 ledger (`trigger: compaction`).
- Coordinate with comms-stack F6 (compaction dispatch gate) — same code region, land the safety
  fix first.
- **Tests:** manual-integration — long fixture session compacts proactively, session continues
  correctly, ledger shows attributed compaction cost.

---

### CE-G7 — Discovery efficiency *(L2; cheap, do early alongside G2)*

#### CE-G7.1 Discovery guidance + skills (S)
- Add a concise (≤600 token) "efficient code discovery" section to the base system prompt /
  relevant roles: grep with `-l` first → targeted read with offset/limit → never `cat` whole
  files via bash; prefer built-in capped tools over bash for search; don't re-read unchanged
  files. Ship a `code-discovery` skill with the longer playbook (lazy-loaded).
- Measure: bash share of tool calls (CE-G0.1 ledger dimension) — target <40% from 56%.
- **Tests:** prompt-section snapshot test; BENCH comparison is the real validation (bundle with
  a G2 bench run to share runs).

#### CE-G7.2 (Later, recorded) Code-graph/LSP pack
- AST/LSP-backed "find usages / go to definition" as an extension-platform pack — already in
  that plan's Later section; cost rationale recorded here: replaces multi-round grep cascades
  with single tool calls.

---

### Expected impact (estimates — the bench harness replaces these with measurements)

| Goal | Lever | Est. effect on affected session class |
|---|---|---|
| CE-G2 | L1 | 10–30% (work sessions; eliminates image-session blowups entirely) |
| CE-G3 | L2 | 15–30% of team/verifier session cost |
| CE-G4 | L1 | 20–40% of resident-context cost (≈ proportional cut in cache-reads) |
| CE-G5 | L3 | 30–60% on worker/verifier spend (price-sheet arithmetic) |
| CE-G1 | L4 | small steady-state; prevents double-billed retries; unlocks G2/G6 |
| CE-G6/G7 | L1/L2 | 5–15% each, mostly on long sessions |

These do not multiply cleanly (overlapping bases), but a realistic compounded outcome on the
expensive session classes (team-leads, llm-reviews — 51%+ of spend) is **2–4×** cheaper at
equal task success, which is the gap the owner perceives vs Claude Code/Hermes.

---

## §7 Reproduction recipes

```bash
# Aggregate + cache ratio
jq -r '[.[] | {i:(.inputTokens//0), cr:(.cacheReadTokens//0), cw:(.cacheWriteTokens//0), o:(.outputTokens//0), c:(.totalCost//0)}] |
  "sessions=\(length) uncachedIn=\([.[].i]|add) cacheRead=\([.[].cr]|add) cacheWrite=\([.[].cw]|add) out=\([.[].o]|add) totalCost=$\([.[].c]|add)"' \
  .bobbit/state/session-costs.json

# Top sessions by cost
jq -r 'to_entries | sort_by(-(.value.totalCost//0)) | .[0:10][] |
  "\(.key)\t$\(.value.totalCost)\tcacheR=\(.value.cacheReadTokens)\tout=\(.value.outputTokens)"' \
  .bobbit/state/session-costs.json

# Prompt-section sizes for recent sessions
for f in $(ls -t .bobbit/state/session-prompts/*-prompt.json | head -5); do
  jq -r '[.sections[] | "\(.label): \(.tokens)"] | join("\n")' "$f"; echo ---; done

# Tool-call distribution in a transcript
jq -s '[.[] | select(.type=="message" and .message.role=="assistant") | .message.content[]? |
  select(.type=="toolCall") | .name] | group_by(.) | map({tool:.[0],n:length}) | sort_by(-.n)' \
  ~/.bobbit/agent/sessions/<file>.jsonl

# Repeated identical bash commands
jq -s '[.[] | select(.type=="message" and .message.role=="assistant") | .message.content[]? |
  select(.type=="toolCall" and .name=="bash") | .arguments.command] | group_by(.) |
  map({cmd:.[0],reps:length}) | map(select(.reps>1)) | sort_by(-.reps)' \
  ~/.bobbit/agent/sessions/<file>.jsonl

# Largest tool results
jq -s '[.[] | select(.type=="message" and .message.role=="toolResult") |
  {tool:.message.toolName, bytes:(.message.content|tostring|length)}] | sort_by(-.bytes) | .[0:20]' \
  ~/.bobbit/agent/sessions/<file>.jsonl
```

## §8 Risks & open questions

1. **Prompt-diet regressions** (G4) — the team-lead role encodes hard-won behavior; the bench
   gate + role-budget pin are the mitigations, but the bench suite must include a real team
   task or G4.1 is being validated on the wrong distribution.
2. **Truncation hiding needed info** (G2) — mitigated by spill+preview+path and the read-on-
   demand loop; watch for agents that never learn to follow the path (add guidance in G7.1).
3. **Fork divergence** — patching `earendil-works/pi` (G2 SDK-side, G6 auxiliary model) carries
   maintenance cost; prefer upstreamable patches with tests in the fork repo.
4. **Bench cost & flakiness** — real-LLM benches cost real money and have run-to-run variance;
   N=3 minimum, compare medians, and keep suites small. Bench runs are manual-only, never CI.
5. **Cheaper-model failure modes** (G5) — a worker that fails and retries on a cheap model can
   cost more than succeeding once on a frontier model; the ledger's per-trigger attribution
   (retry share by model) is the early-warning metric.
6. **Data drift** — every number in §1 is a 2026-06-10 snapshot of one machine spanning
   multiple projects and weeks of model-price changes; CE-G0 exists so this document never
   needs to be hand-reproduced again.

---

## §9 Latency axis & the process-per-agent root cause *(added 2026-06-19)*

§1–§8 optimise **dollars**. The owner's lived complaint is also **wall-clock**: "goals take a
*really* long time; Claude Code felt a lot faster." Cost and time are correlated but not the
same — a $1 verifier still makes you wait three minutes — so latency needs its own axis, and the
investigation surfaced an **inherent architectural root cause** that several §3 symptoms
(F2 resident floor, F5 verifier economics) trace back to. All numbers here are a 2026-06-19
snapshot of `.bobbit/state` (326 sessions, $1,069, 1.16B cache-read) on the primary dev machine;
the *shapes* corroborate §1's 2026-06-10 snapshot. Repro recipes in §9.7.

### 9.1 The surprise: per-request latency is *not* where Bobbit loses

| Metric | Bobbit | Claude Code | Source |
|---|---|---|---|
| Context tokens per API request (median) | ~18k–55k resident + history | **377,590** | CC is *larger* and still fast |
| Per-API-round latency (median / mean / p90) | comparable per round | **4.4s / 15.1s / 26.5s** | CC `~/.claude/projects/*.jsonl` timestamps |

Claude Code runs **bigger** contexts per request and still turns each round in ~4.4s median. So
Bobbit is **not** slow because individual requests are heavy. The wall-clock goes somewhere
structural — the orchestration model inserts machine work *between you and "done"* that, in
Claude Code, either doesn't happen or is you doing it instantly in real time.

### 9.2 Where the wall-clock actually goes (measured)

| Signal | Value | Why it's wall-clock you wait through |
|---|---|---|
| Verifier (`llm-review`) sessions vs work sessions | **189 vs 141 — 1.34 per unit of work** | Each gated step spawns a verifier that runs *after* the work, on the critical path |
| Verifier session duration | median **2.8 min**, max **9.9 min** (10h total, 175 traced) | `review-findings` blocks `team_complete`; serialized, not overlapped with work |
| Work session duration | median **20.5 min** | multi-turn, multi-tool |
| Per-spawn startup floor | process boot + N MCP stdio spawns + optional `docker exec` + role/AGENTS/tool-doc load | paid *before the first token*, every spawn |
| Nudge/backoff dead time | 5s worker-idle debounce, 5-min stuck-quiet, 30-min long-streaming suppression, exp backoff (cap 12h) | literal inserted sleeps in the coordination loop (`team-manager.ts`) |

Claude Code has none of these: you are the orchestrator and reviewer, in real time, so there is
zero machine wall-clock between turns. **The slowness is the price of unattended autonomy +
automated quality gates** — the fix is making them *proportional to risk*, not removing them.

### 9.3 Root cause: process-per-agent (inherent to the gateway architecture)

Bobbit's deepest inherent tax is that **every agent — lead, worker, and each of the 189
verifiers — is a separate OS process.** `rpc-bridge.ts` does
`spawn(process.execPath, [pi-cli, ...])` per session; each session connects its own **MCP stdio
child processes** (`mcp-client.ts::_connectStdio`); sandboxed goals add a `docker exec` into a
pool container on top (`rpc-bridge.ts:~658`).

Claude Code does the opposite — sub-agents are **in-process forks** (`tools/AgentTool/runAgent.ts`
is an async generator; `utils/swarm/spawnInProcess.js`) that **inherit the parent's already-warm
context** via `forkContextMessages`, and it *deliberately* trims per-spawn context: the
read-only Explore/Plan agents drop CLAUDE.md — source comment: *"Dropping claudeMd here saves
~5–15 Gtok/week across 34M+ Explore spawns"* (`runAgent.ts:~387`). Hermes likewise runs tools
in-process against one resident context.

This single choice explains the symptoms:
- **Verifier write-thrash (F5 refinement).** A separate process has its own prompt-cache
  lifecycle, so it *cannot* inherit the lead's warm cache — it writes the full resident stack
  **cold** and dies before the write amortises. Hence 34% of verifier cost is cache *writes*
  (vs 3% global).
- **The per-agent latency floor (9.2).** Process boot + MCP stdio handshakes + optional
  container exec + role/AGENTS/tool-doc load happen before the model emits a token, paid 189×
  for verifiers alone.
- **Why the resident-prompt floor (F2) is so expensive.** It isn't just resident once — it's
  re-written cold on every short-lived spawn.

This is not a quick fix (it fights the gateway/session model), but naming it reframes the
priority order: **shrink what each cold spawn must write, and reuse warm cache where possible**,
before chasing request-count.

### 9.4 New findings (continuing the §3 F-numbering)

#### F13 — Verification on the critical path with no risk-proportionality (HIGH for latency, difficulty M)
`review-findings` is server-enforced before `team_complete`; a 2-line tooltip tweak triggers the
same full-context ~3-min verifier as a 500-line refactor. No diff-size threshold, no "skip gate
under N lines", no fast-path. This is the single biggest *wall-clock* tax. (Cost cousin: F5.)

#### F14 — Cold-spawn write tax from process-per-agent (HIGH for cost+latency, difficulty L, **inherent**)
§9.3. Short-lived spawns (verifiers, small worker tasks) never amortise their cold cache write
and pay a process+MCP+container startup floor. Inherent to the architecture; mitigable by
context-diet (F15) now and warm-cache reuse (CE-G8.4) later.

#### F15 — No slim sub-agent context profile (MED-HIGH, difficulty S–M)
Every spawned agent inherits the full AGENTS.md cascade + full role, including read-only
verifiers that never commit, lint, or open PRs and so cannot act on most of it. Claude Code's
`omitClaudeMd` for read-only sub-agents is the proven pattern. **This is the highest-leverage,
lowest-risk quick win** — attacks F5's 34% write share with zero behaviour risk.

#### F16 — Coordination dead-time is invisible (MED for latency, difficulty S–M)
Nudge debounce/backoff and the per-spawn startup floor are pure wall-clock that **no token or
cost metric captures**, so CE-G0's ledger (dollars/tokens) would still not surface them. Latency
needs its own instrumentation dimension (wall-clock per turn, queue/startup/verify waits).

#### F17 — No "solo fast" execution mode (MED, difficulty S)
Every goal pays the full team+gate orchestration even when the user would have just used a
single interactive agent. There is no lightweight single-agent, no-gate path for low-risk work —
so the cases most comparable to Claude Code pay the most overhead relative to their value.

### 9.5 Remediation — latency workstream (CE-G8)

Hand-off format matches §6. Lane independent of G0–G7 except where noted. **CE-G8.1 and CE-G8.3
are the quick wins; do them first.**

> **Deepened by measured loop data + new levers:** see
> [verification-loop-economics.md](verification-loop-economics.md) — a 2026-06-20 snapshot showing
> 51% of gate signals are retries (70% reviewer-driven, ~40 h of repeated impl verification) and
> adding goals **CE-G8.7** (severity floor + round budget), **CE-G8.8** (affected-only
> re-verification), **CE-G8.9** (goal-author-composed / agent-right-sized workflows), **CE-G8.10**
> (plan→cheap-exec→frontier-review + per-role thinking tiering), **CE-G8.11** (team-lead diet).
> It leads with the **trust-first north star**: no lever ships if it raises the escaped-defect rate. Behaviour-affecting items are BENCH-GATED on CE-G0.3 plus a
**wall-clock** comparison (extend the bench report with `wallClock`, `startupMs`, `verifyMs`).

#### CE-G8.1 Risk-proportional verification gates (M) **[BENCH-GATED]** — *biggest latency win*
- Add a per-gate **fast-path**: skip or downgrade `review-findings` when the change under review
  is below a configurable threshold (default ~30 changed lines, no non-doc/test files,
  green `npm run check`) — config-overridable per project/workflow; never silently skip a gate a
  workflow marks `required: strict`.
- Where not skipped, run a **lighter review** (cheap model + diff-scoped context, ties to
  CE-G3.3/CE-G5.2) instead of the full verifier.
- **Tests:** unit — threshold/skip decision table (lines, file classes, strictness); E2E — a
  sub-threshold gated step completes without spawning a full verifier; BENCH — review task
  quality holds on the suite while median goal wall-clock drops.

#### CE-G8.2 Verifier cold-write reduction (S–M) — *attacks F5's 34% write share*
- Pair with CE-G3.3/F15: verifiers spawn with a **diff-scoped, slim** context (artifact +
  acceptance criteria + slim reviewer role), measured by cache-**write** tokens per verifier,
  not just rounds. Target: halve verifier write share.
- **Tests:** unit — verifier context assembly excludes the AGENTS.md cascade by default; E2E —
  spawned verifier's resident snapshot under a byte budget; **measure cacheWrite/verifier** in
  the CE-G0.1 ledger before/after.

#### CE-G8.3 Slim sub-agent / read-only context profile (S–M) — *quick win, zero behaviour risk*
- Adopt Claude Code's `omitClaudeMd` pattern: read-only roles (verifiers, explorers, reviewers)
  get a context profile that **drops the project AGENTS.md cascade and commit/PR/lint rules**
  they cannot act on. Resolution lives where role context is assembled (`session-setup.ts`).
- **Tests:** unit — profile resolution per role (read-only ⇒ no cascade); E2E — a read-only
  spawn's prompt sections omit AGENTS.md; pin a per-profile resident-size budget (like the
  tool-description budget) so it can't silently regrow.

#### CE-G8.4 Warm-cache reuse for short-lived spawns (L, **inherent-architecture**, research-first)
- Investigate letting a verifier/sub-agent **reuse the parent's warm cache** instead of
  cold-spawning a fresh process: options are (a) an in-process review path for non-sandboxed
  goals, (b) a pooled warm agent process keyed by resident-prefix hash, (c) SDK/fork support for
  prefix sharing across processes. Decide feasibility against the gateway model in a spike;
  this is the real ceiling on F14 but must not regress sandbox isolation.
- **Tests:** spike + design note appended here before any code; if adopted, E2E that a reused
  spawn records ~0 cold cache-write for the shared prefix.

#### CE-G8.5 Latency instrumentation (S–M) — *extends CE-G0.1, closes F16*
- Add wall-clock dimensions to the CE-G0.1 ledger: per-turn `wallClockMs`, and per-spawn
  `startupMs` (spawn→first-token), `queueMs` (enqueue→start), `verifyMs` (gate signal→verdict).
  Surface a "time breakdown" alongside the cost lens (CE-G0.2): work vs coordination vs
  verification vs startup.
- Extend the bench report (CE-G0.3) with `wallClock`, `startupMs`, `verifyMs` so CE-G8.1’s
  BENCH gate can assert *time* not just dollars.
- **Tests:** unit — timing capture + attribution; API E2E — rollup math over a fixture ledger.

#### CE-G8.6 "Solo fast" goal mode (S) — *closes F17*
- A goal option that runs a **single agent, no team, no gates** (or design-doc only) for
  low-risk work — the Claude-Code-equivalent path — selectable at goal creation, with the
  trade-off (no automated verification) made explicit in the UI.
- **Tests:** unit — mode disables team/gate machinery; E2E — a solo-fast goal completes without
  spawning verifiers; browser E2E for the creation toggle + persisted choice.

### Expected impact (latency — estimates; the bench harness replaces these)

| Goal | Axis | Est. effect |
|---|---|---|
| CE-G8.1 | wall-clock | removes ~1.34× × ~3 min serialized verify from small goals — the dominant tax |
| CE-G8.2/G8.3 | cost+wall-clock | halves verifier cache-**write** share + cuts per-spawn load; zero behaviour risk (G8.3) |
| CE-G8.4 | cost+wall-clock | eliminates cold-write for reused prefixes (ceiling fix; highest risk) |
| CE-G8.5 | visibility | makes coordination/startup dead-time a dashboard number (blocker for tuning) |
| CE-G8.6 | wall-clock | low-risk goals skip orchestration entirely |

### 9.6 Parallelism & swarms — the serial→parallel lever (forward-looking)

Every lever in §6/§9.5 makes a *serial* step cheaper; none removes the **serialization** that
§9.2 identified as the real wall-clock tax. The one lever that does is **parallelism**: fan a
goal out to many small specialised agents (Claude Code's in-process swarm) and, for
decisions/quality, add a **reconciliation/council** step
([karpathy/llm-council](https://github.com/karpathy/llm-council); hermes'
`mixture_of_agents_tool.py`). N independent ~3-min sub-tasks then cost ~3 min, not 3N; and
peer cross-review folds part of the verification tax (F13/F5) *into* the parallel wave instead
of a serial downstream gate.

The blocker is cost: a swarm of *cold OS processes* (§9.3) amplifies the process-per-agent tax
(F14) by the swarm width — a net loss. The unlock is the imminent **single-container Bobbit**
change (per-agent sandboxing becomes redundant → members run as cheap **in-process /
worker_thread forks** that inherit the parent's warm cache, CE-G8.4) and, later, **federation**
across connected Bobbits via the gateway. Because it composes from machinery already on the
roadmap (capability registry, Lifecycle Hub, model-selector pack, workflow templates), it's a
**pack + capability** feature, not core surgery.

This is large enough to warrant its own doc — see
**[agent-swarm-and-reconciliation.md](agent-swarm-and-reconciliation.md)** (workstream **SW**:
fan-out swarm, council/reconciliation, the cheap-spawning dependency chain, federation, and a
BENCH-gated phased plan SW-G0–G4). It is *gated on* this doc's CE-G8.4 (warm-cache reuse) +
the sandbox change, and reuses CE-G0.3/CE-G8.5 (bench + wall-clock metrics) as its measuring
stick.

### 9.7 Reproduction recipes (latency)

```bash
# Verifier vs work session counts + cache-write share (the inverted economics)
python3 - <<'PY'
import json,statistics
d=json.load(open(".bobbit/state/session-costs.json"))
for lbl,pred in [("VERIFIER",lambda k:k.startswith("llm-review")),("WORK",lambda k:not k.startswith("llm-review"))]:
    rows=[v for k,v in d.items() if pred(k)]
    cw=sum(v.get("cacheWriteTokens",0) for v in rows); cr=sum(v.get("cacheReadTokens",0) for v in rows)
    print(f"{lbl}: n={len(rows)} write/read={cw/max(1,cr):.3f}")
PY

# Bobbit verifier wall-clock (sessionSetup→Shutdown) from context traces
for f in .bobbit/state/session-context-trace/llm-review-*.jsonl; do
  python3 -c 'import json,sys; t=[json.loads(l)["ts"] for l in open(sys.argv[1])]; print((max(t)-min(t))/1000)' "$f"
done | sort -n | awk '{a[NR]=$1} END{print "median(s)=" a[int(NR/2)], "max(s)=" a[NR]}'

# Claude Code per-API-round latency baseline
python3 - <<'PY'
import json,glob,datetime,statistics
def ms(t):
    try: return datetime.datetime.fromisoformat(t.replace("Z","+00:00")).timestamp()*1000
    except: return None
gaps=[]
for f in glob.glob("~/.claude/projects/*/*.jsonl".replace("~",__import__("os").path.expanduser("~"))):
    a=[ms(json.loads(l).get("timestamp")) for l in open(f) if '"assistant"' in l]
    a=[x for x in a if x]
    gaps+=[ (y-x)/1000 for x,y in zip(a,a[1:]) if 0<(y-x)/1000<600 ]
if gaps: print(f"CC per-round gap: median {statistics.median(gaps):.1f}s p90 {sorted(gaps)[int(len(gaps)*0.9)]:.1f}s")
PY
```
