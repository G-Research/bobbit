import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import {
	appendPromptAuthorDispatch,
	initAuthorSidecarDir,
} from "../../src/server/agent/author-sidecar.ts";
import {
	appendCompactionSidecarEntry,
	initCompactionSidecarDir,
} from "../../src/server/agent/compaction-sidecar.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import {
	appendSkillSidecarEntry,
	initSkillSidecarDir,
} from "../../src/server/skills/skill-sidecar.ts";
import { LOCAL_USER_AUTHOR, type MessageAuthor } from "../../src/shared/message-author.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-snapshot-memo-"));

beforeAll(() => {
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x32),
	});
	initCompactionSidecarDir(stateDir);
	initSkillSidecarDir(stateDir);
});

afterAll(() => {
	fs.rmSync(stateDir, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function manager(): any {
	const value = Object.create(SessionManager.prototype);
	value.sessions = new Map();
	value.resolveStoreForId = () => undefined;
	return value;
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

	it("keeps cached bases immutable while the production snapshot chokepoint rebuilds fresh structured overlays", async () => {
		const baseMessage = {
			id: "base",
			role: "user",
			content: "expanded system prompt",
			timestamp: 1_000,
		};
		const getMessages = vi.fn(async () => ({ success: true, data: [baseMessage] }));
		const value = manager();
		const live = { ...session(getMessages), title: "Snapshot Agent" };
		value.sessions.set(live.id, live);
		const cached = await value.getMessagesSnapshotBase(live);

		const first = value.buildVisibleMessageSnapshot(live.id, cached.data) as any[];
		assert.equal(first.length, 1);
		assert.deepEqual(first[0].author, LOCAL_USER_AUTHOR);
		assert.deepEqual(baseMessage, {
			id: "base",
			role: "user",
			content: "expanded system prompt",
			timestamp: 1_000,
		});

		const systemAuthor: MessageAuthor = {
			kind: "system",
			id: "system:bobbit:test",
			label: "Bobbit Test",
		};
		const agentAuthor: MessageAuthor = {
			kind: "agent",
			id: `session:${live.id}`,
			label: "Snapshot Agent",
		};
		assert.equal(appendPromptAuthorDispatch(live.id, {
			promptId: "system-base",
			dispatchedAt: 1_000,
			modelText: "expanded system prompt",
			source: "system",
			author: systemAuthor,
		}), true);
		assert.equal(appendSkillSidecarEntry(live.id, {
			ts: 1_000,
			modelText: "expanded system prompt",
			originalText: "/remind",
			skillExpansions: [],
		}), true);
		assert.equal(appendCompactionSidecarEntry(live.id, {
			schemaVersion: 1,
			id: "compaction-fresh",
			trigger: "manual",
			tokensBefore: 100,
			tokensAfter: 50,
			durationMs: 1,
			startedAt: new Date(900).toISOString(),
			endedAt: new Date(901).toISOString(),
			success: true,
			firstKeptEntryId: "base",
		}), true);
		live.latestMessageUpdate = {
			id: "streaming",
			message: {
				id: "streaming",
				role: "assistant",
				content: "fresh overlay",
				author: agentAuthor,
			},
		};
		live.inFlightSteerTexts = [{
			text: "fresh structured steer",
			promptId: "structured-steer",
			source: "system",
			author: systemAuthor,
		}];

		const cacheHit = await value.getMessagesSnapshotBase(live);
		const second = value.buildVisibleMessageSnapshot(live.id, cacheHit.data) as any[];

		assert.equal(getMessages.mock.calls.length, 1, "base remains memoized");
		assert.equal(cacheHit, cached, "production transforms do not replace the memoized RPC response");
		const restoredBase = second.find((message) => message.id === "base");
		assert.equal(restoredBase?.content, "/remind");
		assert.deepEqual(
			restoredBase?.author,
			systemAuthor,
			"author correlation runs against model text before the fresh skill overlay",
		);
		assert.deepEqual(
			second.find((message) => message.id === "streaming")?.author,
			agentAuthor,
			"in-flight assistant overlay is fresh",
		);
		assert.deepEqual(
			second.find((message) => message.id === "inflight-steer:structured-steer")?.author,
			systemAuthor,
			"structured steer author is preserved",
		);
		assert.ok(second.some((message) => message.id === "compaction-fresh"), "compaction sidecar is fresh");
		assert.ok(second.every((message, index) =>
			!message || typeof message !== "object"
				|| message._order === EventBuffer.SNAPSHOT_ORDER_FLOOR + index,
		), "production chokepoint stamps snapshot order");
		assert.deepEqual(baseMessage, {
			id: "base",
			role: "user",
			content: "expanded system prompt",
			timestamp: 1_000,
		});
	});
});
