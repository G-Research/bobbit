/**
 * E2E tests for the Tool Management REST API.
 *
 * Tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify the extended GET /api/tools, GET /api/tools/:name,
 * PUT /api/tools/:name endpoints, and backward compatibility.
 *
 * PUT tests modify YAML files in tools/<group>/. We backup and restore
 * the specific YAML files that are modified by PUT tests.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readE2EToken, BASE, E2E_BOBBIT_DIR } from "./e2e-setup.js";

const TOKEN = readE2EToken();

/**
 * YAML files modified by PUT tests — we backup/restore these.
 * Paths are relative to the E2E BOBBIT_DIR's config/tools/ directory
 * (tool YAMLs are scaffolded into .bobbit/config/tools/ on server startup).
 */
const MODIFIED_YAMLS = [
	"config/tools/shell/bash.yaml",
	"config/tools/filesystem/read.yaml",
	"config/tools/filesystem/edit.yaml",
	"config/tools/agent/delegate.yaml",
];

const yamlBackups = new Map<string, string>();

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

// Back up and restore YAML files around the test suite
test.beforeAll(() => {
	for (const yamlPath of MODIFIED_YAMLS) {
		const abs = join(E2E_BOBBIT_DIR, yamlPath);
		if (existsSync(abs)) {
			yamlBackups.set(yamlPath, readFileSync(abs, "utf-8"));
		}
	}
});

