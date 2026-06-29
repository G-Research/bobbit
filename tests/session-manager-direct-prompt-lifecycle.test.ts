import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-direct-prompt-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");

const AUTH_SECRET = "sk-or-retry-secret-never-leak";
const AUTH_ERROR = `No API key found for openrouter: ${AUTH_SECRET}`;

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
	for (const session of manager.sessions?.values?.() ?? []) {
		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
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
		eventBuffer: new EventBuffer(),
		streamingStartedAt: undefined,
		modelProvider: "openrouter",
		rpcClient: { prompt: mock.fn(async () => ({ success: true })) },
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return { session, client };
}

function autoRetryPendingEvents(session: any): any[] {
	return session.eventBuffer
		.getAll()
		.map((entry: any) => entry.event)
		.filter((event: any) => event?.type === "auto_retry_pending");
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

	it("schedules visible auto retry when direct prompt delivery rejects with fetch failed before message_end", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const prompt = mock.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry transport prompt"),
			/fetch failed/,
		);

		assert.equal(prompt.mock.callCount(), 1, "expected one failed prompt delivery before auto retry timer fires");
		assert.equal(session.status, "idle", "expected dispatch failure recovery to restore idle status");
		assert.equal(session.promptQueue.length, 1, "expected recovered prompt queue after fetch failed");
		assert.equal(session.promptQueue.peek()?.text, "retry transport prompt", "expected recovered prompt text after fetch failed");
		assert.ok(
			session.pendingAutoRetryTimer,
			"expected pendingAutoRetryTimer for dispatch-time fetch failed",
		);
		const pending = autoRetryPendingEvents(session).at(-1);
		assert.ok(pending, "expected auto_retry_pending for dispatch-time fetch failed");
		assert.equal(pending.retryDelayMs, 1000, "expected first bounded retry delay for dispatch-time fetch failed");
		assert.equal(pending.attempt, 1, "expected first bounded retry attempt for dispatch-time fetch failed");
		assert.equal(
			client.sent.some((msg) => msg.type === "event" && msg.data?.type === "auto_retry_pending"),
			true,
			"expected client-visible auto_retry_pending event for dispatch-time fetch failed",
		);
	});

	it("schedules visible auto retry when queued drain dispatch rejects with fetch failed before message_end", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		const prompt = mock.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });
		session.promptQueue.enqueue("queued transport prompt");

		manager.drainQueue(session);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(prompt.mock.callCount(), 1, "expected one failed queued dispatch before auto retry timer fires");
		assert.equal(session.status, "idle", "expected queued dispatch failure recovery to restore idle status");
		assert.equal(session.promptQueue.length, 1, "expected recovered queued prompt after fetch failed");
		assert.equal(session.promptQueue.peek()?.text, "queued transport prompt", "expected queued prompt text recovered after fetch failed");
		assert.ok(session.pendingAutoRetryTimer, "expected pendingAutoRetryTimer for queued fetch failed");
		const pending = autoRetryPendingEvents(session).at(-1);
		assert.ok(pending, "expected auto_retry_pending for queued fetch failed");
		assert.equal(pending.retryDelayMs, 1000, "expected first bounded retry delay for queued fetch failed");
		assert.equal(client.sent.some((msg) => msg.type === "event" && msg.data?.type === "auto_retry_pending"), true);
	});

	it("auto retry consumes the recovered direct prompt row before redispatch", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const manager = makeManager();
		let calls = 0;
		const prompt = mock.fn(async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return { success: true };
		});
		const { session } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry once without duplicate queue replay"),
			/fetch failed/,
		);
		assert.equal(session.promptQueue.length, 1, "expected recovered row before auto retry fires");

		t.mock.timers.tick(1000);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(prompt.mock.callCount(), 2, "expected only the initial failure plus one auto retry dispatch");
		assert.equal(prompt.mock.calls[1].arguments[0], "retry once without duplicate queue replay");
		assert.equal(session.promptQueue.length, 0, "auto retry should consume the recovered row before redispatching");
		assert.equal(session.status, "streaming");
	});

	it("retryLastPrompt routes mid-work provider-auth prompt failures through recovery", async () => {
		const manager = makeManager();
		const prompt = mock.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session, client } = putSession(manager, {
			lastTurnErrored: true,
			turnHadToolCalls: true,
			rpcClient: { prompt },
		});

		await assert.rejects(() => manager.retryLastPrompt(session.id), (err: any) => {
			assert.match(err?.message ?? "", /OpenRouter provider authentication failure \(missing-api-key\)/);
			assert.doesNotMatch(err?.message ?? "", new RegExp(AUTH_SECRET));
			return true;
		});

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.match(session.promptQueue.peek()?.text ?? "", /Please continue where you left off/);
		assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(AUTH_SECRET));
		assert.match(JSON.stringify(client.sent), /provider_auth_required|Fix API key/i);
	});

	it("retryLastPrompt routes fallback provider-auth prompt failures through recovery", async () => {
		const manager = makeManager();
		const prompt = mock.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session, client } = putSession(manager, {
			lastTurnErrored: true,
			lastPromptText: undefined,
			lastPromptImages: undefined,
			rpcClient: { prompt },
		});

		await assert.rejects(() => manager.retryLastPrompt(session.id), /OpenRouter provider authentication failure \(missing-api-key\)/);

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.match(session.promptQueue.peek()?.text ?? "", /retry what you were doing/);
		assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(AUTH_SECRET));
	});

	it("retryLastPrompt routes blank-text recovery provider-auth prompt failures through recovery", async () => {
		const manager = makeManager();
		const prompt = mock.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session, client } = putSession(manager, {
			lastTurnErrored: true,
			lastTurnErrorMessage: "The text field in the ContentBlock is blank",
			lastPromptText: "",
			lastPromptImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
			rpcClient: { prompt },
		});
		manager._recoverBlankTextPoison = mock.fn(async () => session);

		await assert.rejects(() => manager.retryLastPrompt(session.id), /OpenRouter provider authentication failure \(missing-api-key\)/);

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.match(session.promptQueue.peek()?.text ?? "", /Attachments:/i);
		assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(AUTH_SECRET));
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

	it("redrains a rejected steer when abort already settled idle", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const steer = mock.fn(() => pending.promise);
		const prompt = mock.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt, steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "redrain rejected steer");

		assert.equal(steer.mock.callCount(), 1);
		assert.equal(session.promptQueue.length, 0);
		assert.deepEqual(session.inFlightSteerTexts, ["redrain rejected steer"]);

		// Model the race where abort's agent_end has already returned the session to
		// idle and run its drain before the in-flight steer RPC rejects.
		session.status = "idle";
		session.lastTurnErrored = false;
		pending.resolve({ success: false, error: "steer rejected after idle" });
		await assert.rejects(steerPromise, /steer rejected after idle/);

		assert.equal(prompt.mock.callCount(), 1, "recovered steer should redrain without a fresh user prompt");
		assert.equal(prompt.mock.calls[0].arguments[0], "redrain rejected steer");
		assert.equal(session.promptQueue.length, 0);
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

	it("closes extension channels when process_exit terminates a session", () => {
		const manager = makeManager();
		const closeSession = mock.fn(() => {});
		manager.setExtensionChannelServices({ registry: { closeSession } });
		const { session, client } = putSession(manager, { status: "streaming" });

		manager.handleAgentLifecycle(session, { type: "process_exit", code: 17, signal: null });

		assert.equal(closeSession.mock.callCount(), 1);
		assert.deepEqual(closeSession.mock.calls[0].arguments, [session.id, "session-process-exit"]);
		assert.equal(session.status, "terminated");
		assert.deepEqual(
			client.sent.filter((msg) => msg.type === "session_status").map((msg) => msg.status),
			["terminated"],
		);
	});
});
