// Ported from tests/e2e/pr-cache.spec.ts (v2-integration tier).
//
// The server invalidates the PR null-cache and broadcasts a `pr_status_changed`
// WebSocket event when PR-creation is detected. The mechanism is exposed via
// POST /api/goals/:id/pr-cache-bust, which deletes the cached entry and calls
// broadcastToAll({ type: "pr_status_changed", goalId }).
//
// The legacy repro asserted only that the bust endpoint returns 200. This port
// keeps that assertion and additionally proves the named behaviour — the
// pr_status_changed broadcast reaches connected clients — via a session WS
// (broadcastToAll fans out to every authenticated socket regardless of session).
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";

test("server broadcasts pr_status_changed on PR creation detection", async () => {
	// Create a goal with a branch.
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

	// A live client to observe the broadcast (fanned out to all authed sockets).
	const sessionId = await createSession();
	const ws = await connectWs(sessionId);
	try {
		const cursor = ws.messageCount();

		// Prime the null cache by requesting PR status (no real repo → cached null).
		await apiFetch(`/api/goals/${goal.id}/pr-status`);

		// Bust the cache → 200 + pr_status_changed broadcast.
		const bustRes = await apiFetch(`/api/goals/${goal.id}/pr-cache-bust`, {
			method: "POST",
		});
		expect(
			bustRes.status,
			"POST pr-cache-bust should invalidate the null cache and return 200",
		).toBe(200);

		const evt = await ws.waitForFrom(
			cursor,
			(m) => m.type === "pr_status_changed" && m.goalId === goal.id,
			10_000,
		);
		expect(evt.type).toBe("pr_status_changed");
		expect(evt.goalId).toBe(goal.id);
	} finally {
		ws.close();
		await deleteSession(sessionId);
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
	}
});
