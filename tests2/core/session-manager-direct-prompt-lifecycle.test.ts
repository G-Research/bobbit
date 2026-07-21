import { afterAll, afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createManualClock } from "../harness/clock.js";

const VIRTUAL_STATE_DIR = path.resolve("/.bobbit-test/session-direct-prompt");
const VIRTUAL_SIDECAR_DIR = path.join(VIRTUAL_STATE_DIR, "author-sidecar");
const virtualSidecarFiles = new Map<string, string>();

function virtualPath(value: fs.PathLike): string {
	return path.resolve(String(value));
}

function isVirtualSidecarPath(value: fs.PathLike): boolean {
	const target = virtualPath(value);
	return target === VIRTUAL_SIDECAR_DIR || target.startsWith(`${VIRTUAL_SIDECAR_DIR}${path.sep}`);
}

const {
	SessionManager,
	dispatchTrackedSystemPrompt,
	prepareArchivedMessageSnapshot,
	restorePromptAuthorBindings,
} = await import("../../src/server/agent/session-manager.ts");
const { sendDelegatePrompt } = await import("../../src/server/agent/session-setup.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
	purgeAuthorSidecar,
	readAuthorSidecar,
} = await import("../../src/server/agent/author-sidecar.ts");

// Author persistence is exercised through the real sidecar API, backed by a
// tiny in-memory filesystem. Unexpected file access fails instead of silently
// touching Defender-scanned disk in this tier-1 logic suite.
const fsSpies = [
	vi.spyOn(fs, "existsSync").mockImplementation((target) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem read: ${String(target)}`);
		const key = virtualPath(target);
		return key === VIRTUAL_SIDECAR_DIR || virtualSidecarFiles.has(key);
	}),
	vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem write: ${String(target)}`);
		return undefined;
	}) as typeof fs.mkdirSync),
	vi.spyOn(fs, "appendFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
		if (typeof target === "number" || !isVirtualSidecarPath(target)) {
			throw new Error(`unexpected filesystem write: ${String(target)}`);
		}
		const key = virtualPath(target);
		virtualSidecarFiles.set(key, `${virtualSidecarFiles.get(key) ?? ""}${String(data)}`);
	}) as typeof fs.appendFileSync),
	vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor) => {
		if (typeof target === "number" || !isVirtualSidecarPath(target)) {
			throw new Error(`unexpected filesystem read: ${String(target)}`);
		}
		return virtualSidecarFiles.get(virtualPath(target)) ?? "";
	}) as typeof fs.readFileSync),
	vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem write: ${String(target)}`);
		virtualSidecarFiles.delete(virtualPath(target));
	}),
];
initAuthorSidecarDir(VIRTUAL_STATE_DIR);

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
	const clock = createManualClock(1_700_000_000_000);
	// A truthy project-context seam skips every constructor-owned disk store. The
	// tests then install the small in-memory session-store surface they exercise.
	const manager: any = new SessionManager({
		clock,
		stateDir: VIRTUAL_STATE_DIR,
		projectContextManager: {} as any,
	});
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager.projectContextManager = null;
	manager._testClock = clock;
	manager._testStore = {
		update: vi.fn(() => {}),
		get: vi.fn(() => undefined),
	};
	managers.push(manager);
	return manager;
}

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		manager._testClock.clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	for (const session of manager.sessions?.values?.() ?? []) {
		if (session.pendingAutoRetryTimer) manager._testClock.clearTimeout(session.pendingAutoRetryTimer);
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
		cwd: "/virtual/project",
		status: "idle",
		statusVersion: 0,
		createdAt: manager._testClock.now(),
		lastActivity: manager._testClock.now(),
		clients: new Set([client]),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		streamingStartedAt: undefined,
		modelProvider: "openrouter",
		setupComplete: true,
		rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
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

function autoRetryCancelledEvents(session: any): any[] {
	return session.eventBuffer
		.getAll()
		.map((entry: any) => entry.event)
		.filter((event: any) => event?.type === "auto_retry_cancelled");
}

function assertLocalUserSteerLedger(ledger: any, text: string): void {
	assert.ok(Array.isArray(ledger));
	assert.equal(ledger.length, 1);
	assert.equal(ledger[0]?.text, text);
	assert.equal(ledger[0]?.source, "user");
	assert.match(ledger[0]?.promptId ?? "", /^steer:[a-f0-9]{64}$/);
	assert.deepEqual(ledger[0]?.author, {
		kind: "user",
		id: "user:local",
		label: "User",
	});
}

async function flushAsyncWork(): Promise<void> {
	// Promise continuations in dispatch/recovery are deliberately layered. Drain
	// a fixed number of microtask turns without a real timer or event-loop sleep.
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

afterEach(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
	virtualSidecarFiles.clear();
});

afterAll(() => {
	for (const spy of fsSpies) spy.mockRestore();
});

describe("SessionManager direct idle prompt lifecycle", () => {
	it("durably tracks direct delegate, verification, and restart system producers without changing bytes", async () => {
		const manager = makeManager();
		const delegateText = "Execute the task described in your system prompt. Follow the instructions carefully.";
		const delegatePrompt = vi.fn(async (_text: string) => {
			delegateSession.status = "streaming";
			return { success: true };
		});
		const { session: delegateSession } = putSession(manager, {
			id: "s-delegate-producer",
			rpcClient: { prompt: delegatePrompt },
		});

		await sendDelegatePrompt(delegateSession, "not model-facing", 1_000);
		assert.deepEqual(delegatePrompt.mock.calls[0], [delegateText]);
		const delegateBinding = readAuthorSidecar(delegateSession.id)[0];
		assert.equal(delegateBinding.modelText, delegateText);
		assert.equal(delegateBinding.source, "system");
		assert.deepEqual(delegateBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const ownerAuthor = { kind: "agent", id: "session:delegate-owner", label: "Delegate owner" } as const;
		const ownerPrompt = vi.fn(async (_text: string) => {
			ownerDelegate.status = "streaming";
			return { success: true };
		});
		const { session: ownerDelegate } = putSession(manager, {
			id: "s-owner-delegate-producer",
			rpcClient: { prompt: ownerPrompt },
		});
		await sendDelegatePrompt(ownerDelegate, "still not model-facing", 1_000, {
			source: "agent",
			author: ownerAuthor,
		});
		assert.deepEqual(ownerPrompt.mock.calls[0], [delegateText]);
		const ownerBinding = readAuthorSidecar(ownerDelegate.id)[0];
		assert.equal(ownerBinding.modelText, delegateText);
		assert.equal(ownerBinding.source, "agent");
		assert.deepEqual(ownerBinding.author, ownerAuthor);

		const malformedPrompt = vi.fn(async (_text: string) => {
			malformedDelegate.status = "streaming";
			return { success: true };
		});
		const { session: malformedDelegate } = putSession(manager, {
			id: "s-malformed-delegate-producer",
			rpcClient: { prompt: malformedPrompt },
		});
		await sendDelegatePrompt(malformedDelegate, "still not model-facing", 1_000, {
			source: "agent",
			author: { kind: "system", id: "system:forged", label: "Forged" },
		});
		const malformedBinding = readAuthorSidecar(malformedDelegate.id)[0];
		assert.equal(malformedBinding.source, "system");
		assert.deepEqual(malformedBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const verificationText = "Return the verification_result now.";
		const verificationPrompt = vi.fn(async () => ({ success: true }));
		const { session: verificationSession } = putSession(manager, {
			id: "s-verification-producer",
			rpcClient: { prompt: verificationPrompt },
		});
		await dispatchTrackedSystemPrompt(verificationSession, verificationText, {
			source: "verification",
			now: () => manager._testClock.now(),
		});
		assert.deepEqual(verificationPrompt.mock.calls[0], [verificationText]);
		const verificationBinding = readAuthorSidecar(verificationSession.id)[0];
		assert.equal(verificationBinding.modelText, verificationText);
		assert.equal(verificationBinding.source, "verification");
		assert.deepEqual(verificationBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const restartPrompt = vi.fn(async (_text: string) => ({ success: true }));
		const { session: restartSession } = putSession(manager, {
			id: "s-restart-producer",
			rpcClient: { promptWhenReady: restartPrompt },
		});
		assert.equal(await manager._dispatchBootContinuation(restartSession), true);
		assert.equal(restartPrompt.mock.calls.length, 1);
		const restartText = restartPrompt.mock.calls[0][0];
		assert.match(restartText, /infrastructure server restarted while you were mid-turn/i);
		const restartBinding = readAuthorSidecar(restartSession.id)[0];
		assert.equal(restartBinding.modelText, restartText);
		assert.equal(restartBinding.source, "system");
		assert.deepEqual(restartBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });
	});

	it.each([
		{ ordering: "agent-start-before-echo", source: "verification", author: { kind: "system", id: "system:bobbit", label: "Bobbit" } },
		{ ordering: "echo-before-rejection", source: "verification", author: { kind: "system", id: "system:bobbit", label: "Bobbit" } },
		{ ordering: "agent-start-before-echo", source: "agent", author: { kind: "agent", id: "session:caller", label: "Caller" } },
		{ ordering: "echo-before-rejection", source: "agent", author: { kind: "agent", id: "session:caller", label: "Caller" } },
	] as const)(
		"keeps an accepted queued $author.kind author when the late RPC rejection arrives $ordering",
		async ({ ordering, source, author }) => {
			const manager = makeManager();
			const pending = deferred<any>();
			const prompt = vi.fn(() => pending.promise);
			const { session } = putSession(manager, {
				id: `s-late-ack-${author.kind}-${ordering}`,
				rpcClient: { prompt },
			});
			const text = `${author.kind}-owned queued prompt`;
			const queued = session.promptQueue.enqueue(text, { source, author });

			manager.drainQueue(session);
			assert.equal(prompt.mock.calls.length, 1);
			assert.deepEqual(prompt.mock.calls[0], [text, undefined]);

			if (ordering === "agent-start-before-echo") {
				manager.handleAgentLifecycle(session, { type: "agent_start" });
			} else {
				const echo: any = manager.prepareVisibleAgentEvent(session, {
					type: "message_end",
					message: { id: `m-${ordering}`, role: "user", content: text },
				});
				assert.deepEqual(echo.message.author, author);
				manager.handleAgentLifecycle(session, echo);
			}

			pending.resolve({ success: false, error: "late negative acknowledgement" });
			await flushAsyncWork();

			assert.equal(session.promptQueue.length, 0, "an observed turn must not be recovered");
			const afterAck = readAuthorSidecar(session.id).find((row) => row.promptId === queued.id);
			assert.notEqual(afterAck?.settlement?.outcome, "cancelled");

			if (ordering === "agent-start-before-echo") {
				const echo: any = manager.prepareVisibleAgentEvent(session, {
					type: "message_end",
					message: { id: `m-${ordering}`, role: "user", content: text },
				});
				assert.deepEqual(echo.message.author, author);
				manager.handleAgentLifecycle(session, echo);
			}
			assert.equal(
				readAuthorSidecar(session.id).find((row) => row.promptId === queued.id)?.settlement?.outcome,
				"echoed",
				"late rejection must not overwrite the durable echoed settlement",
			);
		},
	);

	it("correlates archived duplicate prompts by outer id/timestamp and strips correlation-only fields", () => {
		const manager = makeManager();
		const sessionId = "s-archived-correlation";
		const text = "duplicate archived bytes";
		const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const records = [
			{ promptId: "p-id-agent", dispatchedAt: 1, author: agentAuthor, messageId: "outer-id-agent", settledAt: 100 },
			{ promptId: "p-id-system", dispatchedAt: 2, author: systemAuthor, messageId: "outer-id-system", settledAt: 200 },
			{ promptId: "p-ts-agent", dispatchedAt: 3, author: agentAuthor, messageTimestamp: 30_000, settledAt: 30_000 },
			{ promptId: "p-ts-system", dispatchedAt: 4, author: systemAuthor, messageTimestamp: 40_000, settledAt: 40_000 },
		];
		for (const record of records) {
			appendPromptAuthorDispatch(sessionId, {
				promptId: record.promptId,
				dispatchedAt: record.dispatchedAt,
				modelText: text,
				source: record.author.kind === "agent" ? "agent" : "system",
				author: record.author,
			});
			appendPromptAuthorSettlement(sessionId, {
				promptId: record.promptId,
				settledAt: record.settledAt,
				outcome: "echoed",
				...(record.messageId ? { messageId: record.messageId } : {}),
				...(record.messageTimestamp ? { messageTimestamp: record.messageTimestamp } : {}),
			});
		}

		const archived = prepareArchivedMessageSnapshot([
			{
				type: "message",
				id: "outer-id-system",
				timestamp: 200,
				message: { role: "user", content: text, id: "inner-id", timestamp: 999 },
			},
			{ type: "message", id: "outer-id-agent", timestamp: 100, message: { role: "user", content: text } },
			{ type: "message", id: "unsettled-ts-system", timestamp: 40_000, message: { role: "user", content: text } },
			{ type: "message", id: "unsettled-ts-agent", ts: 30_000, message: { role: "user", content: text } },
		]);
		const visible = manager.buildVisibleMessageSnapshot(sessionId, archived) as any[];

		assert.deepEqual(visible.map((message) => message.author), [systemAuthor, agentAuthor, systemAuthor, agentAuthor]);
		assert.equal(visible[0].id, "inner-id", "the original inner id remains visible");
		assert.equal(visible[0].timestamp, 999, "the original inner timestamp remains visible");
		for (const message of visible.slice(1)) {
			assert.equal("id" in message, false, "outer entry id is correlation-only");
			assert.equal("timestamp" in message, false, "outer entry timestamp is correlation-only");
			assert.equal(Object.getOwnPropertySymbols(message).length, 0, "private correlation markers are stripped");
		}
	});

	it("marks idle+empty direct prompts as streaming before rpcClient.prompt resolves", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = vi.fn(() => pending.promise);
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		const sendPromise = manager.enqueuePrompt(session.id, "hello Codex");

		assert.equal(prompt.mock.calls.length, 1);
		assert.equal(session.status, "streaming");
		assert.equal(session.promptQueue.length, 0);
		assert.equal(manager._testStore.update.mock.calls.length, 1);
		assert.deepEqual(client.sent.at(-1), {
			type: "session_status",
			status: "streaming",
			statusVersion: 1,
			streamingStartedAt: session.streamingStartedAt,
		});

		pending.resolve({ success: true });
		await sendPromise;
	});

	it("recovers a failed direct prompt by restoring idle status and requeueing", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: false, error: "preflight failed" }));
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry me"),
			/preflight failed/,
		);

		assert.equal(prompt.mock.calls.length, 1);
		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, "retry me");
		assert.equal(client.sent.at(-1).type, "queue_update");
		assert.equal(client.sent.at(-2).type, "session_status");
		assert.equal(client.sent.at(-2).status, "idle");
	});

	it("schedules visible auto retry when direct prompt delivery rejects with fetch failed before message_end", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry transport prompt"),
			/fetch failed/,
		);

		assert.equal(prompt.mock.calls.length, 1, "expected one failed prompt delivery before auto retry timer fires");
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
			client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "auto_retry_pending"),
			true,
			"expected client-visible auto_retry_pending event for dispatch-time fetch failed",
		);
	});

	it("schedules visible auto retry when queued drain dispatch rejects with fetch failed before message_end", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });
		session.promptQueue.enqueue("queued transport prompt");

		manager.drainQueue(session);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(prompt.mock.calls.length, 1, "expected one failed queued dispatch before auto retry timer fires");
		assert.equal(session.status, "idle", "expected queued dispatch failure recovery to restore idle status");
		assert.equal(session.promptQueue.length, 1, "expected recovered queued prompt after fetch failed");
		assert.equal(session.promptQueue.peek()?.text, "queued transport prompt", "expected queued prompt text recovered after fetch failed");
		assert.ok(session.pendingAutoRetryTimer, "expected pendingAutoRetryTimer for queued fetch failed");
		const pending = autoRetryPendingEvents(session).at(-1);
		assert.ok(pending, "expected auto_retry_pending for queued fetch failed");
		assert.equal(pending.retryDelayMs, 1000, "expected first bounded retry delay for queued fetch failed");
		assert.equal(client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "auto_retry_pending"), true);
	});

	it("auto retry consumes the recovered direct prompt row before redispatch", async () => {
		const manager = makeManager();
		let calls = 0;
		const prompt = vi.fn(async () => {
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

		manager._testClock.advance(1000);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(prompt.mock.calls.length, 2, "expected only the initial failure plus one auto retry dispatch");
		assert.equal((prompt.mock.calls[1] as any[])[0], "retry once without duplicate queue replay");
		assert.equal(session.promptQueue.length, 0, "auto retry should consume the recovered row before redispatching");
		assert.equal(session.status, "streaming");
	});

	it("fresh prompt before dispatch auto retry drops the recovered failed prompt", async () => {
		const manager = makeManager();
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return { success: true };
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "stale prompt A"),
			/fetch failed/,
		);
		assert.equal(session.promptQueue.length, 1, "expected recovered prompt A before fresh user prompt");
		assert.ok(session.pendingAutoRetryTimer, "expected pending auto retry before fresh user prompt");

		await manager.enqueuePrompt(session.id, "fresh prompt B");

		assert.equal(prompt.mock.calls.length, 2, "fresh prompt should dispatch immediately without retrying prompt A");
		assert.match((prompt.mock.calls[1] as any[])[0], /fresh prompt B/);
		assert.doesNotMatch((prompt.mock.calls[1] as any[])[0], /stale prompt A/);
		assert.equal(session.pendingAutoRetryTimer, undefined, "fresh prompt should cancel pending auto retry");
		assert.equal(session.promptQueue.length, 0, "fresh prompt should drop the recovered stale prompt A row");
		assert.equal(autoRetryCancelledEvents(session).length, 1, "fresh prompt should emit auto_retry_cancelled");
		assert.equal(
			client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "auto_retry_cancelled"),
			true,
			"expected client-visible auto_retry_cancelled event for superseding prompt",
		);

		session.status = "idle";
		manager.drainQueue(session);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(prompt.mock.calls.length, 2, "later queue drain must not replay stale prompt A");
		assert.equal(session.promptQueue.length, 0, "queue should remain empty after later drain");
	});

	it("auto retry clears stale tool-call state after pre-agent_start prompt delivery failure", async () => {
		const manager = makeManager();
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return { success: true };
		});
		const { session } = putSession(manager, {
			turnHadToolCalls: true,
			rpcClient: { prompt },
		});

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry the newly failed prompt, not old tool work"),
			/fetch failed/,
		);
		assert.equal(session.turnHadToolCalls, false, "pre-agent_start delivery failure should clear stale tool-call state");

		manager._testClock.advance(1000);
		await flushAsyncWork();

		assert.equal(prompt.mock.calls.length, 2, "expected initial failed delivery plus one auto retry");
		assert.equal(
			(prompt.mock.calls[1] as any[])[0],
			"retry the newly failed prompt, not old tool work",
			"auto retry should re-send the recovered failed prompt",
		);
		assert.doesNotMatch(
			(prompt.mock.calls[1] as any[])[0],
			/continue where you left off/i,
			"auto retry must not use stale mid-work continuation text",
		);
		assert.equal(session.promptQueue.length, 0, "auto retry should consume the recovered failed prompt row");
		assert.equal(session.status, "streaming");
	});

	it("emits auto_retry_cancelled when dispatch-time auto retries exhaust before agent_start", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "retry until transport budget exhausts"),
			/fetch failed/,
		);
		assert.equal(autoRetryPendingEvents(session).length, 1, "initial dispatch failure should schedule attempt 1");

		for (const expectedAttempt of [2, 3]) {
			const pending = autoRetryPendingEvents(session).at(-1);
			assert.ok(pending, `expected pending retry before attempt ${expectedAttempt}`);
			manager._testClock.advance(pending.retryDelayMs);
			await flushAsyncWork();

			const latestPending = autoRetryPendingEvents(session).at(-1);
			assert.ok(latestPending, `expected pending retry event for attempt ${expectedAttempt}`);
			assert.equal(latestPending.attempt, expectedAttempt);
			assert.ok(session.pendingAutoRetryTimer, `expected timer after scheduling attempt ${expectedAttempt}`);
		}

		const finalPending = autoRetryPendingEvents(session).at(-1);
		assert.ok(finalPending, "expected third pending retry before exhaustion");
		manager._testClock.advance(finalPending.retryDelayMs);
		await flushAsyncWork();

		assert.equal(prompt.mock.calls.length, 4, "expected initial delivery plus three bounded auto-retry attempts");
		assert.equal(autoRetryPendingEvents(session).length, 3, "exhaustion must not emit another pending countdown");
		assert.equal(session.pendingAutoRetryTimer, undefined, "exhausted retries should leave no active timer");
		assert.equal(autoRetryCancelledEvents(session).length, 1, "exhaustion should clear the last visible pending banner");
		assert.equal(
			client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "auto_retry_cancelled"),
			true,
			"expected client-visible auto_retry_cancelled event on exhausted dispatch retries",
		);
		assert.equal(session.promptQueue.length, 1, "failed prompt should remain queued for manual Retry after exhaustion");
		assert.equal(session.promptQueue.peek()?.text, "retry until transport budget exhausts");
	});

	it("retryLastPrompt routes mid-work provider-auth prompt failures through recovery", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: false, error: AUTH_ERROR }));
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
		const prompt = vi.fn(async () => ({ success: false, error: AUTH_ERROR }));
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
		const prompt = vi.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session, client } = putSession(manager, {
			lastTurnErrored: true,
			lastTurnErrorMessage: "The text field in the ContentBlock is blank",
			lastPromptText: "",
			lastPromptImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
			rpcClient: { prompt },
		});
		manager._recoverBlankTextPoison = vi.fn(async () => session);

		await assert.rejects(() => manager.retryLastPrompt(session.id), /OpenRouter provider authentication failure \(missing-api-key\)/);

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.match(session.promptQueue.peek()?.text ?? "", /Attachments:/i);
		assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(AUTH_SECRET));
	});

	it("dispatches a promoted queued steer immediately like a fresh live steer", async () => {
		const manager = makeManager();
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "fresh live steer");
		assert.equal(steer.mock.calls.length, 1, "fresh live steer dispatches immediately");
		assert.equal((steer.mock.calls[0] as any[])[0], "fresh live steer");

		const queued = session.promptQueue.enqueue("promoted queued steer");
		manager.steerQueued(session.id, queued.id);

		assert.equal(
			steer.mock.calls.length,
			2,
			"promoting a queued message to steer should dispatch immediately, not wait for a later tool boundary/agent_end",
		);
		assert.equal((steer.mock.calls[1] as any[])[0], "promoted queued steer");
	});

	it("persists in-flight steer ledger until the user echo arrives", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const steer = vi.fn(() => pending.promise);
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "durable steer");

		assert.equal(steer.mock.calls.length, 1);
		const ledgerUpdate = manager._testStore.update.mock.calls
			.map((call: any) => call[1])
			.find((update: any) => Array.isArray(update?.inFlightSteerTexts));
		assert.deepEqual(ledgerUpdate?.messageQueue, []);
		assertLocalUserSteerLedger(ledgerUpdate?.inFlightSteerTexts, "durable steer");
		assertLocalUserSteerLedger(session.inFlightSteerTexts, "durable steer");

		const rawEcho: any = {
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "durable steer" }] },
		};
		const preparedEcho = manager.prepareVisibleAgentEvent(session, rawEcho);
		assert.deepEqual(preparedEcho.message.author, {
			kind: "user",
			id: "user:local",
			label: "User",
		});
		assert.equal(rawEcho.message.author, undefined, "Bobbit metadata must not mutate the provider event");
		assert.equal(session.pendingPromptAuthors.length, 0, "the echoed prompt author should settle exactly once");
		manager.handleAgentLifecycle(session, preparedEcho);
		const clearUpdate = manager._testStore.update.mock.calls.at(-1)?.[1];
		assert.deepEqual(clearUpdate, { inFlightSteerTexts: undefined });

		pending.resolve({ success: true });
		await steerPromise;
	});

	it("correlates duplicate multi-block update/end streams to stable prompt bindings", () => {
		const manager = makeManager();
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const text = "part one\npart two";
		const { session } = putSession(manager, {
			pendingPromptAuthors: [
				{ promptId: "p1", dispatchedAt: 1, modelText: text, source: "system", author: systemAuthor },
				{ promptId: "p2", dispatchedAt: 2, modelText: text, source: "agent", author: agentAuthor },
			],
		});
		const message = (id: string) => ({
			role: "user",
			id,
			content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
		});

		const update1: any = manager.prepareVisibleAgentEvent(session, { type: "message_update", message: message("m1") });
		const update2: any = manager.prepareVisibleAgentEvent(session, { type: "message_update", message: message("m2") });
		assert.deepEqual(update1.message.author, systemAuthor);
		assert.deepEqual(update2.message.author, agentAuthor);

		const end1: any = manager.prepareVisibleAgentEvent(session, { type: "message_end", message: message("m1") });
		assert.deepEqual(end1.message.author, systemAuthor);
		assert.deepEqual(session.pendingPromptAuthors.map((row: any) => row.promptId), ["p2"]);

		const replayedEnd1: any = manager.prepareVisibleAgentEvent(session, { type: "message_end", message: message("m1") });
		assert.deepEqual(replayedEnd1.message.author, systemAuthor);
		assert.deepEqual(session.pendingPromptAuthors.map((row: any) => row.promptId), ["p2"], "duplicate end must not reuse p2");

		const end2: any = manager.prepareVisibleAgentEvent(session, { type: "message_end", message: message("m2") });
		assert.deepEqual(end2.message.author, agentAuthor);
		assert.equal(session.pendingPromptAuthors.length, 0);
	});

	it("uses a top-level Pi entry id to make same-text live ends idempotent", () => {
		const manager = makeManager();
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const text = "same top-level entry text";
		const { session } = putSession(manager, {
			pendingPromptAuthors: [
				{ promptId: "p1", dispatchedAt: 1, modelText: text, source: "system", author: systemAuthor },
				{ promptId: "p2", dispatchedAt: 2, modelText: text, source: "agent", author: agentAuthor },
			],
		});
		const event = (entryId: string) => ({
			type: "message_end", entryId, message: { role: "user", content: text },
		});

		const first: any = manager.prepareVisibleAgentEvent(session, event("entry-1"));
		const duplicate: any = manager.prepareVisibleAgentEvent(session, event("entry-1"));
		const second: any = manager.prepareVisibleAgentEvent(session, event("entry-2"));

		assert.deepEqual(first.message.author, systemAuthor);
		assert.deepEqual(duplicate.message.author, systemAuthor);
		assert.deepEqual(second.message.author, agentAuthor);
		assert.equal(session.pendingPromptAuthors.length, 0);
	});

	it("persists settlement ids from every live-correlation id alias", () => {
		const manager = makeManager();
		const aliases = ["id", "entryId", "_entryId", "_bobbitEntryId"] as const;
		for (const field of aliases) {
			const sessionId = `s-settlement-${field}`;
			const promptId = `prompt-${field}`;
			const messageId = `message-${field}`;
			const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
			appendPromptAuthorDispatch(sessionId, {
				promptId,
				dispatchedAt: 1,
				modelText: "same prompt",
				source: "system",
				author,
			});
			const { session } = putSession(manager, {
				id: sessionId,
				pendingPromptAuthors: [{
					promptId,
					dispatchedAt: 1,
					modelText: "same prompt",
					source: "system",
					author,
				}],
			});

			manager.prepareVisibleAgentEvent(session, {
				type: "message_end",
				message: { role: "user", content: "same prompt", [field]: messageId },
			});

			assert.equal(readAuthorSidecar(sessionId)[0]?.settlement?.messageId, messageId, field);
			purgeAuthorSidecar(sessionId);
		}
	});

	it("lets a newly accepted same-text dispatch supersede the prior keyless terminal binding", async () => {
		const manager = makeManager();
		const text = "same keyless live bytes";
		const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, text);
		const p1 = session.inFlightSteerTexts[0].promptId;
		const first: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: text },
		});
		manager.handleAgentLifecycle(session, first);
		assert.deepEqual(first.message.author, { kind: "user", id: "user:local", label: "User" });
		assert.equal(session.inFlightSteerTexts.length, 0);

		await manager.deliverLiveSteer(session.id, text, { source: "agent", author: agentAuthor });
		const p2 = session.inFlightSteerTexts[0].promptId;
		assert.notEqual(p2, p1);
		const second: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: text },
		});
		manager.handleAgentLifecycle(session, second);

		assert.deepEqual(second.message.author, agentAuthor, "the new occurrence must not inherit p1's author");
		assert.equal(second.message.role, "user");
		assert.equal(second.message.content, text, "author correlation must not change model-facing bytes");
		assert.equal(session.pendingPromptAuthors.length, 0);
		assert.equal(session.inFlightSteerTexts.length, 0, "p2's ledger is consumed by p2 exactly once");
		const settled = readAuthorSidecar(session.id);
		assert.equal(settled.find((row) => row.promptId === p1)?.settlement?.outcome, "echoed");
		assert.equal(settled.find((row) => row.promptId === p2)?.settlement?.outcome, "echoed");

		const duplicate: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: text },
		});
		manager.handleAgentLifecycle(session, duplicate);
		assert.deepEqual(duplicate.message.author, agentAuthor);
		assert.deepEqual(readAuthorSidecar(session.id), settled, "duplicate p2 end must not append another settlement");
	});

	it("keeps an unresolved same-text steer ledger-backed when an old keyless echo replays", () => {
		const manager = makeManager();
		const userAuthor = { kind: "user", id: "user:local", label: "User" } as const;
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const text = "identical model bytes";
		appendPromptAuthorDispatch("s-keyless-replay", {
			promptId: "p1", dispatchedAt: 1, modelText: text, source: "user", author: userAuthor,
		});
		appendPromptAuthorSettlement("s-keyless-replay", {
			promptId: "p1", settledAt: 2, outcome: "echoed",
		});
		appendPromptAuthorDispatch("s-keyless-replay", {
			promptId: "p2", dispatchedAt: 3, modelText: text, source: "system", author: systemAuthor,
		});
		const { session } = putSession(manager, {
			id: "s-keyless-replay",
			inFlightSteerTexts: [{ text, promptId: "p2", source: "system", author: systemAuthor }],
		});
		restorePromptAuthorBindings(session, readAuthorSidecar(session.id));

		const replayed: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: text },
		});
		manager.handleAgentLifecycle(session, replayed);

		assert.deepEqual(replayed.message.author, userAuthor, "the historical occurrence keeps p1's author");
		assert.equal(replayed.message.role, "user");
		assert.equal(replayed.message.content, text, "author binding must not change model-facing bytes");
		assert.deepEqual(session.pendingPromptAuthors.map((row: any) => row.promptId), ["p2"]);
		assert.deepEqual(session.inFlightSteerTexts.map((row: any) => row.promptId), ["p2"]);
		assert.equal(readAuthorSidecar(session.id).find((row) => row.promptId === "p2")?.settlement, undefined);

		manager._reconcileAfterAbort(session);
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, text);
		assert.equal(session.promptQueue.peek()?.isSteered, true);
		assert.equal(session.promptQueue.peek()?.source, "system");
		assert.deepEqual(session.promptQueue.peek()?.author, systemAuthor);
	});

	it("keeps an immediate duplicate keyless terminal frame idempotent without a newer dispatch", async () => {
		const manager = makeManager();
		const text = "duplicate keyless text";
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});
		await manager.deliverLiveSteer(session.id, text);
		const promptId = session.inFlightSteerTexts[0].promptId;
		const raw = { type: "message_end", message: { role: "user", content: text } };

		const first: any = manager.prepareVisibleAgentEvent(session, raw);
		manager.handleAgentLifecycle(session, first);
		const settled = readAuthorSidecar(session.id);
		const duplicate: any = manager.prepareVisibleAgentEvent(session, raw);
		manager.handleAgentLifecycle(session, duplicate);

		assert.deepEqual(first.message.author, { kind: "user", id: "user:local", label: "User" });
		assert.deepEqual(duplicate.message.author, first.message.author);
		assert.equal(session.pendingPromptAuthors.length, 0);
		assert.equal(session.inFlightSteerTexts.length, 0);
		assert.equal(settled.find((row) => row.promptId === promptId)?.settlement?.outcome, "echoed");
		assert.deepEqual(readAuthorSidecar(session.id), settled, "duplicate end must remain settlement-idempotent");
	});

	it("restores unresolved sidecar dispatches and consumes a replayed steer exactly once", () => {
		const manager = makeManager();
		const author = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const { session } = putSession(manager, {
			inFlightSteerTexts: [
				{ text: "same", promptId: "old", source: "user", author: { kind: "user", id: "user:local", label: "User" } },
				{ text: "same", promptId: "steer-2", source: "system", author },
			],
		});
		restorePromptAuthorBindings(session, [
			{
				schemaVersion: 1, type: "prompt-author", promptId: "old", dispatchedAt: 1,
				modelText: "same", source: "user", author: { kind: "user", id: "user:local", label: "User" },
				settlement: { schemaVersion: 1, type: "prompt-author-settlement", promptId: "old", settledAt: 2, outcome: "echoed", messageId: "m-old" },
			},
			{
				schemaVersion: 1, type: "prompt-author", promptId: "steer-2", dispatchedAt: 3,
				modelText: "same", source: "system", author,
			},
		]);
		assert.deepEqual(session.pendingPromptAuthors.map((row: any) => row.promptId), ["steer-2"]);
		assert.deepEqual(session.inFlightSteerTexts.map((row: any) => row.promptId), ["steer-2"], "durably settled steer must not replay");

		const raw = { type: "message_end", message: { id: "m-new", role: "user", content: "same" } };
		const first: any = manager.prepareVisibleAgentEvent(session, raw);
		manager.handleAgentLifecycle(session, first);
		assert.deepEqual(first.message.author, author);
		assert.equal(session.pendingPromptAuthors.length, 0);
		assert.equal(session.inFlightSteerTexts.length, 0);

		// Replaying the same end frame after restart/reconnect is idempotent: it
		// retains the binding and cannot settle/consume another same-text record.
		const duplicate: any = manager.prepareVisibleAgentEvent(session, raw);
		manager.handleAgentLifecycle(session, duplicate);
		assert.deepEqual(duplicate.message.author, author);
		assert.equal(session.pendingPromptAuthors.length, 0);
		assert.equal(session.inFlightSteerTexts.length, 0);
	});

	it("does not duplicate a pending steer when abort reconciliation wins the rejection race", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const steer = vi.fn(() => pending.promise);
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "recover steer exactly once");

		assert.equal(steer.mock.calls.length, 1);
		assert.equal(session.promptQueue.length, 0);
		assertLocalUserSteerLedger(session.inFlightSteerTexts, "recover steer exactly once");

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
		const steer = vi.fn(() => pending.promise);
		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt, steer },
		});

		const steerPromise = manager.deliverLiveSteer(session.id, "redrain rejected steer");

		assert.equal(steer.mock.calls.length, 1);
		assert.equal(session.promptQueue.length, 0);
		assertLocalUserSteerLedger(session.inFlightSteerTexts, "redrain rejected steer");

		// Model the race where abort's agent_end has already returned the session to
		// idle and run its drain before the in-flight steer RPC rejects.
		session.status = "idle";
		session.lastTurnErrored = false;
		pending.resolve({ success: false, error: "steer rejected after idle" });
		await assert.rejects(steerPromise, /steer rejected after idle/);

		assert.equal(prompt.mock.calls.length, 1, "recovered steer should redrain without a fresh user prompt");
		assert.equal((prompt.mock.calls[0] as any[])[0], "redrain rejected steer");
		assert.equal(session.promptQueue.length, 0);
	});

	it("does not replay a queued steered task notification after its prompt has started", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = vi.fn(() => pending.promise);
		const steer = vi.fn(async () => ({ success: true }));
		const taskNotice = "Task \"Stabilize at-mention menu close E2E\" transitioned to complete. Use task_list for result summaries and gate_status for verification details.";
		const { session } = putSession(manager, { rpcClient: { prompt, steer } });

		session.promptQueue.enqueue(taskNotice, { isSteered: true });
		manager.drainQueue(session);

		assert.equal(prompt.mock.calls.length, 1);
		assert.equal((prompt.mock.calls[0] as any[])[0], taskNotice);
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
			steer.mock.calls.length,
			0,
			"accepted task notification must not be re-enqueued and steered a second time",
		);
		assert.equal(session.promptQueue.length, 0);
	});

	it("recovers a queued prompt when local abort status changes before prompt rejection", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = vi.fn(() => pending.promise);
		const abort = vi.fn(async () => ({ success: true }));
		const { session, client } = putSession(manager, { rpcClient: { prompt, abort } });

		session.promptQueue.enqueue("recover after abort-before-acceptance");
		manager.drainQueue(session);

		assert.equal(prompt.mock.calls.length, 1);
		assert.equal(session.status, "streaming");
		assert.equal(session.promptQueue.length, 0);

		await manager.abortSessionTurn(session.id);
		assert.equal(abort.mock.calls.length, 1);
		assert.equal(session.status, "aborting");

		pending.resolve({ success: false, error: "preflight failed after abort" });
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(session.status, "idle");
		assert.equal(session.promptQueue.length, 1);
		assert.equal(session.promptQueue.peek()?.text, "recover after abort-before-acceptance");
		assert.deepEqual(
			client.sent.filter((msg: any) => msg.type === "session_status").map((msg: any) => msg.status),
			["streaming", "aborting", "idle"],
		);
	});

	it("does not resurrect a terminated session when direct prompt rejects after process_exit", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = vi.fn(() => pending.promise);
		const { session, client } = putSession(manager, { rpcClient: { prompt } });

		const sendPromise = manager.enqueuePrompt(session.id, "lost with child");
		assert.equal(prompt.mock.calls.length, 1);
		assert.equal(session.status, "streaming");

		manager.handleAgentLifecycle(session, { type: "process_exit", code: 17, signal: null });
		assert.equal(session.status, "terminated");

		pending.reject(new Error("Agent process exited with code 17"));
		await assert.rejects(() => sendPromise, /Agent process exited with code 17/);

		manager._testClock.advance(0);
		await flushAsyncWork();
		assert.equal(prompt.mock.calls.length, 1, "terminated sessions must not redrain rejected prompts");
		assert.equal(session.status, "terminated", "recovery must not broadcast idle over process_exit termination");
		assert.equal(session.promptQueue.length, 0, "prompt rejected by a dead child must not be requeued");
		assert.deepEqual(
			client.sent.filter((msg: any) => msg.type === "session_status").map((msg: any) => msg.status),
			["streaming", "terminated"],
		);
		assert.equal(client.sent.some((msg: any) => msg.type === "queue_update"), false);
	});

	it("closes extension channels when process_exit terminates a session", () => {
		const manager = makeManager();
		const closeSession = vi.fn(() => {});
		manager.setExtensionChannelServices({ registry: { closeSession } });
		const { session, client } = putSession(manager, { status: "streaming" });

		manager.handleAgentLifecycle(session, { type: "process_exit", code: 17, signal: null });

		assert.equal(closeSession.mock.calls.length, 1);
		assert.deepEqual(closeSession.mock.calls[0], [session.id, "session-process-exit"]);
		assert.equal(session.status, "terminated");
		assert.deepEqual(
			client.sent.filter((msg: any) => msg.type === "session_status").map((msg: any) => msg.status),
			["terminated"],
		);
	});
});
