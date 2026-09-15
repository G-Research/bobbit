import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { McpApprovalStore } from "../../../src/server/mcp/mcp-approval-store.js";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	authenticatedOperatorCookie,
	apiFetch,
} from "../../support/harnesses/integration/gateway/e2e-setup.js";
import { bootGateway, type RunningGateway } from "../../support/helpers/integration/gateway/base-path-gateway-fixture.js";
import {
	appendCount,
	startRecordingMcpServer,
	writeProjectMcpConfig,
	writeProjectMcpServers,
} from "../../support/mcp-approval/gateway-mcp-fixtures.js";
import {
	createProject,
	decide,
	installSpawnRecordingManager,
	isolateMcpRuntime,
	named,
	rpcCount,
	setToolPolicy,
	statuses,
	type ServerStatus,
} from "../../support/mcp-approval/project-approval-gateway-helpers.js";

test.describe("project MCP startup approval gateway boundary", () => {
	test("obsolete MCP operator headers are not admitted by CORS", async ({ gateway }) => {
		const standard = await fetch(`${gateway.baseURL}/api/mcp-servers/example/approval?projectId=headquarters`, {
			method: "OPTIONS",
			headers: {
				Origin: "http://127.0.0.1:5173",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "Authorization, Content-Type",
			},
		});
		expect(standard.status).toBe(204);
		expect(standard.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
		expect(standard.headers.get("access-control-allow-credentials")).toBeNull();

		const obsolete = await fetch(`${gateway.baseURL}/api/mcp-servers/example/approval?projectId=headquarters`, {
			method: "OPTIONS",
			headers: {
				Origin: "http://127.0.0.1:5173",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "X-Bobbit-Mcp-Operator, Content-Type",
			},
		});
		expect(obsolete.status).toBe(403);
		expect(obsolete.headers.get("access-control-allow-origin")).toBeNull();
		expect(obsolete.headers.get("access-control-allow-headers")).toBeNull();
	});

	test("trusted-local gateway authentication can approve an exact project MCP definition", async ({ gateway }) => {
		const remote = await startRecordingMcpServer("trusted_local_probe");
		let local: RunningGateway | undefined;
		try {
			// execGh still follows the latest gateway constructed in this process. Reuse
			// the fork gateway runner so this nested auth fixture cannot retarget later
			// shared-gateway route tests away from their injected command seam.
			local = await bootGateway("", "127.0.0.1", false, {
				serveStatic: false,
				commandRunner: (gateway.sessionManager as any).commandRunner,
			});
			expect(local.gateway.trustedLocal).toBe(true);
			const projectRoot = path.join(local.root, "trusted-local-project");
			mkdirSync(projectRoot, { recursive: true });
			const created = await fetch(`${local.baseUrl}/api/projects`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "trusted-local-project", rootPath: projectRoot, acceptCanonical: true }),
			});
			expect(created.status).toBe(201);
			const project = await created.json() as { id: string };
			const serverName = `trusted-local-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(projectRoot, serverName, { url: remote.url });

			const listed = await fetch(`${local.baseUrl}/api/mcp-servers?projectId=${encodeURIComponent(project.id)}&ensure=true`);
			expect(listed.status).toBe(200);
			const pending = named(await listed.json() as ServerStatus[], serverName);
			expect(pending).toMatchObject({ status: "disconnected", approval: { state: "pending" } });
			expect(remote.requests).toHaveLength(0);

			// A sandbox credential remains scoped even when the actual peer is trusted
			// loopback. It must reach the global default-deny guard rather than inherit
			// the credential-free local authority and enter the approval handler.
			const sandboxTokenStore = (local.gateway.sessionManager as any).sandboxTokenStore as {
				register(projectId: string): string;
				remove(projectId: string): void;
			};
			const sandboxToken = sandboxTokenStore.register(project.id);
			try {
				const sandboxDecision = await fetch(`${local.baseUrl}/api/mcp-servers/${encodeURIComponent(serverName)}/approval?projectId=${encodeURIComponent(project.id)}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${sandboxToken}`,
						"Content-Type": "application/json",
					},
					body: "{not-json",
				});
				expect(sandboxDecision.status).toBe(403);
				expect(await sandboxDecision.json()).toMatchObject({ error: "Forbidden: sandbox token cannot access this endpoint" });
				expect(remote.requests).toHaveLength(0);
			} finally {
				sandboxTokenStore.remove(project.id);
			}

			const decision = await fetch(`${local.baseUrl}/api/mcp-servers/${encodeURIComponent(serverName)}/approval?projectId=${encodeURIComponent(project.id)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					decision: "approved",
					fingerprint: pending.approval.fingerprint,
					sourceProjectId: pending.source.projectId,
					sourceId: pending.source.sourceId,
				}),
			});
			expect(decision.status).toBe(200);
			expect((await decision.json()).server).toMatchObject({
				status: "connected",
				toolCount: 1,
				approval: { state: "approved" },
			});
			expect(rpcCount(remote, "initialize")).toBe(1);
		} finally {
			await local?.shutdown();
			await remote.close();
		}
	});

	test("a sandbox-scoped token is denied before body parsing, manager creation, ledger mutation, spawn, or network activity", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "sandbox-pre-handler");
		const remote = await startRecordingMcpServer("sandbox_probe");
		let sandboxProjectId: string | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-sandbox-denial-${randomUUID().slice(0, 8)}`);
			sandboxProjectId = project.id;
			const marker = path.join(isolated.root, "sandbox-spawns.txt");
			const stdioName = `sandbox-stdio-${randomUUID().slice(0, 8)}`;
			const remoteName = `sandbox-remote-${randomUUID().slice(0, 8)}`;
			writeProjectMcpServers(project.root, {
				[stdioName]: { command: "must-not-spawn", args: [marker] },
				[remoteName]: { url: remote.url },
			});

			const sessionManager = gateway.sessionManager as any;
			expect(sessionManager.getMcpManager({ projectId: project.id })).toBeNull();
			expect(existsSync(path.join(isolated.approvalDir, "mcp-server-approvals.json"))).toBe(false);
			const sandboxToken = sessionManager.sandboxTokenStore.register(project.id);

			const response = await fetch(`${gateway.baseURL}/api/mcp-servers/${encodeURIComponent(stdioName)}/approval?projectId=${encodeURIComponent(project.id)}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${sandboxToken}`,
					"Content-Type": "application/json",
				},
				// If route dispatch or JSON parsing occurs this is a 400, not the
				// pre-handler sandbox denial asserted below.
				body: "{not-json",
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ error: "Forbidden: sandbox token cannot access this endpoint" });
			expect(sessionManager.getMcpManager({ projectId: project.id })).toBeNull();
			expect(existsSync(path.join(isolated.approvalDir, "mcp-server-approvals.json"))).toBe(false);
			expect(appendCount(marker)).toBe(0);
			expect(remote.requests).toHaveLength(0);
		} finally {
			if (sandboxProjectId) (gateway.sessionManager as any).sandboxTokenStore.remove(sandboxProjectId);
			await remote.close();
			await isolated.cleanup();
		}
	});

	test("stdio stays unspawned until exact gateway-authenticated approval and decisions survive manager/store reconstruction", async ({ gateway }) => {
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

			const approvalPath = `/api/mcp-servers/${encodeURIComponent(serverName)}/approval?projectId=${encodeURIComponent(project.id)}`;
			const approvalRequest = (decision: "approved" | "rejected") => JSON.stringify({
				decision,
				fingerprint: current.approval.fingerprint,
				sourceProjectId: current.source.projectId,
				sourceId: current.source.sourceId,
			});

			const unauthenticated = await fetch(`${gateway.baseURL}${approvalPath}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: approvalRequest("approved"),
			});
			expect(unauthenticated.status).toBe(401);

			const obsoleteHeaderOnly = await fetch(`${gateway.baseURL}${approvalPath}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Bobbit-Mcp-Operator": "obsolete-credential-must-not-authenticate",
				},
				body: approvalRequest("approved"),
			});
			expect(obsoleteHeaderOnly.status).toBe(401);
			expect(existsSync(path.join(isolated.approvalDir, "mcp-server-approvals.json"))).toBe(false);
			current = named(await statuses(project.id), serverName);
			expect(current.approval.state).toBe("pending");
			expect(appendCount(marker)).toBe(0);

			const restart = await apiFetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/restart?projectId=${encodeURIComponent(project.id)}`, { method: "POST" });
			expect(restart.status).toBe(200);
			expect((await restart.json()).approval.state).toBe("pending");
			expect(appendCount(marker)).toBe(0);

			const cookieApproval = await fetch(`${gateway.baseURL}${approvalPath}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: await authenticatedOperatorCookie(),
				},
				body: approvalRequest("approved"),
			});
			expect(cookieApproval.status).toBe(200);
			current = (await cookieApproval.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(appendCount(marker)).toBe(1);

			let response = await decide(project.id, current, "rejected");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "rejected" } });
			expect(appendCount(marker)).toBe(1);

			await setToolPolicy(project.id, serverName, "never");
			response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(appendCount(marker)).toBe(2);

			const sessionManager = gateway.sessionManager as any;
			const firstManager = sessionManager.getMcpManager({ projectId: project.id });
			const firstClient = firstManager.clients.get(serverName);
			await firstManager.disconnectAll();
			sessionManager.scopedMcpManagers.delete(`project:${project.id}`);
			sessionManager.mcpApprovalStore = new McpApprovalStore(isolated.approvalDir);
			await installSpawnRecordingManager(gateway, project, isolated, marker);

			current = named(await statuses(project.id), serverName);
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(appendCount(marker)).toBe(3);
			expect(firstClient.connected).toBe(false);

			const reconstructedManager = sessionManager.getMcpManager({ projectId: project.id });
			const reconstructedClient = reconstructedManager.clients.get(serverName);
			writeProjectMcpConfig(project.root, serverName, { ...config, env: { ...config.env, GENERATION: "two" } });
			const staleIdentity = current;
			current = named(await statuses(project.id), serverName);
			expect(current).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
			expect(reconstructedClient.connected).toBe(false);
			expect(appendCount(marker)).toBe(3);

			response = await decide(project.id, staleIdentity, "approved");
			expect(response.status).toBe(409);
			const stale = await response.json();
			expect(stale).toMatchObject({ code: "MCP_APPROVAL_STALE", server: { approval: { state: "changed" } } });
			expect(appendCount(marker)).toBe(3);

			response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current.approval.state).toBe("approved");
			expect(appendCount(marker)).toBe(4);

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

	test("a new session and tools API cannot publish cached routes after an on-disk change", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "pre-publication-freshness");
		const approvedServer = await startRecordingMcpServer("published_probe");
		const changedServer = await startRecordingMcpServer("replacement_probe");
		let sessionId: string | undefined;
		try {
			const project = await createProject(gateway, isolated, `mcp-pre-publish-${randomUUID().slice(0, 8)}`);
			const serverName = `pre-publish-${randomUUID().slice(0, 8)}`;
			const toolName = `mcp__${serverName}__published_probe`;
			writeProjectMcpConfig(project.root, serverName, { url: approvedServer.url });

			let current = named(await statuses(project.id), serverName);
			const response = await decide(project.id, current, "approved");
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });

			const sessionManager = gateway.sessionManager as any;
			const manager = sessionManager.getMcpManager({ projectId: project.id });
			const firstApprovedClient = manager.clients.get(serverName);
			sessionManager.refreshExternalMcpToolRegistrations();
			expect(sessionManager.toolManager.getAvailableTools().some((tool: any) => tool.name === toolName)).toBe(true);
			let approvedRequestCount = approvedServer.requests.length;

			// The catalogue route must initiate reconciliation itself; no call, timer,
			// status read, or explicit manager reload occurs after this edit.
			writeProjectMcpConfig(project.root, serverName, { url: changedServer.url });
			const tools = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(tools.tools.some((tool: any) => tool.name === toolName)).toBe(false);
			expect(firstApprovedClient.connected).toBe(false);
			expect(approvedServer.requests).toHaveLength(approvedRequestCount);
			expect(changedServer.requests).toHaveLength(0);

			// Reintroducing the exact approved definition reconnects through the normal
			// lifecycle, then a new session must independently close the same window.
			writeProjectMcpConfig(project.root, serverName, { url: approvedServer.url });
			await manager.reloadDiscoveredServers({ timeoutMs: 0 });
			const secondApprovedClient = manager.clients.get(serverName);
			expect(secondApprovedClient?.connected).toBe(true);
			expect(manager.getToolInfos().some((tool: any) => tool.name === toolName)).toBe(true);
			approvedRequestCount = approvedServer.requests.length;

			writeProjectMcpConfig(project.root, serverName, { url: changedServer.url });
			sessionId = `new-session-${randomUUID().slice(0, 8)}`;
			sessionManager.sessions.set(sessionId, { id: sessionId, projectId: project.id, cwd: project.root });
			const bound = await sessionManager.ensureMcpManagerForSession(sessionId);
			expect(bound).toBe(manager);
			expect(manager.getToolInfos()).toEqual([]);
			expect(sessionManager.toolManager.getAvailableTools().some((tool: any) => tool.name === toolName)).toBe(false);

			const activation = sessionManager.buildToolActivationArgs(
				sessionId,
				undefined,
				undefined,
				project.root,
				project.id,
			);
			expect(activation.args.some((arg: string) => arg.includes("mcp-extensions"))).toBe(false);
			expect(secondApprovedClient.connected).toBe(false);
			expect(approvedServer.requests).toHaveLength(approvedRequestCount);
			expect(rpcCount(approvedServer, "tools/call")).toBe(0);
			expect(changedServer.requests).toHaveLength(0);
		} finally {
			if (sessionId) {
				const sessionManager = gateway.sessionManager as any;
				sessionManager.sessions.delete(sessionId);
				sessionManager.mcpSessionScopes.delete(sessionId);
			}
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
});
