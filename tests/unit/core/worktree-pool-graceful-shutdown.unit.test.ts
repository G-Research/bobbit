import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";
import type { CommandRunner } from "../../../src/server/gateway-deps.ts";

interface CleanupCall {
	repoPath: string;
	worktreePath: string;
	branchName: string | undefined;
	deleteBranch: boolean;
	policy: { skipRemotePush?: boolean; skipNonLocalRemoteGit?: boolean; e2eTmpRoot?: string };
}

function successfulCommandRunner(): CommandRunner {
	return {
		execFile: async () => ({ stdout: "", stderr: "" }),
	};
}

describe("WorktreePool explicit drain ownership", () => {
	it("makes tracked single-repository claim-failure cleanup local-only before stop returns", async () => {
		const repoPath = path.resolve("virtual-failure-cleanup-single-repo");
		const worktreePath = path.resolve("virtual-failure-cleanup-single-wt");
		const calls: CleanupCall[] = [];
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner: successfulCommandRunner(),
			remotePolicy: { skipRemotePush: false, skipNonLocalRemoteGit: true },
			cleanupWorktreeImpl: async (cleanupRepo, cleanupPath, branchName, deleteBranch, _runner, policy) => {
				calls.push({ repoPath: cleanupRepo, worktreePath: cleanupPath, branchName, deleteBranch: deleteBranch === true, policy: { ...policy } });
			},
		});
		const seams = pool as unknown as {
			scheduleFailureCleanup(repo: string, cleanupPath: string, branch: string): void;
		};

		seams.scheduleFailureCleanup(repoPath, worktreePath, "pool/_pool-failed");
		await pool.stop();

		assert.deepEqual(calls, [{
			repoPath,
			worktreePath,
			branchName: "pool/_pool-failed",
			deleteBranch: true,
			policy: { skipRemotePush: true, skipNonLocalRemoteGit: true },
		}], "POOL_FAILURE_CLEANUP_LOCAL_ONLY_REQUIRED");
	});

	it("makes every tracked multi-repository claim-failure cleanup local-only before stop returns", async () => {
		const repoPath = path.resolve("virtual-failure-cleanup-multi-root");
		const firstRepo = path.resolve("virtual-failure-cleanup-multi-a");
		const secondRepo = path.resolve("virtual-failure-cleanup-multi-b");
		const firstWorktree = path.resolve("virtual-failure-cleanup-multi-wt", "a");
		const secondWorktree = path.resolve("virtual-failure-cleanup-multi-wt", "b");
		const calls: CleanupCall[] = [];
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner: successfulCommandRunner(),
			remotePolicy: { skipRemotePush: false, skipNonLocalRemoteGit: true },
			cleanupWorktreeImpl: async (cleanupRepo, cleanupPath, branchName, deleteBranch, _runner, policy) => {
				calls.push({ repoPath: cleanupRepo, worktreePath: cleanupPath, branchName, deleteBranch: deleteBranch === true, policy: { ...policy } });
			},
		});
		const seams = pool as unknown as {
			scheduleFailureCleanups(worktrees: readonly { repoPath: string; worktreePath: string }[], branch: string): void;
		};

		seams.scheduleFailureCleanups([
			{ repoPath: firstRepo, worktreePath: firstWorktree },
			{ repoPath: secondRepo, worktreePath: secondWorktree },
		], "pool/_pool-failed-multi");
		await pool.stop();

		assert.deepEqual(calls, [
			{
				repoPath: firstRepo,
				worktreePath: firstWorktree,
				branchName: "pool/_pool-failed-multi",
				deleteBranch: true,
				policy: { skipRemotePush: true, skipNonLocalRemoteGit: true },
			},
			{
				repoPath: secondRepo,
				worktreePath: secondWorktree,
				branchName: "pool/_pool-failed-multi",
				deleteBranch: true,
				policy: { skipRemotePush: true, skipNonLocalRemoteGit: true },
			},
		], "POOL_MULTI_FAILURE_CLEANUP_LOCAL_ONLY_REQUIRED");
	});

	it("cleans only entries still held by this instance and excludes a claimed entry", async () => {
		const repoPath = path.resolve("virtual-graceful-single-repo");
		const root = path.resolve("virtual-graceful-single-wt");
		const claimedPath = path.join(root, "pool-_pool-claimed");
		const heldPath = path.join(root, "pool-_pool-held");
		const calls: CleanupCall[] = [];
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner: successfulCommandRunner(),
			remotePolicy: { skipRemotePush: false, skipNonLocalRemoteGit: true, e2eTmpRoot: root },
			resolveRepoToplevelImpl: async () => repoPath,
			cleanupWorktreeImpl: async (cleanupRepo, worktreePath, branchName, deleteBranch, _runner, policy) => {
				calls.push({ repoPath: cleanupRepo, worktreePath, branchName, deleteBranch: deleteBranch === true, policy: { ...policy } });
			},
		});
		pool.registerExternalEntry("pool/_pool-claimed", claimedPath);
		pool.registerExternalEntry("pool/_pool-held", heldPath);

		const claimed = await pool.claim("session/claimed");
		assert.ok(claimed, "control: the first current-instance entry must leave the pool through claim");
		await pool.drain();

		assert.deepEqual(calls, [{
			repoPath,
			worktreePath: heldPath,
			branchName: "pool/_pool-held",
			deleteBranch: true,
			policy: { skipRemotePush: true, skipNonLocalRemoteGit: true, e2eTmpRoot: root },
		}], "POOL_DRAIN_CURRENT_INSTANCE_LOCAL_ONLY_REQUIRED");
	});

	it("cleans every repository in a held multi-repo entry locally and isolates component failures", async () => {
		const repoPath = path.resolve("virtual-graceful-multi-root");
		const container = path.resolve("virtual-graceful-multi-wt", "pool-_pool-multi");
		const firstRepo = path.resolve("virtual-graceful-multi-repo-a");
		const secondRepo = path.resolve("virtual-graceful-multi-repo-b");
		const calls: CleanupCall[] = [];
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner: successfulCommandRunner(),
			remotePolicy: { skipRemotePush: false, skipNonLocalRemoteGit: true },
			resolveRepoToplevelImpl: async () => repoPath,
			cleanupWorktreeImpl: async (cleanupRepo, worktreePath, branchName, deleteBranch, _runner, policy) => {
				calls.push({ repoPath: cleanupRepo, worktreePath, branchName, deleteBranch: deleteBranch === true, policy: { ...policy } });
				if (cleanupRepo === firstRepo) throw new Error("first component cleanup failed");
			},
		});
		const heldEntries = pool as unknown as {
			pool: Array<{
				branchName: string;
				worktreePath: string;
				worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }>;
				createdAt: number;
			}>;
		};
		heldEntries.pool.push({
			branchName: "pool/_pool-multi",
			worktreePath: container,
			worktrees: [
				{ repo: "component-a", repoPath: firstRepo, worktreePath: path.join(container, "a") },
				{ repo: "component-b", repoPath: secondRepo, worktreePath: path.join(container, "b") },
			],
			createdAt: Date.now(),
		});

		await pool.drain();

		assert.deepEqual(calls.map(call => ({
			repoPath: call.repoPath,
			worktreePath: call.worktreePath,
			branchName: call.branchName,
			deleteBranch: call.deleteBranch,
			policy: call.policy,
		})), [
			{
				repoPath: firstRepo,
				worktreePath: path.join(container, "a"),
				branchName: "pool/_pool-multi",
				deleteBranch: true,
				policy: { skipRemotePush: true, skipNonLocalRemoteGit: true },
			},
			{
				repoPath: secondRepo,
				worktreePath: path.join(container, "b"),
				branchName: "pool/_pool-multi",
				deleteBranch: true,
				policy: { skipRemotePush: true, skipNonLocalRemoteGit: true },
			},
		], "POOL_DRAIN_MULTI_REPO_LOCAL_ONLY_REQUIRED");
	});
});
