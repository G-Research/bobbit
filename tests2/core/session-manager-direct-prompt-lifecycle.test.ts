import { afterAll, afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createManualClock } from "../harness/clock.js";

const VIRTUAL_STATE_DIR = path.resolve("/.bobbit-test/session-direct-prompt");
const VIRTUAL_SIDECAR_DIR = path.join(VIRTUAL_STATE_DIR, "author-sidecar");
const VIRTUAL_HMAC_KEY = Buffer.alloc(32, 0x36);
const virtualSidecarFiles = new Map<string, string>();
const virtualFds = new Map<number, { path: string; flags: number }>();
let nextVirtualFd = 10_000;

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
	isTransientVerifierReviewError,
	isVerifierBusyTransportError,
	shouldRetryVerificationStep,
} = await import("../../src/server/agent/verification-logic.ts");
const {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
	promptAuthorBindingMatchesText,
	purgeAuthorSidecar,
	readAuthorSidecar,
} = await import("../../src/server/agent/author-sidecar.ts");

// Author persistence is exercised through the real secure sidecar API, backed
// by a descriptor-aware in-memory filesystem. Unexpected paths fail closed.
const fsSpies: Array<{ mockRestore(): void }> = [];
const virtualStats = (isDirectory: boolean) => ({
	isDirectory: () => isDirectory,
	isFile: () => !isDirectory,
	isSymbolicLink: () => false,
	mode: (isDirectory ? 0o040000 | 0o700 : 0o100000 | 0o600),
}) as fs.Stats;
const enoent = (target: string) => Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });

