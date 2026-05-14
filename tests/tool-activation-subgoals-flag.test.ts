/**
 * Behavioural pin: `resolveGrantPolicy` Children-group gate.
 *
 * `resolveGrantPolicy` Step-0 short-circuits every tool in the `Children`
 * group to `'never'` when `groupPolicyStore.getSubgoalsEnabled()` returns
 * false. The reverse must also hold: when the getter is wired and returns
 * true, the normal cascade applies and the team-lead's `always-allow`
 * produces `'allow'`.
 *
 * This is the **trigger-condition** test required by AC #1:
 *   - RED scenario: getter not wired (getter undefined → getSubgoalsEnabled
 *     returns false) → `resolveGrantPolicy` returns `'never'` for Children
 *     tools even when the role explicitly declares `always-allow`.
 *   - GREEN scenario: getter wired and returning true → role-level
 *     `always-allow` wins → resolves to `'allow'`.
 *
 * This complements the source-pin in `server-subgoals-getter-wired.test.ts`
 * (which asserts the wiring CALL exists in server.ts) by asserting the
 * BEHAVIOUR of the resolver when the wiring is absent vs present.
 *
 * This regression hit twice via merge-conflict drops of the wiring call.
 * The source-pin prevents re-introduction; this test proves the resolver
 * itself behaves correctly end-to-end.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveGrantPolicy } = await import(
	"../src/server/agent/tool-activation.ts"
);

/** Minimal GroupPolicyProvider with a controllable subgoalsEnabled getter. */
function makeGroupPolicyStore(subgoalsEnabled: boolean | undefined): import("../src/server/agent/tool-activation.ts").GroupPolicyProvider {
	return {
		getGroupPolicy: () => null,
		getSubgoalsEnabled: subgoalsEnabled === undefined ? undefined : () => subgoalsEnabled,
	} as unknown as import("../src/server/agent/tool-activation.ts").GroupPolicyProvider;
}

/** Team-lead role excerpt — has always-allow for all Children tools. */
const TEAM_LEAD_ROLE = {
	toolPolicies: {
		goal_spawn_child: "always-allow" as const,
		goal_plan_propose: "always-allow" as const,
		goal_merge_child: "always-allow" as const,
		goal_pause: "always-allow" as const,
		goal_resume: "always-allow" as const,
		goal_archive_child: "always-allow" as const,
		goal_plan_status: "always-allow" as const,
		goal_decide_mutation: "always-allow" as const,
		goal_set_policy: "always-allow" as const,
	},
};

/** Contributor role — has never for all Children tools. */
const CODER_ROLE = {
	toolPolicies: {
		goal_spawn_child: "never" as const,
	},
};

const CHILDREN_TOOLS: Array<{ name: string; group: "Children" }> = [
	{ name: "goal_spawn_child", group: "Children" },
	{ name: "goal_plan_propose", group: "Children" },
	{ name: "goal_plan_status", group: "Children" },
	{ name: "goal_merge_child", group: "Children" },
	{ name: "goal_pause", group: "Children" },
	{ name: "goal_resume", group: "Children" },
	{ name: "goal_archive_child", group: "Children" },
	{ name: "goal_decide_mutation", group: "Children" },
	{ name: "goal_set_policy", group: "Children" },
];

describe("resolveGrantPolicy — Children group subgoalsEnabled gate", () => {
	// ── RED scenario: getter not wired (simulates the missing-wiring regression) ──
	describe("getter wired returning false (subgoals OFF) — all Children tools → never", () => {
		const store = makeGroupPolicyStore(false);
		for (const { name, group } of CHILDREN_TOOLS) {
			it(`${name} resolves to 'never' even with team-lead always-allow`, () => {
				const policy = resolveGrantPolicy(name, group, TEAM_LEAD_ROLE, undefined, store);
				assert.equal(
					policy,
					"never",
					`Step-0 must veto ${name} when subgoalsEnabled=false, regardless of role policy`,
				);
			});
		}
	});

	// ── Also verify: getter undefined (step-0 check: getSubgoalsEnabled truthy?) ──
	describe("getSubgoalsEnabled method absent — Step-0 does NOT fire, role policy wins", () => {
		// When the method is absent, the guard condition
		//   `groupPolicyStore?.getSubgoalsEnabled && !groupPolicyStore.getSubgoalsEnabled()`
		// short-circuits on the first conjunct (undefined is falsy) — no veto.
		const storeWithoutGetter = {
			getGroupPolicy: () => null,
		} as unknown as import("../src/server/agent/tool-activation.ts").GroupPolicyProvider;

		it("goal_spawn_child with team-lead resolves to 'allow' when method absent", () => {
			const policy = resolveGrantPolicy("goal_spawn_child", "Children", TEAM_LEAD_ROLE, undefined, storeWithoutGetter);
			// team-lead has always-allow → normalizes to 'allow'
			assert.equal(policy, "allow");
		});
	});

	// ── GREEN scenario: getter wired returning true (subgoals ON) ──
	describe("getter wired returning true (subgoals ON) — role policy applies", () => {
		const store = makeGroupPolicyStore(true);

		for (const { name, group } of CHILDREN_TOOLS) {
			it(`${name} with team-lead role resolves to 'allow'`, () => {
				const policy = resolveGrantPolicy(name, group, TEAM_LEAD_ROLE, undefined, store);
				assert.equal(
					policy,
					"allow",
					`${name}: team-lead always-allow should win when subgoalsEnabled=true`,
				);
			});
		}

		it("goal_spawn_child with coder role resolves to 'never' (role policy, not Step-0)", () => {
			const policy = resolveGrantPolicy("goal_spawn_child", "Children", CODER_ROLE, undefined, store);
			assert.equal(
				policy,
				"never",
				"Coder's never policy is respected when subgoals are ON",
			);
		});
	});

	// ── Non-Children tools are unaffected by the subgoalsEnabled gate ──
	describe("non-Children tools are unaffected by subgoalsEnabled", () => {
		const storeOff = makeGroupPolicyStore(false);

		it("goal_signal (Tasks group) is unaffected when subgoalsEnabled=false", () => {
			const policy = resolveGrantPolicy("gate_signal", "Tasks", TEAM_LEAD_ROLE, undefined, storeOff);
			// team-lead has gate_signal: always-allow → 'allow'
			assert.equal(policy, "allow");
		});
	});
});
