/** API coverage split out of tests/e2e/ui/unseen-activity.spec.ts. */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

test.describe("Unseen-activity API", () => {
	test("mark-read endpoint returns 404 for unknown session", async () => {
		const resp = await apiFetch("/api/sessions/does-not-exist/mark-read", {
			method: "POST",
		});
		expect(resp.status).toBe(404);
	});
});
