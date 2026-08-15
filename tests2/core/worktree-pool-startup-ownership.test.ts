import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, vi } from "vitest";

import { WorktreePool, type WorktreePoolFs } from "../../src/server/agent/worktree-pool.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";

describe("WorktreePool startup ownership", () => {
	it("does not discover, adopt, or claim a pre-existing pool-shaped worktree", async () => {
		const repoPath = path.resolve("virtual-startup-owner-repo");
		const worktreeRoot = path.resolve("virtual-startup-owner-wt");
		const stalePath = path.join(worktreeRoot, "pool-_pool-deadbeef");
		const staleBranch = "pool/_pool-deadbeef";
		let opendirCalls = 0;
		const staleMutations: string[][] = [];
		const fsImpl = new Proxy<WorktreePoolFs>({ rename: async () => undefined }, {
			get: (target, property, receiver) => property === "opendir"
				? async () => {
					opendirCalls++;
					let read = false;
					return {
						read: async () => read ? null : (read = true, { name: path.basename(stalePath), isDirectory: () => true }),
						close: async () => undefined,
					};
				}
				: Reflect.get(target, property, receiver),
		});
		const commandRunner: CommandRunner = {
			execFile: async (_file, args, options) => {
				if (options?.cwd === stalePath && args[0] === "rev-parse") {
					return { stdout: `${staleBranch}\n`, stderr: "" };
				}
				if (options?.cwd === stalePath) staleMutations.push([...args]);
				throw new Error("background fill intentionally disabled");
			},
		};
		const pool = new WorktreePool({
			repoPath,
			worktreeRoot,
			targetSize: 1,
			fsImpl,
			commandRunner,
			resolveRepoToplevelImpl: async () => repoPath,
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await pool.initialize();
			await new Promise<void>(resolve => setImmediate(resolve));

			assert.equal(opendirCalls, 0, "startup must not scan for pool-shaped worktrees to adopt");
			assert.deepEqual(pool.snapshotEntries().entries, [], "a fresh pool must not insert a discovered stale worktree");
			assert.equal(await pool.claim("session/manual-owner"), null, "a discovered stale worktree must not become claimable");
			assert.deepEqual(staleMutations, [], "startup and claim must not mutate the stale worktree");
		} finally {
			await pool.stop();
			consoleError.mockRestore();
		}
	});

	it("keeps explicitly registered in-memory entries claimable", async () => {
		const repoPath = path.resolve("virtual-current-owner-repo");
		const worktreePath = path.resolve("virtual-current-owner-wt", "session-current-owner");
		const commands: string[][] = [];
		const commandRunner: CommandRunner = {
			execFile: async (_file, args) => {
				commands.push([...args]);
				return { stdout: "", stderr: "" };
			},
		};
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner,
			remotePolicy: { skipNonLocalRemoteGit: true },
			resolveRepoToplevelImpl: async () => repoPath,
		});
		pool.registerExternalEntry("pool/_pool-current", worktreePath);
		await pool.initialize();
		try {
			const claimed = await pool.claim("session/current-owner");
			assert.ok(claimed);
			assert.equal(claimed.worktreePath, worktreePath);
			assert.equal(claimed.branchName, "session/current-owner");
			assert.ok(commands.some(args => args[0] === "branch" && args[1] === "-m"), "claim must rename the in-memory entry branch");
		} finally {
			await pool.stop();
		}
	});
});
