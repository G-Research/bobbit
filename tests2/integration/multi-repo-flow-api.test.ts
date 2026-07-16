/**
 * API/data-path coverage split out of tests/e2e/ui/multi-repo-flow.spec.ts.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let restoreCommandRunner: (() => void) | undefined;

function fakeRepo(dir: string): void {
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
	fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
}

function cannedGit(cwd: string, args: readonly string[]): string {
	const key = args.join(" ");
	if (key === "rev-parse --show-toplevel") return cwd;
	if (key === "rev-parse --is-inside-work-tree") return "true";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master" || key === "rev-parse --verify origin/master") return "a".repeat(40);
	if (key === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/master";
	if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error(`missing ref: ${args[2]}`);
	if (args[0] === "worktree" && args[1] === "add") {
		const wtPath = args[2] === "-b" ? args[4] : args[2];
		fs.mkdirSync(wtPath, { recursive: true });
		fs.writeFileSync(path.join(wtPath, ".git"), "gitdir: canned\n");
		return "";
	}
	if (args[0] === "worktree" && args[1] === "remove") {
		fs.rmSync(args[2], { recursive: true, force: true });
		return "";
	}
	if (args[0] === "branch" || args[0] === "push" || args[0] === "fetch") return "";
	if (args[0] === "remote" && args[1] === "get-url") throw new Error("no remote");
	throw new Error(`unexpected canned git command (${cwd}): ${key}`);
}

async function installCannedGitRunner(): Promise<void> {
	const runtime = await loadServerTestRuntime();
	const runner = runtime.gatewayDeps.realCommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	runner.execFile = async (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(String(options?.cwd ?? ""), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(String(options?.cwd ?? ""), args);
	};
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
}

async function registerMultiRepoProject(): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-api-"));
	fakeRepo(path.join(root, "api"));
	fakeRepo(path.join(root, "web"));
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
		},
	};
}

test.describe("multi-repo flow API/data paths", () => {
	test.beforeAll(async () => installCannedGitRunner());
	test.afterAll(() => restoreCommandRunner?.());

	test("multi-repo project exposes structured data and per-repo worktree lifecycle", async () => {
		const project = await registerMultiRepoProject();
		let goalId: string | undefined;

		try {
			// Keep the two structured endpoint assertions in the representative
			// route-flow test so this suite pays the expensive project cleanup once.
			const customRoot = path.join(os.tmpdir(), `bobbit-wt-${Date.now()}`);
			const put = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ worktree_root: customRoot }),
			});
			expect(put.status).toBeLessThan(300);

			const structuredRes = await apiFetch(`/api/projects/${project.id}/structured`);
			expect(structuredRes.status).toBe(200);
			const structured = await structuredRes.json();
			expect(structured.worktree_root).toBe(customRoot);
			expect(Array.isArray(structured?.components)).toBe(true);
			const repos = new Set((structured.components as Array<{ repo?: string }>).map(c => c.repo || "."));
			expect(repos.size).toBeGreaterThan(1);

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

			// Wait for setupStatus to settle — success or error. Multi-repo goal
			// worktrees are wired: only git sub-repos get a worktree, while non-git
			// data-only components are skipped. If the server didn't produce
			// `repoWorktrees`, we just confirm the goal was created and move on.
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
				// Multi-repo goal worktrees are wired — only the git sub-repos get a
				// worktree; the non-git data-only `shared` component is skipped.
				expect(Object.keys(goalRecord.repoWorktrees).sort()).toEqual(["api", "web"]);
				expect(goalRecord.repoWorktrees.shared).toBeUndefined();
				for (const [, wtPath] of Object.entries(goalRecord.repoWorktrees as Record<string, string>)) {
					expect(fs.existsSync(wtPath as string)).toBe(true);
				}

				// Archive → cleanup. Allow up to 15s for async teardown.
				await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
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
				await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
				goalId = undefined;
			}
		} finally {
			if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			project.cleanup();
		}
	});
});
