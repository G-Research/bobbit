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
});
