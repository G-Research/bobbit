import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	deleteSession,
} from "../../support/harnesses/integration/gateway/e2e-setup.js";
import { loadServerTestRuntime } from "../../support/harnesses/shared/server-runtime.js";
import {
	startRecordingMcpServer,
	writeProjectMcpConfig,
	writeProjectMcpServers,
} from "../../support/mcp-approval/gateway-mcp-fixtures.js";
import {
	createProject,
	decide,
	installSharedOwnerManager,
	isolateMcpRuntime,
	named,
	rpcCount,
	seedOwnedSession,
	setToolPolicy,
	statuses,
	type ServerStatus,
} from "../../support/mcp-approval/project-approval-gateway-helpers.js";

test.describe("project MCP approval scope and owner boundary", () => {
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
			for (const rejected of rejectedCases) {
				for (const request of [
					{ path: `/api/mcp-servers?${rejected.query}`, init: undefined },
					{
						path: `/api/mcp-servers/${encodeURIComponent(serverName)}/approval?${rejected.query}`,
						init: {
							method: "POST",
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
