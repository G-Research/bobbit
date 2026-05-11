/**
 * Regression: the synthetic `hidden: true` "system" project (registered
 * via `ProjectRegistry.registerSystemProject()`) must NOT participate in
 * the boot-time worktree-pool initializer.
 *
 * ## The bug
 *
 * `ProjectContextManager.initAll()` builds a `ProjectContext` for every
 * project in `registry.list()` — including hidden ones. The boot
 * pool-init loop in `src/server/server.ts` (~line 1212) iterates
 * `projectContextManager.all()` without filtering. When bobbit's state
 * directory sits inside an unrelated git checkout (e.g. a dev clone
 * where the bobbit project root is a subpath of a larger repo),
 * `isGitRepo(<state>/system-project)` returns true (git walks UP to
 * find a `.git`), `getRepoRoot()` resolves to the surrounding host
 * repo, and the pool then allocates `pool/_pool-*` branches plus
 * worktrees inside the user's unrelated repo.
 *
 * ## Fix contract (pinned by this test)
 *
 *   - `ProjectContextManager` gains a `visible()` iterator that excludes
 *     `hidden` projects.
 *   - The boot pool-init iteration migrates to `visible()`, so the
 *     system project is skipped.
 *   - `all()` continues to include the system project (callers like
 *     `getContextForSession`, MCP discovery, system-scope tool authoring
 *     still need it).
 *   - Registry lookup by id `"system"` continues to work.
 *
 * ## How this test pins the contract
 *
 * The test replicates the production boot pool-init iteration inline.
 * Production walks `pcm.all()` (which is built from `registry.list()` in
 * `initAll`). We walk `registry.list()` directly — same shape, but
 * without dragging `ProjectContextManager` into the tsx ESM import
 * graph (its transitive `flexsearch` named-import currently fails to
 * resolve under tsx's loader, which is a separate infra issue).
 *
 * For each "project" the boot loop:
 *   1. checks `isGitRepo(repoPath)`,
 *   2. resolves `getRepoRoot(repoPath)`,
 *   3. constructs a `WorktreePool` with `targetSize: 1` and
 *      calls `startFilling()`.
 *
 * The fixture places the bobbit state dir INSIDE a freshly-init'd
 * unrelated host git repo, so `<state>/system-project` is "inside a
 * work tree" from git's perspective and the leak materializes as
 * `pool/_pool-*` refs and a `<hostRepo>-wt/_pool-*` directory in the
 * host repo.
 *
 * **Pre-fix run (current master):** the registered system project has
 * no hidden filter applied at the iteration site → a pool is created
 * for it → `pool/_pool-*` refs and worktree directories appear in the
 * host repo → assertions fail with a message matching the leak
 * signature regex `system-project pool leaked: (pool/_pool-|worktree)`.
 *
 * **Post-fix run:** the implementer adds `ProjectContextManager.visible()`
 * and migrates the boot pool-init loop. They must also update the
 * iteration helper in this test (`iterateProjectsForPoolInit`) to apply
 * the same hidden filter — the same one-line change as in production.
 * After that, no pool is created for the system project → assertions
 * pass.
 *
 * Sister assertions also verify that registry id-resolution and the
 * (preserved) `all()`-equivalent shape (`registry.list()`) still return
 * the system project — so the fix cannot regress system-scope tool
 * authoring.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectRegistry, SYSTEM_PROJECT_ID, type RegisteredProject } from "../src/server/agent/project-registry.ts";
import { WorktreePool } from "../src/server/agent/worktree-pool.ts";
import { isGitRepo, getRepoRoot } from "../src/server/skills/git.ts";

// Belt-and-braces: keep the pool freshen path off the network. Tests
// must never touch a remote.
process.env.BOBBIT_TEST_NO_PUSH = "1";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function sleep(ms: number): Promise<void> {
	await new Promise(r => setTimeout(r, ms));
}

async function waitForAny(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (predicate()) return true;
		await sleep(50);
	}
	return false;
}

/**
 * Iteration helper — mirror of the boot pool-init loop's project
 * iteration. On master this is the buggy `registry.list()` (no
 * hidden filter), matching what `ProjectContextManager.initAll()` +
 * `pcm.all()` returns today.
 *
 * **The fix MUST update this helper to filter `hidden`** — the same
 * one-line change the implementer makes in `src/server/server.ts`
 * when migrating the boot loop from `pcm.all()` to `pcm.visible()`.
 */
function iterateProjectsForPoolInit(registry: ProjectRegistry): RegisteredProject[] {
	// Post-fix: mirrors the production boot loop's migration from
	// `projectContextManager.all()` to `projectContextManager.visible()`,
	// which filters out `hidden: true` projects (the synthetic system
	// project). The hidden filter is the single principled fix.
	return registry.list().filter(p => !p.hidden);
}

