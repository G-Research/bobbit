/**
 * API E2E tests for git-status caching, single-flight coalescing,
 * TTL expiry, `?fetch=true` bust, and separate cache keys for
 * `?untracked=1` vs summary (default) requests.
 *
 * See docs/design/git-status-widget-reliability.md §5–§7.
 *
 * These tests DO NOT depend on spawning Git Bash. Under CI load the Git Bash
 * spawn path fails unpredictably with transient spawn errors that the
 * production retry logic already handles for real users — but asserting
 * deterministic invocation counts on top of a flaky spawn is impossible.
 * Instead we install a `__setGitStatusFake` hook that replaces the real
 * spawn path with a fast, deterministic fake. The cache/TTL/single-flight
 * layer ABOVE runBatchGitStatus is what these tests actually verify — that
 * layer doesn't care whether the producer is git or a fake.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, deleteSession, defaultProjectId } from "./e2e-setup.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = await import("../../dist/server/server.js");
	expect(typeof serverModule.__getGitStatusInvocationCount).toBe("function");
	expect(typeof serverModule.__resetGitStatusInvocationCount).toBe("function");
	expect(typeof serverModule.__setGitStatusFake).toBe("function");
	expect(typeof serverModule.__clearGitStatusFake).toBe("function");
	expect(typeof serverModule.invalidateGitStatusCache).toBe("function");
});

// Create a session pointing at an arbitrary cwd (doesn't need to be a git
// repo — the fake returns whatever we program). We still need cwd to exist
// so the handler's fs.existsSync check passes.
async function mkFakeSession(tag: string): Promise<{ id: string; cwd: string }> {
	const cwd = join(tmpdir(), `bobbit-e2e-gitfake-${tag}-${process.pid}-${Date.now()}`);
	mkdirSync(cwd, { recursive: true });
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId }),
	});
	expect(resp.status).toBe(201);
	const { id } = await resp.json();
	// Session creation in a non-git cwd may skip worktree provisioning, but
	// fetch the actual session cwd to be safe (worktree path if applicable).
	const s = await apiFetch(`/api/sessions/${id}`);
	const { cwd: realCwd } = await s.json();
	// Ensure the dir exists (worktree path is created by the server; our
	// original temp dir also exists).
	try { mkdirSync(realCwd, { recursive: true }); } catch { /* already exists */ }
	return { id, cwd: realCwd };
}

test.describe.configure({ timeout: 60_000 });

