/**
 * E2E tests for the AI Gateway (aigw) REST API.
 *
 * These test the server-side /api/aigw/* endpoints including
 * configure, status, test, and proxy routes.
 */

import { test, expect } from "./gateway-harness.js";
import { apiFetch } from "./e2e-setup.js";

test.describe("AI Gateway API", () => {
	// Clean up after each test
	test.afterEach(async () => {
		await apiFetch("/api/aigw/configure", { method: "DELETE" });
	});

	test("GET /api/aigw/status returns unconfigured by default", async () => {
		const res = await apiFetch("/api/aigw/status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(false);
	});

	test("POST /api/aigw/configure rejects missing url", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/aigw/configure rejects unreachable gateway", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: "http://127.0.0.1:19999" }),
		});
		expect(res.status).toBe(502);
		const data = await res.json();
		expect(data.error).toBeTruthy();
	});

	test("POST /api/aigw/test rejects missing url", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/aigw/test rejects unreachable gateway", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: "http://127.0.0.1:19999" }),
		});
		expect(res.status).toBe(502);
	});

	test("DELETE /api/aigw/configure succeeds even when not configured", async () => {
		const res = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
	});

	test("proxy route returns 404-ish when not configured", async () => {
		// First make sure aigw is not configured
		await apiFetch("/api/aigw/configure", { method: "DELETE" });

		// The proxy route should not match when aigw is not configured,
		// so it falls through to the 404 handler
		const res = await apiFetch("/api/aigw/v1/models");
		// Should be 404 since the proxy route guard checks for aigw URL
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
