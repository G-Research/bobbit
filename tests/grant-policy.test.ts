/**
 * Unit tests for resolveGrantPolicy() in tool-activation.ts.
 * Covers 5-layer priority resolution:
 *   role tool-specific > role group > tool YAML default > group default > system fallback ('always-allow').
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

// Minimal mock GroupPolicyStore
function mockGroupPolicyStore(policies: Record<string, string>) {
	return {
		getGroupPolicy(group: string) {
			return policies[group] || null;
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

	it("returns always-allow (system fallback) when no configuration exists", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-allow");
	});

	it("falls through to tool YAML when role is undefined", () => {
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), "ask-once");
	});

	it("returns always-allow with undefined role and no tool grantPolicy", () => {
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), "always-allow");
	});

	it("returns always-allow with undefined toolManager and no role policy", () => {
		const role = {};
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, undefined), "always-allow");
	});

	it("falls through to tool YAML with empty toolPolicies", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "always-ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-ask");
	});

	it("returns always-allow with empty toolPolicies and no tool grantPolicy", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-allow");
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

	it("returns always-allow when both role and toolManager are undefined", () => {
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, undefined), "always-allow");
	});

	it("undefined toolGroup skips group-level check, falls back to always-allow", () => {
		const role = { toolPolicies: { "mcp__pw": "ask-once" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, tm), "always-allow");
	});

	it("group override wins over tool YAML default", () => {
		const role = {
			toolPolicies: { "mcp__pw": "always-ask" as const },
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-ask");
	});

	it("tool not found in toolManager returns always-allow (no role policy)", () => {
		const role = {};
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__unknown__tool", "mcp__unknown", role, tm), "always-allow");
	});

	// ── Layer 4: Group default policy ─────────────────────────────────

	it("group default policy wins over system fallback", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask-once" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "ask-once");
	});

	it("tool YAML default wins over group default", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "always-ask" } });
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask-once" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "always-ask");
	});

	it("role group override wins over group default", () => {
		const role = { toolPolicies: { "mcp__pw": "never-ask" as const } };
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask-once" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "never-ask");
	});

	it("group default ignored when toolGroup is undefined", () => {
		const role = {};
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask-once" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, tm, gps), "always-allow");
	});
});