test.describe("git-status server cache + single-flight", () => {
	let sessionId: string;
	let sessionCwd: string;

	// The fake's shape matches GitStatusResult from the server.
	function okResult(overrides: Record<string, unknown> = {}) {
		return {
			branch: "master",
			primaryBranch: "master",
			isOnPrimary: true,
			hasPrimary: true,
			ahead: 0,
			behind: 0,
			aheadOfPrimary: 0,
			behindPrimary: 0,
			hasUpstream: false,
			upstream: null,
			status: [],
			clean: true,
			partial: false,
			untrackedIncluded: false,
			...overrides,
		};
	}

	// Delay controls how long the fake takes to resolve — used to exercise
	// in-flight single-flight coalescing.
	let fakeDelayMs = 0;
	// Error controls whether the fake throws (for testing error-not-cached).
	let fakeShouldThrow = false;
	// Null controls whether the fake returns null (not-a-repo).
	let fakeReturnsNull = false;

	test.beforeAll(async () => {
		const s = await mkFakeSession("cache");
		sessionId = s.id;
		sessionCwd = s.cwd;
		serverModule.__setGitStatusFake(async (_cwd: string, _cid: string | undefined, opts?: { untracked?: boolean }) => {
			if (fakeDelayMs > 0) await new Promise((r) => setTimeout(r, fakeDelayMs));
			if (fakeShouldThrow) throw new Error("fake git error");
			if (fakeReturnsNull) return null;
			return okResult({ untrackedIncluded: opts?.untracked === true });
		});
	});

	test.afterAll(async () => {
		serverModule.__clearGitStatusFake();
		if (sessionId) await deleteSession(sessionId);
	});

	test.beforeEach(async () => {
		fakeDelayMs = 0;
		fakeShouldThrow = false;
		fakeReturnsNull = false;
		serverModule.invalidateGitStatusCache(sessionCwd);
		await new Promise((r) => setTimeout(r, 800));
		serverModule.invalidateGitStatusCache(sessionCwd);
		serverModule.__resetGitStatusInvocationCount();
	});

	test("5 concurrent calls coalesce into 1 underlying git invocation", async () => {
		fakeDelayMs = 80; // enough that all 5 arrive while first is in-flight
		const calls = await Promise.all(
			Array.from({ length: 5 }, () =>
				apiFetch(`/api/sessions/${sessionId}/git-status`),
			),
		);
		for (const r of calls) {
			if (r.status !== 200) {
				const body = await r.text().catch(() => "<no body>");
				throw new Error(`expected 200 got ${r.status}: ${body}`);
			}
		}
		const bodies = await Promise.all(calls.map((r) => r.json()));
		for (const b of bodies) expect(b.branch).toBe("master");
		expect(serverModule.__getGitStatusInvocationCount()).toBe(1);
	});

	test("in-flight single-flight — 4 callers share one invocation", async () => {
		fakeDelayMs = 80;
		const burst = Promise.all(
			Array.from({ length: 4 }, () =>
				apiFetch(`/api/sessions/${sessionId}/git-status`),
			),
		);
		const results = await burst;
		for (const r of results) expect(r.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount()).toBe(1);
	});

	test("TTL expiry re-runs git after 750ms", async () => {
		fakeDelayMs = 0;
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r1.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(1);

		await new Promise((res) => setTimeout(res, 1200));

		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("within TTL a second call is a cache hit (1 invocation)", async () => {
		fakeDelayMs = 0;
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r1.status).toBe(200);
		// Fire second call well within the 750ms TTL window.
		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(1);
	});

	test("?untracked=1 and summary use separate cache keys", async () => {
		fakeDelayMs = 50;
		const before = serverModule.__getGitStatusInvocationCount();
		const [rSum, rU] = await Promise.all([
			apiFetch(`/api/sessions/${sessionId}/git-status`),
			apiFetch(`/api/sessions/${sessionId}/git-status?untracked=1`),
		]);
		expect(rSum.status).toBe(200);
		expect(rU.status).toBe(200);

		const bSum = await rSum.json();
		const bU = await rU.json();
		expect(bU.untrackedIncluded).toBe(true);
		expect(bSum.untrackedIncluded).toBe(false);

		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("?fetch=true invalidates the cache entry", async () => {
		fakeDelayMs = 0;
		const [a, b] = await Promise.all([
			apiFetch(`/api/sessions/${sessionId}/git-status`),
			apiFetch(`/api/sessions/${sessionId}/git-status`),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		const primed = serverModule.__getGitStatusInvocationCount();

		const r = await apiFetch(`/api/sessions/${sessionId}/git-status?fetch=true`);
		expect(r.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount()).toBeGreaterThan(primed);
	});

	test("errors are NOT cached — error then success both run fresh", async () => {
		fakeShouldThrow = true;
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		// Handler retries once internally, so 2 invocations for a single
		// failed HTTP call; verify the outer status is 500 and that state
		// didn't leak into the cache.
		expect(r1.status).toBe(500);

		fakeShouldThrow = false;
		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		// >=3 because handler does 2 internal attempts on failure + 1 fresh success.
		expect(serverModule.__getGitStatusInvocationCount() - before).toBeGreaterThanOrEqual(3);
	});

	test("not-a-repo (null result) returns 400", async () => {
		fakeReturnsNull = true;
		const r = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r.status).toBe(400);
		const b = await r.json();
		expect(b.error).toBe("Not a git repository");
	});

	test("response includes partial + untrackedIncluded shape fields", async () => {
		const r = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r.status).toBe(200);
		const b = await r.json();
		expect(typeof b.branch).toBe("string");
		expect(b).toHaveProperty("untrackedIncluded");
		expect(b.partial === undefined || b.partial === false).toBe(true);
	});
});
