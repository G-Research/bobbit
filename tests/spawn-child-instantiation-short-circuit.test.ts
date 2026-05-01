/**
 * Pinned regression: when a team-lead calls
 * `goal_spawn_child(planId=X)` and X already exists as a subgoal step
 * in the parent's frozen plan, the operation is INSTANTIATION (turning
 * a planned step into a real child), NOT a plan mutation.
 *
 * Pre-fix behaviour (Bug F from team-lead-317cdb83 PR #409 integration
 * test): the spawn-child route always built a synthetic step with
 * phase=0 and ran the classifier. When the same planId already existed
 * in the plan with phase=N, the diff's `indexByPlanId` map collapsed the
 * duplicate, and the classifier saw `survivor.phase` change from N to 0
 * → `changedDeps` true → `restructure`. Under any policy, every
 * instantiation got rejected with 409.
 *
 * Fix: in `server.ts`'s spawn-child route, if `body.planId` matches an
 * existing subgoal step's planId in the parent's `execution.verify[]`,
 * skip the classifier entirely and proceed to createGoal. The plan
 * isn't changing; only an unspawned planStep is being realised.
 *
 * The unit test below exercises the predicate directly. The end-to-end
 * test is in `tests/e2e/goals-spawn-child-api.spec.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface VerifyStepShape {
	type?: string;
	subgoal?: { planId?: string };
}

/**
 * Mirror of the production predicate in `server.ts` spawn-child route:
 *   `isInstantiation = planId provided && planId matches an existing
 *    subgoal step in `before`.
 *
 * Extracted as a pure function so the test can pin the exact rule that
 * fires (or doesn't) without booting the full HTTP stack. The production
 * code is the inline equivalent — if you change either, change both.
 */
function isInstantiation(planId: string | undefined, before: VerifyStepShape[]): boolean {
	if (!planId) return false;
	for (const s of before) {
		if (s && s.type === "subgoal" && s.subgoal?.planId === planId) {
			return true;
		}
	}
	return false;
}

describe("spawn-child instantiation short-circuit", () => {
	it("returns true when planId matches an existing subgoal step", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: { planId: "phase-1-leaf-A" } },
			{ type: "subgoal", subgoal: { planId: "phase-2-leaf-B" } },
		];
		assert.equal(isInstantiation("phase-1-leaf-A", before), true);
		assert.equal(isInstantiation("phase-2-leaf-B", before), true);
	});

	it("returns false when planId does NOT match any existing step", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: { planId: "phase-1-leaf-A" } },
		];
		assert.equal(isInstantiation("entirely-new-leaf", before), false);
	});

	it("returns false when no planId is provided (ad-hoc spawn)", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: { planId: "phase-1-leaf-A" } },
		];
		assert.equal(isInstantiation(undefined, before), false);
	});

	it("returns false when before is empty (pre-freeze proposal)", () => {
		assert.equal(isInstantiation("phase-1-leaf-A", []), false);
	});

	it("ignores non-subgoal steps", () => {
		// Defensive: a `command` or `llm-review` step with the same
		// `planId` (impossible in practice, but the predicate must not
		// match it).
		const before: VerifyStepShape[] = [
			{ type: "command", subgoal: { planId: "phase-1-leaf-A" } },
		];
		assert.equal(isInstantiation("phase-1-leaf-A", before), false);
	});

	it("ignores steps without a subgoal field", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal" },
		];
		assert.equal(isInstantiation("phase-1-leaf-A", before), false);
	});

	it("ignores steps whose subgoal has no planId", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: {} },
		];
		assert.equal(isInstantiation("phase-1-leaf-A", before), false);
	});

	it("matches the FIRST step with the same planId; subsequent dupes don't matter", () => {
		// In a well-formed plan planIds are unique, but the predicate
		// shouldn't be order-sensitive.
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: { planId: "X" } },
			{ type: "subgoal", subgoal: { planId: "X" } }, // duplicate (malformed)
		];
		assert.equal(isInstantiation("X", before), true);
	});

	it("treats empty-string planId as falsy / no-match", () => {
		const before: VerifyStepShape[] = [
			{ type: "subgoal", subgoal: { planId: "" } },
		];
		// Caller guard: empty planId in body should be rejected by the
		// route before reaching the predicate. Defence in depth: even if
		// it slipped through, it shouldn't pin an existing step with the
		// same empty value (it's degenerate either way).
		assert.equal(isInstantiation("", before), false);
	});
});
