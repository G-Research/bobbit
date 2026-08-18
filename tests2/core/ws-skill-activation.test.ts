import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../src/server/bobbit-dir.ts";
import { createDynamicCapabilitySelection, type DynamicCapabilitySelection } from "../../src/server/agent/dynamic-capability-contract.ts";
import { discoverSlashSkills, invalidateSlashSkillsCache } from "../../src/server/skills/slash-skills.ts";
import { handleWebSocketConnection } from "../../src/server/ws/handler.ts";

const originalProjectRoot = getProjectRoot();
const originalBobbitDir = process.env.BOBBIT_DIR;
const originalPiDir = process.env.BOBBIT_PI_DIR;
const roots: string[] = [];

type Scope = "server" | "global-user" | "project";
type ActivationStore = {
	get(key: string): string | undefined;
	getPackActivation(scope: Scope, packName: string): { skills?: string[] };
};

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	sent: unknown[] = [];

	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		callback?.();
	}

	close(): void {
		this.readyState = 3;
	}
}

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-ws-skill-activation-"));
	roots.push(root);
	return root;
}

function setServerRoot(root: string): string {
	const headquarters = path.join(root, ".bobbit", "headquarters");
	setProjectRoot(root);
	process.env.BOBBIT_DIR = headquarters;
	delete process.env.BOBBIT_PI_DIR;
	return headquarters;
}

function writeSkill(cwd: string, skillName: string, body: string): void {
	const skillDir = path.join(cwd, ".claude", "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
		"---",
		`name: ${skillName}`,
		`description: ${skillName}`,
		"---",
		body,
	].join("\n"), "utf8");
}

function writePack(base: string, packName: string, skillName: string, scope: "server" | "project" = "project"): void {
	const configDir = scope === "server" ? path.join(base, "config") : path.join(base, ".bobbit", "config");
	const packRoot = path.join(configDir, "market-packs", packName);
	fs.mkdirSync(path.join(packRoot, "skills", skillName), { recursive: true });
	fs.writeFileSync(path.join(packRoot, "pack.yaml"), [
		`name: ${packName}`,
		"description: WS activation fixture",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		`  skills: [${skillName}]`,
		"  entrypoints: []",
	].join("\n"), "utf8");
	fs.writeFileSync(path.join(packRoot, ".pack-meta.yaml"), [
		`packName: ${packName}`,
		"version: 1.0.0",
		`scope: ${scope}`,
		"sourceUrl: \"\"",
		"sourceRef: \"\"",
		"commit: \"\"",
		"installedAt: \"\"",
		"updatedAt: \"\"",
	].join("\n"), "utf8");
	fs.writeFileSync(path.join(packRoot, "skills", skillName, "SKILL.md"), [
		"---",
		`name: ${skillName}`,
		`description: ${skillName}`,
		"---",
		"must never expand",
	].join("\n"), "utf8");
}

