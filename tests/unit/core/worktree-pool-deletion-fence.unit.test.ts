import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import type { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";
import {
	MemoryPoolRecordStore,
	type PoolEntryRecord,
} from "../../../src/server/agent/worktree-pool-record.ts";
import type { CommandRunner } from "../../../src/server/gateway-deps.ts";

const managers: SessionManager[] = [];
const tempRoots: string[] = [];

class TrackingRecordStore extends MemoryPoolRecordStore {
	readonly events: string[] = [];

	override replace(projectId: string, repoPath: string, entries: readonly PoolEntryRecord[]): void {
		this.events.push(`replace:${projectId}:${entries.length}`);
		super.replace(projectId, repoPath, entries);
	}

	override forget(projectId: string): void {
		this.events.push(`forget:${projectId}`);
		super.forget(projectId);
	}

	override async flush(): Promise<void> {
		this.events.push("flush");
	}
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function gitWorktreeList(repoPath: string, worktreePath: string, branchName: string): string {
	return [
		`worktree ${repoPath}\nbranch refs/heads/main`,
		`worktree ${worktreePath}\nbranch refs/heads/${branchName}`,
	].join("\n\n") + "\n";
}

function dormantFixture(options: {
	projectId?: string;
	listedBranch?: string;
	liveReference?: boolean;
	failList?: boolean;
	contextAvailable?: boolean;
	failRepoRoot?: boolean;
} = {}) {
	const projectId = options.projectId ?? "deleted-project";
	const lexicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pool-delete-"));
	// Hosted Windows can expose os.tmpdir() through RUNNER~1. Use its native
	// spelling so this fake-Git fixture does not accidentally exercise the
	// separately covered linked-worktree alias cleanup protocol.
	const root = fs.realpathSync.native(lexicalRoot);
	tempRoots.push(root);
	const repoPath = path.join(root, "repo");
	const worktreePath = path.join(root, "worktrees", "pool-_pool-recorded");
	const branchName = "pool/_pool-recorded";
	fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
	fs.mkdirSync(worktreePath, { recursive: true });
	if (options.liveReference) fs.mkdirSync(path.join(worktreePath, "packages", "app"), { recursive: true });
	fs.writeFileSync(path.join(worktreePath, "user-content.txt"), "must survive unless exact ownership is proven");

	const recordStore = new TrackingRecordStore();
	recordStore.replace(projectId, repoPath, [{ branchName, worktreePath, createdAt: 1 }]);
	recordStore.events.length = 0;
	const commandCalls: string[][] = [];
	const commandRunner: CommandRunner = {
		execFile: async (_file, args) => {
			commandCalls.push([...args]);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				if (options.failRepoRoot) throw new Error("repository unavailable");
				return { stdout: repoPath, stderr: "" };
			}
			if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
				return { stdout: path.join(repoPath, ".git"), stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				if (options.failList) throw new Error("worktree inventory unavailable");
				return {
					stdout: gitWorktreeList(repoPath, worktreePath, options.listedBranch ?? branchName),
					stderr: "",
				};
			}
			if (args[0] === "worktree" && args[1] === "remove") {
				recordStore.events.push(`cleanup:${String(args[2])}`);
			}
			return { stdout: "", stderr: "" };
		},
	};
	const context = {
		project: { id: projectId, rootPath: repoPath },
		projectConfigStore: {
			getComponents: () => [{ name: "root", repo: "." }],
			get: () => undefined,
		},
	};
	const projectContextManager = {
		getExisting: (id: string) => options.contextAvailable === false || id !== projectId ? undefined : context,
		getAllSessions: () => options.liveReference
			? [{ id: "live-session", projectId, cwd: path.join(worktreePath, "packages", "app"), archived: false }]
			: [],
		all: () => [],
	};
	const manager = new SessionManager({
		commandRunner,
		projectContextManager: projectContextManager as never,
		worktreePoolRecordStore: recordStore,
		remoteGitPolicy: { skipRemotePush: true },
	});
	managers.push(manager);
	return { branchName, commandCalls, manager, projectId, recordStore, repoPath, worktreePath };
}

function worktreeRemoveCalls(calls: readonly string[][]): string[][] {
	return calls.filter(args => args[0] === "worktree" && args[1] === "remove");
}

describe("worktree pool deletion fence", () => {
	it("strictly re-adopts and drains an exact dormant durable entry before forgetting and flushing", async () => {
		const fixture = dormantFixture();

		await fixture.manager.removeWorktreePool(fixture.projectId);

		assert.equal(fs.existsSync(fixture.worktreePath), false, "the exact recorded and Git-confirmed worktree is drained");
		assert.deepEqual(worktreeRemoveCalls(fixture.commandCalls), [["worktree", "remove", fixture.worktreePath, "--force"]]);
		assert.ok(!fixture.commandCalls.some(args => args[0] === "worktree" && args[1] === "add"), "the deletion-only pool has target size zero");
		assert.deepEqual(fixture.recordStore.read(fixture.projectId), { entries: [] });
		const cleanupIndex = fixture.recordStore.events.indexOf(`cleanup:${fixture.worktreePath}`);
		const forgetIndex = fixture.recordStore.events.indexOf(`forget:${fixture.projectId}`);
		const flushIndex = fixture.recordStore.events.indexOf("flush");
		assert.ok(cleanupIndex >= 0 && cleanupIndex < forgetIndex, "drain cleanup precedes project-record removal");
		assert.ok(forgetIndex < flushIndex, "record removal is durable before deletion returns");
		assert.equal(fs.existsSync(path.join(fixture.repoPath, "worktree-pools.json")), false, "pool state never leaks into the project repository");
	});

	it("leaves mismatched, live, and Git-unverifiable dormant paths physically untouched", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const cases: Array<{
				label: string;
				options: Parameters<typeof dormantFixture>[0];
			}> = [
				{ label: "branch mismatch", options: { listedBranch: "feature/user" } },
				{ label: "live reference", options: { liveReference: true } },
				{ label: "unverifiable Git inventory", options: { failList: true } },
			];
			for (const testCase of cases) {
				const fixture = dormantFixture(testCase.options);

				await fixture.manager.removeWorktreePool(fixture.projectId);

				assert.equal(fs.existsSync(fixture.worktreePath), true, `${testCase.label}: the path must remain`);
				assert.equal(fs.readFileSync(path.join(fixture.worktreePath, "user-content.txt"), "utf8"), "must survive unless exact ownership is proven");
				assert.deepEqual(worktreeRemoveCalls(fixture.commandCalls), [], `${testCase.label}: no destructive Git command`);
				assert.deepEqual(fixture.recordStore.read(fixture.projectId), { entries: [] }, `${testCase.label}: explicit deletion forgets rejected hints`);
				assert.equal(fs.existsSync(path.join(fixture.repoPath, "worktree-pools.json")), false);
			}
		} finally {
			warn.mockRestore();
		}
	});

	it("fails safe and retains the durable record when project or repository context is unavailable", async () => {
		for (const testCase of [
			{ label: "project context", options: { contextAvailable: false } },
			{ label: "repository context", options: { failRepoRoot: true } },
		]) {
			const fixture = dormantFixture(testCase.options);

			await assert.rejects(
				fixture.manager.removeWorktreePool(fixture.projectId),
				/ context is unavailable|repository unavailable/,
			);

			assert.equal(fs.existsSync(fixture.worktreePath), true, `${testCase.label}: the worktree remains untouched`);
			assert.deepEqual(fixture.recordStore.read(fixture.projectId), {
				repoPath: fixture.repoPath,
				entries: [{ branchName: fixture.branchName, worktreePath: fixture.worktreePath, createdAt: 1 }],
			});
			assert.deepEqual(worktreeRemoveCalls(fixture.commandCalls), []);
			assert.ok(!fixture.recordStore.events.some(event => event.startsWith("forget:")), "unverified authority remains retryable");
			assert.ok(!fixture.recordStore.events.includes("flush"), "no false deletion result is flushed");
			assert.equal(fs.existsSync(path.join(fixture.repoPath, "worktree-pools.json")), false);
		}
	});

	it("blocks a delayed boot init after deletion before construction or record restoration", async () => {
		const projectId = "stale-init-project";
		const recordStore = new TrackingRecordStore();
		const commandRunner = { execFile: vi.fn() };
		const manager = new SessionManager({
			commandRunner: commandRunner as never,
			worktreePoolRecordStore: recordStore,
		});
		managers.push(manager);

		let releaseStaleBootInit!: () => void;
		const staleBootInitBarrier = new Promise<void>(resolve => { releaseStaleBootInit = resolve; });
		const staleBootInit = (async () => {
			await staleBootInitBarrier;
			await manager.initWorktreePoolForProject(projectId, "C:/repo", undefined, 1);
		})();

		await manager.removeWorktreePool(projectId);
		assert.deepEqual(recordStore.events, [`forget:${projectId}`, "flush"]);

		releaseStaleBootInit();
		await staleBootInit;
		assert.equal(commandRunner.execFile.mock.calls.length, 0, "the fenced callback must not touch Git");
		assert.equal(manager.getWorktreePool(projectId), null);
		assert.deepEqual(recordStore.read(projectId), { entries: [] });
		assert.ok(!recordStore.events.some(event => event.startsWith("replace:")), "the delayed init must not recreate durable ownership");
	});

	it("serializes concurrent removal and permits a safe retry without reopening stale init", async () => {
		const projectId = "retry-deleted-project";
		const recordStore = new TrackingRecordStore();
		const commandRunner = { execFile: vi.fn() };
		const manager = new SessionManager({
			commandRunner: commandRunner as never,
			worktreePoolRecordStore: recordStore,
		});
		managers.push(manager);

		const expected = new Error("drain failed");
		let releaseFirst!: () => void;
		const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
		const drain = vi.fn(async () => {
			if (drain.mock.calls.length === 1) {
				await firstBarrier;
				throw expected;
			}
		});
		manager.getAllWorktreePools().set(projectId, { drain } as unknown as WorktreePool);

		const first = manager.removeWorktreePool(projectId);
		const concurrent = manager.removeWorktreePool(projectId);
		releaseFirst();
		const results = await Promise.allSettled([first, concurrent]);
		assert.ok(results.every(result => result.status === "rejected" && result.reason === expected));
		assert.equal(drain.mock.calls.length, 1, "concurrent callers share one drain owner");
		assert.deepEqual(recordStore.events, [], "failed drain retains ownership and does not flush a false success");

		await manager.initWorktreePoolForProject(projectId, "C:/repo", undefined, 1);
		assert.equal(commandRunner.execFile.mock.calls.length, 0, "failure must not reopen init for a stale callback");

		await manager.removeWorktreePool(projectId);
		assert.equal(drain.mock.calls.length, 2, "a settled failure releases the removal slot for retry");
		assert.deepEqual(recordStore.events, [`forget:${projectId}`, "flush"]);
		assert.equal(manager.getWorktreePool(projectId), null);
	});
});
