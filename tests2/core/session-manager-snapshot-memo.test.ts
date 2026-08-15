import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
} from "../../src/server/agent/author-sidecar.ts";
import {
	appendCompactionSidecarEntry,
	initCompactionSidecarDir,
} from "../../src/server/agent/compaction-sidecar.ts";
import {
	SessionManager,
	preparePromptAuthorDispatch,
	prepareVisibleAgentEvent,
} from "../../src/server/agent/session-manager.ts";
import { correlateTranscriptPromptEntryIds } from "../../src/server/agent/visible-message-snapshot.ts";
import {
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarEntry,
	initSkillSidecarDir,
	readSkillSidecarEntries,
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

function session(
	getMessages: () => Promise<any>,
	getTranscriptCursorSnapshot?: () => Promise<any>,
): any {
	return {
		id: `snapshot-${Math.random().toString(16).slice(2)}`,
		title: "Snapshot session",
		cwd: stateDir,
		status: "idle",
		clients: new Set(),
		eventBuffer: new EventBuffer(),
		rpcClient: { getMessages, getTranscriptCursorSnapshot },
	};
}

function userEntry(id: string, parentId: string | null, text: string): any {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantEntry(id: string, parentId: string | null, text = "answer"): any {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

describe("authoritative transcript cursor correlation", () => {
	it("never trusts a cursor claimed by an id-less Pi agent event", () => {
		const live = session(async () => ({ success: true, data: [] }));
		const prepared = prepareVisibleAgentEvent(live, {
			type: "message_end",
			entryId: "untrusted-event-entry",
			message: {
				role: "user",
				content: "prompt",
				entryId: "untrusted-message-entry",
				_entryIdSource: "pi-transcript",
			},
		}) as any;
		expect(prepared.message.entryId).toBe("untrusted-message-entry");
		expect(prepared.message).not.toHaveProperty("_entryIdSource");
	});

	it("uses the active compaction-aware branch and preserves duplicate occurrences", () => {
		const entries = [
			userEntry("user-old", null, "duplicate"),
			assistantEntry("assistant-old", "user-old"),
			userEntry("user-kept", "assistant-old", "duplicate"),
			assistantEntry("assistant-kept", "user-kept"),
			{
				id: "compaction",
				parentId: "assistant-kept",
				type: "compaction",
				firstKeptEntryId: "user-kept",
			},
			userEntry("user-tail", "compaction", "duplicate"),
			assistantEntry("active-leaf", "user-tail"),
			userEntry("inactive-user", "assistant-old", "duplicate"),
			assistantEntry("inactive-leaf", "inactive-user"),
		];
		const messages = [
			{ role: "compactionSummary", content: "summary" },
			{ role: "user", content: "duplicate" },
			{ role: "assistant", content: "kept answer" },
			{ role: "user", content: "duplicate" },
			{ role: "assistant", content: "tail answer" },
		];
		const forkMessages = ["user-old", "user-kept", "user-tail", "inactive-user"]
			.map((entryId) => ({ entryId, text: "duplicate" }));

		expect(correlateTranscriptPromptEntryIds(messages, {
			entries,
			leafId: "active-leaf",
			forkMessages,
		})).toEqual([undefined, "user-kept", undefined, "user-tail", undefined]);
	});

	it("leaves only a proven streaming tail unstamped and fails closed on incoherent data", () => {
		const entries = [
			userEntry("first", null, "same"),
			assistantEntry("middle", "first"),
			userEntry("second", "middle", "same"),
			assistantEntry("leaf", "second"),
		];
		const cursor = {
			entries,
			leafId: "leaf",
			forkMessages: [
				{ entryId: "first", text: "same" },
				{ entryId: "second", text: "same" },
			],
		};
		const withTail = [
			{ role: "user", content: "same" },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "same" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "same" },
		];
		expect(correlateTranscriptPromptEntryIds(withTail, cursor, { allowUnpersistedTail: true }))
			.toEqual(["first", undefined, "second", undefined, undefined]);
		expect(correlateTranscriptPromptEntryIds(withTail, cursor)).toBeUndefined();
		expect(correlateTranscriptPromptEntryIds(withTail.slice(0, 4), {
			...cursor,
			forkMessages: [{ entryId: "first", text: "wrong" }],
		})).toBeUndefined();
	});
});

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

	it("coalesces the cursor plane with get_messages and stamps only correlated rows", async () => {
		const messages = [
			{ role: "user", content: "duplicate" },
			{ role: "assistant", content: "one" },
			{ role: "user", content: "duplicate" },
			{ role: "assistant", content: "two" },
		];
		const entries = [
			userEntry("cursor-one", null, "duplicate"),
			assistantEntry("answer-one", "cursor-one", "one"),
			userEntry("cursor-two", "answer-one", "duplicate"),
			assistantEntry("answer-two", "cursor-two", "two"),
		];
		const getMessages = vi.fn(async () => ({ success: true, data: { messages } }));
		const getCursors = vi.fn(async () => ({
			success: true,
			data: {
				entries,
				leafId: "answer-two",
				forkMessages: [
					{ entryId: "cursor-one", text: "duplicate" },
					{ entryId: "cursor-two", text: "duplicate" },
				],
			},
		}));
		const value = manager();
		const live = session(getMessages, getCursors);
		value.sessions.set(live.id, live);

		const [first, second] = await Promise.all([
			value.getMessagesSnapshotBase(live),
			value.getMessagesSnapshotBase(live),
		]);
		expect(first).toBe(second);
		expect(getMessages).toHaveBeenCalledOnce();
		expect(getCursors).toHaveBeenCalledOnce();
		const visible = value.buildVisibleMessageSnapshot(live.id, first.data) as { messages: any[] };
		expect(visible.messages[0]).toMatchObject({
			entryId: "cursor-one",
			_entryIdSource: "pi-transcript",
		});
		expect(visible.messages[2]).toMatchObject({
			entryId: "cursor-two",
			_entryIdSource: "pi-transcript",
		});
		expect(messages[0]).not.toHaveProperty("_entryIdSource");
	});

	it("binds a settled skill record to its aligned authoritative Pi cursor without a connected client", async () => {
		const messages = [
			{ id: "inner-user", role: "user", content: "expanded prompt" },
			{ id: "inner-answer", role: "assistant", content: "answer" },
		];
		const entries = [
			userEntry("pi-user", null, "expanded prompt"),
			assistantEntry("pi-answer", "pi-user"),
		];
		const getMessages = vi.fn(async () => ({ success: true, data: messages }));
		const getCursors = vi.fn(async () => ({ success: true, data: {
			entries,
			leafId: "pi-answer",
			forkMessages: [{ entryId: "pi-user", text: "expanded prompt" }],
		} }));
		const value = manager();
		const live = session(getMessages, getCursors);
		value.sessions.set(live.id, live);
		const recordId = appendIdentifiedSkillSidecarEntry(live.id, {
			ts: 1,
			modelText: "expanded prompt",
			originalText: "/fixture",
			skillExpansions: [],
		});
		assert.ok(recordId);
		live.pendingSkillExpansions = [{
			recordId,
			modelText: "expanded prompt",
			originalText: "/fixture",
			skillExpansions: [],
		}];
		preparePromptAuthorDispatch(live, "prompt-skill", "expanded prompt", "user", LOCAL_USER_AUTHOR, 1);
		prepareVisibleAgentEvent(live, {
			type: "message_end",
			message: { id: "inner-user", role: "user", content: "expanded prompt" },
		});
		expect(live.pendingSkillTranscriptBindings).toHaveLength(1);

		value.schedulePromptCursorRefresh(live, { settleBindings: true });
		await vi.waitFor(() => expect(readSkillSidecarEntries(live.id)[0]).toMatchObject({
			recordId,
			transcriptEntryId: "pi-user",
		}));
		expect(live.clients.size).toBe(0);
	});

	it("leaves a timestamp-only skill occurrence unbound when the authoritative snapshot is ambiguous", async () => {
		const messages = [
			{ role: "user", content: "duplicate", timestamp: 7 },
			{ role: "user", content: "duplicate", timestamp: 7 },
		];
		const entries = [
			userEntry("pi-first", null, "duplicate"),
			userEntry("pi-second", "pi-first", "duplicate"),
		];
		const getCursors = vi.fn(async () => ({ success: true, data: {
			entries,
			leafId: "pi-second",
			forkMessages: [
				{ entryId: "pi-first", text: "duplicate" },
				{ entryId: "pi-second", text: "duplicate" },
			],
		} }));
		const value = manager();
		const live = session(async () => ({ success: true, data: messages }), getCursors);
		value.sessions.set(live.id, live);
		const recordId = appendIdentifiedSkillSidecarEntry(live.id, {
			ts: 1, modelText: "duplicate", originalText: "/duplicate", skillExpansions: [],
		});
		assert.ok(recordId);
		live.pendingSkillExpansions = [{
			recordId, modelText: "duplicate", originalText: "/duplicate", skillExpansions: [],
		}];
		preparePromptAuthorDispatch(live, "prompt-ambiguous", "duplicate", "user", LOCAL_USER_AUTHOR, 1);
		prepareVisibleAgentEvent(live, {
			type: "message_end",
			message: { role: "user", content: "duplicate", timestamp: 7 },
		});

		value.schedulePromptCursorRefresh(live, { settleBindings: true });
		await vi.waitFor(() => expect(getCursors).toHaveBeenCalledOnce());
		await new Promise((resolve) => setImmediate(resolve));
		expect(readSkillSidecarEntries(live.id)[0]).not.toHaveProperty("transcriptEntryId");
	});

	it("does not consume pending skill bindings during the agent-start cursor refresh", async () => {
		const getCursors = vi.fn(async () => ({ success: true, data: {
			entries: [userEntry("pi-user", null, "prompt")],
			leafId: "pi-user",
			forkMessages: [{ entryId: "pi-user", text: "prompt" }],
		} }));
		const value = manager();
		const live = session(async () => ({ success: true, data: [
			{ id: "inner-user", role: "user", content: "prompt" },
		] }), getCursors);
		live.pendingSkillTranscriptBindings = [{
			recordId: "skill-record",
			promptId: "prompt-id",
			modelText: "prompt",
			messageIdentity: { id: "inner-user" },
		}];
		value.sessions.set(live.id, live);

		value.schedulePromptCursorRefresh(live);
		await vi.waitFor(() => expect(getCursors).toHaveBeenCalledOnce());
		expect(live.pendingSkillTranscriptBindings).toHaveLength(1);
	});

	it("schedules cursor enrichment at agent start and a settling fallback at final agent end", () => {
		const value = manager();
		value._sessionReplacementCoordinators = new Map();
		value._bootRepromptedSessions = new Set();
		value.clock = { now: () => 1 };
		value._sessionWriterIsCurrent = () => true;
		value._consumeSteerEcho = () => undefined;
		value.resolveStoreForSession = () => ({
			get: () => undefined,
			update: () => undefined,
		});
		value.resolveIdleWaiters = () => undefined;
		value.drainQueue = () => undefined;
		value._finishSessionSetup = async () => undefined;
		value.schedulePromptCursorRefresh = vi.fn();
		const live = session(async () => ({ success: true, data: [] }));
		live.status = "streaming";
		live.promptQueue = { dequeueAllSteered: () => [], toArray: () => [] };
		value.sessions.set(live.id, live);

		value.handleAgentLifecycle(live, { type: "agent_start" });
		expect(value.schedulePromptCursorRefresh).toHaveBeenCalledWith(live);
		value.handleAgentLifecycle(live, { type: "agent_end", messages: [], willRetry: true });
		expect(value.schedulePromptCursorRefresh).toHaveBeenCalledOnce();
		value.handleAgentLifecycle(live, { type: "agent_end", messages: [], willRetry: false });
		expect(value.schedulePromptCursorRefresh).toHaveBeenCalledTimes(2);
		expect(value.schedulePromptCursorRefresh).toHaveBeenLastCalledWith(live, { settleBindings: true });
	});

	it("broadcasts a cursor-enriched replacement after the settled event sequence advances", async () => {
		const entries = [
			userEntry("settled-prompt", null, "live prompt"),
			assistantEntry("settled-answer", "settled-prompt"),
		];
		const getMessages = vi.fn(async () => ({ success: true, data: [
			{ role: "user", content: "live prompt" },
			{ role: "assistant", content: "answer" },
		] }));
		const getCursors = vi.fn(async () => ({ success: true, data: {
			entries,
			leafId: "settled-answer",
			forkMessages: [{ entryId: "settled-prompt", text: "live prompt" }],
		} }));
		const sends: string[] = [];
		const client = { readyState: 1, send: (payload: string) => sends.push(payload) };
		const value = manager();
		const live = session(getMessages, getCursors);
		live.clients.add(client);
		value.sessions.set(live.id, live);

		value.schedulePromptCursorRefresh(live, { settleBindings: true });
		live.eventBuffer.push({ type: "agent_end" });
		await vi.waitFor(() => expect(sends.length).toBe(1));
		const frame = JSON.parse(sends[0]);
		expect(frame.type).toBe("messages");
		expect(frame.data[0]).toMatchObject({
			entryId: "settled-prompt",
			_entryIdSource: "pi-transcript",
		});
		expect(live.messagesSnapshotCache.seq).toBe(1);
	});

	it("keeps the sole mid-turn cursor refresh when streaming events advance", async () => {
		const messages = deferred<any>();
		const cursors = deferred<any>();
		const getMessages = vi.fn(() => messages.promise);
		const getCursors = vi.fn(() => cursors.promise);
		const sends: string[] = [];
		const client = { readyState: 1, send: (payload: string) => sends.push(payload) };
		const value = manager();
		const live = session(getMessages, getCursors);
		live.clients.add(client);
		value.sessions.set(live.id, live);

		value.schedulePromptCursorRefresh(live);
		await vi.waitFor(() => expect(getMessages).toHaveBeenCalledOnce());
		live.latestMessageUpdate = {
			id: "assistant-message",
			message: { id: "assistant-message", role: "assistant", content: "live answer" },
		};
		live.eventBuffer.push({ type: "message_update" });
		messages.resolve({ success: true, data: [
			{ id: "user-message", role: "user", content: "prompt" },
		] });
		cursors.resolve({ success: true, data: {
			entries: [userEntry("pi-user", null, "prompt")],
			leafId: "pi-user",
			forkMessages: [{ entryId: "pi-user", text: "prompt" }],
		} });

		await vi.waitFor(() => expect(sends).toHaveLength(1));
		const frame = JSON.parse(sends[0]);
		expect(frame.data[0]).toMatchObject({ entryId: "pi-user", _entryIdSource: "pi-transcript" });
		expect(frame.data[1]).toMatchObject({ content: "live answer" });
		expect(getMessages).toHaveBeenCalledOnce();
	});

	it("fences a stale cursor refresh after a newer snapshot wins", async () => {
		const oldMessages = deferred<any>();
		const oldCursors = deferred<any>();
		const newMessages = deferred<any>();
		const newCursors = deferred<any>();
		const messageReads = [oldMessages, newMessages];
		const cursorReads = [oldCursors, newCursors];
		const getMessages = vi.fn(() => messageReads.shift()!.promise);
		const getCursors = vi.fn(() => cursorReads.shift()!.promise);
		const sends: string[] = [];
		const client = { readyState: 1, send: (payload: string) => sends.push(payload) };
		const value = manager();
		const live = session(getMessages, getCursors);
		live.clients.add(client);
		const recordId = appendIdentifiedSkillSidecarEntry(live.id, {
			ts: 1,
			modelText: "prompt",
			originalText: "/pending",
			skillExpansions: [],
		});
		assert.ok(recordId);
		live.pendingSkillTranscriptBindings = [{
			recordId,
			promptId: "pending-prompt",
			modelText: "prompt",
			messageIdentity: { id: "user-message" },
		}];
		value.sessions.set(live.id, live);

		value.schedulePromptCursorRefresh(live, { settleBindings: true });
		await vi.waitFor(() => expect(getMessages).toHaveBeenCalledOnce());
		live.eventBuffer.push({ type: "message_update" });
		value.schedulePromptCursorRefresh(live);
		await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));

		newMessages.resolve({ success: true, data: [
			{ id: "user-message", role: "user", content: "prompt" },
			{ id: "assistant-message", role: "assistant", content: "new answer" },
		] });
		newCursors.resolve({ success: true, data: {
			entries: [userEntry("new-user", null, "prompt"), assistantEntry("new-answer", "new-user", "new answer")],
			leafId: "new-answer",
			forkMessages: [{ entryId: "new-user", text: "prompt" }],
		} });
		await vi.waitFor(() => expect(sends).toHaveLength(1));
		const winningFrame = JSON.parse(sends[0]);
		expect(winningFrame.data[0]).toMatchObject({ entryId: "new-user", _entryIdSource: "pi-transcript" });
		expect(winningFrame.data[1]).toMatchObject({ content: "new answer" });

		oldMessages.resolve({ success: true, data: [
			{ id: "user-message", role: "user", content: "prompt" },
		] });
		oldCursors.resolve({ success: true, data: {
			entries: [userEntry("old-user", null, "prompt")],
			leafId: "old-user",
			forkMessages: [{ entryId: "old-user", text: "prompt" }],
		} });
		await vi.waitFor(() => expect(readSkillSidecarEntries(live.id)[0]).toMatchObject({
			recordId,
			transcriptEntryId: "old-user",
		}));
		expect(sends).toHaveLength(1);
		expect(live.pendingSkillTranscriptBindings).toHaveLength(0);
	});

	it("refreshes compaction messages and cursors as one fresh authoritative pair", async () => {
		const visibleMessages = [
			{ role: "user", content: "same prompt" },
			{ role: "assistant", content: "answer" },
		];
		const snapshots = [
			{
				entries: [userEntry("before-compaction", null, "same prompt"), assistantEntry("before-answer", "before-compaction")],
				leafId: "before-answer",
				forkMessages: [{ entryId: "before-compaction", text: "same prompt" }],
			},
			{
				entries: [userEntry("after-compaction", null, "same prompt"), assistantEntry("after-answer", "after-compaction")],
				leafId: "after-answer",
				forkMessages: [{ entryId: "after-compaction", text: "same prompt" }],
			},
		];
		const getMessages = vi.fn(async () => ({ success: true, data: visibleMessages }));
		const getCursors = vi.fn(async () => ({ success: true, data: snapshots[getCursors.mock.calls.length - 1] }));
		const sends: string[] = [];
		const value = manager();
		value.broadcastSessionCost = vi.fn();
		const live = session(getMessages, getCursors);
		live.rpcClient.getState = vi.fn(async () => ({ success: false }));
		live.clients.add({ readyState: 1, send: (payload: string) => sends.push(payload) });
		value.sessions.set(live.id, live);

		const stale = await value.getMessagesSnapshotBase(live);
		expect(value.buildVisibleMessageSnapshot(live.id, stale.data)[0]).toMatchObject({ entryId: "before-compaction" });
		await value.refreshAfterCompaction(live);

		expect(getMessages).toHaveBeenCalledTimes(2);
		expect(getCursors).toHaveBeenCalledTimes(2);
		const replacement = sends.map((payload) => JSON.parse(payload)).find((frame) => frame.type === "messages");
		expect(replacement.data[0]).toMatchObject({
			entryId: "after-compaction",
			_entryIdSource: "pi-transcript",
		});
		expect(replacement.data[0]).not.toHaveProperty("entryId", "before-compaction");
	});

	it("keeps cached bases immutable while the production snapshot chokepoint rebuilds fresh structured overlays", async () => {
		const baseMessage = {
			id: "base",
			role: "user",
			content: "[System]: expanded system prompt",
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
			content: "[System]: expanded system prompt",
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
			modelText: "[System]: expanded system prompt",
			modelPrefix: "[System]: ",
			source: "system",
			author: systemAuthor,
		}), true);
		assert.equal(appendPromptAuthorSettlement(live.id, {
			promptId: "system-base",
			settledAt: 1_001,
			outcome: "echoed",
			messageId: "base",
			messageTimestamp: 1_000,
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
			content: "[System]: expanded system prompt",
			timestamp: 1_000,
		});
	});
});
