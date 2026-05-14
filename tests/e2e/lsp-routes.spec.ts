/**
 * E2E: assert every /api/lsp/* route is registered in handleApiRoute().
 *
 * Context: a merge regression on a sibling branch silently dropped the
 * /api/lsp/* route handlers from server.ts::handleApiRoute() while leaving
 * LspSupervisor construction, the tool YAMLs, extension.ts, and the
 * agent system-prompt tool listing all intact. Every lsp_* call returned
 * HTTP 404 {"error":"Not found"}. The extension collapsed that into
 * lsp_unavailable. Agents saw "unavailable", reached for grep, and there
 * was no signal anything was broken.
 *
 * This test suite asserts the gateway routes are wired — not that the LSP
 * server is installed or functional. A 200 with body.error="lsp_unavailable"
 * is fine (supervisor not ready, binary not installed); a 404 is never fine.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

const LSP_METHODS = [
	"definition",
	"references",
	"hover",
	"diagnostics",
	"document_symbols",
	"workspace_symbol",
	"rename",
] as const;

/** Body to POST for each method. workspace_symbol and rename have different required params. */
function methodBody(method: string): Record<string, unknown> {
	if (method === "workspace_symbol") return { query: "add", cwd: FIXTURE };
	if (method === "rename") return { path: "src/math.ts", line: 0, character: 0, newName: "addRenamed", cwd: FIXTURE };
	return { path: "src/math.ts", line: 0, character: 0, cwd: FIXTURE };
}

const BENIGN_ERRORS = new Set(["lsp_unavailable", "lsp_capacity", "lsp_timeout"]);

test("GET /api/lsp/stats is registered (never 404)", async () => {
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status, "GET /api/lsp/stats must not be 404").not.toBe(404);
	expect(res.status).toBe(200);
});

test("GET /api/lsp/state is registered (never 404)", async () => {
	const params = new URLSearchParams({ cwd: FIXTURE, path: "src/math.ts" });
	const res = await apiFetch(`/api/lsp/state?${params}`, { method: "GET" });
	expect(res.status, "GET /api/lsp/state must not be 404").not.toBe(404);
	expect(res.status).toBe(200);
});

for (const method of LSP_METHODS) {
	test(`POST /api/lsp/${method} is registered (never 404)`, async () => {
		const res = await apiFetch(`/api/lsp/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(methodBody(method)),
		});
		// The route must exist (200). The body may be a tool result OR a
		// benign supervisor error — but never a raw 404 (route missing).
		expect(res.status, `POST /api/lsp/${method} must not be 404 — route block missing from handleApiRoute()?`).not.toBe(404);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		if (body && typeof body === "object" && "error" in body && body.error !== undefined) {
			expect(BENIGN_ERRORS, `body.error "${String(body.error)}" must be a known benign error`).toContain(body.error as string);
		}
	});
}
