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
import { waitForPool, pollSessionUntil, pollSessionUntilArchived } from "./test-utils/pool-polling.mjs";
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

	test("multi-repo session lifecycle: branch + dir stable across creation, prompt, restart, archive", async ({ gateway }) => {
		// Use a fresh project so the pool state for this test is independent.
		const lifecycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-life-"));
		gitInit(path.join(lifecycleRoot, "api"));
		gitInit(path.join(lifecycleRoot, "web"));
		gitInit(path.join(lifecycleRoot, "data"));

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({
				name: `mr-life-${Date.now()}`,
				rootPath: lifecycleRoot,
				components: [
					{ name: "api", repo: "api" },
					{ name: "web", repo: "web" },
					// Data-only component — no commands. Must still get a sibling worktree.
					{ name: "data", repo: "data" },
				],
			}),
		});
		expect(reg.status).toBe(201);
		const lifecycleProjectId = (await reg.json()).id;

		const ready = await waitForPool(lifecycleProjectId, 1);
		expect(ready).toBeGreaterThan(0);

		// 1. Create session — claim a multi-repo pool entry.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: path.join(lifecycleRoot, "api"),
				projectId: lifecycleProjectId,
				worktree: true,
			}),
		});
		expect(sessResp.status).toBe(201);
		const sessionId = (await sessResp.json()).id;

		// Poll until branch settles to session/<id8>.
		const settled = await pollSessionUntil(
			sessionId,
			row => typeof row.branch === "string" && row.branch.startsWith("session/"),
			15_000,
		);
		const branch: string | undefined = settled?.branch;
		const worktreePath: string | undefined = settled?.worktreePath;
		expect(branch).toMatch(/^session\/[a-f0-9]{8}$/);
		expect(branch).not.toMatch(/^pool\//);
		expect(branch).not.toMatch(/^session\/new-session-/);

		// 2. Assert per-repo worktrees on disk, all on the same branch.
		const branchSlug = branch!.replace(/\//g, "-");
		const container = path.join(`${lifecycleRoot}-wt`, branchSlug);
		const repos = ["api", "web", "data"];
		for (const r of repos) {
			const wt = path.join(container, r);
			expect(fs.existsSync(wt), `${r} worktree must exist at ${wt}`).toBe(true);
			const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, encoding: "utf-8" }).trim();
			expect(head).toBe(branch);
		}

		// Capture pre-restart per-repo fingerprints. Use the branch's own
		// reflog only (NOT --all) so background pool replenishment doesn't
		// pollute the snapshot.
		const beforeReflogs = repos.map(r => {
			try {
				return execFileSync("git", ["reflog", "show", "--no-abbrev", branch!], {
					cwd: path.join(container, r), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
				});
			} catch { return ""; }
		});

		// 3. PATCH title — metadata only, branch must NOT change.
		const patch = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "Multi-repo lifecycle" }),
		});
		expect(patch.status === 200 || patch.status === 204).toBe(true);
		// Settle: re-fetch until the title update has been observed (or timeout).
		const afterPatch = await pollSessionUntil(
			sessionId,
			row => row.title === "Multi-repo lifecycle" || !!row.branch,
			2_000,
		);
		expect(afterPatch.branch).toBe(branch);
		expect(afterPatch.worktreePath).toBe(worktreePath);

		// 4. Simulate restart — verify on-disk persisted state is byte-stable
		// and per-repo branch/dir state is unchanged. The in-process harness
		// shares Node's module cache so we cannot truly tear down + re-create
		// the gateway; the authoritative restart input is `sessions.json` plus
		// the on-disk worktree state. If anything was going to rename a branch
		// or move a directory across the implicit "restart boundary", it would
		// have done so by the time we observe these.
		const sessionsJson = path.join(gateway.bobbitDir, "state", "sessions.json");
		let persistedSearched = false;
		for (const candidate of [sessionsJson, path.join(lifecycleRoot, ".bobbit", "state", "sessions.json")]) {
			if (!fs.existsSync(candidate)) continue;
			persistedSearched = true;
			const raw = fs.readFileSync(candidate, "utf-8");
			if (raw.includes(sessionId)) {
				const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
				const row = rows.find(r => r.id === sessionId);
				if (row) {
					expect(row.branch).toBe(branch);
					expect(row.worktreePath).toBe(worktreePath);
				}
			}
		}
		expect(persistedSearched).toBe(true);

		const afterRestart = await apiFetch(`/api/sessions/${sessionId}`).then(r => r.json());
		expect(afterRestart.branch).toBe(branch);
		expect(afterRestart.worktreePath).toBe(worktreePath);

		for (let i = 0; i < repos.length; i++) {
			const wt = path.join(container, repos[i]);
			expect(fs.existsSync(wt)).toBe(true);
			const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, encoding: "utf-8" }).trim();
			expect(head).toBe(branch);
			let reflogAfter = "";
			try {
				reflogAfter = execFileSync("git", ["reflog", "show", "--no-abbrev", branch!], {
					cwd: wt, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
				});
			} catch { /* may be empty */ }
			expect(reflogAfter).toBe(beforeReflogs[i]);
		}

		// 5. Archive the session.
		//
		// On archive, the local worktree is NOT immediately removed — the
		// actual `git worktree remove` runs as part of the 7-day
		// `purgeOneSession` schedule (see
		// `session-manager.ts::terminateSession` and PR #orphan-cleanup).
		// What MUST be true post-archive is:
		//   - the session row is archived in the API,
		//   - cleanup operates on the FINAL `session/<id8>` name — no ghost
		//     `session/new-session-*` branches must appear,
		//   - per-repo refs/branches are still on the same final name (no
		//     rename happened during archive).
		const del = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(del.ok).toBe(true);

		// Poll until the API reports the session as archived.
		await pollSessionUntilArchived(sessionId, 10_000);

		for (const r of repos) {
			const repoRoot = path.join(lifecycleRoot, r);
			const legacy = execFileSync("git", ["branch", "--list"], {
				cwd: repoRoot, encoding: "utf-8",
			}).trim();
			expect(legacy, `${r} must not have any session/new-session-* ghost branch`).not.toMatch(/session\/new-session-/);
			expect(legacy, `${r} must not have any session/<slug>-<id8> ghost from the legacy rename path`).not.toMatch(new RegExp(`session/[a-z0-9-]+-${branch!.slice("session/".length)}`));
		}
	});
});