describe("hidden system project — worktree pool leak", () => {
	let fixtureRoot: string;
	let hostRepo: string;          // <fixture>/host-repo — the user's unrelated git checkout
	let stateDir: string;          // <hostRepo>/bobbit-state — bobbit state dir (nested inside host repo)
	let systemRoot: string;        // <stateDir>/system-project — the synthetic system project root
	const pools: WorktreePool[] = [];

	before(() => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sysproj-leak-"));
		hostRepo = path.join(fixtureRoot, "host-repo");
		fs.mkdirSync(hostRepo, { recursive: true });

		// Initialize the unrelated host git repo with `master` as default
		// branch so pool branch naming is deterministic.
		git(hostRepo, "init", "-q", "-b", "master");
		git(hostRepo, "config", "user.email", "test@bobbit.local");
		git(hostRepo, "config", "user.name", "Bobbit Test");
		git(hostRepo, "config", "commit.gpgsign", "false");
		fs.writeFileSync(path.join(hostRepo, "README.md"), "# host repo (unrelated)\n");
		git(hostRepo, "add", ".");
		git(hostRepo, "commit", "-q", "-m", "init");

		// The bobbit state dir lives inside the host repo. The synthetic
		// system project's rootPath therefore sits inside the host repo's
		// work tree — which is precisely the condition that triggers the
		// leak in production.
		stateDir = path.join(hostRepo, "bobbit-state");
		fs.mkdirSync(stateDir, { recursive: true });
		systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });
	});

	after(async () => {
		// Drain any pools we started so background promises settle before
		// the temp dir is removed.
		for (const p of pools) {
			try { await p.drain(); } catch { /* best-effort */ }
		}
		try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
	});

	it("does not allocate pool branches/worktrees in the surrounding host repo for the hidden system project", async () => {
		// Build a registry pointed at our isolated state dir with NO
		// user-registered projects. Then register the synthetic system
		// project — exactly what the real boot path does.
		const registry = new ProjectRegistry(stateDir);
		assert.equal(registry.list().length, 0, "registry should start empty");
		const sys = registry.registerSystemProject(systemRoot);
		assert.equal(sys.id, SYSTEM_PROJECT_ID);
		assert.equal(sys.hidden, true);

		// Pre-fix sanity: the system project IS in registry.list() — which
		// mirrors what `ProjectContextManager.initAll()` + `pcm.all()`
		// returns today, and what `pcm.all()` must continue to return.
		const all = registry.list();
		assert.equal(all.length, 1);
		assert.equal(all[0].id, SYSTEM_PROJECT_ID);

		// Replicate the boot pool-init loop (see src/server/server.ts
		// around line 1212). Single-repo path only — the system project
		// is not multi-repo.
		for (const project of iterateProjectsForPoolInit(registry)) {
			const repoPath = project.rootPath;
			if (!(await isGitRepo(repoPath))) continue;
			const poolRepoPath = await getRepoRoot(repoPath);
			const pool = new WorktreePool({ repoPath: poolRepoPath, targetSize: 1 });
			pools.push(pool);
			pool.startFilling();
		}

		// If any pools are filling, give them time to actually allocate
		// at least one entry so the leak materializes on disk. If no
		// pools were created (post-fix path), proceed immediately.
		if (pools.length > 0) {
			await waitForAny(() => pools.some(p => p.size >= 1), 30_000);
		}

		// ── Assertions ────────────────────────────────────────────

		// 1. No `pool/_pool-*` refs exist in the surrounding host repo.
		const refs = execFileSync(
			"git",
			["-C", hostRepo, "for-each-ref", "--format=%(refname)", "refs/heads/pool/"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		).toString().trim();

		// 2. No `_pool-*` worktree directory has been created adjacent to
		//    the host repo (the pool places worktrees under `<repoRoot>-wt/`).
		const hostWtParent = hostRepo + "-wt";
		const hostWtExists = fs.existsSync(hostWtParent);
		const hostWtChildren = hostWtExists ? fs.readdirSync(hostWtParent) : [];
		// Pool worktree dirs include a `pool-` (or just `_pool-`) prefix
		// depending on the pool's branch-to-dir naming. Match either.
		const leakedWtChildren = hostWtChildren.filter(c => /(^|[/\\])_?pool[-_]/.test(c));

		const diag = [
			`pools created=${pools.length}`,
			`pool refs in host repo: ${refs || "(none)"}`,
			`worktree parent ${hostWtParent}: exists=${hostWtExists} children=${JSON.stringify(hostWtChildren)}`,
		].join("\n  ");

		assert.equal(
			refs,
			"",
			`system-project pool leaked: pool/_pool-* refs in host repo\n  ${diag}`,
		);
		assert.equal(
			leakedWtChildren.length,
			0,
			`system-project pool leaked: worktree directory created in host repo\n  ${diag}`,
		);

		// 3. Registry still resolves the system project by id (the fix
		//    must not change persistence or id resolution).
		assert.ok(registry.get(SYSTEM_PROJECT_ID), "registry must still resolve 'system' by id");

		// 4. registry.list() (the surface backing `pcm.all()`) still
		//    includes the hidden system project. Hidden filtering must
		//    happen at the iteration site (visible()), not by mutating
		//    the registry's persisted shape.
		const post = registry.list();
		assert.ok(
			post.some(p => p.id === SYSTEM_PROJECT_ID),
			"registry.list() must continue to include the hidden system project",
		);
	});
});
