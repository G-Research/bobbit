/**
 * Fast server-authoritative prompt-queue decisions. A single SessionManager is
 * reused with test-owned sessions and observable clients; no gateway, socket,
 * agent process, or real elapsed-time window is needed to exercise queue order,
 * fan-out, drain, abort, and error-cap behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, test, vi } from "vitest";
import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { createManualClock } from "../harness/clock.ts";

type TestClient = {
	readyState: number;
	bufferedAmount: number;
	sent: any[];
	send(data: string): void;
};

let manager: any;
let sequence = 0;
let stateDir = "";

function client(): TestClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(data: string) { this.sent.push(JSON.parse(data)); },
	};
}

function session(opts: { status?: string; clients?: TestClient[] } = {}) {
	const prompt = vi.fn(async (_text: string, _images?: unknown) => ({ success: true }));
	const steer = vi.fn(async (_text: string) => ({ success: true }));
	const abort = vi.fn(async () => ({ success: true }));
	const listeners = new Set<(event: any) => void>();
	const value: any = {
		id: `queue-session-${++sequence}`,
		title: "Queue decision session",
		titleGenerated: true,
		cwd: process.cwd(),
		status: opts.status ?? "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(opts.clients ?? []),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		rpcClient: {
			prompt,
			steer,
			abort,
			getState: vi.fn(async () => ({ success: true, data: { sessionFile: `${process.cwd()}/queue-test.jsonl` } })),
			onEvent(handler: (event: any) => void) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
		},
	};
	manager.sessions.set(value.id, value);
	return { value, prompt, steer, abort, listeners };
}

function queueUpdates(target: TestClient): any[] {
	return target.sent.filter(message => message.type === "queue_update");
}

function latestQueue(target: TestClient): any[] {
	return queueUpdates(target).at(-1)?.queue ?? [];
}

function endTurn(value: any): void {
	manager.handleAgentLifecycle(value, { type: "agent_end", willRetry: false });
}

beforeAll(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-e2e-author-sidecar-"));
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x36),
	});
	const clock = createManualClock();
	manager = new SessionManager({ clock, skipTitleGeneration: true });
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager._testStore = { get: vi.fn(() => undefined), update: vi.fn(), getAll: vi.fn(() => []) };
});

afterEach(() => manager.sessions.clear());
afterAll(() => {
	manager.sessions.clear();
	fs.rmSync(stateDir, { recursive: true, force: true });
});

test.describe("Queue E2E", () => {
	it("receives queue_update on connect (initially empty)", () => {
		const conn = client();
		const { value } = session({ clients: [conn] });
		conn.send(JSON.stringify({ type: "queue_update", sessionId: value.id, queue: value.promptQueue.toArray() }));
		expect(latestQueue(conn)).toEqual([]);
		expect(queueUpdates(conn).at(-1)?.sessionId).toBe(value.id);
	});

	it("prompt when idle dispatches directly (queue stays empty) @smoke", async () => {
		const conn = client();
		const { value, prompt } = session({ clients: [conn] });
		await manager.enqueuePrompt(value.id, "hello");
		expect(prompt).toHaveBeenCalledWith("hello", undefined);
		expect(value.status).toBe("streaming");
		expect(value.promptQueue.toArray()).toEqual([]);
		expect(queueUpdates(conn).some(update => update.queue.length > 0)).toBe(false);
	});

	it("prompt when busy gets queued, queue_update broadcast @smoke", async () => {
		const conn = client();
		const { value, prompt } = session({ status: "streaming", clients: [conn] });
		await manager.enqueuePrompt(value.id, "queued message");
		expect(prompt).not.toHaveBeenCalled();
		expect(latestQueue(conn)[0]).toMatchObject({ text: "queued message", isSteered: false });
	});

	it("steer_queued dispatches promoted row and leaves normal queue intact", async () => {
		const conn = client();
		const { value, steer } = session({ status: "streaming", clients: [conn] });
		await manager.enqueuePrompt(value.id, "msg A");
		await manager.enqueuePrompt(value.id, "msg B");
		const msgB = value.promptQueue.toArray()[1];
		expect(manager.steerQueued(value.id, msgB.id)).toBe(true);
		await Promise.resolve();
		expect(latestQueue(conn).map((row: any) => row.text)).toEqual(["msg A"]);
		expect(steer).toHaveBeenCalledWith("msg B");
	});

	it("remove_queued removes from queue", async () => {
		const conn = client();
		const { value } = session({ status: "streaming", clients: [conn] });
		await manager.enqueuePrompt(value.id, "to remove");
		const queued = value.promptQueue.toArray()[0];
		expect(manager.removeQueued(value.id, queued.id)).toBe(true);
		expect(latestQueue(conn)).toEqual([]);
	});

	it("multi-client sync: both clients see queue updates", async () => {
		const first = client();
		const second = client();
		const { value } = session({ status: "streaming", clients: [first, second] });
		await manager.enqueuePrompt(value.id, "from client 1");
		expect(latestQueue(first)[0].text).toBe("from client 1");
		expect(latestQueue(second)[0].text).toBe("from client 1");
	});

	it("queue drains after agent finishes turn", async () => {
		const conn = client();
		const { value, prompt } = session({ status: "streaming", clients: [conn] });
		await manager.enqueuePrompt(value.id, "queued follow-up");
		expect(value.promptQueue.length).toBe(1);
		endTurn(value);
		await Promise.resolve();
		expect(value.promptQueue.length).toBe(0);
		expect(prompt).toHaveBeenCalledWith("queued follow-up", undefined);
		expect(latestQueue(conn)).toEqual([]);
	});

	it("story 10: reorder_queue reorders and broadcasts to both clients", async () => {
		const first = client();
		const second = client();
		const { value } = session({ status: "streaming", clients: [first, second] });
		for (const text of ["msg 1", "msg 2", "msg 3"]) await manager.enqueuePrompt(value.id, text);
		const rows = value.promptQueue.toArray();
		manager.reorderQueue(value.id, [rows[2].id, rows[0].id, rows[1].id]);
		expect(latestQueue(first).map((row: any) => row.text)).toEqual(["msg 3", "msg 1", "msg 2"]);
		expect(latestQueue(second).map((row: any) => row.text)).toEqual(["msg 3", "msg 1", "msg 2"]);
	});

	it("story 13: abort with no queue — agent goes idle, no extra messages", () => {
		const conn = client();
		const { value } = session({ status: "aborting", clients: [conn] });
		endTurn(value);
		expect(value.status).toBe("idle");
		expect(value.promptQueue.length).toBe(0);
		expect(conn.sent.some(message => message.type === "event" && message.data?.type === "message_start")).toBe(false);
		expect(conn.sent.some(message => message.type === "queue_update" && message.queue.length > 0)).toBe(false);
	});

	it("story 35: error keeps queue intact, does not drain", async () => {
		const conn = client();
		const { value, prompt } = session({ clients: [conn] });
		value.lastTurnErrored = true;
		value.lastTurnErrorMessage = "mock provider error";
		value.consecutiveErrorTurns = 3;
		await manager.enqueuePrompt(value.id, "queued after cap A");
		await manager.enqueuePrompt(value.id, "queued after cap B");
		expect(value.promptQueue.toArray().map((row: any) => row.text)).toEqual(["queued after cap A", "queued after cap B"]);
		expect(prompt).not.toHaveBeenCalled();
		expect(value.status).toBe("idle");
	});

	it("story 36 (updated): error + cap reached, then retry drains parked messages", async () => {
		const { value, prompt } = session();
		value.lastPromptText = "failed turn";
		value.lastTurnErrored = true;
		value.lastTurnErrorMessage = "mock provider error";
		value.consecutiveErrorTurns = 3;
		await manager.enqueuePrompt(value.id, "queued msg after cap");
		expect(value.promptQueue.toArray().map((row: any) => row.text)).toEqual(["queued msg after cap"]);
		await manager.retryLastPrompt(value.id);
		expect(value.promptQueue.toArray().map((row: any) => row.text)).toEqual(["queued msg after cap"]);
		endTurn(value);
		await Promise.resolve();
		expect(value.promptQueue.length).toBe(0);
		expect(prompt.mock.calls.map((call: any[]) => call[0])).toEqual(["[System]: failed turn", "queued msg after cap"]);
	});

	it("story 37 (updated): error state — implicit unstick dispatches new message (under cap)", async () => {
		const { value, prompt } = session();
		value.lastTurnErrored = true;
		value.lastTurnErrorMessage = "mock provider error";
		value.consecutiveErrorTurns = 1;
		await manager.enqueuePrompt(value.id, "continue please");
		expect(value.promptQueue.length).toBe(0);
		expect(value.status).toBe("streaming");
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0][0]).toContain("continue please");
	});
});
