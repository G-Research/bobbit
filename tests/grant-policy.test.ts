/**
 * Unit tests for resolveGrantPolicy() in tool-activation.ts.
 * Covers priority resolution: role tool-specific > role group > tool YAML > null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveGrantPolicy } = await import("../dist/server/agent/tool-activation.js");

// Minimal mock ToolManager — only needs getToolByName()
function mockToolManager(tools: Record<string, { grantPolicy?: string }>) {
	return {
		getToolByName(name: string) {
			const key = Object.keys(tools).find(k => k.toLowerCase() === name.toLowerCase());
			return key ? tools[key] : undefined;
		},
	};
}

// ── Priority resolution ─────────────────────────────────────────────

describe("resolveGrantPolicy", () => {
	it("role tool-specific override wins over tool YAML default", () => {
		const role = { toolPolicies: { "mcp__pw__snap": "always-ask" as const } };
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-ask");
	});

	it("role group-level override when no tool-specific", () => {
		const role = { toolPolicies: { "mcp__playwright": "ask-once" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__playwright__snap", "mcp__playwright", role, tm), "ask-once");
	});

	it("tool YAML default when no role toolPolicies", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "ask-once");
	});

	it("returns null when no configuration exists", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), null);
	});

	it("falls through to tool YAML when role is undefined", () => {
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), "ask-once");
	});

	it("returns null with undefined role and no tool grantPolicy", () => {
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), null);
	});

	it("returns null with undefined toolManager and no role policy", () => {
		const role = {};
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, undefined), null);
	});

	it("falls through to tool YAML with empty toolPolicies", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "always-ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-ask");
	});

	it("returns null with empty toolPolicies and no tool grantPolicy", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), null);
	});

	it("priority: role tool > role group > YAML — all three set", () => {
		const role = {
			toolPolicies: {
				"mcp__pw__snap": "never-ask" as const,
				"mcp__pw": "ask-once" as const,
			},
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "always-ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "never-ask");
	});

	it("explicit never-ask via role toolPolicies", () => {
		const role = { toolPolicies: { "mcp__pw__snap": "never-ask" as const } };
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, undefined), "never-ask");
	});

	it("returns null when both role and toolManager are undefined", () => {
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, undefined), null);
	});

	it("undefined toolGroup skips group-level check", () => {
		const role = { toolPolicies: { "mcp__pw": "ask-once" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, tm), null);
	});

	it("group override wins over tool YAML default", () => {
		const role = {
			toolPolicies: { "mcp__pw": "always-ask" as const },
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-ask");
	});

	it("tool not found in toolManager returns null (no role policy)", () => {
		const role = {};
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__unknown__tool", "mcp__unknown", role, tm), null);
	});
});
