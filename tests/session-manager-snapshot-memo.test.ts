/**
 * PERF-06 — SessionManager.getMessagesSnapshotBase() memoization.
 *
 * Caches the expensive part of a `get_messages` snapshot (the agent-process
 * RPC round-trip + hydrate + normalize) per session, keyed by
 * `session.eventBuffer.lastSeq`. See the doc comment on
 * `getMessagesSnapshotBase` in session-manager.ts for the full invalidation
 * argument: every event that can change what `rpcClient.getMessages()`
 * returns is pushed through `emitSessionEvent` (which always bumps
 * `eventBuffer.lastSeq`) before it reaches the gateway, so a same-seq cache
 * hit is guaranteed byte-identical to a fresh fetch.
 *
 * These tests pin the three PERF-06 quality-bar invariants:
 *   1. byte-identity: a memo hit returns the exact same data a fresh fetch
 *      would, and does not re-invoke the RPC.
 *   2. invalidation: bumping `eventBuffer.lastSeq` (a new event) forces a
 *      fresh fetch on the next call.
 *   3. concurrency: two concurrent requests at the same seq share one
 *      in-flight RPC round-trip (no duplicate `getMessages()` calls for N
 *      simultaneous tabs).
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("session-manager-snapshot-memo-");
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");

const managers: any[] = [];

function makeManager(): any {
	const manager = new SessionManager();
	managers.push(manager);
	return manager;
}

/**
 * Bare session stub: no store/project context is registered, so
 * `hydrateClaudeCodeSnapshotMessages` short-circuits (no persisted
 * transcript file to fall back to) and returns the live RPC data unchanged
 * — isolating these tests to the memoization behavior itself.
 */
function makeSession(id: string, getMessages: (...args: any[]) => Promise<any>): any {
	return {
		id,
		eventBuffer: new EventBuffer(),
		rpcClient: { getMessages: mock.fn(getMessages) },
	};
}

afterEach(() => {
	managers.length = 0;
});

describe("SessionManager.getMessagesSnapshotBase (PERF-06 snapshot memo)", () => {
	it("byte-identity: a same-seq cache hit returns the same data as a fresh fetch, without a second RPC call", async () => {
		const manager = makeManager();
		const getMessages = mock.fn(async () => ({ success: true, data: { messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] }] } }));
		const session = makeSession("s1", getMessages);

		const first = await manager.getMessagesSnapshotBase(session);
		const second = await manager.getMessagesSnapshotBase(session);

		assert.equal(getMessages.mock.callCount(), 1, "second call at the same seq must reuse the cached RPC result");
		assert.equal(JSON.stringify(second), JSON.stringify(first), "memo hit must be byte-identical to the original fetch");
		assert.deepEqual(second.data.messages, [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] }]);
	});

	it("invalidation: a new event (seq bump) forces a fresh fetch that reflects the change", async () => {
		const manager = makeManager();
		let call = 0;
		const getMessages = mock.fn(async () => {
			call++;
			return {
				success: true,
				data: { messages: [{ id: `m${call}`, role: "assistant", content: [{ type: "text", text: `reply ${call}` }] }] },
			};
		});
		const session = makeSession("s2", getMessages);

		const before = await manager.getMessagesSnapshotBase(session);
		assert.equal(before.data.messages[0].text ?? before.data.messages[0].content[0].text, "reply 1");

		// Same seq, no new event yet — must still be cached (proves the
		// invalidation is precise, not time- or call-based).
		const stillCached = await manager.getMessagesSnapshotBase(session);
		assert.equal(getMessages.mock.callCount(), 1);
		assert.equal(JSON.stringify(stillCached), JSON.stringify(before));

		// A live event bumps eventBuffer.lastSeq — this is exactly what
		// `emitSessionEvent` does for every agent event (message_end,
		// tool_execution_start, compaction_end, ...).
		session.eventBuffer.push({ type: "message_end", message: { id: "m2" } });

		const after = await manager.getMessagesSnapshotBase(session);
		assert.equal(getMessages.mock.callCount(), 2, "a seq bump must trigger a fresh RPC call");
		assert.equal(after.data.messages[0].content[0].text, "reply 2");
		assert.notEqual(JSON.stringify(after), JSON.stringify(before), "post-invalidation snapshot must reflect the new data");
	});

	it("concurrency: two concurrent requests at the same seq share one in-flight RPC round-trip", async () => {
		const manager = makeManager();
		let inFlight = 0;
		let maxConcurrent = 0;
		let resolveRpc!: (v: any) => void;
		const rpcPromise = new Promise((resolve) => { resolveRpc = resolve; });
		const getMessages = mock.fn(async () => {
			inFlight++;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			const result = await rpcPromise;
			inFlight--;
			return result;
		});
		const session = makeSession("s3", getMessages);

		const p1 = manager.getMessagesSnapshotBase(session);
		const p2 = manager.getMessagesSnapshotBase(session);

		// Let both callers reach the (still-pending) RPC call before resolving it.
		await new Promise((r) => setImmediate(r));
		resolveRpc({ success: true, data: { messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "concurrent" }] }] } });

		const [r1, r2] = await Promise.all([p1, p2]);

		assert.equal(getMessages.mock.callCount(), 1, "concurrent callers at the same seq must not trigger duplicate RPC round-trips");
		assert.equal(maxConcurrent, 1, "only one RPC call should ever be in flight for the same seq");
		assert.equal(JSON.stringify(r1), JSON.stringify(r2), "concurrent callers must observe the same resolved snapshot");
	});

	it("a failed fetch is not cached — the next call at the same seq retries", async () => {
		const manager = makeManager();
		let call = 0;
		const getMessages = mock.fn(async () => {
			call++;
			if (call === 1) return { success: false, error: "transient RPC timeout" };
			return { success: true, data: { messages: [] } };
		});
		const session = makeSession("s4", getMessages);

		const first = await manager.getMessagesSnapshotBase(session);
		assert.equal(first.success, false);

		const second = await manager.getMessagesSnapshotBase(session);
		assert.equal(second.success, true, "a failed fetch must not poison the cache for the next attempt at the same seq");
		assert.equal(getMessages.mock.callCount(), 2);
	});
});
