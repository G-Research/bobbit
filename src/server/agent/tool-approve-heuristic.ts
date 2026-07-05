// src/server/agent/tool-approve-heuristic.ts
//
// CLF-W2.5 — the first REAL classifier registered at the (tool-call,
// tool-approve) decision seam CLF-W2 shipped as a harness-only pair (see
// tool-approve-classifier.ts's header for that wave's full scope). Mirrors
// the F14 thinking router's own split (CLF-W1a ships the seam dark, CLF-W1b
// wires the first real customer): this file is that same "first real
// customer" step for tool-approve. See the CLF classifier-framework design
// note (Fable program) §6/§8.3/§10 for the full design.
//
// CONSERVATIVE BY CONSTRUCTION — `ToolApproveArg` carries only `toolName`,
// `toolGroup`, and an optional `roleName` (no command/argument content), so
// this classifier can only ever reason about a tool's IDENTITY, never about
// what a specific invocation would actually do (e.g. it cannot tell a
// read-only `rg` from a destructive one inside a `bash` call — that is a
// DIFFERENT, argument-level policy problem; see
// `src/server/pr-walkthrough/walkthrough-readonly-policy.ts` for the PR
// Walkthrough pack's own narrower, argument-aware read-only allowlist for
// exactly that reason). Given that constraint, the rule table below is
// deliberately narrow:
//
//   - DENY: the tool's group is one of the codebase's own existing
//     "never by default" tool-guard groups (`defaults/tool-group-policies.yaml`
//     — Children/Team/PR Walkthrough). That file is the actual, existing,
//     single source of truth for "categories of tools this codebase already
//     considers off-limits by default" — reused here, not re-invented. In
//     ordinary operation a role that resolves one of these tools to `ask`
//     never even reaches this classifier (the tool-guard extension hard-
//     blocks `never`-policy tools before ever calling `requestToolGrant`,
//     see `tool-guard-extension.ts`), so this rule is defense-in-depth for
//     the case where a group-policy override or a per-tool role exception
//     re-opens one of these tools to `ask`.
//   - ALLOW (record-only this wave — see `isAutoDenyDecision`'s doc comment
//     in `tool-approve-classifier.ts`: an auto-`allow` needs the CQ-03
//     operator-confirmation permit for widening, which is NOT built yet):
//     a hand-curated list of the builtin File System tools that are
//     read-only by construction — `read`, `ls`, `grep`, `find`. The rule
//     matches on BOTH the tool name AND the builtin "File System" group — a
//     pack/MCP-provided tool merely NAMED `read` in some other group must
//     NOT collect an `allow` verdict: harmless telemetry today, but a real
//     widening hazard the day the CQ-03 permit machinery exists and starts
//     consuming recorded `allow`s. CQ-03 PRECONDITION: any future
//     auto-apply wiring may treat this rule's verdicts as trustworthy ONLY
//     because of this group restriction — never loosen it to name-only.
//     Deliberately excludes `bash`/`bash_bg` even though they are very
//     often used for read-only commands (`cat`, `ls`, `rg`) — this
//     classifier has no visibility into the actual command being run, so
//     treating the WHOLE tool as safe would be wrong the moment it is used
//     for anything else.
//   - Everything else: `abstain`. No ambiguity guessing (same discipline as
//     `thinking-router-classifier.ts`'s rule table) — a tool this classifier
//     doesn't recognize defers entirely to the existing human-ask flow.
import type { Decision, DecisionClassifier, DecisionDispatchCtx } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, isToolApproveArg, type ToolApproveArg, type ToolApproveVerdict } from "./tool-approve-classifier.js";

export const TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID = "builtin.tool-approve-heuristic";

/** Mirrors `defaults/tool-group-policies.yaml`'s builtin `never`-by-default
 *  groups (Children, Team, PR Walkthrough) — the codebase's own existing
 *  tool-guard rule source for "tool categories considered dangerous/off-
 *  limits by default". Kept in sync with that file by
 *  `tests/tool-approve-heuristic.test.ts`, which parses it directly and pins
 *  that every builtin `never` group is present here — if that file ever adds
 *  a new `never` group, the test fails until this set is updated too.
 *  Case-insensitive comparison (see `classifyToolApprove`) so a differently-
 *  cased `toolGroup` string still matches. */
export const DANGEROUS_TOOL_GROUPS: readonly string[] = ["Children", "Team", "PR Walkthrough"];

/** Hand-curated read-only-safe builtin tool names (File System group's
 *  non-mutating members). Matched case-insensitively against `toolName`,
 *  AND the arg's `toolGroup` must be {@link READ_ONLY_SAFE_TOOL_GROUP} — a
 *  same-named tool from any other group abstains (see the header comment's
 *  CQ-03 precondition). Deliberately excludes `edit`/`write` (mutate files)
 *  and `bash`/`bash_bg` (arbitrary command execution — see this file's
 *  header comment). */
export const READ_ONLY_SAFE_TOOL_NAMES: readonly string[] = ["read", "ls", "grep", "find"];

