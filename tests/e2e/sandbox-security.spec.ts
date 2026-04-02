/**
 * Sandbox Security Boundary E2E Tests
 *
 * Verifies that sandbox-scoped tokens are properly restricted by the
 * HTTP middleware (sandbox-guard.ts). No Docker required — tests use
 * the in-process gateway's live SandboxTokenStore to register scoped
 * tokens and make real HTTP requests against the gateway.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, nonGitCwd } from "./e2e-setup.js";

// Helper to make requests with admin token
function adminFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	return fetch(`${baseURL}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${readE2EToken()}`, ...(opts.headers as Record<string, string>) },
	});
}

// Helper to make requests with sandbox-scoped token
function sandboxFetch(baseURL: string, path: string, token: string, opts: RequestInit = {}) {
	return fetch(`${baseURL}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers as Record<string, string>) },
	});
}

test.describe("Sandbox Security Boundaries", () => {
	let scopedToken: string;
	let sessionId: string;
	const goalId = "test-goal-id";

	test.beforeAll(async ({ gateway }) => {
		// Create a real session via admin token
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		sessionId = data.id;

		// Register a sandbox-scoped token in the LIVE gateway's SandboxTokenStore
		scopedToken = gateway.sessionManager.sandboxTokenStore.register(sessionId, goalId);
	});

	test.afterAll(async ({ gateway }) => {
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	});

	// ── BLOCKED endpoints ──────────────────────────────────────────────

	test("cannot list sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read project config", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/project-config", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot write project config", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/project-config", scopedToken, {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		});
		expect(res.status).toBe(403);
	});

	test("cannot read roles", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/roles", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read MCP servers", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/mcp-servers", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot read preferences", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/preferences", scopedToken);
		expect(res.status).toBe(403);
	});

	test("bg-processes blocked on own session", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, scopedToken, {
			method: "POST",
			body: JSON.stringify({ command: "echo hello" }),
		});
		expect(res.status).toBe(403);
	});

	test("cannot access other sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions/nonexistent-other", scopedToken);
		expect(res.status).toBe(403);
	});

	test("cannot access other goals", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/goals/other-goal-id/gates", scopedToken);
		expect(res.status).toBe(403);
	});

	// ── ALLOWED endpoints ──────────────────────────────────────────────

	test("can access own session", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, `/api/sessions/${sessionId}`, scopedToken);
		expect(res.status).toBe(200);
	});

	test("can access health endpoint", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/health", scopedToken);
		expect(res.status).toBe(200);
	});

	test("can create delegate sessions", async ({ gateway }) => {
		const res = await sandboxFetch(gateway.baseURL, "/api/sessions", scopedToken, {
			method: "POST",
			body: JSON.stringify({ delegateOf: sessionId, instructions: "test delegate", cwd: nonGitCwd() }),
		});
		// Should be 201 (created) — server forces sandboxed=true
		expect(res.status).toBe(201);
		const data = await res.json();
		// Clean up the delegate session
		await adminFetch(gateway.baseURL, `/api/sessions/${data.id}`, { method: "DELETE" }).catch(() => {});
	});

	// ── Token persistence check ────────────────────────────────────────

	test("sandbox token not persisted to disk", async ({ gateway }) => {
		const fs = await import("node:fs");
		const path = await import("node:path");

		// Recursively read all files in the bobbit state dir
		function readAllFiles(dir: string): string[] {
			const contents: string[] = [];
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						contents.push(...readAllFiles(fullPath));
					} else if (entry.isFile()) {
						try {
							contents.push(fs.readFileSync(fullPath, "utf-8"));
						} catch { /* skip binary/unreadable */ }
					}
				}
			} catch { /* skip inaccessible dirs */ }
			return contents;
		}

		const allContent = readAllFiles(gateway.bobbitDir).join("\n");
		expect(allContent).not.toContain(scopedToken);
	});
});
