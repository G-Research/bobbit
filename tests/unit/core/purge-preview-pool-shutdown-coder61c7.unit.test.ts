import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { BACKGROUND_IO_CONCURRENCY, mapWithConcurrency } from "../../../src/server/agent/bounded-async-work.ts";
import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import {
	createPreviewSessionOperationQueue,
	initializeBootProjectPools,
	shutdownCpuDiagnostics,
} from "../../../src/server/server.ts";
import { createManualClock } from "../../support/harnesses/shared/clock.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function archivedSession(id: string, now: number): any {
	return {
		id,
		title: id,
		cwd: "",
		projectId: "project-purge-serialization",
		archived: true,
		archivedAt: now - 8 * DAY_MS,
		createdAt: now - 9 * DAY_MS,
		lastActivity: now - 8 * DAY_MS,
	};
}

function makeManager(options: {
	record: any;
	additionalRecords?: any[];
	purgeAsync?: (id: string) => Promise<void>;
	previewPurgeOperation?: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
}): { manager: SessionManager; records: Map<string, any> } {
	const now = 20 * DAY_MS;
	const records = new Map(
		[options.record, ...(options.additionalRecords ?? [])].map(record => [record.id, record]),
	);
	const store = {
		get: (id: string) => records.get(id),
		getAll: () => [...records.values()],
		getLive: () => [...records.values()].filter(record => !record.archived),
		getArchived: () => [...records.values()].filter(record => record.archived),
		purgeAsync: async (id: string) => {
			await options.purgeAsync?.(id);
			records.delete(id);
		},
		flush: () => undefined,
	};
	const context = {
		project: { id: "project-purge-serialization", name: "Purge serialization" },
		sessionStore: store,
		costTracker: { flush: () => undefined },
		searchIndex: {
			removeMessagesForSession: () => undefined,
			removeSession: () => undefined,
		},
	};
	const clock = createManualClock(now);
	const manager = new SessionManager({
		clock,
		projectContextManager: {
			all: () => [context],
			getOrCreate: () => context,
			getAllSessions: () => [...records.values()],
			getAllLiveSessions: () => [...records.values()].filter(record => !record.archived),
		} as any,
		previewPurgeOperation: options.previewPurgeOperation,
	});
	const internal = manager as any;
	if (internal._statusHeartbeatTimer) {
		clock.clearInterval(internal._statusHeartbeatTimer);
		internal._statusHeartbeatTimer = null;
	}
	return { manager, records };
}

