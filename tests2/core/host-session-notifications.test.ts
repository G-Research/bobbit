import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { guardProcessEnv } from "./helpers/env-guard.js";

guardProcessEnv();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-session-notifications-"));
process.env.BOBBIT_DIR = root;

const { SessionManager, emitSessionEvent } = await import("../../src/server/agent/session-manager.ts");
const { SessionStore } = await import("../../src/server/agent/session-store.ts");
const { broadcastStatus } = await import("../../src/server/agent/session-status.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { HostNotificationDispatcher } = await import("../../src/server/extension-host/host-notification-dispatcher.ts");

const managers: any[] = [];

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions.clear();
	}
});

function makeHarness() {
	const facts: Array<{ name: string; publication: any; frameCount: number }> = [];
	const sent: any[] = [];
	const dispatcher = new HostNotificationDispatcher({
		resolveSessionProject: (sessionId) => sessionId === "session-a" ? "project-a" : undefined,
	});
	const publisher = {
		publish(name: string, publication: any) {
			const validated = dispatcher.publish(name as any, publication);
			if (validated) facts.push({ name, publication: validated, frameCount: sent.length });
			return validated;
		},
	};
	const manager: any = new SessionManager({ hostNotificationPublisher: publisher });
	managers.push(manager);
	manager._testStore = { update: vi.fn(), get: vi.fn(() => undefined) };
	const client = {
		readyState: 1,
		bufferedAmount: 0,
		send(data: string) { sent.push(JSON.parse(data)); },
	};
	const session: any = {
		id: "session-a",
		projectId: "project-a",
		title: "Session A",
		cwd: root,
		status: "idle",
		statusVersion: 0,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set([client]),
		rpcClient: { prompt: vi.fn(), getState: vi.fn(async () => ({ success: true, data: {} })) },
		eventBuffer: new EventBuffer(),
		promptQueue: new PromptQueue(),
		unsubscribe: () => {},
		isCompacting: false,
		setupComplete: true,
		lastPromptSource: "user",
	};
	manager.sessions.set(session.id, session);
	manager.setHostNotificationPublisher(publisher);
	return { manager, session, facts, sent, dispatcher };
}

