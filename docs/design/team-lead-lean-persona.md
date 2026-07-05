# Team-Lead Lean Persona (VER-03/F8, W3.9) — Design Note

**Finding:** FINDINGS.md "Fat team-lead persona (~10k resident tokens) is
reloaded on every nudge/steer turn of the highest-cost session class"
(tracker W3.9, labeled VER-03/F8). Team-leads are the two most expensive
session classes in the audit; `defaults/roles/team-lead.yaml`'s
`promptTemplate` is resolved once at session creation and then resident as
the system prompt for every subsequent model turn of that session — every
idle-nudge, worker-idle notification, and gate pass/fail turn re-bills it
(mitigated by provider prompt caching on a cache hit, full price on a
cache-miss/idle-wake).

## Measurement

| | Bytes (parsed, de-indented) | ~Tokens (4B/tok) |
|---|---|---|
| `promptTemplate` (full, unchanged) | 37,095 B | ~9.3k |
| `promptTemplateLean` (new, opt-in) | 10,721 B | ~2.7k |
| **Reduction** | **-71.1%** (-26,374 B) | |

Measured via `parseRoleYaml()` on `defaults/roles/team-lead.yaml` with
`BOBBIT_LEAN_TEAM_LEAD` unset vs `"1"` (see
`tests/team-lead-lean-persona.test.ts`). The finding's own reproduction used
raw-file line/byte counts including YAML indentation (`tail -n +49 ... | wc
-lc` → 37,725 B); the table above uses the actual de-indented string the
model receives, which is the correct apples-to-apples number for both
variants.

## Mechanism — opt-in, byte-disjoint, single flag

`defaults/roles/team-lead.yaml` gained one new top-level field,
`promptTemplateLean`, alongside the existing `promptTemplate`. Both are
static YAML block scalars — no runtime cost to keep both around.

`src/server/agent/builtin-config.ts::parseRoleYaml()` (the single canonical
role-YAML parser shared by `BuiltinConfigProvider` and the pack resolver's
`RoleLoader` — see the "Do NOT fork these" comment at the top of the file)
now resolves the *effective* `promptTemplate` via
`resolveEffectivePromptTemplate()`:

```ts
function resolveEffectivePromptTemplate(data): string {
  if (
    data.name === "team-lead" &&
    process.env.BOBBIT_LEAN_TEAM_LEAD === "1" &&
    typeof data.promptTemplateLean === "string" &&
    data.promptTemplateLean.length > 0
  ) {
    return data.promptTemplateLean;
  }
  return data.promptTemplate ?? "";
}
```

