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
import { test, expect } from "../../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch, assertStaysFalse, deleteGoal, nonGitCwd, waitForCondition } from "../../../../tests/support/harnesses/integration/gateway/e2e-setup.js";

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

test.describe("POST /api/goals/:id/retry-setup — child scheduler and recovered setup state", () => {
	test("a dependency-blocked auto-start child repairs setup without requesting a team", async ({ gateway }) => {
		const parent = await createParent();
		let childId: string | undefined;
		const context = gateway.projectContextManager.getContextForGoal(parent.id);
		const goalManager = context.goalManager as any;
		const originalSetupWorktree = goalManager.setupWorktree;
		let setupCalls = 0;
		try {
			const createChild = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `blocked retry child ${Date.now()}`,
					cwd: nonGitCwd(),
					parentGoalId: parent.id,
					autoStartTeam: false,
					workflowId: "feature",
					spec: "Blocked child setup retry must repair its worktree but wait for dependency scheduling before starting a team.",
				}),
			});
			expect(createChild.status).toBe(201);
			childId = (await createChild.json()).id;
			context.goalStore.update(childId, { autoStartTeam: true, state: "blocked" });
			context.goalStore.transitionSetup(childId, "error", "simulated setup failure");

			goalManager.setupWorktree = async (goalId: string) => {
				setupCalls++;
				context.goalStore.transitionSetup(goalId, "ready");
			};
			const retry = await apiFetch(`/api/goals/${childId}/retry-setup`, { method: "POST" });
			expect(retry.status).toBe(200);
			expect(await retry.json()).toMatchObject({ ok: true, coalesced: false, setupStatus: "retrying" });
			await waitForCondition(() => context.goalStore.get(childId!)?.setupStatus === "ready", {
				message: "blocked child setup retry reaches ready",
			});

			expect(setupCalls).toBe(1);
			expect(startRequests).not.toContain(childId);
			expect(gateway.teamManager.getTeamState(childId)).toBeUndefined();
			expect(context.goalStore.get(childId)?.state).toBe("blocked");
		} finally {
			goalManager.setupWorktree = originalSetupWorktree;
			if (childId) await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});

	test("an orphaned preparing status reports an actionable conflict instead of false coalesced success", async ({ gateway }) => {
		const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
		const goalManager = context.goalManager as any;
		const originalSetupWorktree = goalManager.setupWorktree;
		let setupCalls = 0;
		let goalId: string | undefined;
		try {
			const create = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `orphan preparing retry ${Date.now()}`,
					cwd: nonGitCwd(),
					autoStartTeam: false,
					workflowId: "feature",
					spec: "A persisted preparing setup without an in-memory setup flight must not pretend that retry was coalesced.",
				}),
			});
			expect(create.status).toBe(201);
			goalId = (await create.json()).id;
			context.goalStore.transitionSetup(goalId, "preparing");
			goalManager.setupWorktree = async () => { setupCalls++; };

			const retry = await apiFetch(`/api/goals/${goalId}/retry-setup`, { method: "POST" });
			expect(retry.status).toBe(409);
			expect(await retry.json()).toMatchObject({
				setupStatus: "preparing",
				error: expect.stringContaining("no active setup flight"),
			});
			expect(setupCalls).toBe(0);
		} finally {
			goalManager.setupWorktree = originalSetupWorktree;
			if (goalId) await deleteGoal(goalId);
		}
	});

	test("an orphaned retrying status starts one recovery setup instead of false coalesced success", async ({ gateway }) => {
		const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
		const goalManager = context.goalManager as any;
		const originalSetupWorktree = goalManager.setupWorktree;
		let setupCalls = 0;
		let goalId: string | undefined;
		try {
			const create = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `orphan retrying recovery ${Date.now()}`,
					cwd: nonGitCwd(),
					autoStartTeam: false,
					workflowId: "feature",
					spec: "A persisted retrying setup without an in-memory flight must resume setup when the retry endpoint is invoked.",
				}),
			});
			expect(create.status).toBe(201);
			goalId = (await create.json()).id;
			context.goalStore.transitionSetup(goalId, "retrying");
			goalManager.setupWorktree = async (id: string) => {
				setupCalls++;
				context.goalStore.transitionSetup(id, "ready");
			};

			const retry = await apiFetch(`/api/goals/${goalId}/retry-setup`, { method: "POST" });
			expect(retry.status).toBe(200);
			expect(await retry.json()).toMatchObject({ ok: true, coalesced: false, setupStatus: "retrying" });
			await waitForCondition(() => context.goalStore.get(goalId!)?.setupStatus === "ready", {
				message: "orphaned retrying setup reaches ready",
			});
			expect(setupCalls).toBe(1);
		} finally {
			goalManager.setupWorktree = originalSetupWorktree;
			if (goalId) await deleteGoal(goalId);
		}
	});

	test("concurrent retry posts coalesce their route continuation", async ({ gateway }) => {
		const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
		const goalManager = context.goalManager as any;
		const originalSetupWorktree = goalManager.setupWorktree;
		let setupCalls = 0;
		let release!: () => void;
		let goalId: string | undefined;
		try {
			const create = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `coalesced retry ${Date.now()}`,
					cwd: nonGitCwd(),
					autoStartTeam: false,
					workflowId: "feature",
					spec: "Concurrent retry setup posts must share one route continuation and one authoritative setup flight.",
				}),
			});
			expect(create.status).toBe(201);
			goalId = (await create.json()).id;
			context.goalStore.transitionSetup(goalId, "error", "simulated setup failure");
			goalManager.setupWorktree = (id: string) => {
				setupCalls++;
				return new Promise<void>((resolve) => {
					release = () => {
						context.goalStore.transitionSetup(id, "ready");
						resolve();
					};
				});
			};

			const [first, second] = await Promise.all([
				apiFetch(`/api/goals/${goalId}/retry-setup`, { method: "POST" }),
				apiFetch(`/api/goals/${goalId}/retry-setup`, { method: "POST" }),
			]);
			const results = [await first.json(), await second.json()];
			expect(results.filter(result => result.coalesced === false)).toHaveLength(1);
			expect(results.filter(result => result.coalesced === true)).toHaveLength(1);
			expect(setupCalls).toBe(1);
			release();
			await waitForCondition(() => context.goalStore.get(goalId!)?.setupStatus === "ready", {
				message: "coalesced setup reaches ready",
			});
		} finally {
			goalManager.setupWorktree = originalSetupWorktree;
			if (goalId) await deleteGoal(goalId);
		}
	});
});
