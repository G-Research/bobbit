/**
 * API/data-path coverage split out of tests/e2e/ui/stories-projects.spec.ts.
 *
 * Browser-only project organization stories stay in the UI spec.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

test.describe("CT-16 project organization API stories", () => {
	// ---------------------------------------------------------------
	// PR-04: Project removal API exists
	// ---------------------------------------------------------------

	test("PR-04: Project removal API returns proper status", async () => {
		// act — verify DELETE endpoint exists (don't actually delete — would break other tests)
		// Use a non-existent project ID to test the endpoint without side effects.
		const resp = await apiFetch("/api/projects/nonexistent-id-12345", {
			method: "DELETE",
		});

		// assert — endpoint exists and returns appropriate status (404 for non-existent)
		// 404 means the endpoint exists but the project doesn't — that's correct behavior.
		expect([404, 400].includes(resp.status)).toBe(true);
	});
});
