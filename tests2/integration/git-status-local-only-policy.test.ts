/**
 * Focused HTTP coverage for read-only session git status.
 *
 * The status producer and branch publisher are faked so these tests pin the
 * route boundary: status may inspect/fetch refs, but only POST /git-push may
 * invoke the publisher.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProjectId, deleteSession, gitCwd, nonGitCwd } from "./_e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = (await loadServerTestRuntime()).server;
	expect(typeof serverModule.__setGitStatusFake).toBe("function");
	expect(typeof serverModule.__clearGitStatusFake).toBe("function");
	expect(typeof serverModule.invalidateGitStatusCache).toBe("function");
	expect(typeof serverModule.__setPublishCurrentBranchToOriginFake).toBe("function");
	expect(typeof serverModule.__clearPublishCurrentBranchToOriginFake).toBe("function");
});

test.describe.configure({ mode: "serial", timeout: 60_000 });

function okResult(overrides: Record<string, unknown> = {}) {
	return {
		branch: "master",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: true,
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: true,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		status: [],
		clean: true,
		summary: "clean",
		unpushed: false,
		partial: false,
		untrackedIncluded: false,
		...overrides,
	};
}

async function mkSession(tag: string, requestedCwd?: string): Promise<{ id: string; cwd: string }> {
	const cwd = requestedCwd ?? join(nonGitCwd(), `git-status-read-only-${tag}-${process.pid}-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId }),
	});
	expect(resp.status).toBe(201);
	const { id } = await resp.json();
	const sessionResp = await apiFetch(`/api/sessions/${id}`);
	expect(sessionResp.status).toBe(200);
	const { cwd: realCwd } = await sessionResp.json();
	mkdirSync(realCwd, { recursive: true });
	return { id, cwd: realCwd };
}

async function withRemotePushEnabled<T>(fn: () => Promise<T>): Promise<T> {
	const prev = serverModule.__setServerRemoteGitPolicy({ skipRemotePush: false });
	try {
		return await fn();
	} finally {
		serverModule.__setServerRemoteGitPolicy(prev);
	}
}

test.describe("session git-status read-only contract", () => {
	let createdSessionIds: string[] = [];
	let currentResult: Record<string, unknown>;
	let publishCalls: Array<{ cwd: string; branch: string; opts: Record<string, unknown> }>;
	let statusCalls: Array<{ cwd: string; opts?: { untracked?: boolean; configuredBaseRef?: string } }>;

	test.beforeEach(() => {
		createdSessionIds = [];
		publishCalls = [];
		statusCalls = [];
		currentResult = okResult();
		serverModule.__setGitStatusFake(async (cwd: string, _containerId?: string, opts?: { untracked?: boolean; configuredBaseRef?: string }) => {
			statusCalls.push({ cwd, opts });
			return currentResult;
		});
		serverModule.__setPublishCurrentBranchToOriginFake(async (cwd: string, branch: string, opts: Record<string, unknown>) => {
			publishCalls.push({ cwd, branch, opts });
			return "published";
		});
	});

	test.afterEach(async () => {
		serverModule.__clearGitStatusFake();
		serverModule.__clearPublishCurrentBranchToOriginFake();
		await Promise.all(createdSessionIds.map((id) => deleteSession(id).catch(() => {})));
	});

	test("repeated status reads preserve upstream/base_ref data without publishing", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const store = gateway.projectContextManager.getOrCreate(projectId!)?.projectConfigStore;
		expect(store).toBeTruthy();
		const previousBaseRef = store!.get("base_ref");
		store!.set("base_ref", "origin/master");

		try {
			const { id, cwd } = await mkSession("repeated");
			createdSessionIds.push(id);
			const persisted = gateway.sessionManager.getPersistedSession(id) as any;
			persisted.worktreePushPolicy = "publish";
			persisted.remotePublicationPolicy = "publish";
			currentResult = okResult({
				branch: "goal/integration-12345678",
				isOnPrimary: false,
				hasUpstream: true,
				ahead: 3,
				aheadOfPrimary: 3,
				mergedIntoPrimary: false,
				unpushed: true,
			});
			serverModule.invalidateGitStatusCache(cwd);

			for (const suffix of ["", "?fetch=true", "", "?untracked=1"]) {
				const response = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status${suffix}`));
				expect(response.status).toBe(200);
				const body = await response.json();
				expect(body).toMatchObject({
					branch: "goal/integration-12345678",
					hasUpstream: true,
					ahead: 3,
					primaryRef: "origin/master",
				});
				expect(body.remotePublication).toBeUndefined();
				expect(body.aggregate.remotePublication).toBeUndefined();
			}

			expect(statusCalls.some((call) => call.opts?.configuredBaseRef === "origin/master")).toBe(true);
			expect(publishCalls).toHaveLength(0);

			currentResult = okResult({
				branch: "session/helper-abcdef",
				isOnPrimary: false,
				hasUpstream: false,
				mergedIntoPrimary: false,
				unpushed: true,
			});
			serverModule.invalidateGitStatusCache(cwd);
			const noUpstream = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status`));
			expect(noUpstream.status).toBe(200);
			expect(await noUpstream.json()).toMatchObject({ branch: "session/helper-abcdef", hasUpstream: false });
			expect(publishCalls).toHaveLength(0);
		} finally {
			if (previousBaseRef) store!.set("base_ref", previousBaseRef);
			else store!.remove("base_ref");
		}
	});

	test("multi-repo status aggregation remains read-only", async ({ gateway }) => {
		const { id, cwd } = await mkSession("multi");
		createdSessionIds.push(id);
		const apiWorktree = join(cwd, "api");
		const webWorktree = join(cwd, "web");
		mkdirSync(apiWorktree, { recursive: true });
		mkdirSync(webWorktree, { recursive: true });
		const live = gateway.sessionManager.getSession(id) as any;
		live.repoWorktrees = [
			{ repo: "api", repoPath: apiWorktree, worktreePath: apiWorktree },
			{ repo: "web", repoPath: webWorktree, worktreePath: webWorktree },
		];
		currentResult = okResult({
			branch: "session/multi-abcdef",
			isOnPrimary: false,
			hasUpstream: true,
			ahead: 1,
			aheadOfPrimary: 1,
			mergedIntoPrimary: false,
			unpushed: true,
		});
		serverModule.invalidateGitStatusCache(cwd);

		const response = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status?fetch=true`));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(Object.keys(body.repos).sort()).toEqual(["api", "web"]);
		expect(body.aggregate).toMatchObject({ branch: "session/multi-abcdef", ahead: 1 });
		expect(publishCalls).toHaveLength(0);
	});

	test("explicit POST git-push still invokes the branch publisher", async () => {
		const { id } = await mkSession("explicit", gitCwd());
		createdSessionIds.push(id);
		const runtime = await loadServerTestRuntime();
		const runner = runtime.gatewayDeps.realCommandRunner;
		const originalExecFile = runner.execFile;
		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			const command = args.join(" ");
			if (command === "symbolic-ref --short HEAD") return { stdout: "feature/explicit", stderr: "" };
			if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") throw new Error("no upstream");
			return originalExecFile(file, args, options);
		};

		try {
			const response = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-push`, { method: "POST" }));
			const body = await response.json();
			expect(response.status, JSON.stringify(body)).toBe(200);
			expect(body).toMatchObject({ ok: true, output: "published" });
			expect(publishCalls).toHaveLength(1);
			expect(publishCalls[0]).toMatchObject({ branch: "feature/explicit", opts: { setUpstream: true } });
		} finally {
			runner.execFile = originalExecFile;
		}
	});
});