describe("purge, preview, pool, and diagnostics lifecycle regressions", () => {
	it("coalesces overlapping immediate and expiry purges through one destructive owner", async () => {
		const now = 20 * DAY_MS;
		const releaseStorePurge = deferred<void>();
		const storePurgeStarted = deferred<void>();
		const releaseListener = deferred<void>();
		const listenerStarted = deferred<void>();
		let storePurges = 0;
		let listenerCalls = 0;
		const { manager, records } = makeManager({
			record: archivedSession("11111111-1111-4111-8111-111111111111", now),
			purgeAsync: async () => {
				storePurges++;
				storePurgeStarted.resolve();
				await releaseStorePurge.promise;
			},
		});
		const latePurgeSettlementOrder: string[] = [];
		manager.addTerminationListener(async () => {
			listenerCalls++;
			listenerStarted.resolve();
			await releaseListener.promise;
			latePurgeSettlementOrder.push("listener-complete");
		});

		const firstImmediate = manager.purgeArchivedSession("11111111-1111-4111-8111-111111111111");
		await storePurgeStarted.promise;
		const secondImmediate = manager.purgeArchivedSession("11111111-1111-4111-8111-111111111111");
		const expirySweep = manager.purgeExpiredArchives();

		assert.equal(storePurges, 1, "all overlapping entry points must join the same session purge");
		assert.equal(listenerCalls, 0, "listeners remain behind durable store cleanup");
		releaseStorePurge.resolve();
		await listenerStarted.promise;
		assert.equal(records.has("11111111-1111-4111-8111-111111111111"), false);

		const lateImmediate = manager.purgeArchivedSession("11111111-1111-4111-8111-111111111111")
			.then((value) => {
				latePurgeSettlementOrder.push("late-immediate-settled");
				return value;
			});

		releaseListener.resolve();
		assert.deepEqual(await Promise.all([firstImmediate, secondImmediate, lateImmediate]), [true, true, true]);
		assert.deepEqual(latePurgeSettlementOrder, ["listener-complete", "late-immediate-settled"],
			"an overlap after store removal must still join listeners");
		await expirySweep;
		assert.equal(storePurges, 1);
		assert.equal(listenerCalls, 1, "destructive listeners run exactly once");
		await manager.shutdown();
	});

	it("does not rerun a completed immediate purge from a stale expiry-sweep snapshot", async () => {
		const now = 20 * DAY_MS;
		const earlierRelease = deferred<void>();
		const earlierPurgeStarted = deferred<void>();
		const earlierId = "33333333-3333-4333-8333-333333333333";
		const targetId = "44444444-4444-4444-8444-444444444444";
		const purgeCounts = new Map<string, number>();
		const { manager } = makeManager({
			record: archivedSession(earlierId, now),
			additionalRecords: [archivedSession(targetId, now)],
			purgeAsync: async (id) => {
				purgeCounts.set(id, (purgeCounts.get(id) ?? 0) + 1);
				if (id === earlierId) {
					earlierPurgeStarted.resolve();
					await earlierRelease.promise;
				}
			},
		});

		const sweep = manager.purgeExpiredArchives();
		await earlierPurgeStarted.promise;
		assert.equal(await manager.purgeArchivedSession(targetId), true);
		assert.equal(purgeCounts.get(targetId), 1);

		earlierRelease.resolve();
		await sweep;
		assert.equal(purgeCounts.get(targetId), 1, "the stale sweep row must not start a second purge owner");
		await manager.shutdown();
	});

	it("queues purge mount and artifact cleanup behind active preview work and fences recreation", async () => {
		const now = 20 * DAY_MS;
		const queue = createPreviewSessionOperationQueue();
		const activeRelease = deferred<void>();
		const activeStarted = deferred<void>();
		const purgeQueued = deferred<void>();
		const mountCleanupFinished = deferred<void>();
		const storeRelease = deferred<void>();
		const events: string[] = [];
		const sessionId = "22222222-2222-4222-8222-222222222222";
		const { manager } = makeManager({
			record: archivedSession(sessionId, now),
			purgeAsync: () => storeRelease.promise,
			previewPurgeOperation: (id, operation) => {
				purgeQueued.resolve();
				return queue.purge(id, async () => {
					events.push("mount-cleanup-start");
					const result = await operation();
					events.push("mount-cleanup-end");
					mountCleanupFinished.resolve();
					return result;
				});
			},
		});
		manager.addTerminationListener((id, info) => {
			if (info.reason !== "purged") return;
			return queue.purge(id, async () => { events.push("artifact-cleanup"); });
		});

		const active = queue.run(sessionId, async () => {
			events.push("active-preview-start");
			activeStarted.resolve();
			await activeRelease.promise;
			events.push("active-preview-end");
		});
		await activeStarted.promise;
		const purge = manager.purgeArchivedSession(sessionId);
		await purgeQueued.promise;

		let recreated = false;
		await assert.rejects(
			queue.run(sessionId, async () => { recreated = true; }),
			/preview has been purged/,
		);
		assert.equal(recreated, false, "a queued or later POST-equivalent cannot recreate the mount");
		assert.deepEqual(events, ["active-preview-start"], "purge cleanup waits for active preview work");

		activeRelease.resolve();
		await active;
		await mountCleanupFinished.promise;
		storeRelease.resolve();
		assert.equal(await purge, true);
		assert.deepEqual(events, [
			"active-preview-start",
			"active-preview-end",
			"mount-cleanup-start",
			"mount-cleanup-end",
			"artifact-cleanup",
		]);
		await manager.shutdown();
	});

	it("keeps total reclaim candidate work within one ceiling across many boot projects", async () => {
		const projects = Array.from({ length: BACKGROUND_IO_CONCURRENCY * 3 + 1 }, (_, index) => index);
		const candidates = Array.from({ length: BACKGROUND_IO_CONCURRENCY * 2 }, (_, index) => index);
		const release = deferred<void>();
		const firstCandidateBatchStarted = deferred<void>();
		const projectStartOrder: number[] = [];
		const projectFinishOrder: number[] = [];
		let candidateOperationsStarted = 0;
		let pendingCandidateOperations = 0;
		let maxPendingCandidateOperations = 0;
		const initialization = initializeBootProjectPools(projects, async (project) => {
			projectStartOrder.push(project);
			await mapWithConcurrency(candidates, BACKGROUND_IO_CONCURRENCY, async () => {
				candidateOperationsStarted++;
				pendingCandidateOperations++;
				maxPendingCandidateOperations = Math.max(maxPendingCandidateOperations, pendingCandidateOperations);
				if (candidateOperationsStarted === BACKGROUND_IO_CONCURRENCY) firstCandidateBatchStarted.resolve();
				await release.promise;
				pendingCandidateOperations--;
			});
			projectFinishOrder.push(project);
		});

		await firstCandidateBatchStarted.promise;
		assert.deepEqual(projectStartOrder, [projects[0]], "another project must not multiply candidate concurrency");
		assert.equal(pendingCandidateOperations, BACKGROUND_IO_CONCURRENCY);
		assert.equal(maxPendingCandidateOperations, BACKGROUND_IO_CONCURRENCY);

		release.resolve();
		await initialization;
		assert.deepEqual(projectStartOrder, projects);
		assert.deepEqual(projectFinishOrder, projects);
		assert.equal(candidateOperationsStarted, projects.length * candidates.length);
		assert.ok(maxPendingCandidateOperations <= BACKGROUND_IO_CONCURRENCY);
	});

	it("does not finish gateway CPU diagnostics shutdown before the final write settles", async () => {
		const release = deferred<void>();
		const shutdownStarted = deferred<void>();
		let settled = false;
		const shutdown = shutdownCpuDiagnostics({
			shutdown: () => {
				shutdownStarted.resolve();
				return release.promise;
			},
		}).then(() => { settled = true; });

		await shutdownStarted.promise;
		assert.equal(settled, false);
		release.resolve();
		await shutdown;
		assert.equal(settled, true);
	});
});
