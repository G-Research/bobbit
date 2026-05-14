/**
 * E2E: gateway LSP routes round-trip against the host filesystem fixture.
 *
 * The supervisor pre-warm hook only fires for session-attached worktrees;
 * here we hit the routes directly, which is sufficient to validate the
 * gateway HTTP surface + supervisor + adapter wiring.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

test("GET /api/lsp/stats returns supervisor stats", async () => {
	const res = await apiFetch("/api/lsp/stats", { method: "GET" });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toHaveProperty("maxServers");
	expect(body).toHaveProperty("entries");
});

test("POST /api/lsp/diagnostics — clean → dirty → revert", async ({}, testInfo) => {
	// Allow CI / local environments without tsserver to opt out explicitly.
	// SKIP_LSP_E2E=1 is the ONLY legitimate way to skip these tests — not a
	// non-2xx stats response, which is the very regression we're guarding.
	if (process.env.SKIP_LSP_E2E) { testInfo.skip(); return; }

	const statsRes = await apiFetch("/api/lsp/stats");
	// Hard assertion: a 404 here means /api/lsp/* routes were dropped from
	// handleApiRoute() — exactly the regression this test exists to catch.
	expect(statsRes.status).toBe(200);

	const mathPath = path.join(FIXTURE, "src", "math.ts");
	const original = await fs.readFile(mathPath, "utf-8");

	try {
		const clean = await apiFetch("/api/lsp/diagnostics", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "src/math.ts", cwd: FIXTURE }),
		});
		expect(clean.status).toBe(200);
		const cleanBody = await clean.json();
		// lsp_unavailable means tsserver binary not running; let downstream
		// assertions fail with a clear message rather than silently skipping.
		// Use SKIP_LSP_E2E=1 to skip the whole test when the binary is absent.
		expect(Array.isArray(cleanBody)).toBe(true);
		expect(cleanBody.length).toBe(0);

		await fs.writeFile(mathPath, `export function add(a: number, b: number): number {\n\treturn a + b + "oops";\n}\n`, "utf-8");
		const dirty = await apiFetch("/api/lsp/diagnostics", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "src/math.ts", cwd: FIXTURE }),
		});
		const dirtyBody = await dirty.json();
		expect(Array.isArray(dirtyBody)).toBe(true);
		expect(dirtyBody.length).toBeGreaterThanOrEqual(1);

		await fs.writeFile(mathPath, original, "utf-8");
		const reverted = await apiFetch("/api/lsp/diagnostics", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "src/math.ts", cwd: FIXTURE }),
		});
		const revertedBody = await reverted.json();
		expect(Array.isArray(revertedBody)).toBe(true);
		expect(revertedBody.length).toBe(0);
	} finally {
		await fs.writeFile(mathPath, original, "utf-8");
	}
});

test("POST /api/lsp/definition resolves add() across files", async ({}, testInfo) => {
	// Allow CI / local environments without tsserver to opt out explicitly.
	if (process.env.SKIP_LSP_E2E) { testInfo.skip(); return; }

	// Warm-up: open math.ts by asking for its diagnostics. This forces
	// tsserver to add the file to its project, which is a prerequisite for
	// cross-file definition resolution from a separate file.
	await apiFetch("/api/lsp/diagnostics", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "src/math.ts", cwd: FIXTURE }),
	});

	// `const x = add(1, 2);` — line 2, character 10 in index.ts.
	const res = await apiFetch("/api/lsp/definition", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "src/index.ts", line: 2, character: 10, cwd: FIXTURE }),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	// lsp_unavailable means tsserver binary not running; let downstream
	// assertions fail rather than silently skipping.
	expect(body).toBeTruthy();
	if (!body || typeof body.path !== "string") throw new Error(`unexpected body: ${JSON.stringify(body)}`);
	expect(body.path.endsWith("math.ts")).toBe(true);
});
