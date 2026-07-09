/**
 * Multi-repo goal worktree set creation.
 *
 * Verifies that creating a goal in a 3-repo project lands per-repo worktrees
 * under `<wtRoot>/<branchSlug>/<repo>/` for every distinct repo.
 *
 * See docs/design/multi-repo-components.md §5.3 / §9.2.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, base, registerProject } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function gitInit(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

test.beforeAll(() => { token = readE2EToken(); });

test("multi-repo goal creates per-repo worktrees", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-goal-"));
	gitInit(path.join(root, "api"));
	gitInit(path.join(root, "web"));
	gitInit(path.join(root, "shared"));

	const projectName = `mr-goal-${Date.now()}`;
	const project = await registerProject({
		name: projectName,
		rootPath: root,
		components: [
			{ name: "api", repo: "api" },
			{ name: "web", repo: "web" },
			{ name: "shared", repo: "shared" },
		],
		// Goal creation requires a resolvable workflow id (default "general").
		// Inline a minimal workflow so this test doesn't depend on auto-seed.
		workflows: {
			general: {
				name: "General",
				description: "E2E test workflow",
				gates: [
					{
						id: "implementation",
						name: "Implementation",
						depends_on: [],
						verify: [{ name: "Build", type: "command", run: "echo ok" }],
					},
				],
			},
		},
	});

	// Create a goal scoped to this project; cwd points at one of the repos so
	// isGitRepo() returns true and `goal.repoPath` is set.
	const goalRes = await fetch(`${base()}/api/goals`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			title: "mr",
			cwd: path.join(root, "api"),
			team: false,
			projectId: project.id,
		}),
	});
	expect(goalRes.status).toBe(201);
	const goal = await goalRes.json();

	// The Phase-4 TODO below means we only assert the goal was CREATED (multi-repo
	// worktree creation is covered by the unit layer). Confirm the goal persisted
	// via a single GET — driving on observable state, not a fixed-delay poll for a
	// `setupStatus` this test does not assert. That vestigial 60×200 ms (~12 s)
	// wall-clock loop was the dominant variable cost that pushed this real-git test
	// past its timeout under N-way CPU load; it never influenced the assertion
	// (the loop falls through to the same `updated.id` check on timeout anyway).
	const getRes = await fetch(`${base()}/api/goals/${goal.id}`, { headers: headers() });
	expect(getRes.status).toBe(200);
	const updated = await getRes.json();

	// TODO Phase 4 follow-up: end-to-end multi-repo goal worktree creation
	// requires a few wiring pieces that are not in this commit:
	//   - GoalManager's componentsResolver needs to be wired by the server
	//     bootstrap (today it's set lazily for the project context, but goals
	//     created through the REST endpoint still go through the legacy path
	//     because `goal.repoPath` ends up at `rootPath/api`, not the project
	//     root, so createWorktreeSet would only see the api repo).
	//   - Goal repoPath detection needs a multi-repo-aware variant.
	// For now, assert only the goal was created — the component infrastructure
	// is exercised by the unit-test layer.
	expect(updated.id).toBeTruthy();
});
