import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { McpApprovalStore } from "../../../src/server/mcp/mcp-approval-store.js";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch } from "../../support/harnesses/integration/gateway/e2e-setup.js";
import type { GatewayFixture } from "../../support/harnesses/shared/gateway.js";
import { loadServerTestRuntime } from "../../support/harnesses/shared/server-runtime.js";
import {
	appendCount,
	startRecordingMcpServer,
	writeProjectMcpConfig,
	writeProjectMcpServers,
	SpawnRecordingMcpClient,
	type RecordingMcpServer,
} from "../../support/mcp-approval/gateway-mcp-fixtures.js";

type ServerStatus = {
	name: string;
	status: string;
	toolCount: number;
	tools: Array<{ name: string }>;
	approval: { required: boolean; state: string; fingerprint?: string };
	source: { sourceId: string; projectId?: string; projectName?: string; file: string };
	reviewConfig?: Record<string, unknown>;
	diagnostics?: Array<{ code: string }>;
};

type IsolatedMcpState = {
	root: string;
	approvalDir: string;
	store: McpApprovalStore;
	createdProjectIds: string[];
	cleanup(): Promise<void>;
};

async function isolateMcpRuntime(gateway: GatewayFixture, label: string): Promise<IsolatedMcpState> {
	const root = path.join(gateway.bobbitDir, `.mcp-approval-${label}-${randomUUID()}`);
	const approvalDir = path.join(root, "headquarters-state");
	mkdirSync(approvalDir, { recursive: true });
	const sessionManager = gateway.sessionManager as any;
	const savedDefault = sessionManager.mcpManager;
	const savedScoped = sessionManager.scopedMcpManagers;
	const savedStore = sessionManager.mcpApprovalStore;
	const store = new McpApprovalStore(approvalDir);
	const createdProjectIds: string[] = [];
	sessionManager.mcpManager = null;
	sessionManager.scopedMcpManagers = new Map<string, any>();
	sessionManager.mcpApprovalStore = store;
	sessionManager.refreshExternalMcpToolRegistrations();

	return {
		root,
		approvalDir,
		store,
		createdProjectIds,
		async cleanup() {
			for (const projectId of [...createdProjectIds].reverse()) {
				await gateway.api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
			}
			const owned = new Set<any>([
				...(sessionManager.mcpManager ? [sessionManager.mcpManager] : []),
				...sessionManager.scopedMcpManagers.values(),
			]);
			await Promise.allSettled([...owned].map(manager => manager.disconnectAll()));
			sessionManager.mcpManager = savedDefault;
			sessionManager.scopedMcpManagers = savedScoped;
			sessionManager.mcpApprovalStore = savedStore;
			sessionManager.refreshExternalMcpToolRegistrations();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function createProject(gateway: GatewayFixture, state: IsolatedMcpState, name: string): Promise<{ id: string; root: string }> {
	const root = path.join(state.root, name);
	mkdirSync(root, { recursive: true });
	const response = await gateway.api("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: root, acceptCanonical: true }),
	});
	expect(response.status).toBe(201);
	const project = await response.json() as { id: string };
	state.createdProjectIds.push(project.id);
	return { id: project.id, root };
}

async function statuses(projectId: string): Promise<ServerStatus[]> {
	const response = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
	expect(response.status).toBe(200);
	return response.json();
}

function named(all: ServerStatus[], name: string): ServerStatus {
	const status = all.find(entry => entry.name === name);
	expect(status, `missing MCP status for ${name}`).toBeDefined();
	return status!;
}

async function decide(
	viewProjectId: string,
	status: ServerStatus,
	decision: "approved" | "rejected",
	overrides: Partial<{ fingerprint: string; sourceProjectId: string; sourceId: string }> = {},
): Promise<Response> {
	return apiFetch(`/api/mcp-servers/${encodeURIComponent(status.name)}/approval?projectId=${encodeURIComponent(viewProjectId)}`, {
		method: "POST",
		body: JSON.stringify({
			decision,
			fingerprint: overrides.fingerprint ?? status.approval.fingerprint,
			sourceProjectId: overrides.sourceProjectId ?? status.source.projectId,
			sourceId: overrides.sourceId ?? status.source.sourceId,
		}),
	});
}

function rpcCount(server: RecordingMcpServer, method: string): number {
	return server.requests.filter(request => request.method === method).length;
}

async function installSpawnRecordingManager(
	gateway: GatewayFixture,
	project: { id: string; root: string },
	state: IsolatedMcpState,
	marker: string,
): Promise<any> {
	const { McpManager } = (await loadServerTestRuntime()).mcpManager;
	class SpawnRecordingManager extends McpManager {
		protected override _createClient(name: string): any {
			return new SpawnRecordingMcpClient(name, marker);
		}
	}
	const sessionManager = gateway.sessionManager as any;
	const manager = new SpawnRecordingManager(project.root, undefined, state.approvalDir, {
		projectId: project.id,
		projectName: path.basename(project.root),
		approvalStore: sessionManager.mcpApprovalStore,
		scopeKey: `project:${project.id}`,
	});
	sessionManager.scopedMcpManagers.set(`project:${project.id}`, manager);
	return manager;
}

async function setToolPolicy(projectId: string, serverName: string, policy: "never" | null): Promise<void> {
	const response = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(`mcp__${serverName}`)}?projectId=${encodeURIComponent(projectId)}`, {
		method: "PUT",
		body: JSON.stringify({ policy, projectId }),
	});
	expect(response.status).toBe(200);
}

test.describe("project MCP startup approval gateway boundary", () => {
	test("stdio stays unspawned until exact approval and decisions survive manager/store reconstruction", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "stdio");
		try {
			const project = await createProject(gateway, isolated, `mcp-stdio-${randomUUID().slice(0, 8)}`);
			const marker = path.join(isolated.root, "stdio-spawns.txt");
			const serverName = `stdio-${randomUUID().slice(0, 8)}`;
			const config = {
				command: "approval-boundary-fixture",
				args: ["--stdio"],
				env: { FIXTURE_SECRET: "must-not-cross-the-api", GENERATION: "one" },
			};
			writeProjectMcpConfig(project.root, serverName, config);
			await installSpawnRecordingManager(gateway, project, isolated, marker);

			let current = named(await statuses(project.id), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { required: true, state: "pending" } });
			expect(current.diagnostics).toContainEqual({ code: "MCP_APPROVAL_PENDING", message: "Server startup is awaiting approval." });
			expect(appendCount(marker)).toBe(0);
			expect(JSON.stringify(current)).not.toContain("must-not-cross-the-api");
			expect(current.reviewConfig?.env).toEqual({ FIXTURE_SECRET: "[redacted]", GENERATION: "[redacted]" });

			const restart = await apiFetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/restart?projectId=${encodeURIComponent(project.id)}`, { method: "POST" });
			expect(restart.status).toBe(200);
			expect((await restart.json()).approval.state).toBe("pending");
			expect(appendCount(marker)).toBe(0);

			let response = await decide(project.id, current, "rejected");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current.approval.state).toBe("rejected");
			expect(current.toolCount).toBe(0);
			expect(appendCount(marker)).toBe(0);

			await setToolPolicy(project.id, serverName, "never");
			response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(appendCount(marker)).toBe(1);

			const sessionManager = gateway.sessionManager as any;
			const firstManager = sessionManager.getMcpManager({ projectId: project.id });
			const firstClient = firstManager.clients.get(serverName);
			await firstManager.disconnectAll();
			sessionManager.scopedMcpManagers.delete(`project:${project.id}`);
			sessionManager.mcpApprovalStore = new McpApprovalStore(isolated.approvalDir);
			await installSpawnRecordingManager(gateway, project, isolated, marker);

			current = named(await statuses(project.id), serverName);
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(appendCount(marker)).toBe(2);
			expect(firstClient.connected).toBe(false);

			const reconstructedManager = sessionManager.getMcpManager({ projectId: project.id });
			const reconstructedClient = reconstructedManager.clients.get(serverName);
			writeProjectMcpConfig(project.root, serverName, { ...config, env: { ...config.env, GENERATION: "two" } });
			const staleIdentity = current;
			current = named(await statuses(project.id), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
			expect(reconstructedClient.connected).toBe(false);
			expect(appendCount(marker)).toBe(2);

			response = await decide(project.id, staleIdentity, "approved");
			expect(response.status).toBe(409);
			const stale = await response.json();
			expect(stale).toMatchObject({ code: "MCP_APPROVAL_STALE", server: { approval: { state: "changed" } } });
			expect(appendCount(marker)).toBe(2);

			response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current.approval.state).toBe("approved");
			expect(appendCount(marker)).toBe(3);

			const approvedManager = sessionManager.getMcpManager({ projectId: project.id });
			const approvedClient = approvedManager.clients.get(serverName);
			unlinkSync(path.join(project.root, ".mcp.json"));
			expect((await statuses(project.id)).some(server => server.name === serverName)).toBe(false);
			expect(approvedClient.connected).toBe(false);
			expect(approvedManager.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === serverName)).toBe(false);
			await setToolPolicy(project.id, serverName, null);
		} finally {
			await isolated.cleanup();
		}
	});

	test("remote requests are blocked while pending/rejected/changed and scoped approval is shared across managers", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "http");
		const introduced = await startRecordingMcpServer("introduced_probe");
		const primaryA = await startRecordingMcpServer("a_probe");
		const primaryB = await startRecordingMcpServer("b_probe");
		const changed = await startRecordingMcpServer("changed_probe");
		try {
			const projectA = await createProject(gateway, isolated, `mcp-source-a-${randomUUID().slice(0, 8)}`);
			const projectB = await createProject(gateway, isolated, `mcp-view-b-${randomUUID().slice(0, 8)}`);
			const introducedName = `introduced-${randomUUID().slice(0, 8)}`;
			const collidingName = `same-name-${randomUUID().slice(0, 8)}`;
			writeProjectMcpServers(projectA.root, {
				[introducedName]: { url: introduced.url, headers: { Authorization: "Bearer hidden-secret" } },
				[collidingName]: { url: primaryA.url },
			});
			writeProjectMcpConfig(projectB.root, collidingName, { url: primaryB.url });

			const statusesA = await statuses(projectA.id);
			const statusesB = await statuses(projectB.id);
			let fromB = named(statusesB, introducedName);
			expect(fromB.source).toMatchObject({ projectId: projectA.id, projectName: path.basename(projectA.root), file: ".mcp.json" });
			expect(named(statusesA, collidingName).source.projectId).toBe(projectA.id);
			expect(named(statusesB, collidingName).source.projectId).toBe(projectB.id);
			expect([introduced, primaryA, primaryB].flatMap(server => server.requests)).toHaveLength(0);
			expect(JSON.stringify(fromB)).not.toContain("hidden-secret");

			let response = await decide(projectB.id, fromB, "rejected");
			expect(response.status).toBe(200);
			fromB = (await response.json()).server;
			expect(fromB.approval.state).toBe("rejected");
			expect(introduced.requests).toHaveLength(0);

			const wrongSource = named(statusesB, collidingName);
			response = await decide(projectB.id, wrongSource, "approved", { sourceProjectId: projectA.id });
			expect(response.status).toBe(409);
			expect((await response.json()).code).toBe("MCP_APPROVAL_STALE");
			expect(primaryA.requests).toHaveLength(0);
			expect(primaryB.requests).toHaveLength(0);

			await setToolPolicy(projectB.id, introducedName, "never");
			response = await decide(projectB.id, fromB, "approved");
			expect(response.status).toBe(200);
			fromB = (await response.json()).server;
			expect(fromB).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(rpcCount(introduced, "initialize")).toBe(2);
			expect(rpcCount(introduced, "tools/list")).toBe(2);
			expect(primaryA.requests).toHaveLength(0);
			expect(primaryB.requests).toHaveLength(0);

			const sessionManager = gateway.sessionManager as any;
			const managerA = sessionManager.getMcpManager({ projectId: projectA.id });
			const managerB = sessionManager.getMcpManager({ projectId: projectB.id });
			const clients = [managerA.clients.get(introducedName), managerB.clients.get(introducedName)];
			const oldIdentity = fromB;
			writeProjectMcpServers(projectA.root, {
				[introducedName]: { url: changed.url, headers: { Authorization: "Bearer replacement-secret" } },
				[collidingName]: { url: primaryA.url },
			});

			response = await decide(projectB.id, oldIdentity, "approved");
			expect(response.status).toBe(409);
			expect(clients.every(client => client.connected === false)).toBe(true);
			expect(changed.requests).toHaveLength(0);
			fromB = named(await statuses(projectB.id), introducedName);
			expect(fromB).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });

			response = await decide(projectB.id, fromB, "approved");
			expect(response.status).toBe(200);
			fromB = (await response.json()).server;
			expect(fromB.approval.state).toBe("approved");
			expect(rpcCount(changed, "initialize")).toBe(2);
			expect(rpcCount(changed, "tools/list")).toBe(2);

			const worktreeRoot = path.join(isolated.root, "alternate-worktree");
			writeProjectMcpServers(worktreeRoot, {
				[introducedName]: { url: changed.url, headers: { Authorization: "Bearer replacement-secret" } },
				[collidingName]: { url: primaryA.url },
			});
			const { McpManager } = (await loadServerTestRuntime()).mcpManager;
			const worktreeManager = new McpManager(worktreeRoot, undefined, isolated.approvalDir, {
				projectId: projectA.id,
				projectName: path.basename(projectA.root),
				approvalStore: sessionManager.mcpApprovalStore,
			});
			try {
				await worktreeManager.connectAll();
				const worktreeStatus = named(worktreeManager.getServerStatuses() as unknown as ServerStatus[], introducedName);
				expect(worktreeStatus).toMatchObject({ status: "connected", approval: { state: "approved" } });
				expect(worktreeStatus.source.sourceId).toBe(fromB.source.sourceId);
				expect(worktreeStatus.approval.fingerprint).toBe(fromB.approval.fingerprint);
			} finally {
				await worktreeManager.disconnectAll();
			}

			const changedRequestCount = changed.requests.length;
			response = await decide(projectB.id, fromB, "rejected");
			expect(response.status).toBe(200);
			fromB = (await response.json()).server;
			expect(fromB).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "rejected" } });
			expect(changed.requests).toHaveLength(changedRequestCount);
			expect(managerA.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === introducedName)).toBe(false);
			expect(managerB.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === introducedName)).toBe(false);
			await setToolPolicy(projectB.id, introducedName, null);
		} finally {
			await Promise.allSettled([introduced.close(), primaryA.close(), primaryB.close(), changed.close()]);
			await isolated.cleanup();
		}
	});
});
