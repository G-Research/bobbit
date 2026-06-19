/**
 * Per-goal worktree setup command — pool-claim path (API E2E).
 *
 * The worktree pool pre-builds branches off master; it cannot pre-run a
 * goal-specific script. So when a goal claims a pool worktree, the per-goal
 * setup command must still fire AFTER the claim. This spec enables the pool
 * (file-scoped worker option) and asserts the per-goal audit line is written
 * for a pool-claimed goal.
 *
 * See goal-worktree-setup-command.spec.ts for the freshly-created-worktree path.
 */
import { test, expect } from "./in-process-harness.js";

// Pool pre-fill must actually run for this spec.
test.use({ enableWorktreePool: true });

import { apiFetch } from "./e2e-setup.js";
import { waitForPool } from "./test-utils/pool-polling.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init", "--quiet"], { cwd: dir });
}

test.describe.serial("Per-goal worktree setup command (pool claim)", () => {
	let repoPath: string;
	let projectId: string;
	let recordFile: string;

	test.beforeAll(async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-setup-pool-"));
		repoPath = path.join(root, "repo");
		gitInit(repoPath);

		recordFile = path.join(root, "setup-record.tsv");
		process.env.BOBBIT_TEST_RECORD_SETUP = recordFile;

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `goal-setup-pool-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test.afterAll(() => {
		delete process.env.BOBBIT_TEST_RECORD_SETUP;
	});

	test("pool-claimed worktree still runs the per-goal setup command", async () => {
		// Wait for the pool to warm so the goal actually claims a pre-built entry.
		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		const command = "echo pool-goal-hook-ran";
		const createRes = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Pool-claimed per-goal setup",
				cwd: repoPath,
				projectId,
				worktree: true,
				team: false,
				autoStartTeam: false,
				workflowId: "general",
				worktreeSetupCommand: command,
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();

		// Wait for setup to settle (event-loop-driven poll, no inline sleep).
		let detail: Record<string, unknown> = {};
		await expect.poll(async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return undefined;
			detail = await r.json();
			return detail.setupStatus;
		}, { timeout: 30_000 }).toMatch(/^(ready|error)$/);
		expect(detail.setupStatus).toBe("ready");

		// Per-goal audit line written even though the worktree came from the pool.
		const lines = fs.existsSync(recordFile)
			? fs.readFileSync(recordFile, "utf-8").split("\n").filter((l) => l.startsWith("goal\t") && l.includes(created.id))
			: [];
		expect(lines.length).toBe(1);
		expect(lines[0].split("\t")[4]).toBe(command);
	});
});
