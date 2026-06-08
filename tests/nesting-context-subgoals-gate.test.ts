/**
 * Pins the subgoals-flag gating of the dynamically-injected team-lead nesting
 * context (`buildNestingContextSection` in src/server/agent/system-prompt.ts).
 *
 * When the Subgoals feature is OFF the Children tools resolve to `never`, so the
 * tool-dependent guidance must NOT be injected — otherwise the team-lead is told
 * to use tools it doesn't have. But a CHILD goal's position guardrails ("DO NOT
 * raise a PR", branch merges into parent) must ALWAYS show, since a child can
 * outlive the flag being turned off.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNestingContextSection } from "../src/server/agent/system-prompt.ts";

describe("buildNestingContextSection — subgoals flag gating", () => {
	it("root + subgoals OFF → no nesting section at all", () => {
		const out = buildNestingContextSection({ team: true, subGoalsEnabled: false });
		assert.equal(out, undefined);
	});

	it("root + subgoals ON → emits root orchestration guidance", () => {
		const out = buildNestingContextSection({ team: true, subGoalsEnabled: true });
		assert.ok(out && out.includes("TOP-LEVEL ROOT"));
		assert.ok(out!.includes("maxConcurrentChildren"));
		assert.ok(out!.includes("When to use `subgoal`"), "Stanza C should be present when enabled");
	});

	it("child + subgoals OFF → keeps position guardrails, drops tool-dependent parts", () => {
		const out = buildNestingContextSection({
			team: true,
			subGoalsEnabled: false,
			parent: { id: "p1", title: "Parent", branch: "goal-parent" },
			goalBranch: "goal-child",
		});
		assert.ok(out, "child always gets its position guardrails");
		assert.ok(out!.includes("CHILD GOAL"));
		assert.ok(out!.includes("DO NOT raise a PR"));
		assert.ok(out!.includes("merges INTO the parent's branch"));
		// Tool-dependent parts must be gone.
		assert.ok(!out!.includes("deeper nested sub-goals"), "deeper-nesting bullet must be dropped");
		assert.ok(!out!.includes("When to use `subgoal`"), "Stanza C must be dropped");
		assert.ok(!out!.includes("goal_spawn_child"), "no Children-tool references when disabled");
	});

	it("child + subgoals ON → includes the deeper-nesting bullet and Stanza C", () => {
		const out = buildNestingContextSection({
			team: true,
			subGoalsEnabled: true,
			parent: { id: "p1", title: "Parent", branch: "goal-parent" },
			goalBranch: "goal-child",
		});
		assert.ok(out!.includes("DO NOT raise a PR"), "position guardrails still present");
		assert.ok(out!.includes("deeper nested sub-goals"));
		assert.ok(out!.includes("When to use `subgoal`"));
	});

	it("non-team goal → no section regardless of flag", () => {
		assert.equal(buildNestingContextSection({ team: false, subGoalsEnabled: true }), undefined);
	});
});
