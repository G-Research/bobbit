/**
 * `POST /api/goals/:id/spawn-child` — route-level wiring tests.
 *
 * Covers the fixes that landed in 0f7e6a64, 7491041c, and 00d6805f
 * without dedicated route-level coverage:
 *
 *   1. `X-Bobbit-Spawning-Session` header → stamps `spawnedBySessionId`
 *      on the persisted child (header path).
 *   2. `body.spawnedBySessionId` → stamped when no header present
 *      (body fallback path).
 *   3. Header wins over body when both are supplied (header is the
 *      authoritative source — defends against forwarded requests
 *      rewriting the body).
 *   4. `body.suggestedRole` → persisted on the child goal (commit
 *      7491041c reinstated this after it had been `void`'d).
 *   5. `spawnedFromPlanId` is stamped (existing Lesson 4.1 invariant —
 *      atomic with `createGoal`, no awaits between).
 *   6. Child goal's `cwd` is derived from `parent.repoPath` (NOT
 *      `parent.cwd`) so children don't inherit the parent's worktree
 *      path and end up nested under `<parent-worktree>-wt/`.
 *   7. Setup-trigger: `setupWorktreeAndStartTeam` is invoked after
 *      spawn-child so the child doesn't sit in `setupStatus="preparing"`
 *      forever (the showstopper bug from 0f7e6a64).
 *
 * Mirrors the in-process harness import pattern from
 * `tests/e2e/gates-api.spec.ts`.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	gitCwd,
	rawApiFetch,
	readE2EToken,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let token: string;

test.beforeAll(() => {
	token = readE2EToken();
});

/** Build a header set including the auth token. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(extra ?? {}),
	};
}

/**
 * Create a parent goal in a real git repo so it gets a worktree
 * (`worktreePath`, `repoPath`, `branch`). Use `autoStartTeam: false` so
 * the team-lead doesn't actually spawn — we only need the goal record.
 */
