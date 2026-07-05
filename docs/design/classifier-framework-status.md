# CLF — Classifier Framework lane: in-repo status ledger

Status: Wave 2.5 shipped (real tool-approve heuristic, observe-mode-only value
delivery). The full design (interception points, the select/abstain `Decision`
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
