import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolManager, __resetToolScanCache } from "../../src/server/agent/tool-manager.ts";
import {
	CanonicalMutationError,
	applyCanonicalToolProposal,
	createCanonicalRole,
	createCanonicalStaff,
	createCanonicalWorkflow,
	updateCanonicalWorkflow,
} from "../../src/server/proposals/canonical-mutations.ts";

const roots: string[] = [];

afterEach(() => {
	__resetToolScanCache();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { configDir: string; builtinDir: string; manager: ToolManager } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-proposal-mutations-"));
	roots.push(root);
	const configDir = path.join(root, "project", ".bobbit", "config");
	const builtinDir = path.join(root, "defaults", "tools");
	fs.mkdirSync(path.join(builtinDir, "fixture"), { recursive: true });
	fs.writeFileSync(path.join(builtinDir, "fixture", "fallback.yaml"), "name: fallback_tool\ndescription: bundled\ngroup: Fixture\n", "utf8");
	return { configDir, builtinDir, manager: new ToolManager(configDir, builtinDir) };
}

function yaml(name: string, description: string, group = "Fixture"): string {
	return `name: ${name}\ndescription: ${description}\ngroup: ${group}\n`;
}

function apply(manager: ToolManager, action: "create" | "update" | "delete", tool: string, content?: string) {
	return applyCanonicalToolProposal({ action, tool, content }, { configDir: manager.getToolsDir(), toolManager: manager });
}

describe("canonical proposal mutations", () => {
	it("preserves role defaulting and staff creation options through the shared services", async () => {
		let role: any;
		const createdRole = await createCanonicalRole({ name: "proposal-role", label: "Proposal Role", promptTemplate: "Prompt" }, {
			scope: "project",
			store: { put: (value: any) => { role = value; } } as any,
			projectId: "project",
		}, { normalizeThinking: () => undefined, validateModel: async () => true });
		assert.equal(createdRole.accessory, "none");
		assert.equal(role.name, "proposal-role");

		let options: Record<string, unknown> | undefined;
		let broadcast = false;
		const staff = await createCanonicalStaff({ name: "Proposal Staff", description: "", systemPrompt: "Prompt", cwd: "/workspace", projectId: "project", sandboxed: true, worktree: false }, {
			create: async (_name, _description, _prompt, _cwd, value) => { options = value; return { id: "staff-1" }; },
			broadcast: (value) => { broadcast = value.id === "staff-1"; },
		});
		assert.equal(staff.id, "staff-1");
		assert.equal(options?.sandboxed, true);
		assert.equal(options?.worktree, false);
		assert.equal(broadcast, true);
	});

	it("creates, updates, and deletes exactly the project override while revealing a bundled fallback", () => {
		const { configDir, manager } = fixture();
		apply(manager, "create", "fallback_tool", yaml("fallback_tool", "project version"));
		assert.equal(manager.getToolByName("fallback_tool")?.description, "project version");
		apply(manager, "update", "fallback_tool", yaml("fallback_tool", "updated project version"));
		assert.equal(manager.getToolByName("fallback_tool")?.description, "updated project version");
		apply(manager, "delete", "fallback_tool");
		assert.equal(manager.getToolByName("fallback_tool")?.description, "bundled");
		assert.equal(fs.existsSync(path.join(configDir, "tools", "fixture", "fallback_tool.yaml")), false);
	});

	it("rejects malformed content and traversal before mutating the project tree", () => {
		const { configDir, manager } = fixture();
		const before = fs.existsSync(path.join(configDir, "tools"));
		assert.throws(() => apply(manager, "create", "unsafe", "name: unsafe\ndescription: okay\ngroup: Fixture\nprovider: nope\n"), CanonicalMutationError);
		assert.equal(fs.existsSync(path.join(configDir, "tools")), before);
		assert.throws(() => apply(manager, "create", "../escape", yaml("escape", "no")), CanonicalMutationError);
		assert.equal(fs.existsSync(path.join(configDir, "tools")), before);
	});

	it("preserves previous override bytes when an update candidate is rejected", () => {
		const { configDir, manager } = fixture();
		const initial = yaml("safe_tool", "safe");
		apply(manager, "create", "safe_tool", initial);
		const file = path.join(configDir, "tools", "fixture", "safe_tool.yaml");
		assert.throws(() => apply(manager, "update", "safe_tool", "name: safe_tool\ndescription: bad\ngroup: Fixture\nprovider: broken\n"), CanonicalMutationError);
		assert.equal(fs.readFileSync(file, "utf8"), initial);
		assert.equal(manager.getToolByName("safe_tool")?.description, "safe");
	});

	it("validates workflow gates before create or update writes", () => {
		const records = new Map<string, any>();
		const store = { get: (id: string) => records.get(id), put: (workflow: any) => records.set(workflow.id, workflow) } as any;
		const valid = { id: "valid", name: "Valid", gates: [{ id: "build", name: "Build", dependsOn: [], verify: [{ name: "Build", type: "command", run: "echo ok" }] }] };
		const created = createCanonicalWorkflow(valid, store, []);
		assert.equal(records.get("valid"), created);
		assert.throws(() => createCanonicalWorkflow({ id: "bad", name: "Bad", gates: [{ id: "broken", name: "Broken", dependsOn: ["missing"] }] }, store, []), CanonicalMutationError);
		assert.equal(records.has("bad"), false);
		assert.throws(() => updateCanonicalWorkflow("valid", { gates: [{ id: "build", name: "Build", dependsOn: ["missing"] }] }, store, []), CanonicalMutationError);
		assert.equal(records.get("valid").gates[0].dependsOn[0], undefined);
	});
});
