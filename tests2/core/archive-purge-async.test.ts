import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { BACKGROUND_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import {
	SessionManager,
	type SessionPreviewPurgeOperation,
} from "../../src/server/agent/session-manager.ts";
import { createManualClock, type ManualClock } from "../harness/clock.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const heldDeferredReleases: Array<() => void> = [];

function heldDeferred(): Deferred<void> {
	const hold = deferred<void>();
	heldDeferredReleases.push(() => hold.resolve());
	return hold;
}

function fileError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function cleanupRunner(onList?: () => { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>): any {
	return {
		execFile: async (_command: string, args: readonly string[]) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				await fs.promises.rm(String(args[2]), { recursive: true, force: true });
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "worktree" && args[1] === "list") return await onList?.() ?? { stdout: "", stderr: "" };
			return { stdout: "", stderr: "" };
		},
	};
}

function archivedSession(id: string, now: number, agentSessionFile?: string): any {
	return {
		id,
		title: id,
		cwd: "",
		projectId: "project-archive",
		archived: true,
		archivedAt: now - 8 * DAY_MS,
		agentSessionFile,
		createdAt: now - 9 * DAY_MS,
		lastActivity: now - 8 * DAY_MS,
	};
}

function makeManager(options: {
	records: any[];
	clock?: ManualClock;
	archiveStat?: (filePath: string) => Promise<{ size: number }>;
	purgeAsync?: (id: string) => Promise<void>;
	previewPurgeOperation?: SessionPreviewPurgeOperation;
	commandRunner?: any;
}): { manager: SessionManager; records: Map<string, any>; clock: ManualClock } {
	const clock = options.clock ?? createManualClock(20 * DAY_MS);
	const records = new Map(options.records.map(record => [record.id, record]));
	const store = {
		get: (id: string) => records.get(id),
		getAll: () => [...records.values()],
		getLive: () => [...records.values()].filter(record => !record.archived),
		getArchived: () => [...records.values()].filter(record => record.archived),
		purgeAsync: async (id: string) => {
			await options.purgeAsync?.(id);
			records.delete(id);
		},
	};
	const context = {
		project: { id: "project-archive", name: "Archive test" },
		sessionStore: store,
		searchIndex: {
			removeMessagesForSession: () => undefined,
			removeSession: () => undefined,
		},
	};
	const projectContextManager = {
		all: () => [context],
		getOrCreate: () => context,
		getAllSessions: () => [...records.values()],
		getAllLiveSessions: () => [...records.values()].filter(record => !record.archived),
	};
	const manager = new SessionManager({
		clock,
		projectContextManager: projectContextManager as any,
		archiveStat: options.archiveStat,
		previewPurgeOperation: options.previewPurgeOperation,
		commandRunner: options.commandRunner,
		remoteGitPolicy: { skipRemotePush: true },
	});
	const internal = manager as any;
	if (internal._statusHeartbeatTimer) {
		clock.clearInterval(internal._statusHeartbeatTimer);
		internal._statusHeartbeatTimer = null;
	}
	return { manager, records, clock };
}

const managers: SessionManager[] = [];

afterEach(async () => {
	for (const release of heldDeferredReleases.splice(0)) release();
	try {
		await Promise.all(managers.splice(0).map(manager => manager.stopPurgeSchedule()));
	} finally {
		vi.restoreAllMocks();
	}
});

