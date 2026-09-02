import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

const poolSpies = vi.hoisted(() => ({
	constructed: vi.fn(),
	initialized: vi.fn(),
}));

vi.mock("../../../src/server/agent/worktree-pool.ts", () => ({
	WorktreePool: class {
		constructor(options: unknown) { poolSpies.constructed(options); }
		initialize(activeWorktreePaths: ReadonlySet<string>) {
			poolSpies.initialized(activeWorktreePaths);
			return Promise.resolve();
		}
	},
}));

import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import type { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";
import type { PoolRecordSink } from "../../../src/server/agent/worktree-pool-record.ts";

const managers: SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
	vi.clearAllMocks();
});

describe("worktree pool deletion fence", () => {
	it("blocks a delayed boot init after deletion before construction or record restoration", async () => {
		const projectId = "deleted-project";
		const events: string[] = [];
		let recordPresent = true;
		const recordStore: PoolRecordSink = {
			replace() {
				recordPresent = true;
				events.push("replace");
			},
			read() {
				return recordPresent
					? { repoPath: "C:/repo", entries: [{ branchName: "pool/_pool-old", worktreePath: "C:/repo-wt/old", createdAt: 1 }] }
					: { entries: [] };
			},
			forget(id) {
				recordPresent = false;
				events.push(`forget:${id}`);
			},
			async flush() { /* in-memory test seam */ },
		};
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
		assert.deepEqual(events, [`forget:${projectId}`]);
		assert.deepEqual(recordStore.read(projectId), { entries: [] });

		releaseStaleBootInit();
		await staleBootInit;
		assert.equal(poolSpies.constructed.mock.calls.length, 0, "the fenced callback must not construct a replacement pool");
		assert.equal(poolSpies.initialized.mock.calls.length, 0, "the fenced callback must not fill a replacement pool");
		assert.equal(commandRunner.execFile.mock.calls.length, 0);
		assert.equal(manager.getWorktreePool(projectId), null);
		assert.deepEqual(recordStore.read(projectId), { entries: [] });
		assert.ok(!events.includes("replace"), "the delayed init must not recreate the durable record");
	});

	it("keeps stale init fenced when drain fails and removal is retried", async () => {
		const projectId = "retry-deleted-project";
		const forget = vi.fn();
		const recordStore: PoolRecordSink = {
			replace: vi.fn(),
			read: () => ({ entries: [] }),
			forget,
			async flush() { /* in-memory test seam */ },
		};
		const manager = new SessionManager({
			commandRunner: { execFile: vi.fn() } as never,
			worktreePoolRecordStore: recordStore,
		});
		managers.push(manager);

		const expected = new Error("drain failed");
		const drain = vi.fn()
			.mockRejectedValueOnce(expected)
			.mockResolvedValueOnce(undefined);
		manager.getAllWorktreePools().set(projectId, { drain } as unknown as WorktreePool);

		await assert.rejects(manager.removeWorktreePool(projectId), error => error === expected);
		await manager.initWorktreePoolForProject(projectId, "C:/repo", undefined, 1);
		assert.equal(poolSpies.constructed.mock.calls.length, 0, "failure must not reopen init for a captured boot callback");
		assert.equal(forget.mock.calls.length, 0, "ownership remains authoritative until drain succeeds");

		await manager.removeWorktreePool(projectId);
		assert.equal(drain.mock.calls.length, 2);
		assert.deepEqual(forget.mock.calls, [[projectId]]);
		assert.equal(manager.getWorktreePool(projectId), null);
	});
});
