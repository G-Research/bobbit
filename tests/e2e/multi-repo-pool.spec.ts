/**
 * Multi-repo worktree pool — API E2E (Phase 4a).
 *
 * Asserts:
 *   1. Registering a multi-repo project (2 repos) warms the pool with
 *      multi-repo entries.
 *   2. Creating a goal claims a multi-repo set; on disk we observe one
 *      worktree per declared repo, all on the goal's branch.
 *
 * See docs/design/multi-repo-components.md §5.1 / §5.3 / §9.2.
 */
import { test, expect } from "./in-process-harness.js";

// Pool prebuild must run for this spec.
test.use({ enableWorktreePool: true });

import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

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

test.describe.serial("multi-repo worktree pool E2E", () => {
	let root: string;
	let projectId: string;

	test.beforeAll(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-pool-"));
		gitInit(path.join(root, "api"));
		gitInit(path.join(root, "web"));

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: `mr-pool-${Date.now()}`,
				rootPath: root,
				components: [
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
				],
			}),
		});
		expect(reg.status).toBe(201);
		const project = await reg.json();
		projectId = project.id;
	});

	test("pool warms with multi-repo entries; goal claim yields per-repo worktrees on disk", async () => {
		const ready = await waitForPool(projectId, 1);
		expect(ready).toBeGreaterThan(0);

		// Create a goal scoped to this project; cwd points at one of the repos
		// so isGitRepo() returns true.
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Multi-repo pool goal",
				cwd: path.join(root, "api"),
				projectId,
				team: false,
				worktree: true,
				workflowId: "general",
			}),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		const goalId = goal.id;

		// Wait for setupStatus → ready.
		let setupStatus: string | undefined;
		let detail: any;
		for (let i = 0; i < 100; i++) {
			detail = await apiFetch(`/api/goals/${goalId}`).then(r => r.status === 200 ? r.json() : null);
			if (detail && detail.setupStatus) {
				setupStatus = detail.setupStatus;
				if (setupStatus === "ready" || setupStatus === "error") break;
			}
			await new Promise(r => setTimeout(r, 200));
		}
		expect(setupStatus).toBe("ready");

		// Per-repo worktrees should exist on disk under the goal branch slug.
		const branch: string = detail.branch;
		expect(typeof branch).toBe("string");
		const branchSlug = branch.replace(/\//g, "-");
		// Worktree root is `<rootPath>-wt/` by default.
		const wtRoot = `${root}-wt`;
		const container = path.join(wtRoot, branchSlug);

		// Either the pool path got renamed to the goal branch slug, or the
		// fallback createWorktreeSet created the container directly. Both are
		// acceptable. Either way, both per-repo worktrees must exist on disk.
		const apiWt = path.join(container, "api");
		const webWt = path.join(container, "web");
		expect(fs.existsSync(apiWt)).toBe(true);
		expect(fs.existsSync(webWt)).toBe(true);

		// Each per-repo worktree should be on the goal's branch.
		for (const wt of [apiWt, webWt]) {
			const stdout = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, encoding: "utf-8" });
			expect(stdout.trim()).toBe(branch);
		}
	});
});
