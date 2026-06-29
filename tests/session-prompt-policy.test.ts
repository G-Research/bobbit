import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { computeEffectiveAllowedTools, resolveGrantPolicy } = await import("../src/server/agent/tool-activation.ts");

const SESSION_PROMPT_TOOL = { name: "session_prompt", group: "Agent", grantPolicy: "never" as const };
const READ_TOOL = { name: "read_session", group: "Agent" };

function mockToolManager() {
	const tools = [SESSION_PROMPT_TOOL, READ_TOOL];
	const providers = new Map(tools.map((tool) => [tool.name, { type: "bobbit-extension", tool: tool.name }]));
	return {
		getAvailableTools() {
			return tools;
		},
		getToolByName(name: string) {
			return tools.find((tool) => tool.name.toLowerCase() === name.toLowerCase());
		},
		getToolProviders() {
			return providers;
		},
	};
}

function mockGroupPolicyStore(policies: Record<string, string>) {
	return {
		getGroupPolicy(group: string) {
			return policies[group] ?? null;
		},
		getAll() {
			return policies;
		},
	};
}

function allowedNames(role?: { toolPolicies?: Record<string, string> }) {
	return computeEffectiveAllowedTools(
		mockToolManager() as never,
		role as never,
		mockGroupPolicyStore({ Agent: "allow" }) as never,
	).map((tool: { name: string }) => tool.name);
}

describe("session_prompt grant policy", () => {
	it("resolves to never from its tool default even though Agent tools are otherwise default-allow", () => {
		const policy = resolveGrantPolicy(
			"session_prompt",
			"Agent",
			undefined,
			mockToolManager() as never,
			mockGroupPolicyStore({ Agent: "allow" }) as never,
		);

		assert.equal(policy, "never");
	});

	it("is absent from effective allowed tools unless explicitly re-granted", () => {
		const defaultAllowed = allowedNames();
		assert.ok(defaultAllowed.includes("read_session"), "control Agent tool should remain available");
		assert.ok(!defaultAllowed.includes("session_prompt"), "session_prompt must not be exposed by default");

		const explicitlyAllowed = allowedNames({ toolPolicies: { session_prompt: "allow" } });
		assert.ok(explicitlyAllowed.includes("session_prompt"), "a per-tool allow policy should re-grant session_prompt");
	});
});
