// src/server/agent/swarm-topology-classifier.ts
//
// SWARM-W4.2 — swarm-topology decision seam HARNESS at `(goal-create,
// swarm-topology)`. See docs/design/swarm-orchestration-w4.md §3.2/§3.3 for
// the full design; this file implements ONLY step 1 of §3.3's observe-mode-
// first path — "harness-only (mirrors CLF-W2's first slice)".
//
// SCOPE OF THIS WAVE — deliberately narrow, exactly CLF-W2's own split
// (ship the dispatch harness first, ship a real classifier customer later —
// see tool-approve-classifier.ts's header for the precedent this mirrors):
//   - This file defines the (point, kind) pair and the arg/choice shapes
//     ONLY. `server.ts` calls `allowDecisionPoint` for this pair (NOT
//     `registerDecisionClassifier`), so `LifecycleHub.dispatchDecision`
//     always abstains in production today — zero classifiers registered ⇒
//     byte-identical, the same discipline as CLF-W0b's own "allow-listed but
//     zero classifiers registered" pin (tests/lifecycle-hub-dispatch-decision
//     .test.ts).
//   - Unlike CLF-W0b's fully-dark seam, the best-of-N creation route
//     (`swarm-routes.ts`'s `POST /api/goals/:id/swarm/best-of-n` handler)
//     DOES consult this pair for real on every swarm creation — a genuine
//     production call site. With nothing registered, every consult abstains,
//     so behaviour is unconditionally unchanged: the topology created below
//     is ALWAYS the caller-supplied best-of-N shape, exactly SWARM-W1's
//     existing behavior, regardless of this decision's outcome.
//   - There is NO apply/enforce mode at all this wave (unlike CLF-W2, which
//     shipped its enforce-mode plumbing for auto-deny even before a real
//     classifier existed) — design doc §3.3 stages that as step 3
//     ("enforce, later, AJ-gated... only once observed data clears the
//     bar"), and §3.4 lays out a swarm-specific, STRICTER enforce bound
//     (auto-select only bounded-at-or-below-solo-cost topologies) that this
//     wave deliberately does not build any part of. A real observe-mode rule-
//     table classifier (mirroring model-tier-classifier.ts's identity-only
//     discipline) is a deliberately separate follow-up (SWARM-W4.3).
//
// HARD INVARIANT (design doc §3.4, restated): a swarm-topology decision must
// NEVER influence `forceIntegrateSwarmWinner` or the operator-confirmation
// token flow (`operator-confirmation.ts`) — those stay wired exclusively to
// the human-gated `/confirm` route, completely independent of this seam.
import type { Decision, DecisionPoint } from "./decision-types.js";

/** The (point, kind) pair this seam is consulted at. Exported so the
 *  allow-list call site (`server.ts`, at gateway construction) and the
 *  consult call site (`swarm-routes.ts`) can never drift apart into a silent
 *  mismatch — a typo in either place fails `npm run check`, not a test (same
 *  discipline as `TOOL_APPROVE_POINT`/`_KIND` in `tool-approve-classifier.ts`). */
export const SWARM_TOPOLOGY_POINT: DecisionPoint = "goal-create";
export const SWARM_TOPOLOGY_KIND = "swarm-topology";

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

/** Type-only re-export so call sites can annotate a raw `dispatchDecision`
 *  result without importing `decision-types.ts` directly for just this. */
export type SwarmTopologyDecision = Decision<SwarmTopologyChoice>;
