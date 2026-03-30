import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveGrantPolicy } from "../dist/server/agent/tool-activation.js";

/** Minimal ToolManager mock — only needs getToolByName */
function mockToolManager(tools: Record<string, { grantPolicy?: string }>) {
	return {
		getToolByName(name: string) {
			return tools[name] as { grantPolicy?: string } | undefined;
		},
	} as any;
}

describe("resolveGrantPolicy", () => {
	it("role tool-specific override wins over tool YAML", () => {
		const role = { toolPolicies: { "bash": "never-ask" as const } };
		const tm = mockToolManager({ "bash": { grantPolicy: "always-ask" } });
		assert.strictEqual(resolveGrantPolicy("bash", "shell", role, tm), "never-ask");
	});

	it("role group-level override (toolGroup match)", () => {
		const role = { toolPolicies: { "mcp__playwright": "always-ask" as const } };
		const tm = mockToolManager({});
		assert.strictEqual(
			resolveGrantPolicy("mcp__playwright__snap", "mcp__playwright", role, tm),
			"always-ask",
		);
	});

	it("tool YAML grantPolicy fallback", () => {
		const tm = mockToolManager({ "web_fetch": { grantPolicy: "ask-once" } });
		assert.strictEqual(resolveGrantPolicy("web_fetch", "web", undefined, tm), "ask-once");
	});

	it("no config returns null", () => {
		const tm = mockToolManager({});
		assert.strictEqual(resolveGrantPolicy("unknown_tool", undefined, undefined, tm), null);
	});

	it("undefined role falls through", () => {
		const tm = mockToolManager({ "bash": { grantPolicy: "always-ask" } });
		assert.strictEqual(resolveGrantPolicy("bash", "shell", undefined, tm), "always-ask");
	});

	it("undefined toolManager falls through to null", () => {
		assert.strictEqual(resolveGrantPolicy("bash", "shell", undefined, undefined), null);
	});

	it("empty toolPolicies falls through", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "bash": { grantPolicy: "ask-once" } });
		assert.strictEqual(resolveGrantPolicy("bash", "shell", role, tm), "ask-once");
	});

	it("priority: role tool > role group > YAML (all set)", () => {
		const role = {
			toolPolicies: {
				"mcp__pw__click": "never-ask" as const,
				"mcp__pw": "always-ask" as const,
			},
		};
		const tm = mockToolManager({ "mcp__pw__click": { grantPolicy: "ask-once" } });
		// Tool-specific should win
		assert.strictEqual(resolveGrantPolicy("mcp__pw__click", "mcp__pw", role, tm), "never-ask");
	});

	it("explicit never-ask from role", () => {
		const role = { toolPolicies: { "dangerous_tool": "never-ask" as const } };
		const tm = mockToolManager({});
		assert.strictEqual(resolveGrantPolicy("dangerous_tool", "danger", role, tm), "never-ask");
	});
});
