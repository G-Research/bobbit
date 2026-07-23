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
test("direct and REST team spawn preserve exact local component HEADs across collisions, rollback, and cleanup", async ({ gateway }) => {
	await prepareGitTemplate();
	const fixtureRoot = mkdtempSync(join(gateway.bobbitDir, "team-multi-minimal-"));
	const projectRoot = join(fixtureRoot, "project");
	const worktreeRoot = join(fixtureRoot, "worktrees");
	const runner = gateway.sessionManager.commandRunner as CommandRunner;
	let projectId: string | undefined;
	let goalId: string | undefined;
	let teamLeadSessionId: string | undefined;
	let collisionWorkerId: string | undefined;
	let directWorkerId: string | undefined;
	let restWorkerId: string | undefined;
	let originalExecFile: CommandRunner["execFile"] | undefined;
	let originalUpdateSessionMeta: any;
	let originalSessionStorePut: any;
	let interceptedSessionStore: any;

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

		// Pin the exact-start collision boundary after one earlier component has
		// already been created. The second component owns a worker-named branch at
		// its source HEAD, deliberately divergent from its unpublished goal HEAD.
		// Provisioning must reject before attaching or mutating that branch, roll
		// back only the first component it created, and perform no remote mutation.
		const projectContext = gateway.projectContextManager.getContextForGoal(goalId!);
		expect(projectContext, "multi-repo goal must retain its project context").toBeTruthy();
		projectContext!.projectConfigStore.set("base_ref", "master");
		originalExecFile = runner.execFile;
		let collidingBranch: string | undefined;
		let collidingBranchHead: string | undefined;
		let collisionContainer: string | undefined;
		let firstCreatedWorktree: string | undefined;
		let collidingWorktree: string | undefined;
		const collisionWorktreeAddTargets: string[] = [];
		const rollbackWorktreeRemoveTargetsForCollision: string[] = [];
		const upstreamMutationCalls: Array<{ cwd: string; args: string[] }> = [];
		const localBranchDeleteCalls: Array<{ cwd: string; branch: string }> = [];
		const remoteMutationCalls: Array<{ cwd: string; args: string[] }> = [];
		(runner as any).execFile = async (file: string, args: string[], options: any) => {
			const gitCommand = file.toLowerCase().replace(/\.exe$/, "") === "git";
			const cwd = String(options?.cwd ?? "");
			if (gitCommand && args[0] === "worktree" && args[1] === "remove") {
				rollbackWorktreeRemoveTargetsForCollision.push(String(args[2]));
			}
			if (gitCommand && args[0] === "branch" && args.some(arg => arg.startsWith("--set-upstream-to="))) {
				upstreamMutationCalls.push({ cwd, args: [...args] });
			}
			if (gitCommand && args[0] === "branch" && args[1] === "-D") {
				localBranchDeleteCalls.push({ cwd, branch: String(args[2]) });
			}
			if (gitCommand && args[0] === "push") {
				remoteMutationCalls.push({ cwd, args: [...args] });
			}

			if (gitCommand && args[0] === "worktree" && args[1] === "add") {
				const branchIndex = args.indexOf("-b");
				const branch = String(branchIndex >= 0 ? args[branchIndex + 1] : args[3]);
				const target = String(branchIndex >= 0 ? args[branchIndex + 2] : args[2]);
				const workerAdd = branch.startsWith(`goal/${goalId!.slice(0, 8)}/coder-`);
				if (workerAdd && normalized(cwd) === normalized(join(projectRoot, NESTED_COMPONENT))) {
					firstCreatedWorktree = target;
					collisionContainer = resolve(
						target,
						...NESTED_COMPONENT.split("/").map(() => ".."),
					);
					if (!collidingBranch) {
						collidingBranch = branch;
						const result = await originalExecFile!.call(runner, "git", ["rev-parse", "HEAD"], {
							cwd: join(projectRoot, FAILED_COMPONENT),
							encoding: "utf-8",
							timeout: 10_000,
						});
						collidingBranchHead = String(result.stdout).trim();
						await originalExecFile!.call(runner, "git", ["branch", collidingBranch, collidingBranchHead], {
							cwd: join(projectRoot, FAILED_COMPONENT),
							encoding: "utf-8",
							timeout: 10_000,
						});
					}
				}
				if (workerAdd && normalized(cwd) === normalized(join(projectRoot, FAILED_COMPONENT))) {
					collidingWorktree = target;
					collisionWorktreeAddTargets.push(target);
				}
			}
			return originalExecFile!.call(runner, file, args, options);
		};

		let collisionFailure: unknown;
		try {
			const result = await gateway.teamManager.spawnRole(goalId!, "coder", "Reject a divergent exact-start branch collision");
			collisionWorkerId = result.sessionId;
		} catch (error) {
			collisionFailure = error;
		} finally {
			(runner as any).execFile = originalExecFile;
			originalExecFile = undefined;
		}
		const collisionFailureMessage = collisionFailure instanceof Error
			? collisionFailure.message
			: String(collisionFailure ?? "spawn succeeded");
		if (
			!/component\s+["']?beta["']?/i.test(collisionFailureMessage)
			|| !/(?:exact start|does not match|mismatch|collision|differs)/i.test(collisionFailureMessage)
		) {
			throw new Error(`${REPRO}: expected beta exact-start branch collision rejection, received: ${collisionFailureMessage}`);
		}
		expect(collidingBranch, "fixture must create beta's colliding worker branch after alpha starts").toBeTruthy();
		expect(collidingBranchHead, "fixture must retain the divergent beta branch HEAD").toBeTruthy();
		expect(collidingBranchHead, "beta collision must differ from its authoritative unpublished goal HEAD").not.toBe(goalHeads[FAILED_COMPONENT]);
		expect(firstCreatedWorktree, "collision must be detected only after the first component was created").toBeTruthy();
		expect(collisionContainer, "first component must reveal the worker branch container").toBeTruthy();
		const expectedCollidingWorktree = join(collisionContainer!, FAILED_COMPONENT);
		expect(firstCreatedWorktree && existsSync(firstCreatedWorktree), "earlier nested component worktree must be rolled back").toBe(false);
		expect(firstCreatedWorktree && existsSync(dirname(firstCreatedWorktree)), "earlier nested repo-key directory must be rolled back").toBe(false);
		expect(existsSync(collisionContainer!), "empty collision-attempt container must be rolled back").toBe(false);
		expect(rollbackWorktreeRemoveTargetsForCollision.map(normalized)).toContain(normalized(firstCreatedWorktree!));
		expect(collisionWorktreeAddTargets, "beta collision must be rejected before git worktree add can attach it").toEqual([]);
		expect(collidingWorktree, "beta collision must never produce a worker worktree target").toBeUndefined();
		expect(existsSync(expectedCollidingWorktree), "beta collision path must never be created").toBe(false);
		expect(
			await git(runner, join(projectRoot, FAILED_COMPONENT), ["rev-parse", `refs/heads/${collidingBranch}`]),
			"collision rejection must preserve beta's divergent local branch HEAD exactly",
		).toBe(collidingBranchHead);
		expect(
			await git(runner, join(projectRoot, FAILED_COMPONENT), ["worktree", "list", "--porcelain"]),
			"collision rejection must not leave beta's branch attached to any worktree",
		).not.toContain(`branch refs/heads/${collidingBranch}`);
		expect(
			await git(runner, join(projectRoot, FAILED_COMPONENT), ["for-each-ref", "--format=%(upstream)", `refs/heads/${collidingBranch}`]),
			"collision rejection must not assign an upstream to beta's pre-existing branch",
		).toBe("");
		expect(
			upstreamMutationCalls.some(call => normalized(call.cwd) === normalized(expectedCollidingWorktree)),
			"collision rejection must occur before beta's upstream mutation step",
		).toBe(false);
		expect(
			localBranchDeleteCalls.some(call => normalized(call.cwd) === normalized(join(projectRoot, FAILED_COMPONENT)) && call.branch === collidingBranch),
			"rollback must not ask Git to delete beta's pre-existing colliding branch",
		).toBe(false);
		expect(remoteMutationCalls, "collision rejection and rollback must not mutate any remote").toEqual([]);
		expect(
			await gitRefExists(runner, join(projectRoot, NESTED_COMPONENT), `refs/heads/${collidingBranch}`),
			"rollback must delete the earlier alpha branch created by this attempt",
		).toBe(false);
		for (const repo of COMPONENTS) {
			expect(
				await git(runner, goal.repoWorktrees[repo], ["rev-parse", "HEAD"]),
				`${repo} goal component must remain at its authoritative HEAD after collision rollback`,
			).toBe(goalHeads[repo]);
		}
		await git(runner, join(projectRoot, FAILED_COMPONENT), ["branch", "-D", collidingBranch!]);

		// Direct production call: this is the primary host-side regression boundary.
		// Observe the project SessionStore boundary so the first durable worker
		// record can be distinguished from TeamManager's later metadata update.
		const sessionWriteEvents: Array<{ kind: "put" | "update"; id: string; value: any }> = [];
		interceptedSessionStore = gateway.projectContextManager.getContextForGoal(goalId!)!.sessionStore;
		originalSessionStorePut = interceptedSessionStore.put;
		originalUpdateSessionMeta = (gateway.sessionManager as any).updateSessionMeta;
		interceptedSessionStore.put = (persisted: any) => {
			if (persisted.goalId === goalId && persisted.role === "coder") {
				sessionWriteEvents.push({
					kind: "put",
					id: persisted.id,
					value: {
						...persisted,
						repoWorktrees: persisted.repoWorktrees ? { ...persisted.repoWorktrees } : undefined,
					},
				});
			}
			return originalSessionStorePut.call(interceptedSessionStore, persisted);
		};
		(gateway.sessionManager as any).updateSessionMeta = (id: string, updates: any) => {
			if (updates?.role === "coder" && updates?.teamGoalId === goalId) {
				sessionWriteEvents.push({
					kind: "update",
					id,
					value: {
						...updates,
						repoWorktrees: updates.repoWorktrees ? { ...updates.repoWorktrees } : undefined,
					},
				});
			}
			return originalUpdateSessionMeta.call(gateway.sessionManager, id, updates);
		};

		let directResult: Awaited<ReturnType<typeof gateway.teamManager.spawnRole>>;
		try {
			directResult = await gateway.teamManager.spawnRole(goalId!, "coder", "Direct coordinated spawn");
		} finally {
			interceptedSessionStore.put = originalSessionStorePut;
			originalSessionStorePut = undefined;
			(gateway.sessionManager as any).updateSessionMeta = originalUpdateSessionMeta;
			originalUpdateSessionMeta = undefined;
			interceptedSessionStore = undefined;
		}
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
		const firstDurableWriteIndex = sessionWriteEvents.findIndex(event => event.kind === "put" && event.id === directWorkerId);
		const laterTeamMetaIndex = sessionWriteEvents.findIndex(event => event.kind === "update" && event.id === directWorkerId);
		expect(firstDurableWriteIndex, "createSession must make a durable worker write").toBeGreaterThanOrEqual(0);
		expect(laterTeamMetaIndex, "TeamManager must retain its later worker metadata update").toBeGreaterThan(firstDurableWriteIndex);
		const firstDurableWorker = firstDurableWriteIndex >= 0 ? sessionWriteEvents[firstDurableWriteIndex].value : {};
		expect.soft(firstDurableWorker.worktreePath, "first durable write must already own the branch container").toBe(directResult.worktreePath!);
		expect.soft(firstDurableWorker.repoPath, "first durable write must already own the non-Git repo container").toBe(projectRoot);
		expect.soft(firstDurableWorker.branch, "first durable write must already own the worker branch").toBe(directBranch);
		expect.soft(Object.keys(firstDurableWorker.repoWorktrees ?? {}).sort(), "first durable write must already own both component cleanup paths").toEqual([...COMPONENTS].sort());
		for (const repo of COMPONENTS) {
			expect.soft(firstDurableWorker.repoWorktrees?.[repo], `${repo} cleanup coordinate must exist in the first durable write`).toBe(directPaths[repo]);
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
		if (originalUpdateSessionMeta) (gateway.sessionManager as any).updateSessionMeta = originalUpdateSessionMeta;
		if (originalSessionStorePut && interceptedSessionStore) interceptedSessionStore.put = originalSessionStorePut;
		for (const workerId of [collisionWorkerId, directWorkerId, restWorkerId]) {
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
