/**
 * `403 SUBGOALS_DISABLED` server-gate coverage for the nine nested-goal
 * REST routes. With the system-scope flag OFF, every one of these routes
 * must short-circuit to `{code:"SUBGOALS_DISABLED"}` before any further
 * processing. With the flag ON, the gate is transparent (the request
 * proceeds and may fail for unrelated reasons — we just assert non-403).
 *
 * See docs/design/subgoals-experimental-toggle.md.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, gitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

/** Flip the system-scope subgoalsEnabled flag via PUT /api/preferences. */
async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

/** Create a parent-style goal with a worktree so route handlers can target it. */
async function createGoalReady(): Promise<{ id: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `subgoals-flag-test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	const settled = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `goal ${created.id} setup ready` },
	);
	return settled;
}

interface RouteCase {
	name: string;
	method: string;
	path: (goalId: string) => string;
	body?: Record<string, unknown>;
}

const ROUTES: RouteCase[] = [
	{ name: "spawn-child", method: "POST", path: (id) => `/api/goals/${id}/spawn-child`, body: { planId: "p1", title: "child", spec: "x" } },
	{ name: "plan PATCH", method: "PATCH", path: (id) => `/api/goals/${id}/plan`, body: { proposedSteps: [] } },
	{ name: "plan GET", method: "GET", path: (id) => `/api/goals/${id}/plan` },
	{ name: "integrate-child", method: "POST", path: (id) => `/api/goals/${id}/integrate-child/some-child` },
	{ name: "pause", method: "POST", path: (id) => `/api/goals/${id}/pause`, body: { cascade: false } },
	{ name: "resume", method: "POST", path: (id) => `/api/goals/${id}/resume`, body: { cascade: false } },
	{ name: "mutation decision", method: "POST", path: (id) => `/api/goals/${id}/mutation/req-1/decision`, body: { decision: "approve" } },
	{ name: "policy", method: "PATCH", path: (id) => `/api/goals/${id}/policy`, body: { divergencePolicy: "balanced" } },
	{ name: "tree-cost", method: "GET", path: (id) => `/api/goals/${id}/tree-cost` },
];

test.describe("Subgoals (Experimental) feature gate — REST routes", () => {
	test.afterEach(async () => {
		// Restore harness default for the next spec.
		await setSubgoalsEnabled(true);
	});

	test("all nine routes return 403 SUBGOALS_DISABLED when flag is off @smoke", async () => {
		await setSubgoalsEnabled(false);
		const goal = await createGoalReady();
		for (const route of ROUTES) {
			const opts: RequestInit = { method: route.method };
			if (route.body) opts.body = JSON.stringify(route.body);
			const resp = await apiFetch(route.path(goal.id), opts);
			expect(resp.status, `${route.name} status`).toBe(403);
			const json = await resp.json().catch(() => ({}));
			expect(json.code, `${route.name} code`).toBe("SUBGOALS_DISABLED");
		}
	});

	test("when flag is on, none of the nine routes return 403 SUBGOALS_DISABLED", async () => {
		await setSubgoalsEnabled(true);
		const goal = await createGoalReady();
		for (const route of ROUTES) {
			const opts: RequestInit = { method: route.method };
			if (route.body) opts.body = JSON.stringify(route.body);
			const resp = await apiFetch(route.path(goal.id), opts);
			// Many of these will fail for other reasons (404 child not found,
			// 400 missing body, 422 cascade required, …) — that's fine. We
			// just assert the gate didn't trip.
			if (resp.status === 403) {
				const json = await resp.json().catch(() => ({}));
				expect(json.code, `${route.name} should NOT be SUBGOALS_DISABLED with flag on`).not.toBe("SUBGOALS_DISABLED");
			}
		}
	});
});
