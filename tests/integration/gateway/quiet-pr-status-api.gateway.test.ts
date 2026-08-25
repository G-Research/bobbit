import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { awaitableRm } from "../../support/helpers/e2e/cleanup.js";
import { loadServerTestRuntime } from "../../support/harnesses/server-runtime.js";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, nonGitCwd } from "./_helpers/e2e/e2e-setup.js";

type QuietPrGoal = { id: string; branch: string; cwd: string; worktreePath: string; projectId?: string };

let restoreCommandRunner: (() => void) | undefined;
let unexpectedCommands: string[] = [];

async function installNonGitIdentityRunner(): Promise<void> {
	const runtime = await loadServerTestRuntime();
	const runner = runtime.gatewayDeps.realCommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	const describe = (file: string, args: readonly string[]) => `${basename(file)} ${args.join(" ")}`;
	const rejectUnexpected = (file: string, args: readonly string[]): never => {
		const command = describe(file, args);
		unexpectedCommands.push(command);
		throw new Error(`unexpected command: ${command}`);
	};
	runner.execFile = async (file, args) => {
		if (basename(file).toLowerCase().replace(/\.exe$/, "") === "git" && args.join(" ") === "rev-parse --git-dir") {
			throw new Error("not a git repository");
		}
		return rejectUnexpected(file, args);
	};
	runner.execFileSync = (file, args) => rejectUnexpected(file, args);
	runner.spawn = (file, args) => rejectUnexpected(file, args);
	restoreCommandRunner = () => Object.assign(runner, original);
}

async function cleanupGoal(goal: QuietPrGoal | undefined): Promise<void> {
	if (!goal) return;
	await deleteGoal(goal.id).catch(() => {});
	await awaitableRm(goal.cwd, { maxAttempts: 5, backoffMs: 50 });
}

async function expectEmptyNoContent(resp: Response, label: string): Promise<void> {
	expect(resp.status, `${label} should return 204 No Content`).toBe(204);
	expect(await resp.text(), `${label} 204 response must have no body`).toBe("");
}

async function createGoalWithUnsupportedPrRemote(gateway: any): Promise<QuietPrGoal> {
	// An ordinary directory plus the injected identity probe keeps this route
	// focused on quiet ineligible-target semantics rather than repository setup.
	const cwd = join(
		nonGitCwd(),
		`bobbit-quiet-pr-status-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(cwd, { recursive: true });
	const goal = await createGoal({
		title: `quiet pr-status unsupported-remote ${Date.now()}`,
		cwd,
		worktree: false,
		autoStartTeam: false,
		spec: "Route fixture for quiet optional PR probes with an ineligible local-only remote.",
	});
	const branch = "feature/no-pr";
	const projectId = typeof goal.projectId === "string" ? goal.projectId : undefined;
	if (!projectId) throw new Error(`goal ${goal.id} did not resolve a project`);
	const goalStore = gateway.sessionManager.getGoalStoreForProject(projectId);
	// PR-status routing only requires branch/worktree metadata and an existing cwd.
	// Seed that decision boundary directly; worktree provisioning has dedicated tests.
	goalStore.update(goal.id, { branch, cwd, repoPath: cwd, worktreePath: cwd, setupStatus: "ready" });
	return { id: goal.id, branch, cwd, worktreePath: cwd, projectId };
}

test.describe("quiet optional PR status probes", () => {
	test.beforeAll(async () => {
		await installNonGitIdentityRunner();
	});

	test.beforeEach(() => {
		unexpectedCommands = [];
	});

	test.afterEach(() => {
		expect(unexpectedCommands, "PR-status fixtures must not escape their synthetic Git identity seam").toEqual([]);
	});

	test.afterAll(() => {
		restoreCommandRunner?.();
	});

	test("keeps an ineligible session PR target as bare 404 and optional 204", async ({ gateway }) => {
		let goal: QuietPrGoal | undefined;
		let sessionId: string | undefined;
		try {
			goal = await createGoalWithUnsupportedPrRemote(gateway);
			sessionId = await createSession({ goalId: goal.id, cwd: goal.cwd, projectId: goal.projectId });

			const bareResp = await apiFetch(`/api/sessions/${sessionId}/pr-status`);
			expect(bareResp.status, "ineligible bare session PR target should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/sessions/${sessionId}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "ineligible optional session PR target");
		} finally {
			if (sessionId) await deleteSession(sessionId);
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing session even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/pr-status?optional=1");
		expect(resp.status, "missing session should remain 404 even for quiet PR-status probes").toBe(404);
	});

	test("keeps an ineligible goal PR target as bare 404 and optional 204", async ({ gateway }) => {
		let goal: QuietPrGoal | undefined;
		try {
			goal = await createGoalWithUnsupportedPrRemote(gateway);
			const bareResp = await apiFetch(`/api/goals/${goal.id}/pr-status`);
			expect(bareResp.status, "ineligible bare goal PR target should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/goals/${goal.id}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "ineligible optional goal PR target");
		} finally {
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing goal even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/goals/no-such-goal/pr-status?optional=1");
		expect(resp.status, "missing goal should remain 404 even for quiet PR-status probes").toBe(404);
	});
});
