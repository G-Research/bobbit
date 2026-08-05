import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, it, vi } from "vitest";

import { createManualClock } from "../harness/clock.js";
import { createMemFs } from "../harness/mem-fs.js";
import { PromptDeliveryProtocolError } from "../../src/server/agent/rpc-bridge.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { SessionManager, restorePromptAuthorBindings } from "../../src/server/agent/session-manager.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import { initAuthorSidecarDir, readAuthorSidecar } from "../../src/server/agent/author-sidecar.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prompt-protocol-"));
initAuthorSidecarDir(root, { secretsDir: root, hmacKey: Buffer.alloc(32, 0x42) });
const managers: any[] = [];

function makeManager(store: any = { update: vi.fn(), get: vi.fn(() => undefined) }): any {
	const clock = createManualClock(1_700_000_000_000);
	const manager: any = new SessionManager({ clock, stateDir: root, projectContextManager: {} as any });
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager.projectContextManager = null;
	manager._testClock = clock;
	manager._testStore = store;
	managers.push(manager);
	return manager;
}

function putSession(manager: any, id: string, rpcClient: any, overrides: Record<string, any> = {}): any {
	const session = {
		id,
		title: id,
		titleGenerated: true,
		cwd: root,
		status: "idle",
		statusVersion: 0,
		createdAt: manager._testClock.now(),
		lastActivity: manager._testClock.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		setupComplete: true,
		rpcClient,
		...overrides,
	};
	manager.sessions.set(id, session);
	return session;
}

function persisted(id: string): PersistedSession {
	return {
		id,
		title: id,
		cwd: root,
		agentSessionFile: path.join(root, `${id}.jsonl`),
		createdAt: 1,
		lastActivity: 1,
	};
}

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function userEcho(manager: any, session: any, id: string, content: string): void {
	const event = manager.prepareVisibleAgentEvent(session, {
		type: "message_end",
		message: { id, role: "user", content },
	});
	manager.handleAgentLifecycle(session, event);
}

function deliveryAck(manager: any, session: any, promptId: string, body: string): void {
	manager.handleAgentLifecycle(session, {
		type: "entry_appended",
		entry: {
			type: "custom",
			customType: "bobbit:prompt-delivery-ack-v1",
			data: { protocolVersion: 1, promptId, digest: digest(body) },
		},
	});
}

