import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "missing-live-messages-repro-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager, emitSessionEvent } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");

type TestClient = {
	name: string;
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function flushMicrotasks(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

function makeClient(name: string): TestClient {
	return {
		name,
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { this.sent.push(JSON.parse(data)); },
		close() { this.readyState = 3; },
	};
}

function sawAssistantFrame(client: TestClient): boolean {
	return client.sent.some((msg) =>
		msg.type === "event" &&
		msg.data?.type === "message_end" &&
		msg.data?.message?.role === "assistant"
	);
}

const managers: any[] = [];

afterEach(() => {
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager._statusHeartbeatTimer) {
			clearInterval(manager._statusHeartbeatTimer);
			manager._statusHeartbeatTimer = null;
		}
		manager.sessionsWithConnectedClients?.clear?.();
		manager.sessions?.clear?.();
	}
});

describe("missing live messages after dormant revive", () => {
	it("attached clients keep receiving assistant frames when concurrent dormant addClient revives join one restore", async () => {
		const manager: any = new SessionManager();
		managers.push(manager);

		const sessionId = "s-missing-live";
		const persisted = {
			id: sessionId,
			title: "Dormant session",
			cwd: tmpRoot,
			agentSessionFile: path.join(tmpRoot, "agent-session.jsonl"),
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		manager._testStore = {
			get: mock.fn((id: string) => id === sessionId ? persisted : undefined),
			update: mock.fn(() => {}),
			archive: mock.fn(() => {}),
		};

		manager.sessions.set(sessionId, {
			id: sessionId,
			title: persisted.title,
			cwd: tmpRoot,
			status: "terminated",
			statusVersion: 0,
			dormant: true,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			rpcClient: { stop: mock.fn(async () => {}) },
			eventBuffer: new EventBuffer(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			promptQueue: new PromptQueue(),
		});

		const restoreGates: Array<ReturnType<typeof deferred>> = [];
		const restoredSessions: any[] = [];
		manager.restoreSession = mock.fn(async () => {
			const restoreIndex = restoreGates.length + 1;
			const gate = deferred();
			restoreGates.push(gate);
			await gate.promise;

			const restored: any = {
				id: sessionId,
				title: `Restored ${restoreIndex}`,
				cwd: tmpRoot,
				status: "idle",
				statusVersion: 0,
				createdAt: persisted.createdAt,
				lastActivity: persisted.lastActivity,
				clients: new Set(),
				eventBuffer: new EventBuffer(),
				promptQueue: new PromptQueue(),
				streamingStartedAt: undefined,
				unsubscribe: () => {},
				isCompacting: false,
				titleGenerated: true,
				rpcClient: undefined,
			};
			restored.rpcClient = {
				prompt: mock.fn(async () => {
					emitSessionEvent(restored, {
						type: "message_end",
						message: {
							id: `assistant-${restoreIndex}`,
							role: "assistant",
							content: [{ type: "text", text: "reply after dormant revive" }],
						},
					});
					return { success: true };
				}),
				stop: mock.fn(async () => {}),
			};
			restoredSessions.push(restored);
			manager.sessions.set(sessionId, restored);
		});

		const firstAttachedClient = makeClient("first-attached-client");
		const secondAttachedClient = makeClient("second-attached-client");

		assert.equal(manager.addClient(sessionId, firstAttachedClient as any), true);
		assert.equal(manager.addClient(sessionId, secondAttachedClient as any), true);
		assert.ok(restoreGates.length >= 1, "dormant addClient must start a restore");

		// Resolve all restore attempts in call order. Current HEAD starts two restores
		// and each addClient .then() attaches its ws to whichever SessionInfo is in
		// the map when that restore completes, splitting clients across objects.
		for (let i = 0; i < restoreGates.length; i++) {
			restoreGates[i].resolve();
			await flushMicrotasks();
		}
		// If a fixed implementation coalesces the second addClient into the first
		// in-flight promise, only one gate exists; both clients should now be on it.
		await flushMicrotasks();

		const current = manager.sessions.get(sessionId);
		assert.ok(current, "restored session should be present");
		assert.ok(current.clients.has(secondAttachedClient as any), "second client should be attached to the live restored session");

		await manager.enqueuePrompt(sessionId, "wake the dormant session");

		assert.equal(sawAssistantFrame(secondAttachedClient), true, "control client must receive the produced assistant frame");
		assert.equal(
			sawAssistantFrame(firstAttachedClient),
			true,
			"attached client must receive assistant frame produced after dormant revive; current addClient split-brain drops it",
		);
	});
});
