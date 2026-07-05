// src/server/agent/swarm-topology-classifier.ts
//
// SWARM-W4.3 — swarm-topology classifier, OBSERVE-ONLY. First real classifier
// at `(goal-create, swarm-topology)`, following SWARM-W4.2's harness-only
// seam. Mirrors model-tier-classifier.ts exactly: a pure deterministic rule
// function, a DecisionClassifier wrapper, unconditional registration at
// gateway construction, and NO enforce/apply mode at all this wave.
//
// SCOPE OF THIS WAVE — deliberately narrow by orchestrator decision:
//   - The rule table keys ONLY on the two already-typed deterministic signals
//     `hasVerifyCommand` and `requestedFanOut`. It does not inspect `spec`;
//     no text heuristics, no prompt-content parsing, no new arg fields.
//   - Rule table v1:
//       requestedFanOut >= 2 && hasVerifyCommand -> select best-of-N
//       requestedFanOut >= 2 && !hasVerifyCommand -> abstain
//       everything else -> abstain
//   - The best-of-N creation route consults this pair for real on every swarm
//     creation, but it NEVER reads the decision back. The topology created
//     remains 100% caller-supplied, exactly SWARM-W1's existing behavior,
//     regardless of whether this classifier selects or abstains.
//   - There is NO apply/enforce mode at all this wave. Design doc §3.3 stages
//     that as a later, AJ-gated step; §3.4's stricter swarm-specific enforce
//     bound is intentionally not built here.
//
// HARD INVARIANT (design doc §3.4, restated): a swarm-topology decision must
// NEVER influence `forceIntegrateSwarmWinner` or the operator-confirmation
// token flow (`operator-confirmation.ts`) — those stay wired exclusively to
// the human-gated `/confirm` route, completely independent of this seam.
import type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionPoint } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";

/** The (point, kind) pair this seam is consulted at. Exported so the
 *  registration wrapper and the consult call site (`swarm-routes.ts`) can
 *  never drift apart into a silent mismatch — a typo in either place fails
 *  `npm run check`, not a test (same discipline as `TOOL_APPROVE_POINT`/
 *  `_KIND` in `tool-approve-classifier.ts`). */
export const SWARM_TOPOLOGY_POINT: DecisionPoint = "goal-create";
export const SWARM_TOPOLOGY_KIND = "swarm-topology";
export const SWARM_TOPOLOGY_CLASSIFIER_ID = "builtin.swarm-topology";

/**
 * The classifier's verdict shape (design doc §3.2). `Decision<TChoice>`
 * itself stays select/abstain only (see decision-types.ts's header comment —
 * do not extend the union without documenting why) — this is just the
 * `TChoice` for this one (point, kind) pair.
 *
 * Deliberately NOT a `propose{proposalType, spec}` — see the design doc's
 * §3.2 rationale for why a plain select/abstain over a fixed topology label
 * is sufficient and does not need to wait for CLF's still-unbuilt `propose`
 * kind.
 */
export type SwarmTopologyChoice =
	| { topology: "solo" }
	| { topology: "best-of-n"; fanOut: number; earlyKill: boolean }
	| { topology: "plan-fan-in"; fanOut: number }
	| { topology: "orchestrator-worker"; maxShards: number }
	| { topology: "speculative-small-first"; cheapModel: string };

/** Argument shape passed to a swarm-topology classifier's `evaluate()` — the
 *  deterministic, 0-token signals design doc §2/§3.2 name as the entire
 *  input surface (goal-creation-time signals only, never prompt content
 *  beyond the spec text itself — same visibility class as `tool-call`'s
 *  arg, never widened). */
export interface SwarmTopologyArg {
	goalId: string;
	/** The prompt/spec text the goal was created with. */
	spec: string;
	/** Whether the caller already supplied a deterministic verify command —
	 *  a strong topology signal (§1's whole cost model assumes one exists). */
	hasVerifyCommand: boolean;
	/** Caller-requested fan-out, if any — present when a human/orchestrator
	 *  already picked one explicitly. */
	requestedFanOut?: number;
}

export function isSwarmTopologyArg(value: unknown): value is SwarmTopologyArg {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<SwarmTopologyArg>;
	if (typeof v.goalId !== "string" || typeof v.spec !== "string" || typeof v.hasVerifyCommand !== "boolean") return false;
	return v.requestedFanOut === undefined || typeof v.requestedFanOut === "number";
}

/**
 * Pure rule-table function — zero tokens, zero I/O, fully synchronous.
 * Deliberately keys only on `hasVerifyCommand` and `requestedFanOut`; `spec`
 * remains part of the seam arg for future telemetry context, but v1 must not
 * inspect it.
 */
export function classifySwarmTopology(arg: SwarmTopologyArg): Decision<SwarmTopologyChoice> {
	if (arg.requestedFanOut !== undefined && arg.requestedFanOut >= 2 && arg.hasVerifyCommand) {
		return {
			kind: "select",
			choice: { topology: "best-of-n", fanOut: arg.requestedFanOut, earlyKill: false },
			confidence: 1,
			rationale: "matched deterministic rule 'best-of-n-with-verifier': caller already wants fan-out and a deterministic verifier exists",
		};
	}
	return { kind: "abstain" };
}

/**
 * The built-in conservative classifier — SWARM-W4.3's observe-only customer
 * at `(goal-create, swarm-topology)`. A malformed/missing `arg` abstains
 * rather than throwing, matching every other classifier in this lane.
 */
export const swarmTopologyClassifier: DecisionClassifier<SwarmTopologyChoice> = {
	id: SWARM_TOPOLOGY_CLASSIFIER_ID,
	evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<SwarmTopologyChoice> {
		if (!isSwarmTopologyArg(arg)) return { kind: "abstain" };
		return classifySwarmTopology(arg);
	},
};

/**
 * Registers the built-in swarm-topology classifier at `(goal-create,
 * swarm-topology)`. Called ONCE at gateway construction (`server.ts`), same
 * pattern as `registerModelTierClassifier` — registered unconditionally (no
 * enable flag) since this classifier has no apply mode to gate; recording
 * telemetry is the entire point of this wave. Returns the unregister function
 * for symmetry/tests; production code never calls it.
 */
export function registerSwarmTopologyClassifier(hub: LifecycleHub): () => void {
	return hub.registerDecisionClassifier<SwarmTopologyChoice>(SWARM_TOPOLOGY_POINT, SWARM_TOPOLOGY_KIND, swarmTopologyClassifier);
}

/** Type-only re-export so call sites can annotate a raw `dispatchDecision`
 *  result without importing `decision-types.ts` directly for just this. */
export type SwarmTopologyDecision = Decision<SwarmTopologyChoice>;
