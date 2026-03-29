import { test, expect } from "./gateway-harness.js";
import { readE2EToken, base, nonGitCwd } from "./e2e-setup.js";

/**
 * E2E tests for PR cache invalidation.
 *
 * These tests verify the server has a mechanism to invalidate the PR null cache
 * and broadcast a `pr_status_changed` WebSocket event when a PR is created.
 *
 * Run with:
 *   npx playwright test tests/e2e/pr-cache.spec.ts --config playwright-e2e.config.ts
 */

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

test.beforeAll(() => {
	token = readE2EToken();
});

test("server broadcasts pr_status_changed on PR creation detection", async () => {
	// Create a goal with a branch
	const goalRes = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `PR cache test ${Date.now()}`,
			cwd: nonGitCwd(),
			branch: "test/pr-cache-branch",
			team: false,
		}),
	});
	expect(goalRes.status).toBe(201);
	const goal = await goalRes.json();

	try {
		// Prime the null cache by requesting PR status.
		// This will fail (no real git repo with that branch) and cache null for 5 min.
		await apiFetch(`/api/goals/${goal.id}/pr-status`);

		// The fix should add a POST /api/goals/:id/pr-cache-bust endpoint
		// (or similar mechanism) that invalidates the null cache and triggers
		// a pr_status_changed WS broadcast.
		const bustRes = await apiFetch(`/api/goals/${goal.id}/pr-cache-bust`, {
			method: "POST",
		});

		// This SHOULD return 200 after the fix. Currently returns 404 because
		// the endpoint doesn't exist — no pr_status_changed mechanism is in place.
		expect(
			bustRes.status,
			"Expected pr_status_changed mechanism to exist (POST pr-cache-bust should return 200)",
		).toBe(200);
	} finally {
		// Cleanup
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
	}
});
