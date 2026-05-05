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
import { apiFetch, base, readE2EToken, createSession } from "./e2e-setup.js";
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
async function seedFakeMcpManager(gw: GatewayInfo, serverName = "fake-server") {
	const { McpManager } = await import("../../dist/server/mcp/mcp-manager.js");
	const mgr = new (McpManager as any)(gw.bobbitDir, undefined, undefined);
	const client = new FakeMcpClient(serverName);
	client.connected = true;
	(mgr as any).clients.set(serverName, client);
	(mgr as any).toolDefs.set(serverName, STUB_OPS);
	(mgr as any).configs.set(serverName, { command: "stub" });

	(gw.sessionManager as any).mcpManager = mgr;
	return mgr;
}

function clearFakeMcpManager(gw: GatewayInfo) {
	(gw.sessionManager as any).mcpManager = null;
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

	// 4. happy path
	test("POST /api/internal/mcp-describe lists ops and returns single op detail", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
		const sessionId = await createSession();
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

	// 5. mcp-call never-policy enforcement (Layer B)
	test("POST /api/internal/mcp-call denies per-op `never` policy via role", async ({ gateway }) => {
		await seedFakeMcpManager(gateway);
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
			const sessionId = await createSession();
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
});
