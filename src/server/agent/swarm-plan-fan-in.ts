/**
 * SWARM-W4.5 — plan-fan-in: N cheap, build-free planning passes → one
 * synthesized plan → a single, human-gated build (design/swarm-orchestration-w4.md
 * §1.1). This module is deliberately a thin WRAPPER over `createBestOfNSwarm`
 * — the doc's own principle (§1.1 mechanism step 1): "Fan out N siblings via
 * the SAME `createBestOfNSwarm`-shaped call... but each sibling's prompt is
 * planning-only". No new fan-out/barrier/governor machinery exists here; the
 * only genuinely new pieces are (a) the planning-only prompt prefix, (b) the
 * `topology: "plan-fan-in"` tag that routes the barrier-fire event to
 * `VerificationHarness._maybeTriggerPlanSynthesis` instead of leaving the
 * group waiting for a human `/verify` call, and (c) the `siblingPromptProfile`
 * wiring (orchestrator ruling: plan-phase siblings are planning-only,
 * provably no-build, so the "reviewer" F2/F22 prompt-slimming profile is
 * always safe to apply — build siblings, and the synthesis role itself,
 * never get a promptProfile from this wave).
 *
 * What happens after fan-out is NOT in this module:
 *  - Barrier-fire → synthesis spawn: `VerificationHarness._maybeTriggerPlanSynthesis`
 *    (verification-harness.ts), triggered from the SAME `notifyChildTerminal`
 *    path every swarm topology already goes through.
 *  - Pre-build human gate (`swarm-plan-fan-in-build-start` mint/consume) and
 *    the single ordinary build child: `swarm-routes.ts`'s
 *    `/plan-verify`/`/plan-confirm`/`/plan-reject` routes.
 *
 * `verifyCommand` is a REQUIRED field on `BestOfNSwarmOptions` but has no
 * semantic meaning for a plan-fan-in group — plan-phase siblings produce plan
 * TEXT, not a buildable/verifiable artifact (design §5: "no meaningful verify
 * verdict"). `PLAN_FAN_IN_VERIFY_PLACEHOLDER` ("true", a portable no-op) is
 * stored on the group's config purely to satisfy that shared field; the
 * generic `/verify` and `/confirm` best-of-n routes are explicitly refused
 * for a `topology: "plan-fan-in"` group in `swarm-routes.ts` (a plan sibling
 * must never be `mergeChild`-integrated as if it were a winning build).
 */
import type { GoalManager } from "./goal-manager.js";
import type { ProjectContext } from "./project-context.js";
import type { VerificationHarness } from "./verification-harness.js";
import { createBestOfNSwarm, type BestOfNSwarmResult } from "./swarm-best-of-n.js";

/** See this module's doc header — never read by any reconciler, only stored for the shared `BestOfNSwarmOptions.verifyCommand` field's sake. */
export const PLAN_FAN_IN_VERIFY_PLACEHOLDER = "true";

/** Prepended verbatim to the caller's spec for every plan-phase sibling — design §1.1 mechanism step 1's exact phrase. */
export const PLAN_ONLY_PROMPT_PREFIX =
	"## Planning-only mode\n\n" +
	"You are ONE of several independent candidates proposing an approach for the task below, as part of a swarm plan-fan-in group. " +
	"Propose an approach; do NOT modify files, do not run builds/tests, and do not open a PR. " +
	"Investigate as needed (read code, search, ask clarifying questions of yourself), then write up your proposed approach clearly: what you'd change, why, the key risks/trade-offs, and the order of steps. " +
	"A separate synthesis step will read your proposal alongside the other candidates' and merge the best ideas into one final plan before any code is written. " +
	"End by going idle once your written plan is complete — do not wait for further instructions.\n\n" +
	"---\n\n";

export interface PlanFanInSwarmOptions {
	parentGoalId: string;
	/** Base title; each plan-phase sibling gets " (candidate N)" appended (createBestOfNSwarm's existing convention). */
	title: string;
	/** The underlying task description — wrapped with `PLAN_ONLY_PROMPT_PREFIX` before being handed to `createBestOfNSwarm`, so every sibling still receives the SAME prompt (design §1.1: this is what makes it a swarm fan-out, not N unrelated goals). */
	spec: string;
	/** N — how many independent planning passes to fan out. Must be >= 2 (createBestOfNSwarm's own floor). */
	fanOut: number;
	/** Per-plan-sibling token ceiling — design §1.1 calls for "a small fraction of a normal build's". Default 20_000 (~0.1x a typical 200_000 best-of-n build budget, matching the doc's `Cp ≈ 0.1×C` estimate) when omitted. */
	tokenBudgetPerNode?: number;
	/** Per-plan-sibling wall-clock ceiling — plan-only turns should be short. Default 10 minutes when omitted. */
	wallClockMsPerNode?: number;
	hardKillMarginMultiplier?: number;
}

export interface PlanFanInSwarmResult extends BestOfNSwarmResult {}

export interface PlanFanInSwarmDeps {
	getContextForGoal(goalId: string): ProjectContext | undefined;
	getGoalManagerForGoal(goalId: string): GoalManager;
	harness: VerificationHarness;
}

const DEFAULT_PLAN_TOKEN_BUDGET = 20_000;
const DEFAULT_PLAN_WALL_CLOCK_MS = 10 * 60_000;

/**
 * Fan a task out to N planning-only sibling child goals under `parentGoalId`
 * — same barrier/governor/restart-durability machinery as best-of-n
 * (`createBestOfNSwarm`), tagged `topology: "plan-fan-in"` so the barrier
 * firing routes to the synthesis step instead of waiting on a human
 * `/verify` call. See this module's doc header for what happens next.
 */
export async function createPlanFanInSwarm(deps: PlanFanInSwarmDeps, opts: PlanFanInSwarmOptions): Promise<PlanFanInSwarmResult> {
	const { parentGoalId, title, spec, fanOut, tokenBudgetPerNode, wallClockMsPerNode, hardKillMarginMultiplier } = opts;
	if (!Number.isFinite(fanOut) || fanOut < 2) {
		throw new Error("createPlanFanInSwarm requires fanOut >= 2 (N>=2) — one candidate plan is just a solo goal, not a fan-out");
	}
	const planSpec = `${PLAN_ONLY_PROMPT_PREFIX}${spec}`;

	return createBestOfNSwarm(deps, {
		parentGoalId,
		title,
		spec: planSpec,
		siblings: Array.from({ length: fanOut }, () => ({})),
		tokenBudgetPerNode: tokenBudgetPerNode && tokenBudgetPerNode > 0 ? tokenBudgetPerNode : DEFAULT_PLAN_TOKEN_BUDGET,
		wallClockMsPerNode: wallClockMsPerNode && wallClockMsPerNode > 0 ? wallClockMsPerNode : DEFAULT_PLAN_WALL_CLOCK_MS,
		hardKillMarginMultiplier,
		verifyCommand: PLAN_FAN_IN_VERIFY_PLACEHOLDER,
		earlyKill: false,
		topology: "plan-fan-in",
		// Orchestrator ruling (SWARM-W4.5): plan-phase siblings are
		// planning-only, provably no-build — always safe to apply the
		// "reviewer" F2/F22 prompt-slimming profile. Build siblings (there are
		// none in THIS module — the eventual build child is spawned separately
		// by swarm-routes.ts's `/plan-confirm`) stay unprofiled.
		siblingPromptProfile: "reviewer",
	});
}
