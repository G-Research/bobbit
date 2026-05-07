/**
 * Unit tests for the system-scope Subgoals (Experimental) feature gate
 * inside `resolveGrantPolicy`. When the flag is OFF, every tool in the
 * `Children` group must resolve to `never`, regardless of role-level
 * overrides or group-policy defaults. When ON, the normal cascade
 * applies. See docs/design/subgoals-experimental-toggle.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveGrantPolicy } = await import("../src/server/agent/tool-activation.ts");

interface MockGroupPolicyStore {
	getGroupPolicy(group: string): string | null;
	getSubgoalsEnabled(): boolean;
}

function gpStore(subgoalsEnabled: boolean, policies: Record<string, string> = {}): MockGroupPolicyStore {
	return {
		getGroupPolicy: (g: string) => policies[g] ?? null,
		getSubgoalsEnabled: () => subgoalsEnabled,
	};
}

const CHILDREN_TOOLS = [
	"goal_spawn_child",
	"goal_plan_propose",
	"goal_plan_status",
	"goal_merge_child",
	"goal_pause",
	"goal_resume",
	"goal_archive_child",
	"goal_decide_mutation",
	"goal_set_policy",
];

describe("resolveGrantPolicy — Subgoals feature gate", () => {
	it("forces every Children-group tool to 'never' when subgoalsEnabled is false", () => {
		const gp = gpStore(false);
		// Even with an explicit role allow override, the gate should fire.
		const role = {
			toolPolicies: Object.fromEntries(CHILDREN_TOOLS.map(t => [t, "allow"])),
		} as { toolPolicies?: Record<string, "allow" | "ask" | "never"> };
		for (const name of CHILDREN_TOOLS) {
			const policy = resolveGrantPolicy(name, "Children", role, undefined, gp as never);
			assert.equal(policy, "never", `${name} should resolve to never when flag is off`);
		}
	});

	it("forces 'never' even when group policy says 'allow'", () => {
		const gp = gpStore(false, { Children: "allow" });
		const policy = resolveGrantPolicy("goal_spawn_child", "Children", undefined, undefined, gp as never);
		assert.equal(policy, "never");
	});

	it("does NOT gate non-Children groups", () => {
		const gp = gpStore(false);
		const policy = resolveGrantPolicy("delegate", "Agent", undefined, undefined, gp as never);
		// Falls through to the system fallback (allow).
		assert.equal(policy, "allow");
	});

	it("when flag is on, role-allow on a Children tool resolves to 'allow'", () => {
		const gp = gpStore(true);
		const role = { toolPolicies: { goal_spawn_child: "allow" as const } };
		const policy = resolveGrantPolicy("goal_spawn_child", "Children", role, undefined, gp as never);
		assert.equal(policy, "allow");
	});

	it("when flag is on, role-never on a Children tool resolves to 'never'", () => {
		const gp = gpStore(true);
		const role = { toolPolicies: { goal_spawn_child: "never" as const } };
		const policy = resolveGrantPolicy("goal_spawn_child", "Children", role, undefined, gp as never);
		assert.equal(policy, "never");
	});

	it("when flag is on and no role/group policy, falls through to allow", () => {
		const gp = gpStore(true);
		const policy = resolveGrantPolicy("goal_spawn_child", "Children", undefined, undefined, gp as never);
		assert.equal(policy, "allow");
	});

	it("works without getSubgoalsEnabled (legacy callers): falls through normal cascade", () => {
		// A bare GroupPolicyProvider without the Subgoals accessor must not
		// gate the Children group \u2014 this is the safety net for unit tests
		// that pre-date the flag.
		const gp = { getGroupPolicy: () => null };
		const policy = resolveGrantPolicy("goal_spawn_child", "Children", undefined, undefined, gp as never);
		assert.equal(policy, "allow");
	});
});
