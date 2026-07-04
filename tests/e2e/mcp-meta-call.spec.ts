/**
 * API E2E tests for MCP meta-tool aggregation (design §8.4).
 *
 * Covers:
 *   1. GET /api/mcp-servers — structured server list shape.
 *   2. POST /api/internal/mcp-describe — auth header enforcement.
 *   3. POST /api/internal/mcp-describe — unknown server → 503.
 *   4. POST /api/internal/mcp-describe — happy path with stub McpManager
 *      seeded directly into sessionManager.
 *   5. POST /api/internal/mcp-call — `never` policy enforcement (Layer B).
 *
 * The harness boots with BOBBIT_SKIP_MCP=1 so no real MCP subprocesses
 * are spawned. We construct a real McpManager and seed its private state
 * (clients/toolDefs/configs) — mirrors `tests/mcp-failure-isolation.test.ts`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, base, readE2EToken, createSession, defaultProjectId } from "./e2e-setup.js";
import path from "node:path";
import type { GatewayInfo } from "./in-process-harness.js";

// ─── Stub MCP plumbing ─────────────────────────────────────────────────

/** Minimal stub matching the surface of McpClient used by McpManager. */
class FakeMcpClient {
	connected = false;
	constructor(public name: string) {}
	async connect(): Promise<void> { this.connected = true; }
	async disconnect(): Promise<void> { this.connected = false; }
	async listTools(): Promise<unknown[]> { return []; }
	async callTool(_t: string, _a: Record<string, unknown>): Promise<unknown> {
		return { content: [{ type: "text", text: "stub" }] };
	}
}

