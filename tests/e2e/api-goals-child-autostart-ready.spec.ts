/**
 * `POST /api/goals` child auto-start — data-only / non-git children.
 *
 * Regression: the child auto-start branch only requested the child-team start
 * when `goal.setupStatus === "preparing"`. A data-only / non-git child is
 * created `setupStatus === "ready"` (no worktree to prepare), so the start was
 * silently skipped and its team never ran. The fix gates on
 * `goal.state !== "blocked"` instead, routing both `preparing` and `ready`
 * children through the per-root scheduler (`verificationHarness.requestChildStart`).
 *
 * These tests spy on `requestChildStart` (stubbing it so no real team spawns)
 * and assert:
 *   1. A `ready` (non-git) child with `autoStartTeam:true` + `parentGoalId`
 *      DOES request a scheduler start.
 *   2. A `ready` child with `autoStartTeam:false` does NOT (control — the
 *      auto-start branch is gated on autoStartTeam).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, assertStaysFalse, deleteGoal, nonGitCwd, waitForCondition } from "./e2e-setup.js";

let harness: any;
/** childGoalIds passed to the spied requestChildStart. */
let startRequests: string[];
let originalRequestChildStart: ((childGoalId: string) => "started" | "capacity-blocked") | undefined;

test.beforeAll(async ({ gateway }) => {
	harness = (gateway.sessionManager as any)._verificationHarness;
	expect(harness, "verification harness wired on session manager").toBeTruthy();
});

test.beforeEach(() => {
	startRequests = [];
	// Stub requestChildStart so we record the call WITHOUT actually starting a
	// real team (which would spawn agents + worktree work). Returns "started".
	originalRequestChildStart = harness.requestChildStart.bind(harness);
	harness.requestChildStart = (childGoalId: string) => {
		startRequests.push(childGoalId);
		return "started" as const;
	};
});

test.afterEach(() => {
	if (originalRequestChildStart) harness.requestChildStart = originalRequestChildStart;
});

/** Create a non-git parent goal (no worktree) so its children are data-only. */
async function createParent(): Promise<{ id: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `child-autostart parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: nonGitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
			spec: "Parent goal for the data-only child auto-start regression test — non-git cwd so children are ready.",
		}),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

test.describe("POST /api/goals — data-only child auto-start (state !== blocked, not setupStatus==preparing)", () => {
	test("a ready (non-git) child with autoStartTeam requests a scheduler start @smoke", async () => {
		const parent = await createParent();
		let childId: string | undefined;
		try {
			const resp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `data-only child ${Date.now()}`,
					cwd: nonGitCwd(),
					parentGoalId: parent.id,
					autoStartTeam: true,
					workflowId: "feature",
					spec: "Data-only child: verify a ready (non-git) child still has its team started via the per-root scheduler.",
				}),
			});
			expect(resp.status).toBe(201);
			const child = await resp.json();
			childId = child.id;
			// Precondition for the bug: the child really is 'ready' (no worktree).
			expect(child.setupStatus).toBe("ready");

			// The start request fires synchronously after the 201 is written, but
			// poll to be robust against scheduling.
			await waitForCondition(() => startRequests.includes(childId!), {
				timeoutMs: 5_000,
				message: `requestChildStart called for ready child ${childId}`,
			});
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});

	test("a ready child with autoStartTeam:false does NOT request a start (control)", async () => {
		const parent = await createParent();
		let childId: string | undefined;
		try {
			const resp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `no-autostart child ${Date.now()}`,
					cwd: nonGitCwd(),
					parentGoalId: parent.id,
					autoStartTeam: false,
					workflowId: "feature",
					spec: "Control child: autoStartTeam:false must not request a scheduler start even when the child is ready.",
				}),
			});
			expect(resp.status).toBe(201);
			const child = await resp.json();
			childId = child.id;
			expect(child.setupStatus).toBe("ready");

			// Give the (non-)start a window to fire, then assert it never did.
			await assertStaysFalse(() => startRequests.includes(childId!), {
				durationMs: 300,
				message: `requestChildStart must NOT fire for autoStartTeam:false child ${childId}`,
			});
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});
});
