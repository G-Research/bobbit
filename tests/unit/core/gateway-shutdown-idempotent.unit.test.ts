import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

import {
	createGatewayShutdownOnce,
	stopWorktreePoolsForShutdown,
} from "../../../src/server/server.ts";
import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import type { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";

describe("gateway shutdown is idempotent", () => {
	it("shares one production teardown across concurrent and late callers", async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		let runs = 0;
		const once = createGatewayShutdownOnce();
		const shutdown = () => once(async () => {
			runs++;
			await blocked;
		});

		const first = shutdown();
		const second = shutdown();
		assert.strictEqual(second, first, "concurrent callers must receive the same promise");
		assert.equal(runs, 1);
		release();
		await Promise.all([first, second]);

		const late = shutdown();
		assert.strictEqual(late, first, "late callers must receive the completed promise");
		await late;
		assert.equal(runs, 1);
	});

	it("memoizes a teardown failure instead of retrying it", async () => {
		const expected = new Error("teardown failed");
		let runs = 0;
		const once = createGatewayShutdownOnce();
		const shutdown = () => once(async () => { runs++; throw expected; });

		const results = await Promise.allSettled([shutdown(), shutdown()]);
		assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
		assert.ok(results.every(result => result.status === "rejected" && result.reason === expected));
		await assert.rejects(shutdown(), error => error === expected);
		assert.equal(runs, 1);
	});
});

describe("graceful worktree-pool shutdown", () => {
	it("stops every pool, flushes ownership, and never drains retained entries", async () => {
		const events: string[] = [];
		const pool = (id: string) => ({
			async stop() { events.push(`stop:${id}`); },
			async drain() { events.push(`drain:${id}`); },
		});
		const pools = new Map([
			["alpha", pool("alpha")],
			["beta", pool("beta")],
		]);
		const recordStore = { async flush() { events.push("flush"); } };

		await stopWorktreePoolsForShutdown(pools, recordStore, 1_000);

		assert.deepEqual(new Set(events.slice(0, 2)), new Set(["stop:alpha", "stop:beta"]));
		assert.equal(events[2], "flush", "the record is flushed after stop barriers settle");
		assert.ok(!events.some(event => event.startsWith("drain:")), "graceful shutdown retains ready entries");
	});

	it("still flushes when one pool cannot stop", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let flushed = 0;
		try {
			await stopWorktreePoolsForShutdown(new Map([
				["broken", {
					async stop() { throw new Error("stop failed"); },
				}],
			]), { async flush() { flushed++; } }, 1_000);
		} finally {
			warn.mockRestore();
		}
		assert.equal(flushed, 1);
	});

	it("drains and forgets ownership on explicit project deletion", async () => {
		const events: string[] = [];
		const pool = { async drain() { events.push("drain"); } } as WorktreePool;
		const manager = Object.create(SessionManager.prototype) as SessionManager;
		Object.assign(manager as unknown as Record<string, unknown>, {
			worktreePools: new Map([["project-1", pool]]),
			worktreePoolRecords: {
				forget(projectId: string) { events.push(`forget:${projectId}`); },
			},
		});

		await manager.removeWorktreePool("project-1");

		assert.deepEqual(events, ["drain", "forget:project-1"]);
		assert.equal(manager.getWorktreePool("project-1"), null);
	});
});
