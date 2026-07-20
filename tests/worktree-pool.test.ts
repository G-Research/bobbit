/**
 * Unit tests for WorktreePool — claim sequence.
 *
 * Real git is required; uses a freshly-init'd repo in a temp directory.
 * Tests focus on:
 *   - happy-path claim renames branch + moves directory to the final
 *     `session/<id8>` name in one synchronous step
 *   - claim() returns null when the directory rename fails so the caller
 *     falls back to createWorktree (no half-renamed persistent state)
 *   - claim/freshen does not require a remote and still succeeds in no-push tests
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WorktreePool, isPoolBranch } from "../src/server/agent/worktree-pool.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";
import type { CommandRunner, ExecFileResult } from "../src/server/gateway-deps.ts";
import { makeTmpDir } from "./helpers/tmp.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFile = promisify(execFileCb);

async function makeRepo(): Promise<string> {
	const dir = makeTmpDir("bobbit-pool-test-");
	const repo = path.join(dir, "repo");
	fs.mkdirSync(repo, { recursive: true });
	await execFile("git", ["init", "--initial-branch=master"], { cwd: repo });
	await execFile("git", ["config", "user.email", "test@test"], { cwd: repo });
	await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
	await execFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
	return repo;
}

async function rmRepo(repoPath: string) {
	const root = path.dirname(repoPath);
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function initGitRepo(dir: string): Promise<void> {
	fs.mkdirSync(dir, { recursive: true });
	await execFile("git", ["init", "--initial-branch=master"], { cwd: dir });
	await execFile("git", ["config", "user.email", "test@test"], { cwd: dir });
	await execFile("git", ["config", "user.name", "Test"], { cwd: dir });
	await execFile("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

describe("WorktreePool — Phase 3 claim sequence", () => {
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;

	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("isPoolBranch matches new and legacy prefixes", () => {
		assert.equal(isPoolBranch("pool/_pool-abcd1234"), true);
		assert.equal(isPoolBranch("session/_pool-abcd1234"), true);
		assert.equal(isPoolBranch("session/foo-bar"), false);
		assert.equal(isPoolBranch("master"), false);
	});

	it("happy path: claim renames branch and moves directory to session/<id8>", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			// Wait for fill — simple poll loop.
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry after fill");

			// Capture the pooled branch name BEFORE claim. claim() kicks off a
			// background refill (replenish() → _fill() back up to targetSize), which
			// legitimately creates a NEW `pool/_pool-*` branch. So asserting the
			// global absence of the `pool/_pool-` prefix after claim is racy (the
			// refill can land before the assertion under load). Instead assert that
			// THIS pooled branch was renamed away — claim's actual contract.
			const listBranches = async (): Promise<string[]> => {
				const { stdout } = await execFile("git", ["branch", "--list"], { cwd: repo });
				return stdout.split("\n").map((s) => s.replace(/^[*+]?\s*/, "").trim()).filter(Boolean);
			};
			const pooledBranch = (await listBranches()).find((b) => b.startsWith("pool/_pool-"));
			assert.ok(pooledBranch, "a pool branch should exist before claim");

			const claim = await pool.claim("session/abcd1234");
			assert.ok(claim, "claim should succeed");
			assert.equal(claim!.branchName, "session/abcd1234");
			assert.equal(claim!.degraded, false);

			// Verify the pooled branch was renamed to the session branch.
			const after = await listBranches();
			assert.ok(after.includes("session/abcd1234"), "target branch should exist");
			assert.ok(!after.includes(pooledBranch!), "the claimed pool branch should be renamed away");

			// Verify the directory was moved (path basename is the flattened slug).
			assert.equal(path.basename(claim!.worktreePath), "session-abcd1234");
			assert.ok(fs.existsSync(claim!.worktreePath), "new worktree dir should exist");
		} finally {
			await rmRepo(repo);
		}
	});

	it("directory-rename failure returns null so caller falls back to createWorktree", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			// Pre-create a *file* at the destination path — `git worktree move`
			// refuses with "target already exists" rather than touching it.
			const wtRoot = path.resolve(repo, "..", `${path.basename(repo)}-wt`);
			const blocker = path.join(wtRoot, "session-deadbeef");
			fs.writeFileSync(blocker, "in the way");

			const claim = await pool.claim("session/deadbeef");
			assert.equal(claim, null, "claim must return null on dir-rename failure (no half-state)");

			// Branch must not be left renamed: the pool branch should be gone
			// (entry was cleaned up) AND the target branch should not be present.
			const { stdout: branchList } = await execFile("git", ["branch", "--list"], { cwd: repo });
			assert.ok(!branchList.includes("session/deadbeef"), "target branch must not be left behind");
		} finally {
			await rmRepo(repo);
		}
	});

	it("setTitle does not trigger any branch rename (regression: branch is stable post-claim)", async () => {
		// Sanity check: there is no public API on WorktreePool that performs a
		// post-claim rename. Verifies the absence of `claimUnnamed` / first-prompt
		// rename helpers — if someone re-introduces them, this test still passes,
		// but the symbol-grep guard below catches the regression.
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 50 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);

			const claim = await pool.claim("session/cafebabe");
			assert.ok(claim);
			const branchBefore = claim!.branchName;
			const pathBefore = claim!.worktreePath;

			// Simulate "first prompt": there's no API that renames a claimed entry.
			// Verify branch + path are byte-stable in our records (and on disk).
			const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pathBefore });
			assert.equal(stdout.trim(), branchBefore, "branch on disk must equal claimed branch");
			assert.equal(branchBefore, "session/cafebabe");
			assert.ok(fs.existsSync(pathBefore));
		} finally {
			await rmRepo(repo);
		}
	});

	it("claim returns null when pool is empty and never throws in no-push mode", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 0 });
			// targetSize 0 → fill loop exits immediately
			pool.startFilling();
			await new Promise(r => setTimeout(r, 100));
			const claim = await pool.claim("session/foo-deadbeef");
			assert.equal(claim, null, "empty pool should return null");
		} finally {
			await rmRepo(repo);
		}
	});

	it("freshen skips missing origin in no-remote test mode without logging a reset failure", async () => {
		const repo = await makeRepo();
		const originalNoRemote = process.env.BOBBIT_TEST_NO_REMOTE;
		const originalNoExternal = process.env.BOBBIT_TEST_NO_EXTERNAL;
		const originalWarn = console.warn;
		const warnings: string[] = [];
		process.env.BOBBIT_TEST_NO_REMOTE = "1";
		process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 0, remotePolicy: { skipNonLocalRemoteGit: true } });
			await (pool as any).freshen(repo, "session/no-remote");
		} finally {
			console.warn = originalWarn;
			if (originalNoRemote === undefined) delete process.env.BOBBIT_TEST_NO_REMOTE;
			else process.env.BOBBIT_TEST_NO_REMOTE = originalNoRemote;
			if (originalNoExternal === undefined) delete process.env.BOBBIT_TEST_NO_EXTERNAL;
			else process.env.BOBBIT_TEST_NO_EXTERNAL = originalNoExternal;
			await rmRepo(repo);
		}
		assert.equal(
			warnings.some(w => w.includes("[worktree-pool] Background reset failed") || w.includes("git fetch origin")),
			false,
			`freshen should not attempt origin in no-remote test mode; warnings: ${warnings.join("\n")}`,
		);
	});
});

