import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, vi } from "vitest";

import * as serverExports from "../../src/server/server.ts";
import { WorktreePool } from "../../src/server/agent/worktree-pool.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";

interface ShutdownPool {
	stop(): Promise<void>;
	drain(): Promise<void>;
}

type ShutdownPoolHelper = (
	pools: ReadonlyMap<string, ShutdownPool>,
) => Promise<void>;

function requireShutdownPoolHelper(): ShutdownPoolHelper {
	const helper = (serverExports as typeof serverExports & {
		drainWorktreePoolsForShutdown?: ShutdownPoolHelper;
	}).drainWorktreePoolsForShutdown;
	if (typeof helper !== "function") assert.fail("GRACEFUL_POOL_DRAIN_HELPER_REQUIRED");
	return helper;
}

function fakePool(
	id: string,
	events: string[],
	opts: { stopError?: Error; drainError?: Error } = {},
): ShutdownPool {
	return {
		async stop() {
			events.push(`stop:${id}`);
			if (opts.stopError) throw opts.stopError;
		},
		async drain() {
			events.push(`drain:${id}`);
			if (opts.drainError) throw opts.drainError;
		},
	};
}

async function withoutExpectedShutdownLogs(run: () => Promise<void>): Promise<void> {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await run();
	} finally {
		warn.mockRestore();
		error.mockRestore();
	}
}

describe("gateway graceful worktree-pool shutdown", () => {
	it("stops every snapshotted pool before the first drain", async () => {
		const events: string[] = [];
		const pools = new Map<string, ShutdownPool>([
			["alpha", fakePool("alpha", events)],
			["beta", fakePool("beta", events)],
			["gamma", fakePool("gamma", events)],
		]);

		await requireShutdownPoolHelper()(pools);

		const firstDrain = events.findIndex(event => event.startsWith("drain:"));
		assert.ok(firstDrain >= 0, "shutdown must drain ready current-instance pools");
		for (const id of pools.keys()) {
			assert.ok(events.indexOf(`stop:${id}`) < firstDrain, `${id} must stop before any drain starts`);
			assert.ok(events.includes(`drain:${id}`), `${id} must be drained`);
		}
	});

	it("skips a pool whose stop failed while later pools still drain", async () => {
		const events: string[] = [];
		const pools = new Map<string, ShutdownPool>([
			["unsafe", fakePool("unsafe", events, { stopError: new Error("stop failed") })],
			["later", fakePool("later", events)],
		]);

		await withoutExpectedShutdownLogs(() => requireShutdownPoolHelper()(pools));

		assert.deepEqual(events.filter(event => event.startsWith("stop:")), ["stop:unsafe", "stop:later"]);
		assert.ok(!events.includes("drain:unsafe"), "a pool that did not stop safely must not be drained");
		assert.ok(events.includes("drain:later"), "one stop failure must not block later pools");
	});

	it("isolates a drain failure and completes later drains", async () => {
		const events: string[] = [];
		const pools = new Map<string, ShutdownPool>([
			["broken", fakePool("broken", events, { drainError: new Error("drain failed") })],
			["later", fakePool("later", events)],
		]);

		await withoutExpectedShutdownLogs(() => requireShutdownPoolHelper()(pools));

		assert.ok(events.includes("drain:broken"));
		assert.ok(events.includes("drain:later"), "one drain failure must not block later pools or helper completion");
	});
});

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

describe("WorktreePool graceful drain ownership", () => {
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