describe("asynchronous archive purge lifecycle", () => {
	it("bounds deferred archive stats and lets unrelated event-loop work progress", async () => {
		const now = 20 * DAY_MS;
		const count = BACKGROUND_IO_CONCURRENCY * 2 + 1;
		const records = Array.from({ length: count }, (_, index) =>
			archivedSession(`archive-${index}`, now, `/transcripts/${index}.jsonl`));
		const release = heldDeferred();
		const workersStarted = deferred<void>();
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const { manager } = makeManager({
			records,
			clock: createManualClock(now),
			archiveStat: async (filePath) => {
				calls++;
				active++;
				maxActive = Math.max(maxActive, active);
				if (calls === BACKGROUND_IO_CONCURRENCY) workersStarted.resolve();
				try {
					await release.promise;
					return { size: Number(/(\d+)\.jsonl$/.exec(filePath)?.[1] ?? 0) + 1 };
				} finally {
					active--;
				}
			},
		});
		managers.push(manager);

		let settled = false;
		let stats: Awaited<ReturnType<typeof manager.getExpiredArchiveStats>> | undefined;
		const statsPromise = manager.getExpiredArchiveStats().then(value => { settled = true; return value; });
		const unrelatedWork = deferred<void>();
		setImmediate(() => unrelatedWork.resolve());
		try {
			await Promise.all([workersStarted.promise, unrelatedWork.promise]);
			assert.equal(settled, false);
			assert.equal(active, BACKGROUND_IO_CONCURRENCY);
			assert.equal(maxActive, BACKGROUND_IO_CONCURRENCY);
			assert.equal(calls, BACKGROUND_IO_CONCURRENCY, "no work above the shared ceiling starts while every worker is held");

			release.resolve();
			stats = await statsPromise;
		} finally {
			release.resolve();
			await statsPromise.catch(() => undefined);
		}
		assert.deepEqual(stats, {
			count,
			totalSizeBytes: count * (count + 1) / 2,
		});
		assert.equal(calls, count);
		assert.ok(maxActive <= BACKGROUND_IO_CONCURRENCY);
	});

	it("coalesces scheduled purge ticks and stopPurgeSchedule joins the active run", async () => {
		const now = 20 * DAY_MS;
		const releasePurge = heldDeferred();
		const purgeStarted = deferred<void>();
		let purgeCalls = 0;
		const { manager, clock } = makeManager({
			records: [archivedSession("archive-held", now)],
			clock: createManualClock(now),
			purgeAsync: async () => {
				purgeCalls++;
				purgeStarted.resolve();
				await releasePurge.promise;
			},
		});
		managers.push(manager);
		manager.startPurgeSchedule();

		let stop: Promise<void> | undefined;
		try {
			clock.advance(DAY_MS);
			await purgeStarted.promise;
			assert.equal(purgeCalls, 1);

			clock.advance(DAY_MS);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(purgeCalls, 1, "a second timer tick must join, not overlap, the active purge");

			let stopSettled = false;
			stop = manager.stopPurgeSchedule().then(() => { stopSettled = true; });
			const unrelatedWork = deferred<void>();
			setImmediate(() => unrelatedWork.resolve());
			await unrelatedWork.promise;
			assert.equal(stopSettled, false, "stop must await the in-flight purge");
			assert.equal(clock.pending(), 0, "stop must cancel the future interval before joining");
		} finally {
			releasePurge.resolve();
			await (stop ?? manager.stopPurgeSchedule());
		}

		clock.advance(2 * DAY_MS);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(purgeCalls, 1, "no stale timer callback may start cleanup after stop");
	});

	it("waits for explicit purge readiness after more than 1,000 event-loop turns", async () => {
		const now = 20 * DAY_MS;
		const previewCleanupStarted = deferred<void>();
		const allowPreviewCleanup = heldDeferred();
		const purgeStarted = deferred<void>();
		let purgeStartedFlag = false;
		const { manager, clock } = makeManager({
			records: [archivedSession("archive-delayed-readiness", now)],
			clock: createManualClock(now),
			previewPurgeOperation: async (_sessionId, operation) => {
				previewCleanupStarted.resolve();
				await allowPreviewCleanup.promise;
				return operation();
			},
			purgeAsync: async () => {
				purgeStartedFlag = true;
				purgeStarted.resolve();
			},
		});
		managers.push(manager);
		manager.startPurgeSchedule();

		clock.advance(DAY_MS);
		await previewCleanupStarted.promise;
		const releaseAfterControlledDelay = (async () => {
			for (let turn = 0; turn < 1_001; turn++) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			allowPreviewCleanup.resolve();
		})();

		try {
			await purgeStarted.promise;
			assert.equal(purgeStartedFlag, true);
		} finally {
			allowPreviewCleanup.resolve();
			await releaseAfterControlledDelay;
			await manager.stopPurgeSchedule();
		}
	});

	it("emits worktree removal only for confirmed cleanup coordinates", async () => {
		const { manager } = makeManager({ records: [archivedSession("archive-worktree-removal", 20 * DAY_MS)] });
		managers.push(manager);
		const removals: Array<{ sessionId: string; projectId?: string; worktreePaths: readonly string[] }> = [];
		manager.addWorktreeRemovedListener((sessionId, info) => { removals.push({ sessionId, ...info }); });
		await (manager as any).notifyWorktreeRemoved("archive-worktree-removal", "project-archive", []);
		assert.deepEqual(removals, []);
		await (manager as any).notifyWorktreeRemoved("archive-worktree-removal", "project-archive", ["/worktree/removed"]);
		assert.deepEqual(removals, [{ sessionId: "archive-worktree-removal", projectId: "project-archive", worktreePaths: ["/worktree/removed"] }]);
	});

	it("confirms ENOENT before notifying a single-repo purge removal", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-purge-enoent-"));
		try {
			const repo = path.join(tmp, "repo");
			const worktree = path.join(tmp, "repo-wt", "archive");
			fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
			fs.mkdirSync(worktree, { recursive: true });
			const { manager } = makeManager({
				records: [{ ...archivedSession("archive-enoent", 20 * DAY_MS), repoPath: repo, worktreePath: worktree, cwd: worktree, branch: "session/archive-enoent" }],
				commandRunner: cleanupRunner(),
			});
			managers.push(manager);
			const removals: string[][] = [];
			manager.addWorktreeRemovedListener((_sessionId, info) => { removals.push([...info.worktreePaths]); });
			assert.equal(await manager.purgeArchivedSession("archive-enoent"), true);
			assert.deepEqual(removals, [[worktree]]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("keeps EACCES and EIO purge paths unconfirmed across single and multi-repo cleanup", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-purge-unconfirmed-"));
		try {
			const repo = path.join(tmp, "repo");
			const single = path.join(tmp, "repo-wt", "single");
			const api = path.join(tmp, "repo-wt", "multi", "api");
			const web = path.join(tmp, "repo-wt", "multi", "web");
			fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
			fs.mkdirSync(single, { recursive: true });
			fs.mkdirSync(api, { recursive: true });
			fs.mkdirSync(web, { recursive: true });
			const { manager } = makeManager({
				records: [
					{ ...archivedSession("archive-eacces", 20 * DAY_MS), repoPath: repo, worktreePath: single, cwd: single, branch: "session/archive-eacces" },
					{ ...archivedSession("archive-eio", 20 * DAY_MS), repoPath: repo, worktreePath: path.dirname(api), branch: "session/archive-eio", repoWorktrees: { api, web } },
				],
				commandRunner: cleanupRunner(),
			});
			managers.push(manager);
			const nativeLstat = fs.promises.lstat.bind(fs.promises);
			vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: fs.PathLike) => {
				if (String(target) === single) throw fileError("EACCES");
				if (String(target) === api) throw fileError("EIO");
				return await nativeLstat(target);
			}) as typeof fs.promises.lstat);
			const removals: string[][] = [];
			manager.addWorktreeRemovedListener((_sessionId, info) => { removals.push([...info.worktreePaths]); });
			assert.equal(await manager.purgeArchivedSession("archive-eacces"), true);
			assert.equal(await manager.purgeArchivedSession("archive-eio"), true);
			assert.deepEqual(removals, [[web]], "only the component with a definitive ENOENT probe may notify removal");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("keeps archived cleanup unconfirmed when both lstat and Git worktree listing fail", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-cleanup-unconfirmed-"));
		try {
			const repo = path.join(tmp, "repo");
			const worktree = path.join(tmp, "repo-wt", "archive");
			const branch = "session/archive-maintenance";
			fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
			fs.mkdirSync(worktree, { recursive: true });
			let listCalls = 0;
			const runner = cleanupRunner(() => {
				listCalls++;
				if (listCalls === 1) return { stdout: `worktree ${repo}\nbranch refs/heads/main\n\nworktree ${worktree}\nbranch refs/heads/${branch}\n`, stderr: "" };
				throw new Error("git worktree list failed");
			});
			const { manager, records } = makeManager({
				records: [{ ...archivedSession("archive-maintenance", 20 * DAY_MS), repoPath: repo, worktreePath: worktree, cwd: worktree, branch }],
				commandRunner: runner,
			});
			managers.push(manager);
			vi.spyOn(fs.promises, "lstat").mockRejectedValue(fileError("EACCES"));
			const removals: string[][] = [];
			manager.addWorktreeRemovedListener((_sessionId, info) => { removals.push([...info.worktreePaths]); });
			const result = await manager.cleanupArchivedSessionWorktrees({ mode: "all" });
			assert.equal(result.counts.cleaned, 0);
			assert.equal(result.counts.failed, 1);
			assert.deepEqual(removals, []);
			assert.equal(records.has("archive-maintenance"), true, "unconfirmed cleanup must leave archived data available for retry");
			assert.equal(listCalls, 2, "post-cleanup verification must observe the Git listing failure");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("awaits termination listeners and isolates a rejected purge listener", async () => {
		const now = 20 * DAY_MS;
		const listenerRelease = heldDeferred();
		const listenerStarted = deferred<void>();
		const order: string[] = [];
		const { manager } = makeManager({ records: [archivedSession("archive-listener", now)] });
		managers.push(manager);
		manager.addTerminationListener(async (_id, info) => {
			assert.equal(info.reason, "purged");
			order.push("first-start");
			listenerStarted.resolve();
			await listenerRelease.promise;
			order.push("first-end");
		});
		manager.addTerminationListener(async () => {
			order.push("second");
			throw new Error("expected listener failure");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

		let settled = false;
		let purgeResult: boolean | undefined;
		const purge = manager.purgeArchivedSession("archive-listener").then(value => { settled = true; return value; });
		try {
			await listenerStarted.promise;
			const unrelatedWork = deferred<void>();
			setImmediate(() => unrelatedWork.resolve());
			await unrelatedWork.promise;
			assert.equal(settled, false, "purge completion must await its async listener contract");

			listenerRelease.resolve();
			purgeResult = await purge;
		} finally {
			listenerRelease.resolve();
			await purge.catch(() => undefined);
		}
		assert.equal(purgeResult, true);
		assert.deepEqual(order, ["first-start", "first-end", "second"]);
		assert.ok(errors.mock.calls.some(args => String(args[0]).includes("purge listener failed")));
	});
});
