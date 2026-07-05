# CLF — Classifier Framework lane: in-repo status ledger

Status: Wave 5 shipped (gate-risk classifier, observe-only). Wave 4 shipped
(model-tier classifier, observe-only). Wave 3 (F14
thinking-router apply mode) shipped behind `BOBBIT_CLF_THINKING_ROUTER=enforce`,
defaulting to observe — unset/`=observe` stays byte-identical to Wave 1(b).
The full design (interception points, the select/abstain `Decision`
model, the RO/RW mount-property safety model, and the phased wave plan) lives
in the Fable program's classifier-framework design note — that document is
tracked outside this repo, so it is referenced here only by name, never by
machine path (see AGENTS.md's "no machine paths in source" convention). This
file is the in-repo mirror of that document's own "Wave N status" sections,
kept close to the code it describes so a reader doesn't need the external doc
just to see what's shipped vs. deferred.

## Wave 0(b) — the seam, dark

`decision-types.ts` + `LifecycleHub.dispatchDecision`/`allowDecisionPoint`/
`registerDecisionClassifier`: a typed `Decision<TChoice>` (`select` |
`abstain` — no `mutate`/`veto` yet, see `decision-types.ts`'s header for why),
a per-`(point, kind)` allow-list, and outcome tracing. No production call site
consults it. Pinned by `tests/lifecycle-hub-dispatch-decision.test.ts`.

## Wave 1(a) — transparency first

`ContextTraceStore.appendDecision` + the transparency-panel decision rows,
landed **before** any real classifier, so a decision is always user-visible
the moment one exists. See `tests/e2e/ui/transparency-panel.spec.ts`'s
CLF-W1a block.

## Wave 1(b) — F14 thinking router (first real classifier)

`thinking-router-classifier.ts`: a small deterministic regex rule table
(`ultrathink` / `think harder` → `xhigh`), registered for real at gateway
construction (`registerThinkingRouterClassifier`, `server.ts`). Observe-mode
only — `SessionManager.enqueuePrompt` records the decision but nothing applies
it yet (no `setThinkingLevel` call on this path).

**S7 (extension-seam audit) — pack-declared rule-table override.** The RULES
table stays the built-in default, but a pack MAY now override/extend it via a
`kind: "selector"` provider (`providers/<id>.yaml`, id
`thinking-router-rules`) whose flat `config.rules` is a plain regex→level
table (`config.mode: "extend" | "override"`, default `extend`).
`registerThinkingRouterClassifier` resolves the effective table ONCE,
synchronously, at gateway construction (`PackContributionRegistry.listProviders`
— no `moduleHost.invoke`, no worker spawn); the registered classifier's
per-prompt `evaluate()` is unchanged: a pure, zero-await regex loop. A real
pack-dispatched classifier (invoked per-prompt through `moduleHost.invoke`)
was rejected — `ModuleHost.invoke` spawns a new `worker_threads.Worker` per
call, and `enqueuePrompt` is too hot a path to pay that per submitted prompt.
Malformed pack config fails open to the built-in table; a single malformed
rule entry is dropped without discarding the rest. See
`thinking-router-classifier.ts`'s header and
`tests/thinking-router-classifier-pack-override.test.ts`.

## Wave 2 — tool-approve decision seam (harness only)

`tool-approve-classifier.ts`: the `(tool-call, tool-approve)` point/kind pair,
`ToolApproveVerdict` (`"allow" | "deny"`), `ToolApproveArg` (`toolName`,
`toolGroup`, optional `roleName` — no argument/command content), and the
`BOBBIT_CLF_TOOL_APPROVE` flag reader (`isToolApproveEnforceMode`).
`SessionManager.requestToolGrant` consults the seam for real on every
tool-permission ask — a genuine production call site, unlike Wave 0(b)'s dark
seam. `server.ts` only `allowDecisionPoint`s the pair at gateway construction;
it registers **no classifier**, so every consult abstains and production
behavior is provably unconditionally unchanged. Deliberately deferred: a real
classifier (this wave's whole point was shipping the harness + safety
mechanics first — deny short-circuits in enforce mode, allow never
auto-applies, byte-identical when the flag/hub/registration is absent — see
that file's header for the full mechanics).

## Wave 2.5 — the real tool-approve heuristic (this ledger's current head)

`tool-approve-heuristic.ts`: the first REAL classifier at
`(tool-call, tool-approve)`, mirroring Wave 1(b)'s "seam ships dark, first
real customer follows" split.

**Conservative by construction.** `ToolApproveArg` carries only tool
identity (name + group + role), never command/argument content, so this
classifier can only reason about *which* tool is being asked for, never
*what a specific invocation would do*. That rules out inventing an
argument-aware read-only policy here — see
`src/server/pr-walkthrough/walkthrough-readonly-policy.ts` for why that's a
deliberately separate, narrower, argument-aware allowlist scoped to the PR
Walkthrough pack's own `readonly_bash` tool, not a general-purpose model.

Given that constraint, the rule table is narrow and reuses existing rule
sources rather than inventing new ones:

- **`select(deny)`** when the tool's group is one of `defaults/tool-group-
  policies.yaml`'s existing `never`-by-default groups (`Children`, `Team`,
  `PR Walkthrough`) — the codebase's own established "these tool categories
  are off-limits by default" source of truth, reused verbatim (kept in sync by
  a pinning test that parses that YAML file directly).
- **`select(allow)`** for a hand-curated read-only-safe allowlist: the
  builtin File System tools that are non-mutating by construction (`read`,
  `ls`, `grep`, `find`), matched on the tool name **and** the builtin
  "File System" group — a pack/MCP tool merely *named* `read` in another
  group abstains, so a future CQ-03 auto-apply consumer can trust recorded
  `allow` verdicts (harmless telemetry today, a widening hazard later without
  the group restriction). Deliberately excludes `bash`/`bash_bg` even though
  they're very often used read-only — this classifier has no visibility into
  the actual command, so treating the whole tool as safe would be wrong the
  moment it's used for anything else.
- Everything else: `abstain`. No ambiguity guessing, same discipline as
  Wave 1(b)'s thinking-router rule table.

**Registration is a SEPARATE gate from enforcement.** `server.ts` registers
this classifier (next to Wave 2's `allowDecisionPoint` call) only when
`BOBBIT_CLF_TOOL_APPROVE` is set to ANY value at all (`isToolApproveHeuristic
Enabled`) — unset stays byte-identical to Wave 2's harness-only state (zero
classifiers, every consult abstains), pinned end-to-end against a real booted
gateway (`tests/e2e/tool-approve-heuristic-registration.spec.ts`), not just at
the unit level. Whether a registered classifier's `deny` verdict actually
*auto-applies* is the separate, pre-existing `isToolApproveEnforceMode` gate
(`BOBBIT_CLF_TOOL_APPROVE=enforce` exactly) — so `BOBBIT_CLF_TOOL_APPROVE=
observe` registers the classifier for pure telemetry (decisions recorded and
visible in the transparency panel — see
`tests/e2e/ui/transparency-panel-tool-approve-heuristic.spec.ts`) with zero
behavior change, and `=enforce` additionally lets a `deny` short-circuit
`requestToolGrant`. An `allow` verdict never auto-applies in either mode this
wave — it still needs the CQ-03 operator-confirmation permit for widening
(see below).

**Deliberately still deferred** (unchanged from Wave 2's own list, mostly
still pending AJ's trust-tier decision):

- The CQ-03 operator-confirmation permit wiring for auto-`allow` widening.
- A model-backed cascade for tools the deterministic rules abstain on.
- Any argument/command-aware policy (see the PR Walkthrough pointer above) —
  this classifier will never grow one; that's a different, separate seam.
- The pre-spawn apply barrier and the per-turn decision budget mentioned in
  the design note's phased plan.

## Wave 3 — F14 thinking-router APPLY MODE

`thinking-router-classifier.ts`'s `isThinkingRouterApplyMode()`
(`BOBBIT_CLF_THINKING_ROUTER=enforce` exactly) turns on the first *apply* path
in this lane's history for a `user-prompt-submit` decision: `SessionManager
.enqueuePrompt` calls `session.rpcClient.setThinkingLevel(choice)` with the
classifier's exact `select`ed level — transiently, for that turn only, never
persisted as a new `spawnPinnedThinkingLevel` pin (the next prompt re-consults
from scratch). Mirrors Wave 2/2.5's three-state flag shape exactly: absent or
any value other than the literal string `"enforce"` (including `"observe"`)
stays Wave 1(b)'s byte-identical observe-only behavior.

**Clamped, never raw.** The level is run through `clampThinkingLevelForModel`
against the session's currently-bound model before the RPC call — the same
defense-in-depth `ws/handler.ts`'s `set_thinking_level` action and
`tryApplyDefaultThinkingLevel` already use, so a classifier `xhigh` select on a
non-reasoning model degrades instead of sending an unsupported literal to the
runtime.

**PINNED PRECEDENCE INVARIANT — the classifier always loses to a human/role
decision.** Apply mode is gated by `SessionManager
.canApplyThinkingRouterDecision`, which refuses to apply (recording the
`select` for telemetry only, never touching the live level) when EITHER is
true:
  - a role-level `thinkingLevel` override resolves for the session
    (`resolveRoleThinkingLevel`) — a role author already made an explicit,
    considered choice;
  - `session.thinkingLevelUserPinned` is set — true ONLY when the user
    explicitly changed the session's thinking level via the composer's
    `set_thinking_level` ws action (never by spawn-time role/preference
    resolution, which is a default, not a decision).

Neither case is "the spawn-time default resolved to something" (no explicit
override) — that case has no human decision to protect, so apply mode is free
to route per-prompt as usual. An `abstain` never calls `setThinkingLevel`
regardless of mode — there is nothing to apply.

**Full transparency of the apply outcome, not just the choice.** `Lifecycle
Hub.dispatchDecision` gained an optional `opts.applyIfSelected: boolean` —
the CALLER's pre-decided answer to "if this comes back `select`, will I
actually apply it?", computed from mode-flag + precedence checks BEFORE the
classifier runs (never from the resulting `choice`). When the result is
`select`, that boolean is recorded verbatim onto the outcome's new `applied?:
boolean` field (omitted for `abstain`, and omitted entirely for any
pre-Wave-3 call site that doesn't pass the option — byte-identical for every
other classifier in this lane). The transparency panel renders
`selected: <choice> (applied)` and an `applied: yes` detail row when true. See
`tests/session-manager-thinking-router.test.ts`'s CLF-W3 block and
`tests/thinking-router-classifier.test.ts`'s `isThinkingRouterApplyMode`
block for the full pin set.

**Deliberately not built this wave:** persistence of
`session.thinkingLevelUserPinned` across a restore/respawn (in-memory only —
a known, small gap, not a safety issue since the flag can only ever suppress
an auto-apply, never force one); a dedicated browser E2E for enforce-mode
rendering (the existing `tests/e2e/ui/transparency-panel.spec.ts` CLF-W1b
block already exercises a real registered-classifier decision row generically
and is unaffected by the additive `applied` field — a dedicated enforce-mode
spec is flagged as a good follow-up, not done here).

## Wave 4 — model-tier classifier (observe-only, no apply path at all)

`model-tier-classifier.ts`: the first classifier at a brand-new decision
point, `(session-spawn, model-tier)` (added to `DECISION_POINTS`), consulted
from `session-setup.ts`'s `resolveDynamicContext` (right after the
`sessionSetup` provider dispatch, so a `TraceEntry` already exists to attach
into — same durability property CLF-W1b's own consult relies on).

**What it proposes:** a symbolic tier label (`"cheap" | "mid" | "frontier"`),
never a literal `<provider>/<modelId>` string. The rule table is a verbatim
mirror of docs/internals.md's "Recommended model tiers (VER-02)" role→tier
table (Frontier: team-lead/architect/security-reviewer/spec-auditor/
bug-hunter; Mid: coder/reviewer/code-reviewer/test-engineer/qa-tester; Cheap:
docs-writer; everything else abstains — no ambiguity guessing), kept in sync
with that doc section by `tests/model-tier-classifier.test.ts`.

**Why this sidesteps AJ's earlier model-tiering deferral instead of reopening
it.** AJ reversed a prior attempt to ship a literal `model:` default per
built-in role (VER-02, PR #89 — CLOSED; TRACKER.md: "built-in role models
stay as they were... revisit inside the roles/models-overhaul + dynamic-
selection future lane") because `role.model` is a hard-fail contract — a
literal model id baked into a built-in role can hard-fail spawns on installs
without that exact model (see docs/internals.md's "Why this is guidance and
not a shipped default"). This classifier changes nothing: the recorded tier
is never read back to alter `bridgeOptions.initialModel` or any spawn
decision — zero behavior change, zero hard-fail risk, by construction (there
is no apply path to build, let alone gate behind a flag). What it produces
instead is the real would-have-chosen tier distribution across actual usage,
which is exactly the evidence AJ needs to make the eventual literal-tiering
call (or the symbolic, install-portable resolver the doc names as the
long-term shape) an informed decision instead of a guess.

**Registered unconditionally**, like the thinking router (Wave 1(b)) — unlike
Wave 2.5's tool-approve heuristic, there is no enable/enforce flag at all
this wave, since there is no apply behavior for a flag to gate. Pure
telemetry from the moment this PR merges.

**Deliberately not built this wave:** any apply path (that's the future
roles/models-overhaul + dynamic-selection lane's job, informed by this
wave's telemetry); a literal-model resolver of any kind; consulting anything
beyond role identity (no prompt content, no per-invocation reasoning — same
identity-only discipline as the tool-approve heuristic).

## Wave 5 — gate-risk classifier (observe-only, VER-05 evidence-gatherer)

`gate-risk-classifier.ts`: another brand-new decision point, `(gate-verify,
risk)` (added to `DECISION_POINTS`), consulted from
`VerificationHarness.verifyGateSignal` right after the run's `baseBranch` is
resolved — the exact same `origin/<baseBranch>...HEAD` ref shape
`computeReviewDiffArtifact` already uses for the review-prompt diff artifact,
reused rather than re-derived a second way.

**Why this wave exists.** The Fable program's dark-flags reconciliation
(`RECONCILIATION-2026-07-05.md`, VER-05 section) measured the seeded
`solo-fast` workflow (opt-in per goal — build/check/unit + one consolidated
review, no e2e, no doc gate) at a real -12.8% wall-clock / -75% review-token
win on the pass path, but concluded **KEEP-DARK**: "there is NO
risk-classification logic anywhere — selection is purely human/agent
choice," so auto-selecting solo-fast for a "low-risk" diff would route
arbitrary-risk changes past e2e and 2 of 3 reviewers with nothing backing the
"low-risk" call. This classifier is the safe first step toward ever making
that call: it runs on every real gate verification from the moment this PR
merges and accumulates the would-have-chosen `low`/`medium`/`high` label
distribution against real changesets — the exact evidence the reconciliation
doc says is missing — without touching workflow selection at all.

**What it proposes:** a symbolic risk label (`"low" | "medium" | "high"`),
computed ONLY from changeset shape: changed-file count, path classes
(`src/server` / `src/ui`+`src/app` / `tests` / `docs` / other), and a small
explicit high-risk-surface list (`session-manager.ts`, `verification-
harness.ts`, `server.ts`, `auth/*` — reused verbatim, not inferred). No diff
content, no commit messages, no file contents ever reach the classifier — the
same identity/shape-only discipline as `ModelTierArg`/`ToolApproveArg`. Rule
precedence: any high-risk-surface hit → `high`; else changeset size over
`LARGE_CHANGESET_FILE_THRESHOLD` (15 files) → `medium`; else `src/server/`
files changed with zero `tests/` files in the same changeset → `medium`;
else `low`. Unlike the model-tier/tool-approve rule tables, this one never
abstains once the changed-file list is known — a risk label is a total
function of shape, so `abstain` is reserved for "the signal itself is
unavailable" (the git call failed), not "the label is ambiguous."

**Registered unconditionally**, like the model-tier classifier (Wave 4) —
there is no enable/enforce flag at all this wave, since there is no apply
behavior for a flag to gate. Pure telemetry from the moment this PR merges.

**What telemetry this accumulates and what decision it feeds.** Every gate
verification run records one `DecisionOutcome` (point `gate-verify`, kind
`risk`) into the raising session's transparency-panel trace (when one is
active) or the in-process fallback ring otherwise — a real would-have-chosen
label plus its rationale string, timestamped, per real changeset. That
distribution is the input to the still-open VER-05 question: whether/how to
ever auto-select `solo-fast` for a goal instead of leaving it a human/agent
choice. This wave builds no consumer for that question — it only makes the
label exist and accumulate, mirroring Wave 4's model-tier classifier's own
"produce the evidence, defer the decision" split.

**Deliberately not built this wave:** any apply path (auto-selecting a
workflow, skipping a gate, or altering `verify[]` based on the label); an
affected-files list for `npm run test:unit -- <paths>` (CLF-W5 computes path
CLASSES for its own label, not a file list — see `seed-default-workflows
.ts`'s comment seam); any diff-CONTENT-aware signal (line counts, added vs.
removed, semantic diffing) — this classifier will only ever reason about
changed-file identity/shape, same as every other rule table in this lane;
tuning `LARGE_CHANGESET_FILE_THRESHOLD` or the high-risk-surface list against
real data (that's exactly what this wave's own telemetry is for).