describe("WorktreePool — orphan reclaim", () => {
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;
	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});
			after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("reclaims pool branches from the configured worktree root through the shared classifier", async () => {
		const repo = await makeRepo();
		try {
			const configuredRoot = path.join(path.dirname(repo), "configured-wt");
			const wtPath = path.join(configuredRoot, "pool-_pool-reclaim1");
			fs.mkdirSync(configuredRoot, { recursive: true });
			await execFile("git", ["worktree", "add", "-b", "pool/_pool-reclaim1", wtPath, "HEAD"], { cwd: repo });
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1, worktreeRoot: configuredRoot });
			await (pool as any).reclaimOrphaned();
			const snapshot = pool.snapshotEntries();
			assert.equal(snapshot.entries.length, 1);
			assert.equal(snapshot.entries[0].branchName, "pool/_pool-reclaim1");
			assert.equal(snapshot.entries[0].worktreePath, wtPath);
		} finally {
			await rmRepo(repo);
		}
	});

	it("does not duplicate an orphan already present in the in-memory pool", async () => {
		const repo = await makeRepo();
		try {
			const configuredRoot = path.join(path.dirname(repo), "configured-wt");
			const wtPath = path.join(configuredRoot, "pool-_pool-idempotent");
			fs.mkdirSync(configuredRoot, { recursive: true });
			await execFile("git", ["worktree", "add", "-b", "pool/_pool-idempotent", wtPath, "HEAD"], { cwd: repo });
			const pool = new WorktreePool({ repoPath: repo, targetSize: 2, worktreeRoot: configuredRoot });
			(pool as any).pool.push({ branchName: "pool/_pool-idempotent", worktreePath: wtPath, createdAt: Date.now() });
			await (pool as any).reclaimOrphaned();
			const snapshot = pool.snapshotEntries();
			assert.equal(snapshot.entries.length, 1);
			assert.equal(snapshot.entries[0].branchName, "pool/_pool-idempotent");
			assert.equal(snapshot.entries[0].worktreePath, wtPath);
		} finally {
			await rmRepo(repo);
		}
	});

	it("does not reclaim a multi-repo pool container with mixed component branches", async () => {
		const root = makeTmpDir("bobbit-pool-mixed-branch-");
		try {
			const apiRepo = path.join(root, "api");
			const webRepo = path.join(root, "web");
			await initGitRepo(apiRepo);
			await initGitRepo(webRepo);

			const configuredRoot = path.join(root, "configured-wt");
			const container = path.join(configuredRoot, "pool-_pool-mixed");
			fs.mkdirSync(container, { recursive: true });
			await execFile("git", ["worktree", "add", "-b", "pool/_pool-mixed", path.join(container, "api"), "HEAD"], { cwd: apiRepo });
			await execFile("git", ["worktree", "add", "-b", "pool/_pool-other", path.join(container, "web"), "HEAD"], { cwd: webRepo });

			const components: Component[] = [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			];
			const pool = new WorktreePool({
				repoPath: root,
				projectRoot: root,
				targetSize: 1,
				worktreeRoot: configuredRoot,
				componentsResolver: () => components,
			});
			await (pool as any).reclaimOrphaned();

			const snapshot = pool.snapshotEntries();
			assert.equal(snapshot.entries.length, 0, "mixed-branch multi-repo containers must not become ready pool entries");
		} finally {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	it("does not reclaim a multi-repo pool container when a declared component repo is incomplete", async () => {
		const root = makeTmpDir("bobbit-pool-incomplete-component-");
		try {
			const apiRepo = path.join(root, "api");
			await initGitRepo(apiRepo);
			fs.mkdirSync(path.join(root, "web"), { recursive: true });

			const configuredRoot = path.join(root, "configured-wt");
			const container = path.join(configuredRoot, "pool-_pool-incomplete");
			fs.mkdirSync(container, { recursive: true });
			await execFile("git", ["worktree", "add", "-b", "pool/_pool-incomplete", path.join(container, "api"), "HEAD"], { cwd: apiRepo });

			const components: Component[] = [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web" },
			];
			const pool = new WorktreePool({
				repoPath: root,
				projectRoot: root,
				targetSize: 1,
				worktreeRoot: configuredRoot,
				componentsResolver: () => components,
			});
			await (pool as any).reclaimOrphaned();

			const snapshot = pool.snapshotEntries();
			assert.equal(snapshot.entries.length, 0, "incomplete multi-repo containers must not become ready pool entries");
		} finally {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});

describe("WorktreePool — components[*].worktreeSetupCommand is the source of truth", () => {
	// These tests must NOT set BOBBIT_SKIP_NPM_CI — we're asserting the setup
	// hook actually fires. Keep BOBBIT_TEST_NO_PUSH so we don't touch any remote.
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;
	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		delete process.env.BOBBIT_SKIP_NPM_CI;
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("single-repo pool fill runs the default component's worktreeSetupCommand", async () => {
		const repo = await makeRepo();
		try {
			const components: Component[] = [
				{ name: "app", repo: ".", worktreeSetupCommand: "touch SETUP_RAN" },
			];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should have one entry");

			const u = await pool.claim("session/abcd1234");
			assert.ok(u, "claim should succeed");
			const marker = path.join(u!.worktreePath, "SETUP_RAN");
			assert.ok(
				fs.existsSync(marker),
				`SETUP_RAN marker missing from pool worktree at ${marker} — setup hook did not run`,
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("threads the project worktree_setup_timeout_ms into pool component setup", async () => {
		const repo = await makeRepo();
		try {
			const components: Component[] = [
				{ name: "app", repo: ".", worktreeSetupCommand: "sleep 5; touch SETUP_RAN" },
			];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
				// Tiny project default — the setup command sleeps far longer, so the
				// resolved timeout must kill it before it can create the marker. Without
				// threading (hardcoded 120000) the sleep would finish and the marker
				// would appear. Mirrors the per-goal timeout-resolution path.
				setupTimeoutResolver: () => 50,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1, "pool should still expose the entry (setup failure is non-fatal)");
			const u = await pool.claim("session/abcd1234");
			assert.ok(u, "claim should succeed after timed-out setup cleanup releases worktree handles");
			assert.equal(
				fs.existsSync(path.join(u!.worktreePath, "SETUP_RAN")),
				false,
				"component setup must be killed by the resolved project timeout before touching the marker",
			);
		} finally {
			await rmRepo(repo);
		}
	});

	it("single-repo pool fill is a no-op when no component declares worktreeSetupCommand", async () => {
		const repo = await makeRepo();
		try {
			const components: Component[] = [{ name: "app", repo: "." }];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);
			const u = await pool.claim("session/abcd1234");
			assert.ok(u);
			// Worktree is fully usable; just no SETUP_RAN file.
			assert.ok(fs.existsSync(path.join(u!.worktreePath, ".git")));
		} finally {
			await rmRepo(repo);
		}
	});

	it("BOBBIT_SKIP_NPM_CI=1 bypasses runComponentSetups", async () => {
		const repo = await makeRepo();
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		try {
			const components: Component[] = [
				{ name: "app", repo: ".", worktreeSetupCommand: "touch SETUP_RAN" },
			];
			const pool = new WorktreePool({
				repoPath: repo,
				targetSize: 1,
				componentsResolver: () => components,
				worktreeSetupRuntime: { skipNpmCi: true },
			});
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
			}
			assert.equal(pool.size, 1);
			const u = await pool.claim("session/abcd1234");
			assert.ok(u);
			assert.equal(
				fs.existsSync(path.join(u!.worktreePath, "SETUP_RAN")),
				false,
				"SETUP_RAN should NOT exist when BOBBIT_SKIP_NPM_CI=1",
			);
		} finally {
			delete process.env.BOBBIT_SKIP_NPM_CI;
			await rmRepo(repo);
		}
	});
});

describe("Restart round-trip: pool worktrees left in place are reclaimed, not rebuilt", () => {
	// Pins the shutdown fix: the gateway must NOT drain worktree pools on
	// shutdown. Pool entries are local-only `pool/_pool-*` worktrees; leaving
	// them on disk lets the next boot's reclaimOrphaned() re-adopt them
	// instantly instead of destroying them (git worktree remove + branch -D +
	// pointless remote delete) and rebuilding from scratch (worktree add + npm
	// ci) over the minutes after start.
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;
	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("a fresh pool reclaims the worktrees an abandoned (undrained) pool left behind", async () => {
		const repo = await makeRepo();
		try {
			// Boot #1: fill the pool to two ready worktrees.
			const pool1 = new WorktreePool({ repoPath: repo, targetSize: 2 });
			pool1.startFilling();
			for (let i = 0; i < 100 && pool1.size < 2; i++) await new Promise(r => setTimeout(r, 100));
			assert.equal(pool1.size, 2, "pool should fill to two entries on first boot");
			const firstBootPaths = pool1.snapshotEntries().entries.map(e => e.worktreePath).sort();
			const firstBootBranches = pool1.snapshotEntries().entries.map(e => e.branchName).sort();

			// Shutdown WITHOUT draining: simply abandon the in-memory pool object.
			// The worktrees remain on disk (this is the invariant under test).
			for (const p of firstBootPaths) {
				assert.ok(fs.existsSync(p), `worktree ${p} must survive an undrained shutdown`);
			}

			// Boot #2: a fresh pool over the same repo reclaims — no rebuild.
			const pool2 = new WorktreePool({ repoPath: repo, targetSize: 2 });
			await (pool2 as any).reclaimOrphaned();
			const secondBootPaths = pool2.snapshotEntries().entries.map(e => e.worktreePath).sort();
			const secondBootBranches = pool2.snapshotEntries().entries.map(e => e.branchName).sort();

			assert.deepEqual(secondBootPaths, firstBootPaths, "second boot must reclaim the exact worktrees left in place");
			assert.deepEqual(secondBootBranches, firstBootBranches, "second boot must reclaim the same pool branches (no new ones built)");
		} finally {
			await rmRepo(repo);
		}
	});
});

describe("Regression: gateway shutdown must not drain worktree pools", () => {
	it("server.ts shutdown() does not call .drain() and documents why", () => {
		const serverTs = fs.readFileSync(path.resolve(__dirname, "..", "src", "server", "server.ts"), "utf-8");
		// Brace-match the shutdown() body (opening `{` to its matching close) so we
		// scan exactly the method — not a fixed-size window that can spill into the
		// next declaration or truncate as shutdown() grows. Inner braces
		// (template `${…}`, arrow bodies) are balanced, so depth-counting lands on
		// the true close.
		const start = serverTs.indexOf("async shutdown()");
		assert.ok(start >= 0, "shutdown() method must exist in server.ts");
		const braceStart = serverTs.indexOf("{", start);
		assert.ok(braceStart > start, "shutdown() opening brace not found");
		let depth = 0, end = -1;
		for (let i = braceStart; i < serverTs.length; i++) {
			const c = serverTs[i];
			if (c === "{") depth++;
			else if (c === "}" && --depth === 0) { end = i; break; }
		}
		assert.ok(end > braceStart, "shutdown() closing brace not found");
		const body = serverTs.slice(braceStart, end + 1);
		// Draining on shutdown destroys pool worktrees the next boot must rebuild —
		// see the restart round-trip suite above.
		assert.equal(/\.drain\s*\(/.test(body), false,
			"gateway shutdown() must not drain worktree pools — leave them on disk for reclaimOrphaned() on next boot");
		// Pin the WHY so a future edit can't silently reintroduce the drain.
		assert.match(body, /intentionally NOT drained on shutdown/,
			"shutdown() must document why pools are not drained (guards against silent reintroduction)");
	});
});

describe("Regression: rename helpers and claimUnnamed must stay deleted", () => {
	it("no source file references renameSessionFromPool / claimUnnamed / UnnamedClaim", () => {
		const srcRoot = path.resolve(__dirname, "..", "src");
		const banned = /(renameSessionFromPool|_renameSessionFromPoolMultiRepo|claimUnnamed|UnnamedClaim)/;
		const hits: string[] = [];
		function scan(dir: string) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) { scan(p); continue; }
				if (!entry.name.endsWith(".ts")) continue;
				const body = fs.readFileSync(p, "utf-8");
				if (banned.test(body)) hits.push(path.relative(srcRoot, p));
			}
		}
		scan(srcRoot);
		assert.deepEqual(
			hits,
			[],
			`Files reference removed rename/claimUnnamed symbols: ${hits.join(", ")}`,
		);
	});

	it("moveWorktree is no longer exported from src/server/skills/git.ts", () => {
		const gitTs = path.resolve(__dirname, "..", "src", "server", "skills", "git.ts");
		const body = fs.readFileSync(gitTs, "utf-8");
		assert.equal(/export\s+(async\s+)?function\s+moveWorktree\b/.test(body), false,
			"moveWorktree must be inlined into worktree-pool.ts (design §14)");
		assert.equal(/export\s+class\s+WorktreeMoveError\b/.test(body), false,
			"WorktreeMoveError must be removed from skills/git.ts");
	});
});

describe("Regression: legacy top-level worktree_setup_command must not be read", () => {
	it("no source file under src/ reads `worktree_setup_command` via projectConfigStore.get()", () => {
		// The migration in state-migration/migrate-project-yaml.ts is the only
		// allowed reader of the legacy top-level key. Every other reader is a
		// regression of the components[*].worktreeSetupCommand source-of-truth.
		const srcRoot = path.resolve(__dirname, "..", "src");
		const hits: string[] = [];
		function scan(dir: string) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) { scan(p); continue; }
				if (!entry.name.endsWith(".ts")) continue;
				// migrate-project-yaml.ts is the one allowed reader.
				if (p.endsWith(path.join("state-migration", "migrate-project-yaml.ts"))) continue;
				const body = fs.readFileSync(p, "utf-8");
				// Match the exact bug we just fixed: a `.get("worktree_setup_command")`
				// or `.get('worktree_setup_command')` call. Allows the string to appear
				// in comments / migration-specific helpers / settings UI labels.
				if (/\.get\(\s*[\"']worktree_setup_command[\"']\s*\)/.test(body)) {
					hits.push(path.relative(srcRoot, p));
				}
			}
		}
		scan(srcRoot);
		assert.deepEqual(
			hits,
			[],
			`Files reading legacy top-level worktree_setup_command via .get(): ${hits.join(", ")}`,
		);
	});
});

describe("WorktreePool — drain() stops and settles background work (teardown race)", () => {
	// Pins the lifecycle contract that keeps Group A (single shared node:test
	// process) deterministic: after `drain()` resolves, NO background fill /
	// freshen `git` child is still running or pending. Previously a `claim()`'s
	// fire-and-forget `replenish()` + `freshenInBackground()` could outlive the
	// test and race `rmRepo()` — spewing `spawn git ENOENT` / misreported
	// `base_ref '<ref>' no longer exists`, and starving later tests' fills so
	// their `pool.size` polls timed out at 0. It is also a real production
	// teardown race: `removeWorktreePool()` -> `drain()` must not let a
	// post-claim replenish rebuild worktrees for a project being deleted.
	const originalNoPush = process.env.BOBBIT_TEST_NO_PUSH;
	const originalSkipNpm = process.env.BOBBIT_SKIP_NPM_CI;
	before(() => {
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
	});
	after(() => {
		if (originalNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
		else process.env.BOBBIT_TEST_NO_PUSH = originalNoPush;
		if (originalSkipNpm === undefined) delete process.env.BOBBIT_SKIP_NPM_CI;
		else process.env.BOBBIT_SKIP_NPM_CI = originalSkipNpm;
	});

	it("after claim + drain, no background fill leaks and the pool stays quiescent", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			pool.startFilling();
			for (let i = 0; i < 100 && pool.size === 0; i++) await new Promise(r => setTimeout(r, 100));
			assert.equal(pool.size, 1, "pool should fill one entry before claim");

			// claim() schedules a background replenish() (refill) AND a
			// freshenInBackground() on the claimed worktree. Both are fire-and-forget.
			const claim = await pool.claim("session/abcd1234");
			assert.ok(claim, "claim should succeed");

			// drain() must set the stop flag and AWAIT the in-flight replenish +
			// freshen before returning. So once it resolves, isFilling is false and
			// there is no live `git` child to race the rmRepo() below.
			await pool.drain();
			assert.equal(pool.isFilling, false, "drain() must await the in-flight fill (isFilling clears)");
			assert.equal(pool.size, 0, "drain() must leave the pool empty");

			// After drain the pool is stopped: further startFilling() is inert and
			// MUST NOT rebuild entries (guards the production teardown race).
			pool.startFilling();
			for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 100));
			assert.equal(pool.size, 0, "a stopped pool must not refill after startFilling()");
			assert.equal(pool.isFilling, false, "a stopped pool must not enter the filling state");
		} finally {
			await rmRepo(repo);
		}
	});

	it("stop() waits for a foreground claim mutation", async () => {
		const branchRename = deferred<ExecFileResult>();
		let branchRenameStarted = false;
		const commandRunner: CommandRunner = {
			execFile: async (_file, args) => {
				if (args[0] === "branch" && args[1] === "-m" && !branchRenameStarted) {
					branchRenameStarted = true;
					return await branchRename.promise;
				}
				return { stdout: "", stderr: "" };
			},
		};
		const pool = new WorktreePool({ repoPath: path.resolve("virtual-pool-repo"), targetSize: 0, commandRunner });
		pool.registerExternalEntry("pool/_pool-deferred", path.resolve("virtual-pool-wt", "pool-_pool-deferred"));

		const claiming = pool.claim("session/deferred1");
		assert.equal(branchRenameStarted, true, "claim should reach the deferred Git mutation");
		let stopSettled = false;
		const stopping = pool.stop().then(() => { stopSettled = true; });
		await yieldToEventLoop();
		assert.equal(stopSettled, false, "stop must remain pending while the foreground claim mutates Git");

		branchRename.resolve({ stdout: "", stderr: "" });
		const claimed = await claiming;
		assert.ok(claimed, "claim semantics should remain successful after the deferred rename resumes");
		await stopping;
		assert.equal(stopSettled, true);
	});

	it("drain() waits for deferred failure cleanup scheduled by claim", async () => {
		const cleanup = deferred<void>();
		let cleanupStarted = false;
		const commandRunner: CommandRunner = {
			execFile: async () => { throw new Error("deferred claim failure"); },
		};
		const pool = new WorktreePool({
			repoPath: path.resolve("virtual-pool-repo"),
			targetSize: 0,
			commandRunner,
			cleanupWorktreeImpl: async () => {
				cleanupStarted = true;
				await cleanup.promise;
			},
		});
		pool.registerExternalEntry("pool/_pool-cleanup", path.resolve("virtual-pool-wt", "pool-_pool-cleanup"));

		const claimed = await pool.claim("session/fallback1");
		assert.equal(claimed, null, "claim failure should preserve the cold-create fallback");
		await yieldToEventLoop();
		assert.equal(cleanupStarted, true, "claim failure should start best-effort cleanup");

		let drainSettled = false;
		const draining = pool.drain().then(() => { drainSettled = true; });
		await yieldToEventLoop();
		assert.equal(drainSettled, false, "drain must remain pending while failure cleanup mutates the worktree");

		cleanup.resolve(undefined);
		await draining;
		assert.equal(drainSettled, true);
		assert.equal(pool.size, 0);
	});

	it("drain() is idempotent and safe on a pool that never started", async () => {
		const repo = await makeRepo();
		try {
			const pool = new WorktreePool({ repoPath: repo, targetSize: 1 });
			await pool.drain();
			await pool.drain();
			assert.equal(pool.size, 0);
			assert.equal(pool.isFilling, false);
		} finally {
			await rmRepo(repo);
		}
	});
});
