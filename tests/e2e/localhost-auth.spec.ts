/**
 * E2E tests for the --auth flag and localhost mode health response.
 *
 * The main E2E server runs with --auth (forceAuth), so auth is enforced
 * even though it binds to 127.0.0.1. These tests verify that:
 *   - /api/health reports localhost: false when --auth is active
 *   - Auth enforcement works (complementing existing auth tests in tools-e2e)
 *
 * The actual auth *bypass* in localhost mode (no --auth) is pure conditional
 * logic — tested implicitly: if isLocalhostMode is true, the auth block is
 * skipped entirely. The --auth flag is the only toggle, and we verify it works.
 */

import { test, expect } from "./gateway-harness.js";
import { base, readE2EToken } from "./e2e-setup.js";

test.describe("Localhost auth flag", () => {
	test("health returns localhost: false when --auth is set", async () => {
		const token = readE2EToken();
		const res = await fetch(`${base()}/api/health`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.localhost).toBe(false);
		expect(data.status).toBe("ok");
	});

	test("health includes localhost field", async () => {
		const token = readE2EToken();
		const res = await fetch(`${base()}/api/health`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const data = await res.json();
		expect(typeof data.localhost).toBe("boolean");
	});

	test("unauthenticated requests are rejected when --auth is set", async () => {
		// Complementary to tools-e2e auth tests — confirms --auth forces auth
		const res = await fetch(`${base()}/api/sessions`);
		expect(res.status).toBe(401);
	});
});