function store(scope: Scope, packName: string, skillName: string): ActivationStore {
	return {
		get(key: string): string | undefined {
			return key === "pack_order" ? JSON.stringify({ [scope]: [packName] }) : undefined;
		},
		getPackActivation(requestedScope: Scope, requestedPack: string): { skills?: string[] } {
			return requestedScope === scope && requestedPack === packName ? { skills: [skillName] } : {};
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail("timed out waiting for WebSocket prompt");
}

async function sendPrompt({
	cwd,
	projectId,
	serverStore,
	projectStore,
	text = "/disabled-skill",
	selectedSkills,
	dynamicCapabilities,
}: {
	cwd: string;
	projectId?: string;
	serverStore: ActivationStore;
	projectStore?: ActivationStore;
	text?: string;
	selectedSkills?: string[];
	dynamicCapabilities?: DynamicCapabilitySelection;
}): Promise<{ originalText: string; options: Record<string, unknown> }> {
	const sessionId = `ws-skill-${Math.random().toString(36).slice(2)}`;
	const ws = new FakeWebSocket();
	const queued: Array<{ originalText: string; options: Record<string, unknown> }> = [];
	const clients = new Set<unknown>();
	const selection = dynamicCapabilities ?? (selectedSkills === undefined
		? undefined
		: createDynamicCapabilitySelection("", selectedSkills, [], { skills: true, mcp: false }));
	const session: any = {
		id: sessionId,
		status: "idle",
		statusVersion: 1,
		title: "WS skill activation",
		cwd,
		projectId,
		clients,
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => [] },
		rpcClient: {},
		...(selection === undefined ? {} : { dynamicCapabilities: selection }),
	};
	const manager: any = {
		getSession: (id: string) => id === sessionId ? session : undefined,
		getArchivedSession: () => undefined,
		addClient: (_id: string, client: unknown) => clients.add(client),
		removeClient: (_id: string, client: unknown) => clients.delete(client),
		getPersistedSession: () => undefined,
		getImageModelForSession: () => undefined,
		withSessionCostInState: (_id: string, data: unknown) => data,
		getSessionCostUpdate: () => undefined,
		getPendingToolPermission: () => undefined,
		getProjectContextManager: () => undefined,
		intentSettlement: () => undefined,
		enqueuePrompt: async (_id: string, originalText: string, options: Record<string, unknown>) => queued.push({ originalText, options }),
	};
	const projectContextManager = projectId && projectStore ? {
		getOrCreate: (id: string) => id === projectId ? {
			project: { rootPath: cwd },
			projectConfigStore: projectStore,
		} : undefined,
	} : undefined;

	handleWebSocketConnection(
		ws as any,
		sessionId,
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		manager,
		"unused-token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		serverStore,
		true,
		undefined,
		projectContextManager as any,
	);
	ws.emit("message", JSON.stringify({ type: "auth", token: "ignored" }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	ws.emit("message", JSON.stringify({ type: "prompt", text }));
	await waitFor(() => queued.length === 1);
	return queued[0];
}

beforeEach(() => invalidateSlashSkillsCache());
afterEach(() => {
	invalidateSlashSkillsCache();
	setProjectRoot(originalProjectRoot);
	if (originalBobbitDir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = originalBobbitDir;
	if (originalPiDir === undefined) delete process.env.BOBBIT_PI_DIR;
	else process.env.BOBBIT_PI_DIR = originalPiDir;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WebSocket slash-skill pack activation", () => {
	it("keeps a disabled server market skill unknown and cannot poison API discovery", async () => {
		const serverRoot = tempRoot();
		const projectRoot = tempRoot();
		const serverBase = setServerRoot(serverRoot);
		writePack(serverBase, "server-disabled-pack", "disabled-skill", "server");
		const serverStore = store("server", "server-disabled-pack", "disabled-skill");

		const queued = await sendPrompt({ cwd: projectRoot, serverStore });
		assert.equal(queued.originalText, "/disabled-skill");
		assert.equal(queued.options.skillExpansions, undefined, "disabled skill must remain unknown in typed WS expansion");
		assert.equal(queued.options.modelText, undefined);

		const apiSkills = discoverSlashSkills(projectRoot, serverStore, {
			serverBase,
			globalUserBase: path.join(serverRoot, "empty-home"),
			projectBase: projectRoot,
			serverConfigStore: serverStore,
			packActivation: (scope, packName) =>
				scope === "project" ? {} : serverStore.getPackActivation(scope, packName),
		});
		assert.equal(apiSkills.some((skill) => skill.name === "disabled-skill"), false, "WS discovery must not cache an activation-bypassed server skill for API/catalog callers");
	});

	it("uses the owning project store for a disabled project market skill", async () => {
		const serverRoot = tempRoot();
		const projectRoot = tempRoot();
		setServerRoot(serverRoot);
		writePack(projectRoot, "project-disabled-pack", "disabled-skill");
		const serverStore = store("server", "unrelated-server-pack", "unrelated-skill");
		const projectStore = store("project", "project-disabled-pack", "disabled-skill");

		const queued = await sendPrompt({
			cwd: projectRoot,
			projectId: "project-a",
			serverStore,
			projectStore,
		});
		assert.equal(queued.options.skillExpansions, undefined, "disabled project skill must remain unknown in typed WS expansion");
		assert.equal(queued.options.modelText, undefined);
	});

	it("applies the persisted selection ceiling to prefix and inline WebSocket expansions", async () => {
		const serverRoot = tempRoot();
		const projectRoot = tempRoot();
		setServerRoot(serverRoot);
		writeSkill(projectRoot, "ws-selected", "selected skill body");
		writeSkill(projectRoot, "ws-blocked", "blocked skill body");
		const serverStore = store("server", "unrelated-server-pack", "unrelated-skill");

		const selected = await sendPrompt({
			cwd: projectRoot,
			serverStore,
			text: "/ws-selected arg",
			selectedSkills: ["ws-selected"],
		});
		assert.equal((selected.options.skillExpansions as Array<{ name: string }>)[0]?.name, "ws-selected");
		assert.match(selected.options.modelText as string, /selected skill body/);

		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const inline = await sendPrompt({
				cwd: projectRoot,
				serverStore,
				text: "Use /ws-blocked with /ws-selected",
				selectedSkills: ["ws-selected"],
			});
			assert.deepEqual((inline.options.skillExpansions as Array<{ name: string }>).map((skill) => skill.name), ["ws-selected"]);
			assert.match(inline.options.modelText as string, /\/ws-blocked/, "unselected inline skill must stay literal");
			assert.doesNotMatch(inline.options.modelText as string, /blocked skill body/);
			assert.ok(warn.mock.calls.some(([message]) => String(message).includes('Slash skill "ws-blocked" not found')),
				"unselected inline skill must remain unknown to the existing warning path");
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps WebSocket skills unrestricted for an MCP-only selection", async () => {
		const serverRoot = tempRoot();
		const projectRoot = tempRoot();
		setServerRoot(serverRoot);
		writeSkill(projectRoot, "ws-legacy", "legacy skill body");
		const serverStore = store("server", "unrelated-server-pack", "unrelated-skill");
		const mcpOnlySelection = createDynamicCapabilitySelection("query", [], ["mcp-selected"], { skills: false, mcp: true });

		const queued = await sendPrompt({
			cwd: projectRoot,
			serverStore,
			text: "/ws-legacy arg",
			dynamicCapabilities: mcpOnlySelection,
		});
		assert.equal((queued.options.skillExpansions as Array<{ name: string }>)[0]?.name, "ws-legacy");
		assert.match(queued.options.modelText as string, /legacy skill body/);
	});

	it("treats an explicit empty persisted selection as deny-all while legacy sessions stay byte-compatible", async () => {
		const serverRoot = tempRoot();
		const projectRoot = tempRoot();
		setServerRoot(serverRoot);
		writeSkill(projectRoot, "ws-legacy", "legacy skill body");
		const serverStore = store("server", "unrelated-server-pack", "unrelated-skill");

		const legacy = await sendPrompt({ cwd: projectRoot, serverStore, text: "/ws-legacy arg" });
		const selected = await sendPrompt({
			cwd: projectRoot,
			serverStore,
			text: "/ws-legacy arg",
			selectedSkills: ["ws-legacy"],
		});
		// intentId is a fresh per-call identifier (unrelated to skill-selection
		// output); exclude it so this stays a comparison of expansion behavior.
		const { intentId: _legacyIntentId, ...legacyOptions } = legacy.options as Record<string, unknown>;
		const { intentId: _selectedIntentId, ...selectedOptions } = selected.options as Record<string, unknown>;
		assert.deepEqual({ ...selected, options: selectedOptions }, { ...legacy, options: legacyOptions }, "a matching selection must not change WebSocket expansion output");

		const denied = await sendPrompt({
			cwd: projectRoot,
			serverStore,
			text: "/ws-legacy arg",
			selectedSkills: [],
		});
		assert.equal(denied.originalText, "/ws-legacy arg");
		assert.equal(denied.options.skillExpansions, undefined);
		assert.equal(denied.options.modelText, undefined);
	});
});
