# Design note — AGENTS.md cascade budget (F19)

Finding F19 (Fable refactor program, tracker W3.7): the Project AGENTS.md
cascade is the single biggest token lever identified across the audit —
measured up to **~21K tokens = 56% of a 37.7K code-reviewer system prompt**
on a real managed project (`raw/context-composition-vs-claude-code-result.json`
in the Fable audit bundle: *"Measured 1,085 tok (new-era) → 9,021
(agent-memory) → 21,226 (bobbit-suubro) — 56% of a 37.7K code-reviewer
prompt"*).

## What actually makes it 21K

Traced the mechanism in `src/server/agent/system-prompt.ts` and
`config-directories.ts` before writing any code (Rule 0 — measure first):

- The Agents cascade is **not** a directory-walking, ancestor-CLAUDE.md-style
  hierarchy (Bobbit has no per-directory parent walk, unlike Claude Code's
  nested memory). `getAllConfigDirectories()` contributes exactly ONE
  built-in `agents`-typed entry — the project's own root `AGENTS.md` (falls
  back to `CLAUDE.md`) — plus any additional `agents`-typed **custom** config
  directories a project owner explicitly opts into (rare, additive).
- `readAllAgentFiles()` concatenates those entries with **no size cap**, and
  `resolveMarkdownRefs()` recursively inlines `@ref` includes up to 5 hops
  deep, **also with no size cap** (only depth and circular-reference guards
  existed before this PR).
- **This repo's own `AGENTS.md` is small** (~5.8KB, independently pinned
  under 6KB by `tests/agents-md-budget.test.ts` from a prior, unrelated
  finding) — confirming the audit's own read that low-context projects stay
  cheap (~1.1K tokens measured on "new-era"). The 21K-token cascade is a
  property of a **managed target project's own AGENTS.md `@ref`-including
  its docs**, not of Bobbit's fixed scaffolding.
- Reproduced the mechanism at a realistic magnitude using this repo's own
  large docs as `@ref` targets (a project's `AGENTS.md` doing
  `@docs/dev-workflow.md` + `@docs/orchestration.md` +
  `@docs/pr-walkthrough-durable-reviews.md`, three ordinary docs totaling
  ~82KB):

  ```
  UNCAPPED   chars=81,897   ~tokens=20,475      (matches the measured "up to 21,226")
  CAPPED@6000tok   chars=24,457   ~tokens=6,115   reduction=70.1%
  CAPPED@2000tok   chars=8,448    ~tokens=2,112   reduction=89.7%
  CAPPED@500tok    chars=2,486    ~tokens=622     reduction=97.0%
  ```

  (see `tests/agents-md-cascade-budget.test.ts` → *"reproduces a
  representative deep @-ref cascade blowup"* for the pinned, smaller-scale
  version of this same reproduction.)

**Conclusion: design for the real cause** — an uncapped `@ref` expansion
mechanism, not a multi-file ancestor cascade. The fix caps `@ref` inlining
(and any additional, non-primary agents-type entries) while leaving the
project's own primary AGENTS.md prose untouched.

## Design

`agents_md_budget: "<tokens>"` in `project.yaml`, with
`BOBBIT_AGENTSMD_BUDGET=<tokens>` as the highest-precedence process override
(or `PromptParts.agentsMdBudgetTokens` override). **Default unset/empty = OFF
= today's uncapped behavior, byte-identical**
(pinned by the "flag off" tests in `tests/agents-md-cascade-budget.test.ts`
and by the full pre-existing `tests/system-prompt*.test.ts` suite passing
unchanged).

Deterministic strategy, no LLM summarization:

1. The **nearest/most-specific** agents file — the first discovered entry,
   normally the project's own root `AGENTS.md`/`CLAUDE.md` — is **always kept
   whole**. Its own literal prose is never truncated by the budget.
2. Everything that file (or any additional, non-primary agents-type entry)
   pulls in via `@ref`, and any additional entries' own text, is budgeted
   from the first byte — treated the same as "ancestor" content.
3. Once the shared budget is exhausted, the remainder is replaced with an
   explicit `<!-- [AGENTS.md cascade budget: truncated/omitted — see <path>
   …] -->` marker naming the source file (transparency: the agent always
   knows something was cut and exactly where to `Read` the rest).
4. Cuts always land on a line boundary (never mid-line) — deterministic and
   reproducible for a given input.
5. Per-section `truncated: true` is recorded in the persisted
   `<sessionId>-prompt.json` breakdown (`PromptSection.truncated`) and shown
   as a badge in the System Prompt inspector dialog, so an A/B can measure
   the before/after delta per real session, not just in synthetic tests.

## Why default OFF

This changes prompt content seen by every agent (lead/coder/reviewer/
assistant) on projects whose AGENTS.md is `@ref`-heavy. Shipping it default
-on risks silently dropping instructions a project author relied on. Default
OFF lets it be measured (via the new `truncated` flag + token deltas in the
persisted breakdown) on real managed projects before considering a
default-on rollout.

## A/B plan

1. Ship default OFF. Operators who suspect a bloated cascade opt in with
   `agents_md_budget` or `BOBBIT_AGENTSMD_BUDGET` (start around 6000–8000 tokens — keeps the
   primary file whole and typically still allows one or two @-refs through
   before capping).
2. Compare `<sessionId>-prompt.json` `totalTokens` and the `Project
   AGENTS.md` section's `tokens`/`truncated` fields across matched sessions
   with the flag off vs. on for the same project, plus reviewer/coder task
   outcome quality (does the agent ask more "where is X" follow-ups, or miss
   a constraint that was truncated away — the marker should make this
   self-diagnosable: the agent can `Read` the named path when it needs
   more).
3. If quality holds and the token savings are material (expect roughly the
   reduction curve above, scaled to the project's actual cascade size),
   consider flipping the default and/or auto-tuning the budget per role
   (e.g. a reviewer that only needs a few touched files vs. an architect
   that needs the full picture) — left for a follow-up finding, out of scope
   for this PR.

## Files touched

- `src/server/agent/system-prompt.ts` — budget primitives
  (`AgentsMdBudget`, `createAgentsMdBudget`, `resolveAgentsMdBudgetTokens`,
  `debitAgentsMdBudget`/`cutAtLineBoundary` internals), threaded through
  `resolveMarkdownRefs`/`resolveOneRef`, `readAgentsMd`, `readAllAgentFiles`,
  `_assembleSystemPrompt`, and `getPromptSections`. New optional
  `PromptParts.agentsMdBudgetTokens` and `PromptSection.truncated` fields.
- `src/ui/dialogs/SystemPromptDialog.ts` — "truncated" badge on capped
  sections.
- `tests/agents-md-cascade-budget.test.ts` — new pinning suite (budget
  resolution, truncation semantics, line-boundary determinism, multi-entry
  cascade, flag-off byte-identity, `getPromptSections` propagation, and the
  representative-cascade reproduction above).
- `docs/internals.md` — env-knob reference entry under "Config scan
  directories".
