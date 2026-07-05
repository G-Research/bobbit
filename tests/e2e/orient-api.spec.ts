/**
 * API E2E tests for the `orient` tool's backing endpoint (Finding W2.15).
 *
 * Covers:
 *   1. GET /api/internal/orient — missing X-Bobbit-Session-Id → 403.
 *   2. GET /api/internal/orient — unknown session id → 403.
 *   3. GET /api/internal/orient — happy path, no goal: session/project fields
 *      populated, goal is null.
 *   4. GET /api/internal/orient — happy path, goal-scoped session: goal
 *      fields populated and match the created goal.
 *
 * Mirrors the auth-enforcement + happy-path shape of
 * tests/e2e/mcp-meta-call.spec.ts's /api/internal/mcp-describe coverage.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, base, readE2EToken, createSession, createGoal, defaultProjectId, defaultProject } from "./e2e-setup.js";

test.describe("GET /api/internal/orient", () => {
	test("requires X-Bobbit-Session-Id", async () => {
		const token = readE2EToken();

		const noHeader = await fetch(`${base()}/api/internal/orient`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(noHeader.status).toBe(403);
		const noHeaderBody = await noHeader.json();
		expect(noHeaderBody.error).toMatch(/X-Bobbit-Session-Id/i);
	});

	test("unknown session id → 403", async () => {
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/orient`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": "no-such-session",
			},
		});
		expect(resp.status).toBe(403);
		const body = await resp.json();
		expect(body.error).toMatch(/not found/i);
	});

	test("happy path — session with no goal reports null goal + populated session/project/gateway", async () => {
		const projectId = await defaultProjectId();
		const project = await defaultProject();
		const sessionId = await createSession({ projectId });
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/orient`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();

		expect(body.session.id).toBe(sessionId);
		expect(body.session.goalId).toBeNull();
		expect(body.session.teamGoalId).toBeNull();
		expect(body.goal).toBeNull();

		expect(body.project).not.toBeNull();
		expect(body.project.id).toBe(projectId);
		expect(body.project.rootPath).toBe(project.rootPath);

		expect(typeof body.gateway.version).toBe("string");
		expect(body.gateway.version.length).toBeGreaterThan(0);
		expect(typeof body.gateway.tokenPath).toBe("string");
		expect(body.gateway.tokenPath).toMatch(/token$/);

		expect(Array.isArray(body.apiRouteFamilies)).toBe(true);
		expect(body.apiRouteFamilies.length).toBeGreaterThan(0);
		for (const entry of body.apiRouteFamilies) {
			expect(typeof entry.family).toBe("string");
			expect(entry.example).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\//);
		}
	});

	test("happy path — goal-scoped session reports matching goal fields", async () => {
		const projectId = await defaultProjectId();
		const goal = await createGoal({ title: "orient e2e goal", projectId });
		const sessionId = await createSession({ projectId, goalId: goal.id });
		const token = readE2EToken();

		const resp = await fetch(`${base()}/api/internal/orient`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Bobbit-Session-Id": sessionId,
			},
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();

		expect(body.session.goalId).toBe(goal.id);
		expect(body.goal).not.toBeNull();
		expect(body.goal.id).toBe(goal.id);
		expect(body.goal.title).toBe("orient e2e goal");
		// `branch` is only assigned when a real git worktree is set up (not the
		// case for this non-git-cwd test fixture) — assert type, not a value.
		expect(body.goal.branch === null || typeof body.goal.branch === "string").toBe(true);

		await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	});
});
