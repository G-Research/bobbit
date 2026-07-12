import { afterEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardProcessEnv } from "./helpers/env-guard.js";

guardProcessEnv();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-agent-end-retry-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager, isRetryableAgentEnd } = await import("../../src/server/agent/session-manager.ts");
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
