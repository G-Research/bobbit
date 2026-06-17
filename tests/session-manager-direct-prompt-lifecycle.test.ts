import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-direct-prompt-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");

type TestClient = {
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

const managers: any[] = [];

function makeClient(): TestClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { this.sent.push(JSON.parse(data)); },
		close() { this.readyState = 3; },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function makeManager(): any {
	const manager: any = new SessionManager();
	manager._testStore = {
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
	};
	managers.push(manager);
	return manager;
}

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager.sessionsWithConnectedClients?.clear();
	manager.sessions?.clear();
}

function putSession(manager: any, overrides: Record<string, any> = {}): any {
	const client = makeClient();
	const session = {
		id: "s-direct",
		title: "Direct prompt test",
		titleGenerated: true,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set([client]),
		promptQueue: new PromptQueue(),
		streamingStartedAt: undefined,
		rpcClient: { prompt: mock.fn(async () => ({ success: true })) },
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return { session, client };
}

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
});

describe("SessionManager direct idle prompt lifecycle", () => {
	it("marks idle+empty direct prompts as streaming before rpcClient.prompt resolves", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = mock.fn(() => pending.promise);
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		const sendPromise = manager.enqueuePrompt(session.id, "hello Codex");

		assert.equal(prompt.mock.callCount(), 1);
		assert.equal(session.status, "streaming");
		assert.equal(session.promptQueue.length, 0);
		assert.equal(manager._testStore.update.mock.callCount(), 1);
		assert.deepEqual(client.sent.at(-1), {
			type: "session_status",
			status: "streaming",
			statusVersion: 1,
			streamingStartedAt: session.streamingStartedAt,
		});

		pending.resolve({ success: true });
		await sendPromise;
	});

	it("recovers a failed direct prompt by restoring idle status and requeueing", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const prompt = mock.fn(async () => ({ success: false, error: "preflight failed" }));
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry me"),
			/preflight failed/,
		);

		assert.equal(prompt.mock.callCount(), 1);
		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, "retry me");
		assert.equal(client.sent.at(-1).type, "queue_update");
		assert.equal(client.sent.at(-2).type, "session_status");
		assert.equal(client.sent.at(-2).status, "idle");
	});

	it("dispatches a promoted queued steer immediately like a fresh live steer", async () => {
		const manager = makeManager();
		const steer = mock.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: mock.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "fresh live steer");
		assert.equal(steer.mock.callCount(), 1, "fresh live steer dispatches immediately");
		assert.equal(steer.mock.calls[0].arguments[0], "fresh live steer");

		const queued = session.promptQueue.enqueue("promoted queued steer");
		manager.steerQueued(session.id, queued.id);

		assert.equal(
			steer.mock.callCount(),
			2,
			"promoting a queued message to steer should dispatch immediately, not wait for a later tool boundary/agent_end",
		);
		assert.equal(steer.mock.calls[1].arguments[0], "promoted queued steer");
	});

	it("persists in-flight steer ledger until the user echo arrives", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const steer = mock.fn(() => pending.promise);
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: mock.fn(async () => ({ success: true })), steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "durable steer");

		assert.equal(steer.mock.callCount(), 1);
		const ledgerUpdate = manager._testStore.update.mock.calls
			.map((call: any) => call.arguments[1])
			.find((update: any) => Array.isArray(update?.inFlightSteerTexts));
		assert.deepEqual(ledgerUpdate, {
			messageQueue: [],
			inFlightSteerTexts: ["durable steer"],
		});

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "durable steer" }] },
		});
		const clearUpdate = manager._testStore.update.mock.calls.at(-1)?.arguments[1];
		assert.deepEqual(clearUpdate, { inFlightSteerTexts: undefined });

		pending.resolve({ success: true });
		await steerPromise;
	});

	it("does not duplicate a pending steer when abort reconciliation wins the rejection race", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const steer = mock.fn(() => pending.promise);
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: mock.fn(async () => ({ success: true })), steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "recover steer exactly once");

		assert.equal(steer.mock.callCount(), 1);
		assert.equal(session.promptQueue.length, 0);
		assert.deepEqual(session.inFlightSteerTexts, ["recover steer exactly once"]);

		manager._reconcileAfterAbort(session);
		assert.deepEqual(session.inFlightSteerTexts, []);
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, "recover steer exactly once");
		assert.equal(session.promptQueue.peek()?.isSteered, true);

		pending.resolve({ success: false, error: "steer rejected after abort" });
		await assert.rejects(steerPromise, /steer rejected after abort/);

		const recovered = session.promptQueue.toArray().filter((row: any) => row.text === "recover steer exactly once");
		assert.equal(recovered.length, 1, "late steer rejection must not duplicate a row already recovered by abort reconciliation");
		assert.equal(session.promptQueue.length, 1);
	});

	it("does not replay a queued steered task notification after its prompt has started", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = mock.fn(() => pending.promise);
		const steer = mock.fn(async () => ({ success: true }));
		const taskNotice = "Task \"Stabilize at-mention menu close E2E\" transitioned to complete. Use task_list for result summaries and gate_status for verification details.";
		const { session } = putSession(manager, { rpcClient: { prompt, steer } });

		session.promptQueue.enqueue(taskNotice, { isSteered: true });
		manager.drainQueue(session);

		assert.equal(prompt.mock.callCount(), 1);
		assert.equal(prompt.mock.calls[0].arguments[0], taskNotice);
		assert.equal(session.promptQueue.length, 0);

		// The agent has accepted the prompt and begun processing it. A late bridge
		// failure from that same dispatch must not recover the row back into the
		// queue, otherwise agent_end will inject the same task notification again.
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		pending.resolve({ success: false, error: "Agent is already processing." });
		await Promise.resolve();
		await Promise.resolve();

		manager.handleAgentLifecycle(session, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
		manager.handleAgentLifecycle(session, { type: "agent_end" });

		assert.equal(
			steer.mock.callCount(),
			0,
			"accepted task notification must not be re-enqueued and steered a second time",
		);
		assert.equal(session.promptQueue.length, 0);
	});

	it("recovers a queued prompt when local abort status changes before prompt rejection", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = mock.fn(() => pending.promise);
		const abort = mock.fn(async () => ({ success: true }));
		const { session, client } = putSession(manager, { rpcClient: { prompt, abort } });

		session.promptQueue.enqueue("recover after abort-before-acceptance");
		manager.drainQueue(session);

		assert.equal(prompt.mock.callCount(), 1);
		assert.equal(session.status, "streaming");
		assert.equal(session.promptQueue.length, 0);

		await manager.abortSessionTurn(session.id);
		assert.equal(abort.mock.callCount(), 1);
		assert.equal(session.status, "aborting");

		pending.resolve({ success: false, error: "preflight failed after abort" });
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, "recover after abort-before-acceptance");
		assert.deepEqual(
			client.sent.filter((msg) => msg.type === "session_status").map((msg) => msg.status),
			["streaming", "aborting", "idle"],
		);
	});

	it("does not resurrect a terminated session when direct prompt rejects after process_exit", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = mock.fn(() => pending.promise);
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		const sendPromise = manager.enqueuePrompt(session.id, "lost with child");
		assert.equal(prompt.mock.callCount(), 1);
		assert.equal(session.status, "streaming");

		manager.handleAgentLifecycle(session, { type: "process_exit", code: 17, signal: null });
		assert.equal(session.status, "terminated");

		pending.reject(new Error("Agent process exited with code 17"));
		await assert.rejects(() => sendPromise, /Agent process exited with code 17/);

		t.mock.timers.tick(0);
		assert.equal(prompt.mock.callCount(), 1, "terminated sessions must not redrain rejected prompts");
		assert.equal(session.status, "terminated", "recovery must not broadcast idle over process_exit termination");
		assert.equal(session.promptQueue.length, 0, "prompt rejected by a dead child must not be requeued");
		assert.deepEqual(
			client.sent.filter((msg) => msg.type === "session_status").map((msg) => msg.status),
			["streaming", "terminated"],
		);
		assert.equal(client.sent.some((msg) => msg.type === "queue_update"), false);
	});
});
