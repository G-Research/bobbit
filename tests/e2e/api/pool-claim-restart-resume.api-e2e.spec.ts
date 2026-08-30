/**
 * Pool claim restart-resume — API E2E (design §16.2 of
 * docs/design/remove-session-worktree-rename.md).
 *
 * Asserts:
 *   1. Pool warms with `pool/_pool-*` branches.
 *   2. `POST /api/sessions` claims one and the persisted `branch` is
 *      `session/<id8>` IMMEDIATELY (no first-prompt rename).
 *   3. After a simulated server restart (re-invoke `restoreSessions()`
 *      against the same on-disk state), the persisted `branch` is
 *      byte-stable. The container directory still exists at
 *      `<wtRoot>/session-<id8>/` — no `git branch -m` ran post-restart
 *      (we probe `git reflog` on the branch).
 *
 * "Restart" model: the in-process harness shares Node's module cache, so we
 * cannot truly tear down + re-create the gateway. Instead we:
 *   - capture the persisted `branch` and `worktreePath` values,
 *   - record `git reflog show <branch>` BEFORE the restore,
 *   - re-invoke `SessionManager.restoreSessions()` (the same path the
 *     server takes at boot), which re-reads `sessions.json` and replays
 *     restoreSession() per row,
 *   - re-read the API and assert byte-equality of `branch` + `worktreePath`,
 *   - re-record reflog and assert no new entries — i.e. no rename ran.
 */
import { test, expect } from "../in-process-harness.js";

// Pool pre-fill must run.
test.use({ enableWorktreePool: true });

import { apiFetch } from "../e2e-setup.js";
import { waitForPool, pollSessionUntilSessionBranch } from "../test-utils/pool-polling.mjs";
import { mkdirSync, existsSync, statSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

function reflog(repo: string, branch: string): string {
	// Use the branch's own reflog only (NOT --all) so pool replenishment
	// activity on sibling refs doesn't pollute the fingerprint.
	try {
		return execFileSync("git", ["reflog", "show", "--no-abbrev", branch], {
			cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

type CleanupStage = () => Promise<void>;

/** Runs every owned cleanup stage in dependency order before surfacing errors. */
async function runOrderedCleanup(stages: readonly CleanupStage[]): Promise<void> {
	const errors: unknown[] = [];
	for (const stage of stages) {
		try {
			await stage();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "pool restart fixture cleanup failed");
}

test.describe.serial("pool claim restart-resume", () => {
	test("session/<id8> branch is byte-stable across simulated restart; no git branch -m runs post-restart", async ({ gateway }) => {
		// Each test owns one canonical root. `mkdtemp` makes concurrent
		// coordinators independent; realpath prevents macOS /var aliases from
		// leaking into project and worktree assertions.
		const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "bobbit-e2e-pool-restart-")));
		const repoPath = join(fixtureRoot, "repo");
		let projectId: string | undefined;
		let sessionId: string | undefined;

		try {
			mkdirSync(repoPath, { recursive: true });
			execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
			execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
			execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

			const reg = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "pool-restart-project", rootPath: repoPath }),
			});
			expect(reg.status).toBe(201);
			projectId = (await reg.json()).id;

			// Step 1 — pool warms.
			const ready = await waitForPool(projectId, 1);
			expect(ready).toBeGreaterThan(0);

			// Step 2 — claim one. Branch must be session/<id8> immediately.
			const sessResp = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
			});
			expect(sessResp.status).toBe(201);
			sessionId = (await sessResp.json()).id;

			const before = await pollSessionUntilSessionBranch(sessionId);
			expect(before.branch).toMatch(/^session\/[a-f0-9]{8}$/);
			expect(before.branch).not.toMatch(/^pool\//);
			expect(before.branch).not.toMatch(/^session\/new-session-/);

			// Container dir convention: branch.replace(/\//g, "-") under <repo>-wt/.
			const expectedDirSlug = before.branch.replace(/\//g, "-");
			const expectedDir = join(`${repoPath}-wt`, expectedDirSlug);
			// Worktree path persisted on the session row should match.
			expect(before.worktreePath).toBeTruthy();
			expect(existsSync(before.worktreePath!)).toBe(true);
			// The worktreePath should resolve to the canonical container.
			expect(before.worktreePath!.replace(/\\/g, "/")).toContain(expectedDirSlug);

			// Capture pre-restart fingerprint of the branch.
			const reflogBefore = reflog(repoPath, before.branch);
			const dirStatBefore = statSync(expectedDir);
			const inoBefore = dirStatBefore.ino;

			// Step 3 — simulate restart by re-invoking restoreSessions().
			// This is exactly the path the server takes at boot. Module-cached
			// singletons (sessions Map etc.) survive, so this exercises the
			// idempotent re-restore branch — but the persisted on-disk state is
			// what's authoritative. If anything in the restore path tried to
			// rename the branch or move the dir, we'd see it.
			const sm = (gateway as any).sessionManager;
			// Defensive: rebuild the dormant set so re-restore behaves like a
			// cold boot for this session.
			try { (sm as any).sessions.delete(sessionId); } catch { /* best-effort */ }
			await sm.restoreSessions().catch(() => {});

			// Step 4 — assert byte-stability.
			const afterResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(afterResp.status).toBe(200);
			const after = await afterResp.json();
			expect(after.branch).toBe(before.branch);
			expect(after.worktreePath).toBe(before.worktreePath);

			// Step 5 — no rename happened post-restart: reflog unchanged + inode stable.
			const reflogAfter = reflog(repoPath, before.branch);
			expect(reflogAfter).toBe(reflogBefore);
			expect(existsSync(expectedDir)).toBe(true);
			const dirStatAfter = statSync(expectedDir);
			// On Linux/macOS the inode is stable across a no-op restore. On
			// Windows `ino` may be 0/unstable across stat calls; guard the
			// stricter assertion.
			if (process.platform !== "win32" && inoBefore !== 0) {
				expect(dirStatAfter.ino).toBe(inoBefore);
			}
		} finally {
			// Session/worktree handles must close before project removal, which must
			// complete before removing this test's canonical fixture root. Every
			// owned stage runs even if an earlier one fails.
			await runOrderedCleanup([
				async () => {
					if (!sessionId) return;
					const response = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
					expect(response.status).toBe(200);
				},
				async () => {
					if (!projectId) return;
					const response = await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" });
					expect(response.status).toBe(200);
				},
				async () => {
					await rm(fixtureRoot, { recursive: true, force: true });
					expect(existsSync(fixtureRoot), `owned fixture root was not removed: ${fixtureRoot}`).toBe(false);
				},
			]);
		}
	});

	test("cleanup attempts project and root after a session cleanup failure", async () => {
		const calls: string[] = [];
		const sessionError = new Error("session cleanup failed");

		await expect(runOrderedCleanup([
			async () => { calls.push("session"); throw sessionError; },
			async () => { calls.push("project"); },
			async () => { calls.push("root"); },
		])).rejects.toBe(sessionError);
		expect(calls).toEqual(["session", "project", "root"]);
	});

	test("cleanup aggregates later failures after attempting every stage in order", async () => {
		const calls: string[] = [];
		const projectError = new Error("project cleanup failed");
		const rootError = new Error("root cleanup failed");

		await expect(runOrderedCleanup([
			async () => { calls.push("session"); },
			async () => { calls.push("project"); throw projectError; },
			async () => { calls.push("root"); throw rootError; },
		])).rejects.toMatchObject({
			name: "AggregateError",
			errors: [projectError, rootError],
		});
		expect(calls).toEqual(["session", "project", "root"]);
	});
});
