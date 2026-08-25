import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigCascade } from "../../../src/server/agent/config-cascade.js";
import { EventBuffer } from "../../../src/server/agent/event-buffer.js";
import { RoleManager } from "../../../src/server/agent/role-manager.js";
import { RoleStore, type Role } from "../../../src/server/agent/role-store.js";
import { SessionManager } from "../../../src/server/agent/session-manager.js";
import { scopedToolContext } from "../../../src/server/agent/session-setup.js";
import { ToolGroupPolicyStore } from "../../../src/server/agent/tool-group-policy-store.js";
import { resolveGrantPolicy } from "../../../src/server/agent/tool-activation.js";
import { ToolManager } from "../../../src/server/agent/tool-manager.js";

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const TOOL = "project_scan_reconcile";
const GROUP = "Project Scanner";

const CODER: Role = {
	name: "coder",
	label: "Coder",
	promptTemplate: "Write correct code.",
	accessory: "none",
	toolPolicies: {},
	createdAt: 1,
	updatedAt: 1,
};

class MemorySessionStore {
	readonly records = new Map<string, any>();
	get(id: string) { return this.records.get(id); }
	getAll() { return [...this.records.values()]; }
	getAllLive() { return [...this.records.values()]; }
	getLive() { return [...this.records.values()]; }
	put(record: any) { this.records.set(record.id, record); }
	update(id: string, patch: Record<string, unknown>) {
		const record = this.records.get(id);
		if (record) Object.assign(record, patch);
	}
	flushAsync = async () => {};
}

type FixtureContext = {
	project: { id: string; rootPath: string };
	roleStore: RoleStore;
	toolManager: ToolManager;
	toolGroupPolicyStore: ToolGroupPolicyStore;
	sessionStore: MemorySessionStore;
};

type RestartCapture = {
	sessionId: string;
	overrideAllowedTools: string[] | undefined;
};

function writeTool(configDir: string): void {
	const groupDir = path.join(configDir, "tools", "project-scanner");
	fs.mkdirSync(groupDir, { recursive: true });
	fs.writeFileSync(path.join(groupDir, "scan_reconcile.yaml"), [
		`name: ${TOOL}`,
		"description: Reconcile project scanner coverage.",
		`group: ${GROUP}`,
		"grantPolicy: ask",
		"provider:",
		"  type: bobbit-extension",
		"  extension: extension.ts",
		"",
	].join("\n"));
	fs.writeFileSync(path.join(groupDir, "extension.ts"), "export default function extension() {}\n");
}

function putRole(store: RoleStore, role: Role): void {
	store.put({
		...role,
		toolPolicies: { ...role.toolPolicies },
	});
}

function snapshotFiles(dir: string): Record<string, string> {
	if (!fs.existsSync(dir)) return {};
	const result: Record<string, string> = {};
	const visit = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else result[path.relative(dir, absolute)] = fs.readFileSync(absolute, "utf8");
		}
	};
	visit(dir);
	return result;
}

function packRoleEntry(packDir: string): any {
	return {
		id: "market:project:readonly-scanner",
		kind: "market",
		scope: "project",
		path: packDir,
		readOnly: true,
		layout: "defaults-tree",
		manifest: {
			name: "readonly-scanner",
			description: "Read-only scanner fixture",
			version: "1.0.0",
			contents: { roles: ["readonly-scanner"], tools: [], skills: [], entrypoints: [] },
		},
	};
}

function makeLiveSession(id: string, projectId: string | undefined, role = "coder", allowedTools?: string[]): any {
	return {
		id,
		title: id,
		cwd: projectId ? path.join("/fixture", projectId) : "/fixture/server",
		projectId,
		role,
		allowedTools,
		status: "idle",
		statusVersion: 0,
		createdAt: 1,
		lastActivity: 1,
		clients: new Set(),
		eventBuffer: new EventBuffer(),
	};
}

