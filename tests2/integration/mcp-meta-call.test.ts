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
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, readE2EToken, createSession, defaultProjectId } from "./_e2e/e2e-setup.js";
import path from "node:path";
import type { GatewayFixture as GatewayInfo } from "../harness/gateway.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

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

type StubOp = { name: string; description: string; inputSchema: any };
const STUB_OPS = Object.freeze([
	Object.freeze({
		name: "echo",
		description: "Echo a message back.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({ message: Object.freeze({ type: "string" }) }),
			required: Object.freeze(["message"]),
		}),
	}),
	Object.freeze({
		name: "add",
		description: "Add two numbers.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({
				a: Object.freeze({ type: "number" }),
				b: Object.freeze({ type: "number" }),
			}),
			required: Object.freeze(["a", "b"]),
		}),
	}),
]) satisfies readonly StubOp[];
const SUB_NAMESPACE_OPS = Object.freeze([
	Object.freeze({
		name: "ai-adoption__list-articles",
		description: "List adoption articles.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({ limit: Object.freeze({ type: "number" }) }),
		}),
	}),
	Object.freeze({
		name: "ai-adoption__create-article",
		description: "Create an adoption article.",
		inputSchema: Object.freeze({
			type: "object",
			properties: Object.freeze({ title: Object.freeze({ type: "string" }) }),
		}),
	}),
]) satisfies readonly StubOp[];
const GATEWAY_RUNTIME_SERVERS = Object.freeze([
	Object.freeze({ runtimeServerKey: "gw-a-gr", contributionId: "first-contribution", url: "https://gateway-a.test/mcp" }),
	Object.freeze({ runtimeServerKey: "gw-b-gr", contributionId: "second-contribution", url: "https://gateway-b.test/mcp" }),
]);

const HEADQUARTERS_PROJECT_ID = "headquarters";
const DENY_ROLE = Object.freeze({
	name: "mcp-meta-deny-role",
	label: "MCP Deny Test",
	toolPolicies: Object.freeze({ "mcp__fake-server__echo": "never" }),
});
const BROAD_ALLOW_ROLE = Object.freeze({
	name: "mcp-meta-broad-allow-role",
	label: "MCP Broad Allow Test",
	toolPolicies: Object.freeze({ "mcp__fake-server": "allow" }),
});
const OP_POLICY_KEY = "mcp__fake-server__echo";
const projectQuery = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;
const mcpServersPath = (projectId: string, suffix = "") => `/api/mcp-servers${suffix}?${projectQuery(projectId)}`;
const toolsPath = (projectId: string) => `/api/tools?${projectQuery(projectId)}`;

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
	toolDefs: readonly StubOp[] = STUB_OPS,
	activeSubNamespaces?: readonly string[],
) {
	const { McpManager } = (await loadServerTestRuntime()).mcpManager;
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
	toolDefs: readonly StubOp[] = STUB_OPS,
	activeSubNamespaces?: readonly string[],
) {
	const scopeKey = `project:${projectId}`;
	const mgr = await makeFakeMcpManager(gw, serverName, { projectId, scopeKey }, toolDefs, activeSubNamespaces);
	(gw.sessionManager as any).scopedMcpManagers.set(scopeKey, mgr);
	return mgr;
}

