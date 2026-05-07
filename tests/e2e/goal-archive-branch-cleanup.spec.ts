/**
 * E2E test for Bug 1 of docs/design/orphan-remote-branch-cleanup.md:
 * archiving a team goal must push-delete every per-role agent branch from
 * `origin`. The bug was a mutated-array read in the DELETE /api/goals/:id
 * handler — see server.ts ~L2755.
 *
 * Strategy: stand up a real local bare-repo origin, register the clone as
 * a project, create a team goal, spawn 2 role agents (each gets its own
 * `goal-goal-<slug>-<id>-<role>-<short>` branch pushed to origin), archive
 * the goal, then poll `git ls-remote --heads <bare>` until every per-role
 * branch is gone (≤55s).
 *
 * Uses the `realpush` harness variant so BOBBIT_TEST_NO_PUSH is NOT set —
 * push-delete actually executes. Registered as the `api-realpush` project
 * in playwright-e2e.config.ts for env isolation from other workers.
 */
import { test, expect } from "./in-process-harness-realpush.js";
import { execFileSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFetch } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const execFileAsync = promisify(execFileCb);

test.setTimeout(120_000);

test.describe("orphan remote branch cleanup — Bug 1 (team goal archive)", () => {
	let tmpRoot: string;
	let bareRepo: string;
	let workRepo: string;
	let projectId: string;

	test.beforeAll(async () => {
		// 1. Local bare-repo "origin" + a clone with an initial master commit.
		tmpRoot = mkdtempSync(join(tmpdir(), "bobbit-bare-"));
		bareRepo = join(tmpRoot, "origin.git");
		workRepo = join(tmpRoot, "work");
		execFileSync("git", ["init", "--bare", "-b", "master", bareRepo]);
		execFileSync("git", ["clone", bareRepo, workRepo]);
		// Identity is required for the empty commit on some CI images.
		execFileSync("git", ["-C", workRepo, "config", "user.email", "test@bobbit.local"]);
		execFileSync("git", ["-C", workRepo, "config", "user.name", "bobbit-e2e"]);
		execFileSync("git", ["-C", workRepo, "commit", "--allow-empty", "-m", "init"]);
		execFileSync("git", ["-C", workRepo, "push", "-u", "origin", "master"]);

		// 2. Register the clone as a project via REST. We talk to the
		//    realpush harness's gateway via the standard apiFetch helper.
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: "bare-origin-test",
				rootPath: workRepo,
				upsert: true,
				acceptCanonical: true,
			}),
		});
		if (!projResp.ok) throw new Error(`project register failed: ${projResp.status} ${await projResp.text()}`);
		const proj = await projResp.json();
		projectId = proj.id;
	});

	test.afterAll(() => {
		if (tmpRoot) {
			try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	test("archiving a team goal deletes all per-role remote branches", async () => {
		// Create a team goal in the cloned project (cwd = workRepo).
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "branch-cleanup-test",
				cwd: workRepo,
				projectId,
				team: true,
				worktree: true,
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const goalId: string = goal.id;

		// Wait for goal setup (worktree create + push) to complete.
		await pollUntil(async () => {
			const r = await apiFetch(`/api/goals/${goalId}`);
			if (!r.ok) return null;
			const g = await r.json();
			if (g.setupStatus === "error") {
				throw new Error(`Goal setup errored: ${JSON.stringify(g)}`);
			}
			return g.setupStatus === "ready" ? g : null;
		}, { timeoutMs: 60_000, intervalMs: 250, label: `goal ${goalId} setup ready` });

		// Spawn two role agents.
		for (const role of ["coder", "reviewer"]) {
			const r = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
				method: "POST",
				body: JSON.stringify({ role, task: "no-op" }),
			});
			if (r.status !== 201) throw new Error(`spawn ${role} failed: ${r.status} ${await r.text()}`);
		}

		// Capture the expected per-role branch list from the team store.
		// /api/goals/:id/team returns { agents: [{ branch, ... }, ...] }.
		const stateResp = await apiFetch(`/api/goals/${goalId}/team`);
		expect(stateResp.ok).toBe(true);
		const state = await stateResp.json();
		const expectedBranches: string[] = (state.agents ?? [])
			.map((a: any) => a.branch)
			.filter((b: string | undefined): b is string => Boolean(b));
		expect(expectedBranches.length).toBeGreaterThanOrEqual(2);

		// Sanity: branches were pushed to origin during worktree creation.
		// Poll briefly — push happens async during spawn in some paths.
		const lsBefore = await pollUntil(async () => {
			const { stdout } = await execFileAsync(
				"git", ["ls-remote", "--heads", bareRepo],
				{ encoding: "utf-8" },
			);
			return expectedBranches.every(b => stdout.includes(b)) ? stdout : null;
		}, { timeoutMs: 30_000, intervalMs: 500, label: "all per-role branches pushed to origin" });
		for (const b of expectedBranches) {
			expect(lsBefore, `branch ${b} should have been pushed`).toContain(b);
		}

		// Archive the goal — DELETE /api/goals/:id triggers
		// deleteRemoteGoalBranches() fire-and-forget.
		const del = await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" });
		expect(del.status).toBe(200);

		// Poll ls-remote until every per-role branch is gone (≤55s).
		let lsAfter = "";
		try {
			lsAfter = await pollUntil(async () => {
				const { stdout } = await execFileAsync(
					"git", ["ls-remote", "--heads", bareRepo],
					{ encoding: "utf-8" },
				);
				return expectedBranches.every(b => !stdout.includes(b)) ? stdout : null;
			}, { timeoutMs: 55_000, intervalMs: 500, label: "all per-role branches deleted from origin" });
		} catch {
			// Fall through to the per-branch expect() below for a clearer diff.
			const { stdout } = await execFileAsync(
				"git", ["ls-remote", "--heads", bareRepo],
				{ encoding: "utf-8" },
			);
			lsAfter = stdout;
		}
		for (const b of expectedBranches) {
			expect(lsAfter, `branch ${b} should have been deleted from origin`).not.toContain(b);
		}
	});
});
