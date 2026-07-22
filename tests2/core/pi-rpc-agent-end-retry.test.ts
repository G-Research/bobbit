import { afterEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { guardProcessEnv } from "./helpers/env-guard.js";

guardProcessEnv();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-agent-end-retry-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager, isRetryableAgentEnd } = await import("../../src/server/agent/session-manager.ts");
const { subscribeToEvents } = await import("../../src/server/agent/session-setup.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { initCompactionSidecarDir, purgeCompactionSidecar, readCompactionSidecarEntries } = await import("../../src/server/agent/compaction-sidecar.ts");
const { createManualClock } = await import("../harness/clock.js");

initCompactionSidecarDir(tmpRoot);

const managers: any[] = [];

afterEach(() => {
	purgeCompactionSidecar("s-pi-retry");
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) {
			manager._testClock?.clearInterval?.(manager._statusHeartbeatTimer);
			manager._statusHeartbeatTimer = null;
		}
		manager.sessions?.clear?.();
		manager.sessionsWithConnectedClients?.clear?.();
	}
});

function makeManager(): any {
	const clock = createManualClock();
	const manager: any = new SessionManager({ clock });
	if (manager._statusHeartbeatTimer) {
		clock.clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager._testClock = clock;
	manager._testStore = { update: vi.fn(), get: vi.fn(() => undefined) };
	managers.push(manager);
	return manager;
}

function putSession(manager: any, overrides: Record<string, any> = {}): any {
	const session = {
		id: "s-pi-retry",
		title: "Pi retry event test",
		cwd: tmpRoot,
		status: "streaming",
		statusVersion: 0,
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		setupComplete: true,
		rpcClient: {
			prompt: vi.fn(async () => ({ success: true })),
			getState: vi.fn(async () => ({ success: true, data: {} })),
		},
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return session;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("Pi RPC agent_end retry contract", () => {
	it("does not mark idle, drain queued prompts, or revoke one-time grants for retryable Pi agent_end", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async (_message: string) => ({ success: true }));
		const session = putSession(manager, {
			rpcClient: { prompt, getState: vi.fn(async () => ({ success: true, data: {} })) },
			allowedTools: ["read", "write"],
			oneTimeGrantedTools: ["read"],
			streamingStartedAt: 123,
		});
		session.promptQueue.enqueue("queued until Pi settles");

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "overloaded_error: retryable" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: true, messages: [] });
		await flush();

		assert.equal(session.status, "streaming");
		assert.equal(session.streamingStartedAt, 123);
		// A retryable agent_end must NOT count the turn: one user-visible turn with
		// an internal Pi retry would otherwise be counted twice (retry + final),
		// shifting lifecycle turn indexes. Unchanged from its pre-event value.
		assert.equal(session.completedTurnCount ?? 0, 0);
		assert.deepEqual(session.allowedTools, ["read", "write"]);
		assert.deepEqual(session.oneTimeGrantedTools, ["read"]);
		expect(prompt).not.toHaveBeenCalled();

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		await flush();

		// Only the final (willRetry:false) agent_end increments the counter — exactly once.
		assert.equal(session.completedTurnCount, 1);
		assert.deepEqual(session.allowedTools, ["write"]);
		assert.deepEqual(session.oneTimeGrantedTools, []);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0][0]).toBe("queued until Pi settles");
	});

	it("isRetryableAgentEnd only matches agent_end with willRetry:true", () => {
		expect(isRetryableAgentEnd({ type: "agent_end", willRetry: true })).toBe(true);
		expect(isRetryableAgentEnd({ type: "agent_end", willRetry: false })).toBe(false);
		expect(isRetryableAgentEnd({ type: "agent_end", messages: [] })).toBe(false);
		expect(isRetryableAgentEnd({ type: "message_end", willRetry: true })).toBe(false);
		expect(isRetryableAgentEnd(undefined)).toBe(false);
		expect(isRetryableAgentEnd(null)).toBe(false);
		expect(isRetryableAgentEnd("agent_end")).toBe(false);
	});

	it("emitAgentEvent suppresses retryable agent_end but emits completed compaction with willRetry:true", () => {
		const manager = makeManager();
		const session = putSession(manager);

		manager.emitAgentEvent(session, { type: "agent_end", willRetry: true, messages: [] });
		expect(session.eventBuffer.size).toBe(0);

		// Compaction has completed even though Pi will retry the surrounding turn.
		manager.emitAgentEvent(session, { type: "compaction_end", willRetry: true, result: { usage: { input: 1 } } });
		manager.emitAgentEvent(session, { type: "message_update", message: { id: "m1", role: "assistant" } });
		manager.emitAgentEvent(session, { type: "agent_end", willRetry: false, messages: [] });
		const events = session.eventBuffer.getAll().map((e: any) => e.event.type);
		expect(events).toEqual(["compaction_end", "message_update", "agent_end"]);
	});

	it("subscribeToEvents (session-setup pipeline) suppresses retryable agent_end before client/EventBuffer broadcast", () => {
		const manager = makeManager();
		let listener: ((event: any) => void) | undefined;
		const session = putSession(manager, {
			rpcClient: { onEvent: (fn: (event: any) => void) => { listener = fn; return () => { listener = undefined; }; } },
		});

		const handleAgentLifecycle = vi.fn();
		const trackCostFromEvent = vi.fn();
		const ctx: any = {
			store: { update: vi.fn() },
			handleAgentLifecycle,
			trackCostFromEvent,
		};

		const unsub = subscribeToEvents(session, ctx);
		expect(typeof unsub).toBe("function");

		// Retryable Pi agent_end must NOT reach the EventBuffer/clients even on the
		// normal spawn setup pipeline path (not only SessionManager direct paths).
		listener?.({ type: "agent_end", willRetry: true, messages: [] });
		expect(session.eventBuffer.size).toBe(0);

		// Other events still broadcast normally.
		listener?.({ type: "message_update", message: { id: "m1", role: "assistant" } });
		expect(session.eventBuffer.size).toBe(1);

		// The real terminal agent_end (willRetry:false) still broadcasts.
		listener?.({ type: "agent_end", willRetry: false, messages: [] });

		const events = session.eventBuffer.getAll().map((e: any) => e.event.type);
		expect(events).toEqual(["message_update", "agent_end"]);

		// Lifecycle + cost tracking still see every event, including the retryable one.
		expect(handleAgentLifecycle).toHaveBeenCalledTimes(3);
		expect(trackCostFromEvent).toHaveBeenCalledTimes(3);

		unsub();
	});

	it("completes overflow compaction before retrying and settles only on the final agent_end", async () => {
		const manager = makeManager();
		const listeners = new Set<(event: any) => void>();
		const prompt = vi.fn(async () => ({ success: true }));
		const recordUsage = vi.fn(() => ({ inputTokens: 11, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 19, totalCost: 1 }));
		manager._testCostTracker = { recordUsage };
		const session = putSession(manager, {
			isCompacting: false,
			allowedTools: ["read", "write"],
			oneTimeGrantedTools: ["read"],
			rpcClient: {
				onEvent: (fn: (event: any) => void) => {
					listeners.add(fn);
					return () => { listeners.delete(fn); };
				},
				prompt,
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		session.promptQueue.enqueue("dispatch only after terminal settlement");
		manager.refreshAfterCompaction = vi.fn();

		const trackCostFromEvent = vi.fn((current: any, event: any) => manager.trackCostFromEvent(current, event));
		const unsub = subscribeToEvents(session, {
			store: manager._testStore,
			handleAgentLifecycle: (current: any, event: any) => manager.handleAgentLifecycle(current, event),
			trackCostFromEvent,
		} as any);
		let idleResolved = false;
		const wait = manager.waitForIdle(session.id, 10_000).then(() => { idleResolved = true; });
		const emit = (event: any) => {
			for (const listener of [...listeners]) listener(event);
		};

		const scheduled: AgentSessionEvent = {
			type: "summarization_retry_scheduled",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 250,
			errorMessage: "temporary summarizer disconnect",
		};
		const attemptStart: AgentSessionEvent = {
			type: "summarization_retry_attempt_start",
			source: "compaction",
			reason: "overflow",
		};
		const retryFinished: AgentSessionEvent = { type: "summarization_retry_finished" };
		const compactionUsage = {
			input: 11,
			output: 13,
			cacheRead: 17,
			cacheWrite: 19,
			totalTokens: 60,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const compactionEnd = {
			type: "compaction_end",
			reason: "overflow",
			result: {
				summary: "compacted after summarizer retry",
				firstKeptEntryId: "entry-kept",
				tokensBefore: 1_000,
				estimatedTokensAfter: 100,
				usage: compactionUsage,
			},
			aborted: false,
			// Pi's _runAutoCompaction has already appended the compaction. This flag
			// announces agent.continue(); it does not announce another compaction_end.
			willRetry: true,
		};

		emit({ type: "compaction_start", reason: "overflow" });
		const pendingId = session._pendingCompactionStart?.compactionId;
		expect(pendingId).toMatch(/^c_/);
		emit(scheduled);
		emit(attemptStart);
		emit(retryFinished);
		emit(compactionEnd);
		await flush();

		// Compaction itself is complete and visible exactly once.
		expect(session.isCompacting).toBe(false);
		expect(session._pendingCompactionStart).toBeUndefined();
		expect(compactionEnd).toHaveProperty("compactionId", pendingId);
		expect(readCompactionSidecarEntries(session.id)).toMatchObject([{
			id: pendingId,
			success: true,
			firstKeptEntryId: "entry-kept",
		}]);
		expect(manager.refreshAfterCompaction).toHaveBeenCalledTimes(1);
		const compactionEvents = session.eventBuffer.getAll().map((entry: any) => entry.event);
		expect(compactionEvents.map((event: any) => event.type)).toEqual([
			"compaction_start",
			"summarization_retry_scheduled",
			"summarization_retry_attempt_start",
			"summarization_retry_finished",
			"compaction_end",
		]);
		expect(compactionEvents.at(-1)).toBe(compactionEnd);

		// The surrounding turn is still live until Pi's retried agent run ends.
		expect(idleResolved).toBe(false);
		expect(session.status).toBe("streaming");
		expect(session.completedTurnCount ?? 0).toBe(0);
		expect(session.allowedTools).toEqual(["read", "write"]);
		expect(session.oneTimeGrantedTools).toEqual(["read"]);
		expect(prompt).not.toHaveBeenCalled();

		// Summarizer usage is retained even though willRetry describes the agent turn.
		expect(trackCostFromEvent).toHaveBeenCalledWith(session, compactionEnd);
		expect(recordUsage).toHaveBeenCalledTimes(1);
		expect(recordUsage).toHaveBeenCalledWith(session.id, {
			inputTokens: 11,
			outputTokens: 13,
			cacheReadTokens: 17,
			cacheWriteTokens: 19,
			cost: 1,
		}, undefined);
		assert.equal((trackCostFromEvent.mock.calls.at(-1)?.[1] as any).result.usage, compactionUsage,
			"compaction usage must be accounted without synthesizing or dropping it");

		// _runAutoCompaction returns true, so Pi calls agent.continue(). There is no
		// second compaction_end; the next agent_end is the terminal turn boundary.
		emit({ type: "agent_start" });
		emit({ type: "agent_end", messages: [], willRetry: false });
		await wait;
		await flush();

		expect(idleResolved).toBe(true);
		expect(session.eventBuffer.getAll().filter((entry: any) => entry.event.type === "compaction_end")).toHaveLength(1);
		// The terminal turn boundary briefly settles idle and then drains the
		// queued prompt, whose optimistic dispatch makes the session streaming.
		expect(session.status).toBe("streaming");
		expect(session.completedTurnCount).toBe(1);
		expect(session.allowedTools).toEqual(["write"]);
		expect(session.oneTimeGrantedTools).toEqual([]);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("dispatch only after terminal settlement", undefined);

		unsub();
	});

	it("waitForIdle ignores retryable Pi agent_end and resolves on the final agent_end", async () => {
		const manager = makeManager();
		let listener: ((event: any) => void) | undefined;
		const session = putSession(manager, {
			rpcClient: { onEvent: (fn: (event: any) => void) => { listener = fn; return () => { listener = undefined; }; } },
		});

		let resolved = false;
		const wait = manager.waitForIdle(session.id, 10_000).then(() => { resolved = true; });
		listener?.({ type: "agent_end", willRetry: true });
		await flush();
		expect(resolved).toBe(false);

		listener?.({ type: "agent_end", willRetry: false });
		await wait;
		expect(resolved).toBe(true);
	});
});
