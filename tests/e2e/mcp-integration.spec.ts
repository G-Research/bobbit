/**
 * E2E tests for MCP (Model Context Protocol) server integration.
 *
 * Tests run against a real gateway (started by Playwright webServer).
 * A mock MCP server (tests/fixtures/mock-mcp-server.mjs) provides
 * deterministic tool responses via stdio transport.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readE2EToken, BASE, E2E_BOBBIT_DIR } from "./e2e-setup.js";

const TOKEN = readE2EToken();

/** Authenticated fetch helper */
function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

// Resolve paths for the mock MCP server
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_SERVER_PATH = resolve(__dirname, "..", "fixtures", "mock-mcp-server.mjs");
const MCP_CONFIG_DIR = join(E2E_BOBBIT_DIR, "config");
const MCP_CONFIG_PATH = join(MCP_CONFIG_DIR, "mcp.json");

/** The MCP config that points to our mock server */
const mcpConfig = {
	mcpServers: {
		mock: {
			command: process.execPath, // node executable
			args: [MOCK_SERVER_PATH],
		},
	},
};

// Write MCP config before tests, clean up after
test.beforeAll(() => {
	mkdirSync(MCP_CONFIG_DIR, { recursive: true });
	writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2), "utf-8");
});

test.afterAll(() => {
	if (existsSync(MCP_CONFIG_PATH)) {
		try { unlinkSync(MCP_CONFIG_PATH); } catch { /* ignore */ }
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. MCP Server Discovery
// ═══════════════════════════════════════════════════════════════════════════

test.describe("MCP Server Discovery", () => {
	test("GET /api/mcp-servers returns discovered servers", async () => {
		// First restart the mock server to ensure discovery picks up the config
		await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });

		const resp = await apiFetch("/api/mcp-servers");
		expect(resp.status).toBe(200);
		const servers = await resp.json();
		expect(Array.isArray(servers)).toBe(true);

		const mock = servers.find((s: any) => s.name === "mock");
		expect(mock).toBeDefined();
		expect(mock.config?.command).toBe(process.execPath);
	});

	test("POST /api/mcp-servers/:name/restart connects server", async () => {
		const resp = await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });
		expect(resp.status).toBe(200);
		const result = await resp.json();
		expect(result.status).toBe("connected");
		expect(result.toolCount).toBe(2);
	});

	test("GET /api/mcp-servers shows connected server with tools", async () => {
		// Ensure server is connected
		await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });

		const resp = await apiFetch("/api/mcp-servers");
		expect(resp.status).toBe(200);
		const servers = await resp.json();
		const mock = servers.find((s: any) => s.name === "mock");
		expect(mock).toBeDefined();
		expect(mock.status).toBe("connected");
		expect(mock.toolCount).toBe(2);

		// Verify tool names follow the mcp__<server>__<tool> convention
		if (mock.tools) {
			const toolNames = mock.tools.map((t: any) => t.name);
			expect(toolNames).toContain("mcp__mock__echo");
			expect(toolNames).toContain("mcp__mock__add");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. MCP Tool Calls via Internal API
// ═══════════════════════════════════════════════════════════════════════════

test.describe("MCP Tool Calls", () => {
	test.beforeAll(async () => {
		// Ensure the mock server is connected before running tool call tests
		await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });
	});

	test("POST /api/internal/mcp-call executes echo tool", async () => {
		const resp = await apiFetch("/api/internal/mcp-call", {
			method: "POST",
			body: JSON.stringify({
				tool: "mcp__mock__echo",
				args: { message: "hello world" },
			}),
		});
		expect(resp.status).toBe(200);
		const result = await resp.json();
		expect(result.content).toBeDefined();
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toBe("hello world");
		expect(result.isError).toBeFalsy();
	});

	test("POST /api/internal/mcp-call executes add tool", async () => {
		const resp = await apiFetch("/api/internal/mcp-call", {
			method: "POST",
			body: JSON.stringify({
				tool: "mcp__mock__add",
				args: { a: 2, b: 3 },
			}),
		});
		expect(resp.status).toBe(200);
		const result = await resp.json();
		expect(result.content).toBeDefined();
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toBe("5");
		expect(result.isError).toBeFalsy();
	});

	test("POST /api/internal/mcp-call returns error for unknown tool on server", async () => {
		const resp = await apiFetch("/api/internal/mcp-call", {
			method: "POST",
			body: JSON.stringify({
				tool: "mcp__mock__nonexistent",
				args: {},
			}),
		});
		expect(resp.status).toBe(200);
		const result = await resp.json();
		expect(result.content[0].text).toBe("Unknown tool");
		expect(result.isError).toBe(true);
	});

	test("POST /api/internal/mcp-call returns error for unknown server", async () => {
		const resp = await apiFetch("/api/internal/mcp-call", {
			method: "POST",
			body: JSON.stringify({
				tool: "mcp__nonexistent__sometool",
				args: {},
			}),
		});
		// Should return an error status (400 or 404)
		expect(resp.status).toBeGreaterThanOrEqual(400);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. MCP Tools in Tool List
// ═══════════════════════════════════════════════════════════════════════════

test.describe("MCP Tools in Tool List", () => {
	test.beforeAll(async () => {
		// Ensure the mock server is connected
		await apiFetch("/api/mcp-servers/mock/restart", { method: "POST" });
	});

	test("GET /api/tools includes MCP tools", async () => {
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const { tools } = await resp.json();
		const toolNames = tools.map((t: any) => t.name);

		expect(toolNames).toContain("mcp__mock__echo");
		expect(toolNames).toContain("mcp__mock__add");
	});

	test("MCP tools have correct metadata", async () => {
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const { tools } = await resp.json();

		const echoTool = tools.find((t: any) => t.name === "mcp__mock__echo");
		expect(echoTool).toBeDefined();
		expect(echoTool.description.toLowerCase()).toContain("echo");
		expect(echoTool.group).toMatch(/MCP/i);

		const addTool = tools.find((t: any) => t.name === "mcp__mock__add");
		expect(addTool).toBeDefined();
		expect(addTool.description.toLowerCase()).toContain("add");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Authentication
// ═══════════════════════════════════════════════════════════════════════════

test.describe("MCP API Authentication", () => {
	test("MCP endpoints require auth", async () => {
		const endpoints = [
			{ path: "/api/mcp-servers", method: "GET" },
			{ path: "/api/mcp-servers/mock/restart", method: "POST" },
			{ path: "/api/internal/mcp-call", method: "POST" },
		];

		for (const { path, method } of endpoints) {
			const resp = await fetch(`${BASE}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: method === "POST" ? JSON.stringify({}) : undefined,
			});
			expect(resp.status).toBe(401);
		}
	});
});
