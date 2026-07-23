import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, deleteGoal, registerProject, teardownTeam } from "./_e2e/e2e-setup.js";

const REPRO = "MULTI_REPO_TEAM_SPAWN_REGRESSION";
const NESTED_COMPONENT = "packages/alpha" as const;
const FAILED_COMPONENT = "beta" as const;
const COMPONENTS = [NESTED_COMPONENT, FAILED_COMPONENT] as const;
type ComponentName = typeof COMPONENTS[number];

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
	const result = await runner.execFile("git", args, { cwd, encoding: "utf-8", timeout: 10_000 });
	return String(result.stdout).trim();
}

async function gitRefExists(runner: CommandRunner, cwd: string, ref: string): Promise<boolean> {
	try {
		await git(runner, cwd, ["show-ref", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

async function waitForGoalReady(goalId: string): Promise<any> {
	return pollUntil(
		async () => {
			const response = await apiFetch(`/api/goals/${goalId}`);
			const body = await readJson(response);
			return body.setupStatus === "ready" || body.setupStatus === "error" ? body : null;
		},
		{ timeoutMs: 30_000, intervalMs: 50, label: "multi-repo goal provisioning" },
	);
}

function normalized(filePath: string): string {
	const absolute = resolve(filePath);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function liveRepoWorktrees(session: any): Record<string, string> {
	return Object.fromEntries(
		(session?.repoWorktrees ?? []).map((entry: { repo: string; worktreePath: string }) => [
			entry.repo,
			entry.worktreePath,
		]),
	);
}

function assertWorkerShape(opts: {
	gateway: any;
	runner: CommandRunner;
	projectRoot: string;
	goalId: string;
	goalHeads: Record<ComponentName, string>;
	sessionId: string;
	worktreePath: string;
}): Record<ComponentName, string> {
	const { gateway, runner, projectRoot, goalId, goalHeads, sessionId, worktreePath } = opts;
	const session = gateway.sessionManager.getSession(sessionId);
	const agent = gateway.teamManager.findAgentBySessionId(sessionId);
	const repoWorktrees = liveRepoWorktrees(session) as Record<ComponentName, string>;

	expect(session, `${REPRO}: spawned worker session must exist`).toBeTruthy();
	expect(agent?.branch, `${REPRO}: TeamManager must retain the worker branch`).toMatch(
		new RegExp(`^goal/${goalId.slice(0, 8)}/coder-[0-9a-f]{4}$`),
	);
	expect(normalized(session.cwd), "worker cwd must be its non-Git branch container").toBe(normalized(worktreePath));
	expect(normalized(session.worktreePath), "flat worker worktreePath must be the branch container").toBe(normalized(worktreePath));
	expect(normalized(session.repoPath), "worker cleanup must retain the non-Git project root as its repo container").toBe(normalized(projectRoot));
	expect(existsSync(join(worktreePath, ".git")), "worker branch container must remain non-Git").toBe(false);
	expect(Object.keys(repoWorktrees).sort()).toEqual([...COMPONENTS].sort());
	expect(new Set(COMPONENTS.map(repo => normalized(resolve(
		repoWorktrees[repo],
		...repo.split("/").map(() => ".."),
	))))).toEqual(new Set([normalized(worktreePath)]));

	for (const repo of COMPONENTS) {
		expect(normalized(repoWorktrees[repo]), `${repo} must retain the configured repo-key layout`).toBe(
			normalized(join(worktreePath, repo)),
		);
		expect(existsSync(repoWorktrees[repo]), `${repo} worker worktree must exist`).toBe(true);
	}

	// Keep this helper synchronous for structural assertions; callers perform the
	// real Git HEAD/branch assertions with the same canonical runner.
	void runner;
	void goalHeads;
	return repoWorktrees;
}

// Real-Git fidelity owner. The project root is deliberately not a repository;
// GoalManager provisions one goal worktree per configured component first, then
// TeamManager must use those persisted component paths as authoritative starts.
test("direct and REST team spawn create coordinated workers from local component HEADs and roll back partial creation", async ({ gateway }) => {
	await prepareGitTemplate();
	const fixtureRoot = mkdtempSync(join(gateway.bobbitDir, "team-multi-minimal-"));
	const projectRoot = join(fixtureRoot, "project");
	const worktreeRoot = join(fixtureRoot, "worktrees");
	const runner = gateway.sessionManager.commandRunner as CommandRunner;
	let projectId: string | undefined;
	let goalId: string | undefined;
	let teamLeadSessionId: string | undefined;
	let directWorkerId: string | undefined;
	let restWorkerId: string | undefined;
	let originalExecFile: CommandRunner["execFile"] | undefined;

	try {
		for (const repo of COMPONENTS) copyGitTemplate(join(projectRoot, repo));
		expect(existsSync(join(projectRoot, ".git")), "fixture root must be a non-Git container").toBe(false);
		for (const repo of COMPONENTS) {
			expect(await git(runner, join(projectRoot, repo), ["rev-parse", "HEAD"])).toMatch(/^[0-9a-f]{40}$/);
		}

		const project = await registerProject({
			name: `team-multi-minimal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			rootPath: projectRoot,
			components: COMPONENTS.map(repo => ({ name: repo.split("/").at(-1)!, repo })),
			workflows: {
				general: {
					name: "General",
					description: "Focused multi-repo team-spawn regression",
					gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
				},
			},
			seedWorkflows: false,
		});
		projectId = project.id;

		const configResponse = await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ worktree_root: worktreeRoot }),
		});
		expect(configResponse.status, `${REPRO}: fixture worktree_root configuration must succeed`).toBe(200);

		const goalResponse = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				title: "Minimal coordinated worker spawn",
				spec: "Spawn workers from unpublished alpha and beta goal commits.",
				workflowId: "general",
				cwd: projectRoot,
				worktree: true,
				team: true,
				autoStartTeam: false,
			}),
		});
		const createdGoal = await readJson(goalResponse);
		expect(goalResponse.status, `${REPRO}: goal creation failed: ${JSON.stringify(createdGoal)}`).toBe(201);
		goalId = createdGoal.id;

		const goal = await waitForGoalReady(goalId!);
		expect(goal.setupStatus, `${REPRO}: goal setup failed: ${goal.setupError ?? "unknown"}`).toBe("ready");
		expect(normalized(goal.repoPath)).toBe(normalized(projectRoot));
		expect(Object.keys(goal.repoWorktrees ?? {}).sort()).toEqual([...COMPONENTS].sort());
		expect(existsSync(join(goal.worktreePath, ".git")), "goal branch container must remain non-Git").toBe(false);

		const goalHeads = {} as Record<ComponentName, string>;
		for (const repo of COMPONENTS) {
			const goalWorktree = goal.repoWorktrees[repo];
			expect(existsSync(goalWorktree), `${repo} goal worktree must exist`).toBe(true);
			await git(runner, goalWorktree, ["commit", "--quiet", "--allow-empty", "-m", `Unpublished ${repo} goal head`]);
			goalHeads[repo] = await git(runner, goalWorktree, ["rev-parse", "HEAD"]);
			expect(await git(runner, join(projectRoot, repo), ["remote"]), `${repo} goal commit must be unpublished`).toBe("");
		}
		expect(goalHeads[NESTED_COMPONENT]).not.toBe(goalHeads[FAILED_COMPONENT]);

		const startResponse = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
		const startBody = await readJson(startResponse);
		expect(startResponse.status, `${REPRO}: team lead start failed: ${JSON.stringify(startBody)}`).toBe(201);
		teamLeadSessionId = startBody.sessionId;

		// Inject failure only after the nested component's real worktree add has
		// completed. The rejected direct spawn must remove that worktree, its
		// intermediate repo-key directory, branch, and container. It must never
		// attempt cleanup against beta's failed, never-created target.
		originalExecFile = runner.execFile;
		let failedBranch: string | undefined;
		let failedContainer: string | undefined;
		let firstComponentWorktree: string | undefined;
		let failedComponentWorktree: string | undefined;
		const rollbackWorktreeRemoveTargets: string[] = [];
		(runner as any).execFile = async (file: string, args: string[], options: any) => {
			const gitCommand = file.toLowerCase().replace(/\.exe$/, "") === "git";
			if (gitCommand && args[0] === "worktree" && args[1] === "remove") {
				rollbackWorktreeRemoveTargets.push(String(args[2]));
			}
			const branchIndex = args.indexOf("-b");
			const branch = branchIndex >= 0 ? args[branchIndex + 1] : undefined;
			const target = branchIndex >= 0 ? args[branchIndex + 2] : args[2];
			const workerAdd = gitCommand
				&& args[0] === "worktree"
				&& args[1] === "add"
				&& branch?.startsWith(`goal/${goalId!.slice(0, 8)}/coder-`);
			if (workerAdd && normalized(String(options?.cwd ?? "")) === normalized(join(projectRoot, NESTED_COMPONENT))) {
				failedBranch = branch;
				firstComponentWorktree = target;
				failedContainer = dirname(dirname(target));
			}
			if (workerAdd && normalized(String(options?.cwd ?? "")) === normalized(join(projectRoot, FAILED_COMPONENT))) {
				failedComponentWorktree = target;
				const error = new Error("injected beta git worktree add failure");
				(error as any).stderr = "injected beta git worktree add failure";
				throw error;
			}
			return originalExecFile!.call(runner, file, args, options);
		};

		let injectedFailure: unknown;
		try {
			await gateway.teamManager.spawnRole(goalId!, "coder", "Prove partial multi-repo rollback");
		} catch (error) {
			injectedFailure = error;
		} finally {
			(runner as any).execFile = originalExecFile;
			originalExecFile = undefined;
		}
		const failureMessage = injectedFailure instanceof Error ? injectedFailure.message : String(injectedFailure ?? "spawn succeeded");
		if (!/beta.*(?:git )?worktree add|(?:git )?worktree add.*beta/i.test(failureMessage)) {
			throw new Error(`${REPRO}: expected beta git worktree add failure, received: ${failureMessage}`);
		}
		expect(failedBranch, "injection must run after the first component worktree add").toBeTruthy();
		expect(firstComponentWorktree, "nested first-component target must be observed").toBeTruthy();
		expect(failedComponentWorktree, "failed second-component target must be observed").toBeTruthy();
		expect(firstComponentWorktree && existsSync(firstComponentWorktree), "nested first-component worktree must be rolled back").toBe(false);
		expect(firstComponentWorktree && existsSync(dirname(firstComponentWorktree)), "nested repo-key intermediate directory must be rolled back").toBe(false);
		expect(failedContainer && existsSync(failedContainer), "empty worker branch container must be rolled back").toBe(false);
		expect(failedComponentWorktree && existsSync(failedComponentWorktree), "failed second-component target must never be created").toBe(false);
		expect(rollbackWorktreeRemoveTargets.map(normalized)).toContain(normalized(firstComponentWorktree!));
		expect(
			rollbackWorktreeRemoveTargets.map(normalized),
			"rollback must not invoke git worktree remove for the failed, never-created component",
		).not.toContain(normalized(failedComponentWorktree!));
		expect(
			await gitRefExists(runner, join(projectRoot, NESTED_COMPONENT), `refs/heads/${failedBranch}`),
			"nested first-component branch must be rolled back",
		).toBe(false);
		for (const repo of COMPONENTS) {
			expect(
				await git(runner, goal.repoWorktrees[repo], ["rev-parse", "HEAD"]),
				`${repo} goal component must remain usable after worker rollback`,
			).toBe(goalHeads[repo]);
		}

		// Direct production call: this is the primary host-side regression boundary.
		const directResult = await gateway.teamManager.spawnRole(goalId!, "coder", "Direct coordinated spawn");
		directWorkerId = directResult.sessionId;
		expect(directResult.worktreePath).toBeTruthy();
		const directPaths = assertWorkerShape({
			gateway,
			runner,
			projectRoot,
			goalId: goalId!,
			goalHeads,
			sessionId: directWorkerId!,
			worktreePath: directResult.worktreePath!,
		});
		const directBranch = gateway.teamManager.findAgentBySessionId(directWorkerId!)!.branch!;
		for (const repo of COMPONENTS) {
			expect(await git(runner, directPaths[repo], ["rev-parse", "HEAD"]), `${repo} must start at its exact local goal HEAD`).toBe(goalHeads[repo]);
			expect(await git(runner, directPaths[repo], ["branch", "--show-current"]), `${repo} must use the common worker branch`).toBe(directBranch);
		}
		expect(existsSync(join(projectRoot, ".git")), "worker spawn must not make the project container a repository").toBe(false);

		// Ordinary dismissal + purge must consume the worker's known component map,
		// not probe the non-Git branch container as though it were a repository.
		const dismissed = await gateway.teamManager.dismissRoleForGoal(goalId!, directWorkerId!);
		expect(dismissed.status).toBe("dismissed");
		const purgeResponse = await apiFetch(`/api/sessions/${directWorkerId}?purge=true`, { method: "DELETE" });
		expect(purgeResponse.status, `${REPRO}: direct worker purge must succeed`).toBe(200);
		await pollUntil(
			async () => COMPONENTS.every(repo => !existsSync(directPaths[repo])) && !existsSync(directResult.worktreePath!) ? true : null,
			{ timeoutMs: 15_000, intervalMs: 50, label: "direct worker component purge" },
		);
		expect(
			existsSync(dirname(directPaths[NESTED_COMPONENT])),
			"ordinary purge must remove the nested repo-key intermediate directory",
		).toBe(false);
		directWorkerId = undefined;

		// Exactly one REST team/spawn request proves the HTTP route reaches the same
		// fixed TeamManager path and returns the worker branch container.
		const spawnResponse = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({ role: "coder", task: "REST coordinated spawn" }),
		});
		const spawnBody = await readJson(spawnResponse);
		expect(
			spawnResponse.status,
			`${REPRO}: POST team/spawn must accept a non-Git multi-repo container: ${JSON.stringify(spawnBody)}`,
		).toBe(201);
		restWorkerId = spawnBody.sessionId;
		expect(restWorkerId).toBeTruthy();
		expect(spawnBody.worktreePath).toBeTruthy();
		assertWorkerShape({
			gateway,
			runner,
			projectRoot,
			goalId: goalId!,
			goalHeads,
			sessionId: restWorkerId!,
			worktreePath: spawnBody.worktreePath,
		});
	} finally {
		if (originalExecFile) (runner as any).execFile = originalExecFile;
		for (const workerId of [directWorkerId, restWorkerId]) {
			if (!workerId || !goalId) continue;
			await gateway.teamManager.dismissRoleForGoal(goalId, workerId).catch(() => undefined);
			await apiFetch(`/api/sessions/${workerId}?purge=true`, { method: "DELETE" }).catch(() => undefined);
		}
		if (goalId) await teardownTeam(goalId).catch(() => undefined);
		if (teamLeadSessionId) await apiFetch(`/api/sessions/${teamLeadSessionId}?purge=true`, { method: "DELETE" }).catch(() => undefined);
		if (goalId) await deleteGoal(goalId).catch(() => undefined);
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
		rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});