/** The builtin group the read-only-safe rule is scoped to — matches the
 *  `group: File System` field in `defaults/tools/filesystem/*.yaml`.
 *  Compared case-insensitively (same trim/lower idiom as the deny rule). */
export const READ_ONLY_SAFE_TOOL_GROUP = "File System";

interface ToolApproveRule {
	id: string;
	verdict: ToolApproveVerdict;
	match(arg: ToolApproveArg): boolean;
	rationale(arg: ToolApproveArg): string;
}

const DANGEROUS_TOOL_GROUPS_LOWER = new Set(DANGEROUS_TOOL_GROUPS.map((g) => g.toLowerCase()));
const READ_ONLY_SAFE_TOOL_NAMES_LOWER = new Set(READ_ONLY_SAFE_TOOL_NAMES.map((t) => t.toLowerCase()));
const READ_ONLY_SAFE_TOOL_GROUP_LOWER = READ_ONLY_SAFE_TOOL_GROUP.toLowerCase();

const RULES: readonly ToolApproveRule[] = [
	{
		id: "dangerous-group",
		verdict: "deny",
		match: (arg) => DANGEROUS_TOOL_GROUPS_LOWER.has(arg.toolGroup.trim().toLowerCase()),
		rationale: (arg) =>
			`matched deterministic rule 'dangerous-group': tool "${arg.toolName}" is in the "${arg.toolGroup}" group, which defaults/tool-group-policies.yaml marks off-limits (never) by default`,
	},
	{
		id: "read-only-safe",
		verdict: "allow",
		// Name AND builtin File System group — a same-named tool from any
		// other group (e.g. a pack/MCP tool named "read") must abstain; see
		// the header comment's CQ-03 precondition.
		match: (arg) =>
			READ_ONLY_SAFE_TOOL_NAMES_LOWER.has(arg.toolName.trim().toLowerCase())
			&& arg.toolGroup.trim().toLowerCase() === READ_ONLY_SAFE_TOOL_GROUP_LOWER,
		rationale: (arg) =>
			`matched deterministic rule 'read-only-safe': tool "${arg.toolName}" (builtin "${READ_ONLY_SAFE_TOOL_GROUP}" group) is on the hand-curated read-only-safe allowlist — record-only this wave, no CQ-03 permit to auto-apply`,
	},
];

/**
 * Pure rule-table function — zero tokens, zero I/O, fully synchronous. See
 * this file's header for why the rule table is intentionally this narrow.
 * Exported directly so the rule table itself is unit-testable without
 * standing up a `LifecycleHub`/`DecisionClassifier` wrapper (same pattern as
 * `classifyThinkingLevel` in `thinking-router-classifier.ts`).
 */
export function classifyToolApprove(arg: ToolApproveArg): Decision<ToolApproveVerdict> {
	for (const rule of RULES) {
		if (rule.match(arg)) {
			return { kind: "select", choice: rule.verdict, confidence: 1, rationale: rule.rationale(arg) };
		}
	}
	return { kind: "abstain" };
}

/**
 * The built-in conservative classifier — CLF-W2.5's real customer at
 * `(tool-call, tool-approve)`. A malformed/missing `arg` (defensive —
 * `dispatchDecision`'s `arg` is untyped `unknown`) abstains rather than
 * throwing, matching `isDecision`'s "malformed → treated as abstain"
 * discipline elsewhere in the seam.
 */
export const toolApproveHeuristicClassifier: DecisionClassifier<ToolApproveVerdict> = {
	id: TOOL_APPROVE_HEURISTIC_CLASSIFIER_ID,
	evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<ToolApproveVerdict> {
		if (!isToolApproveArg(arg)) return { kind: "abstain" };
		return classifyToolApprove(arg);
	},
};

/** Whether the heuristic classifier should be REGISTERED at all — distinct
 *  from `isToolApproveEnforceMode()` (which gates whether a produced `deny`
 *  auto-applies). Any non-empty value (including `"observe"`) registers the
 *  classifier in observe-only telemetry mode; unset (or empty string) means
 *  it is never registered, so `server.ts`'s own `allowDecisionPoint` call
 *  stays the only registration for the pair — `dispatchDecision` keeps
 *  abstaining for every consult, byte-identical to CLF-W2, exactly as if
 *  this file didn't exist. Read LIVE (not cached), same idiom as
 *  `isToolApproveEnforceMode`. */
export function isToolApproveHeuristicEnabled(): boolean {
	return !!process.env.BOBBIT_CLF_TOOL_APPROVE;
}

/**
 * Registers the built-in heuristic classifier at `(tool-call, tool-approve)`.
 * Called from `server.ts`, right after the pair's `allowDecisionPoint` call,
 * ONLY when `isToolApproveHeuristicEnabled()` is true — see that call site
 * for why the flag gates registration itself, not just enforcement. Returns
 * the unregister function (mirrors `registerThinkingRouterClassifier`) for
 * symmetry/tests; production code never calls it.
 */
export function registerToolApproveHeuristicClassifier(hub: LifecycleHub): () => void {
	return hub.registerDecisionClassifier<ToolApproveVerdict>(TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, toolApproveHeuristicClassifier);
}
