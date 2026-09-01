import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { EventBuffer } from "../../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../../src/server/agent/prompt-queue.ts";
import { RpcBridge } from "../../../src/server/agent/rpc-bridge.ts";
import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import { handleWebSocketConnection } from "../../../src/server/ws/handler.ts";
import { createManualClock } from "../../../tests/support/harnesses/shared/clock.ts";

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	readonly sent: any[] = [];

	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		callback?.();
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", code, reason);
	}
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${label}`);
}

function makeManager(root: string): any {
	const clock = createManualClock(1_700_000_000_000);
	const manager: any = new SessionManager({
		clock,
		stateDir: root,
		projectContextManager: {} as any,
		skipTitleGeneration: true,
	});
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager.projectContextManager = null;
	manager._testStore = {
		get: vi.fn(() => undefined),
		update: vi.fn(() => {}),
	};
	manager.getSessionCostUpdate = () => undefined;
	manager.getImageModelForSession = () => undefined;
	manager.withSessionCostInState = (_sessionId: string, data: unknown) => data;
	manager.getPendingToolPermission = () => undefined;
	manager.getProjectContextManager = () => undefined;
	return manager;
}

function connect(ws: FakeWebSocket, sessionId: string, manager: SessionManager): void {
	handleWebSocketConnection(
		ws as any,
		sessionId,
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		manager,
		"unused-token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		undefined,
		true,
	);
}

const roots: string[] = [];
const managers: any[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (managers.length > 0) {
		const manager = managers.pop();
		manager.sessionsWithConnectedClients?.clear?.();
		manager.sessions?.clear?.();
	}
	while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function testRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
	roots.push(root);
	return root;
}

function commandErrors(ws: FakeWebSocket): any[] {
	return ws.sent.filter((frame) => frame.type === "error" && frame.code === "COMMAND_ERROR");
}

describe("gateway session lifecycle races", () => {
	it("uses persisted state while a dormant attach is still restoring instead of surfacing Agent process not running", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const root = testRoot("gateway-dormant-state-race");
		const manager = makeManager(root);
		managers.push(manager);
		const sessionId = "dormant-state-race";
		const restoreStarted = deferred<void>();
		const releaseRestore = deferred<void>();
		const persisted = {
			id: sessionId,
			title: "Dormant state race",
			cwd: root,
			agentSessionFile: path.join(root, "agent-session.jsonl"),
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			effectiveThinkingLevel: "high",
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		manager._testStore.get = vi.fn((id: string) => id === sessionId ? persisted : undefined);
		manager.restoreSession = vi.fn(async () => {
			restoreStarted.resolve();
			await releaseRestore.promise;
		});

		const buffered = new EventBuffer();
		buffered.push({ type: "message_end", message: { role: "assistant", content: "previous reply" } });
		manager.sessions.set(sessionId, {
			id: sessionId,
			title: persisted.title,
			cwd: root,
			status: "terminated",
			statusVersion: 3,
			dormant: true,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			// A real stopped RpcBridge reproduces sendCommand's synchronous throw.
			rpcClient: new RpcBridge({}),
			eventBuffer: buffered,
			promptQueue: new PromptQueue(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
		});

		const ws = new FakeWebSocket();
		connect(ws, sessionId, manager);
		try {
			ws.emit("message", JSON.stringify({ type: "auth", token: "ignored" }));
			await restoreStarted.promise;
			await waitFor(
				() => commandErrors(ws).length > 0 || ws.sent.some((frame) => frame.type === "state"),
				"dormant attach state or command error",
			);

			const errors = commandErrors(ws);
			assert.equal(
				errors.length,
				0,
				`COMMAND_ERROR: ${errors[0]?.message ?? "Agent process not running"}`,
			);
			const fallback = ws.sent.find((frame) => frame.type === "state");
			assert.equal(fallback?.data?.model?.provider, persisted.modelProvider);
			assert.equal(fallback?.data?.model?.id, persisted.modelId);
			assert.equal(fallback?.data?.thinkingLevel, persisted.effectiveThinkingLevel);
		} finally {
			releaseRestore.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			ws.close();
		}
	});

	it("refetches the canonical session for get_state and falls back when its bridge throws synchronously", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const root = testRoot("gateway-canonical-state-race");
		const manager = makeManager(root);
		managers.push(manager);
		const sessionId = "canonical-state-race";
		const persisted = {
			id: sessionId,
			title: "Canonical state race",
			cwd: root,
			agentSessionFile: path.join(root, "agent-session.jsonl"),
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			effectiveThinkingLevel: "high",
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		manager._testStore.get = vi.fn((id: string) => id === sessionId ? persisted : undefined);
		const staleGetState = vi.fn(async () => ({ success: true, data: { generation: "stale" } }));
		const stale = {
			id: sessionId,
			title: persisted.title,
			cwd: root,
			status: "idle",
			statusVersion: 4,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			rpcClient: { getState: staleGetState },
			eventBuffer: new EventBuffer(),
			promptQueue: new PromptQueue(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
		};
		const canonical = {
			...stale,
			statusVersion: 5,
			clients: new Set(),
			rpcClient: new RpcBridge({}),
		};
		manager.sessions.set(sessionId, stale);

		const ws = new FakeWebSocket();
		connect(ws, sessionId, manager);
		ws.emit("message", JSON.stringify({ type: "auth", token: "ignored" }));
		await waitFor(() => ws.sent.some((frame) => frame.type === "auth_ok"), "websocket authentication");

		const originalGetSession = manager.getSession.bind(manager);
		let getSessionCalls = 0;
		const getSession = vi.spyOn(manager, "getSession").mockImplementation((id: unknown) => {
			if (typeof id !== "string") return undefined;
			if (id !== sessionId) return originalGetSession(id);
			getSessionCalls += 1;
			return getSessionCalls === 1 ? stale : canonical;
		});
		const cursor = ws.sent.length;
		ws.emit("message", JSON.stringify({ type: "get_state" }));
		await waitFor(
			() => commandErrors(ws).length > 0 || ws.sent.slice(cursor).some((frame) => frame.type === "state"),
			"canonical get_state fallback",
		);

		assert.equal(staleGetState.mock.calls.length, 0, "the stale lifecycle generation must not receive getState");
		assert.equal(commandErrors(ws).length, 0, "a synchronous canonical bridge throw must remain a state fallback");
		const fallback = ws.sent.slice(cursor).find((frame) => frame.type === "state");
		assert.equal(fallback?.data?.model?.provider, persisted.modelProvider);
		assert.equal(fallback?.data?.model?.id, persisted.modelId);
		getSession.mockRestore();
		ws.close();
	});

});
