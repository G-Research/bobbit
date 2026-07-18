import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { applyLiveSnapshotTransforms } from "../../src/server/ws/handler.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function manager(): any {
	return Object.create(SessionManager.prototype);
}

function session(getMessages: () => Promise<any>): any {
	return {
		id: `snapshot-${Math.random().toString(16).slice(2)}`,
		eventBuffer: new EventBuffer(),
		rpcClient: { getMessages },
	};
}

describe("SessionManager snapshot memo", () => {
	it("coalesces concurrent callers and reuses a byte-identical normalized base at one sequence", async () => {
		const pending = deferred<any>();
		const getMessages = vi.fn(() => pending.promise);
		const value = manager();
		const live = session(getMessages);

		const first = value.getMessagesSnapshotBase(live);
		const second = value.getMessagesSnapshotBase(live);
		assert.equal(getMessages.mock.calls.length, 1);

		pending.resolve({ success: true, data: [{ role: "toolResult", is_error: true, content: "failed" }] });
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a, b, "same-sequence callers share the installed promise result");
		assert.equal(JSON.stringify(a), JSON.stringify(await value.getMessagesSnapshotBase(live)));
		assert.equal((a.data as any[])[0].isError, true);
		assert.equal(getMessages.mock.calls.length, 1);
	});

	it("invalidates precisely on event sequence changes", async () => {
		const getMessages = vi.fn(async () => ({ success: true, data: [{ call: getMessages.mock.calls.length }] }));
		const value = manager();
		const live = session(getMessages);

		await value.getMessagesSnapshotBase(live);
		await value.getMessagesSnapshotBase(live);
		assert.equal(getMessages.mock.calls.length, 1);
		live.eventBuffer.push({ type: "message_end" });
		await value.getMessagesSnapshotBase(live);
		assert.equal(getMessages.mock.calls.length, 2);
	});

	it("does not cache unsuccessful responses or rejected RPCs", async () => {
		const getMessages = vi.fn()
			.mockResolvedValueOnce({ success: false, error: "temporary" })
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce({ success: true, data: [] });
		const value = manager();
		const live = session(getMessages);

		assert.equal((await value.getMessagesSnapshotBase(live)).success, false);
		await assert.rejects(value.getMessagesSnapshotBase(live), /timeout/);
		assert.equal((await value.getMessagesSnapshotBase(live)).success, true);
		assert.equal(getMessages.mock.calls.length, 3);
	});

	it("an old failure cannot clear a newer-sequence cache slot", async () => {
		const old = deferred<any>();
		const newer = deferred<any>();
		const getMessages = vi.fn()
			.mockImplementationOnce(() => old.promise)
			.mockImplementationOnce(() => newer.promise);
		const value = manager();
		const live = session(getMessages);

		const oldRequest = value.getMessagesSnapshotBase(live);
		live.eventBuffer.push({ type: "message_end" });
		const newRequest = value.getMessagesSnapshotBase(live);
		old.reject(new Error("old failed"));
		await assert.rejects(oldRequest, /old failed/);
		newer.resolve({ success: true, data: [{ id: "new" }] });
		const current = await newRequest;
		assert.equal(await value.getMessagesSnapshotBase(live), current);
		assert.equal(getMessages.mock.calls.length, 2);
	});

	it("keeps cached bases immutable while overlays and both sidecar transforms are recomputed fresh", async () => {
		const baseMessage = { id: "base", role: "assistant", content: "base" };
		const getMessages = vi.fn(async () => ({ success: true, data: [baseMessage] }));
		const value = manager();
		const live = session(getMessages);
		const cached = await value.getMessagesSnapshotBase(live);
		let compactionMessages: any[] = [];
		let skillMessages: any[] = [];
		const mergeCompactionSidecar = vi.fn((_sessionId: string, messages: any[]) => [...messages, ...compactionMessages]);
		const mergeSkillSidecar = vi.fn((_sessionId: string, messages: any[]) => [...messages, ...skillMessages]);
		const collaborators = { mergeCompactionSidecar, mergeSkillSidecar };

		const first = applyLiveSnapshotTransforms(live.id, live, cached.data, collaborators);
		assert.equal(first.length, 1);
		assert.deepEqual(baseMessage, { id: "base", role: "assistant", content: "base" });

		live.latestMessageUpdate = {
			id: "streaming",
			message: { id: "streaming", role: "assistant", content: "fresh overlay" },
		};
		compactionMessages = [{ id: "compaction-fresh", role: "tool", content: "compaction" }];
		skillMessages = [{ id: "skill-fresh", role: "tool", content: "skill" }];
		const second = applyLiveSnapshotTransforms(
			live.id,
			live,
			(await value.getMessagesSnapshotBase(live)).data,
			collaborators,
		);

		assert.equal(getMessages.mock.calls.length, 1, "base remains memoized");
		assert.ok(second.some((message: any) => message.id === "streaming"), "live overlay is fresh");
		assert.ok(second.some((message: any) => message.id === "compaction-fresh"), "compaction sidecar is fresh");
		assert.ok(second.some((message: any) => message.id === "skill-fresh"), "skill sidecar is fresh");
		assert.equal(mergeCompactionSidecar.mock.calls.length, 2);
		assert.equal(mergeSkillSidecar.mock.calls.length, 2);
		assert.deepEqual(baseMessage, { id: "base", role: "assistant", content: "base" });
	});
});
