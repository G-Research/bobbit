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
	liveWorktrees: Array<{ path: string; branch?: string }> | (() => Array<{ path: string; branch?: string }>);
	recordStore: MemoryPoolRecordStore;
	projectId?: string;
	components?: Component[];
	realpathNativeImpl?: (value: string) => Promise<string>;
}) {
	const mutations: string[][] = [];
	const cleanupCalls: Array<{ repoPath: string; worktreePath: string; branchName?: string }> = [];
	const commandRunner: CommandRunner = {
		execFile: async (_file, args) => {
			if (args[0] === "worktree" && args[1] === "list") {
				const liveWorktrees = typeof opts.liveWorktrees === "function" ? opts.liveWorktrees() : opts.liveWorktrees;
				return { stdout: gitWorktreeListOutput(opts.repoPath, liveWorktrees), stderr: "" };
			}
			if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
				return { stdout: path.join(opts.repoPath, ".git"), stderr: "" };
			}
			if (args[0] === "for-each-ref") return { stdout: "", stderr: "" };
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
		realpathNativeImpl: opts.realpathNativeImpl ?? (async value => path.resolve(value)),
		componentsResolver: opts.components ? () => opts.components! : undefined,
		cleanupWorktreeImpl: async (cleanupRepoPath, worktreePath, branchName) => {
			cleanupCalls.push({ repoPath: cleanupRepoPath, worktreePath, branchName });
		},
		recordStore: opts.recordStore,
		projectId: opts.projectId ?? PROJECT_ID,
	});
	return { pool, mutations, cleanupCalls };
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

	it("revokes an adopted entry without mutation when its branch changes after initialization", async () => {
		const recordStore = new MemoryPoolRecordStore();
		const branchName = "pool/_pool-raced123";
		let currentBranch = branchName;
		recordStore.replace(PROJECT_ID, repoPath, [
			{ branchName, worktreePath: poolPath, createdAt: Date.now() },
		]);
		const { pool, mutations, cleanupCalls } = makePool({
			repoPath,
			liveWorktrees: () => [{ path: poolPath, branch: currentBranch }],
			recordStore,
		});
		try {
			await pool.initialize();
			currentBranch = "feature/mine";
			assert.equal(await pool.claim("session/must-fall-back"), null);
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, [], "stale authority must be revoked");
			assert.deepEqual(mutations, [], "revalidation failure must precede every Git mutation");
			assert.deepEqual(cleanupCalls, [], "claim-failure cleanup must not touch the contested worktree");
		} finally {
			await pool.stop();
		}
	});

	it("revalidates adopted entries before explicit drain cleanup", async () => {
		for (const changedAfterInitialize of [false, true]) {
			const recordStore = new MemoryPoolRecordStore();
			const branchName = "pool/_pool-drain123";
			let currentBranch = branchName;
			recordStore.replace(PROJECT_ID, repoPath, [
				{ branchName, worktreePath: poolPath, createdAt: Date.now() },
			]);
			const { pool, mutations, cleanupCalls } = makePool({
				repoPath,
				liveWorktrees: () => [{ path: poolPath, branch: currentBranch }],
				recordStore,
			});
			await pool.initialize();
			if (changedAfterInitialize) currentBranch = "feature/mine";
			await pool.drain();
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, [], "drain must revoke restart authority first");
			assert.equal(cleanupCalls.length, changedAfterInitialize ? 0 : 1, changedAfterInitialize
				? "a changed adopted worktree must be left untouched"
				: "an unchanged adopted worktree remains explicitly drainable");
			assert.deepEqual(mutations, [], "the injected cleanup is the only valid drain mutation");
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

	it("never promotes a remaining external entry when another external entry is claimed", async () => {
		const recordStore = new MemoryPoolRecordStore();
		const { pool } = makePool({ repoPath, liveWorktrees: [], recordStore });
		pool.registerExternalEntry("pool/_pool-external-one", path.resolve("virtual-record-wt", "external-one"));
		pool.registerExternalEntry("pool/_pool-external-two", path.resolve("virtual-record-wt", "external-two"));
		try {
			assert.ok(await pool.claim("session/external-one"));
			assert.equal(pool.size, 1, "the second external entry remains claimable in memory");
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, [], "external test-seam entries are never restart authority");
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
		webBranch?: string | (() => string);
		failWebList?: boolean;
	}) {
		const mutationCommands: string[][] = [];
		const filesystemRenames: Array<{ oldPath: string; newPath: string }> = [];
		const cleanupCalls: Array<{ repoPath: string; worktreePath: string; branchName?: string }> = [];
		const commandRunner: CommandRunner = {
			execFile: async (_file, args, options) => {
				if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
					return { stdout: String(options?.cwd), stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
					return { stdout: "abc123", stderr: "" };
				}
				if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
					return { stdout: path.join(String(options?.cwd), ".git"), stderr: "" };
				}
				if (args[0] === "worktree" && args[1] === "list") {
					if (options?.cwd === members[1]!.repoPath && overrides?.failWebList) throw new Error("list failed");
					const member = members.find(candidate => candidate.repoPath === options?.cwd);
					if (!member) throw new Error(`unexpected worktree list cwd: ${options?.cwd}`);
					const configuredWebBranch = typeof overrides?.webBranch === "function" ? overrides.webBranch() : overrides?.webBranch;
					const branch = member.repo === "web" ? configuredWebBranch ?? branchName : branchName;
					return { stdout: gitWorktreeListOutput(member.repoPath, [{ path: member.worktreePath, branch }]), stderr: "" };
				}
				if (args[0] === "for-each-ref") return { stdout: "", stderr: "" };
				mutationCommands.push([...args]);
				return { stdout: "", stderr: "" };
			},
		};
		const pool = new WorktreePool({
			repoPath: root,
			targetSize: 0,
			componentsResolver: () => components,
			commandRunner,
			resolveRepoToplevelImpl: async () => root,
			realpathNativeImpl: async value => path.resolve(value),
			fsImpl: { rename: async (oldPath, newPath) => { filesystemRenames.push({ oldPath, newPath }); } },
			cleanupWorktreeImpl: async (repoPath, worktreePath, cleanupBranchName) => {
				cleanupCalls.push({ repoPath, worktreePath, branchName: cleanupBranchName });
			},
			recordStore,
			projectId: PROJECT_ID,
		});
		return { pool, mutationCommands, filesystemRenames, cleanupCalls };
	}

	function recordedStore(): MemoryPoolRecordStore {
		const store = new MemoryPoolRecordStore();
		store.replace(PROJECT_ID, root, [{ branchName, worktreePath: container, worktrees: members, createdAt: 1 }]);
		return store;
	}

	it("adopts a complete set only after every member has an exact Git identity match", async () => {
		const store = recordedStore();
		const { pool } = createMultiPool(store);
		await pool.initialize();
		try {
			assert.deepEqual(pool.snapshotEntries().entries[0]?.worktrees, members);
		} finally {
			await pool.stop();
		}
	});

	it("revokes a complete adopted set without mutation when one member changes after initialization", async () => {
		const store = recordedStore();
		let webBranch = branchName;
		const { pool, mutationCommands, filesystemRenames, cleanupCalls } = createMultiPool(store, { webBranch: () => webBranch });
		await pool.initialize();
		try {
			webBranch = "feature/mine";
			assert.equal(await pool.claim("session/must-fall-back"), null);
			assert.deepEqual(store.read(PROJECT_ID).entries, [], "the complete set's authority must be revoked");
			assert.deepEqual(mutationCommands, [], "no member may mutate when one exact match changed");
			assert.deepEqual(filesystemRenames, [], "all-or-nothing validation must precede the container rename");
			assert.deepEqual(cleanupCalls, [], "claim-failure cleanup must not touch any contested member");
		} finally {
			await pool.stop();
		}
	});

	it("skips complete-set drain cleanup when one adopted member changes", async () => {
		const store = recordedStore();
		let webBranch = branchName;
		const { pool, mutationCommands, filesystemRenames, cleanupCalls } = createMultiPool(store, { webBranch: () => webBranch });
		await pool.initialize();
		webBranch = "feature/mine";
		await pool.drain();
		assert.deepEqual(store.read(PROJECT_ID).entries, []);
		assert.deepEqual(mutationCommands, []);
		assert.deepEqual(filesystemRenames, []);
		assert.deepEqual(cleanupCalls, [], "drain must leave every member untouched after an all-or-nothing mismatch");
	});

	it("rejects missing, extra, or reordered members before worktree mutation", async () => {
		const variants = [
			[members[0]!],
			[...members, { repo: "docs", repoPath: path.join(root, "docs"), worktreePath: path.join(container, "docs") }],
			[members[1]!, members[0]!],
		];
		for (const worktrees of variants) {
			const store = new MemoryPoolRecordStore();
			store.replace(PROJECT_ID, root, [{ branchName, worktreePath: container, worktrees, createdAt: 1 }]);
			const { pool, mutationCommands } = createMultiPool(store);
			await pool.initialize();
			try {
				assert.deepEqual(pool.snapshotEntries().entries, []);
				assert.deepEqual(store.read(PROJECT_ID).entries, [], "the incomplete authority record must be revoked");
				assert.deepEqual(mutationCommands, [], "a rejected set must cause no Git mutation");
			} finally {
				await pool.stop();
			}
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
			const { pool } = createMultiPool(store);
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
				const { pool } = createMultiPool(store, overrides);
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
			const { pool } = createMultiPool(store);
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

	it("does not collapse case-distinct POSIX-style identities", async () => {
		const recordStore = new MemoryPoolRecordStore();
		const recordedPath = path.resolve("virtual-case-wt", "User");
		const gitPath = path.resolve("virtual-case-wt", "user");
		recordStore.replace(PROJECT_ID, repoPath, [{ branchName: "pool/_pool-case", worktreePath: recordedPath, createdAt: 1 }]);
		const { pool, mutations } = makePool({
			repoPath,
			liveWorktrees: [{ path: gitPath, branch: "pool/_pool-case" }],
			recordStore,
			realpathNativeImpl: async value => path.resolve(value),
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, []);
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, []);
			assert.deepEqual(mutations, [], "case-distinct rejection must not mutate Git");
		} finally {
			await pool.stop();
		}
	});

	it("preserves legal whitespace and POSIX backslash bytes in canonical identities", async () => {
		const variants = [
			{ recorded: path.resolve("virtual-byte-wt", "owner "), listed: path.resolve("virtual-byte-wt", "owner") },
		];
		if (process.platform !== "win32") {
			variants.push({
				recorded: path.resolve("virtual-byte-wt", "owner\\child"),
				listed: path.resolve("virtual-byte-wt", "owner", "child"),
			});
		}
		for (const [index, variant] of variants.entries()) {
			const branchName = `pool/_pool-bytes-${index}`;
			const recordStore = new MemoryPoolRecordStore();
			recordStore.replace(PROJECT_ID, repoPath, [{ branchName, worktreePath: variant.recorded, createdAt: 1 }]);
			const { pool, mutations } = makePool({
				repoPath,
				liveWorktrees: [{ path: variant.listed, branch: branchName }],
				recordStore,
				realpathNativeImpl: async value => path.resolve(value),
			});
			try {
				await pool.initialize();
				assert.deepEqual(pool.snapshotEntries().entries, []);
				assert.deepEqual(recordStore.read(PROJECT_ID).entries, []);
				assert.deepEqual(mutations, [], "byte-distinct rejection must not mutate Git");
			} finally {
				await pool.stop();
			}
		}
	});

	it("uses native realpath identity for recorded, Git-listed, and live aliases", async () => {
		const canonicalPath = path.resolve("virtual-alias-wt", "canonical");
		const aliasPath = path.resolve("virtual-alias-wt", "alias");
		const identities = new Map([[aliasPath, canonicalPath]]);
		const realpathNativeImpl = async (value: string) => identities.get(path.resolve(value)) ?? path.resolve(value);

		for (const activePaths of [undefined, new Set([aliasPath])]) {
			const recordStore = new MemoryPoolRecordStore();
			recordStore.replace(PROJECT_ID, repoPath, [{ branchName: "pool/_pool-alias", worktreePath: aliasPath, createdAt: 1 }]);
			const { pool, mutations } = makePool({
				repoPath,
				liveWorktrees: [{ path: canonicalPath, branch: "pool/_pool-alias" }],
				recordStore,
				realpathNativeImpl,
			});
			try {
				await pool.initialize(activePaths);
				assert.equal(pool.size, activePaths ? 0 : 1, activePaths ? "a live alias must exclude adoption" : "an exact canonical alias may be adopted");
				assert.deepEqual(mutations, [], "identity validation must not mutate Git");
			} finally {
				await pool.stop();
			}
		}
	});

	it("rejects ambiguous duplicate Git rows that resolve to one identity", async () => {
		const canonicalPath = path.resolve("virtual-duplicate-wt", "canonical");
		const aliasPath = path.resolve("virtual-duplicate-wt", "alias");
		const recordStore = new MemoryPoolRecordStore();
		recordStore.replace(PROJECT_ID, repoPath, [{ branchName: "pool/_pool-duplicate", worktreePath: canonicalPath, createdAt: 1 }]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { pool, mutations } = makePool({
			repoPath,
			liveWorktrees: [
				{ path: canonicalPath, branch: "pool/_pool-duplicate" },
				{ path: aliasPath, branch: "pool/_pool-duplicate" },
			],
			recordStore,
			realpathNativeImpl: async value => path.resolve(value) === aliasPath ? canonicalPath : path.resolve(value),
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, []);
			assert.deepEqual(recordStore.read(PROJECT_ID).entries, []);
			assert.deepEqual(mutations, [], "ambiguous Git inventory must not mutate Git");
		} finally {
			warn.mockRestore();
			await pool.stop();
		}
	});

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
		const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-live-ref-"));
		const liveRepoPath = path.join(testRoot, "repo");
		const recordedPath = path.join(testRoot, "worktrees", "pool-_pool-persisted");
		fs.mkdirSync(path.join(liveRepoPath), { recursive: true });
		fs.mkdirSync(path.join(recordedPath, "packages", "app"), { recursive: true });
		const branchName = "pool/_pool-persisted";
		const commandRunner: CommandRunner = {
			execFile: async (_file, args) => args[0] === "worktree" && args[1] === "list"
				? { stdout: gitWorktreeListOutput(liveRepoPath, [{ path: recordedPath, branch: branchName }]), stderr: "" }
				: { stdout: "", stderr: "" },
		};
		const cases = [
			{ label: "live cwd descendant", row: { cwd: path.join(recordedPath, "packages", "app"), archived: false }, adopted: false },
			{ label: "live component", row: { repoWorktrees: { api: recordedPath }, archived: false }, adopted: false },
			{ label: "archived cwd", row: { cwd: path.join(recordedPath, "packages", "app"), archived: true }, adopted: true },
		];
		try {
			for (const testCase of cases) {
				const recordStore = new MemoryPoolRecordStore();
				recordStore.replace(PROJECT_ID, liveRepoPath, [{ branchName, worktreePath: recordedPath, createdAt: 1 }]);
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

				await manager.initWorktreePoolForProject(PROJECT_ID, liveRepoPath, undefined, 0);
				const entries = manager.getWorktreePool(PROJECT_ID)?.snapshotEntries().entries ?? [];
				assert.equal(entries.length, testCase.adopted ? 1 : 0, testCase.label);
				await manager.getWorktreePool(PROJECT_ID)?.stop();
			}
		} finally {
			fs.rmSync(testRoot, { recursive: true, force: true });
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
			realpathNativeImpl: async value => path.resolve(value),
		});
		try {
			await pool.initialize();
			assert.deepEqual(pool.snapshotEntries().entries, []);
		} finally {
			await pool.stop();
		}
	});
});
