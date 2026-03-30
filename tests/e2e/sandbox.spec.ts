/**
 * E2E tests for Docker Sandbox API endpoints.
 *
 * These tests verify the sandbox REST API layer — they do NOT require Docker
 * to be installed or running. They test configuration, validation, and status
 * endpoints that work regardless of Docker availability.
 */
import { test, expect } from "./gateway-harness.js";
import { readE2EToken, base, nonGitCwd } from "./e2e-setup.js";

let _tok: string;
function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

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

test.describe("Docker Sandbox", () => {
	test("GET /api/sandbox-status returns correct shape", async () => {
		const res = await apiFetch("/api/sandbox-status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("configured");
		expect(data).toHaveProperty("available");
		expect(typeof data.configured).toBe("boolean");
		expect(typeof data.available).toBe("boolean");
		// Default config is sandbox: "none", so configured should be false
		expect(data.configured).toBe(false);
	});

	test("POST /api/sessions with sandboxed=true fails when sandbox not configured", async () => {
		const res = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				sandboxed: true,
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("not configured");
	});

	test("POST /api/web-proxy/search with missing query returns 400", async () => {
		const res = await apiFetch("/api/web-proxy/search", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("query");
	});

	test("POST /api/web-proxy/fetch with invalid URL returns 400", async () => {
		const res = await apiFetch("/api/web-proxy/fetch", {
			method: "POST",
			body: JSON.stringify({ url: "ftp://invalid" }),
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("http");
	});

	test("POST /api/web-proxy/fetch with missing URL returns 400", async () => {
		const res = await apiFetch("/api/web-proxy/fetch", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toContain("url");
	});

	test("GET /api/sandbox-status reflects config changes", async () => {
		// Initially configured should be false
		const res1 = await apiFetch("/api/sandbox-status");
		const data1 = await res1.json();
		expect(data1.configured).toBe(false);

		// Set sandbox to "docker"
		const putRes = await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "docker" }),
		});
		expect(putRes.status).toBe(200);

		// Now configured should be true
		const res2 = await apiFetch("/api/sandbox-status");
		expect(res2.status).toBe(200);
		const data2 = await res2.json();
		expect(data2.configured).toBe(true);

		// Clean up — reset to "none"
		await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: "none" }),
		});
	});
});