async function seedFakeGatewayRuntimeMcpManager(gw: GatewayInfo, projectId?: string) {
	const { McpManager } = (await loadServerTestRuntime()).mcpManager;
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
	for (const { runtimeServerKey, contributionId, url } of GATEWAY_RUNTIME_SERVERS) {
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

async function clearFakeMcpManagers(gw: GatewayInfo): Promise<void> {
	const sessionManager = gw.sessionManager as any;
	const managers = new Set<any>([
		...(sessionManager.mcpManager ? [sessionManager.mcpManager] : []),
		...sessionManager.scopedMcpManagers.values(),
	]);

	// Remove ownership first so no request can observe a manager while teardown
	// awaits its clients. Refresh once after every disconnect has settled.
	sessionManager.mcpManager = null;
	sessionManager.scopedMcpManagers.clear();
	const results = await Promise.allSettled(
		[...managers].map((mgr) => typeof mgr?.disconnectAll === "function" ? mgr.disconnectAll() : Promise.resolve()),
	);
	gw.sessionManager.refreshExternalMcpToolRegistrations?.();
	const failures = results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason);
	if (failures.length > 0) throw new AggregateError(failures, "Failed to disconnect fake MCP managers");
}

// ─── Tests ──────────────────────────────────────────────────────────────

test.describe("MCP meta-tool API E2E", () => {
	let projectId: string;
	let token: string;
	let sharedSessionId: string;
	let denySessionId: string;
	let broadAllowSessionId: string;

	test.beforeAll(async () => {
		const resolvedProjectId = await defaultProjectId();
		expect(resolvedProjectId).toBeTruthy();
		projectId = resolvedProjectId!;
		token = readE2EToken();

		for (const role of [DENY_ROLE, BROAD_ALLOW_ROLE]) {
			await apiFetch(`/api/roles/${role.name}`, { method: "DELETE" }).catch(() => {});
		}
		await apiFetch(`/api/tool-group-policies/${encodeURIComponent(OP_POLICY_KEY)}`, {
			method: "PUT",
			body: JSON.stringify({ policy: null }),
		}).catch(() => {});

		for (const role of [DENY_ROLE, BROAD_ALLOW_ROLE]) {
			const createResp = await apiFetch("/api/roles", {
				method: "POST",
				body: JSON.stringify({ name: role.name, label: role.label }),
			});
			expect([200, 201]).toContain(createResp.status);
			const putResp = await apiFetch(`/api/roles/${role.name}`, {
				method: "PUT",
				body: JSON.stringify({ toolPolicies: role.toolPolicies }),
			});
			expect(putResp.status).toBe(200);
		}

		// One immutable identity serves role-free HTTP cases; policy cases each get
		// a dedicated identity so assignments never bleed between tests.
		sharedSessionId = await createSession({ projectId });
		denySessionId = await createSession({ projectId });
		broadAllowSessionId = await createSession({ projectId });
		expect(new Set([sharedSessionId, denySessionId, broadAllowSessionId]).size).toBe(3);
	});

	test.afterEach(async ({ gateway }) => {
		await clearFakeMcpManagers(gateway);
	});

	test.afterAll(async ({ gateway }) => {
		await clearFakeMcpManagers(gateway);
		const policyReset = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(OP_POLICY_KEY)}`, {
			method: "PUT",
			body: JSON.stringify({ policy: null }),
		});
		expect(policyReset.status).toBe(200);
		for (const sessionId of [sharedSessionId, denySessionId, broadAllowSessionId].filter(Boolean)) {
			const purgeResp = await apiFetch(`/api/sessions/${sessionId}?purge=true`, { method: "DELETE" });
			expect(purgeResp.status).toBe(200);
		}
		for (const role of [DENY_ROLE, BROAD_ALLOW_ROLE]) {
			const deleteResp = await apiFetch(`/api/roles/${role.name}`, { method: "DELETE" });
			expect([200, 204]).toContain(deleteResp.status);
		}
	});

	// 1. GET /api/mcp-servers shape
	test("GET /api/mcp-servers requires projectId and returns structured Headquarters entries", async ({ gateway }) => {
		const missingProject = await apiFetch("/api/mcp-servers");
		expect(missingProject.status).toBe(400);
		const missingProjectBody = await missingProject.json().catch(() => ({}));
		expect(String(missingProjectBody.code ?? missingProjectBody.error ?? "").toLowerCase()).toContain("project");

		// First with no McpManager initialised (BOBBIT_SKIP_MCP=1) — empty array.
		const empty = await apiFetch(mcpServersPath(HEADQUARTERS_PROJECT_ID));
		expect(empty.status).toBe(200);
		const emptyBody = await empty.json();
		expect(Array.isArray(emptyBody)).toBe(true);

		// Then seed a fake Headquarters server and verify the entry shape.
		await seedFakeScopedMcpManager(gateway, HEADQUARTERS_PROJECT_ID);
		const resp = await apiFetch(mcpServersPath(HEADQUARTERS_PROJECT_ID));
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
		await seedFakeGatewayRuntimeMcpManager(gateway, HEADQUARTERS_PROJECT_ID);

		const resp = await apiFetch(mcpServersPath(HEADQUARTERS_PROJECT_ID));
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
		await clearFakeMcpManagers(gateway);
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
		const projectRoot = gateway.projectContextManager.getOrCreate(projectId)?.project.rootPath;
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

		let toolsBody = await (await apiFetch(toolsPath(projectId!))).json();
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

		toolsBody = await (await apiFetch(toolsPath(projectId!))).json();
		names = toolsBody.tools.map((t: any) => t.name);
		expect(names).toContain("mcp__default-server__echo");
		expect(names).toContain("mcp__unrelated-cwd-server__echo");
		expect(names).not.toContain("mcp__project-server__echo");
		expect(names).not.toContain("mcp__cwd-server__echo");
	});

	test("external MCP refresh keeps scoped registrations alongside default", async ({ gateway }) => {
		await seedFakeMcpManager(gateway, "default-refresh");
		await seedFakeScopedMcpManager(gateway, projectId!, "scoped-refresh");

		gateway.sessionManager.refreshExternalMcpToolRegistrations();

		const toolsBody = await (await apiFetch(toolsPath(projectId!))).json();
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
		const sessionId = sharedSessionId;

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
		const sessionId = sharedSessionId;

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
		await seedFakeScopedMcpManager(gateway, projectId);
		const sessionId = sharedSessionId;

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
		await seedFakeGatewayRuntimeMcpManager(gateway, projectId);
		const sessionId = sharedSessionId;

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
		await seedFakeScopedMcpManager(gateway, projectId, "gr", SUB_NAMESPACE_OPS, ["ai-adoption"]);
		const sessionId = sharedSessionId;

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
		const sessionId = sharedSessionId;

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
		await seedFakeScopedMcpManager(gateway, projectId);
		const assignResp = await apiFetch(`/api/sessions/${denySessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ roleId: DENY_ROLE.name }),
		});
		expect([200, 204]).toContain(assignResp.status);

		// Call the denied tool — Layer B enforcement should return 403.
		const callResp = await fetch(`${base()}/api/internal/mcp-call`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": denySessionId,
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
	});

	test("POST /api/internal/mcp-call lets broad role allow override persisted per-op `never`", async ({ gateway }) => {
		await seedFakeScopedMcpManager(gateway, projectId);
		const policyResp = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(OP_POLICY_KEY)}`, {
			method: "PUT",
			body: JSON.stringify({ policy: "never" }),
		});
		expect(policyResp.status).toBe(200);

		try {
			const assignResp = await apiFetch(`/api/sessions/${broadAllowSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: BROAD_ALLOW_ROLE.name }),
			});
			expect([200, 204]).toContain(assignResp.status);

			const callResp = await fetch(`${base()}/api/internal/mcp-call`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					"X-Bobbit-Session-Id": broadAllowSessionId,
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
			const resetResp = await apiFetch(`/api/tool-group-policies/${encodeURIComponent(OP_POLICY_KEY)}`, {
				method: "PUT",
				body: JSON.stringify({ policy: null }),
			});
			expect(resetResp.status).toBe(200);
		}
	});
});
