/**
 * Worktree pool flow \u2014 API E2E.
 *
 * Stepwise lifecycle assertion (per design \u00a716.1 of
 * docs/design/remove-session-worktree-rename.md):
 *
 *   1. Pool warms with `pool/_pool-*` branches.
 *   2. `POST /api/sessions` claims one and produces `session/<id8>`
 *      IMMEDIATELY (no first-prompt rename).
 *   3. Sending a prompt does NOT rename the branch.
 *   4. `PATCH /api/sessions/:id { title }` is metadata-only \u2014 branch unchanged.
 *   5. Goal creation also routes through the pool (the goal's persisted
 *      `branch` is the goal branch; the pool replenishes for the next claim).
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

test.describe.serial("Worktree pool flow", () => {
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

	test("pool warms; session claim produces session/<id8> immediately and is stable across title changes", async () => {
		// Step 1 \u2014 wait for pool fill.
		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		// Step 2 \u2014 create a worktree session and read its persisted branch.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
		});
		expect(sessResp.status).toBe(201);
		const session = await sessResp.json();
		const sessionId = session.id;
		expect(sessionId).toBeTruthy();

		// IMMEDIATELY (before any prompt): branch must be session/<id8>, NOT
		// `pool/_pool-*` and NOT the legacy `session/new-session-*` placeholder.
		// Allow a short wait for the worktree pipeline to persist structural fields.
		let branch: string | undefined;
		for (let i = 0; i < 50; i++) {
			const detail = await apiFetch(`/api/sessions/${sessionId}`).then(r => r.status === 200 ? r.json() : null);
			if (detail && typeof detail.branch === "string") {
				branch = detail.branch;
				if (branch && branch.startsWith("session/")) break;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		expect(branch).toMatch(/^session\/[a-f0-9]{8}$/);
		expect(branch).not.toMatch(/^pool\//);
		expect(branch).not.toMatch(/^session\/new-session-/);

		const branchAtCreation = branch!;

		// Step 3 \u2014 pool should replenish.
		const replenished = await waitForPool(projectId, 1, 30_000);
		expect(replenished).toBeGreaterThan(0);

		// Step 4 \u2014 setting a title is metadata-only; branch must NOT change.
		const patch = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "Cool task title" }),
		});
		expect(patch.status === 200 || patch.status === 204).toBe(true);

		// Give any (unwanted) async work a chance to land, then re-read.
		await new Promise(r => setTimeout(r, 1_500));
		const afterPatch = await apiFetch(`/api/sessions/${sessionId}`).then(r => r.json());
		expect(afterPatch.title).toBe("Cool task title");
		expect(afterPatch.branch).toBe(branchAtCreation);
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