const STUB_OPS = [
	{
		name: "echo",
		description: "Echo a message back.",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
	},
	{
		name: "add",
		description: "Add two numbers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

/**
 * Seed a fake McpManager onto the live sessionManager so HTTP routes that
 * call sessionManager.getMcpManager() see a connected "fake-server" with two
 * known operations. Returns the manager so the test can clear state in
 * teardown.
 */
async function makeFakeMcpManager(
	gw: GatewayInfo,
	serverName = "fake-server",
	opts?: Record<string, unknown>,
	toolDefs = STUB_OPS,
	activeSubNamespaces?: string[],
) {
	const { McpManager } = await import("../../dist/server/mcp/mcp-manager.js");
	const mgr = new (McpManager as any)(gw.bobbitDir, undefined, undefined, opts);
	const client = new FakeMcpClient(serverName);
	client.connected = true;
	const config = { command: "stub" };
	(mgr as any).clients.set(serverName, client);
	(mgr as any).toolDefs.set(serverName, toolDefs);
	(mgr as any).configs.set(serverName, config);
	if (activeSubNamespaces) {
		(mgr as any).connectionGroups.set(serverName, {
			serverName,
			config,
			ownerContributions: [],
			activeSubNamespaces: new Set(activeSubNamespaces),
		});
	}
	return mgr;
}

async function seedFakeMcpManager(gw: GatewayInfo, serverName = "fake-server") {
	const mgr = await makeFakeMcpManager(gw, serverName);
	(gw.sessionManager as any).mcpManager = mgr;
	return mgr;
}

async function seedFakeScopedMcpManager(
	gw: GatewayInfo,
	projectId: string,
	serverName = "fake-server",
	toolDefs = STUB_OPS,
	activeSubNamespaces?: string[],
) {
	const scopeKey = `project:${projectId}`;
	const mgr = await makeFakeMcpManager(gw, serverName, { projectId, scopeKey }, toolDefs, activeSubNamespaces);
	(gw.sessionManager as any).scopedMcpManagers.set(scopeKey, mgr);
	return mgr;
}

async function seedFakeGatewayRuntimeMcpManager(gw: GatewayInfo, projectId?: string) {
	const { McpManager } = await import("../../dist/server/mcp/mcp-manager.js");
	const scopeKey = projectId ? `project:${projectId}` : undefined;
	const mgr = new (McpManager as any)(gw.bobbitDir, undefined, undefined, projectId ? { projectId, scopeKey } : undefined);
	const makeGroup = (runtimeServerKey: string, contributionId: string, url: string) => {
		const config = { url };
		return {
			serverName: runtimeServerKey,
			runtimeServerKey,
			config,
			ownerContributions: [{
				listName: contributionId,
				serverName: "gr",
				runtimeServerKey,
				contributionId,
				subNamespace: "jira",
				config,
				origin: { scope: "project", packName: contributionId },
			}],
			activeSubNamespaces: new Set(["jira"]),
		};
	};
	for (const [runtimeServerKey, contributionId, url] of [
		["gw-a-gr", "first-contribution", "https://gateway-a.test/mcp"],
		["gw-b-gr", "second-contribution", "https://gateway-b.test/mcp"],
	] as const) {
		const client = new FakeMcpClient(runtimeServerKey);
		client.connected = true;
		const group = makeGroup(runtimeServerKey, contributionId, url);
		(mgr as any).clients.set(runtimeServerKey, client);
		(mgr as any).toolDefs.set(runtimeServerKey, [{
			name: "jira__search",
			description: `${contributionId} search`,
			inputSchema: { type: "object", properties: { q: { type: "string" } } },
		}]);
		(mgr as any).configs.set(runtimeServerKey, group.config);
		(mgr as any).discoveredConnectionGroups.set(runtimeServerKey, group);
		(mgr as any).connectionGroups.set(runtimeServerKey, group);
	}
	if (scopeKey) {
		(gw.sessionManager as any).scopedMcpManagers.set(scopeKey, mgr);
	} else {
		(gw.sessionManager as any).mcpManager = mgr;
	}
	return mgr;
}

function clearFakeMcpManager(gw: GatewayInfo) {
	(gw.sessionManager as any).mcpManager = null;
	(gw.sessionManager as any).scopedMcpManagers.clear();
	gw.sessionManager.refreshExternalMcpToolRegistrations?.();
}

// ─── Tests ──────────────────────────────────────────────────────────────

test.describe("MCP meta-tool API E2E", () => {
	test.afterEach(async ({ gateway }) => {
		clearFakeMcpManager(gateway);
	});

	// 1. GET /api/mcp-servers shape
	test("GET /api/mcp-servers returns an array of structured entries", async ({ gateway }) => {
		// First with no McpManager initialised (BOBBIT_SKIP_MCP=1) — empty array.
		const empty = await apiFetch("/api/mcp-servers");
		expect(empty.status).toBe(200);
		const emptyBody = await empty.json();
		expect(Array.isArray(emptyBody)).toBe(true);

		// Then seed a fake server and verify the entry shape.
		await seedFakeMcpManager(gateway);
		const resp = await apiFetch("/api/mcp-servers");
		expect(resp.status).toBe(200);
		const servers = await resp.json();
		expect(Array.isArray(servers)).toBe(true);
		const fake = servers.find((s: any) => s.name === "fake-server");
		expect(fake).toBeDefined();
		expect(fake.status).toBe("connected");
		expect(typeof fake.toolCount).toBe("number");
		expect(fake.toolCount).toBe(2);
	});

	test("GET /api/mcp-servers attributes conflicted public tools only to the winning runtime owner", async ({ gateway }) => {
		await seedFakeGatewayRuntimeMcpManager(gateway);

		const resp = await apiFetch("/api/mcp-servers");
		expect(resp.status).toBe(200);
		const servers = await resp.json();
		const first = servers.find((s: any) => s.name === "gw-a-gr");
		const second = servers.find((s: any) => s.name === "gw-b-gr");
		expect(first?.serverPolicyKey).toBe("mcp__gr");
		expect(first?.policyKey).toBe("mcp__gr");
		expect(first?.tools.map((t: any) => t.name)).toEqual(["mcp__gr__jira__search"]);
		expect(first?.tools[0]).toMatchObject({
			serverPolicyKey: "mcp__gr",
			packagePolicyKey: "mcp__gr__jira",
			subNamespacePolicyKey: "mcp__gr__jira",
			operationPolicyKey: "mcp__gr__jira__search",
			policyKey: "mcp__gr__jira__search",
		});
		expect(first?.toolCount).toBe(1);
		expect(second?.serverPolicyKey).toBe("mcp__gr");
		expect(second?.tools).toEqual([]);
		expect(second?.toolCount).toBe(0);
	});

	test("GET /api/mcp-servers scoped reads do not create managers unless ensure=true", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		clearFakeMcpManager(gateway);
		expect(gateway.sessionManager.getMcpManager({ projectId })).toBeNull();

		const readOnly = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId!)}`);
		expect(readOnly.status).toBe(200);
		expect(await readOnly.json()).toEqual([]);
		expect(gateway.sessionManager.getMcpManager({ projectId })).toBeNull();

		const cwdReadOnly = await apiFetch(`/api/mcp-servers?cwd=${encodeURIComponent(gateway.bobbitDir)}`);
		expect(cwdReadOnly.status).toBe(400);
		const cwdReadOnlyBody = await cwdReadOnly.json().catch(() => ({}));
		expect(String(cwdReadOnlyBody.code ?? cwdReadOnlyBody.error ?? "").toLowerCase()).toContain("project");
		expect(gateway.sessionManager.getMcpManager({ cwd: gateway.bobbitDir })).toBeNull();

		const ensured = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId!)}&ensure=true`);
		expect(ensured.status).toBe(200);
		expect(Array.isArray(await ensured.json())).toBe(true);
		expect(gateway.sessionManager.getMcpManager({ projectId })).not.toBeNull();
	});

	test("scoped MCP project cleanup disconnects managers and unregisters external tools", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const projectRoot = gateway.projectContextManager.getOrCreate(projectId!)?.project.rootPath;
		expect(projectRoot).toBeTruthy();

		await seedFakeMcpManager(gateway, "default-server");
		const projectMgr = await seedFakeScopedMcpManager(gateway, projectId!, "project-server");
		const cwdKey = `cwd:${path.resolve(projectRoot)}`;
		const cwdMgr = await makeFakeMcpManager(gateway, "cwd-server", { scopeKey: cwdKey });
		(gateway.sessionManager as any).scopedMcpManagers.set(cwdKey, cwdMgr);
		const unrelatedRoot = path.join(projectRoot!, "..", "unrelated-mcp-scope");
		const unrelatedCwdKey = `cwd:${path.resolve(unrelatedRoot)}`;
		const unrelatedCwdMgr = await makeFakeMcpManager(gateway, "unrelated-cwd-server", { scopeKey: unrelatedCwdKey });
		(gateway.sessionManager as any).scopedMcpManagers.set(unrelatedCwdKey, unrelatedCwdMgr);
		gateway.sessionManager.refreshExternalMcpToolRegistrations();
		const projectClient = (projectMgr as any).clients.get("project-server");
		const cwdClient = (cwdMgr as any).clients.get("cwd-server");
		const unrelatedCwdClient = (unrelatedCwdMgr as any).clients.get("unrelated-cwd-server");

		let toolsBody = await (await apiFetch("/api/tools")).json();
		let names = toolsBody.tools.map((t: any) => t.name);
		expect(names).toContain("mcp__default-server__echo");
		expect(names).toContain("mcp__project-server__echo");
		expect(names).toContain("mcp__cwd-server__echo");
		expect(names).toContain("mcp__unrelated-cwd-server__echo");

		await gateway.sessionManager.cleanupScopedMcpManagersForProject(projectId!, projectRoot);

		expect(gateway.sessionManager.getMcpManager({ projectId })).toBeNull();
		expect(gateway.sessionManager.getMcpManager({ cwd: projectRoot })).toBeNull();
		expect(gateway.sessionManager.getMcpManager({ cwd: unrelatedRoot })).not.toBeNull();
		expect(projectClient?.connected).toBe(false);
		expect(cwdClient?.connected).toBe(false);
		expect(unrelatedCwdClient?.connected).toBe(true);

		toolsBody = await (await apiFetch("/api/tools")).json();
		names = toolsBody.tools.map((t: any) => t.name);
		expect(names).toContain("mcp__default-server__echo");
		expect(names).toContain("mcp__unrelated-cwd-server__echo");
		expect(names).not.toContain("mcp__project-server__echo");
		expect(names).not.toContain("mcp__cwd-server__echo");
	});

	test("external MCP refresh keeps scoped registrations alongside default", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		await seedFakeMcpManager(gateway, "default-refresh");
		await seedFakeScopedMcpManager(gateway, projectId!, "scoped-refresh");

		gateway.sessionManager.refreshExternalMcpToolRegistrations();

		const toolsBody = await (await apiFetch("/api/tools")).json();
		const names = toolsBody.tools.map((t: any) => t.name);
		expect(names).toContain("mcp__default-refresh__echo");
		expect(names).toContain("mcp__scoped-refresh__echo");
	});

	test("reloadMcpAfterMarketplaceMutation aggregates scoped manager failures", async ({ gateway }) => {
		(gateway.sessionManager as any).mcpManager = {
			getScopeKey: () => "default",
			reloadDiscoveredServers: async () => ({
				status: "ok",
				connected: ["default-ok"],
				disconnected: [],
				unchanged: [],
				skippedErrored: [],
				failed: [],
				statuses: [],
			}),
		};
		(gateway.sessionManager as any).scopedMcpManagers.set("project:broken", {
			getScopeKey: () => "project:broken",
			reloadDiscoveredServers: async () => ({
				status: "error",
				connected: [],
				disconnected: [],
				unchanged: [],
				skippedErrored: [],
				failed: [{ name: "broken", error: "boom" }],
				statuses: [],
			}),
		});

		const result = await gateway.sessionManager.reloadMcpAfterMarketplaceMutation("server");
		expect(result?.status).toBe("partial");
		expect(result?.connected).toEqual(["default-ok"]);
		expect(result?.failed).toEqual([{ name: "broken", error: "boom" }]);
	});

	// 2. mcp-describe header enforcement
	test("POST /api/internal/mcp-describe requires X-Bobbit-Session-Id", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
		const token = readE2EToken();

		// Missing header → 403 (per server.ts)
		const noHeader = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ server: "fake-server" }),
		});
		expect(noHeader.status).toBe(403);
		const noHeaderBody = await noHeader.json();
		expect(noHeaderBody.error).toMatch(/X-Bobbit-Session-Id/i);

		// Unknown session id → 403
		const unknown = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": "no-such-session",
			},
			body: JSON.stringify({ server: "fake-server" }),
		});
		expect(unknown.status).toBe(403);
		const unknownBody = await unknown.json();
		expect(unknownBody.error).toMatch(/not found/i);
	});

	// 3. unknown server
	test("POST /api/internal/mcp-describe returns 503 for unknown server", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
		const sessionId = await createSession();
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
			body: JSON.stringify({ server: "definitely-not-a-real-server" }),
		});
		expect(resp.status).toBe(503);
		const body = await resp.json();
		expect(body.error).toMatch(/definitely-not-a-real-server/);
		expect(body.error).toMatch(/not connected/);
	});

	test("POST /api/internal/mcp-describe does not fall back from project manager to default", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
		const projectId = await defaultProjectId();
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
			body: JSON.stringify({ server: "fake-server" }),
		});
		expect(resp.status).toBe(503);
		const body = await resp.json();
		expect(body.error).toMatch(/fake-server/);
		expect(body.error).toMatch(/not connected/);
	});

	// 4. happy path
	test("POST /api/internal/mcp-describe lists ops and returns single op detail", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		await seedFakeScopedMcpManager(gateway, projectId!);
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"X-Bobbit-Session-Id": sessionId,
		};

		// List all ops on fake-server
		const listResp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers,
			body: JSON.stringify({ server: "fake-server" }),
		});
		expect(listResp.status).toBe(200);
		const listBody = await listResp.json();
		expect(Array.isArray(listBody.tools)).toBe(true);
		expect(listBody.tools).toHaveLength(2);
		const names = listBody.tools.map((t: any) => t.name).sort();
		expect(names).toEqual(["add", "echo"]);
		const echoEntry = listBody.tools.find((t: any) => t.name === "echo");
		expect(echoEntry.description).toMatch(/Echo/);
		expect(echoEntry.inputSchema?.type).toBe("object");

		// Single op detail
		const oneResp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers,
			body: JSON.stringify({ server: "fake-server", operation: "echo" }),
		});
		expect(oneResp.status).toBe(200);
		const oneBody = await oneResp.json();
		expect(oneBody.tool).toBeDefined();
		expect(oneBody.tool.name).toBe("echo");
		expect(oneBody.tool.description).toMatch(/Echo/);
		expect(oneBody.tool.inputSchema?.properties?.message).toBeDefined();

		// Missing op → 404
		const missResp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers,
			body: JSON.stringify({ server: "fake-server", operation: "missing" }),
		});
		expect(missResp.status).toBe(404);
		const missBody = await missResp.json();
		expect(missBody.error).toMatch(/operation not found/i);
	});

	test("POST /api/internal/mcp-describe accepts gateway public server names with generated runtime keys", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		await seedFakeGatewayRuntimeMcpManager(gateway, projectId!);
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
			body: JSON.stringify({ server: "gr" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.tools).toHaveLength(1);
		expect(body.tools[0]).toMatchObject({ name: "search", subNamespace: "jira" });
		expect(body.tools[0].description).toMatch(/first-contribution/);
	});

	test("POST /api/internal/mcp-describe uses stripped operation names for sub-namespace servers", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const subNamespaceOps = [
			{
				name: "ai-adoption__list-articles",
				description: "List adoption articles.",
				inputSchema: { type: "object", properties: { limit: { type: "number" } } },
			},
			{
				name: "ai-adoption__create-article",
				description: "Create an adoption article.",
				inputSchema: { type: "object", properties: { title: { type: "string" } } },
			},
		];
		await seedFakeScopedMcpManager(gateway, projectId!, "gr", subNamespaceOps, ["ai-adoption"]);
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"X-Bobbit-Session-Id": sessionId,
		};

		const listResp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers,
			body: JSON.stringify({ server: "gr" }),
		});
		expect(listResp.status).toBe(200);
		const listBody = await listResp.json();
		expect(listBody.tools.map((t: any) => t.name).sort()).toEqual(["create-article", "list-articles"]);
		expect(listBody.tools.map((t: any) => t.name)).not.toContain("ai-adoption__list-articles");
		expect(listBody.tools.every((t: any) => t.subNamespace === "ai-adoption")).toBe(true);

		const oneResp = await fetch(`${base()}/api/internal/mcp-describe`, {
			method: "POST",
			headers,
			body: JSON.stringify({ server: "gr", operation: "list-articles" }),
		});
		expect(oneResp.status).toBe(200);
		const oneBody = await oneResp.json();
		expect(oneBody.tool.name).toBe("list-articles");
		expect(oneBody.tool.subNamespace).toBe("ai-adoption");
		expect(oneBody.tool.description).toMatch(/List adoption/);
		expect(oneBody.tool.inputSchema?.properties?.limit).toBeDefined();
	});

	test("POST /api/internal/mcp-call does not fall back from project manager to default", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
		const projectId = await defaultProjectId();
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const callResp = await fetch(`${base()}/api/internal/mcp-call`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
			body: JSON.stringify({
				tool: "mcp__fake-server__echo",
				args: { message: "must not reach default manager" },
			}),
		});
		expect(callResp.status).toBe(500);
		const body = await callResp.json();
		expect(body.error).toMatch(/fake-server/);
	});

	// 5. mcp-call never-policy enforcement (Layer B)
	test("POST /api/internal/mcp-call denies per-op `never` policy via role", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		await seedFakeScopedMcpManager(gateway, projectId!);
		const token = readE2EToken();
		const roleName = "mcp-meta-deny-role";

		// Create a role with a per-op `never` policy on mcp__fake-server__echo.
		// POST /api/roles doesn't accept toolPolicies — set them via PUT.
		await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
		const createResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: roleName, label: "MCP Deny Test" }),
		});
		expect([200, 201]).toContain(createResp.status);

		const putResp = await apiFetch(`/api/roles/${roleName}`, {
			method: "PUT",
			body: JSON.stringify({
				toolPolicies: { "mcp__fake-server__echo": "never" },
			}),
		});
		expect(putResp.status).toBe(200);

		try {
			// Create a session and bind the role.
			const sessionId = await createSession({ projectId });
			const assignResp = await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: roleName }),
			});
			expect([200, 204]).toContain(assignResp.status);

			// Call the denied tool — Layer B enforcement should return 403.
			const callResp = await fetch(`${base()}/api/internal/mcp-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					"X-Bobbit-Session-Id": sessionId,
				},
				body: JSON.stringify({
					tool: "mcp__fake-server__echo",
					args: { message: "should be blocked" },
				}),
			});
			expect(callResp.status).toBe(403);
			const callBody = await callResp.json();
			expect(callBody.error).toMatch(/denied by policy/);
			expect(callBody.tool).toBe("mcp__fake-server__echo");
		} finally {
			await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("POST /api/internal/mcp-call lets broad role allow override persisted per-op `never`", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		await seedFakeScopedMcpManager(gateway, projectId!);
		const token = readE2EToken();
		const roleName = "mcp-meta-broad-allow-role";
		const opPolicyKey = "mcp__fake-server__echo";

		await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
		await apiFetch(`/api/tool-group-policies/${encodeURIComponent(opPolicyKey)}`, {
			method: "PUT",
			body: JSON.stringify({ policy: null }),
		}).catch(() => {});
		const createResp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: roleName, label: "MCP Broad Allow Test" }),
		});
		expect([200, 201]).toContain(createResp.status);

		const roleResp = await apiFetch(`/api/roles/${roleName}`, {
			method: "PUT",
			body: JSON.stringify({
				toolPolicies: { "mcp__fake-server": "allow" },
			}),
		});
		expect(roleResp.status).toBe(200);
		const policyResp = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(opPolicyKey)}`, {
			method: "PUT",
			body: JSON.stringify({ policy: "never" }),
		});
		expect(policyResp.status).toBe(200);

		try {
			const sessionId = await createSession({ projectId });
			const assignResp = await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: roleName }),
			});
			expect([200, 204]).toContain(assignResp.status);

			const callResp = await fetch(`${base()}/api/internal/mcp-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					"X-Bobbit-Session-Id": sessionId,
				},
				body: JSON.stringify({
					tool: "mcp__fake-server__echo",
					args: { message: "role policy should allow this available operation" },
				}),
			});
			expect(callResp.status).toBe(200);
			const callBody = await callResp.json();
			expect(callBody.content?.[0]?.text).toBe("stub");
		} finally {
			await apiFetch(`/api/tool-group-policies/${encodeURIComponent(opPolicyKey)}`, {
				method: "PUT",
				body: JSON.stringify({ policy: null }),
			}).catch(() => {});
			await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
