import { describe, expect, it } from "vitest";
import { validateInlineRoles } from "../../src/server/agent/inline-role-validator.js";
import { buildActive, buildFixture, buildSubgoalStep } from "../../tests/helpers/run-subgoal-step-fixture.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function role(overrides: Record<string, unknown> = {}) {
	return { name: "reviewer", label: "Reviewer", promptTemplate: "Review {{GOAL_BRANCH}}", ...overrides };
}

describe("canonical goal candidate primitives", () => {
	it("normalizes a valid inline role without mutating input", () => {
		const input = { reviewer: role({ toolPolicies: { bash: "always-ask" }, model: "openai/gpt-5", thinkingLevel: "high" }) };
		const result = validateInlineRoles(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.roles?.reviewer).toMatchObject({ accessory: "none", toolPolicies: { bash: "ask" }, createdAt: 0, updatedAt: 0 });
		expect(input.reviewer).not.toHaveProperty("accessory");
	});

	it.each([
		[{ "Bad Name": role({ name: "Bad Name" }) }, "lowercase alphanumeric"],
		[{ reviewer: role({ name: "other" }) }, "matching name"],
		[{ reviewer: role({ model: "malformed" }) }, "provider/model"],
		[{ reviewer: role({ thinkingLevel: "maximum" }) }, "unsupported"],
		[{ reviewer: role({ toolPolicies: { bash: "sometimes" } }) }, "invalid tool policy"],
	])("rejects invalid inline role contracts", (input, message) => {
		const result = validateInlineRoles(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain(message);
	});
});

describe("canonical goal commit boundary", () => {
	it("revalidates a verification child after held repository preflight", async () => {
		const fixture = await buildFixture();
		const entered = deferred();
		const release = deferred();
		const manager = fixture.goalManager as any;
		const originalPreflight = manager.preflightGoalCreation.bind(manager);
		manager.preflightGoalCreation = async (...args: unknown[]) => {
			const result = await originalPreflight(...args);
			entered.resolve();
			await release.promise;
			return result;
		};
		try {
			const step = buildSubgoalStep({ planId: "held-preflight-child" });
			const { signal, active, stepIndex } = buildActive(fixture.parent.id);
			const pending = fixture.harness.runSubgoalStep(step, signal, active, stepIndex);
			await entered.promise;
			fixture.goalStore.update(fixture.parent.id, { subgoalsAllowed: false });
			release.resolve();
			const result = await pending;
			expect(result.passed).toBe(false);
			expect(result.output).toMatch(/doesn't allow sub-goals/i);
			expect(fixture.goalStore.getAll().filter(goal => goal.parentGoalId === fixture.parent.id)).toEqual([]);
			expect(fixture.calls.filter(call => call.kind === "createGoal")).toEqual([]);
		} finally {
			manager.preflightGoalCreation = originalPreflight;
			release.resolve();
			fixture.cleanup();
		}
	});
});