describe("authoritative session host notifications", () => {
	it("fences session creation listeners on successful initial persistence", async () => {
		const manager: any = new SessionManager();
		managers.push(manager);
		const publication = deferred<void>();
		const calls: string[] = [];
		manager.addCreationListener((session: any) => calls.push(session.id));
		const session = { id: "created-after-commit" } as any;
		const notifying = manager.notifySessionCreated(session, {
			flushAsync: () => publication.promise,
		} as any);

		await Promise.resolve();
		assert.deepEqual(calls, [], "listeners must remain silent before the store barrier settles");
		publication.resolve();
		await notifying;
		assert.deepEqual(calls, [session.id]);
	});

	it("treats a synchronous injected recording store as an already-committed seam", async () => {
		const manager: any = new SessionManager();
		managers.push(manager);
		const calls: string[] = [];
		manager.addCreationListener((session: any) => calls.push(session.id));
		await manager.notifySessionCreated({ id: "sync-fixture-creation" } as any, {
			put: () => {},
			update: () => {},
		} as any);
		assert.deepEqual(calls, ["sync-fixture-creation"]);
	});

	it("keeps session creation listeners silent when a real store's atomic flush fails", async () => {
		const manager: any = new SessionManager();
		managers.push(manager);
		const calls: string[] = [];
		manager.addCreationListener((session: any) => calls.push(session.id));
		const store = manager._testStore;
		assert.ok(store instanceof SessionStore, "fixture must exercise the production SessionStore fence");
		const flush = vi.spyOn(store, "flushAsync").mockRejectedValueOnce(new Error("injected initial persistence failure"));
		try {
			await assert.rejects(
				manager.notifySessionCreated({ id: "failed-creation" } as any, store),
				/injected initial persistence failure/,
			);
			assert.deepEqual(calls, []);
		} finally {
			flush.mockRestore();
		}
	});

	it("publishes status only after the legacy frame and suppresses unchanged status", () => {
		const { session, facts, sent } = makeHarness();
		broadcastStatus(session, "streaming", { streamingStartedAt: 10 });

		assert.equal(sent.length, 1);
		assert.deepEqual(facts.map((fact) => fact.name), ["statusChanged", "sessionStatusChanged"]);
		assert.ok(facts.every((fact) => fact.frameCount === 1), "fact must follow legacy frame queueing");
		assert.deepEqual(facts[0].publication.payload, {
			previousStatus: "idle",
			status: "streaming",
			statusVersion: 1,
		});

		broadcastStatus(session, "streaming", { streamingStartedAt: 10 });
		assert.equal(sent.length, 2, "legacy same-status compatibility frame remains");
		assert.equal(facts.length, 2, "same-status write is not a committed transition fact");
	});

	it("reuses final-turn fences and reports explicit success, error, and abort outcomes once", () => {
		const { manager, session, facts } = makeHarness();
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: true, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnStarted").length, 1);
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").length, 0);

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		const completed = facts.filter((fact) => fact.name === "turnCompleted");
		assert.equal(completed.length, 1);
		assert.equal(completed[0].publication.payload.outcome, "succeeded");
		assert.equal(session.completedTurnCount, 1);

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "assistant-error", role: "assistant", stopReason: "error", errorMessage: "PRIVATE_PROVIDER_BODY" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").at(-1)?.publication.payload.outcome, "errored");

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		broadcastStatus(session, "aborting");
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
		assert.equal(facts.filter((fact) => fact.name === "turnCompleted").at(-1)?.publication.payload.outcome, "aborted");
		assert.equal(JSON.stringify(facts).includes("PRIVATE_PROVIDER_BODY"), false);
	});

	it("publishes tool lifecycle facts without an installed interceptor and fences completion on the accepted result", () => {
		const { manager, session, facts, dispatcher } = makeHarness();
		assert.equal(manager.hostInterceptors, undefined, "precondition: lifecycle observation is not interceptor-gated");
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		assert.equal(manager.dispatchHostInterceptor(session.id, "beforeToolCall", {
			toolCallId: "call-1", toolName: "read", args: {},
		}), undefined);
		manager.markToolCallAdmitted(session.id, "call-1", "read");
		assert.equal(facts.filter((fact) => fact.name === "toolCallStarted").length, 1);
		manager.handleAgentLifecycle(session, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			result: { content: [{ type: "text", text: "PRIVATE_TOOL_BODY" }] },
		});
		assert.equal(facts.filter((fact) => fact.name === "toolCallCompleted").length, 0);

		emitSessionEvent(session, {
			type: "message_end",
			message: {
				id: "result-message",
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: true,
				content: [{ type: "text", text: "PRIVATE_TOOL_BODY" }],
			},
		});

		assert.deepEqual(facts.slice(-2).map((fact) => fact.name), ["messageAppended", "toolCallCompleted"]);
		assert.equal(facts.filter((fact) => fact.name === "toolCallStarted").length, 1);
		assert.equal(facts.filter((fact) => fact.name === "toolCallCompleted").length, 1);
		assert.deepEqual(facts.at(-1)?.publication.payload, {
			toolCallId: "call-1",
			toolName: "read",
			status: "errored",
			durationMs: facts.at(-1)?.publication.payload.durationMs,
			errorStatus: "handler_error",
		});
		assert.equal(JSON.stringify(facts).includes("PRIVATE_TOOL_BODY"), false);
		assert.deepEqual(dispatcher.getDiagnostics(), [], "session facts must satisfy the canonical dispatcher schema");
		assert.equal(session.hostToolCallLifecycle.size, 0);
	});
});
