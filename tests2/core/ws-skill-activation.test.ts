import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../src/server/bobbit-dir.ts";
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
}: {
	cwd: string;
	projectId?: string;
	serverStore: ActivationStore;
	projectStore?: ActivationStore;
}): Promise<{ originalText: string; options: Record<string, unknown> }> {
	const sessionId = `ws-skill-${Math.random().toString(36).slice(2)}`;
	const ws = new FakeWebSocket();
	const queued: Array<{ originalText: string; options: Record<string, unknown> }> = [];
	const clients = new Set<unknown>();
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
	ws.emit("message", JSON.stringify({ type: "prompt", text: "/disabled-skill" }));
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
});
