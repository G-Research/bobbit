import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revive-window-prompt-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager, emitSessionEvent } = await import("../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function flushMicrotasks(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
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

/**
 * Build a SessionManager whose dormant session is in `this.sessions` (terminated)
 * with a restorable persisted record. `restoreSession` is mocked to gate on a
 * deferred so the test controls the revive window, and the restored bridge
 * records every `prompt()` call so we can assert dispatch happened against the
 * canonical revived object.
 */
function queueRows(texts: string[]): any[] {
	return texts.map((text, i) => ({ id: `q-${i}`, text, isSteered: false, createdAt: Date.now() }));
}

function makeDormantManager(sessionId: string, opts?: { restoredQueue?: string[] }) {
	const manager: any = new SessionManager();
	managers.push(manager);
	const restoredQueueRows = opts?.restoredQueue ? queueRows(opts.restoredQueue) : undefined;

	const persisted: any = {
		id: sessionId,
		title: "Dormant session",
		cwd: tmpRoot,
		agentSessionFile: path.join(tmpRoot, "agent-session.jsonl"),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		messageQueue: restoredQueueRows,
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

	const restoreGate = deferred();
	const promptCalls: string[] = [];
	const restoredSessions: any[] = [];

	manager.restoreSession = mock.fn(async () => {
		await restoreGate.promise;
		const restored: any = {
			id: sessionId,
			title: "Restored",
			cwd: tmpRoot,
			status: "idle",
			statusVersion: 0,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			eventBuffer: new EventBuffer(),
			promptQueue: new PromptQueue(restoredQueueRows),
			streamingStartedAt: undefined,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			rpcClient: undefined,
		};
		restored.rpcClient = {
			prompt: mock.fn(async (text: string) => {
				promptCalls.push(text);
				emitSessionEvent(restored, {
					type: "message_end",
					message: {
						id: `assistant-${promptCalls.length}`,
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

	return { manager, restoreGate, promptCalls, restoredSessions };
}

describe("revive-window prompt dispatch (CS-R2 follow-up)", () => {
	it("dispatches a prompt that arrives against a dormant session by joining the coalesced restore", async () => {
		const sessionId = "s-revive-direct";
		const { manager, restoreGate, promptCalls, restoredSessions } = makeDormantManager(sessionId);

		// No prior attach / awaited revive — the prompt itself must trigger and
		// join the restore, then dispatch against the canonical revived session.
		const enqueuePromise = manager.enqueuePrompt(sessionId, "wake me");
		await flushMicrotasks();

		// Exactly one restore started (the enqueue triggered it through the coordinator).
		assert.equal(manager.restoreSession.mock.callCount(), 1, "enqueue must trigger exactly one restore");

		restoreGate.resolve();
		const result = await enqueuePromise;
		await flushMicrotasks();

		assert.equal(restoredSessions.length, 1, "exactly one canonical SessionInfo created");
		assert.equal(manager.sessions.get(sessionId), restoredSessions[0], "map entry is the canonical revived session");
		assert.deepEqual(promptCalls, ["wake me"], "prompt dispatched against the revived canonical bridge");
		assert.equal(result.status, "dispatched", "enqueue reports dispatched, not silently queued");
	});

	it("joins an in-flight restore and dispatches after the revive completes", async () => {
		const sessionId = "s-revive-inflight";
		const { manager, restoreGate, promptCalls, restoredSessions } = makeDormantManager(sessionId);

		// Open a restore via the coalescer first (simulating an addClient dormant
		// revive in flight), then enqueue while it is gated open.
		const inFlight = manager._restoreSessionCoalesced(manager._testStore.get(sessionId));
		await flushMicrotasks();
		assert.equal(manager.restoreSession.mock.callCount(), 1, "one restore in flight");

		const enqueuePromise = manager.enqueuePrompt(sessionId, "queued during revive");
		await flushMicrotasks();
		// enqueue must NOT have started a second restore — it joins the in-flight one.
		assert.equal(manager.restoreSession.mock.callCount(), 1, "enqueue must join the in-flight restore, not start a second");

		restoreGate.resolve();
		await inFlight;
		const result = await enqueuePromise;
		await flushMicrotasks();

		assert.equal(restoredSessions.length, 1, "only one restore occurred");
		assert.deepEqual(promptCalls, ["queued during revive"], "prompt dispatched after the in-flight revive resolved");
		assert.equal(result.status, "dispatched", "enqueue reports dispatched");
	});

	it("drains a queue restored from the persisted record once the revive reaches idle", async () => {
		const sessionId = "s-revive-restored-queue";
		const { manager, restoreGate, promptCalls } = makeDormantManager(sessionId, {
			restoredQueue: ["persisted prompt"],
		});

		// Trigger the revive directly (no enqueue) — the restored session re-seeds
		// its queue from ps.messageQueue and must drain it once idle.
		const inFlight = manager._restoreSessionCoalesced(manager._testStore.get(sessionId));
		restoreGate.resolve();
		await inFlight;
		await flushMicrotasks();

		assert.deepEqual(promptCalls, ["persisted prompt"], "restored persisted queue is drained once after revive");
	});
});
