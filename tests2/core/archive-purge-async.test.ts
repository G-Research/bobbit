import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { BACKGROUND_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	throw new Error(`timed out waiting for ${label}`);
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
	vi.restoreAllMocks();
	await Promise.all(managers.splice(0).map(manager => manager.stopPurgeSchedule()));
});

describe("asynchronous archive purge lifecycle", () => {
	it("bounds deferred archive stats and lets unrelated event-loop work progress", async () => {
		const now = 20 * DAY_MS;
		const count = BACKGROUND_IO_CONCURRENCY * 2 + 1;
		const records = Array.from({ length: count }, (_, index) =>
			archivedSession(`archive-${index}`, now, `/transcripts/${index}.jsonl`));
		const release = deferred<void>();
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
				await release.promise;
				active--;
				return { size: Number(/(\d+)\.jsonl$/.exec(filePath)?.[1] ?? 0) + 1 };
			},
		});
		managers.push(manager);

		let settled = false;
		const statsPromise = manager.getExpiredArchiveStats().then(value => { settled = true; return value; });
		let unrelatedWorkRan = false;
		setImmediate(() => { unrelatedWorkRan = true; });
		await waitFor(() => calls === BACKGROUND_IO_CONCURRENCY && unrelatedWorkRan, "bounded archive stat workers");

		assert.equal(settled, false);
		assert.equal(active, BACKGROUND_IO_CONCURRENCY);
		assert.equal(maxActive, BACKGROUND_IO_CONCURRENCY);
		assert.equal(calls, BACKGROUND_IO_CONCURRENCY, "no work above the shared ceiling starts while every worker is held");

		release.resolve();
		const stats = await statsPromise;
		assert.deepEqual(stats, {
			count,
			totalSizeBytes: count * (count + 1) / 2,
		});
		assert.equal(calls, count);
		assert.ok(maxActive <= BACKGROUND_IO_CONCURRENCY);
	});

	it("coalesces scheduled purge ticks and stopPurgeSchedule joins the active run", async () => {
		const now = 20 * DAY_MS;
		const releasePurge = deferred<void>();
		let purgeCalls = 0;
		const { manager, clock } = makeManager({
			records: [archivedSession("archive-held", now)],
			clock: createManualClock(now),
			purgeAsync: async () => {
				purgeCalls++;
				await releasePurge.promise;
			},
		});
		managers.push(manager);
		manager.startPurgeSchedule();

		clock.advance(DAY_MS);
		await waitFor(() => purgeCalls === 1, "first scheduled purge");
		clock.advance(DAY_MS);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(purgeCalls, 1, "a second timer tick must join, not overlap, the active purge");

		let stopSettled = false;
		const stop = manager.stopPurgeSchedule().then(() => { stopSettled = true; });
		let unrelatedWorkRan = false;
		setImmediate(() => { unrelatedWorkRan = true; });
		await waitFor(() => unrelatedWorkRan, "event-loop work during purge stop barrier");
		assert.equal(stopSettled, false, "stop must await the in-flight purge");
		assert.equal(clock.pending(), 0, "stop must cancel the future interval before joining");

		releasePurge.resolve();
		await stop;
		clock.advance(2 * DAY_MS);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(purgeCalls, 1, "no stale timer callback may start cleanup after stop");
	});

	it("awaits termination listeners and isolates a rejected purge listener", async () => {
		const now = 20 * DAY_MS;
		const listenerRelease = deferred<void>();
		const order: string[] = [];
		const { manager } = makeManager({ records: [archivedSession("archive-listener", now)] });
		managers.push(manager);
		manager.addTerminationListener(async (_id, info) => {
			assert.equal(info.reason, "purged");
			order.push("first-start");
			await listenerRelease.promise;
			order.push("first-end");
		});
		manager.addTerminationListener(async () => {
			order.push("second");
			throw new Error("expected listener failure");
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

		let settled = false;
		const purge = manager.purgeArchivedSession("archive-listener").then(value => { settled = true; return value; });
		await waitFor(() => order.includes("first-start"), "first purge listener");
		let unrelatedWorkRan = false;
		setImmediate(() => { unrelatedWorkRan = true; });
		await waitFor(() => unrelatedWorkRan, "event-loop work during listener barrier");
		assert.equal(settled, false, "purge completion must await its async listener contract");

		listenerRelease.resolve();
		assert.equal(await purge, true);
		assert.deepEqual(order, ["first-start", "first-end", "second"]);
		assert.ok(errors.mock.calls.some(args => String(args[0]).includes("purge listener failed")));
	});
});
