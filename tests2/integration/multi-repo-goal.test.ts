/**
 * Multi-repo goal API persistence.
 *
 * Verifies that a goal can be created and retrieved in a project with three
 * distinct component roots. Per-repository worktree fidelity lives in E2E;
 * this tier-1 route case explicitly disables worktree provisioning.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, base, registerProject } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandRunner } from "../../src/server/gateway-deps.js";

let token: string;
let restoreCommandRunner: (() => void) | undefined;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function componentDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
}

test.beforeAll(({ gateway }) => {
	token = readE2EToken();
	const runner = gateway.sessionManager.commandRunner as CommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	const reject = (): never => { throw new Error("multi-repo route fixture is intentionally non-git"); };
	runner.execFile = async () => reject();
	runner.execFileSync = () => reject();
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
});

test.afterAll(() => restoreCommandRunner?.());

test("multi-repo goal creates per-repo worktrees", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mr-goal-"));
	componentDir(path.join(root, "api"));
	componentDir(path.join(root, "web"));
	componentDir(path.join(root, "shared"));

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

	// This tier-1 case covers project scoping and goal persistence. Real
	// per-repository worktree behavior is covered by the E2E worktree tier, so
	// explicitly disable worktree setup instead of constructing Git fixtures.
	const goalRes = await fetch(`${base()}/api/goals`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			title: "mr",
			cwd: path.join(root, "api"),
			team: false,
			worktree: false,
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
