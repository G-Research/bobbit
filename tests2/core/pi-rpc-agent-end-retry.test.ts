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
const { createManualClock } = await import("../harness/clock.js");

const managers: any[] = [];

afterEach(() => {
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

	it("emitAgentEvent suppresses retryable agent_end but emits the terminal one to clients", () => {
		const manager = makeManager();
		const session = putSession(manager);

		// Retryable agent_end must NOT reach the event buffer (clients treat any
		// agent_end as terminal and would clear the streaming message/tool calls).
		manager.emitAgentEvent(session, { type: "agent_end", willRetry: true, messages: [] });
		expect(session.eventBuffer.size).toBe(0);

		// Non-terminal streaming events still flow through.
		manager.emitAgentEvent(session, { type: "message_update", message: { id: "m1", role: "assistant" } });
		expect(session.eventBuffer.size).toBe(1);

		// The real terminal agent_end is emitted so clients end the turn.
		manager.emitAgentEvent(session, { type: "agent_end", willRetry: false, messages: [] });
		const events = session.eventBuffer.getAll().map((e: any) => e.event.type);
		expect(events).toEqual(["message_update", "agent_end"]);
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

	it("keeps summarization retries and compaction continuations streaming until terminal agent_end", async () => {
		const manager = makeManager();
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const prompt = vi.fn(async () => ({ success: true }));
		const session = putSession(manager, {
			isCompacting: true,
			allowedTools: ["read", "write"],
			oneTimeGrantedTools: ["read"],
			rpcClient: {
				onEvent: (fn: (event: AgentSessionEvent) => void) => {
					listeners.add(fn);
					return () => { listeners.delete(fn); };
				},
				prompt,
				getState: vi.fn(async () => ({ success: true, data: {} })),
			},
		});
		session.promptQueue.enqueue("dispatch only after terminal settlement");
		manager.refreshAfterCompaction = vi.fn();

		const trackCostFromEvent = vi.fn();
		const unsub = subscribeToEvents(session, {
			store: manager._testStore,
			handleAgentLifecycle: (current: any, event: AgentSessionEvent) => manager.handleAgentLifecycle(current, event),
			trackCostFromEvent,
		} as any);
		let idleResolved = false;
		const wait = manager.waitForIdle(session.id, 10_000).then(() => { idleResolved = true; });
		const emit = (event: AgentSessionEvent) => {
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
		const compactionEnd: AgentSessionEvent = {
			type: "compaction_end",
			reason: "overflow",
			result: {
				summary: "compacted after retry",
				firstKeptEntryId: "entry-2",
				tokensBefore: 1_000,
				estimatedTokensAfter: 100,
				usage: compactionUsage,
			},
			aborted: false,
			willRetry: true,
		};

		emit(scheduled);
		emit(attemptStart);
		emit(retryFinished);
		emit(compactionEnd);
		await flush();

		expect(idleResolved).toBe(false);
		expect(session.status).toBe("streaming");
		expect(session.isCompacting).toBe(false);
		expect(session.completedTurnCount ?? 0).toBe(0);
		expect(session.allowedTools).toEqual(["read", "write"]);
		expect(session.oneTimeGrantedTools).toEqual(["read"]);
		expect(prompt).not.toHaveBeenCalled();
		expect(trackCostFromEvent).toHaveBeenCalledTimes(4);

		const continuationEvents = session.eventBuffer.getAll().map((entry: any) => entry.event);
		expect(continuationEvents.map((event: any) => event.type)).toEqual([
			"summarization_retry_scheduled",
			"summarization_retry_attempt_start",
			"summarization_retry_finished",
			"compaction_end",
		]);
		expect(continuationEvents[3].willRetry).toBe(true);
		assert.equal(continuationEvents[3].result.usage, compactionUsage, "summary usage must be forwarded, not synthesized or dropped");

		emit({ type: "agent_end", messages: [], willRetry: false });
		await wait;
		await flush();

		expect(idleResolved).toBe(true);
		// The terminal boundary briefly settles idle and then drains the queued
		// prompt, whose optimistic dispatch transition makes the session streaming.
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