fsSpies.push(
	vi.spyOn(fs, "existsSync").mockImplementation((target) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem read: ${String(target)}`);
		const key = virtualPath(target);
		return key === VIRTUAL_SIDECAR_DIR || virtualSidecarFiles.has(key);
	}),
	vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem write: ${String(target)}`);
		return undefined;
	}) as typeof fs.mkdirSync),
	vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem read: ${String(target)}`);
		const key = virtualPath(target);
		if (key === VIRTUAL_SIDECAR_DIR) return virtualStats(true);
		if (virtualSidecarFiles.has(key)) return virtualStats(false);
		throw enoent(key);
	}) as typeof fs.lstatSync),
	vi.spyOn(fs, "chmodSync").mockImplementation(((target: fs.PathLike) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem write: ${String(target)}`);
	}) as typeof fs.chmodSync),
	vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: number) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem open: ${String(target)}`);
		const key = virtualPath(target);
		const exists = virtualSidecarFiles.has(key);
		if ((flags & fs.constants.O_EXCL) !== 0 && exists) throw Object.assign(new Error(`EEXIST: ${key}`), { code: "EEXIST" });
		if ((flags & fs.constants.O_CREAT) !== 0 && !exists) virtualSidecarFiles.set(key, "");
		if (!virtualSidecarFiles.has(key)) throw enoent(key);
		const fd = nextVirtualFd++;
		virtualFds.set(fd, { path: key, flags });
		return fd;
	}) as typeof fs.openSync),
	vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
		if (!virtualFds.has(fd)) throw new Error(`unexpected descriptor stat: ${fd}`);
		return virtualStats(false);
	}) as typeof fs.fstatSync),
	vi.spyOn(fs, "fchmodSync").mockImplementation(((fd: number) => {
		if (!virtualFds.has(fd)) throw new Error(`unexpected descriptor chmod: ${fd}`);
	}) as typeof fs.fchmodSync),
	vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: Uint8Array, offset: number, length: number) => {
		const descriptor = virtualFds.get(fd);
		if (!descriptor) throw new Error(`unexpected descriptor write: ${fd}`);
		const chunk = Buffer.from(data.buffer, data.byteOffset + offset, length).toString("utf8");
		const current = virtualSidecarFiles.get(descriptor.path) ?? "";
		virtualSidecarFiles.set(descriptor.path, (descriptor.flags & fs.constants.O_APPEND) !== 0 ? current + chunk : chunk);
		return length;
	}) as typeof fs.writeSync),
	vi.spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
		if (!virtualFds.has(fd)) throw new Error(`unexpected descriptor fsync: ${fd}`);
	}) as typeof fs.fsyncSync),
	vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
		if (!virtualFds.delete(fd)) throw new Error(`unexpected descriptor close: ${fd}`);
	}) as typeof fs.closeSync),
	vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor) => {
		const key = typeof target === "number" ? virtualFds.get(target)?.path : virtualPath(target);
		if (!key || !isVirtualSidecarPath(key)) throw new Error(`unexpected filesystem read: ${String(target)}`);
		if (!virtualSidecarFiles.has(key)) throw enoent(key);
		return virtualSidecarFiles.get(key)!;
	}) as typeof fs.readFileSync),
	vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
		if (!isVirtualSidecarPath(from) || !isVirtualSidecarPath(to)) throw new Error("unexpected filesystem rename");
		const source = virtualPath(from);
		const destination = virtualPath(to);
		if (!virtualSidecarFiles.has(source)) throw enoent(source);
		virtualSidecarFiles.set(destination, virtualSidecarFiles.get(source)!);
		virtualSidecarFiles.delete(source);
	}) as typeof fs.renameSync),
	vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
		if (!isVirtualSidecarPath(target)) throw new Error(`unexpected filesystem write: ${String(target)}`);
		virtualSidecarFiles.delete(virtualPath(target));
	}),
);
initAuthorSidecarDir(VIRTUAL_STATE_DIR, {
	secretsDir: VIRTUAL_STATE_DIR,
	hmacKey: VIRTUAL_HMAC_KEY,
});

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
		getLive: vi.fn(() => []),
		archiveAsync: vi.fn(async () => true),
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
	virtualFds.clear();
});

afterAll(() => {
	for (const spy of fsSpies) spy.mockRestore();
});

describe("SessionManager direct idle prompt lifecycle", () => {
	it("durably tracks direct delegate, verification, and restart system producers with exact provider prefixes", async () => {
		const manager = makeManager();
		const delegateText = "Execute the task described in your system prompt. Follow the instructions carefully.";
		const systemPrefix = "[System]: ";
		const delegatePiText = `${systemPrefix}${delegateText}`;
		const delegatePrompt = vi.fn(async (_text: string) => {
			delegateSession.status = "streaming";
			return { success: true };
		});
		const { session: delegateSession } = putSession(manager, {
			id: "s-delegate-producer",
			rpcClient: { prompt: delegatePrompt },
		});

		await sendDelegatePrompt(delegateSession, "not model-facing", 1_000);
		assert.deepEqual(delegatePrompt.mock.calls[0], [delegatePiText]);
		const delegateBinding = readAuthorSidecar(delegateSession.id)[0];
		assert.equal(delegateBinding.modelText, undefined);
		assert.equal(delegateBinding.modelPrefix, systemPrefix);
		assert.equal(promptAuthorBindingMatchesText(delegateBinding, delegatePiText), true);
		assert.equal(delegateBinding.source, "system");
		assert.deepEqual(delegateBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const ownerAuthor = { kind: "agent", id: "session:delegate-owner", label: "Delegate owner" } as const;
		const ownerPrefix = "[Delegate owner (delega)]: ";
		const ownerPiText = `${ownerPrefix}${delegateText}`;
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
		assert.deepEqual(ownerPrompt.mock.calls[0], [ownerPiText]);
		const ownerBinding = readAuthorSidecar(ownerDelegate.id)[0];
		assert.equal(ownerBinding.modelText, undefined);
		assert.equal(ownerBinding.modelPrefix, ownerPrefix);
		assert.equal(promptAuthorBindingMatchesText(ownerBinding, ownerPiText), true);
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
		assert.deepEqual(malformedPrompt.mock.calls[0], [delegatePiText]);
		const malformedBinding = readAuthorSidecar(malformedDelegate.id)[0];
		assert.equal(malformedBinding.modelPrefix, systemPrefix);
		assert.equal(promptAuthorBindingMatchesText(malformedBinding, delegatePiText), true);
		assert.equal(malformedBinding.source, "system");
		assert.deepEqual(malformedBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const verificationText = "Return the verification_result now.";
		const verificationPiText = `${systemPrefix}${verificationText}`;
		const verificationPrompt = vi.fn(async () => ({ success: true }));
		const { session: verificationSession } = putSession(manager, {
			id: "s-verification-producer",
			rpcClient: { prompt: verificationPrompt },
		});
		await dispatchTrackedSystemPrompt(verificationSession, verificationText, {
			source: "verification",
			now: () => manager._testClock.now(),
		});
		assert.deepEqual(verificationPrompt.mock.calls[0], [verificationPiText]);
		const verificationBinding = readAuthorSidecar(verificationSession.id)[0];
		assert.equal(verificationBinding.modelText, undefined);
		assert.equal(verificationBinding.modelPrefix, systemPrefix);
		assert.equal(promptAuthorBindingMatchesText(verificationBinding, verificationPiText), true);
		assert.equal(verificationBinding.source, "verification");
		assert.deepEqual(verificationBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });

		const restartPrompt = vi.fn(async (_text: string) => ({ success: true }));
		const { session: restartSession } = putSession(manager, {
			id: "s-restart-producer",
			rpcClient: { promptWhenReady: restartPrompt },
		});
		assert.equal(await manager._dispatchBootContinuation(restartSession), true);
		assert.equal(restartPrompt.mock.calls.length, 1);
		const restartPiText = restartPrompt.mock.calls[0][0];
		const restartBaseText =
			"The infrastructure server restarted while you were mid-turn. " +
			"Your previous work has been preserved. Please continue where you left off. " +
			"Do NOT start over — review your recent messages and resume from the exact point of interruption.";
		assert.equal(restartPiText, `${systemPrefix}${restartBaseText}`);
		assert.equal(restartPiText.match(/\[System\]:/g)?.length, 1, "system author prefix appears exactly once");
		const restartBinding = readAuthorSidecar(restartSession.id)[0];
		assert.equal(restartBinding.modelText, undefined);
		assert.equal(restartBinding.modelPrefix, systemPrefix);
		assert.equal(promptAuthorBindingMatchesText(restartBinding, restartPiText), true);
		assert.equal(restartBinding.source, "system");
		assert.deepEqual(restartBinding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });
	});

	it.each([
		{ ordering: "agent-start-before-echo", source: "verification", author: { kind: "system", id: "system:bobbit", label: "Bobbit" } },
		{ ordering: "echo-before-rejection", source: "verification", author: { kind: "system", id: "system:bobbit", label: "Bobbit" } },
		{ ordering: "agent-start-before-echo", source: "agent", author: { kind: "agent", id: "session:caller", label: "Caller" } },
		{ ordering: "echo-before-rejection", source: "agent", author: { kind: "agent", id: "session:caller", label: "Caller" } },
	] as const)(
		"requires the queued $author.kind prompt's exact echo when RPC rejection arrives $ordering",
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
			const expectedPrefix = author.kind === "system" ? "[System]: " : "[Caller (caller)]: ";
			const piText = `${expectedPrefix}${text}`;
			assert.deepEqual(prompt.mock.calls[0], [piText, undefined]);
			assert.equal(session.promptQueue.length, 0, "the durable base-text row is consumed while Pi receives the prefixed text");
			const dispatched = readAuthorSidecar(session.id).find((row) => row.promptId === queued.id);
			assert.equal(dispatched?.modelPrefix, expectedPrefix);
			assert.equal(promptAuthorBindingMatchesText(dispatched, piText), true);

			if (ordering === "agent-start-before-echo") {
				manager.handleAgentLifecycle(session, { type: "agent_start" });
			} else {
				const echo: any = manager.prepareVisibleAgentEvent(session, {
					type: "message_end",
					message: { id: `m-${ordering}`, role: "user", content: piText },
				});
				assert.deepEqual(echo.message.author, author);
				assert.equal(echo.message.content, text, "the provider echo projects back to the durable base text");
				manager.handleAgentLifecycle(session, echo);
			}

			pending.resolve({ success: false, error: "late negative acknowledgement" });
			await flushAsyncWork();

			const afterAck = readAuthorSidecar(session.id).find((row) => row.promptId === queued.id);
			if (ordering === "agent-start-before-echo") {
				assert.equal(session.promptQueue.length, 1, "unrelated lifecycle must not accept the rejected dispatch");
				assert.equal(afterAck?.settlement?.outcome, "cancelled");
			} else {
				assert.equal(session.promptQueue.length, 0, "the exact user echo must prevent recovery");
				assert.equal(afterAck?.settlement?.outcome, "echoed", "late rejection must not overwrite the echoed settlement");
			}
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
		assert.equal((prompt.mock.calls[0] as any[])[0], "retry once without duplicate queue replay", "the original human dispatch stays unprefixed");
		assert.equal((prompt.mock.calls[1] as any[])[0], "[System]: retry once without duplicate queue replay");
		assert.equal(session.promptQueue.length, 0, "auto retry should consume the recovered base-text row before redispatching");
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
			(prompt.mock.calls[0] as any[])[0],
			"retry the newly failed prompt, not old tool work",
			"the original human dispatch stays unprefixed",
		);
		assert.equal(
			(prompt.mock.calls[1] as any[])[0],
			"[System]: retry the newly failed prompt, not old tool work",
			"the system-owned auto retry prefixes the recovered base prompt only at provider dispatch",
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
		assert.equal(session.manualRetryRequired, true, "exhaustion without a retry owner must visibly park durable work");
		assert.equal(
			client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "manual_retry_required"),
			true,
			"exhaustion must notify attached clients that explicit Retry is required",
		);
		assert.ok(
			manager._testStore.update.mock.calls.some(([, update]: any[]) => update.manualRetryRequired === true),
			"exhaustion must persist the parked manual-retry state",
		);
	});

	it("surfaces durable work when an explicit Retry dispatch is rejected", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: false, error: "invalid request schema" }));
		const { session, client } = putSession(manager, {
			lastTurnErrored: true,
			lastTurnErrorMessage: "invalid request schema",
			lastPromptText: "retry this parked prompt",
			rpcClient: { prompt },
		});

		await assert.rejects(() => manager.retryLastPrompt(session.id), /invalid request schema/);

		assert.equal(session.pendingAutoRetryTimer, undefined, "a rejected explicit Retry has no automatic owner");
		assert.equal(session.manualRetryRequired, true, "rejected Retry must leave its durable row visibly parked");
		assert.equal(session.promptQueue.length, 1, "the explicit Retry row remains durable");
		assert.equal(
			client.sent.some((msg: any) => msg.type === "event" && msg.data?.type === "manual_retry_required"),
			true,
			"the rejected explicit Retry must notify attached clients",
		);
		assert.ok(
			manager._testStore.update.mock.calls.some(([, update]: any[]) => update.manualRetryRequired === true),
			"the rejected explicit Retry must persist the parked-state marker",
		);
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

	it("does not replay an echoed live steer after Stop", async () => {
		const manager = makeManager();
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "A echoed");
		const echo = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: "A echoed" },
		});
		manager.handleAgentLifecycle(session, echo);
		manager._reconcileAfterAbort(session);

		assert.deepEqual(session.inFlightSteerTexts, []);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			[],
			"a proven user echo is settled work, not abort recovery work",
		);
	});

	it("recovers only an unechoed later steer after Stop", async () => {
		const manager = makeManager();
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "A echoed");
		await manager.deliverLiveSteer(session.id, "B unechoed");
		const echo = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: "A echoed" },
		});
		manager.handleAgentLifecycle(session, echo);
		manager._reconcileAfterAbort(session);

		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			["B unechoed"],
			"Stop recovers the unresolved B intent without duplicating settled A",
		);
	});

	it("recovers multiple unechoed steers in dispatch order", async () => {
		const manager = makeManager();
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "A first");
		await manager.deliverLiveSteer(session.id, "B second");
		manager._reconcileAfterAbort(session);

		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			["A first", "B second"],
			"front insertion reverses the ledger traversal, preserving chronological dispatch order",
		);
	});

	it("places recovered steers before an ordinary queued prompt without reordering either", async () => {
		const manager = makeManager();
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			status: "streaming",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })), steer },
		});

		await manager.deliverLiveSteer(session.id, "A recover");
		session.promptQueue.enqueue("ordinary queued prompt");
		manager._reconcileAfterAbort(session);

		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			["A recover", "ordinary queued prompt"],
			"recovered steer retains priority while ordinary queued work remains FIFO behind it",
		);
	});

	it("correlates duplicate multi-block update/end streams to stable prompt bindings", () => {
		const manager = makeManager();
		const systemAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
		const agentAuthor = { kind: "agent", id: "session:caller", label: "Caller" } as const;
		const textBlocks = ["part one", "part two"] as const;
		const text = textBlocks.join("");
		const { session } = putSession(manager, {
			pendingPromptAuthors: [
				{ promptId: "p1", dispatchedAt: 1, modelText: text, source: "system", author: systemAuthor },
				{ promptId: "p2", dispatchedAt: 2, modelText: text, source: "agent", author: agentAuthor },
			],
		});
		const message = (id: string) => ({
			role: "user",
			id,
			content: textBlocks.map((part) => ({ type: "text", text: part })),
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
		const firstPiText = (steer.mock.calls[0] as any[])[0];
		assert.equal(firstPiText, text, "human steers stay provider-visible byte-for-byte");
		const first: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: firstPiText },
		});
		manager.handleAgentLifecycle(session, first);
		assert.deepEqual(first.message.author, { kind: "user", id: "user:local", label: "User" });
		assert.equal(session.inFlightSteerTexts.length, 0);

		await manager.deliverLiveSteer(session.id, text, { source: "agent", author: agentAuthor });
		const p2 = session.inFlightSteerTexts[0].promptId;
		assert.notEqual(p2, p1);
		const secondPiText = (steer.mock.calls[1] as any[])[0];
		assert.equal(secondPiText, `[Caller (caller)]: ${text}`);
		assert.equal(session.inFlightSteerTexts[0].text, text, "the in-flight ledger retains unprefixed base text");
		const second: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: secondPiText },
		});
		manager.handleAgentLifecycle(session, second);

		assert.deepEqual(second.message.author, agentAuthor, "the new occurrence must not inherit p1's author");
		assert.equal(second.message.role, "user");
		assert.equal(second.message.content, text, "the raw prefixed provider echo projects back to visible base text");
		assert.equal(session.pendingPromptAuthors.length, 0);
		assert.equal(session.inFlightSteerTexts.length, 0, "p2's ledger is consumed by p2 exactly once");
		const settled = readAuthorSidecar(session.id);
		assert.equal(settled.find((row) => row.promptId === p1)?.settlement?.outcome, "echoed");
		assert.equal(settled.find((row) => row.promptId === p2)?.settlement?.outcome, "echoed");

		const duplicate: any = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { role: "user", content: secondPiText },
		});
		manager.handleAgentLifecycle(session, duplicate);
		assert.deepEqual(duplicate.message.author, agentAuthor);
		assert.equal(duplicate.message.content, text);
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

		// The exact user echo proves Pi accepted this dispatch. A late bridge
		// failure from that same dispatch must not recover the row back into the
		// queue, otherwise agent_end will inject the same task notification again.
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		const echo = manager.prepareVisibleAgentEvent(session, {
			type: "message_end",
			message: { id: "accepted-task-notice", role: "user", content: taskNotice },
		});
		manager.handleAgentLifecycle(session, echo);
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

	it("tick-zero redrains an ordinary busy rejection without auto or manual retry", async () => {
		const manager = makeManager();
		let attempts = 0;
		const prompt = vi.fn(async () => {
			attempts += 1;
			return attempts === 1
				? { success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." }
				: { success: true };
		});
		const { session } = putSession(manager, { rpcClient: { prompt } });

		await assert.rejects(manager.enqueuePrompt(session.id, "ordinary busy prompt"), /already processing/);
		assert.equal(autoRetryPendingEvents(session).length, 0, "ordinary contention must not schedule provider auto-retry");
		assert.equal(session.manualRetryRequired, undefined, "ordinary contention must not expose manual retry before the queue redrain");

		manager._testClock.advance(0);
		await flushAsyncWork();
		assert.equal(prompt.mock.calls.length, 2, "tick-zero redrain should deliver the original durable row once the transport settles");
		assert.equal(session.promptQueue.length, 0);
		assert.equal(autoRetryPendingEvents(session).length, 0);
		assert.notEqual(session.manualRetryRequired, true);
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

	it("drains queued work after narrow externally aborted terminal forms", () => {
		const terminalForms = [
			{ stopReason: "aborted" },
			{ stopReason: "error", errorMessage: "aborted" },
			{ stopReason: "error", errorMessage: "request was aborted" },
			{ stopReason: "error", errorMessage: "operation aborted" },
			{ stopReason: "error", errorMessage: "This operation was aborted" },
			{ stopReason: "error", errorMessage: "AbortError: The operation was aborted." },
			{ stopReason: "error", errorMessage: "AbortError: This operation was aborted" },
		];

		for (const terminal of terminalForms) {
			const manager = makeManager();
			const prompt = vi.fn(async () => ({ success: true }));
			const { session } = putSession(manager, {
				status: "streaming",
				rpcClient: { prompt },
			});
			session.promptQueue.enqueue("deliver the queued delegate report");

			// Pi/runtime cancellation can report these terminal shapes even though
			// the session was never put into the user-Stop `aborting` state.
			manager.handleAgentLifecycle(session, {
				type: "message_end",
				message: { role: "assistant", ...terminal },
			});
			manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

			assert.equal(prompt.mock.calls.length, 1, `external abort must drain for ${JSON.stringify(terminal)}`);
			assert.equal(session.lastTurnErrored, false, "only cancellation error state is cleared");
		}
	});

	it("does not mistake provider diagnostics containing aborted for cancellation", () => {
		for (const errorMessage of [
			"Authentication failed: request aborted by provider",
			"HTTP 500: request aborted while upstream was unavailable",
			"ValidationError: request aborted after invalid request schema",
			"Content policy rejection: operation aborted by provider",
			"This operation was aborted: provider diagnostic",
			"AbortError: This operation was aborted (provider diagnostic)",
		]) {
			const manager = makeManager();
			const prompt = vi.fn(async () => ({ success: true }));
			const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt } });
			session.promptQueue.enqueue("must remain parked");
			manager.handleAgentLifecycle(session, {
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage },
			});
			manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

			assert.equal(prompt.mock.calls.length, 0, `must not drain ${errorMessage}`);
			assert.equal(session.lastTurnErrored, true, `must retain errored state for ${errorMessage}`);
		}
	});

	it("keeps queued steers parked for provider backoff without dispatching", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt, steer } });
		const queued = session.promptQueue.enqueue("do not deliver into an overloaded provider", { isSteered: true });

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "HTTP 429 Too Many Requests" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

		assert.equal(prompt.mock.calls.length, 0, "provider failures must not be blindly drained");
		assert.equal(steer.mock.calls.length, 0, "provider failures must not dispatch queued steers");
		assert.equal(session.lastTurnErrored, true);
		assert.ok(session.pendingAutoRetryTimer, "existing provider retry policy remains armed");
		assert.equal(session.promptQueue.peek()?.id, queued.id, "the original durable steer remains queued");
	});

	it("surfaces an unclassified error once while leaving queued steers parked", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const steer = vi.fn(async () => ({ success: true }));
		const { session, client } = putSession(manager, { status: "streaming", rpcClient: { prompt, steer } });
		const queued = session.promptQueue.enqueue("requires manual recovery", { isSteered: true });

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "Provider diagnostic: request aborted after invalid request schema",
			},
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

		assert.equal(prompt.mock.calls.length, 0, "an unknown provider failure remains parked");
		assert.equal(steer.mock.calls.length, 0, "an unknown provider failure must not dispatch queued steers");
		assert.equal(session.promptQueue.peek()?.id, queued.id, "the original durable steer remains queued");
		assert.equal(session.lastTurnErrored, true);
		assert.equal(session.manualRetryRequired, true);
		const parked: any[] = (client.sent as any[]).filter((msg: any) => msg.type === "event" && msg.data?.type === "manual_retry_required");
		assert.equal(parked.length, 1, "manual recovery must be visible once rather than silently idle");
		assert.match(parked[0].data.message, /queued work is parked.*manual retry/i);
	});

	it("hydrates persisted parked state and clears it for Retry and a new turn", async () => {
		const manager = makeManager();
		const persistedQueue = new PromptQueue();
		persistedQueue.enqueue("parked before gateway restart");
		manager.addDormantSession({
			id: "s-restored-parked",
			title: "Restored parked session",
			cwd: "/virtual/project",
			agentSessionFile: "/virtual/project/agent.jsonl",
			createdAt: 1,
			lastActivity: 1,
			messageQueue: persistedQueue.toArray(),
			manualRetryRequired: true,
		});
		assert.equal(
			manager.sessions.get("s-restored-parked")?.manualRetryRequired,
			true,
			"manager restore must retain the durable marker that authenticated attach replays",
		);

		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt } });
		session.promptQueue.enqueue("parked durable work");
		session.lastPromptText = "retry this turn";

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "invalid request schema" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		assert.equal(session.manualRetryRequired, true);
		assert.ok(
			manager._testStore.update.mock.calls.some(([, update]: any[]) => update.manualRetryRequired === true),
			"parking a terminal failure must durably mark manual Retry before a restart",
		);

		await manager.retryLastPrompt(session.id);
		assert.equal(session.manualRetryRequired, false, "Retry clears the parked-state marker before dispatch");
		assert.ok(
			manager._testStore.update.mock.calls.some(([, update]: any[]) => update.manualRetryRequired === false),
			"Retry must durably clear the parked-state marker",
		);

		session.manualRetryRequired = true;
		manager.handleAgentLifecycle(session, { type: "agent_start" });
		assert.equal(session.manualRetryRequired, false, "a proven new turn clears a stale parked-state marker");
		assert.equal(
			manager._testStore.update.mock.calls.at(-1)?.[1]?.manualRetryRequired,
			false,
			"new-turn persistence must not resurrect a stale manual Retry banner after restoration",
		);
	});

	it("safety-dispatches queued steers after a successful terminal", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const steer = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt, steer } });
		session.promptQueue.enqueue("deliver after the non-tool turn", { isSteered: true });

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

		assert.equal(steer.mock.calls.length, 1, "successful terminals retain the safety-net steer dispatch");
		assert.equal(prompt.mock.calls.length, 0, "the safety-net uses the steer path");
		assert.equal(session.promptQueue.length, 0);
	});

	it("keeps external-abort drain FIFO and ignores duplicate terminal frames", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt } });
		session.promptQueue.enqueue("first queued delegate report");
		session.promptQueue.enqueue("second queued delegate report");
		const terminal = {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "aborted" },
		};

		manager.handleAgentLifecycle(session, terminal);
		manager.handleAgentLifecycle(session, terminal); // duplicate/late message_end
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false }); // duplicate agent_end

		assert.equal(prompt.mock.calls.length, 1, "the final boundary dispatches exactly once");
		assert.equal((prompt.mock.calls as any[][])[0]?.[0], "first queued delegate report", "drain preserves FIFO order");
		assert.equal(session.promptQueue.peek()?.text, "second queued delegate report");
		assert.equal(session.promptQueue.length, 1, "duplicates do not enqueue or dispatch another copy");
		assert.equal(session.completedTurnCount, 1, "late agent_end cannot repeat terminal bookkeeping");
	});

	it("uses the latest distinct terminal before the boundary and rejects all replays after it", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt } });
		session.promptQueue.enqueue("deliver once after cancellation");
		const toolUse = {
			type: "message_end",
			message: { id: "A", role: "assistant", stopReason: "toolUse", content: [{ type: "tool_use", id: "A" }] },
		};
		const aborted = {
			type: "message_end",
			message: { id: "B", role: "assistant", stopReason: "error", errorMessage: "aborted" },
		};
		const end = { type: "agent_end", willRetry: false };

		manager.handleAgentLifecycle(session, toolUse);
		manager.handleAgentLifecycle(session, aborted);
		manager.handleAgentLifecycle(session, end);
		assert.equal(prompt.mock.calls.length, 1, "the latest abort terminal drains the queued row");
		assert.equal(session.completedTurnCount, 1);

		manager.handleAgentLifecycle(session, toolUse);
		manager.handleAgentLifecycle(session, aborted);
		manager.handleAgentLifecycle(session, end);
		assert.equal(prompt.mock.calls.length, 1, "replayed A/B/end cannot dispatch a second row");
		assert.equal(session.completedTurnCount, 1, "replayed final boundaries cannot complete twice");
	});

	it("lets a later successful terminal supersede an earlier error before agent_end", () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, { status: "streaming", rpcClient: { prompt } });
		session.promptQueue.enqueue("drain after latest success");

		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "error", role: "assistant", stopReason: "error", errorMessage: "HTTP 500 provider failure" },
		});
		manager.handleAgentLifecycle(session, {
			type: "message_end",
			message: { id: "success", role: "assistant", stopReason: "stop" },
		});
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

		assert.equal(session.lastTurnErrored, false, "the latest distinct terminal owns classification");
		assert.equal(prompt.mock.calls.length, 1, "latest success reaches the normal queue drain");
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

	it("VERIFIER_BUSY_RACE_REPRO sends one verifier intent as an atomic Pi followUp command", async () => {
		const manager = makeManager();
		const commands: Array<{ text: string; images: unknown; third: unknown; streamingBehavior: unknown }> = [];
		const prompt = vi.fn(async (text: string, images: unknown, third: unknown, streamingBehavior: unknown) => {
			commands.push({ text, images, third, streamingBehavior });
			// This is the real Pi contention boundary: a healthy transport is already
			// processing, and accepts only the atomic followUp form of this exact RPC.
			if (streamingBehavior !== "followUp") {
				return { success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." };
			}
			return { success: true };
		});
		const { session } = putSession(manager, {
			id: "s-verifier-atomic-follow-up",
			rpcClient: { prompt },
		});

		const result = await manager.enqueuePrompt(session.id, "submit the review verdict", {
			source: "verification",
			streamingBehavior: "followUp",
			suppressTitleGen: true,
		});

		assert.deepEqual(result, { status: "dispatched" });
		assert.equal(commands.length, 1, "VERIFIER_BUSY_RACE_REPRO: a busy verifier must receive one logical provider command, never a raw retry");
		assert.deepEqual(commands[0], {
			text: "[System]: submit the review verdict",
			images: undefined,
			third: undefined,
			streamingBehavior: "followUp",
		});
		assert.equal(session.promptQueue.length, 0, "VERIFIER_BUSY_RACE_REPRO: accepted atomic followUp must not leave a replayable duplicate queue row");
		assert.equal(session.status, "streaming");
		const binding = readAuthorSidecar(session.id)[0];
		assert.equal(binding?.source, "verification");
		assert.deepEqual(binding?.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });
	});

	it("preserves source:verification title suppression through direct busy recovery", async () => {
		const manager = makeManager();
		const busy = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? { success: false, error: busy } : { success: true };
		});
		const { session } = putSession(manager, {
			id: "s-direct-verification-title-suppression",
			titleGenerated: false,
			rpcClient: { prompt },
		});
		const titleGeneration = vi.spyOn(manager, "tryGenerateTitleFromPrompt").mockImplementation(() => {});

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "continue the reviewer check", {
				source: "verification",
				streamingBehavior: "followUp",
				suppressTitleGen: true,
			}),
			/Agent is already processing/,
		);
		assert.equal(session.promptQueue.peek()?.suppressTitleGen, true,
			"direct recovery must preserve suppression when it re-enqueues the rejected prompt");

		manager._testClock.advance(0);
		await flushAsyncWork();
		assert.equal(prompt.mock.calls.length, 2);
		assert.equal(titleGeneration.mock.calls.length, 0, "direct busy redrive must not generate a title");
	});

	it("VERIFIER_BUSY_RACE_REPRO preserves an exact verifier row's title suppression through busy redrain", async () => {
		const manager = makeManager();
		const busy = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			return calls === 1 ? { success: false, error: busy } : { success: true };
		});
		const { session } = putSession(manager, {
			id: "s-verifier-title-suppression-redrive",
			title: "Stable reviewer title",
			titleGenerated: false,
			rpcClient: { prompt },
		});
		const titleGeneration = vi.spyOn(manager, "tryGenerateTitleFromPrompt").mockImplementation(() => {});

		const receipt = manager.enqueueVerifierPrompt(session.id, "submit the reviewer verdict exactly once");
		await flushAsyncWork();
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => [row.id, row.suppressTitleGen, row.verifierOwned]),
			[[receipt.rowId, true, true]],
			"VERIFIER_BUSY_RACE_REPRO: busy recovery must restore the same verifier row with title suppression intact",
		);
		assert.equal(titleGeneration.mock.calls.length, 0, "the rejected verifier dispatch must not name its ephemeral reviewer");

		manager._testClock.advance(0);
		await flushAsyncWork();
		await receipt.dispatched;

		assert.equal(prompt.mock.calls.length, 2, "VERIFIER_BUSY_RACE_REPRO: one busy rejection redrives the exact row once");
		assert.equal(session.promptQueue.length, 0, "the accepted redrive consumes the original verifier row");
		assert.equal(titleGeneration.mock.calls.length, 0, "busy redrive must not generate or replace the reviewer title");
		assert.equal(session.title, "Stable reviewer title");
	});

	it("VERIFIER_BUSY_RACE_REPRO parks one verifier row after three busy drain rejections without duplicate delivery", async () => {
		const manager = makeManager();
		const busy = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
		const prompt = vi.fn(async () => ({ success: false, error: busy }));
		const { session } = putSession(manager, {
			id: "s-verifier-busy-drain-cap",
			rpcClient: { prompt },
		});

		const receipt = manager.enqueueVerifierPrompt(session.id, "deliver exactly one contention-bound verifier turn");
		const parkedOutcome = receipt.dispatched.then(
			() => assert.fail("VERIFIER_BUSY_RACE_REPRO: bounded busy recovery must park rather than falsely acknowledge the verifier row"),
			(error: Error) => error,
		);
		await flushAsyncWork();
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [receipt.rowId],
			"VERIFIER_BUSY_RACE_REPRO: first rejection restores the original durable row");
		manager._testClock.advance(0);
		await flushAsyncWork();
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [receipt.rowId],
			"VERIFIER_BUSY_RACE_REPRO: second rejection reuses rather than duplicates the durable row");
		manager._testClock.advance(0);
		await flushAsyncWork();

		const parkedError = await parkedOutcome;
		const verifierOutput = `LLM review failed: ${parkedError.message}`;
		assert.equal(prompt.mock.calls.length, 3, "VERIFIER_BUSY_RACE_REPRO: initial dispatch plus two bounded redrains only");
		assert.equal(session.promptQueue.length, 0,
			"VERIFIER_BUSY_RACE_REPRO: terminal parking hands the one rejected row to the verifier retry loop without stale replay");
		assert.equal(readAuthorSidecar(session.id).filter((binding) => binding.promptId === receipt.rowId).length, 1,
			"VERIFIER_BUSY_RACE_REPRO: repeated redrains retain one author binding for the exact row");
		assert.equal(isVerifierBusyTransportError(verifierOutput), true);
		assert.equal(isTransientVerifierReviewError(verifierOutput), true);
		assert.equal(shouldRetryVerificationStep({
			passed: false,
			output: verifierOutput,
			attempt: 1,
			maxBoundedAttempts: 3,
			isTransient: isTransientVerifierReviewError,
		}), "retry", "VERIFIER_BUSY_RACE_REPRO: parked contention returns to the verifier's bounded retry loop");
	});

	it("rejects a verifier receipt immediately for provider authentication failure without parking its row", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session, client } = putSession(manager, {
			id: "s-verifier-auth-terminal",
			rpcClient: { prompt },
		});

		const receipt = manager.enqueueVerifierPrompt(session.id, "submit the protected review verdict");
		const outcome = receipt.dispatched.then(
			() => assert.fail("provider authentication failure must reject the verifier receipt"),
			(error: Error) => error,
		);
		await flushAsyncWork();

		const error = await outcome;
		assert.match(error.message, /OpenRouter provider authentication failure \(missing-api-key\)/);
		assert.doesNotMatch(error.message, new RegExp(AUTH_SECRET));
		assert.equal(prompt.mock.calls.length, 1, "VERIFIER_BUSY_RACE_REPRO: provider auth is terminal and must not retry");
		assert.equal(session.promptQueue.length, 0, "the failed verifier row must not wait for a manual retry or receipt timeout");
		assert.equal(session.pendingAutoRetryTimer, undefined);
		assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(AUTH_SECRET));
	});

	it("rejects a verifier receipt when bounded non-busy delivery retries exhaust", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => { throw new TypeError("fetch failed"); });
		const { session } = putSession(manager, {
			id: "s-verifier-generic-terminal",
			rpcClient: { prompt },
		});

		const receipt = manager.enqueueVerifierPrompt(session.id, "deliver one generic-failure review verdict");
		const outcome = receipt.dispatched.then(
			() => assert.fail("exhausted verifier delivery must reject its receipt"),
			(error: Error) => error,
		);
		await flushAsyncWork();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const pending = autoRetryPendingEvents(session).at(-1);
			assert.ok(pending, `expected bounded retry ${attempt + 1}`);
			manager._testClock.advance(pending.retryDelayMs);
			await flushAsyncWork();
		}

		const error = await outcome;
		assert.match(error.message, /fetch failed/);
		assert.equal(prompt.mock.calls.length, 4, "one verifier intent gets only the bounded provider attempts");
		assert.equal(session.promptQueue.length, 0, "exhausted verifier work cannot remain parked for manual Retry");
		assert.equal(session.pendingAutoRetryTimer, undefined);
	});

	it("retains one verifier session and settles the same receipt after a transient redrive", async () => {
		const manager = makeManager();
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return { success: true };
		});
		const { session } = putSession(manager, {
			id: "s-verifier-one-session-redrive",
			rpcClient: { prompt },
		});
		const createSession = vi.spyOn(manager, "createSession");

		const receipt = manager.enqueueVerifierPrompt(session.id, "redrive this exact verifier intent");
		await flushAsyncWork();
		const pending = autoRetryPendingEvents(session).at(-1);
		assert.ok(pending, "the first transient failure must schedule the bounded retry");
		manager._testClock.advance(pending.retryDelayMs);
		await receipt.dispatched;

		assert.equal(prompt.mock.calls.length, 2, "VERIFIER_BUSY_RACE_REPRO: one intent is retried, not duplicated");
		assert.equal(createSession.mock.calls.length, 0, "a healthy verifier is redriven in its original session");
		assert.equal(session.promptQueue.length, 0, "acceptance consumes the original durable verifier row");
		assert.equal(session.id, "s-verifier-one-session-redrive");
	});

	it("rejects an in-flight verifier receipt after process exit without a replacement dispatch", async () => {
		const manager = makeManager();
		const pending = deferred<any>();
		const prompt = vi.fn(() => pending.promise);
		const { session } = putSession(manager, {
			id: "s-verifier-process-exit-terminal",
			rpcClient: { prompt },
		});

		const receipt = manager.enqueueVerifierPrompt(session.id, "do not respawn this dead reviewer");
		const outcome = receipt.dispatched.then(
			() => assert.fail("process exit must reject the verifier receipt"),
			(error: Error) => error,
		);
		assert.equal(prompt.mock.calls.length, 1);
		manager.handleAgentLifecycle(session, { type: "process_exit", code: 17, signal: null });
		pending.reject(new Error("Agent process exited with code 17"));
		const error = await outcome;

		assert.match(error.message, /Agent process exited with code 17/);
		assert.equal(session.status, "terminated");
		assert.equal(session.promptQueue.length, 0, "the dead verifier's exact row must be removed");
		manager._testClock.advance(0);
		await flushAsyncWork();
		assert.equal(prompt.mock.calls.length, 1, "VERIFIER_BUSY_RACE_REPRO: terminal recovery cannot spawn a replacement delivery");
	});

	it("VERIFIER_BUSY_RACE_REPRO keeps a verifier receipt queued behind a real streaming turn until agent_end drains its exact row", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: true }));
		const { session } = putSession(manager, {
			id: "s-verifier-receipt-behind-stream",
			status: "streaming",
			rpcClient: { prompt },
		});
		const receipt = manager.enqueueVerifierPrompt(session.id, "deliver the queued verifier verdict");
		session.promptQueue.enqueue("ordinary durable work");
		let settlement = "pending";
		void receipt.dispatched.then(() => { settlement = "dispatched"; }, () => { settlement = "rejected"; });

		await flushAsyncWork();
		assert.equal(prompt.mock.calls.length, 0, "VERIFIER_BUSY_RACE_REPRO: a streaming session must not dispatch a second verifier turn");
		assert.equal(settlement, "pending", "the receipt must not borrow the preceding turn's streaming state");
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => [row.text, row.source]),
			[["deliver the queued verifier verdict", "verification"], ["ordinary durable work", undefined]],
		);

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		await receipt.dispatched;

		assert.equal(settlement, "dispatched", "only the dequeued verifier row may settle this receipt");
		assert.equal(prompt.mock.calls.length, 1, "VERIFIER_BUSY_RACE_REPRO: agent_end drains exactly one queued provider command");
		assert.deepEqual(prompt.mock.calls[0], ["[System]: deliver the queued verifier verdict", undefined, undefined, "followUp"]);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			["ordinary durable work"],
			"the unrelated row stays durable and cannot settle the verifier receipt",
		);
	});

	it("VERIFIER_BUSY_RACE_REPRO cancels the exact queued verifier row without removing ordinary work", async () => {
		const manager = makeManager();
		const { session } = putSession(manager, {
			id: "s-verifier-receipt-cancel",
			status: "streaming",
		});
		const receipt = manager.enqueueVerifierPrompt(session.id, "expire before a reviewer becomes idle");
		session.promptQueue.enqueue("ordinary work survives verifier timeout");

		assert.equal(receipt.cancel(), true, "the verifier timeout owner must be able to cancel its exact durable row");
		await assert.rejects(receipt.dispatched, /cancelled before dispatch/);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => [row.text, row.source]),
			[["ordinary work survives verifier timeout", undefined]],
			"VERIFIER_BUSY_RACE_REPRO: cancellation must not delete neighbouring ordinary work",
		);
		assert.equal(receipt.cancel(), false, "cancellation is idempotent after the receipt has settled");
	});

	it("VERIFIER_BUSY_RACE_REPRO cancels and terminates verifier rows owned by an in-flight replacement", async () => {
		const manager = makeManager();
		const sessionId = "s-replacement-owned-verifier";
		const { session: promptOwner } = putSession(manager, {
			id: sessionId,
			status: "streaming",
		});
		const replacement = {
			...promptOwner,
			promptQueue: new PromptQueue(),
			rpcClient: {
				prompt: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => ({})),
				stop: vi.fn(async () => {}),
			},
			unsubscribe: vi.fn(),
		};
		manager.sessions.set(sessionId, replacement);
		manager._sessionReplacementCoordinators.set(sessionId, {
			tail: Promise.resolve(), pending: 0, coalesced: new Map(), promptOwner, drainOnRelease: false,
		});

		const cancelled = manager.enqueueVerifierPrompt(sessionId, "cancel on the replacement-owned queue");
		// Keep the expected rejection observed even when this failing-first
		// assertion exposes an ownership regression before await assert.rejects.
		void cancelled.dispatched.catch(() => {});
		assert.equal(promptOwner.promptQueue.peek()?.id, cancelled.rowId);
		assert.equal(cancelled.cancel(), true, "VERIFIER_BUSY_RACE_REPRO: cancellation must target the replacement promptOwner, not an empty successor queue");
		await assert.rejects(cancelled.dispatched, /cancelled before dispatch/);
		assert.equal(promptOwner.promptQueue.length, 0, "the cancelled verifier row cannot survive on the replaced owner");

		const terminated = manager.enqueueVerifierPrompt(sessionId, "remove on reviewer termination");
		const terminatedOutcome = terminated.dispatched.then(() => "resolved", (error: Error) => error.message);
		assert.equal(promptOwner.promptQueue.peek()?.id, terminated.rowId);
		await manager.terminateSession(sessionId);
		assert.match(await terminatedOutcome, /terminated before dispatch/);
		assert.equal(promptOwner.promptQueue.length, 0, "termination must purge verifier work from the replacement promptOwner too");
	});

	it("redrives the exact verifier-owned steer without batching a source:verification notification", async () => {
		const manager = makeManager();
		let calls = 0;
		const prompt = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("fetch failed");
			return { success: true };
		});
		const { session } = putSession(manager, {
			id: "s-mixed-steered-verifier-retry",
			rpcClient: { prompt },
		});
		const verifier = session.promptQueue.enqueue("exact verifier steer", {
			isSteered: true,
			source: "verification",
			verifierOwned: true,
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
			streamingBehavior: "followUp",
		});
		const notification = session.promptQueue.enqueue("team lead notification must not hitchhike", {
			isSteered: true,
			source: "verification",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});

		manager.drainQueue(session);
		await flushAsyncWork();
		assert.equal(session.lastPromptText, verifier.text, "the verifier retry anchor must be its exact row, not mixed batch text");
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.id),
			[verifier.id, notification.id],
			"the failed verifier row restores ahead of, but never absorbs, the ordinary notification",
		);
		const retry = autoRetryPendingEvents(session).at(-1);
		assert.ok(retry, "the failed verifier delivery schedules its bounded retry");
		manager._testClock.advance(retry.retryDelayMs);
		await flushAsyncWork();

		assert.deepEqual(
			prompt.mock.calls.map((call: any[]) => call[0]),
			["[System]: exact verifier steer", "[System]: exact verifier steer"],
			"retryLastPrompt must select the flagged verifier row by durable ID, never replay its source:verification neighbour",
		);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => [row.id, row.text, row.verifierOwned]),
			[[notification.id, notification.text, undefined]],
			"only the accepted verifier row is consumed; the notification remains queued exactly once",
		);
	});

	it("restartAgent carries source:verification notifications but purges verifier-owned rows", async () => {
		const manager = makeManager();
		const sessionId = "s-restart-verifier-ownership";
		const { session } = putSession(manager, {
			id: sessionId,
			status: "streaming",
			unsubscribe: vi.fn(),
			rpcClient: { stop: vi.fn(async () => {}) },
		});
		const notification = session.promptQueue.enqueue("team lead notification survives restart", {
			source: "verification",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});
		const receipt = manager.enqueueVerifierPrompt(sessionId, "verifier-owned row is purged at restart");
		const receiptOutcome = receipt.dispatched.then(
			() => assert.fail("restart must settle the discarded verifier receipt"),
			(error: Error) => error,
		);
		const persisted = {
			id: sessionId,
			title: session.title,
			cwd: session.cwd,
			agentSessionFile: "/virtual/project/reviewer.jsonl",
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
		};
		manager._testStore.get.mockReturnValue(persisted);
		manager.restoreSession = vi.fn(async () => {
			manager.sessions.set(sessionId, {
				...session,
				promptQueue: new PromptQueue(session.promptQueue.toArray()),
				status: "idle",
			});
		});

		await manager.restartAgent(sessionId);
		assert.match((await receiptOutcome).message, /restarted before dispatch/);
		assert.deepEqual(
			manager.sessions.get(sessionId)?.promptQueue.toArray().map((row: any) => [row.id, row.source, row.verifierOwned]),
			[[notification.id, "verification", undefined]],
			"restartAgent must retain durable team-lead work while fencing only harness-owned verifier rows",
		);
	});

	it("separates verifier lifecycle ownership from verification attribution on restore", () => {
		const manager = makeManager();
		const persisted = new PromptQueue();
		persisted.enqueue("ordinary restored work");
		// Team-lead gate notifications share the verification source for UI and
		// authorship, but were never admitted by enqueueVerifierPrompt.
		persisted.enqueue("team lead gate notification", {
			source: "verification",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});
		persisted.enqueue("stale verifier reminder", {
			source: "verification",
			verifierOwned: true,
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
			streamingBehavior: "followUp",
		});

		manager.addDormantSession({
			id: "s-restored-verifier-rows",
			title: "Restored reviewer",
			cwd: "/virtual/project",
			agentSessionFile: "/virtual/project/reviewer.jsonl",
			createdAt: 1,
			lastActivity: 1,
			messageQueue: persisted.toArray(),
		});

		assert.deepEqual(
			manager.sessions.get("s-restored-verifier-rows")?.promptQueue.toArray().map((row: any) => [row.text, row.source, row.verifierOwned]),
			[
				["ordinary restored work", undefined, undefined],
				["team lead gate notification", "verification", undefined],
			],
			"VERIFIER_BUSY_RACE_REPRO: restore prunes only explicitly verifier-owned rows; legacy source:verification work remains durable",
		);
	});

	it("keeps source:verification work through auth and manual-retry recovery while settling verifier-owned receipts", async () => {
		const manager = makeManager();
		const prompt = vi.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const { session } = putSession(manager, {
			id: "s-verifier-ownership-auth",
			status: "streaming",
			rpcClient: { prompt },
		});
		const notification = session.promptQueue.enqueue("team lead notification survives recovery", {
			source: "verification",
			author: { kind: "system", id: "system:bobbit", label: "Bobbit" },
		});
		const receipt = manager.enqueueVerifierPrompt(session.id, "owned verifier row is abandoned");
		const receiptOutcome = receipt.dispatched.then(
			() => assert.fail("verifier-owned auth failure must reject its receipt"),
			(error: Error) => error,
		);

		// A real provider-auth recovery sees both dequeued/recovered kinds. The
		// ordinary source:verification row remains, while the exact verifier row
		// is abandoned so the harness cannot time out waiting for manual Retry.
		(manager as any).recoverPromptDispatch(session, [
			{ id: notification.id, text: notification.text, source: notification.source },
			{ id: receipt.rowId, text: "owned verifier row is abandoned", source: "verification", verifierOwned: true },
		], AUTH_ERROR, "ownership test", [notification.id, receipt.rowId], true);

		const error = await receiptOutcome;
		assert.match(error.message, /OpenRouter provider authentication failure \(missing-api-key\)/);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => [row.id, row.source, row.verifierOwned]),
			[[notification.id, "verification", undefined]],
			"manual/provider-auth recovery must not abandon durable team-lead notifications",
		);
	});
});
