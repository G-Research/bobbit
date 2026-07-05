# Verification-harness policy seam (S8)

Status: **design only — no code moves in this doc's PR.** Deliverable per the
Fable extension-seam audit
(`~/Documents/dev/bobbit-fable-refactor/EXTENSION-SEAM-AUDIT.md`, row
"Verification harness" and slice S8): the 6,957-line
`src/server/agent/verification-harness.ts` fuses generic spawn/collect
primitives with product policy in one class, no declarative policy schema
exists today, and the invariant a move would need to preserve ("swapping
policy cannot change primitive semantics") is **not pinnable yet**. Per repo
doctrine (`AGENTS.md` — "if a regression isn't caught by a test, the missing
test IS the bug"), the correct deliverable right now is the seam design and
the list of pins each future slice needs, not a code move.

All line numbers verified live in this worktree
(`fable/d5-verif-policy-seam`, based on `origin/aj-current`) on 2026-07-05 —
grep and read, not recalled.

---

## 0. Orientation report

1. **LSP.** No LSP tool was available in this session (`ToolSearch` returned
   no `documentSymbol`-shaped tool), and the graphify MCP server is listed as
   `⏸ Pending approval` (`claude mcp list`) — it cannot be queried without an
   interactive approval this lane doesn't have. Orientation below uses `rg`
   + `Read` only, cross-checked against the audit's own cited line numbers
   (which were themselves verified against this same tip).
2. **Harness shape.** `verification-harness.ts` is 6,957 lines. Two
   top-level declarations: `class PendingCommandCleanupError` (line 25) and
   `export class VerificationHarness` (line 1405, running to EOF). 39 class
   methods matched by `^\s*(private|public|protected|async|static)+\s+\w+\(`
   (module-scope helper functions like `buildReviewPrompt`, `isPidAlive`,
   `readCommandLogTail` are separate, not counted). One method —
   `verifyGateSignal` (3305–4662, ~1,357 lines) — is both the largest method
   in the file and the one carrying the highest policy density (gate-id
   rewrite, cache-mode selection, phase/parallel-review orchestration all
   live in its body).
3. **Sibling module.** `src/server/agent/verification-logic.ts` (1,060
   lines) already holds the *pure* decision functions the harness calls into
   — `resolveGateCacheMode`, `buildStepCache`/`buildContentStepCache`,
   `groupStepsByPhase`, `isParallelReviewsEnabled`,
   `readyToMergeUnresolvedBuiltinFailure`, retry/backoff classifiers. This
   module is already the harness's "logic, deps-injected" half; it is not a
   declarative schema, but it is the natural landing spot for policy
   descriptors once they exist (see §2).
4. **Docs read for constraints**: `docs/design/gate-step-cache.md` (VER-01,
   full per-step cache-key table + A/B plan for `BOBBIT_GATE_CACHE`),
   `docs/design/human-signoff-gates.md` (third step-type precedent — how a
   new verification behavior was added compositionally, without touching the
   phase/fan-out primitives), `docs/design/swarm-orchestration-w1.md` +
   `docs/design/session-manager-decomposition.md` (S3/SM-decomp sequencing,
   §6 below), `docs/goals-workflows-tasks.md` §"Parallel reviews" (
   `BOBBIT_PARALLEL_REVIEWS` user-facing contract), `docs/marketplace.md`
   (`PackResolver` mechanism, §4 below). Tests: `rg -l
   verification-harness tests/` → 44 files (unit + `tests/e2e/*.spec.ts`);
   titles surveyed, not bodies (list in §5).

---

## 1. Inventory — policy vs. primitive

| # | Decision | File:line | Class | Why |
|---|---|---|---|---|
| 1 | `ready-to-merge` gate-id string match → child-merge verify rewrite | `verification-harness.ts:3319-3328` (also `verification-logic.ts:517` `readyToMergeUnresolvedBuiltinFailure`, `child-ready-to-merge.ts:1-30`, `verification-harness.ts` spawn-time call in `runSubgoalStep`) | **POLICY, leaked as a magic string** | `WorkflowGate` (`workflow-store.ts:103-113`) has no semantic-role field — only `id: string`. Three call sites independently test `gateId === "ready-to-merge"` to decide child-vs-root merge semantics. This is workflow authoring policy (what a gate named "ready-to-merge" *means*) fused into primitive dispatch code. |
| 2 | Gate-cache mode selection + default | `verification-harness.ts:3419` `resolveGateCacheMode(process.env.BOBBIT_GATE_CACHE)` | **POLICY** (mechanism in `verification-logic.ts:855-874` is a pure fn — already close to declarative) | Mode is a raw `process.env` read inline in the hot path, not a project/workflow config field. `docs/design/gate-step-cache.md` already frames it as "a pure A/B knob" — i.e. self-describes as policy, not primitive. |
| 3 | Parallel-reviews mode + default | `verification-harness.ts:4041` `isParallelReviewsEnabled(process.env.BOBBIT_PARALLEL_REVIEWS)` | **POLICY** | Same shape as #2 — env-var-gated behavioral policy read inline mid-method rather than sourced from config. |
| 4 | Review-prompt wrapper (working-directory instructions, `verification_result` call contract, upstream-gate-content injection, baseline-SHA resolution) | `buildReviewPrompt`, `verification-harness.ts:1119-1208` (full function to ~1380) | **Mostly PRIMITIVE, smaller leak than the audit's line range implies** | The actual review *criteria* are already role-authored data (`role.promptTemplate`, resolved through the standard role/PackResolver pipeline — see §4). What's hardcoded here is context-assembly plumbing (diff embedding, working-directory caveats, the `verification_result` tool-call contract) that every reviewer needs regardless of role — this is closer to "system prompt assembly" (already judged core platform, audit row `system-prompt.ts`) than to product policy. The one real policy fragment inside it: the hardcoded `"pass" if no critical or high severity findings, "fail" otherwise` verdict rubric (line ~1185) — that rubric is prose baked into every review prompt, not sourced from the gate/step definition. |
| 5 | `ready-to-merge` required-builtin failure list | `verification-logic.ts:509` `READY_TO_MERGE_REQUIRED_BUILTINS` + `:516-524` | **POLICY** (same magic-string family as #1) | Hardcoded safety-check policy keyed on the same unstructured gate-id string. |
| 6 | Retry/transient-error classification (`TRANSIENT_ERROR_PATTERNS`, `PROVIDER_BACKOFF_REGEXES`, `shouldRetryVerificationStep`) | `verification-logic.ts:25-338` | **PRIMITIVE (infra classification), not product policy** | Classifies provider/infra failure signatures (rate limits, timeouts) — this is operational resilience, not a per-project/per-role authoring surface. Leave as-is; flag only for completeness. |
| 7 | Human-signoff bypass flag | `docs/design/human-signoff-gates.md` `BOBBIT_HUMAN_SIGNOFF_SKIP`, harness step-type dispatch | **PRIMITIVE with one deliberate policy carve-out** | The step *type* (`human-signoff`) and its resolver wiring are primitive (same shape as `llm-review`/`agent-qa`). The env-var test bypass is intentionally test-only and intentionally NOT unified with `BOBBIT_LLM_REVIEW_SKIP` (documented Bug-1 defense-in-depth) — do not fold into the general policy surface; it is a safety-motivated exception, not a workflow-authoring knob. |
| 8 | Phase fan-out / step-state / spawn-collect (`groupStepsByPhase`, `getSortedPhases`, `computeEarlyReviewPhases`, active-verification persistence) | `verification-logic.ts:661-762`, `verification-harness.ts:1668-1919` (`_persistActive`/`_loadActive`/`_findStepDefinition`) | **CORE PRIMITIVE** | Generic execution machinery; already deps-injected pure functions where it matters (`groupStepsByPhase` takes step arrays, no policy branching). |
| 9 | Process management (spawn/kill/heartbeat/PID-identity), result stores, restart/resume | `verification-harness.ts:2760-3148` (command-identity + kill-cleanup), `1706-1981` (`resumeInterruptedVerifications`) | **CORE PRIMITIVE** | Security/liveness-critical process bookkeeping; no product policy branching found. |
| 10 | Swarm turn-budget governor call | `verification-harness.ts` field `swarmGovernor` consumed from `session-manager.ts:5019-5038`; harness stores it at `_verificationHarness` field set at `session-manager.ts:1315` | **Not this doc's scope — tracked as S3** | Audit's own S3 slice. Documented here only for the coupling note in §6 — the harness and the governor share the same `_verificationHarness` field on `SessionManager`, so S8 code moves and S3 must not fight over that seam. |

**Top-5 policy leaks (file:line), ranked by blast radius if left as-is:**

1. `gate.id === "ready-to-merge"` magic-string dispatch — 3 independent call sites (`verification-harness.ts:3319`, `verification-logic.ts:517`, `child-ready-to-merge.ts` callers) that must stay in sync by convention, not by type.
2. `resolveGateCacheMode(process.env.BOBBIT_GATE_CACHE)` inline at `verification-harness.ts:3419` — an A/B lever read from `process.env` mid-method instead of from project/workflow config.
3. `isParallelReviewsEnabled(process.env.BOBBIT_PARALLEL_REVIEWS)` inline at `verification-harness.ts:4041` — same shape as #2.
4. The verdict rubric string embedded in `buildReviewPrompt` (`verification-harness.ts:~1185`, `"pass" if no critical or high severity findings, "fail" otherwise`) — every reviewer gets the same severity bar regardless of gate/workflow authoring intent.
5. `READY_TO_MERGE_REQUIRED_BUILTINS` (`verification-logic.ts:509`) — a hardcoded required-variable list for a gate identified only by its string id, same family as #1.

---

## 2. The seam: `VerificationPolicy`

```ts
// src/server/agent/verification-policy.ts (proposed — NOT created by this PR)

/** Named cache strategy — mirrors GateCacheMode but as policy data, not an env read. */
export type GateCacheStrategy = "sha" | "content";

export interface VerificationPolicy {
  /** Default gate-cache strategy when a workflow/project doesn't override it. */
  gateCacheDefault: GateCacheStrategy;
  /** Whether the leading contiguous review-phase block may start concurrently
   *  with the command phases preceding it. */
  parallelReviewsDefault: boolean;
  /**
   * Declarative replacement for the `gate.id === "ready-to-merge"` family.
   * Keyed by *semantic role*, not by gate id string — a workflow gate opts in
   * via `WorkflowGate.role: "ready-to-merge"` (new optional field) instead of
   * relying on a specific id spelling.
   */
  gateRoles: Record<string, {
    /** Verify-step rewrite rule applied when the owning goal is a child (mergeTarget === "parent"). */
    childRewrite?: "adapt-ready-to-merge" | "none";
    /** Required built-in template vars whose non-substitution fails (not skips) the step. */
    requiredBuiltins?: string[];
  }>;
  /** Review verdict rubric, injected into buildReviewPrompt's wrapper instead of a hardcoded string. */
  reviewVerdictRubric: string;
}
```

This is **one typed interface + a declarative YAML doc under `defaults/`**,
mirroring the `defaults/tool-group-policies.yaml` convention (builtin
default, project-overridable, comment-documented, pinned by a dedicated
test):

- `defaults/verification-policy.yaml` — ships the byte-identical-to-today
  defaults (`gateCacheDefault: sha`, `parallelReviewsDefault: true` — flipped
  from `false` when `BOBBIT_PARALLEL_REVIEWS` went default-on with the
  retry-aware early-start guard, see `docs/goals-workflows-tasks.md`'s
  "Parallel reviews" section — `gateRoles: { ready-to-merge: { childRewrite: adapt-ready-to-merge,
  requiredBuiltins: [branch, baseBranch, master, cwd, goal_spec, commit] } }`,
  `reviewVerdictRubric` = today's literal string).
- `.bobbit/config/verification-policy.yaml` — project override, loaded
  through the **same `ConfigCascade` precedence** `tool-group-policies.yaml`
  already uses (builtin → project), *not* through `PackResolver`. See §4 for
  why this is the correct mechanism and not a `PackResolver`-resolved entity
  type.
- A pure `resolveVerificationPolicy(raw): VerificationPolicy` loader lives in
  `verification-logic.ts` next to `resolveGateCacheMode` — same "fails
  closed on bad input" contract that function already documents.

**Env vars become overrides of policy fields, not the source of truth**:
`BOBBIT_GATE_CACHE` / `BOBBIT_PARALLEL_REVIEWS`, when set, take precedence
over `gateCacheDefault`/`parallelReviewsDefault` (operational A/B knob for a
running deployment); when unset, the resolved `VerificationPolicy` field
governs. This preserves every existing A/B-testing workflow
(`docs/design/gate-step-cache.md`'s hit-rate comparison, the parallel-reviews
opt-in) while giving projects a way to set a *default* without touching env
vars. See §6 for the precedence rule in full.

**What `verifyGateSignal` calls change to, conceptually** (not this PR):

```ts
const gateCacheMode = process.env.BOBBIT_GATE_CACHE
  ? resolveGateCacheMode(process.env.BOBBIT_GATE_CACHE)
  : this.policy.gateCacheDefault;

const gateRole = this.policy.gateRoles[effectiveGate.id];
if (gateRole?.childRewrite === "adapt-ready-to-merge" && rtmGoal?.mergeTarget === "parent" && rtmParent?.branch) {
  effectiveGate = { ...gate, verify: adaptReadyToMergeVerify(gate.verify, { parentBranch: rtmParent.branch }) };
}
```

This is a data-lookup replacing a string-literal `if`, not a behavior
change — the migration's whole point (§5, slice V1) is byte-identical output
for every existing workflow, proven by a parity test before the code moves.

---

## 3. What stays hardcoded, and why

- **Retry/transient-error classification** (`verification-logic.ts:25-338`,
  item #6 above) — infra resilience, not an authoring surface. No project
  has ever needed to customize "is this a rate-limit error." Moving it to
  policy would add a config surface nobody asks for and risks a
  misconfigured project silently disabling retry.
- **`BOBBIT_HUMAN_SIGNOFF_SKIP`** (item #7) — deliberately isolated by
  design (`docs/design/human-signoff-gates.md`'s Bug-1 defense-in-depth); a
  human-decided gate must never share a bypass surface with LLM-review
  skips. Keeping it a distinct, non-policy env var is the safety property,
  not a gap.
- **Phase fan-out / spawn-collect / process management / restart-resume**
  (items #8, #9) — genuine core primitives per the audit's own doctrine
  (security/liveness-critical, no policy branching found). Nothing here
  moves.
- **The bulk of `buildReviewPrompt`'s wrapper text** (working-directory
  caveats, the `verification_result` tool-call contract, upstream-gate
  content injection) — this is context-assembly plumbing every reviewer
  needs verbatim; making it a per-workflow authoring surface would let a
  project accidentally break the `verification_result` contract the harness
  depends on to receive results. Only the verdict rubric (leak #4) is worth
  extracting; the rest stays with system-prompt-assembly-style "core,
  config-driven only at the edges" treatment (matches the audit's verdict on
  `system-prompt.ts` itself).

---

## 4. How packs/workflows override it

Two distinct override paths, corresponding to two distinct policy
surfaces — conflating them would be the wrong design, so this section is
explicit about which mechanism owns what:

**(a) Gate/step *shape* (which steps exist, their order, deps, cache globs)
is already workflow-authored, and already NOT a `PackResolver` entity.**
`WorkflowGate`/`VerifyStep` definitions live inline in `project.yaml::workflows`
(`workflow-store.ts:1-13` — "Workflows now live inline in `project.yaml`...
a thin facade over `ProjectConfigStore`"), loaded through `ConfigCascade`,
not `PackResolver`. `docs/marketplace.md`'s `EntityType` is explicitly `"roles"
| "tools" | "skills"` only (`pack-types.ts:24`, comment: "+ `mcp` | `panels`
later") — gates/workflows are not, and per this design should not become,
a fourth `PackResolver` entity type. This is already the correct seam
(`docs/design/gate-step-cache.md`'s own W3.1b section demonstrates a project
declaring real `cacheInputGlobs` per step with zero core code change) — the
new `VerificationPolicy` YAML in §2 is a sibling config file loaded the
*same way* (`ConfigCascade`, project overrides builtin), not a new
`PackResolver`-mediated kind.

**(b) Review *criteria* (what a reviewer is told to look for) are already
pack/role-authored, through `PackResolver`.** `buildReviewPrompt`'s
`role: { promptTemplate: string }` parameter is resolved the same way every
other role field is — through the unified `PackResolver` (`pack-resolver.ts:36`,
`pack-types.ts` `EntityType: "roles"`), which already lets a pack ship a
custom reviewer role with its own `promptTemplate` and have it shadow a
built-in reviewer by pack precedence (`docs/marketplace.md` §"Core concept:
one resolver over one ordered list" — "a name defined by a higher-priority
pack shadows the same name in a lower one"). Nothing new is needed here; the
seam design just needs to (per §1 leak #4) extract the one hardcoded
sentence (the verdict rubric) out of the wrapper and into
`VerificationPolicy.reviewVerdictRubric`, so a pack/project can tune
"what counts as pass/fail" without forking the wrapper.

**Net shape**: `VerificationPolicy` (§2) is a `ConfigCascade`-loaded
sibling of `tool-group-policies.yaml`, not a `PackResolver` entity. Review
*content* stays with `PackResolver`-resolved roles (unchanged, already
correct). Gate *shape* stays with `ConfigCascade`-loaded `project.yaml`
workflows (unchanged, already correct). The new seam only covers the
residual policy fused into `verification-harness.ts` itself (§1's five
leaks) — nothing about this design proposes routing verification policy
through `PackResolver`.

---

## 5. Migration plan — slices, each gated on a pre-existing pin

No slice below may land before its pin exists and is green on `aj-current`.
Each pin is a **new** test unless marked "(exists)".

| Slice | Change | Pinning test (must exist FIRST) | What it pins | Phase (`docs/testing-strategy.md`) |
|---|---|---|---|---|
| **V0** | Land `defaults/verification-policy.yaml` + `resolveVerificationPolicy()` in `verification-logic.ts`, with **zero call sites wired up yet** (dead code, unit-tested alone) | `tests/verification-policy.test.ts` (new) — pure-function tests: defaults round-trip byte-identical to today's hardcoded values (`sha`, `false`, the exact `ready-to-merge` builtins list, the exact verdict-rubric string); malformed/partial YAML fails closed to defaults | The loader's parse/defaults/fail-closed contract, in isolation, before anything depends on it | unit·node |
| **V1** | Wire `gateRoles["ready-to-merge"]` lookup to replace the `gate.id === "ready-to-merge"` literal at `verification-harness.ts:3319` (and the two sibling call sites) | `tests/gate-role-lookup-parity.test.ts` (new) — for every existing workflow shipped in `seed-default-workflows.ts` plus a synthetic workflow with a *renamed* ready-to-merge-equivalent gate, assert identical child-rewrite behavior before/after; add a regression case proving a gate NOT declared in `gateRoles` never gets the rewrite (today's magic-string exact-match semantics preserved) | Behavior-identity of the id→role generalization, including the "only this exact string" edge case that made it fragile | unit·node |
| **V2** | Wire `gateCacheDefault`/`parallelReviewsDefault` as the fallback when the corresponding env var is unset (§2's precedence rule) | `tests/gate-cache-policy-precedence.test.ts` (new) — matrix: {env set to sha, env set to content, env unset + policy=sha, env unset + policy=content} × same for parallel-reviews; assert env always wins when set, policy governs only when unset | The precedence contract itself (existing `tests/verification-logic.test.ts` and `tests/gate-cache-globs-adoption.test.ts` (exist) continue to pin `resolveGateCacheMode`'s own behavior unchanged — this slice only adds a fallback source, never edits that function) | unit·node |
| **V3** | Extract the verdict rubric string out of `buildReviewPrompt` into `policy.reviewVerdictRubric` | `tests/review-prompt-verdict-rubric.test.ts` (new) — snapshot the exact assembled prompt text before/after for a fixture role+step, byte-identical when policy uses the shipped default | Prompt byte-parity (same pattern the audit's own S6 slice proposes for goal-nesting stanzas) | unit·node |
| **V4** | Add `WorkflowGate.role?: string` schema field (optional, defaults to id-based inference for back-compat) so future workflows can declare gate role explicitly instead of relying on the `"ready-to-merge"` spelling | `tests/workflow-gate-role-field.test.ts` (new) + extend `tests/workflow-step-shapes.test.ts` (exists) — round-trip load/save preserves the field; absence infers from id exactly as V1 left it | Schema back-compat: old `project.yaml` files with no `role` field behave identically | unit·node |

Every slice above is **additive and behavior-preserving by construction** —
none deletes the `gate.id === "ready-to-merge"` string checks until V4 ships
and a follow-up (out of scope here, and explicitly **not** proposed by this
doc) migrates seed workflows to declare `role` explicitly. This design doc
does not schedule that follow-up; it only makes it possible without another
unpinned 7k-line entanglement.

---

## 6. Interaction with the A/B flags

Both existing flags become **overrides of `VerificationPolicy` fields**, not
replacements:

- `BOBBIT_GATE_CACHE` → overrides `gateCacheDefault` when set to a valid
  literal (`"content"`); any other value (unset, typo) falls through to the
  policy field, which itself defaults to `"sha"`. This is **exactly**
  `resolveGateCacheMode`'s existing fail-closed contract
  (`verification-logic.ts:863-874`), just given a second, lower-priority
  input source. `docs/design/gate-step-cache.md`'s A/B plan (env-var flip,
  compare via the `[verification][gate-cache]` log line) is unaffected —
  env-var flips still work identically; a project can additionally pin a
  *default* once the A/B settles, without redeploying with an env var.
- `BOBBIT_PARALLEL_REVIEWS` → same shape, overrides `parallelReviewsDefault`.
- Neither flag is deprecated or removed by this design. The seam is
  additive: it gives config-driven projects a way to set what today can
  only be set via process environment, while preserving the env var as the
  fast, zero-redeploy operational override for live A/B experiments.

---

## 7. Explicit sequencing against in-flight work

This design must **compose with, not duplicate**, three lines of in-flight
work identified by the extension-seam audit:

1. **Upstream-sync** (`fable/d5-upstream-sync`, unmerged 4-commit series
   touching `server.ts`, both `session-manager.ts` files — 209 files
   pending per the audit §0). `verification-harness.ts` and
   `verification-logic.ts` are not in that file set as of this writing, but
   `session-manager.ts` (the `_verificationHarness` field host) is. **No V1–V4
   code slice lands before upstream-sync lands** — same hard gate the audit
   applies to S1/S3/S4/S5.
2. **SessionManager decomposition** (`docs/design/session-manager-decomposition.md`,
   unmerged spike at `fable/d5-str06-spike`). Cohort 4 ("bring-up
   unification onto `session-setup.ts`") is the relevant neighbor: it does
   not touch `verification-harness.ts` directly, but the `_verificationHarness`
   field (session-manager.ts:1193/1315) is adjacent to the swarm-governor
   inline branch (`trackCostFromEvent`, session-manager.ts:5019-5038) that
   cohort 4's own §6.4 flags as a concurrency risk for **S3**. V1–V4 above
   touch only `verification-harness.ts`/`verification-logic.ts`/
   `workflow-store.ts` and never `session-manager.ts`, so they do not
   collide with cohort 4's rework — but land them **after** cohort 4 anyway,
   as a matter of reducing concurrent-branch risk in the same file
   neighborhood the audit already flagged as contended.
3. **Swarm governor seam (S3)**. S3 wraps the *same* `_verificationHarness`
   field this doc's slices read from (`swarmGovernor` is a property
   accessed off the harness instance, `session-manager.ts:5028`). S3's typed
   `TurnBudgetGovernor` port and this doc's `VerificationPolicy` are
   **orthogonal** — S3 is about *who* checks token budget and how the
   harness exposes that check; this doc is about *what gate/review policy*
   the harness applies. Neither slice's diff touches the other's target
   lines (S3: `session-manager.ts:1193,1315,5019-5038` + a thin adapter in
   `verification-harness.ts:1437`; this doc: `verification-harness.ts:3319-3429,4041`,
   `~1185`, `verification-logic.ts:509-524`). Sequence **S3 first** anyway
   (per the audit's own ordering, S3 rides behind SM-decomp cohort 4) so
   that V1–V4's diffs are reviewed against a harness that already has S3's
   adapter shape, avoiding two independent PRs both narrating "here's a new
   field on `VerificationHarness`" in the same review window.

**Sequencing summary**: `upstream-sync` → `SM-decomp cohort 4` → `S3` →
`V0` (independent, can start anytime — pure addition) → `V1` → `V2` → `V3` →
`V4`. V0 is the only slice with no upstream dependency and could land
today as dead code; V1–V4 wait behind the three gates above.

---

## 8. Summary

| | |
|---|---|
| Deliverable | This doc only — no production code changed |
| Top policy leaks | `ready-to-merge` magic-string dispatch (×3 call sites), inline `process.env` reads for cache-mode/parallel-reviews, hardcoded verdict rubric, hardcoded required-builtins list |
| Seam shape | Typed `VerificationPolicy` interface + `defaults/verification-policy.yaml`, loaded via `ConfigCascade` (mirroring `tool-group-policies.yaml`) — **not** a `PackResolver` entity type. Review-criteria overrides continue via `PackResolver`-resolved role `promptTemplate` (already correct); gate-shape overrides continue via `project.yaml` workflows under `ConfigCascade` (already correct). The new file only covers the residual harness-internal policy. |
| Migration | V0 (dead-code loader) → V1 (gate-role lookup) → V2 (env/policy precedence) → V3 (verdict rubric) → V4 (schema field) — each behind a named pinning test, each additive/behavior-preserving |
| Sequencing | After upstream-sync AND SM-decomp cohort 4 AND S3, except V0 (independent) |