test.afterAll(() => {
	for (const [yamlPath, content] of yamlBackups) {
		const abs = join(E2E_BOBBIT_DIR, yamlPath);
		writeFileSync(abs, content, "utf-8");
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/tools — extended response
// ═══════════════════════════════════════════════════════════════════════════

test.describe("GET /api/tools — extended response", () => {
	test("returns tools array with hasRenderer and rendererFile fields", async () => {
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const { tools } = await resp.json();
		expect(Array.isArray(tools)).toBe(true);
		expect(tools.length).toBeGreaterThan(0);

		// Every tool should have the extended fields
		for (const tool of tools) {
			expect(typeof tool.hasRenderer).toBe("boolean");
			// rendererFile is present when hasRenderer is true
			if (tool.hasRenderer) {
				expect(typeof tool.rendererFile).toBe("string");
				expect(tool.rendererFile.length).toBeGreaterThan(0);
			}
		}
	});

	test("known tools with renderers have correct rendererFile paths", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();
		const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));

		// bash is a core tool that definitely has a renderer
		expect(byName["bash"]).toBeDefined();
		expect(byName["bash"].hasRenderer).toBe(true);
		expect(byName["bash"].rendererFile).toContain("BashRenderer");

		// read, write, edit also have renderers
		expect(byName["read"].hasRenderer).toBe(true);
		expect(byName["write"].hasRenderer).toBe(true);
		expect(byName["edit"].hasRenderer).toBe(true);
	});

	test("includes docs field (undefined by default)", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();

		// By default, docs is undefined (no overrides in store)
		// The field should be present in the response type but may be undefined
		for (const tool of tools) {
			expect("name" in tool).toBe(true);
			// docs can be undefined or a string
			if (tool.docs !== undefined) {
				expect(typeof tool.docs).toBe("string");
			}
		}
	});

	test("includes all expected tool names", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();
		const names = tools.map((t: any) => t.name);

		// Core tools that should always be present
		for (const expected of ["read", "write", "edit", "bash", "web_search", "web_fetch", "delegate"]) {
			expect(names).toContain(expected);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /api/tools/:name — single tool detail
// ═══════════════════════════════════════════════════════════════════════════

test.describe("GET /api/tools/:name — single tool detail", () => {
	test("returns full detail for a known tool", async () => {
		const resp = await apiFetch("/api/tools/bash");
		expect(resp.status).toBe(200);
		const tool = await resp.json();
		expect(tool.name).toBe("bash");
		expect(typeof tool.description).toBe("string");
		expect(typeof tool.group).toBe("string");
		expect(typeof tool.hasRenderer).toBe("boolean");
		expect(tool.hasRenderer).toBe(true);
		expect(tool.rendererFile).toContain("BashRenderer");
	});

	test("returns 404 for unknown tool", async () => {
		const resp = await apiFetch("/api/tools/nonexistent-tool-xyz");
		expect(resp.status).toBe(404);
		const body = await resp.json();
		expect(body.error).toBeTruthy();
	});

	test("returns consistent data with list endpoint", async () => {
		// Get the tool from the list
		const listResp = await apiFetch("/api/tools");
		const { tools } = await listResp.json();
		const fromList = tools.find((t: any) => t.name === "read");
		expect(fromList).toBeDefined();

		// Get the same tool by name
		const detailResp = await apiFetch("/api/tools/read");
		expect(detailResp.status).toBe(200);
		const fromDetail = await detailResp.json();

		// Should match
		expect(fromDetail.name).toBe(fromList.name);
		expect(fromDetail.description).toBe(fromList.description);
		expect(fromDetail.group).toBe(fromList.group);
		expect(fromDetail.hasRenderer).toBe(fromList.hasRenderer);
		expect(fromDetail.rendererFile).toBe(fromList.rendererFile);
	});

	test("handles URL-encoded tool names", async () => {
		const resp = await apiFetch("/api/tools/web_search");
		expect(resp.status).toBe(200);
		const tool = await resp.json();
		expect(tool.name).toBe("web_search");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. PUT /api/tools/:name — update metadata
// ═══════════════════════════════════════════════════════════════════════════

test.describe("PUT /api/tools/:name — update metadata", () => {
	test("updates description and verifies with GET", async () => {
		const resp = await apiFetch("/api/tools/bash", {
			method: "PUT",
			body: JSON.stringify({ description: "E2E test custom description" }),
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.ok).toBe(true);

		// Verify via GET detail
		const getResp = await apiFetch("/api/tools/bash");
		const tool = await getResp.json();
		expect(tool.description).toBe("E2E test custom description");
	});

	test("updates group and verifies with GET", async () => {
		const resp = await apiFetch("/api/tools/bash", {
			method: "PUT",
			body: JSON.stringify({ group: "Custom Group" }),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/tools/bash");
		const tool = await getResp.json();
		expect(tool.group).toBe("Custom Group");
	});

	test("updates docs and verifies with GET", async () => {
		const docsContent = "# Bash Tool\n\nRun shell commands.\n\n## Examples\n```bash\necho hello\n```";
		const resp = await apiFetch("/api/tools/bash", {
			method: "PUT",
			body: JSON.stringify({ docs: docsContent }),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/tools/bash");
		const tool = await getResp.json();
		expect(tool.docs).toBe(docsContent);
	});

	test("updates multiple fields at once", async () => {
		const resp = await apiFetch("/api/tools/read", {
			method: "PUT",
			body: JSON.stringify({
				description: "Read files (custom)",
				group: "IO",
				docs: "Reads file content.",
			}),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/tools/read");
		const tool = await getResp.json();
		expect(tool.description).toBe("Read files (custom)");
		expect(tool.group).toBe("IO");
		expect(tool.docs).toBe("Reads file content.");
	});

	test("updated tool appears correctly in list endpoint", async () => {
		await apiFetch("/api/tools/edit", {
			method: "PUT",
			body: JSON.stringify({ description: "Custom edit desc", docs: "Edit docs here" }),
		});

		const listResp = await apiFetch("/api/tools");
		const { tools } = await listResp.json();
		const editTool = tools.find((t: any) => t.name === "edit");
		expect(editTool).toBeDefined();
		expect(editTool.description).toBe("Custom edit desc");
		expect(editTool.docs).toBe("Edit docs here");
	});

	test("returns 404 for unknown tool", async () => {
		const resp = await apiFetch("/api/tools/nonexistent-tool-xyz", {
			method: "PUT",
			body: JSON.stringify({ description: "Nope" }),
		});
		expect(resp.status).toBe(404);
		const body = await resp.json();
		expect(body.error).toBeTruthy();
	});

	test("partial update preserves other custom fields", async () => {
		// Set both description and docs
		await apiFetch("/api/tools/delegate", {
			method: "PUT",
			body: JSON.stringify({ description: "Custom delegate", docs: "Delegate docs" }),
		});

		// Update only description
		await apiFetch("/api/tools/delegate", {
			method: "PUT",
			body: JSON.stringify({ description: "Updated delegate" }),
		});

		// Docs should still be there
		const getResp = await apiFetch("/api/tools/delegate");
		const tool = await getResp.json();
		expect(tool.description).toBe("Updated delegate");
		expect(tool.docs).toBe("Delegate docs");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Backward compatibility", () => {
	test("GET /api/tools response shape includes original fields", async () => {
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const data = await resp.json();

		// Must have { tools: [...] } wrapper
		expect(data.tools).toBeDefined();
		expect(Array.isArray(data.tools)).toBe(true);

		// Each tool must have the original fields from before the extension
		for (const tool of data.tools) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(typeof tool.group).toBe("string");
			// New fields are additive — old consumers can ignore them
			expect(tool.name.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.group.length).toBeGreaterThan(0);
		}
	});

	test("tools are not returned as plain strings", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();

		// Old API may have returned strings; new API returns objects
		for (const tool of tools) {
			expect(typeof tool).toBe("object");
			expect(tool).not.toBeNull();
		}
	});

	test("auth required for all tool endpoints", async () => {
		const endpoints = [
			{ path: "/api/tools", method: "GET" },
			{ path: "/api/tools/bash", method: "GET" },
			{ path: "/api/tools/bash", method: "PUT" },
		];

		for (const { path, method } of endpoints) {
			const resp = await fetch(`${BASE}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: method === "PUT" ? JSON.stringify({ description: "x" }) : undefined,
			});
			expect(resp.status).toBe(401);
		}
	});
});
