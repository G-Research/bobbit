import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../../../tests/support/harnesses/integration/gateway/in-process-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	defaultProjectId,
	nonGitCwd,
} from "../../../tests/support/harnesses/integration/gateway/e2e-setup.js";
import { loadServerTestRuntime } from "../../../tests/support/harnesses/shared/server-runtime.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = (await loadServerTestRuntime()).server;
});

test.describe.configure({ mode: "serial", timeout: 60_000 });

function status(ahead: number, untrackedIncluded: boolean) {
	return {
		branch: "goal/polyrepo-fetch",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: false,
		status: [],
		hasUpstream: true,
		ahead,
		behind: 0,
		aheadOfPrimary: ahead,
		behindPrimary: 0,
		mergedIntoPrimary: false,
		insertionsVsPrimary: ahead,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: ahead > 0,
		partial: false,
		untrackedIncluded,
	};
}

function makePolyrepoRoot(tag: string): { root: string; api: string; web: string } {
	const root = join(nonGitCwd(), `git-status-polyrepo-${tag}-${process.pid}-${Date.now()}`);
	const api = join(root, "api");
	const web = join(root, "web");
	mkdirSync(api, { recursive: true });
	mkdirSync(web, { recursive: true });
	return { root, api, web };
}

test("goal and session fetch every component and invalidate summary plus untracked caches", async ({ gateway }) => {
	const goalPaths = makePolyrepoRoot("goal");
	const sessionPaths = makePolyrepoRoot("session");
	const projectId = await defaultProjectId();
	const goal = await createGoal({ title: `Polyrepo fetch goal ${Date.now()}`, cwd: goalPaths.root, projectId: projectId!, worktree: false });
	const sessionId = await createSession({ cwd: sessionPaths.root, projectId: projectId! });

	const goalContext = gateway.projectContextManager.getContextForGoal(goal.id as string);
	const liveGoal = goalContext?.goalStore.get(goal.id as string) as any;
	expect(liveGoal).toBeTruthy();
	Object.assign(liveGoal, {
		cwd: goalPaths.root,
		worktreePath: goalPaths.root,
		branch: "goal/polyrepo-fetch",
		repoWorktrees: { api: goalPaths.api, web: goalPaths.web },
	});

	const liveSession = gateway.sessionManager.getSession(sessionId) as any;
	expect(liveSession).toBeTruthy();
	Object.assign(liveSession, {
		cwd: sessionPaths.root,
		repoWorktrees: [
			{ repo: "api", repoPath: sessionPaths.api, worktreePath: sessionPaths.api },
			{ repo: "web", repoPath: sessionPaths.web, worktreePath: sessionPaths.web },
		],
	});

	const values = new Map<string, number>([
		[goalPaths.api, 1], [goalPaths.web, 2],
		[sessionPaths.api, 3], [sessionPaths.web, 4],
	]);
	const statusCalls = new Map<string, number>();
	serverModule.__setGitStatusFake(async (cwd: string, _cid?: string, opts?: { untracked?: boolean }) => {
		statusCalls.set(cwd, (statusCalls.get(cwd) ?? 0) + 1);
		const ahead = values.get(cwd);
		return ahead === undefined ? null : status(ahead, opts?.untracked === true);
	});

	const runner = (gateway.sessionManager as any).commandRunner;
	const originalExecFile = runner.execFile;
	const fetchCalls: string[] = [];
	runner.execFile = async (file: string, args: readonly string[], options?: any) => {
		if (file === "git" && args.join(" ") === "fetch --quiet") {
			const cwd = String(options?.cwd ?? "");
			fetchCalls.push(cwd);
			if (cwd === goalPaths.root || cwd === sessionPaths.root) throw new Error("non-Git root fetch failed");
			return { stdout: "", stderr: "" };
		}
		return originalExecFile(file, args, options);
	};

	try {
		for (const endpoint of [`/api/goals/${goal.id}/git-status`, `/api/sessions/${sessionId}/git-status`]) {
			expect((await apiFetch(endpoint)).status).toBe(200);
			expect((await apiFetch(`${endpoint}?untracked=1`)).status).toBe(200);
		}

		values.set(goalPaths.api, 10);
		values.set(goalPaths.web, 20);
		values.set(sessionPaths.api, 30);
		values.set(sessionPaths.web, 40);

		const goalFetch = await apiFetch(`/api/goals/${goal.id}/git-status?fetch=true`);
		expect(goalFetch.status).toBe(200);
		expect(await goalFetch.json()).toMatchObject({ aggregate: { ahead: 30 }, repos: { api: { ahead: 10 }, web: { ahead: 20 } } });
		const sessionFetch = await apiFetch(`/api/sessions/${sessionId}/git-status?fetch=true`);
		expect(sessionFetch.status).toBe(200);
		expect(await sessionFetch.json()).toMatchObject({ aggregate: { ahead: 70 }, repos: { api: { ahead: 30 }, web: { ahead: 40 } } });

		// `fetch=true` invalidates both cache variants, not only the summary key.
		const beforeUntracked = new Map(statusCalls);
		const goalUntracked = await apiFetch(`/api/goals/${goal.id}/git-status?untracked=1`);
		expect(goalUntracked.status).toBe(200);
		expect(await goalUntracked.json()).toMatchObject({ aggregate: { ahead: 30, untrackedIncluded: true } });
		const sessionUntracked = await apiFetch(`/api/sessions/${sessionId}/git-status?untracked=1`);
		expect(sessionUntracked.status).toBe(200);
		expect(await sessionUntracked.json()).toMatchObject({ aggregate: { ahead: 70, untrackedIncluded: true } });
		for (const component of [goalPaths.api, goalPaths.web, sessionPaths.api, sessionPaths.web]) {
			expect(statusCalls.get(component)).toBe((beforeUntracked.get(component) ?? 0) + 1);
		}

		expect(fetchCalls.sort()).toEqual([
			goalPaths.api, goalPaths.root, goalPaths.web,
			sessionPaths.api, sessionPaths.root, sessionPaths.web,
		].sort());
	} finally {
		runner.execFile = originalExecFile;
		serverModule.__clearGitStatusFake();
		for (const worktreePath of [
			goalPaths.root, goalPaths.api, goalPaths.web,
			sessionPaths.root, sessionPaths.api, sessionPaths.web,
		]) serverModule.invalidateGitStatusCache(worktreePath);
	}
});
