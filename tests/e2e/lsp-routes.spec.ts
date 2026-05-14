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

test("GET /api/lsp/stats reports routeSelfCheck: 'ok' after clean boot", async () => {
	// The post-boot loopback self-check probes /api/lsp/stats, /api/lsp/state, and
	// /api/lsp/diagnostics. On a clean in-process boot all three routes are registered
	// and the supervisor's routeSelfCheck field must be "ok".
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status).toBe(200);
	const body = await res.json() as Record<string, unknown>;
	expect(body.routeSelfCheck, "routeSelfCheck must be 'ok' — if 'pending' the check did not run; if 'failed:...' a route is missing").toBe("ok");
});

test("GET /api/lsp/state is registered (never 404)", async () => {
	const params = new URLSearchParams({ cwd: FIXTURE, path: "src/math.ts" });
	const res = await apiFetch(`/api/lsp/state?${params}`, { method: "GET" });
	expect(res.status, "GET /api/lsp/state must not be 404").not.toBe(404);
	expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// Telemetry: adoption counters on /api/lsp/stats
//
// Design: docs/design (Goal: LSP adoption telemetry). LspSupervisor maintains
// process-local counters incremented on every dispatch() and via an internal
// hint-emitted endpoint called by grep/bash hint extensions. /api/lsp/stats
// exposes them under `counters`. Boot self-check may have already incremented
// `diagnostics` and `lspCallsTotal`, so all assertions use deltas.
// ---------------------------------------------------------------------------

interface TelemetryCounters {
	lspCallsTotal: number;
	lspCallsByMethod: Record<string, number>;
	lspCallsByStatus: Record<string, number>;
	grepLspHintEmittedTotal: number;
}

async function getCounters(): Promise<TelemetryCounters> {
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status).toBe(200);
	const body = await res.json() as { counters?: TelemetryCounters };
	expect(body.counters, "/api/lsp/stats must expose a `counters` object").toBeDefined();
	return body.counters as TelemetryCounters;
}

test("GET /api/lsp/stats exposes telemetry counters with stable shape", async () => {
	const counters = await getCounters();
	expect(typeof counters.lspCallsTotal).toBe("number");
	expect(counters.lspCallsByMethod, "lspCallsByMethod must be an object").toBeTruthy();
	expect(counters.lspCallsByStatus, "lspCallsByStatus must be an object").toBeTruthy();
	expect(typeof counters.grepLspHintEmittedTotal).toBe("number");
	// Known method keys are pre-initialized so the shape is stable before any calls.
	for (const m of LSP_METHODS) {
		expect(typeof counters.lspCallsByMethod[m], `lspCallsByMethod.${m} must be initialized to a number`).toBe("number");
	}
	for (const s of ["ok", "lsp_unavailable", "lsp_capacity", "lsp_timeout", "lsp_route_missing", "error"]) {
		expect(typeof counters.lspCallsByStatus[s], `lspCallsByStatus.${s} must be initialized to a number`).toBe("number");
	}
});

test("POST /api/lsp/diagnostics increments lspCallsTotal and lspCallsByMethod.diagnostics", async () => {
	const before = await getCounters();
	const res = await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "src/math.ts", cwd: FIXTURE }),
	});
	expect(res.status).toBe(200);
	// Drain body so the request fully completes before re-reading stats.
	await res.json();
	const after = await getCounters();
	expect(after.lspCallsTotal - before.lspCallsTotal, "lspCallsTotal must increment by 1").toBe(1);
	expect((after.lspCallsByMethod.diagnostics ?? 0) - (before.lspCallsByMethod.diagnostics ?? 0), "lspCallsByMethod.diagnostics must increment by 1").toBe(1);
});

test("POST /api/lsp/diagnostics with path outside worktree increments lspCallsByStatus.lsp_unavailable", async () => {
	const before = await getCounters();
	const res = await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// Absolute path well outside the fixture's worktree triggers the
		// supervisor's path-containment guard → lsp_unavailable.
		body: JSON.stringify({ path: "/etc/hostname", cwd: FIXTURE }),
	});
	expect(res.status).toBe(200);
	await res.json();
	const after = await getCounters();
	expect(
		(after.lspCallsByStatus.lsp_unavailable ?? 0) - (before.lspCallsByStatus.lsp_unavailable ?? 0),
		"lspCallsByStatus.lsp_unavailable must increment by 1",
	).toBe(1);
});

test("POST /api/lsp/_internal/hint-emitted increments grepLspHintEmittedTotal", async () => {
	const before = await getCounters();
	const res = await apiFetch("/api/lsp/_internal/hint-emitted", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	expect(res.status, "/api/lsp/_internal/hint-emitted must be a registered route").not.toBe(404);
	expect(res.status).toBe(200);
	await res.json().catch(() => undefined);
	const after = await getCounters();
	expect(
		after.grepLspHintEmittedTotal - before.grepLspHintEmittedTotal,
		"grepLspHintEmittedTotal must increment by 1",
	).toBe(1);
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
