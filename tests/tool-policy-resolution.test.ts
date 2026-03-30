/**
 * Unit tests for the unified tool access policy system.
 *
 * Tests:
 * - resolveGrantPolicy with all 5 resolution layers
 * - ToolGroupPolicyStore CRUD operations
 * - Role migration from allowedTools to toolPolicies
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { resolveGrantPolicy } = await import("../dist/server/agent/tool-activation.js");
const { ToolGroupPolicyStore } = await import("../dist/server/agent/tool-group-policy-store.js");

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal mock ToolManager — only needs getToolByName() */
function mockToolManager(tools: Record<string, { grantPolicy?: string }>) {
	return {
		getToolByName(name: string) {
			const key = Object.keys(tools).find(k => k.toLowerCase() === name.toLowerCase());
			return key ? tools[key] : undefined;
		},
	};
}

/** Minimal mock GroupPolicyProvider */
function mockGroupPolicyStore(policies: Record<string, string>) {
	return {
		getGroupPolicy(group: string) {
			return policies[group] ?? null;
		},
	};
}

// ── resolveGrantPolicy — 5-layer resolution ─────────────────────────

describe("resolveGrantPolicy — unified 5-layer resolution", () => {
	it("layer 1: role tool-specific override wins over everything", () => {
		const role = {
			toolPolicies: {
				"mcp__pw__snap": "never-ask" as const,
				"mcp__pw": "ask-once" as const,
			},
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "always-ask" } });
		const gps = mockGroupPolicyStore({ "mcp__pw": "always-allow" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "never-ask");
	});

	it("layer 2: role group override wins over tool default and group default", () => {
		const role = { toolPolicies: { "mcp__playwright": "always-ask" as const } };
		const tm = mockToolManager({ "mcp__playwright__snap": { grantPolicy: "ask-once" } });
		const gps = mockGroupPolicyStore({ "mcp__playwright": "always-allow" });
		assert.equal(resolveGrantPolicy("mcp__playwright__snap", "mcp__playwright", role, tm, gps), "always-ask");
	});

	it("layer 3: tool YAML default wins over group default", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask-once" } });
		const gps = mockGroupPolicyStore({ "mcp__pw": "always-ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "ask-once");
	});

	it("layer 4: group default wins over system fallback", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		const gps = mockGroupPolicyStore({ "mcp__pw": "always-ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "always-ask");
	});

	it("layer 5: system fallback returns 'always-allow' when no policy configured", () => {
		const role = {};
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({});
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "always-allow");
	});

	it("system fallback when no groupPolicyStore provided", () => {
		const role = {};
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "always-allow");
	});

	it("system fallback with undefined role and toolManager", () => {
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, undefined), "always-allow");
	});

	it("'never-ask' policy correctly returned at role tool level", () => {
		const role = { toolPolicies: { "dangerous_tool": "never-ask" as const } };
		assert.equal(resolveGrantPolicy("dangerous_tool", "SomeGroup", role, undefined), "never-ask");
	});

	it("'never-ask' policy correctly returned at role group level", () => {
		const role = { toolPolicies: { "mcp__dangerous": "never-ask" as const } };
		assert.equal(resolveGrantPolicy("mcp__dangerous__tool", "mcp__dangerous", role, undefined), "never-ask");
	});

	it("'never-ask' policy correctly returned at tool YAML level", () => {
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "never-ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", {}, tm), "never-ask");
	});

	it("'never-ask' policy correctly returned at group default level", () => {
		const gps = mockGroupPolicyStore({ "Browser": "never-ask" });
		assert.equal(resolveGrantPolicy("browser_click", "Browser", {}, mockToolManager({}), gps), "never-ask");
	});

	it("'always-allow' at group level matches group name exactly", () => {
		const gps = mockGroupPolicyStore({ "Browser": "ask-once" });
		// Tool in a different group should not match
		assert.equal(resolveGrantPolicy("read", "Filesystem", {}, mockToolManager({}), gps), "always-allow");
	});

	it("undefined toolGroup skips group-level checks", () => {
		const role = { toolPolicies: { "mcp__pw": "ask-once" as const } };
		const gps = mockGroupPolicyStore({ "mcp__pw": "always-ask" });
		// With undefined toolGroup, neither role group nor group default apply
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, undefined, gps), "always-allow");
	});

	it("empty toolPolicies falls through to tool default", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "read": { grantPolicy: "always-ask" } });
		assert.equal(resolveGrantPolicy("read", "Filesystem", role, tm), "always-ask");
	});

	it("'always-allow' at any layer is returned correctly", () => {
		const role = { toolPolicies: { "my_tool": "always-allow" as const } };
		assert.equal(resolveGrantPolicy("my_tool", "Group", role, undefined), "always-allow");
	});
});

// ── ToolGroupPolicyStore CRUD ───────────────────────────────────────

describe("ToolGroupPolicyStore", () => {
	let tmpDir: string;
	let origBobbitDir: string | undefined;

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-test-group-policy-"));
		// Set BOBBIT_DIR so the store reads from our temp directory
		origBobbitDir = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = tmpDir;
		// Create the config dir structure
		fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
	});

	after(() => {
		if (origBobbitDir !== undefined) {
			process.env.BOBBIT_DIR = origBobbitDir;
		} else {
			delete process.env.BOBBIT_DIR;
		}
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getAll returns empty object when no file exists", () => {
		const store = new ToolGroupPolicyStore();
		const all = store.getAll();
		assert.deepEqual(all, {});
	});

	it("setGroupPolicy creates file and stores policy", () => {
		const store = new ToolGroupPolicyStore();
		store.setGroupPolicy("Browser", "ask-once");
		assert.equal(store.getGroupPolicy("Browser"), "ask-once");
	});

	it("getGroupPolicy returns null for unknown group", () => {
		const store = new ToolGroupPolicyStore();
		assert.equal(store.getGroupPolicy("nonexistent"), null);
	});

	it("setGroupPolicy with null removes the entry", () => {
		const store = new ToolGroupPolicyStore();
		store.setGroupPolicy("Browser", "ask-once");
		assert.equal(store.getGroupPolicy("Browser"), "ask-once");
		store.setGroupPolicy("Browser", null);
		assert.equal(store.getGroupPolicy("Browser"), null);
	});

	it("getAll returns all stored policies", () => {
		const store = new ToolGroupPolicyStore();
		store.setGroupPolicy("Agent", "always-allow");
		store.setGroupPolicy("mcp__playwright", "always-ask");
		const all = store.getAll();
		assert.equal(all["Agent"], "always-allow");
		assert.equal(all["mcp__playwright"], "always-ask");
	});

	it("persists to disk — new instance reads same data", () => {
		const store1 = new ToolGroupPolicyStore();
		store1.setGroupPolicy("Shell", "never-ask");

		// Create a new instance — should read from disk
		const store2 = new ToolGroupPolicyStore();
		assert.equal(store2.getGroupPolicy("Shell"), "never-ask");
	});

	it("invalid policy values in YAML are filtered out", () => {
		// Write invalid data directly to the file
		const filePath = path.join(tmpDir, "config", "tool-group-policies.yaml");
		fs.writeFileSync(filePath, "Browser: ask-once\nInvalid: not-a-policy\nAgent: always-allow\n");

		const store = new ToolGroupPolicyStore();
		const all = store.getAll();
		assert.equal(all["Browser"], "ask-once");
		assert.equal(all["Agent"], "always-allow");
		assert.equal(all["Invalid"], undefined);
	});
});
