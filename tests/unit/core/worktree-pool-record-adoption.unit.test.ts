/**
 * Adopting pool worktrees across a restart, and the limits on doing so.
 *
 * Pool entries used to be deleted at shutdown, so every restart paid to rebuild
 * them. The reason was not laziness: boot is forbidden from adopting a leftover
 * worktree from its branch name or path shape, because nothing about the shape
 * distinguishes Bobbit's own pre-built worktree from one a user made and still
 * wants (`docs/design/preserve-user-worktrees.md`).
 *
 * The pool now writes down the `(repoPath, worktreePath, branchName)` triples it
 * owns, which is the *exact durable record* the ownership rules already accept. So
 * these tests pin both halves of the deal:
 *
 *  - a recorded entry that Git still agrees with is reused, making restarts cheap;
 *  - anything else is left strictly alone, so the invariant is preserved rather
 *    than traded away for speed.
 *
 * The second half is the one that matters. If it regresses, Bobbit starts deleting
 * or hijacking worktrees a user was working in.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";

import { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";
import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import { MemoryPoolRecordStore, WorktreePoolRecordStore } from "../../../src/server/agent/worktree-pool-record.ts";
import { realFs, type CommandRunner } from "../../../src/server/gateway-deps.ts";
import type { Component } from "../../../src/server/agent/project-config-store.ts";

const PROJECT_ID = "project-1";

function gitWorktreeListOutput(repoPath: string, entries: Array<{ path: string; branch?: string }>): string {
	const blocks = [`worktree ${repoPath}\nbranch refs/heads/master`];
	for (const entry of entries) {
		blocks.push(`worktree ${entry.path}` + (entry.branch ? `\nbranch refs/heads/${entry.branch}` : ""));
	}
	return `${blocks.join("\n\n")}\n`;
}

/**
 * A pool whose Git only reports `liveWorktrees`, with `targetSize: 0` so nothing is
 * pre-built and the entries under test are exactly the adopted ones.
 */
function makePool(opts: {
	repoPath: string;
	liveWorktrees: Array<{ path: string; branch?: string }>;
	recordStore: MemoryPoolRecordStore;
	projectId?: string;
	components?: Component[];
}) {
	const mutations: string[][] = [];
	const commandRunner: CommandRunner = {
		execFile: async (_file, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				return { stdout: gitWorktreeListOutput(opts.repoPath, opts.liveWorktrees), stderr: "" };
			}
			mutations.push([...args]);
			return { stdout: "", stderr: "" };
		},
	};
	const pool = new WorktreePool({
		repoPath: opts.repoPath,
		targetSize: 0,
		commandRunner,
		remotePolicy: { skipNonLocalRemoteGit: true },
		resolveRepoToplevelImpl: async () => opts.repoPath,
		componentsResolver: opts.components ? () => opts.components! : undefined,
		recordStore: opts.recordStore,
		projectId: opts.projectId ?? PROJECT_ID,
	});
	return { pool, mutations };
}

