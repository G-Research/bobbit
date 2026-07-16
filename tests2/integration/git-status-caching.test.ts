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
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, deleteSession, defaultProjectId, nonGitCwd } from "./_e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = (await loadServerTestRuntime()).server;
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
	const cwd = mkdtempSync(join(nonGitCwd(), `gitfake-${tag}-${process.pid}-`));
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
	let sessionId = "";
	let sessionCwd = "";

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

	// Per-test producer state keeps this suite independent from other files sharing
	// the fork-scoped server module. A gate holds the producer in flight without a
	// wall-clock sleep, making coalescing deterministic.
	let fakeShouldThrow = false;
	let fakeReturnsNull = false;
	let fakeGate: {
		started(): void;
		allStarted: Promise<void>;
		release(): void;
		waitForRelease: Promise<void>;
	} | undefined;

	function blockFakeUntilReleased(expectedStarts: number): NonNullable<typeof fakeGate> {
		let starts = 0;
		let resolveStarted!: () => void;
		let resolveRelease!: () => void;
		const gate = {
			started: () => { if (++starts === expectedStarts) resolveStarted(); },
			allStarted: new Promise<void>((resolve) => { resolveStarted = resolve; }),
			release: () => resolveRelease(),
			waitForRelease: new Promise<void>((resolve) => { resolveRelease = resolve; }),
		};
		fakeGate = gate;
		return gate;
	}

	test.beforeEach(async () => {
		const s = await mkFakeSession("cache");
		sessionId = s.id;
		sessionCwd = s.cwd;
		fakeShouldThrow = false;
		fakeReturnsNull = false;
		fakeGate = undefined;
		serverModule.invalidateGitStatusCache(sessionCwd);
		serverModule.__resetGitStatusInvocationCount();
		serverModule.__setGitStatusFake(async (_cwd: string, _cid: string | undefined, opts?: { untracked?: boolean }) => {
			const gate = fakeGate;
			if (gate) {
				gate.started();
				await gate.waitForRelease;
			}
			if (fakeShouldThrow) throw new Error("fake git error");
			if (fakeReturnsNull) return null;
			return okResult({ untrackedIncluded: opts?.untracked === true });
		});
	});

	test.afterEach(async () => {
		fakeGate?.release();
		serverModule.__clearGitStatusFake();
		if (sessionCwd) serverModule.invalidateGitStatusCache(sessionCwd);
		if (sessionId) await deleteSession(sessionId);
		sessionId = "";
		sessionCwd = "";
	});

	test("5 concurrent calls coalesce into 1 underlying git invocation", async () => {
		const gate = blockFakeUntilReleased(1);
		const pending = Promise.all(
			Array.from({ length: 5 }, () => apiFetch(`/api/sessions/${sessionId}/git-status`)),
		);
		await gate.allStarted;
		gate.release();
		const calls = await pending;
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
		const gate = blockFakeUntilReleased(1);
		const burst = Promise.all(
			Array.from({ length: 4 }, () => apiFetch(`/api/sessions/${sessionId}/git-status`)),
		);
		await gate.allStarted;
		gate.release();
		const results = await burst;
		for (const r of results) expect(r.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount()).toBe(1);
	});

	test("TTL expiry re-runs git after 750ms", async () => {
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r1.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(1);

		serverModule.__forceGitStatusCacheExpiry(sessionCwd);

		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("within TTL a second call is a cache hit (1 invocation)", async () => {
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r1.status).toBe(200);
		// Fire the second call immediately, well within the TTL window.
		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(1);
	});

	test("?untracked=1 and summary use separate cache keys", async () => {
		const gate = blockFakeUntilReleased(2);
		const before = serverModule.__getGitStatusInvocationCount();
		const pending = Promise.all([
			apiFetch(`/api/sessions/${sessionId}/git-status`),
			apiFetch(`/api/sessions/${sessionId}/git-status?untracked=1`),
		]);
		await gate.allStarted;
		gate.release();
		const [rSum, rU] = await pending;
		expect(rSum.status).toBe(200);
		expect(rU.status).toBe(200);

		const bSum = await rSum.json();
		const bU = await rU.json();
		expect(bU.untrackedIncluded).toBe(true);
		expect(bSum.untrackedIncluded).toBe(false);

		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("?fetch=true invalidates the cache entry", async () => {
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
		// Handler is single-attempt now (no internal retry loop). One
		// invocation per failed HTTP call; verify the outer status is 500.
		expect(r1.status).toBe(500);

		fakeShouldThrow = false;
		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		// Exactly 2: 1 failed + 1 fresh success. Errors are not cached so the
		// second call falls through to a fresh underlying invocation.
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
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
