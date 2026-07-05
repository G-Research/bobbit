// src/server/agent/model-tier-classifier.ts
//
// CLF-W4 — model-tier classifier, OBSERVE-ONLY. First real customer at a
// brand-new decision point, `(session-spawn, model-tier)` — added to
// `DECISION_POINTS` (decision-types.ts) alongside the pre-existing points,
// mirroring the F14 thinking router (CLF-W1b) and tool-approve heuristic
// (CLF-W2.5)'s own "seam ships, first real classifier follows" split, except
// this classifier ships with NO enforce/apply mode at all this wave — see
// below for why.
//
// WHAT IT PROPOSES: a symbolic TIER LABEL (`"cheap" | "mid" | "frontier"`),
// NEVER a literal `<provider>/<modelId>` string. The rule table is a byte-for-
// byte mirror of docs/internals.md's "Recommended model tiers (VER-02)"
// table — the exact, already-AJ-reviewed recommendation from finding VER-02 —
// turned into a deterministic classifier so real would-have-chosen data
// accumulates instead of staying a static doc. Kept in sync with that table
// by `tests/model-tier-classifier.test.ts`.
//
// WHY OBSERVE-ONLY WITH NO ENFORCE FLAG (unlike CLF-W3/W2.5's three-state
// mode flags): AJ explicitly deferred literal per-role model-tiering
// (TRACKER.md D2.1 → PR #89, CLOSED per AJ reversal — "built-in role models
// stay as they were... revisit inside the roles/models-overhaul + dynamic-
// selection future lane") because `role.model` is a hard-fail contract (see
// docs/internals.md's "Why this is guidance and not a shipped default") — a
// literal model id baked into a built-in role can hard-fail spawns on
// installs without that exact model. Recording only a TIER LABEL, and never
// reading it back to change `bridgeOptions.initialModel`, sidesteps that
// deferral entirely: zero behavior change, zero hard-fail risk, while still
// producing the exact "would-have-chosen" telemetry AJ would need to make
// the eventual literal-tiering call an informed one instead of a guess. When
// that future lane lands a symbolic, install-portable tier resolver (the doc
// names `selectAigwModelForRoleTier`'s pattern as the template), THIS
// classifier's recorded history is the evidence base — apply mode is that
// lane's job, not this wave's.
//
// CONSERVATIVE BY CONSTRUCTION — role name is the ONLY signal (mirrors
// tool-approve-heuristic.ts's identity-only discipline): no prompt content,
// no per-invocation reasoning. A role not on the VER-02 table (assistant,
// general, ux-designer, any custom/pack role) abstains — no ambiguity
// guessing, same discipline as every other rule table in this lane.
import type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionPoint } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";

/** The (point, kind) pair this classifier is registered at. */
export const MODEL_TIER_POINT: DecisionPoint = "session-spawn";
export const MODEL_TIER_KIND = "model-tier";
export const MODEL_TIER_CLASSIFIER_ID = "builtin.model-tier";

/** Mirrors docs/internals.md's VER-02 "Recommended model tiers" table
 *  verbatim — DO NOT edit one without the other; `tests/model-tier-classifier
 *  .test.ts` pins that they stay in sync. */
export type ModelTier = "cheap" | "mid" | "frontier";

/** Argument shape passed to the model-tier classifier's `evaluate()` —
 *  identity only, same minimalism as `ToolApproveArg`. */
export interface ModelTierArg {
	roleName?: string;
}

export const FRONTIER_TIER_ROLES: readonly string[] = ["team-lead", "architect", "security-reviewer", "spec-auditor", "bug-hunter"];
export const MID_TIER_ROLES: readonly string[] = ["coder", "reviewer", "code-reviewer", "test-engineer", "qa-tester"];
export const CHEAP_TIER_ROLES: readonly string[] = ["docs-writer"];

const FRONTIER_TIER_ROLES_LOWER = new Set(FRONTIER_TIER_ROLES.map((r) => r.toLowerCase()));
const MID_TIER_ROLES_LOWER = new Set(MID_TIER_ROLES.map((r) => r.toLowerCase()));
const CHEAP_TIER_ROLES_LOWER = new Set(CHEAP_TIER_ROLES.map((r) => r.toLowerCase()));

/**
 * Pure rule-table function — zero tokens, zero I/O, fully synchronous. See
 * this file's header for why the rule table is a verbatim mirror of the
 * VER-02 doc table and why it will never grow beyond role-name matching.
 */
export function classifyModelTier(arg: ModelTierArg): Decision<ModelTier> {
	const role = arg.roleName?.trim().toLowerCase();
	if (!role) return { kind: "abstain" };
	if (CHEAP_TIER_ROLES_LOWER.has(role)) {
		return { kind: "select", choice: "cheap", confidence: 1, rationale: `matched deterministic rule 'cheap-tier-role': role "${arg.roleName}" is in docs/internals.md's VER-02 Cheap tier` };
	}
	if (MID_TIER_ROLES_LOWER.has(role)) {
		return { kind: "select", choice: "mid", confidence: 1, rationale: `matched deterministic rule 'mid-tier-role': role "${arg.roleName}" is in docs/internals.md's VER-02 Mid tier` };
	}
	if (FRONTIER_TIER_ROLES_LOWER.has(role)) {
		return { kind: "select", choice: "frontier", confidence: 1, rationale: `matched deterministic rule 'frontier-tier-role': role "${arg.roleName}" is in docs/internals.md's VER-02 Frontier tier` };
	}
	return { kind: "abstain" };
}

function isModelTierArg(value: unknown): value is ModelTierArg {
	if (!value || typeof value !== "object") return false;
	const roleName = (value as ModelTierArg).roleName;
	return roleName === undefined || typeof roleName === "string";
}

/**
 * The built-in conservative classifier — CLF-W4's real customer at
 * `(session-spawn, model-tier)`. A malformed/missing `arg` abstains rather
 * than throwing, matching every other classifier in this lane's discipline.
 */
export const modelTierClassifier: DecisionClassifier<ModelTier> = {
	id: MODEL_TIER_CLASSIFIER_ID,
	evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<ModelTier> {
		if (!isModelTierArg(arg)) return { kind: "abstain" };
		return classifyModelTier(arg);
	},
};

/**
 * Registers the built-in model-tier classifier at `(session-spawn,
 * model-tier)`. Called ONCE at gateway construction (`server.ts`), same
 * pattern as `registerThinkingRouterClassifier` — registered unconditionally
 * (no enable flag) since this classifier has no apply mode to gate; recording
 * telemetry is the entire point of this wave. Returns the unregister function
 * for symmetry/tests; production code never calls it.
 */
export function registerModelTierClassifier(hub: LifecycleHub): () => void {
	return hub.registerDecisionClassifier<ModelTier>(MODEL_TIER_POINT, MODEL_TIER_KIND, modelTierClassifier);
}