async function flush(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		manager.sessions?.clear?.();
		manager.sessionsWithConnectedClients?.clear?.();
	}
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("SessionManager stable prompt settlement and redrive", () => {
	it("does not settle direct delivery at message_end and clears it only from a matching post-persistence ACK", async () => {
		const promptWithId = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const manager = makeManager();
		const session = putSession(manager, "stable-direct", {
			promptDeliveryProtocol: "v1",
			promptWithId,
			prompt: vi.fn(),
		});

		await manager.enqueuePrompt(session.id, "one durable direct prompt");
		const row = session.promptQueue.peek();
		assert.ok(row);
		assert.equal(promptWithId.mock.calls[0][1], row.id);
		userEcho(manager, session, "u-direct", "one durable direct prompt");
		assert.equal(session.promptQueue.length, 1, "message_end happens before Pi transcript persistence");

		deliveryAck(manager, session, row.id, "one durable direct prompt");
		assert.equal(session.promptQueue.length, 0);
	});

	it("redrives the same direct id/body after append-before-ACK and reconciles ACK-before-store-cleanup", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/stable-redrive";
		const id = "stable-crash";
		const store = new SessionStore(stateDir, memfs);
		store.put(persisted(id));
		await store.flushAsync();

		const firstPrompt = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const firstManager = makeManager(store);
		const first = putSession(firstManager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId: firstPrompt,
			prompt: vi.fn(),
		});
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		await firstManager.enqueuePrompt(id, "crash-window body", { source: "system", author: systemAuthor });
		const original = first.promptQueue.peek()!;
		userEcho(firstManager, first, "u-crash", "[System]: crash-window body");
		await store.flushAsync();

		const restartedStore = new SessionStore(stateDir, memfs);
		const disk = restartedStore.get(id)!;
		assert.deepEqual(disk.messageQueue?.map((row) => row.id), [original.id]);
		const redrive = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const restartedManager = makeManager(restartedStore);
		const restarted = putSession(restartedManager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId: redrive,
			prompt: vi.fn(),
		}, { promptQueue: new PromptQueue(disk.messageQueue) });
		restorePromptAuthorBindings(restarted, readAuthorSidecar(id));
		restartedManager.drainQueue(restarted);
		await waitFor(() => redrive.mock.calls.length === 1, "restart did not redrive durable prompt");
		assert.deepEqual(redrive.mock.calls[0]?.slice(0, 2), ["[System]: crash-window body", original.id]);

		// Fault the cleanup publication after Pi's durable ACK. This is the exact
		// ACK-before-SessionStore-cleanup crash window; canonical disk stays at the
		// pre-ACK row without leaving a competing stale SessionStore writer alive.
		restartedManager._testStore = {
			get: restartedStore.get.bind(restartedStore),
			update: vi.fn(),
			flushAsync: vi.fn(async () => {}),
		};
		deliveryAck(restartedManager, restarted, original.id, "[System]: crash-window body");
		assert.equal(restarted.promptQueue.length, 0);
		// A hard crash before SessionStore cleanup publication leaves the row on
		// disk, but replaying the durable ACK settles it again without a model turn.
		const cleanupCrashStore = new SessionStore(stateDir, memfs);
		const cleanupCrash = cleanupCrashStore.get(id)!;
		const finalManager = makeManager(cleanupCrashStore);
		const noDuplicate = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const finalSession = putSession(finalManager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId: noDuplicate,
			prompt: vi.fn(),
		}, { promptQueue: new PromptQueue(cleanupCrash.messageQueue) });
		restorePromptAuthorBindings(finalSession, readAuthorSidecar(id));
		deliveryAck(finalManager, finalSession, original.id, "[System]: crash-window body");
		finalManager.drainQueue(finalSession);
		assert.equal(noDuplicate.mock.calls.length, 0);
	});

	it("fences one live steer reservation across concurrent tool and terminal boundaries until ACK", async () => {
		let resolveSteer!: (value: any) => void;
		const steerWithId = vi.fn(() => new Promise((resolve) => { resolveSteer = resolve; }));
		const manager = makeManager();
		const session = putSession(manager, "stable-steer-fence", {
			promptDeliveryProtocol: "v1",
			steerWithId,
			promptWithId: vi.fn(),
			prompt: vi.fn(),
		}, { status: "streaming" });
		const row = session.promptQueue.enqueue("one live steer", { isSteered: true });

		const dispatch = manager._dispatchSteer(session, session.promptQueue.peekAllSteered());
		await waitFor(() => steerWithId.mock.calls.length === 1, "initial steer did not dispatch");
		manager.handleAgentLifecycle(session, { type: "tool_execution_end" });
		manager.handleAgentLifecycle(session, { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
		assert.equal(steerWithId.mock.calls.length, 1, "boundaries cannot redispatch while the RPC owns the reservation");

		resolveSteer({ success: true });
		await dispatch;
		assert.equal((session.promptQueue.peek() as any)?.deliveryState, "awaiting-ack");
		manager.handleAgentLifecycle(session, { type: "tool_execution_end" });
		manager.handleAgentLifecycle(session, { type: "agent_end" });
		await flush();
		assert.equal(steerWithId.mock.calls.length, 1, "awaiting-ACK rows stay fenced for the live generation");
		assert.equal(session.promptQueue.peek()?.id, row.id);

		deliveryAck(manager, session, (session.promptQueue.peek() as any).deliveryPromptId, "one live steer");
		assert.equal(session.promptQueue.length, 0);
	});

	it("preserves batch row ids, stable prompt id, order, and prefixed body through an ambiguous steer failure", async () => {
		const firstCalls: any[][] = [];
		const manager = makeManager();
		const session = putSession(manager, "stable-batch", {
			promptDeliveryProtocol: "v1",
			steerWithId: vi.fn(async (...args: any[]) => {
				firstCalls.push(args);
				throw new PromptDeliveryProtocolError("reservation-failed", "ambiguous reservation failure");
			}),
			promptWithId: vi.fn(async (...args: any[]) => {
				firstCalls.push(args);
				return { success: true };
			}),
			prompt: vi.fn(),
		}, { status: "streaming" });
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const first = session.promptQueue.enqueue("first", { isSteered: true, source: "system", author });
		const second = session.promptQueue.enqueue("second", { isSteered: true, source: "system", author });

		await manager._dispatchSteer(session, session.promptQueue.peekAllSteered());
		const retryRows = session.promptQueue.toArray();
		assert.deepEqual(retryRows.map((row: any) => row.id), [first.id, second.id]);
		assert.equal(retryRows[0].deliveryPromptId, retryRows[1].deliveryPromptId);
		const stableId = retryRows[0].deliveryPromptId;
		assert.deepEqual(firstCalls[0], ["[System]: first\nsecond", stableId]);

		session.status = "idle";
		manager.drainQueue(session);
		await flush();
		assert.deepEqual(firstCalls[1]?.slice(0, 2), ["[System]: first\nsecond", stableId]);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [first.id, second.id]);
	});
});
