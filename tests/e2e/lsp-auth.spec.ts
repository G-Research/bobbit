/**
 * E2E regression: the `/api/lsp/*` route surface refuses caller-supplied
 * `cwd` values that resolve outside any authorized project worktree.
 *
 * Security review 2026-05-15: an attacker holding a gateway bearer (admin
 * or sandbox-scoped) could otherwise ask the gateway to spawn tsserver at
 * arbitrary host paths. `tests/lsp/authorize-cwd.spec.ts` pins the helper;
 * this file pins the wiring — the routes MUST emit `lsp_forbidden_cwd`
 * with HTTP 403 before any LSP child is spawned.
 *
 * Sibling pin: `tests/e2e/lsp.spec.ts` still hits the host fixture under
 * `tests/fixtures/lsp-ts` (inside the gateway repo) and must keep passing.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

test("POST /api/lsp/diagnostics rejects cwd outside every authorized worktree", async () => {
	const res = await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cwd: "/etc", path: "passwd" }),
	});
	expect(res.status).toBe(403);
	const body = await res.json();
	expect(body.error).toBe("lsp_forbidden_cwd");
	expect(body.reason).toBe("cwd_outside_authorized_worktree");
});

test("POST /api/lsp/definition rejects an attacker-shaped cwd-prefix lookalike", async () => {
	// `<repo>-attacker` resolves outside the gateway repo even though it
	// shares the prefix with a legitimate worktree.
	const res = await apiFetch("/api/lsp/definition", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cwd: "/var-attacker/whatever", path: "x.ts", line: 0, character: 0 }),
	});
	expect(res.status).toBe(403);
	const body = await res.json();
	expect(body.error).toBe("lsp_forbidden_cwd");
});

test("POST /api/lsp/diagnostics with non-absolute cwd is rejected as 400", async () => {
	const res = await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cwd: "relative/path" }),
	});
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(body.error).toBe("lsp_forbidden_cwd");
	expect(body.reason).toBe("cwd_not_absolute");
});

test("POST /api/lsp/diagnostics with missing cwd is rejected as 400", async () => {
	const res = await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "src/x.ts" }),
	});
	expect(res.status).toBe(400);
	const body = await res.json();
	expect(body.error).toBe("lsp_forbidden_cwd");
	expect(body.reason).toBe("missing_cwd");
});

test("GET /api/lsp/state rejects cwd outside every authorized worktree", async () => {
	const res = await apiFetch(`/api/lsp/state?cwd=${encodeURIComponent("/usr/local/bin")}`, {
		method: "GET",
	});
	expect(res.status).toBe(403);
	const body = await res.json();
	expect(body.error).toBe("lsp_forbidden_cwd");
});
