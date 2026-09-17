/**
 * Gateway tests for the default authenticated localhost mode.
 *
 * The shared E2E gateway explicitly enables auth, matching the production
 * default. The separate request-admission integration suite pins the opt-in
 * `forceAuth: false` / `--no-auth` loopback escape hatch.
 */

import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { base, readE2EToken } from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

test.describe("Authenticated localhost", () => {
	test("health returns localhost: false when auth is required", async () => {
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

	test("unauthenticated requests are rejected by default", async () => {
		// Complementary to tools-e2e auth tests — confirms localhost requires auth.
		const res = await fetch(`${base()}/api/sessions`);
		expect(res.status).toBe(401);
	});
});
