/**
 * E2E tests for MCP (Model Context Protocol) server integration.
 *
 * Tests run against a real gateway (started by Playwright webServer).
 * A mock MCP server (tests/fixtures/mock-mcp-server.mjs) provides
 * deterministic tool responses via stdio transport.
 *
 * One serial journey owns discovery, subprocess restart, scoped tool execution,
 * error handling, and tool-list metadata. Permission grant flow is covered by
 * mcp-tool-permission.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";

// This spec actually exercises MCP — opt the worker gateway into starting MCP servers.
test.use({ enableMcp: true });
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readE2EToken, base, bobbitDir, injectDefaultProjectId } from "../e2e-setup.js";

let _tok: string; function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

/** Authenticated fetch helper */
async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${base()}${path}`, {
		...opts,
		body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

// Resolve paths for the mock MCP server
const __dirname = fileURLToPath(new URL("..", import.meta.url));
const MOCK_SERVER_PATH = resolve(__dirname, "..", "fixtures", "mock-mcp-server.mjs");
const HEADQUARTERS_PROJECT_ID = "headquarters";
const hqQuery = `projectId=${encodeURIComponent(HEADQUARTERS_PROJECT_ID)}`;
const hqMcpServersPath = `/api/mcp-servers?${hqQuery}`;
const hqMcpRestartPath = (name: string) => `/api/mcp-servers/${encodeURIComponent(name)}/restart?${hqQuery}`;
const hqToolsPath = `/api/tools?${hqQuery}`;

/** The MCP config that points to our mock server */
const mcpConfig = {
	mcpServers: {
		mock: {
			command: process.execPath, // node executable
			args: [MOCK_SERVER_PATH],
		},
	},
};

// Resolve paths lazily — bobbitDir() depends on BOBBIT_DIR env which is set
// by the worker-scoped gateway fixture *after* module-level code runs.
let mcpConfigPath = "";

// Write MCP config before tests, clean up after
test.beforeAll(() => {
	const configDir = join(bobbitDir(), "config");
	mcpConfigPath = join(configDir, "mcp.json");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
});

test.afterAll(() => {
	if (mcpConfigPath && existsSync(mcpConfigPath)) {
		try { unlinkSync(mcpConfigPath); } catch { /* ignore */ }
	}
});

test("real MCP subprocess discovery, scoped calls, errors, and tool metadata", async () => {
	// Restart exactly once so this journey crosses the production child teardown,
	// spawn, initialize, and tools/list lifecycle before making scoped calls.
	const restartResp = await apiFetch(hqMcpRestartPath("mock"), { method: "POST" });
	expect(restartResp.status).toBe(200);
	const restartResult = await restartResp.json();
	expect(restartResult.status).toBe("connected");
	expect(restartResult.toolCount).toBe(2);

	const serversResp = await apiFetch(hqMcpServersPath);
	expect(serversResp.status).toBe(200);
	const servers = await serversResp.json();
	const mock = servers.find((server: any) => server.name === "mock");
	expect(mock).toBeDefined();
	expect(mock.config?.command).toBe(process.execPath);
	expect(mock.status).toBe("connected");
	expect(mock.toolCount).toBe(2);
	const discoveredToolNames = mock.tools.map((tool: any) => tool.name);
	expect(discoveredToolNames).toContain("mcp__mock__echo");
	expect(discoveredToolNames).toContain("mcp__mock__add");

	// A real Headquarters session carries project scope across every internal call.
	const sessionResp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ title: "mcp-test-session", projectId: HEADQUARTERS_PROJECT_ID }),
	});
	expect(sessionResp.status).toBe(201);
	const testSessionId = (await sessionResp.json()).id;
	const mcpCall = (tool: string, args: Record<string, unknown>) =>
		apiFetch("/api/internal/mcp-call", {
			method: "POST",
			headers: { "X-Bobbit-Session-Id": testSessionId },
			body: JSON.stringify({ tool, args }),
		});

	try {
		const echoResp = await mcpCall("mcp__mock__echo", { message: "hello world" });
		expect(echoResp.status).toBe(200);
		const echoResult = await echoResp.json();
		expect(echoResult.content[0].text).toBe("hello world");
		expect(echoResult.isError).toBeFalsy();

		const addResp = await mcpCall("mcp__mock__add", { a: 2, b: 3 });
		expect(addResp.status).toBe(200);
		const addResult = await addResp.json();
		expect(addResult.content[0].text).toBe("5");

		const unknownResp = await mcpCall("mcp__mock__nonexistent", {});
		expect(unknownResp.status).toBe(200);
		const unknownResult = await unknownResp.json();
		expect(unknownResult.isError).toBe(true);

		const badServerResp = await mcpCall("mcp__nonexistent__sometool", {});
		expect(badServerResp.status).toBeGreaterThanOrEqual(400);

		const toolsResp = await apiFetch(hqToolsPath);
		expect(toolsResp.status).toBe(200);
		const { tools } = await toolsResp.json();
		const toolNames = tools.map((tool: any) => tool.name);
		expect(toolNames).toContain("mcp__mock__echo");
		expect(toolNames).toContain("mcp__mock__add");

		const echoTool = tools.find((tool: any) => tool.name === "mcp__mock__echo");
		expect(echoTool.description.toLowerCase()).toContain("echo");
		expect(echoTool.group).toMatch(/MCP/i);
	} finally {
		const deleteResp = await apiFetch(`/api/sessions/${testSessionId}?purge=true`, { method: "DELETE" });
		expect([200, 404]).toContain(deleteResp.status);
	}
});
