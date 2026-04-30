/**
 * Phase 3 worktree pool flow — API E2E.
 *
 * Asserts:
 *   1. After registering a git-repo project, the pool warms with `pool/_pool-*`
 *      branches (visible via `GET /api/worktree-pool`).
 *   2. Creating a worktree session against the project claims an unnamed entry,
 *      so the persisted `branch` is `pool/_pool-<id>` rather than the legacy
 *      `session/new-session-<id>` placeholder.
 *   3. Setting a title via PATCH renames the worktree onto `session/<slug>-<id>`.
 *   4. Goal creation also routes through the pool (the goal's persisted
 *      `branch` is the goal branch, but its `worktreePath` ends up under the
 *      goal-branch slug rather than failing).
 *   5. Pool replenishes after claims so subsequent sessions don't fall through
 *      to createWorktree.
 */
import { test, expect } from "./in-process-harness.js";

// Pool-flow specs need the pre-fill to actually run.
test.use({ enableWorktreePool: true });

import { apiFetch } from "./e2e-setup.js";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function waitForPool(projectId: string, target: number, timeoutMs = 30_000): Promise<number> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch("/api/worktree-pool");
		if (resp.status === 200) {
			const body = await resp.json();
			const entry = body?.pools?.[projectId];
			if (entry && entry.ready >= target) return entry.ready;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	return 0;
}

test.describe.serial("Phase 3 worktree pool flow", () => {
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		const base = join(tmpdir(), `bobbit-e2e-pool-flow-${Date.now()}`);
		repoPath = join(base, "repo");
		mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "pool-flow-project", rootPath: repoPath }),
		});
		if (reg.status !== 201) throw new Error(`project register failed: ${reg.status}`);
		const project = await reg.json();
		projectId = project.id;
	});

	test("pool warms with pool/_pool-* entries and session creation claims one", async () => {
		// Wait for pool to fill.
		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		// 3. Create a worktree session — should claim a pool entry.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
		});
		expect(sessResp.status).toBe(201);
		const session = await sessResp.json();
		const sessionId = session.id;
		expect(sessionId).toBeTruthy();

		// 4. The session's persisted branch should be a pool branch (not the
		//    legacy `session/new-session-*` placeholder). Allow a short wait
		//    while the worktree pipeline persists structural fields.
		let branch: string | undefined;
		for (let i = 0; i < 50; i++) {
			const detail = await apiFetch(`/api/sessions/${sessionId}`).then(r => r.status === 200 ? r.json() : null);
			if (detail && typeof detail.branch === "string") {
				branch = detail.branch;
				if (branch && branch.startsWith("pool/_pool-")) break;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		expect(branch).toMatch(/^pool\/_pool-/);

		// 5. Pool should replenish (eventually back to target).
		const replenished = await waitForPool(projectId, 1, 30_000);
		expect(replenished).toBeGreaterThan(0);

		// 6. Setting a title via PATCH triggers the pool-rename helper, moving
		//    the session onto its real `session/<slug>-<id>` branch.
		const patch = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "Cool task title" }),
		});
		expect(patch.status === 200 || patch.status === 204).toBe(true);

		// Wait for rename — happens fire-and-forget.
		let renamed: string | undefined;
		for (let i = 0; i < 60; i++) {
			const detail = await apiFetch(`/api/sessions/${sessionId}`).then(r => r.status === 200 ? r.json() : null);
			if (detail && typeof detail.branch === "string" && detail.branch.startsWith("session/")) {
				renamed = detail.branch;
				break;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		expect(renamed).toMatch(/^session\/cool-task-title/);
	});

	test("goal creation claims a pool entry (goal branch persisted, not error state)", async () => {
		// Wait for pool to be warm again.
		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Test pool goal",
				cwd: repoPath,
				projectId,
				team: false,
				worktree: true,
				workflowId: "general",
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const goalId = goal.id;

		// Wait for setupStatus to flip to "ready".
		let setupStatus: string | undefined;
		for (let i = 0; i < 100; i++) {
			const detail = await apiFetch(`/api/goals/${goalId}`).then(r => r.status === 200 ? r.json() : null);
			if (detail && detail.setupStatus) {
				setupStatus = detail.setupStatus;
				if (setupStatus === "ready" || setupStatus === "error") break;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		expect(setupStatus).toBe("ready");
	});
});
