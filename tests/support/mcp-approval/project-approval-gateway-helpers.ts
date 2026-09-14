import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { McpApprovalStore } from "../../../src/server/mcp/mcp-approval-store.js";
import { expect } from "../harnesses/integration/gateway/in-process-harness.js";
import { apiFetch, createSession } from "../harnesses/integration/gateway/e2e-setup.js";
import type { GatewayFixture } from "../harnesses/shared/gateway.js";
import { loadServerTestRuntime } from "../harnesses/shared/server-runtime.js";
import {
	SpawnRecordingMcpClient,
	type RecordingMcpServer,
} from "./gateway-mcp-fixtures.js";

export type ServerStatus = {
	name: string;
	status: string;
	toolCount: number;
	tools: Array<{ name: string }>;
	approval: { required: boolean; state: string; fingerprint?: string };
	source: { sourceId: string; projectId?: string; projectName?: string; file: string };
	reviewConfig?: Record<string, unknown>;
	diagnostics?: Array<{ code: string }>;
};

export type IsolatedMcpState = {
	root: string;
	approvalDir: string;
	store: McpApprovalStore;
	createdProjectIds: string[];
	cleanup(): Promise<void>;
};

export async function isolateMcpRuntime(gateway: GatewayFixture, label: string): Promise<IsolatedMcpState> {
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

export async function createProject(gateway: GatewayFixture, state: IsolatedMcpState, name: string): Promise<{ id: string; root: string }> {
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

export type McpReviewOwner = { sessionId?: string; goalId?: string };

export function mcpReviewParams(projectId: string, cwd?: string, owner: McpReviewOwner = {}): URLSearchParams {
	const params = new URLSearchParams({ projectId });
	if (cwd) params.set("cwd", cwd);
	if (owner.sessionId) params.set("sessionId", owner.sessionId);
	if (owner.goalId) params.set("goalId", owner.goalId);
	return params;
}

export async function statuses(projectId: string, cwd?: string, owner: McpReviewOwner = {}): Promise<ServerStatus[]> {
	const params = mcpReviewParams(projectId, cwd, owner);
	params.set("ensure", "true");
	const response = await apiFetch(`/api/mcp-servers?${params.toString()}`);
	expect(response.status).toBe(200);
	return response.json();
}

export function named(all: ServerStatus[], name: string): ServerStatus {
	const status = all.find(entry => entry.name === name);
	expect(status, `missing MCP status for ${name}`).toBeDefined();
	return status!;
}

export async function decide(
	viewProjectId: string,
	status: ServerStatus,
	decision: "approved" | "rejected",
	overrides: Partial<{ fingerprint: string; sourceProjectId: string; sourceId: string }> = {},
	cwd?: string,
	owner: McpReviewOwner = {},
): Promise<Response> {
	const params = mcpReviewParams(viewProjectId, cwd, owner);
	return apiFetch(`/api/mcp-servers/${encodeURIComponent(status.name)}/approval?${params.toString()}`, {
		method: "POST",
		body: JSON.stringify({
			decision,
			fingerprint: overrides.fingerprint ?? status.approval.fingerprint,
			sourceProjectId: overrides.sourceProjectId ?? status.source.projectId,
			sourceId: overrides.sourceId ?? status.source.sourceId,
		}),
	});
}

export function rpcCount(server: RecordingMcpServer, method: string): number {
	return server.requests.filter(request => request.method === method).length;
}

export async function seedOwnedSession(
	gateway: GatewayFixture,
	project: { id: string; root: string },
	hostWorktree: string,
	opts: { sandboxed?: boolean } = {},
): Promise<{ id: string; requestCwd: string }> {
	const id = await createSession({ projectId: project.id, cwd: project.root });
	const branch = `session/mcp-owner-${randomUUID().slice(0, 8)}`;
	const requestCwd = opts.sandboxed ? `/workspace-wt/${branch}` : hostWorktree;
	const coordinates = {
		cwd: requestCwd,
		worktreePath: hostWorktree,
		repoPath: project.root,
		branch,
		...(opts.sandboxed ? { sandboxed: true, containerId: `mcp-owner-${randomUUID()}` } : {}),
	};
	const sessionManager = gateway.sessionManager as any;
	const live = sessionManager.getSession(id);
	const persisted = sessionManager.getPersistedSession(id);
	expect(live, "owned MCP fixture session must be live").toBeTruthy();
	expect(persisted?.projectId, "owned MCP fixture session must be persisted").toBe(project.id);
	Object.assign(live, coordinates);
	sessionManager.getSessionStore(project.id).update(id, coordinates);
	sessionManager.mcpSessionScopes.delete(id);
	expect(sessionManager.getPersistedSession(id)).toMatchObject({ projectId: project.id, ...coordinates });
	return { id, requestCwd };
}

export async function installSpawnRecordingManager(
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

export async function installSharedOwnerManager(
	gateway: GatewayFixture,
	viewProject: { id: string; root: string },
	owners: Array<{ id: string; root: string }>,
	state: IsolatedMcpState,
	runtimeServerKey: string,
	url: string,
): Promise<any> {
	const { McpManager } = (await loadServerTestRuntime()).mcpManager;
	const config = { url };
	const manager = new McpManager(viewProject.root, undefined, state.approvalDir, {
		projectId: viewProject.id,
		projectName: path.basename(viewProject.root),
		approvalStore: (gateway.sessionManager as any).mcpApprovalStore,
		scopeKey: `project:${viewProject.id}`,
		marketplaceResolver: () => owners.map((owner, index) => ({
			listName: `owner-${index}`,
			serverName: `owner-${index}`,
			runtimeServerKey,
			contributionId: `project-owner:${owner.id}`,
			config,
			origin: {
				scope: "project",
				authority: "project",
				trust: "approval-required",
				projectId: owner.id,
				projectName: path.basename(owner.root),
				sourceId: `project-pack:${owner.id}`,
				file: `.bobbit/config/packs/owner-${index}/mcp/shared.yaml`,
			},
		})),
	});
	(gateway.sessionManager as any).scopedMcpManagers.set(`project:${viewProject.id}`, manager);
	return manager;
}

export async function setToolPolicy(projectId: string, serverName: string, policy: "never" | null): Promise<void> {
	const response = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(`mcp__${serverName}`)}?projectId=${encodeURIComponent(projectId)}`, {
		method: "PUT",
		body: JSON.stringify({ policy, projectId }),
	});
	expect(response.status).toBe(200);
}
