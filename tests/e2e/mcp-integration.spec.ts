/**
 * E2E tests for MCP (Model Context Protocol) server integration.
 *
 * Tests run against a real gateway (started by Playwright webServer).
 * A mock MCP server (tests/fixtures/mock-mcp-server.mjs) provides
 * deterministic tool responses via stdio transport.
 *
 * Trimmed to 3 core tests: discovery+connection, tool execution, tool list.
 * Permission grant flow is covered by mcp-tool-permission.spec.ts.
 */
import { test, expect } from "./gateway-harness.js";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readE2EToken, base, bobbitDir } from "./e2e-setup.js";

let _tok: string; function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

/** Authenticated fetch helper */
function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

// Resolve paths for the mock MCP server
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER_PATH = resolve(__dirname, "..", "fixtures", "mock-mcp-server.mjs");

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

// ═══════════════════════════════════════════════════════════════════════════
// 1. MCP Server Discovery & Connection
// ═══════════════════════════════════════════════════════════════════════════

test("server discovery, restart, and connected status", async () => {
	// Restart to ensure the mock server is connected
	const restartResp = await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });
	expect(restartResp.status).toBe(200);
	const restartResult = await restartResp.json();
	expect(restartResult.status).toBe("connected");
	expect(restartResult.toolCount).toBe(2);

	// Verify the server list shows it connected with correct metadata
	const resp = await apiFetch("/api/mcp-servers");
	expect(resp.status).toBe(200);
	const servers = await resp.json();
	const mock = servers.find((s: any) => s.name === "mock");
	expect(mock).toBeDefined();
	expect(mock.config?.command).toBe(process.execPath);
	expect(mock.status).toBe("connected");
	expect(mock.toolCount).toBe(2);

	// Verify tool names follow the mcp__<server>__<tool> convention
	if (mock.tools) {
		const toolNames = mock.tools.map((t: any) => t.name);
		expect(toolNames).toContain("mcp__mock__echo");
		expect(toolNames).toContain("mcp__mock__add");
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. MCP Tool Execution via Internal API
// ═══════════════════════════════════════════════════════════════════════════

test("tool execution via /api/internal/mcp-call", async () => {
	// Ensure the mock server is connected
	await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });

	// Create a test session for the X-Bobbit-Session-Id header
	const sessResp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ title: "mcp-test-session" }),
	});
	const testSessionId = (await sessResp.json()).id;

	const mcpCall = (tool: string, args: Record<string, unknown>) =>
		apiFetch("/api/internal/mcp-call", {
			method: "POST",
			headers: { "X-Bobbit-Session-Id": testSessionId },
			body: JSON.stringify({ tool, args }),
		});

	// Echo tool — happy path
	const echoResp = await mcpCall("mcp__mock__echo", { message: "hello world" });
	expect(echoResp.status).toBe(200);
	const echoResult = await echoResp.json();
	expect(echoResult.content[0].text).toBe("hello world");
	expect(echoResult.isError).toBeFalsy();

	// Add tool — verifies argument passing
	const addResp = await mcpCall("mcp__mock__add", { a: 2, b: 3 });
	expect(addResp.status).toBe(200);
	const addResult = await addResp.json();
	expect(addResult.content[0].text).toBe("5");

	// Unknown tool — error handling
	const unknownResp = await mcpCall("mcp__mock__nonexistent", {});
	expect(unknownResp.status).toBe(200);
	const unknownResult = await unknownResp.json();
	expect(unknownResult.isError).toBe(true);

	// Unknown server — 4xx error
	const badServerResp = await mcpCall("mcp__nonexistent__sometool", {});
	expect(badServerResp.status).toBeGreaterThanOrEqual(400);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. MCP Tools in Tool List
// ═══════════════════════════════════════════════════════════════════════════

test("MCP tools appear in GET /api/tools with correct metadata", async () => {
	// Ensure the mock server is connected
	await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });

	const resp = await apiFetch("/api/tools");
	expect(resp.status).toBe(200);
	const { tools } = await resp.json();
	const toolNames = tools.map((t: any) => t.name);

	expect(toolNames).toContain("mcp__mock__echo");
	expect(toolNames).toContain("mcp__mock__add");

	const echoTool = tools.find((t: any) => t.name === "mcp__mock__echo");
	expect(echoTool.description.toLowerCase()).toContain("echo");
	expect(echoTool.group).toMatch(/MCP/i);
});