async function createParentGoal(): Promise<{ id: string; cwd: string; repoPath?: string; worktreePath?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `spawn-child route parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	// Wait for setupStatus to settle — we need repoPath and worktreePath
	// stamped before the spawn-child handler reads them.
	const settled = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
	return settled;
}

/** Read the persisted child goal directly via REST. */
async function readGoal(goalId: string): Promise<any> {
	const r = await apiFetch(`/api/goals/${goalId}`);
	expect(r.status).toBe(200);
	return r.json();
}

/**
 * POST to /api/goals/:id/spawn-child via rawApiFetch so we can pass
 * arbitrary headers (and not have the harness mutate the body).
 */
async function spawnChildRaw(opts: {
	parentId: string;
	body: Record<string, unknown>;
	headers?: Record<string, string>;
}): Promise<{ status: number; body: any }> {
	const resp = await rawApiFetch(`/api/goals/${opts.parentId}/spawn-child`, {
		method: "POST",
		headers: authHeaders(opts.headers),
		body: JSON.stringify(opts.body),
	});
	const text = await resp.text();
	let body: any;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: resp.status, body };
}

test.describe("POST /api/goals/:id/spawn-child — route wiring", () => {
	test("X-Bobbit-Spawning-Session header → stamps spawnedBySessionId @smoke", async () => {
		const parent = await createParentGoal();
		const sessionId = `sess-header-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": sessionId },
				body: {
					planId: "plan-header-1",
					title: "Child via header",
					spec: "header-path child spec",
				},
			});
			expect(status).toBe(201);
			expect(body.id).toBeTruthy();
			expect(body.spawnedBySessionId).toBe(sessionId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);
			expect(child.parentGoalId).toBe(parent.id);
			expect(child.spawnedFromPlanId).toBe("plan-header-1");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("body.spawnedBySessionId fallback → stamped when no header", async () => {
		const parent = await createParentGoal();
		const sessionId = `sess-body-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				// No X-Bobbit-Spawning-Session header.
				body: {
					planId: "plan-body-1",
					title: "Child via body",
					spec: "body-fallback child spec",
					spawnedBySessionId: sessionId,
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(sessionId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("header wins over body when both present", async () => {
		const parent = await createParentGoal();
		const headerSession = `sess-header-${Date.now()}`;
		const bodySession = `sess-body-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": headerSession },
				body: {
					planId: "plan-precedence-1",
					title: "Header-wins child",
					spec: "precedence test",
					spawnedBySessionId: bodySession,
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(headerSession);
			expect(body.spawnedBySessionId).not.toBe(bodySession);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(headerSession);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("suggestedRole body field → persisted on the child goal", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-role-1",
					title: "Role-suggested child",
					spec: "suggested-role spec",
					suggestedRole: "test-engineer",
				},
			});
			expect(status).toBe(201);
			// Response echoes the role back so callers can confirm it landed
			// (commit 7491041c — was previously void'd at server.ts:3356).
			expect(body.suggestedRole).toBe("test-engineer");

			const child = await readGoal(body.id);
			expect(child.suggestedRole).toBe("test-engineer");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("spawnedFromPlanId is stamped atomically with createGoal (Lesson 4.1)", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-lesson-4-1",
					title: "Lesson 4.1 child",
					spec: "lesson 4.1 spec",
				},
			});
			expect(status).toBe(201);

			// The persisted record MUST carry spawnedFromPlanId — by the time
			// we can read it back through the REST API the synchronous
			// updateGoal that follows createGoal must have completed.
			const child = await readGoal(body.id);
			expect(child.spawnedFromPlanId).toBe("plan-lesson-4-1");
			expect(child.parentGoalId).toBe(parent.id);

			// Idempotency: a second call with the same planId must return the
			// same child id without creating a duplicate record (the handler's
			// idempotency branch keys on (parentGoalId, spawnedFromPlanId)).
			const second = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-lesson-4-1",
					title: "Lesson 4.1 child",
					spec: "lesson 4.1 spec",
				},
			});
			expect(second.status).toBe(200);
			expect(second.body.alreadyExists).toBe(true);
			expect(second.body.id).toBe(body.id);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("child cwd derived from parent.repoPath, not parent.cwd (no nested -wt/)", async () => {
		const parent = await createParentGoal();
		// Sanity: the parent must have BOTH a worktreePath and a repoPath
		// for the invariant to be testable. If either is absent (e.g. the
		// harness env doesn't produce a worktree), the parent.repoPath-vs-
		// parent.cwd distinction collapses to a trivially-true tautology
		// and we skip cleanly. Note: we do NOT skip on parent.cwd ===
		// parent.repoPath because that's actually possible AND meaningful
		// (sub-package roots), but here we want a worktree-vs-root
		// difference, so both must be present.
		if (!parent.worktreePath || !parent.repoPath) {
			test.skip(true, `Parent missing worktree (worktreePath=${parent.worktreePath}, repoPath=${parent.repoPath})`);
			return;
		}

		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-repopath-1",
					title: "RepoPath child",
					spec: "repoPath derivation",
				},
			});
			expect(status).toBe(201);

			const child = await readGoal(body.id);
			// The handler's invariant: child.cwd is derived from
			// parent.repoPath (with monorepo offset preserved), NOT from
			// parent.cwd. The child gets its OWN worktree under the same
			// `<root>-wt/` parent — never under `<parent-worktree>-wt/`.
			expect(child.repoPath).toBe(parent.repoPath);
			// The child's own worktree path must NOT be a sub-path of the
			// parent's worktree path (which would mean the new repoPath
			// resolved through the parent's worktree).
			if (child.worktreePath) {
				expect(child.worktreePath.startsWith(parent.worktreePath)).toBe(false);
			}

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("setup is triggered: child does NOT sit in setupStatus=preparing forever", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-setup-1",
					title: "Setup-triggered child",
					spec: "setup trigger smoke",
				},
			});
			expect(status).toBe(201);
			const childId = body.id;

			// The showstopper bug from 0f7e6a64: the handler created the
			// child record but never called setupWorktreeAndStartTeam, so
			// the child's setupStatus stayed "preparing" forever. After the
			// fix, setup is initiated and the status moves off "preparing"
			// — either to "ready" (worktree created OK) or "error" (a
			// downstream step failed). The bug repro is "stays preparing
			// indefinitely"; either of the post-fix outcomes is enough to
			// confirm setup was actually initiated.
			const settled = await pollUntil(
				async () => {
					const g = await readGoal(childId);
					return g.setupStatus && g.setupStatus !== "preparing" ? g : null;
				},
				{ timeoutMs: 30_000, intervalMs: 100, label: `child ${childId} setupStatus moves off preparing` },
			);
			expect(settled.setupStatus === "ready" || settled.setupStatus === "error").toBe(true);

			await deleteGoal(childId);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("missing planId / title / spec → 400 with actionable error", async () => {
		const parent = await createParentGoal();
		try {
			// Missing planId
			const r1 = await spawnChildRaw({
				parentId: parent.id,
				body: { title: "no-planId", spec: "spec" },
			});
			expect(r1.status).toBe(400);
			expect(String(r1.body.error || "")).toMatch(/planId/i);

			// Missing title
			const r2 = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-x", spec: "spec" },
			});
			expect(r2.status).toBe(400);
			expect(String(r2.body.error || "")).toMatch(/title/i);

			// Missing spec
			const r3 = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-x", title: "title" },
			});
			expect(r3.status).toBe(400);
			expect(String(r3.body.error || "")).toMatch(/spec/i);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("absent header AND absent body → child has no spawnedBySessionId", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-absent-1",
					title: "No session-id child",
					spec: "no session linkage",
				},
			});
			expect(status).toBe(201);
			// Response carries an undefined spawnedBySessionId (legacy callers
			// without session context fall through to parent-level rendering).
			expect(body.spawnedBySessionId == null).toBe(true);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId == null).toBe(true);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});
});