describe("durable worktree pool records", () => {
	it("flushes and reloads only beneath the explicit state directory", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-record-"));
		const stateDir = path.join(root, "state");
		const repoPath = path.join(root, "repo");
		const worktreePath = path.join(root, "worktrees", "pool-_pool-durable");
		const cwdFile = path.resolve("worktree-pools.json");
		const cwdTmp = `${cwdFile}.tmp`;
		const repoFile = path.join(repoPath, "worktree-pools.json");
		assert.equal(fs.existsSync(cwdFile), false, "precondition: checkout must not contain a pool record");
		assert.equal(fs.existsSync(cwdTmp), false, "precondition: checkout must not contain a pool-record temp file");
		try {
			const writer = new WorktreePoolRecordStore(realFs, stateDir, undefined, 0);
			writer.replace(PROJECT_ID, repoPath, [{
				branchName: "pool/_pool-durable",
				worktreePath,
				createdAt: 123,
			}]);
			await writer.flush();

			const recordFile = path.join(stateDir, "worktree-pools.json");
			assert.equal(fs.existsSync(recordFile), true);
			assert.equal(fs.existsSync(`${recordFile}.tmp`), false, "atomic temp file must be renamed in the state directory");
			assert.deepEqual(new WorktreePoolRecordStore(realFs, stateDir).read(PROJECT_ID).entries, [{
				branchName: "pool/_pool-durable",
				worktreePath,
				createdAt: 123,
			}]);
			assert.equal(fs.existsSync(cwdFile), false, "record writer must not target process cwd");
			assert.equal(fs.existsSync(cwdTmp), false, "record writer must not leave a process-cwd temp file");
			assert.equal(fs.existsSync(repoFile), false, "record writer must not target a project repository");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects future, partial, and malformed project records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-record-invalid-"));
		const stateDir = path.join(root, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const recordFile = path.join(stateDir, "worktree-pools.json");
		const invalid = [
			{ version: 2, projects: { [PROJECT_ID]: { repoPath: root, entries: [] } } },
			{ version: 1, projects: { [PROJECT_ID]: { entries: [{ branchName: "pool/_pool-x", worktreePath: root, createdAt: 1 }] } } },
			{ version: 1, projects: { [PROJECT_ID]: { repoPath: root, entries: [
				{ branchName: "pool/_pool-good", worktreePath: root, createdAt: 1 },
				{ branchName: "pool/_pool-bad", worktreePath: root, createdAt: 1, worktrees: [{ repo: "api" }] },
			] } } },
		];
		try {
			for (const value of invalid) {
				fs.writeFileSync(recordFile, JSON.stringify(value));
				assert.deepEqual(new WorktreePoolRecordStore(realFs, stateDir).read(PROJECT_ID).entries, []);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("worktree pool reuses recorded entries across a restart", () => {
	const repoPath = path.resolve("virtual-record-repo");
	const poolPath = path.resolve("virtual-record-wt", "pool-_pool-abc12345");

	it("adopts an entry it recorded owning, and makes it claimable", async () => {
		const recordStore = new MemoryPoolRecordStore();
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName: "pool/_pool-abc12345", worktreePath: poolPath, createdAt: Date.now() },
		]);

		const { pool, mutations } = makePool({
			repoPath,
			liveWorktrees: [{ path: poolPath, branch: "pool/_pool-abc12345" }],
			recordStore,
		});
		try {
			await pool.initialize();
			const adopted = pool.snapshotEntries().entries;
			assert.equal(adopted.length, 1, "a recorded, Git-confirmed entry should be reused");
			assert.equal(adopted[0]!.worktreePath, poolPath, "and should be the exact recorded worktree");

			const claimed = await pool.claim("session/reused");
			assert.ok(claimed, "the reused entry should be claimable — that is the whole point");
			// Claim moves the worktree to the target branch's directory, so the post-claim
			// path is the renamed one, not the pool path it was adopted under.
			assert.equal(claimed.branchName, "session/reused");
			assert.ok(
				mutations.some(args => args[0] === "branch" && args[1] === "-m"),
				"claiming a reused entry still renames its branch",
			);
		} finally {
			await pool.stop();
		}
	});

	it("stops listing an entry once it is claimed, so a restart cannot hand it out twice", async () => {
		const recordStore = new MemoryPoolRecordStore();
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName: "pool/_pool-abc12345", worktreePath: poolPath, createdAt: Date.now() },
		]);
		const { pool } = makePool({
			repoPath,
			liveWorktrees: [{ path: poolPath, branch: "pool/_pool-abc12345" }],
			recordStore,
		});
		try {
			await pool.initialize();
			assert.ok(await pool.claim("session/taken"));
			assert.deepEqual(
				recordStore.read(PROJECT_ID).entries,
				[],
				"a claimed worktree belongs to its session record, not the pool",
			);
		} finally {
			await pool.stop();
		}
	});
});

describe("multi-repository pool adoption", () => {
	const root = path.resolve("virtual-record-multi-root");
	const container = path.resolve("virtual-record-multi-wt", "pool-_pool-multi123");
	const branchName = "pool/_pool-multi123";
	const members = [
		{ repo: "api", repoPath: path.join(root, "api"), worktreePath: path.join(container, "api") },
		{ repo: "web", repoPath: path.join(root, "web"), worktreePath: path.join(container, "web") },
	];
	const components: Component[] = members.map(member => ({ name: member.repo, repo: member.repo }));

	function createMultiPool(recordStore: MemoryPoolRecordStore, overrides?: {
		webBranch?: string;
		failWebList?: boolean;
	}) {
		const commandRunner: CommandRunner = {
			execFile: async (_file, args, options) => {
				if (args[0] === "worktree" && args[1] === "list") {
					if (options?.cwd === members[1]!.repoPath && overrides?.failWebList) throw new Error("list failed");
					const member = members.find(candidate => candidate.repoPath === options?.cwd);
					if (!member) throw new Error(`unexpected worktree list cwd: ${options?.cwd}`);
					const branch = member.repo === "web" ? overrides?.webBranch ?? branchName : branchName;
					return { stdout: gitWorktreeListOutput(member.repoPath, [{ path: member.worktreePath, branch }]), stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		};
		return new WorktreePool({
			repoPath: root,
			targetSize: 0,
			componentsResolver: () => components,
			commandRunner,
			resolveRepoToplevelImpl: async () => root,
			recordStore,
			projectId: PROJECT_ID,
		});
	}

	function recordedStore(): MemoryPoolRecordStore {
		const store = new MemoryPoolRecordStore();
		store.replace(PROJECT_ID, root, [{ branchName, worktreePath: container, worktrees: members, createdAt: 1 }]);
		return store;
	}

	it("adopts a complete set only after every member has an exact Git identity match", async () => {
		const store = recordedStore();
		const pool = createMultiPool(store);
		await pool.initialize();
		try {
			assert.deepEqual(pool.snapshotEntries().entries[0]?.worktrees, members);
		} finally {
			await pool.stop();
		}
	});

	it("rejects duplicate members and coordinates outside the recorded container", async () => {
		const invalidMembers = [
			[members[0]!, { ...members[0]!, worktreePath: members[1]!.worktreePath }],
			[members[0]!, { ...members[1]!, worktreePath: path.resolve("outside-recorded-container") }],
		];
		for (const worktrees of invalidMembers) {
			const store = new MemoryPoolRecordStore();
			store.replace(PROJECT_ID, root, [{ branchName, worktreePath: container, worktrees, createdAt: 1 }]);
			const pool = createMultiPool(store);
			await pool.initialize();
			try {
				assert.deepEqual(pool.snapshotEntries().entries, []);
				assert.deepEqual(store.read(PROJECT_ID).entries, []);
			} finally {
				await pool.stop();
			}
		}
	});

	it("rejects the complete set when one member mismatches or cannot be listed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			for (const overrides of [{ webBranch: "feature/user" }, { failWebList: true }]) {
				const store = recordedStore();
				const pool = createMultiPool(store, overrides);
				await pool.initialize();
				try {
					assert.deepEqual(pool.snapshotEntries().entries, []);
					assert.deepEqual(store.read(PROJECT_ID).entries, [], "invalid authority must be republished away");
				} finally {
					await pool.stop();
				}
			}
		} finally {
			warn.mockRestore();
		}
	});

	it("rejects the complete set when a live session references a member or container descendant", async () => {
		for (const livePath of [members[1]!.worktreePath, path.join(container, "api", "packages", "app")]) {
			const store = recordedStore();
			const pool = createMultiPool(store);
			await pool.initialize(new Set([livePath]));
			try {
				assert.deepEqual(pool.snapshotEntries().entries, []);
				assert.deepEqual(store.read(PROJECT_ID).entries, []);
			} finally {
				await pool.stop();
			}
		}
	});
});

describe("worktree pool adoption refuses anything it cannot prove it owns", () => {
	const repoPath = path.resolve("virtual-record-repo");

	it("ignores a pool-shaped worktree that was never recorded", async () => {
		// The original invariant: shape alone is not evidence. An empty record must
		// leave a pool-shaped directory completely alone.
		const recordStore = new MemoryPoolRecordStore();
		const strayPath = path.resolve("virtual-record-wt", "pool-_pool-stray999");
		const { pool, mutations } = makePool({
			repoPath,
			liveWorktrees: [{ path: strayPath, branch: "pool/_pool-stray999" }],
			recordStore,
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, [], "an unrecorded worktree must never be adopted");
			assert.equal(await pool.claim("session/thief"), null, "and must never become claimable");
			assert.deepEqual(mutations, [], "and must not be touched");
		} finally {
			await pool.stop();
		}
	});

	it("discards a record Git no longer agrees with", async () => {
		// The user deleted the worktree, or moved it, or checked out a different
		// branch in it. The record is stale; trusting it would corrupt their work.
		const recordStore = new MemoryPoolRecordStore();
		const recordedPath = path.resolve("virtual-record-wt", "pool-_pool-gone1234");
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName: "pool/_pool-gone1234", worktreePath: recordedPath, createdAt: Date.now() },
		]);
		const { pool, mutations } = makePool({ repoPath, liveWorktrees: [], recordStore });
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, [], "a record Git cannot confirm must not be adopted");
			assert.deepEqual(mutations, [], "and the path must not be touched");
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, [], "the stale record should be dropped, not retried forever");
		} finally {
			await pool.stop();
		}
	});

	it("refuses a recorded path whose branch has changed underneath it", async () => {
		const recordStore = new MemoryPoolRecordStore();
		const recordedPath = path.resolve("virtual-record-wt", "pool-_pool-moved123");
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName: "pool/_pool-moved123", worktreePath: recordedPath, createdAt: Date.now() },
		]);
		const { pool } = makePool({
			repoPath,
			// Same directory, but the user is now on their own branch in it.
			liveWorktrees: [{ path: recordedPath, branch: "feature/mine" }],
			recordStore,
		});
		try {
			await pool.initialize();
			assert.deepEqual(
				pool.snapshotEntries().entries,
				[],
				"a directory checked out on someone else's branch is not a free pool entry",
			);
		} finally {
			await pool.stop();
		}
	});

	it("refuses a recorded path a live session is using", async () => {
		// Belt and braces: a crash between claim and record-write could leave a
		// claimed worktree still listed. The live-session set is the tiebreak.
		const recordStore = new MemoryPoolRecordStore();
		const contestedPath = path.resolve("virtual-record-wt", "pool-_pool-inuse123");
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName: "pool/_pool-inuse123", worktreePath: contestedPath, createdAt: Date.now() },
		]);
		const { pool } = makePool({
			repoPath,
			liveWorktrees: [{ path: contestedPath, branch: "pool/_pool-inuse123" }],
			recordStore,
		});
		try {
			await pool.initialize(new Set([contestedPath]));
			assert.deepEqual(
				pool.snapshotEntries().entries,
				[],
				"a worktree a live session references must not be handed to someone else",
			);
		} finally {
			await pool.stop();
		}
	});

	it("discards records when the project's repository path has changed", async () => {
		const recordStore = new MemoryPoolRecordStore();
		recordStore.replace(PROJECT_ID, path.resolve("some-other-repo"), [
			{
				branchName: "pool/_pool-abc12345",
				worktreePath: path.resolve("virtual-record-wt", "pool-_pool-abc12345"),
				createdAt: Date.now(),
			},
		]);
		const { pool } = makePool({
			repoPath,
			liveWorktrees: [{ path: path.resolve("virtual-record-wt", "pool-_pool-abc12345"), branch: "pool/_pool-abc12345" }],
			recordStore,
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, [], "records describing a different repo must not be adopted");
		} finally {
			await pool.stop();
		}
	});

	it("SessionManager excludes persisted live cwd descendants but not archived rows", async () => {
		const recordedPath = path.resolve("virtual-persisted-live-wt", "pool-_pool-persisted");
		const branchName = "pool/_pool-persisted";
		const commandRunner: CommandRunner = {
			execFile: async (_file, args) => args[0] === "worktree" && args[1] === "list"
				? { stdout: gitWorktreeListOutput(repoPath, [{ path: recordedPath, branch: branchName }]), stderr: "" }
				: { stdout: "", stderr: "" },
		};
		const cases = [
			{ label: "live cwd descendant", row: { cwd: path.join(recordedPath, "packages", "app"), archived: false }, adopted: false },
			{ label: "live component", row: { repoWorktrees: { api: recordedPath }, archived: false }, adopted: false },
			{ label: "archived cwd", row: { cwd: path.join(recordedPath, "packages", "app"), archived: true }, adopted: true },
		];
		for (const testCase of cases) {
			const recordStore = new MemoryPoolRecordStore();
			recordStore.replace(PROJECT_ID, repoPath, [{ branchName, worktreePath: recordedPath, createdAt: 1 }]);
			const manager = Object.create(SessionManager.prototype) as SessionManager;
			Object.assign(manager as unknown as Record<string, unknown>, {
				projectContextManager: null,
				sessions: new Map(),
				worktreePools: new Map(),
				worktreePoolInitializations: new Map(),
				worktreePoolRecords: recordStore,
				commandRunner,
				remoteGitPolicy: { skipNonLocalRemoteGit: true },
				worktreeSetupRuntime: {},
				getAllPersistedSessionsForWorktreeGuard: () => [{ id: "persisted-session", ...testCase.row }],
			});

			await manager.initWorktreePoolForProject(PROJECT_ID, repoPath, undefined, 0);
			const entries = manager.getWorktreePool(PROJECT_ID)?.snapshotEntries().entries ?? [];
			assert.equal(entries.length, testCase.adopted ? 1 : 0, testCase.label);
			await manager.getWorktreePool(PROJECT_ID)?.stop();
		}
	});

	it("adopts nothing when no record store is configured", async () => {
		// Opting out must restore the previous behaviour exactly.
		const poolPath = path.resolve("virtual-record-wt", "pool-_pool-abc12345");
		const commandRunner: CommandRunner = {
			execFile: async () => ({ stdout: gitWorktreeListOutput(repoPath, [{ path: poolPath, branch: "pool/_pool-abc12345" }]), stderr: "" }),
		};
		const pool = new WorktreePool({
			repoPath,
			targetSize: 0,
			commandRunner,
			remotePolicy: { skipNonLocalRemoteGit: true },
			resolveRepoToplevelImpl: async () => repoPath,
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, []);
		} finally {
			await pool.stop();
		}
	});
});
