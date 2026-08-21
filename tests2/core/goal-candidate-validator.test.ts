import { describe, expect, it } from "vitest";
import { validateInlineRoles } from "../../src/server/agent/inline-role-validator.js";

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
