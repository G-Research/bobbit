import { afterEach, describe, expect, it } from "vitest";
import {
	parentHostEligibility,
	type EligibilityGoal,
} from "../../../src/app/subgoal-eligibility.js";
import { _setMaxNestingDepthForTesting } from "../../../src/app/subgoals-flag.js";

afterEach(() => {
	_setMaxNestingDepthForTesting(undefined);
});

describe("subgoal parent eligibility", () => {
	it("marks a parent with sub-goals disabled and provides the Children-tab remedy", () => {
		const parent: EligibilityGoal = { id: "parent", subgoalsAllowed: false };

		expect(parentHostEligibility(parent, [parent])).toEqual({
			eligible: false,
			reason: "subgoals-off",
			suffix: "(sub-goals off)",
			hint: expect.stringMatching(/dashboard.*Children tab.*Allow sub-goals/i),
		});
	});

	it("marks a parent whose inherited cap leaves no room for a child", () => {
		_setMaxNestingDepthForTesting(4);
		const goals: EligibilityGoal[] = [
			{ id: "root", subgoalsAllowed: true, maxNestingDepth: 2 },
			{ id: "parent", parentGoalId: "root", subgoalsAllowed: true },
		];

		expect(parentHostEligibility(goals[1], goals)).toEqual({
			eligible: false,
			reason: "at-cap",
			suffix: "(at nesting cap)",
			hint: expect.stringMatching(/depth 2.*cap \(2\).*no room/i),
		});
	});

	it("keeps an allowed parent below its effective cap eligible", () => {
		_setMaxNestingDepthForTesting(4);
		const parent: EligibilityGoal = {
			id: "parent",
			subgoalsAllowed: true,
			maxNestingDepth: 3,
		};

		expect(parentHostEligibility(parent, [parent])).toEqual({ eligible: true });
	});
});
