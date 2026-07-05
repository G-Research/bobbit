/**
 * Focused coverage for session git-status publication policy.
 *
 * The git-status producer and branch publisher are faked so these tests verify
 * only the HTTP handler's policy/observability decisions, not Git itself.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, deleteSession } from "./e2e-setup.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = await import("../../dist/server/skills/git-gh.js");
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

async function mkFakeSession(tag: string): Promise<{ id: string; cwd: string }> {
	const cwd = join(tmpdir(), `bobbit-e2e-git-status-policy-${tag}-${process.pid}-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId }),
	});
	expect(resp.status).toBe(201);
	const { id } = await resp.json();
	const s = await apiFetch(`/api/sessions/${id}`);
	expect(s.status).toBe(200);
	const { cwd: realCwd } = await s.json();
	mkdirSync(realCwd, { recursive: true });
	return { id, cwd: realCwd };
}

async function withRemotePushEnabled<T>(fn: () => Promise<T>): Promise<T> {
	const previous = process.env.BOBBIT_TEST_NO_PUSH;
	process.env.BOBBIT_TEST_NO_PUSH = "0";
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = previous;
	}
}

test.describe("session git-status local-only publication policy", () => {
	let createdSessionIds: string[] = [];
	let currentResult: Record<string, unknown>;
	let publishCalls: Array<{ cwd: string; branch: string; opts: Record<string, unknown> }>;

	test.beforeEach(() => {
		createdSessionIds = [];
		publishCalls = [];
		currentResult = okResult();
		serverModule.__setGitStatusFake(async () => currentResult);
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

	test("does not auto-publish and reports policy when persisted metadata is local-only", async ({ gateway }) => {
		const { id, cwd } = await mkFakeSession("local-only");
		createdSessionIds.push(id);
		const persisted = gateway.sessionManager.getPersistedSession(id) as any;
		expect(persisted, "session must be persisted").toBeTruthy();
		persisted.worktreePushPolicy = "local-only";
		currentResult = okResult({
			branch: "goal/656b8057/coder-abcd",
			isOnPrimary: false,
			ahead: 3,
			hasUpstream: true,
			unpushed: true,
		});
		serverModule.invalidateGitStatusCache(cwd);

		const resp = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status`));
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.remotePublication).toBe("local-only-policy");
		expect(body.aggregate.remotePublication).toBe("local-only-policy");

		expect(publishCalls).toHaveLength(0);
	});

	test("does not classify goal/ or session/ prefixes as local-only without metadata", async () => {
		const { id, cwd } = await mkFakeSession("prefixes");
		createdSessionIds.push(id);

		currentResult = okResult({
			branch: "goal/integration-12345678",
			isOnPrimary: false,
			ahead: 2,
			hasUpstream: true,
			unpushed: true,
		});
		serverModule.invalidateGitStatusCache(cwd);
		const goalResp = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status`));
		expect(goalResp.status).toBe(200);
		expect((await goalResp.json()).remotePublication).toBeUndefined();
		await expect.poll(() => publishCalls.length, { timeout: 1_000 }).toBe(1);
		expect(publishCalls[0].branch).toBe("goal/integration-12345678");
		expect(publishCalls[0].opts.setUpstream).toBeUndefined();

		currentResult = okResult({
			branch: "session/helper-abcdef",
			isOnPrimary: false,
			ahead: 0,
			hasUpstream: false,
			unpushed: false,
		});
		serverModule.invalidateGitStatusCache(cwd);
		const sessionResp = await withRemotePushEnabled(() => apiFetch(`/api/sessions/${id}/git-status`));
		expect(sessionResp.status).toBe(200);
		expect((await sessionResp.json()).remotePublication).toBeUndefined();
		await expect.poll(() => publishCalls.length, { timeout: 1_000 }).toBe(2);
		expect(publishCalls[1].branch).toBe("session/helper-abcdef");
		expect(publishCalls[1].opts.setUpstream).toBe(true);
	});
});
