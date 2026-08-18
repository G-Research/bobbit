import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolManager, __resetToolScanCache } from "../../src/server/agent/tool-manager.ts";
import {
	CanonicalMutationError,
	applyCanonicalToolProposal,
	canonicalToolProposalState,
	createCanonicalRole,
	createCanonicalStaff,
	createCanonicalWorkflow,
	deleteCanonicalStaff,
	updateCanonicalStaff,
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
	return applyCanonicalToolProposal({ action, tool, content }, { toolManager: manager });
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
			resolveProject: () => ({ projectId: "project", rootPath: "/workspace" }),
			validateCwd: () => undefined,
			create: async (_name, _description, _prompt, _cwd, value) => { options = value; return { id: "staff-1" }; },
			broadcast: (value) => { broadcast = value.id === "staff-1"; },
		});
		assert.equal(staff.id, "staff-1");
		assert.equal(options?.sandboxed, true);
		assert.equal(options?.worktree, false);
		assert.equal(broadcast, true);
	});

	it("owns staff validation, accessory session metadata, and lifecycle broadcasts", async () => {
		await assert.rejects(
			() => createCanonicalStaff({}, {
				resolveProject: () => ({ projectId: "project", rootPath: "/workspace" }),
				validateCwd: () => undefined,
				create: async () => ({ id: "never" }),
				broadcast: () => undefined,
			}),
			(error: any) => error instanceof CanonicalMutationError && error.message === "Missing name",
		);
		let staff: any = { id: "staff-1", currentSessionId: "session-1", accessory: "crown" };
		let accessory: unknown;
		let broadcasts = 0;
		const updated = updateCanonicalStaff("staff-1", { accessory: "crown" }, {
			update: () => true,
			read: () => staff,
			syncAccessory: (_sessionId, value) => { accessory = value; },
			broadcast: () => { broadcasts++; },
		});
		assert.equal(updated, staff);
		assert.equal(accessory, "crown");
		await deleteCanonicalStaff("staff-1", {
			read: () => staff,
			remove: async () => true,
			broadcast: () => { broadcasts++; },
		});
		assert.equal(broadcasts, 2);
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

	it("replays tool create, update, and delete only for the exact observed bytes and rejects competing writes", () => {
		const { manager } = fixture();
		const created = yaml("replay_tool", "created");
		const changed = yaml("replay_tool", "changed");

		// A lost response may replay each CRUD operation, but only if the exact
		// before-state proves the effect already happened.
		assert.equal(applyCanonicalToolProposal({ action: "create", tool: "replay_tool", content: created, expectedBeforeSha256: null }, { toolManager: manager }).action, "create");
		assert.equal(applyCanonicalToolProposal({ action: "create", tool: "replay_tool", content: created, expectedBeforeSha256: null }, { toolManager: manager }).action, "create");
		const createdHash = canonicalToolProposalState("replay_tool", { toolManager: manager })!;
		assert.equal(applyCanonicalToolProposal({ action: "update", tool: "replay_tool", content: changed, expectedBeforeSha256: createdHash }, { toolManager: manager }).action, "update");
		assert.equal(applyCanonicalToolProposal({ action: "update", tool: "replay_tool", content: changed, expectedBeforeSha256: createdHash }, { toolManager: manager }).action, "update");
		const changedHash = canonicalToolProposalState("replay_tool", { toolManager: manager })!;
		assert.equal(applyCanonicalToolProposal({ action: "delete", tool: "replay_tool", expectedBeforeSha256: changedHash }, { toolManager: manager }).action, "delete");
		assert.equal(applyCanonicalToolProposal({ action: "delete", tool: "replay_tool", expectedBeforeSha256: changedHash }, { toolManager: manager }).action, "delete");

		apply(manager, "create", "conflict_tool", yaml("conflict_tool", "first"));
		const staleHash = canonicalToolProposalState("conflict_tool", { toolManager: manager })!;
		apply(manager, "update", "conflict_tool", yaml("conflict_tool", "newer"));
		assert.throws(
			() => applyCanonicalToolProposal({ action: "update", tool: "conflict_tool", content: yaml("conflict_tool", "stale"), expectedBeforeSha256: staleHash }, { toolManager: manager }),
			(error: any) => error instanceof CanonicalMutationError && error.code === "TOOL_STATE_CONFLICT",
		);
	});

	it("rejects malformed content and traversal before mutating the project tree", () => {
		const { configDir, manager } = fixture();
		const before = fs.existsSync(path.join(configDir, "tools"));
		assert.throws(() => apply(manager, "create", "unsafe", "name: unsafe\ndescription: okay\ngroup: Fixture\nprovider: nope\n"), CanonicalMutationError);
		assert.equal(fs.existsSync(path.join(configDir, "tools")), before);
		assert.throws(() => apply(manager, "create", "../escape", yaml("escape", "no")), CanonicalMutationError);
		assert.equal(fs.existsSync(path.join(configDir, "tools")), before);
	});

	it("accepts an extension-backed override only when the local group dependencies load", () => {
		const { configDir, manager } = fixture();
		fs.mkdirSync(path.join(configDir, "tools", "fixture"), { recursive: true });
		fs.mkdirSync(path.join(configDir, "tools", "_shared"), { recursive: true });
		fs.writeFileSync(path.join(configDir, "tools", "_shared", "helper.ts"), "export const helper = true;\n");
		fs.writeFileSync(path.join(configDir, "tools", "fixture", "extension.ts"), "import { helper } from '../_shared/helper.ts'; export { helper };\n");
		const content = "name: extension_tool\ndescription: extension backed\ngroup: Fixture\nprovider:\n  type: bobbit-extension\n  extension: extension.ts\n";
		apply(manager, "create", "extension_tool", content);
		assert.equal(manager.getToolByName("extension_tool")?.description, "extension backed");
	});

	it("restores exact bytes after the target loader rejects a post-write update", () => {
		const { configDir, manager } = fixture();
		const initial = yaml("safe_tool", "safe");
		apply(manager, "create", "safe_tool", initial);
		const file = path.join(configDir, "tools", "fixture", "safe_tool.yaml");
		const rejectingTarget = {
			getToolsDir: () => manager.getToolsDir(),
			getBuiltinToolsDir: () => manager.getBuiltinToolsDir(),
			getLocalTools: () => [],
			getToolDiagnostics: () => [],
		} as unknown as ToolManager;
		assert.throws(() => apply(rejectingTarget, "update", "safe_tool", yaml("safe_tool", "candidate")), CanonicalMutationError);
		assert.equal(fs.readFileSync(file, "utf8"), initial);
	});

	it("removes an empty group after a failed create", () => {
		const { configDir, manager } = fixture();
		const rejectingTarget = {
			getToolsDir: () => manager.getToolsDir(),
			getBuiltinToolsDir: () => manager.getBuiltinToolsDir(),
			getLocalTools: () => [],
			getToolDiagnostics: () => [],
		} as unknown as ToolManager;
		assert.throws(() => apply(rejectingTarget, "create", "rejected_tool", yaml("rejected_tool", "candidate")), CanonicalMutationError);
		assert.equal(fs.existsSync(path.join(configDir, "tools", "fixture")), false);
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