- **Default OFF.** With the env var unset (or any value other than the exact
  string `"1"`), every consumer of `role.promptTemplate` — `role-prompt.ts`,
  `team-manager.ts`, `verification-harness.ts`, `session-manager.ts`,
  `server.ts`, etc. — sees exactly the original `promptTemplate` field,
  byte-for-byte. This is pinned by
  `tests/team-lead-lean-persona.test.ts` ("flag unset ⇒ effective template
  is byte-identical to the raw promptTemplate field") and by the pre-existing
  `tests/local-only-role-prompts.test.ts` (unmodified — it regexes the raw
  `promptTemplate:` YAML field directly and continues to pass unchanged).
- **Scoped to team-lead only.** The check is `data.name === "team-lead"`; no
  other role defines `promptTemplateLean`, so the flag is a no-op for every
  other role regardless of its value (pinned in the test suite).
- **Single insertion point.** Because every role-loading path funnels through
  `parseRoleYaml`, there was exactly one place to change — no risk of the
  pack-resolver path and the legacy `BuiltinConfigProvider` path drifting.

## Fix approach — lazy skills, not deletion

Bobbit already ships a mechanism for exactly this shape of problem:
`activate_skill` (`defaults/tools/skills/extension.ts` →
`POST /api/sessions/:id/activate-skill`), gated by the `Skills` tool group
which defaults to `allow` (`defaults/tool-group-policies.yaml`) — so
team-lead did not need any `toolPolicies` change to use it. Four new
built-in skills carry the moved content, loaded on demand exactly like
`defaults/skills/html` and `defaults/skills/mockup` already are:

- `defaults/skills/team-lead-tools/SKILL.md` — full team/task/gate tool
  parameter reference + worked examples, and the reuse-vs-custom
  role/workflow decision guide.
- `defaults/skills/team-lead-gates/SKILL.md` — content-gate authoring
  patterns, the command-format-gate pre-signal checklist + verification
  execution context, the merge/cherry-pick/conflict-resolution recipe,
  expect-failure gate semantics, documentation-gate delegation, and gate
  re-signaling behavior.
- `defaults/skills/team-lead-orchestration/SKILL.md` — sub-goal pause/resume
  ownership, concurrency/divergence-policy knobs, task/agent lifecycle, and
  the layered gate/task information-gathering (dashboard → detail → content)
  recipe.
- `defaults/skills/team-lead-completion/SKILL.md` — the exact goal-completion
  command sequence (master merge, push, PR creation/detection, `ready-to-merge`,
  `team_complete`).

**One real limitation surfaced during this work:** `activate_skill` 403s on
`disable-model-invocation: true`, and there is currently no way to mark a
skill "model-invocable but excluded from the auto-injected Available Skills
catalog." That catalog (`system-prompt.ts::buildSkillsCatalogSection`) is
resident in **every** session with `activate_skill` allowed, not just
team-lead's — so these four skills add roughly one ~100–200 byte bullet each
to that shared catalog for every role/session in the project, not only
team-lead's. This is a small, one-time, already-existing-mechanism cost
(~600–800 B against a 16 KB catalog budget) traded for removing ~26 KB from
every team-lead turn when the flag is on; it is not gated by
`BOBBIT_LEAN_TEAM_LEAD` because skill *files* are static content — only the
team-lead prompt's *use* of them is flagged.

## Section disposition table

Every heading of the original `promptTemplate` (lines 51–449), and where its
content ended up. "Kept-resident" means the substance is still in
`promptTemplateLean`, possibly reworded/condensed; "moved" means the full
elaboration lives only in a skill (a short pointer + the load-bearing
invariant, if any, stays resident); "dropped" is the only case where content
did not survive, with justification.

| Original section | Disposition | Notes |
|---|---|---|
| Identity + goal-nesting awareness | **Kept-resident** (condensed) | Root-vs-child PR responsibility kept; procedural conditional block replaced with a plain pointer to `team-lead-orchestration` (no `{if:}` — see below) |
| Your Role | **Kept-resident**, verbatim | Core identity directive |
| Parallelism & Conflict Avoidance | **Kept-resident** (trimmed) + **moved** | Bullets kept; full merge/cherry-pick/remote-handoff nuance → `team-lead-gates` |
| Critical Constraints | **Kept-resident**, verbatim | Hard invariant (never merge/push master) |
| Tools (Team/Task/Gate Management full docs) | **Kept-resident**: one-line pointer only. **Moved**: full param docs + examples → `team-lead-tools` | Dropped-with-justification for the *duplication*, not the content: this is largely a restatement of the resident global "Tools" system-prompt section (`tool-manager.ts::getToolDocsForPrompt`, `system-prompt.ts` section 3), which every session already gets for its allowed tools, plus a `.bobbit/state/tool-docs/<group>.md` pointer for full detail. The hard rule ("never curl/REST") stays resident. |
| Children Management (pause/resume) + Sub-goal knobs | **Kept-resident**: the one never-overridable rule (criteria-drop always rejected). **Moved**: full pause/resume ownership, `maxConcurrentChildren`, `divergencePolicy` classifier detail → `team-lead-orchestration` | Was already gated by `{if:subGoalsEnabled}`; the lean prompt drops the `{if:}/{endif:}` conditional syntax entirely (always shows a one-line pointer) rather than reintroducing conditional-markup risk for a rarely-used feature |
| Available Roles | **Kept-resident**, verbatim (incl. `{{AVAILABLE_ROLES}}`) | Needed every spawn decision |
| Reuse existing roles/workflows | **Kept-resident** (one-line summary) + **moved** | Full exception-justification guide + `inlineRoles`/`propose_role` mechanics → `team-lead-tools` |
| Workflow System | **Kept-resident** (condensed numbered list) | Core DAG-following directive; "avoid duplicate validation" and "check quality criteria" kept; gate-content-quality detail folded in |
| Gate Content Quality | **Kept-resident** (condensed into the Workflow System list) | Cheap (3 short clauses), valuable every content-gate turn |
| Gate Signaling — You Own Every Signal | **Kept-resident** (condensed) | Hard invariant; explicit gate/role name enumeration dropped since enforcement is server-side tool-policy, not prompt text |
| Producers vs Verifiers | **Kept-resident** (condensed) | Hard guardrail against spawning reviewers as producers |
| Producing Content for Content Gates | **Moved** → `team-lead-gates` | Direct-draft vs delegated-artifact patterns; situational |
| Command-Format Gates (+ verification execution context + pre-signal checklist) | **Kept-resident**: the "#1 cause of gate failures" one-liner. **Moved**: full checklist + execution-context detail → `team-lead-gates` | |
| Merging member branches — the standard flow | **Moved** → `team-lead-gates` (verbatim, incl. "No remote fetch needed…") | Core one-liner ("do NOT signal before merging") kept resident via the Command-Format Gates rule |
| Expect-Failure Gates | **Moved** → `team-lead-gates` | Situational (only `reproducing-test`-style gates) |
| Documentation Gate | **Kept-resident** (one line: delegate to docs-writer) + **moved** (AGENTS.md-vs-docs/ guidance) → `team-lead-gates` | |
| Frontend Changes: UX Design | **Kept-resident**, condensed to one sentence | Cheap, short |
| **Available Skills** (hardcoded list: correctness-review, security-review, design-review, test-suite-report) | **Dropped**, justified | Stale/dead: verified via repo-wide grep that none of these four named skills exist anywhere in this repo (`defaults/skills`, `market-packs/*/skills`). The *real* Available Skills catalog is auto-injected by `system-prompt.ts::buildSkillsCatalogSection` from actually-discovered skills — this hand-maintained list predates/duplicates that mechanism and was already wrong |
| What You Do | **Kept-resident**, condensed | |
| What You Do NOT Do | **Kept-resident**, de-duplicated | The "never merge/push master" rule was restated 3× across the original persona (Critical Constraints, here, and Command-Format Gates) — the finding calls this out by name as bloat evidence. The lean prompt keeps it 2× (belt-and-suspenders) instead of 3× — the rule itself is not diluted, only its repetition count |
| Startup Sequence | **Kept-resident** (trimmed) | First-turn checklist; the `degraded-execution` warning detail → `team-lead-orchestration` pointer |
| Task Lifecycle | **Kept-resident** (condensed to one paragraph) + **moved** (full detail) → `team-lead-orchestration` | |
| Agent Lifecycle — One Agent Per Milestone | **Kept-resident** (folded into the same paragraph) + **moved** (full detail) → `team-lead-orchestration` | |
| Consuming Agent Results — Layered Information Gathering | **Moved** → `team-lead-orchestration` (verbatim) | Largest single chunk (~38 lines); one summary rule kept resident in Workflow System ("gate_status, then step-scoped gate_inspect") |
| Handling Merge Conflicts | **Moved** → `team-lead-gates` | |
| Notification System — DO NOT POLL OR SLEEP | **Kept-resident**, condensed to one paragraph | Hard invariant, cheap |
| Gate Re-Signaling Behavior | **Kept-resident**: one clause ("re-signaling cancels in-flight verification"). **Moved**: full guidance → `team-lead-gates` | |
| Completion | **Kept-resident** (one paragraph: mandatory PR, master merge, ready-to-merge, never merge PR yourself). **Moved**: exact command sequence + orphaned-PR detection → `team-lead-completion` | |
| Drive to Completion | **Kept-resident**, verbatim in spirit | Closing operational loop |

## Quality bar / verification

- `tests/team-lead-lean-persona.test.ts` (new): flag-off byte-identity,
  flag-on selection + byte budget, no-effect-on-other-roles scoping, every
  hard invariant present as a substring in the lean prompt, every
  `activate_skill(name="...")` pointer resolves to a real model-invocable
  skill, and all four new `SKILL.md` files parse through `scanSkillDir` (the
  same function the pack resolver's `SkillLoader` uses for `defaults-tree`
  packs) with no leftover `{{...}}` role-prompt placeholders.
- Pre-existing suite: `tests/role-prompt.test.ts`,
  `tests/local-only-role-prompts.test.ts`,
  `tests/role-team-tools-policy.test.ts`,
  `tests/role-gate-signal-policy.test.ts`, `tests/prompt-conditionals.test.ts`,
  `tests/role-children-tools-policy.test.ts` — all pass unmodified.
- `npm run check` — clean.
- Full `npm run test:unit` run: pre-existing, unrelated failures only
  (`container-path-translation.test.ts`, `pack-contributions.test.ts` ×3,
  `provider-bridge-extension.test.ts`, `verification-harness-parallel-reviews.test.ts`
  — none touch roles, prompts, or skills; confirmed present without this
  change too).

## What was intentionally NOT done

- No BENCH-GATE / live agent A/B run — this PR is the mechanism +
  measurement + disposition table; the finding rates this "staged/high-risk"
  and the fix sketch explicitly calls for benching the rewrite before
  flipping the default. `BOBBIT_LEAN_TEAM_LEAD` ships **default OFF**;
  flipping it to default-on is a follow-up once a live orchestration run
  confirms lead behavior holds (gate discipline, no-sibling-spawn guardrails,
  etc.) under the lean persona.
- No change to `toolPolicies` — the `Skills` tool group already defaults to
  `allow`, so `activate_skill` was already reachable by team-lead with zero
  policy change.
