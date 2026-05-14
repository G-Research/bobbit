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

// ─────────────────────────────────────────────────────────────────────────────
// ORDERING INVARIANT — DO NOT REORDER THE FIRST /api/lsp/stats TEST
//
// The in-process harness fixture is worker-scoped: every test in this file
// shares ONE booted gateway. The regression test below ("is never 'pending'
// on immediate post-boot read") pins the contract that the FIRST external
// /api/lsp/stats call after start() must see a settled routeSelfCheck.
//
// If any other /api/lsp/stats call runs first, the supervisor's self-check
// promise will have already been awaited (or naturally settled by elapsed
// wall-time), and the regression test becomes a tautology that passes even
// if the await is removed from the stats handler. That is exactly the
// review finding that prompted this reorder — see goal fix-routes-1db8c87b,
// task "Make post-boot test immediate".
//
// Keep the immediate-post-boot regression test as the FIRST declared test
// in this file. The other stats tests (registration, 'ok', cap) must remain
// AFTER it.
// ─────────────────────────────────────────────────────────────────────────────

test("GET /api/lsp/stats is never 'pending' on immediate post-boot read", async () => {
	// Direct regression for goal fix-routes-1db8c87b: the previous fire-and-forget
	// boot ordering let /api/lsp/stats return routeSelfCheck === "pending" if the
	// caller read the route before the background self-check task settled.
	//
	// The fix awaits the supervisor's route-self-check promise inside the stats
	// handler (bounded by LSP_ROUTE_SELF_CHECK_STATS_CAP_MS). A single synchronous
	// fetch immediately after start() must therefore return a settled value.
	//
	// This MUST be the first test in the file — see the ordering banner above.
	// Status check (200) also subsumes the "not 404" registration assertion for
	// this route, so no separate /stats registration test runs ahead of it.
	//
	// This assertion is intentionally weaker than the 'ok' test below: any settled
	// state (ok / failed:...) is acceptable here. The point is that the route's
	// observability contract is honored — callers never see the in-progress sentinel.
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status, "GET /api/lsp/stats must not be 404").not.toBe(404);
	expect(res.status).toBe(200);
	const body = await res.json() as Record<string, unknown>;
	expect(
		body.routeSelfCheck,
		"routeSelfCheck must be settled — 'pending' means the stats handler did not await the self-check promise (goal fix-routes-1db8c87b)",
	).not.toBe("pending");
	expect(typeof body.routeSelfCheck, "routeSelfCheck must be a string").toBe("string");
});

test("GET /api/lsp/stats is registered (never 404)", async () => {
	// Registration check — runs AFTER the immediate-post-boot regression test
	// (see ordering banner above). By the time this runs the self-check has
	// settled, but the route registration assertion is independent of that.
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status, "GET /api/lsp/stats must not be 404").not.toBe(404);
	expect(res.status).toBe(200);
});

test("GET /api/lsp/stats reports routeSelfCheck: 'ok' after clean boot", async () => {
	// The post-boot loopback self-check probes /api/lsp/stats, /api/lsp/state, and
	// /api/lsp/diagnostics. On a clean in-process boot all three routes are registered
	// and the supervisor's routeSelfCheck field must be "ok".
	//
	// This used to race against the boot pipeline (lspRouteCheckTask was awaited only
	// after `start()` returned, so an immediate /api/lsp/stats could see "pending").
	// The fix (goal fix-routes-1db8c87b) makes /api/lsp/stats await the supervisor's
	// in-flight self-check promise with a bounded cap. No polling here — a single
	// synchronous read must see a settled "ok".
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

test("GET /api/lsp/stats returns within cap when self-check promise never settles", async ({ gateway }) => {
	// Hang-safety regression for goal fix-routes-1db8c87b: the stats handler awaits
	// the supervisor's routeSelfCheck promise, but bounds the wait with
	// LSP_ROUTE_SELF_CHECK_STATS_CAP_MS so a pathological never-settling probe cannot
	// hang /api/lsp/stats indefinitely. When the cap fires before the promise settles,
	// the route returns whatever the supervisor's current routeSelfCheck value is —
	// here we force it back to "pending" so the assertion is meaningful.
	// Import the SAME compiled server module the in-process harness booted, so the
	// cap override mutates the live module state. A static import from src/server
	// would be a *different* module instance and the override would be a no-op.
	const { __setLspRouteSelfCheckStatsCapMsForTesting } = await import("../../dist/server/server.js");

	const supervisor = gateway.sessionManager.getLspSupervisor();
	expect(supervisor, "supervisor must exist on the in-process gateway").toBeTruthy();

	const SHORT_CAP_MS = 150;
	// Wide upper bound — we just need to prove the route is bounded, not that it's
	// tight. CI scheduling jitter on slow runners can add tens of ms; 2000ms is
	// generous while still catching a regression that drops the cap entirely (which
	// would block on the never-settling promise and eventually time the test out).
	const MAX_OBSERVED_MS = 2000;

	// IMPORTANT: the boot self-check IIFE writes setRouteSelfCheck("ok") directly
	// when it succeeds, independently of which promise is published via
	// setRouteSelfCheckPromise(). If we install our hang before that IIFE finishes,
	// it can overwrite our "pending" sentinel mid-test. Wait for the boot probe to
	// fully settle, THEN install the hang.
	const priorPromise = supervisor.getRouteSelfCheckPromise();
	if (priorPromise) await priorPromise.catch(() => { /* boot probe already failed — fine, we're about to overwrite the sentinel */ });

	const neverSettles = new Promise<void>(() => { /* intentionally never resolves */ });
	supervisor.setRouteSelfCheckPromise(neverSettles);
	supervisor.setRouteSelfCheck("pending");
	__setLspRouteSelfCheckStatsCapMsForTesting(SHORT_CAP_MS);

	try {
		const startedAt = Date.now();
		const res = await apiFetch("/api/lsp/stats", { method: "GET" });
		const elapsed = Date.now() - startedAt;

		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(
			body.routeSelfCheck,
			"routeSelfCheck must remain 'pending' when the bounded wait expires before the promise settles",
		).toBe("pending");
		expect(
			elapsed,
			`/api/lsp/stats must return within the cap (${SHORT_CAP_MS}ms) when the self-check promise hangs — observed ${elapsed}ms`,
		).toBeLessThan(MAX_OBSERVED_MS);
		expect(
			elapsed,
			"if the route returned faster than the cap, the bounded await may not be running at all",
		).toBeGreaterThanOrEqual(SHORT_CAP_MS - 20); // tiny slack for timer rounding
	} finally {
		__setLspRouteSelfCheckStatsCapMsForTesting(undefined);
		supervisor.setRouteSelfCheckPromise(priorPromise);
		// Restore the supervisor's settled sentinel so later tests in this file (and any
		// retry) still observe the post-boot "ok" value.
		supervisor.setRouteSelfCheck("ok");
	}
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
