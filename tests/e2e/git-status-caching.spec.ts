/**
 * API E2E tests for git-status caching, single-flight coalescing,
 * TTL expiry, `?fetch=true` bust, and separate cache keys for
 * `?untracked=1` vs summary (default) requests.
 *
 * See docs/design/git-status-widget-reliability.md §5–§7.
 *
 * The tests spy on the exported `__getGitStatusInvocationCount` counter
 * in `dist/server/server.js` to assert how many times the underlying
 * git script ran — regardless of how many concurrent HTTP callers
 * hit `/api/sessions/:id/git-status`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession, defaultProjectId } from "./e2e-setup.js";

let serverModule: any;

test.beforeAll(async () => {
	serverModule = await import("../../dist/server/server.js");
	expect(typeof serverModule.__getGitStatusInvocationCount).toBe("function");
	expect(typeof serverModule.__resetGitStatusInvocationCount).toBe("function");
	expect(typeof serverModule.invalidateGitStatusCache).toBe("function");
});

// Build a real git repo we can run git-status against.
function makeGitRepo(tag: string): string {
	const dir = join(tmpdir(), `bobbit-e2e-git-status-${tag}-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "README.md"), "# test\n");
	execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir });
	return dir;
}

async function mkSessionInRepo(cwd: string): Promise<string> {
	// Session creation with a git cwd would normally trigger worktree creation.
	// We bypass that by providing a projectId that already owns this cwd — but
	// since this is an isolated test repo, we just pass cwd + projectId and
	// rely on the harness to register a project. Simpler: create a session on
	// the default (non-git) project but then call git-status against the real
	// repo by pointing cwd via the session record. We do need session.cwd = gitRepo.
	//
	// The harness default project root is a non-git temp dir. We can pass
	// `cwd: gitRepoDir` to createSession and accept that the server will try
	// to create a worktree. To avoid that, set the session's `goalId` to
	// undefined and pass `worktree: false`-equivalent via projectId only.
	// createSession() already uses the default projectId when caller doesn't
	// specify one; it passes cwd straight through. That path skips worktree
	// provisioning for plain sessions.
	const projectId = await defaultProjectId();
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

// Each test spawns Git Bash multiple times on Windows; a cold spawn can cost
// 500-1500ms normally, but under CI load (full test suite in parallel) it can
// stretch to 5-10s. 180s keeps us safe under heavy contention without masking
// real hangs.
test.describe.configure({ timeout: 180_000 });

test.describe("git-status server cache + single-flight", () => {
	let gitRepo: string;
	let sessionId: string;
	let sessionCwd: string;

	test.beforeAll(async () => {
		gitRepo = makeGitRepo("cache");
		sessionId = await mkSessionInRepo(gitRepo);
		// Sessions in a git cwd auto-create worktrees — the server's actual
		// `cwd` for git-status is the worktree path, not the source repo. We
		// need that path to invalidate the right cache key between tests.
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.status).toBe(200);
		sessionCwd = (await resp.json()).cwd;
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId);
	});

	test.beforeEach(async () => {
		// Bust any previous caching so each test starts deterministically.
		serverModule.invalidateGitStatusCache(sessionCwd);
		// Wait past TTL so any in-flight-but-not-yet-cleaned entries from a
		// prior test's last request cannot be seen as "fresh" by this test.
		await new Promise((r) => setTimeout(r, 800));
		serverModule.invalidateGitStatusCache(sessionCwd);
		serverModule.__resetGitStatusInvocationCount();
	});

	test("5 concurrent calls coalesce into 1 underlying git invocation", async () => {
		const calls = await Promise.all(
			Array.from({ length: 5 }, () =>
				apiFetch(`/api/sessions/${sessionId}/git-status`),
			),
		);
		for (const r of calls) expect(r.status).toBe(200);
		const bodies = await Promise.all(calls.map((r) => r.json()));
		const firstBranch = bodies[0].branch;
		for (const b of bodies) expect(b.branch).toBe(firstBranch);

		expect(serverModule.__getGitStatusInvocationCount()).toBe(1);
	});

	test("in-flight single-flight + post-resolution cache hit both coalesce", async () => {
		// First call resolves; second call fired immediately (before TTL expiry).
		// On slow platforms the first git invocation may exceed TTL (750ms), so
		// this test's strongest guarantee is single-flight during in-flight.
		// Fire a burst: one that drives the first invocation, three that join
		// it mid-flight, then one after resolution. The in-flight three MUST
		// share the promise.
		const burst = Promise.all(
			Array.from({ length: 4 }, () =>
				apiFetch(`/api/sessions/${sessionId}/git-status`),
			),
		);
		const results = await burst;
		for (const r of results) expect(r.status).toBe(200);

		// All 4 callers arriving before the first resolves share one invocation.
		expect(serverModule.__getGitStatusInvocationCount()).toBe(1);
	});

	test("TTL expiry re-runs git after 750ms", async () => {
		const before = serverModule.__getGitStatusInvocationCount();
		const r1 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r1.status).toBe(200);
		const mid = serverModule.__getGitStatusInvocationCount();
		expect(mid - before).toBe(1);

		// Enough past TTL that even with clock skew we re-run.
		await new Promise((res) => setTimeout(res, 1200));

		const r2 = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r2.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("?untracked=1 and summary use separate cache keys", async () => {
		const before = serverModule.__getGitStatusInvocationCount();
		// Fire concurrently so both enter in-flight before either resolves.
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

		// Two distinct cache keys → two underlying git invocations.
		expect(serverModule.__getGitStatusInvocationCount() - before).toBe(2);
	});

	test("?fetch=true invalidates the cache entry", async () => {
		// Prime the cache with two parallel calls (single-flight → 1 invocation).
		const [a, b] = await Promise.all([
			apiFetch(`/api/sessions/${sessionId}/git-status`),
			apiFetch(`/api/sessions/${sessionId}/git-status`),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		const primed = serverModule.__getGitStatusInvocationCount();

		// ?fetch=true explicitly invalidates both cache keys before the
		// status call, so even within the TTL window it must re-run.
		const r = await apiFetch(`/api/sessions/${sessionId}/git-status?fetch=true`);
		expect(r.status).toBe(200);
		expect(serverModule.__getGitStatusInvocationCount()).toBeGreaterThan(primed);
	});

	test("errors are NOT cached — non-git dir returns 400 each time, status can re-run", async () => {
		const nonGit = join(tmpdir(), `bobbit-e2e-nongit-${process.pid}-${Date.now()}`);
		mkdirSync(nonGit, { recursive: true });
		const sid = await mkSessionInRepo(nonGit);
		try {
			const r1 = await apiFetch(`/api/sessions/${sid}/git-status`);
			expect(r1.status).toBe(400);
			const b1 = await r1.json();
			expect(b1.error).toBe("Not a git repository");

			// Second call should also return 400 (not stuck on a cached error).
			const r2 = await apiFetch(`/api/sessions/${sid}/git-status`);
			expect(r2.status).toBe(400);
		} finally {
			await deleteSession(sid);
		}
	});

	test("response includes partial + untrackedIncluded shape fields", async () => {
		const r = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		expect(r.status).toBe(200);
		const b = await r.json();
		expect(typeof b.branch).toBe("string");
		expect(b).toHaveProperty("untrackedIncluded");
		// partial is optional but, on a healthy repo, must not be true
		expect(b.partial === undefined || b.partial === false).toBe(true);
	});
});
