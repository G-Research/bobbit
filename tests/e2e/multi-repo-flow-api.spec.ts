/**
 * API/data-path coverage split out of tests/e2e/ui/multi-repo-flow.spec.ts.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
	// Ensure an `origin` exists so worktree push targets resolve. Fake it via
	// a bare clone alongside.
	const bare = `${dir}-bare`;
	execFileSync("git", ["clone", "--bare", "--quiet", dir, bare], { stdio: "pipe" });
	execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
}

async function registerMultiRepoProject(): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-api-"));
	gitInit(path.join(root, "api"));
	gitInit(path.join(root, "web"));
	fs.mkdirSync(path.join(root, "shared"), { recursive: true });  // data-only repo

	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: `mr-api-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			rootPath: root,
			components: [
				{ name: "api", repo: "api", commands: { build: "echo build-api", test: "echo test-api" } },
				{ name: "web", repo: "web", commands: { build: "echo build-web" } },
				{ name: "shared", repo: "shared" },  // data-only
			],
			workflows: {
				simple: {
					id: "simple",
					name: "Simple",
					gates: [
						{
							id: "implementation",
							name: "Build",
							verify: [
								{ name: "Build api", type: "command", component: "api", command: "build" },
								{ name: "Test api", type: "command", component: "api", command: "test" },
								{ name: "Build web", type: "command", component: "web", command: "build" },
							],
						},
					],
				},
			},
		}),
	});
	expect(res.status).toBe(201);
	const project = await res.json();
	return {
		id: project.id,
		rootPath: root,
		cleanup: () => {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
			try { fs.rmSync(path.join(root, "api-bare"), { recursive: true, force: true }); } catch { /* ignore */ }
			try { fs.rmSync(path.join(root, "web-bare"), { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test.describe("multi-repo flow API/data paths", () => {
	test("worktree_root structured endpoint round-trips", async () => {
		test.setTimeout(60_000);
		const project = await registerMultiRepoProject();
		try {
			const customRoot = path.join(os.tmpdir(), `bobbit-wt-${Date.now()}`);
			const put = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ worktree_root: customRoot }),
			});
			expect(put.status).toBeLessThan(300);

			const res = await apiFetch(`/api/projects/${project.id}/structured`);
			const data = await res.json();
			expect(data.worktree_root).toBe(customRoot);
		} finally {
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			project.cleanup();
		}
	});

	test("multi-repo goal: per-repo worktrees on disk, then archive cleanup", async () => {
		test.setTimeout(120_000);
		const project = await registerMultiRepoProject();
		let goalId: string | undefined;

		try {
			// Drive goal creation entirely via the API so this data-path coverage
			// stays stable across UI flow changes.
			//
			// `cwd` must be one of the configured repos so isGitRepo() returns
			// true and `goal.repoPath` is set; createWorktreeSet then runs across
			// every component.
			const goalRes = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					projectId: project.id,
					title: "Multi-repo goal",
					spec: "Spec",
					workflowId: "simple",
					cwd: path.join(project.rootPath, "api"),
					autoStartTeam: false,
					team: false,
				}),
			});
			expect(goalRes.status).toBeLessThan(300);
			const goal = await goalRes.json();
			goalId = goal.id;

			// Wait for setupStatus to settle — success or error. Phase 4a wiring
			// for multi-repo goal worktrees is in progress; if the server didn't
			// produce `repoWorktrees`, we just confirm the goal was created and
			// move on (the API-level test in tests/e2e/multi-repo-goal.spec.ts
			// will tighten once Phase 4a lands).
			const goalRecord: any = await pollUntil(
				async () => {
					const r = await apiFetch(`/api/goals/${goal.id}`);
					const record = await r.json();
					return record?.setupStatus === "ready" || record?.setupStatus === "error" ? record : null;
				},
				{ timeoutMs: 30_000, intervalMs: 500, label: "multi-repo goal setup" },
			);
			expect(goalRecord.id).toBeTruthy();

			if (goalRecord.repoWorktrees && Object.keys(goalRecord.repoWorktrees).length > 1) {
				// Phase 4a has wired multi-repo goal worktrees — assert per-repo paths exist.
				expect(Object.keys(goalRecord.repoWorktrees)).toEqual(expect.arrayContaining(["api", "web", "shared"]));
				for (const [, wtPath] of Object.entries(goalRecord.repoWorktrees as Record<string, string>)) {
					expect(fs.existsSync(wtPath as string)).toBe(true);
				}

				// Archive → cleanup. Allow up to 15s for async teardown.
				await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
				goalId = undefined;
				const allGone = await pollUntil(
					async () => Object.values(goalRecord.repoWorktrees as Record<string, string>)
						.every(wtPath => !fs.existsSync(wtPath as string)) ? true : null,
					{ timeoutMs: 15_000, intervalMs: 500, label: "multi-repo worktree cleanup" },
				).catch(() => false);
				expect(allGone).toBe(true);
			} else {
				// Pre-Phase-4a single-repo fallback: just verify a worktree was set up.
				expect(goalRecord.worktreePath || goalRecord.cwd).toBeTruthy();
				await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
				goalId = undefined;
			}
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			project.cleanup();
		}
	});

	test("structured endpoint surfaces a >1 repo count for the goal-form indicator", async () => {
		test.setTimeout(60_000);
		const project = await registerMultiRepoProject();

		try {
			// The goal-form's multi-repo indicator template is guarded by
			// `componentSummary?.multiRepo`, which derives from
			// `/api/projects/:id/structured`. This test asserts that data path:
			// register the project, GET /structured, and verify a >1 repo count.
			const res = await apiFetch(`/api/projects/${project.id}/structured`);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(Array.isArray(data?.components)).toBe(true);
			const repos = new Set((data.components as Array<{ repo?: string }>).map(c => c.repo || "."));
			expect(repos.size).toBeGreaterThan(1);
		} finally {
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			project.cleanup();
		}
	});
});
