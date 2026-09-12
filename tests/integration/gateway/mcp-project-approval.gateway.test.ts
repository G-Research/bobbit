import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { McpApprovalStore } from "../../../src/server/mcp/mcp-approval-store.js";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	authenticatedMcpOperatorHeaders,
	authenticatedOperatorCookie,
	apiFetch,
	createMcpOperatorPairingCode,
	pairMcpOperatorBrowser,
	rawApiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
} from "../../support/harnesses/integration/gateway/e2e-setup.js";
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

type McpReviewOwner = { sessionId?: string; goalId?: string };

function mcpReviewParams(projectId: string, cwd?: string, owner: McpReviewOwner = {}): URLSearchParams {
	const params = new URLSearchParams({ projectId });
	if (cwd) params.set("cwd", cwd);
	if (owner.sessionId) params.set("sessionId", owner.sessionId);
	if (owner.goalId) params.set("goalId", owner.goalId);
	return params;
}

async function statuses(projectId: string, cwd?: string, owner: McpReviewOwner = {}): Promise<ServerStatus[]> {
	const params = mcpReviewParams(projectId, cwd, owner);
	params.set("ensure", "true");
	const response = await apiFetch(`/api/mcp-servers?${params.toString()}`);
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
	cwd?: string,
	owner: McpReviewOwner = {},
): Promise<Response> {
	const params = mcpReviewParams(viewProjectId, cwd, owner);
	return apiFetch(`/api/mcp-servers/${encodeURIComponent(status.name)}/approval?${params.toString()}`, {
		method: "POST",
		headers: await authenticatedMcpOperatorHeaders(),
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

async function seedOwnedSession(
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

async function installSharedOwnerManager(
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

async function setToolPolicy(projectId: string, serverName: string, policy: "never" | null): Promise<void> {
	const response = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(`mcp__${serverName}`)}?projectId=${encodeURIComponent(projectId)}`, {
		method: "PUT",
		body: JSON.stringify({ policy, projectId }),
	});
	expect(response.status).toBe(200);
}

test.describe("project MCP startup approval gateway boundary", () => {
	test("operator approval header is exposed only to an admitted browser origin", async ({ gateway }) => {
		const allowed = await fetch(`${gateway.baseURL}/api/mcp-servers/example/approval?projectId=headquarters`, {
			method: "OPTIONS",
			headers: {
				Origin: "http://127.0.0.1:5173",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "X-Bobbit-Mcp-Operator, Content-Type",
			},
		});
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-bobbit-mcp-operator");
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

		const rejected = await fetch(`${gateway.baseURL}/api/mcp-servers/example/approval?projectId=headquarters`, {
			method: "OPTIONS",
			headers: {
				Origin: "https://repository-controlled.invalid",
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "cors",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "X-Bobbit-Mcp-Operator, Content-Type",
			},
		});
		expect(rejected.status).toBe(403);
		expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
	});

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

			// The global admin bearer is available to direct agents and must not let
			// repository instructions authorize their own MCP process. Authorization
			// is checked before the body is parsed or any ledger/runtime mutation.
			const approvalPath = `/api/mcp-servers/${encodeURIComponent(serverName)}/approval?projectId=${encodeURIComponent(project.id)}`;
			const approvalBody = JSON.stringify({
				decision: "approved",
				fingerprint: current.approval.fingerprint,
				sourceProjectId: current.source.projectId,
				sourceId: current.source.sourceId,
			});
			const bearerOnly = await rawApiFetch(approvalPath, {
				method: "POST",
				body: approvalBody,
			});
			expect(bearerOnly.status).toBe(403);
			expect(await bearerOnly.json()).toMatchObject({ code: "MCP_APPROVAL_HUMAN_REQUIRED" });

			const genericCookie = await rawApiFetch(approvalPath, {
				method: "POST",
				headers: { Cookie: await authenticatedOperatorCookie() },
				body: approvalBody,
			});
			expect(genericCookie.status).toBe(403);
			expect(await genericCookie.json()).toMatchObject({ code: "MCP_APPROVAL_HUMAN_REQUIRED" });
			expect(existsSync(path.join(isolated.approvalDir, "mcp-server-approvals.json"))).toBe(false);
			current = named(await statuses(project.id), serverName);
			expect(current.approval.state).toBe("pending");
			expect(appendCount(marker)).toBe(0);

			const pairing = createMcpOperatorPairingCode();
			const wrongPairing = await rawApiFetch("/api/mcp-operator/pair", {
				method: "POST",
				body: JSON.stringify({ code: Buffer.alloc(32, 0x5a).toString("base64url") }),
			});
			expect(wrongPairing.status).toBe(403);
			expect(wrongPairing.headers.get("cache-control")).toBe("no-store");
			expect(await wrongPairing.json()).toMatchObject({ code: "MCP_OPERATOR_PAIRING_REQUIRED" });

			const firstCredential = await pairMcpOperatorBrowser(pairing.code);
			expect(firstCredential).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
			const replay = await rawApiFetch("/api/mcp-operator/pair", {
				method: "POST",
				body: JSON.stringify({ code: pairing.code }),
			});
			expect(replay.status).toBe(403);
			expect(replay.headers.get("cache-control")).toBe("no-store");
			expect(await replay.json()).toMatchObject({ code: "MCP_OPERATOR_PAIRING_REQUIRED" });

			const rotatedCredential = await pairMcpOperatorBrowser(createMcpOperatorPairingCode().code);
			expect(rotatedCredential).not.toBe(firstCredential);
			const revokedCredential = await rawApiFetch(approvalPath, {
				method: "POST",
				headers: { "X-Bobbit-Mcp-Operator": firstCredential },
				body: approvalBody,
			});
			expect(revokedCredential.status).toBe(403);
			expect(await revokedCredential.json()).toMatchObject({ code: "MCP_APPROVAL_HUMAN_REQUIRED" });
			expect(appendCount(marker)).toBe(0);

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

	test("SessionManager binds worktree discovery, reuses exact approval, and revokes changed or removed definitions", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "session-worktree");
		const rootServer = await startRecordingMcpServer("root_probe");
		const changedServer = await startRecordingMcpServer("changed_probe");
		try {
			const project = await createProject(gateway, isolated, `mcp-session-worktree-${randomUUID().slice(0, 8)}`);
			const worktreeRoot = path.join(project.root, "worktrees", "candidate");
			const serverName = `worktree-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: rootServer.url });

			let rootStatus = named(await statuses(project.id), serverName);
			let response = await decide(project.id, rootStatus, "approved");
			expect(response.status).toBe(200);
			rootStatus = (await response.json()).server;
			expect(rootStatus).toMatchObject({ status: "connected", approval: { state: "approved" } });

			writeProjectMcpConfig(worktreeRoot, serverName, { url: rootServer.url });
			const sessionManager = gateway.sessionManager as any;
			const firstSessionId = `worktree-owner-${randomUUID()}`;
			const secondSessionId = `worktree-borrower-${randomUUID()}`;
			sessionManager.sessions.set(firstSessionId, { id: firstSessionId, projectId: project.id, cwd: worktreeRoot });
			sessionManager.sessions.set(secondSessionId, { id: secondSessionId, projectId: project.id, cwd: worktreeRoot });
			const firstManager = await sessionManager.ensureMcpManagerForSession(firstSessionId);
			const secondManager = await sessionManager.ensureMcpManagerForSession(secondSessionId);
			expect(firstManager).toBe(secondManager);
			expect(firstManager).not.toBe(sessionManager.getMcpManager({ projectId: project.id }));
			expect(sessionManager.getMcpManagerForSession(firstSessionId)).toBe(firstManager);

			let worktreeStatus = named(await statuses(project.id, worktreeRoot), serverName);
			expect(worktreeStatus).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(worktreeStatus.source.sourceId).toBe(rootStatus.source.sourceId);
			expect(worktreeStatus.approval.fingerprint).toBe(rootStatus.approval.fingerprint);
			const ledger = JSON.parse(readFileSync(isolated.store.ledgerPath, "utf8")) as { decisions: unknown[] };
			expect(ledger.decisions).toHaveLength(1);

			const worktreeClient = firstManager.clients.get(serverName);
			const rootRequestCount = rootServer.requests.length;
			writeProjectMcpConfig(worktreeRoot, serverName, { url: changedServer.url });
			worktreeStatus = named(await statuses(project.id, worktreeRoot), serverName);
			expect(worktreeStatus).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
			expect(worktreeClient.connected).toBe(false);
			expect(rootServer.requests).toHaveLength(rootRequestCount);
			expect(changedServer.requests).toHaveLength(0);

			response = await decide(project.id, worktreeStatus, "approved", {}, worktreeRoot);
			expect(response.status).toBe(200);
			worktreeStatus = (await response.json()).server;
			expect(worktreeStatus).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(rpcCount(changedServer, "initialize")).toBe(1);
			const changedClient = firstManager.clients.get(serverName);

			unlinkSync(path.join(worktreeRoot, ".mcp.json"));
			expect((await statuses(project.id, worktreeRoot)).some(server => server.name === serverName)).toBe(false);
			expect(changedClient.connected).toBe(false);
			expect(named(await statuses(project.id), serverName).status).toBe("connected");

			sessionManager.sessions.delete(firstSessionId);
			await sessionManager.cleanupScopedMcpManagersForSessionScope({ projectId: project.id, cwd: worktreeRoot }, firstSessionId);
			expect(sessionManager.getMcpManager({ projectId: project.id, cwd: worktreeRoot })).toBe(firstManager);
			sessionManager.sessions.delete(secondSessionId);
			await sessionManager.cleanupScopedMcpManagersForSessionScope({ projectId: project.id, cwd: worktreeRoot }, secondSessionId);
			expect(sessionManager.getMcpManager({ projectId: project.id, cwd: worktreeRoot })).toBeNull();
		} finally {
			await Promise.allSettled([rootServer.close(), changedServer.close()]);
			await isolated.cleanup();
		}
	});

	test("external sibling worktree review requires an exact session owner and stays fail-closed", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "external-session-owner");
		const rootServer = await startRecordingMcpServer("root_probe");
		const worktreeServer = await startRecordingMcpServer("worktree_probe");
		const changedServer = await startRecordingMcpServer("changed_probe");
		let ownerSessionId: string | undefined;
		let foreignSessionId: string | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-external-owner-${randomUUID().slice(0, 8)}`);
			const foreignProject = await createProject(gateway, isolated, `mcp-external-foreign-${randomUUID().slice(0, 8)}`);
			const worktreeRoot = path.join(`${project.root}-wt`, "session", "external-owner");
			expect(path.relative(project.root, worktreeRoot).startsWith("..")).toBe(true);
			const serverName = `external-owner-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: rootServer.url, headers: { "X-Scope": "root" } });
			writeProjectMcpConfig(worktreeRoot, serverName, { url: worktreeServer.url, headers: { "X-Scope": "worktree" } });

			const owner = await seedOwnedSession(gateway, project, worktreeRoot);
			ownerSessionId = owner.id;
			const foreign = await seedOwnedSession(gateway, foreignProject, path.join(`${foreignProject.root}-wt`, "session", "foreign"));
			foreignSessionId = foreign.id;
			const sessionManager = gateway.sessionManager as any;
			const managerCountBeforeRejections = sessionManager.scopedMcpManagers.size;
			const encodedProject = encodeURIComponent(project.id);
			const encodedCwd = encodeURIComponent(worktreeRoot);
			const rejectedCases = [
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&ensure=true`, status: 422, code: "CWD_OUTSIDE_PROJECT" },
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&sessionId=bad%20owner&ensure=true`, status: 400, code: "MCP_REVIEW_SCOPE_INVALID" },
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&sessionId=${owner.id}&sessionId=${owner.id}&ensure=true`, status: 400, code: "MCP_REVIEW_SCOPE_INVALID" },
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&sessionId=${owner.id}&goalId=conflicting-owner&ensure=true`, status: 400, code: "MCP_REVIEW_SCOPE_INVALID" },
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&sessionId=missing-owner&ensure=true`, status: 422, code: "CWD_OUTSIDE_PROJECT" },
				{ query: `projectId=${encodedProject}&cwd=${encodedCwd}&sessionId=${foreign.id}&ensure=true`, status: 422, code: "CWD_OUTSIDE_PROJECT" },
			];
			const operatorHeaders = await authenticatedMcpOperatorHeaders();
			for (const rejected of rejectedCases) {
				for (const request of [
					{ path: `/api/mcp-servers?${rejected.query}`, init: undefined },
					{
						path: `/api/mcp-servers/${encodeURIComponent(serverName)}/approval?${rejected.query}`,
						init: {
							method: "POST",
							headers: operatorHeaders,
							body: JSON.stringify({
								decision: "approved",
								fingerprint: "unreachable",
								sourceProjectId: project.id,
								sourceId: "unreachable",
							}),
						},
					},
				] satisfies Array<{ path: string; init: RequestInit | undefined }>) {
					const response = await apiFetch(request.path, request.init);
					expect(response.status).toBe(rejected.status);
					expect(await response.json()).toMatchObject({ code: rejected.code });
					expect(sessionManager.getMcpManager({ projectId: project.id, cwd: worktreeRoot })).toBeNull();
					expect(sessionManager.scopedMcpManagers.size).toBe(managerCountBeforeRejections);
					expect([...rootServer.requests, ...worktreeServer.requests, ...changedServer.requests]).toHaveLength(0);
				}
			}

			let current = named(await statuses(project.id, worktreeRoot, { sessionId: owner.id }), serverName);
			expect(current).toMatchObject({
				status: "disconnected",
				toolCount: 0,
				approval: { state: "pending" },
				reviewConfig: { url: worktreeServer.url },
			});
			expect(worktreeServer.requests).toHaveLength(0);
			expect(rootServer.requests).toHaveLength(0);

			let response = await decide(project.id, current, "approved", {}, worktreeRoot, { sessionId: owner.id });
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(rpcCount(worktreeServer, "initialize")).toBe(1);
			expect(rootServer.requests).toHaveLength(0);
			expect(named(await statuses(project.id), serverName).approval.state).toBe("changed");

			const worktreeManager = sessionManager.getMcpManager({ projectId: project.id, cwd: worktreeRoot });
			const worktreeClient = worktreeManager.clients.get(serverName);
			writeProjectMcpConfig(worktreeRoot, serverName, { url: changedServer.url, headers: { "X-Scope": "changed" } });
			current = named(await statuses(project.id, worktreeRoot, { sessionId: owner.id }), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
			expect(worktreeClient.connected).toBe(false);
			expect(changedServer.requests).toHaveLength(0);
			expect(rootServer.requests).toHaveLength(0);
		} finally {
			if (ownerSessionId) await deleteSession(ownerSessionId).catch(() => undefined);
			if (foreignSessionId) await deleteSession(foreignSessionId).catch(() => undefined);
			await Promise.allSettled([rootServer.close(), worktreeServer.close(), changedServer.close()]);
			await isolated.cleanup();
		}
	});

	test("goal ownership authorizes only its external sibling worktree", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "external-goal-owner");
		const remote = await startRecordingMcpServer("goal_probe");
		let goalId: string | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-goal-owner-${randomUUID().slice(0, 8)}`);
			const worktreeRoot = path.join(`${project.root}-wt`, "goal", "external-owner");
			const serverName = `goal-owner-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(worktreeRoot, serverName, { url: remote.url });
			const goal = await createGoal({
				title: `MCP external owner ${randomUUID()}`,
				projectId: project.id,
				cwd: project.root,
				worktree: false,
				autoStartTeam: false,
			});
			goalId = String(goal.id);
			const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
			expect(goalStore.update(goalId, {
				cwd: worktreeRoot,
				worktreePath: worktreeRoot,
				repoPath: project.root,
				branch: "goal/mcp-external-owner",
				setupStatus: "ready",
			})).toBe(true);

			let current = named(await statuses(project.id, worktreeRoot, { goalId }), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "pending" } });
			expect(remote.requests).toHaveLength(0);
			const response = await decide(project.id, current, "approved", {}, worktreeRoot, { goalId });
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(rpcCount(remote, "initialize")).toBe(1);
		} finally {
			if (goalId) await deleteGoal(goalId).catch(() => undefined);
			await remote.close();
			await isolated.cleanup();
		}
	});

	test("sandbox session review maps its opaque owner to the authoritative host worktree", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "sandbox-host-worktree");
		const rootServer = await startRecordingMcpServer("root_probe");
		const hostServer = await startRecordingMcpServer("host_probe");
		let sessionId: string | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-sandbox-owner-${randomUUID().slice(0, 8)}`);
			const hostWorktree = path.join(`${project.root}-wt`, "session", "sandbox-owner");
			const serverName = `sandbox-owner-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: rootServer.url });
			writeProjectMcpConfig(hostWorktree, serverName, { url: hostServer.url });
			const owner = await seedOwnedSession(gateway, project, hostWorktree, { sandboxed: true });
			sessionId = owner.id;
			expect(owner.requestCwd).toMatch(/^\/workspace-wt\//);

			let current = named(await statuses(project.id, owner.requestCwd, { sessionId: owner.id }), serverName);
			expect(current).toMatchObject({
				status: "disconnected",
				approval: { state: "pending" },
				reviewConfig: { url: hostServer.url },
			});
			const sessionManager = gateway.sessionManager as any;
			const selected = sessionManager.getMcpManager({ projectId: project.id, cwd: hostWorktree });
			expect(selected).toBeTruthy();
			expect(sessionManager.getMcpManager({ projectId: project.id, cwd: owner.requestCwd })).toBeNull();
			expect(selected).not.toBe(sessionManager.getMcpManager({ projectId: project.id }));
			expect([...rootServer.requests, ...hostServer.requests]).toHaveLength(0);

			const response = await decide(project.id, current, "approved", {}, owner.requestCwd, { sessionId: owner.id });
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(rpcCount(hostServer, "initialize")).toBe(1);
			expect(rootServer.requests).toHaveLength(0);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			await Promise.allSettled([rootServer.close(), hostServer.close()]);
			await isolated.cleanup();
		}
	});

	test("a rejection reloads a worktree manager published while decision persistence is paused", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "deferred-decision-worktree");
		const remote = await startRecordingMcpServer("deferred_probe");
		const sessionManager = gateway.sessionManager as any;
		let sessionId: string | undefined;
		let viewManager: any;
		let originalDecideApproval: ((...args: any[]) => Promise<unknown>) | undefined;
		let releasePersistence: (() => void) | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-deferred-${randomUUID().slice(0, 8)}`);
			const worktreeRoot = path.join(project.root, "worktrees", "candidate");
			const serverName = `deferred-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: remote.url });
			writeProjectMcpConfig(worktreeRoot, serverName, { url: remote.url });

			let current = named(await statuses(project.id), serverName);
			let response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;

			viewManager = sessionManager.getMcpManager({ projectId: project.id });
			originalDecideApproval = viewManager.decideApproval.bind(viewManager);
			const persistenceReleased = new Promise<void>(resolve => { releasePersistence = resolve; });
			let persistencePaused!: () => void;
			const reachedPersistencePause = new Promise<void>(resolve => { persistencePaused = resolve; });
			viewManager.decideApproval = async (...args: any[]) => {
				persistencePaused();
				await persistenceReleased;
				return originalDecideApproval!(...args);
			};

			const decisionResponse = decide(project.id, current, "rejected");
			await reachedPersistencePause;
			sessionId = `deferred-worktree-${randomUUID()}`;
			sessionManager.sessions.set(sessionId, { id: sessionId, projectId: project.id, cwd: worktreeRoot });
			const worktreeManager = await sessionManager.ensureMcpManagerForSession(sessionId);
			const worktreeClient = worktreeManager.clients.get(serverName);
			const externalToolName = `mcp__${serverName}__deferred_probe`;
			expect(worktreeClient?.connected).toBe(true);
			expect(worktreeManager.getToolInfos().some((tool: any) => tool.name === externalToolName)).toBe(true);
			sessionManager.refreshExternalMcpToolRegistrations();

			releasePersistence!();
			response = await decisionResponse;

			expect(response.status).toBe(200);
			expect((await response.json()).server).toMatchObject({
				status: "disconnected",
				toolCount: 0,
				approval: { state: "rejected" },
			});
			expect(worktreeClient.connected).toBe(false);
			expect(worktreeManager.getToolInfos()).toEqual([]);
			const tools = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(tools.tools.some((tool: any) => tool.name === externalToolName)).toBe(false);
		} finally {
			releasePersistence?.();
			if (viewManager && originalDecideApproval) viewManager.decideApproval = originalDecideApproval;
			if (sessionId) {
				sessionManager.sessions.delete(sessionId);
				sessionManager.mcpSessionScopes.delete(sessionId);
			}
			await remote.close();
			await isolated.cleanup();
		}
	});

	test("an on-disk change blocks a cached remote tool call before periodic reconciliation", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "pre-call-freshness");
		const approvedServer = await startRecordingMcpServer("cached_probe");
		const changedServer = await startRecordingMcpServer("changed_probe");
		try {
			const project = await createProject(gateway, isolated, `mcp-pre-call-${randomUUID().slice(0, 8)}`);
			const serverName = `pre-call-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: approvedServer.url });

			let current = named(await statuses(project.id), serverName);
			const response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });

			const sessionManager = gateway.sessionManager as any;
			const manager = sessionManager.getMcpManager({ projectId: project.id });
			const approvedClient = manager.clients.get(serverName);
			const toolName = `mcp__${serverName}__cached_probe`;
			expect(manager.getToolRouteSnapshots().some((tool: any) => tool.name === toolName)).toBe(true);
			const approvedRequestCount = approvedServer.requests.length;
			expect(rpcCount(approvedServer, "tools/call")).toBe(0);

			writeProjectMcpConfig(project.root, serverName, { url: changedServer.url });
			await expect(manager.callTool(toolName, { secret: "must-not-be-sent" })).rejects.toThrow(
				`MCP server "${serverName}" is not approved to run`,
			);

			expect(approvedServer.requests).toHaveLength(approvedRequestCount);
			expect(rpcCount(approvedServer, "tools/call")).toBe(0);
			expect(changedServer.requests).toHaveLength(0);
			expect(approvedClient.connected).toBe(false);
			expect(manager.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === serverName)).toBe(false);
			current = named(manager.getServerStatuses(), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
		} finally {
			await Promise.allSettled([approvedServer.close(), changedServer.close()]);
			await isolated.cleanup();
		}
	});

	test("a forced reload changed during disconnect sends no initialize request to the stale replacement", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "pre-connect-disconnect-window");
		const approvedServer = await startRecordingMcpServer("approved_probe");
		const changedServer = await startRecordingMcpServer("changed_probe");
		try {
			const project = await createProject(gateway, isolated, `mcp-disconnect-window-${randomUUID().slice(0, 8)}`);
			const serverName = `disconnect-window-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, { url: approvedServer.url });
			let current = named(await statuses(project.id), serverName);
			const response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(rpcCount(approvedServer, "initialize")).toBe(1);

			const manager = (gateway.sessionManager as any).getMcpManager({ projectId: project.id });
			const oldClient = manager.clients.get(serverName);
			const originalDisconnect = oldClient.disconnect.bind(oldClient);
			let enteredDisconnect!: () => void;
			let releaseDisconnect!: () => void;
			const disconnectEntered = new Promise<void>((resolve) => { enteredDisconnect = resolve; });
			const disconnectGate = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
			oldClient.disconnect = async () => {
				await originalDisconnect();
				enteredDisconnect();
				await disconnectGate;
			};

			const forcedReload = manager.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
			await disconnectEntered;
			writeProjectMcpConfig(project.root, serverName, { url: changedServer.url });
			releaseDisconnect();
			await forcedReload;

			expect(rpcCount(approvedServer, "initialize")).toBe(1);
			expect(changedServer.requests).toHaveLength(0);
			expect(manager.getToolRouteSnapshots()).toEqual([]);
			current = named(manager.getServerStatuses(), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
		} finally {
			await Promise.allSettled([approvedServer.close(), changedServer.close()]);
			await isolated.cleanup();
		}
	});

	test("shared runtime owners advance one at a time without reporting the persisted decision as stale", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "shared-owner-decision");
		const remote = await startRecordingMcpServer("shared_owner_probe");
		try {
			const projectA = await createProject(gateway, isolated, `mcp-owner-a-${randomUUID().slice(0, 8)}`);
			const projectB = await createProject(gateway, isolated, `mcp-owner-b-${randomUUID().slice(0, 8)}`);
			const runtimeServerKey = `shared-runtime-${randomUUID().slice(0, 8)}`;
			await installSharedOwnerManager(gateway, projectA, [projectA, projectB], isolated, runtimeServerKey, remote.url);

			let current = named(await statuses(projectA.id), runtimeServerKey);
			expect(current).toMatchObject({
				status: "disconnected",
				approval: { state: "pending" },
				source: { projectId: projectA.id, sourceId: `project-pack:${projectA.id}` },
			});

			const ownerA = current;
			let response = await decide(projectA.id, current, "approved");
			expect(response.status).toBe(200);
			expect(isolated.store.classify({
				projectId: ownerA.source.projectId,
				sourceId: ownerA.source.sourceId,
				serverName: ownerA.name,
				trust: "approval-required",
				config: { url: remote.url },
			}).state).toBe("approved");
			current = (await response.json()).server;
			expect(current).toMatchObject({
				status: "disconnected",
				approval: { state: "pending" },
				source: { projectId: projectB.id, sourceId: `project-pack:${projectB.id}` },
			});
			expect(remote.requests).toHaveLength(0);

			response = await decide(projectA.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 2, approval: { state: "approved" } });
			expect(rpcCount(remote, "initialize")).toBe(1);
			expect(rpcCount(remote, "tools/list")).toBe(1);
		} finally {
			await remote.close();
			await isolated.cleanup();
		}
	});

	test("a change in the post-reload freshness window disconnects the approved runtime before returning stale", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "post-reload-stale");
		const approvedServer = await startRecordingMcpServer("post_reload_probe");
		const changedServer = await startRecordingMcpServer("changed_probe");
		try {
			const project = await createProject(gateway, isolated, `mcp-post-reload-${randomUUID().slice(0, 8)}`);
			const serverName = `post-reload-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(project.root, serverName, {
				url: approvedServer.url,
				headers: { Authorization: "Bearer initial-secret" },
			});

			let current = named(await statuses(project.id), serverName);
			let response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });

			const sessionManager = gateway.sessionManager as any;
			const manager = sessionManager.getMcpManager({ projectId: project.id });
			const approvedClient = manager.clients.get(serverName);
			expect(approvedClient?.connected).toBe(true);
			expect(manager.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === serverName)).toBe(true);
			const externalToolName = `mcp__${serverName}__post_reload_probe`;
			let tools = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(tools.tools.some((tool: any) => tool.name === externalToolName)).toBe(true);

			// Change the file only when SessionManager revalidates the exact decided
			// owner, after its first scoped reload, to exercise the final stale window.
			const originalIsApprovalIdentityCurrent = manager.isApprovalIdentityCurrent.bind(manager);
			let revalidationReads = 0;
			manager.isApprovalIdentityCurrent = (identity: unknown) => {
				revalidationReads += 1;
				writeProjectMcpConfig(project.root, serverName, {
					url: changedServer.url,
					headers: { Authorization: "Bearer replacement-secret" },
				});
				return originalIsApprovalIdentityCurrent(identity);
			};
			const approvedRequestCount = approvedServer.requests.length;
			try {
				response = await decide(project.id, current, "approved");
			} finally {
				manager.isApprovalIdentityCurrent = originalIsApprovalIdentityCurrent;
			}

			expect(revalidationReads).toBe(1);
			expect(response.status).toBe(409);
			const stale = await response.json();
			expect(stale).toMatchObject({
				code: "MCP_APPROVAL_STALE",
				server: {
					status: "disconnected",
					toolCount: 0,
					approval: { state: "changed" },
					reviewConfig: { headers: { Authorization: "[redacted]" } },
				},
			});
			expect(JSON.stringify(stale)).not.toContain("replacement-secret");
			expect(approvedClient.connected).toBe(false);
			expect(approvedServer.requests).toHaveLength(approvedRequestCount);
			expect(changedServer.requests).toHaveLength(0);
			expect(manager.getToolRouteSnapshots().some((tool: any) => tool.runtimeServerKey === serverName)).toBe(false);
			expect(manager.getToolInfos().some((tool: any) => tool.name === externalToolName)).toBe(false);
			tools = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(tools.tools.some((tool: any) => tool.name === externalToolName)).toBe(false);
		} finally {
			await Promise.allSettled([approvedServer.close(), changedServer.close()]);
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