function seedSession(context: FixtureContext, session: any, persistedAllowedTools?: string[]): void {
	context.sessionStore.put({
		id: session.id,
		title: session.title,
		cwd: session.cwd,
		projectId: session.projectId,
		role: session.role,
		...(persistedAllowedTools !== undefined ? { allowedTools: persistedAllowedTools } : {}),
		createdAt: 1,
		lastActivity: 1,
		sandboxed: false,
	});
}

describe("project-scoped persistent group grants", () => {
	let root: string;
	let serverConfig: string;
	let serverRoleStore: RoleStore;
	let serverRoleManager: RoleManager;
	let serverToolManager: ToolManager;
	let projectA: FixtureContext;
	let projectB: FixtureContext;
	let serverContext: FixtureContext;
	let manager: any;
	let restartCaptures: RestartCapture[];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "project-group-grant-"));
		serverConfig = path.join(root, "server-config");
		const projectAConfig = path.join(root, "project-a", ".bobbit", "config");
		const projectBConfig = path.join(root, "project-b", ".bobbit", "config");
		fs.mkdirSync(serverConfig, { recursive: true });
		writeTool(projectAConfig);
		writeTool(projectBConfig);

		serverRoleStore = new RoleStore(serverConfig);
		serverRoleStore.setBuiltins([{ ...CODER, toolPolicies: {} }]);
		serverRoleManager = new RoleManager(serverRoleStore);
		serverToolManager = new ToolManager(serverConfig);

		const makeContext = (id: string, configDir: string): FixtureContext => ({
			project: { id, rootPath: path.dirname(path.dirname(configDir)) },
			roleStore: new RoleStore(configDir),
			toolManager: new ToolManager(configDir),
			toolGroupPolicyStore: new ToolGroupPolicyStore(configDir),
			sessionStore: new MemorySessionStore(),
		});
		projectA = makeContext(PROJECT_A, projectAConfig);
		projectB = makeContext(PROJECT_B, projectBConfig);
		serverContext = makeContext("server-records", path.join(root, "server-records-config"));

		// B deliberately has the same role and tool names as A. An approval in A
		// must not become visible through either the server layer or B's local role.
		putRole(projectB.roleStore, { ...CODER, toolPolicies: { [TOOL]: "ask" } });

		const contexts = new Map<string, FixtureContext>([
			[PROJECT_A, projectA],
			[PROJECT_B, projectB],
		]);
		const pcm = {
			getOrCreate: (id: string) => contexts.get(id),
			all: () => [...contexts.values(), serverContext],
		};

		const readonlyPackDir = path.join(root, "readonly-pack");
		fs.mkdirSync(path.join(readonlyPackDir, "roles"), { recursive: true });
		fs.writeFileSync(path.join(readonlyPackDir, "roles", "readonly-scanner.yaml"), [
			"name: readonly-scanner",
			"label: Read-only scanner",
			"accessory: none",
			"toolPolicies:",
			`  ${TOOL}: ask`,
			"createdAt: 1",
			"updatedAt: 1",
			"promptTemplate: Read only scanner role.",
			"",
		].join("\n"));

		const cascade = new ConfigCascade({
			getRoles: () => [{ ...CODER, toolPolicies: {} }],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		} as any, {
			getRoles: () => serverRoleStore.getAllLocal(),
			getTools: () => serverToolManager.getLocalTools(),
			getToolGroupPolicies: () => ({}),
		}, pcm as any, undefined, {
			marketEntries: (scope: string, projectId?: string) =>
				scope === "project" && projectId === PROJECT_A ? [packRoleEntry(readonlyPackDir)] : [],
		}, path.join(root, "empty-global"), path.join(root, "empty-builtins"));

		manager = new SessionManager({
			projectContextManager: pcm as any,
			roleManager: serverRoleManager,
			toolManager: serverToolManager,
		});
		manager.configCascade = cascade;
		restartCaptures = [];
		manager._respawnAgentInPlace = vi.fn(async (session: any, persisted: any, options: any) => {
			const replacementInput = { ...persisted };
			options?.mutatePs?.(replacementInput);
			restartCaptures.push({
				sessionId: session.id,
				overrideAllowedTools: replacementInput._overrideAllowedTools,
			});
			const restored = {
				...session,
				allowedTools: replacementInput._overrideAllowedTools ?? session.allowedTools,
			};
			manager.sessions.set(session.id, restored);
			return restored;
		});
	});

	afterEach(() => {
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("copies a builtin coder approval only into project A and regenerates A without widening project B", async () => {
		const serverFilesBefore = snapshotFiles(path.join(serverConfig, "roles"));
		const serverRolesBefore = serverRoleStore.getAllLocal();
		const projectBRolesBefore = projectB.roleStore.getAllLocal();
		const session = makeLiveSession("project-a-builtin-coder", PROJECT_A);
		seedSession(projectA, session);
		manager.sessions.set(session.id, session);

		const granted = await manager.grantToolPermission(session.id, TOOL, "group", GROUP, "persistent");

		expect(snapshotFiles(path.join(serverConfig, "roles")), "RC7_PROJECT_ROLE_GRANT_LEAKED_TO_SERVER").toEqual(serverFilesBefore);
		expect(serverRoleStore.getAllLocal(), "RC7_PROJECT_ROLE_GRANT_CHANGED_SERVER_ROLE_STORE").toEqual(serverRolesBefore);
		const projectOverride = projectA.roleStore.getLocal("coder");
		expect(projectOverride, "RC7_PROJECT_ROLE_GRANT_MISSING_PROJECT_OVERRIDE").toBeDefined();
		expect(projectOverride?.toolPolicies?.[TOOL]).toBe("allow");
		expect(granted).toContain(TOOL);
		expect(restartCaptures).toEqual([{ sessionId: session.id, overrideAllowedTools: undefined }]);
		const aTool = projectA.toolManager.getToolByName(TOOL, scopedToolContext(PROJECT_A, projectA.project.rootPath));
		expect(resolveGrantPolicy(TOOL, GROUP, projectOverride, projectA.toolManager, undefined, scopedToolContext(PROJECT_A, projectA.project.rootPath), aTool)).toBe("allow");

		expect(projectB.roleStore.getAllLocal(), "RC7_PROJECT_ROLE_GRANT_CROSSED_PROJECT_BOUNDARY").toEqual(projectBRolesBefore);
		const bRole = (manager.configCascade.resolveRoles(PROJECT_B) as any[]).find((entry) => entry.item.name === "coder")!.item;
		const bTool = projectB.toolManager.getToolByName(TOOL, scopedToolContext(PROJECT_B, projectB.project.rootPath));
		expect(resolveGrantPolicy(TOOL, GROUP, bRole, projectB.toolManager, undefined, scopedToolContext(PROJECT_B, projectB.project.rootPath), bTool)).toBe("ask");
	});

	it("updates an existing project-local coder override rather than the server role", async () => {
		putRole(projectA.roleStore, { ...CODER, promptTemplate: "Project A coder.", toolPolicies: { [TOOL]: "ask" } });
		const serverFilesBefore = snapshotFiles(path.join(serverConfig, "roles"));
		const session = makeLiveSession("project-a-local-coder", PROJECT_A);
		seedSession(projectA, session);
		manager.sessions.set(session.id, session);

		await manager.grantToolPermission(session.id, TOOL, "group", GROUP, "persistent");

		expect(projectA.roleStore.getLocal("coder")?.promptTemplate).toBe("Project A coder.");
		expect(projectA.roleStore.getLocal("coder")?.toolPolicies?.[TOOL]).toBe("allow");
		expect(snapshotFiles(path.join(serverConfig, "roles")), "RC7_PROJECT_LOCAL_ROLE_UPDATE_LEAKED_TO_SERVER").toEqual(serverFilesBefore);
		expect(restartCaptures).toHaveLength(1);
	});

	it("keeps a marketplace role grant session-only and creates no role override", async () => {
		const serverFilesBefore = snapshotFiles(path.join(serverConfig, "roles"));
		const projectFilesBefore = snapshotFiles(path.join(projectA.project.rootPath, ".bobbit", "config", "roles"));
		const session = makeLiveSession("project-a-market-role", PROJECT_A, "readonly-scanner");
		seedSession(projectA, session);
		manager.sessions.set(session.id, session);

		const granted = await manager.grantToolPermission(session.id, TOOL, "group", GROUP, "persistent");

		expect(granted).toContain(TOOL);
		expect(manager.sessions.get(session.id).sessionOnlyGrantedTools).toContain(TOOL);
		expect(snapshotFiles(path.join(serverConfig, "roles")), "RC7_MARKET_ROLE_GRANT_CREATED_SERVER_OVERRIDE").toEqual(serverFilesBefore);
		expect(snapshotFiles(path.join(projectA.project.rootPath, ".bobbit", "config", "roles")), "RC7_MARKET_ROLE_GRANT_CREATED_PROJECT_OVERRIDE").toEqual(projectFilesBefore);
		expect(restartCaptures).toHaveLength(1);
		expect(restartCaptures[0].overrideAllowedTools).toContain(TOOL);
	});

	it("preserves projectless persistent grants through the server RoleManager", async () => {
		const session = makeLiveSession("server-coder", undefined);
		seedSession(serverContext, session);
		manager.sessions.set(session.id, session);

		await manager.grantToolPermission(session.id, "read", "tool", undefined, "persistent");

		expect(serverRoleStore.getLocal("coder")?.toolPolicies?.read, "RC7_PROJECTLESS_GRANT_DID_NOT_USE_SERVER_ROLE_MANAGER").toBe("allow");
		expect(projectA.roleStore.getLocal("coder")).toBeUndefined();
		expect(projectB.roleStore.getLocal("coder")?.toolPolicies?.read).toBeUndefined();
		expect(restartCaptures).toEqual([{ sessionId: session.id, overrideAllowedTools: undefined }]);
	});

	it("rejects stale group membership and resolves batched pending grants before restarting", async () => {
		const session = makeLiveSession("project-a-pending", PROJECT_A);
		seedSession(projectA, session);
		manager.sessions.set(session.id, session);

		const first = manager.requestToolGrant(session.id, TOOL, GROUP);
		const second = manager.requestToolGrant(session.id, TOOL, GROUP);
		const permissionId = manager.sessions.get(session.id).pendingGrantRequest.id;

		await expect(manager.grantToolPermission(session.id, TOOL, "group", "Wrong Group", "persistent", permissionId))
			.rejects.toThrow(/Ignored stale permission grant/);
		expect(manager.sessions.get(session.id).pendingGrantRequest.id).toBe(permissionId);
		expect(restartCaptures).toHaveLength(0);

		const granted = await manager.grantToolPermission(session.id, TOOL, "group", GROUP, "persistent", permissionId);
		expect(granted).toContain(TOOL);
		await expect(first).resolves.toMatchObject({ granted: true, tools: [TOOL], scope: "group", group: GROUP });
		await expect(second).resolves.toMatchObject({ granted: true, tools: [TOOL], scope: "group", group: GROUP });
		expect(manager.sessions.get(session.id).pendingGrantRequest).toBeUndefined();
		expect(restartCaptures, "pending guards must settle in-process before any restart").toHaveLength(0);
	});

	it("keeps an explicit empty persisted allowlist empty across the persistent-grant restart", async () => {
		const session = makeLiveSession("project-a-empty", PROJECT_A, "coder", []);
		seedSession(projectA, session, []);
		manager.sessions.set(session.id, session);

		await manager.grantToolPermission(session.id, TOOL, "group", GROUP, "persistent");

		expect(projectA.roleStore.getLocal("coder")?.toolPolicies?.[TOOL]).toBe("allow");
		expect(restartCaptures).toEqual([{ sessionId: session.id, overrideAllowedTools: [] }]);
		expect(manager.sessions.get(session.id).allowedTools, "RC7_EMPTY_ALLOWLIST_WIDENED_DURING_RESTART").toEqual([]);
	});
});
