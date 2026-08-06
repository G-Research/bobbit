import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, it, vi } from "vitest";

import { createManualClock } from "../harness/clock.js";
import { createMemFs } from "../harness/mem-fs.js";
import {
	PromptDeliveryProtocolError,
	registerRpcBridgeFactory,
} from "../../src/server/agent/rpc-bridge.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import {
	SessionManager,
	hydratePromptAuthorBindings,
	reconcileRestoredPromptDelivery,
	restorePromptAuthorBindings,
} from "../../src/server/agent/session-manager.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	initAuthorSidecarDir,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.ts";

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

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
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

function startLatchedBridge(mode: "v1" | "legacy"): any {
	let started = false;
	return {
		get promptDeliveryProtocol() {
			return started && mode === "v1" ? "v1" : undefined;
		},
		start: vi.fn(async () => { started = true; }),
		promptWithId: vi.fn(async () => ({ success: true })),
		prompt: vi.fn(async () => ({ success: true })),
		steerWithId: vi.fn(async () => ({ success: true })),
		steer: vi.fn(async () => ({ success: true })),
	};
}

function restoredBinding(
	promptId: string,
	modelText: string,
	messageId?: string,
): any {
	return {
		schemaVersion: 1,
		type: "prompt-author",
		promptId,
		dispatchedAt: 1,
		modelText,
		source: "user",
		author: { kind: "user", id: "user:local", label: "User" },
		...(messageId ? {
			settlement: {
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId,
				settledAt: 2,
				outcome: "echoed",
				messageId,
			},
		} : {}),
	};
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

function configureRealRestore(manager: any, ps: PersistedSession, store?: any): any {
	const restoreStore = store ?? {
		get: vi.fn(() => ps),
		getLive: vi.fn(() => [ps]),
		update: vi.fn(),
		archive: vi.fn(),
	};
	manager._testStore = restoreStore;
	manager.getSessionStore = () => restoreStore;
	manager.resolveStoreForSession = () => restoreStore;
	manager.resolveStoreForId = () => restoreStore;
	manager.assemblePrompt = () => undefined;
	manager.applyScopedGatewayCredentials = () => {};
	manager.ensureMcpManagerForContext = async () => {};
	manager.buildToolActivationArgs = () => ({ args: [], runtimeExtensions: [], env: {} });
	manager.resolveCurrentCatalogSpawnModel = async () => undefined;
	manager.resolveCurrentCatalogThinkingLevel = async () => undefined;
	manager.applyDirectProviderEnv = async () => {};
	manager.tryAutoSelectModel = async () => undefined;
	manager.tryApplyDefaultThinkingLevel = async () => {};
	manager.sessionSecretStore = {
		getOrCreateSecret: () => "restore-fixture-secret",
		remove: () => {},
	};
	return restoreStore;
}

function delayNextSessionPublication(memfs: ReturnType<typeof createMemFs>, stateDir: string) {
	const entered = deferred<void>();
	const release = deferred<void>();
	const storeFile = path.resolve(stateDir, "sessions.json");
	const tempFile = `${storeFile}.tmp`;
	const rename = memfs.promises.rename.bind(memfs.promises);
	let blocked = true;
	(memfs.promises as any).rename = async (from: fs.PathLike, to: fs.PathLike) => {
		if (blocked && path.resolve(String(from)) === tempFile && path.resolve(String(to)) === storeFile) {
			blocked = false;
			entered.resolve();
			await release.promise;
		}
		return rename(from, to);
	};
	return { entered: entered.promise, release: release.resolve };
}

function rejectNextSessionPublication(memfs: ReturnType<typeof createMemFs>, stateDir: string, failure: Error) {
	const entered = deferred<void>();
	const release = deferred<void>();
	const storeFile = path.resolve(stateDir, "sessions.json");
	const tempFile = `${storeFile}.tmp`;
	const rename = memfs.promises.rename.bind(memfs.promises);
	let rejected = false;
	(memfs.promises as any).rename = async (from: fs.PathLike, to: fs.PathLike) => {
		if (!rejected && path.resolve(String(from)) === tempFile && path.resolve(String(to)) === storeFile) {
			rejected = true;
			entered.resolve();
			await release.promise;
			throw failure;
		}
		return rename(from, to);
	};
	return { entered: entered.promise, release: release.resolve };
}

afterEach(() => {
	registerRpcBridgeFactory(null);
	for (const manager of managers.splice(0)) {
		manager.sessions?.clear?.();
		manager.sessionsWithConnectedClients?.clear?.();
	}
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("SessionManager stable prompt settlement and redrive", () => {
	it("cold restore waits for start-time v1 capability before reconciling an echoed durable row", async () => {
		const id = "real-start-latched-v1";
		const transcript = path.join(root, `${id}.jsonl`);
		fs.writeFileSync(transcript, "", "utf8");
		const durableRow = {
			id: "restore-stable-id",
			text: "restore stable body",
			isSteered: false,
			createdAt: 1,
			deliveryState: "awaiting-ack",
			deliveryAttempt: 1,
			deliveryPromptId: "restore-stable-id",
		} as const;
		appendPromptAuthorDispatch(id, {
			promptId: durableRow.id,
			dispatchedAt: 1,
			modelText: durableRow.text,
			source: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		appendPromptAuthorSettlement(id, {
			promptId: durableRow.id,
			settledAt: 2,
			outcome: "echoed",
			messageId: "restore-echo",
		});
		const ps: any = {
			...persisted(id),
			agentSessionFile: transcript,
			messageQueue: [durableRow],
		};
		let listener: ((event: any) => void) | undefined;
		const bridge = startLatchedBridge("v1");
		bridge.stop = vi.fn(async () => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.sendCommand = vi.fn(async (command: any) => {
			if (command.type === "switch_session") {
				listener?.({
					type: "message_end",
					message: { id: "restore-echo", role: "user", content: durableRow.text },
				});
			}
			return { success: true };
		});
		registerRpcBridgeFactory(() => bridge);

		const manager = makeManager();
		configureRealRestore(manager, ps);
		putSession(manager, id, { prompt: vi.fn() }, {
			status: "terminated",
			dormant: true,
			promptQueue: new PromptQueue([durableRow]),
		});

		await manager._restoreSessionCoalesced(ps);
		const restored = manager.sessions.get(id);
		assert.ok(restored);
		assert.equal(bridge.start.mock.calls.length, 1);
		assert.equal(bridge.promptDeliveryProtocol, "v1");
		await waitFor(() => bridge.promptWithId.mock.calls.length === 1, "restore did not redrive the stable row");
		assert.deepEqual(restored.promptQueue.toArray().map((row: any) => row.id), [durableRow.id]);
		assert.deepEqual(bridge.promptWithId.mock.calls[0]?.slice(0, 2), [durableRow.text, durableRow.id]);
		deliveryAck(manager, restored, durableRow.id, durableRow.text);
		assert.equal(restored.promptQueue.length, 0);
	});

	it("carries a validated replay ACK across coalesced restore owner merge", async () => {
		const id = "coalesced-v1-replay-ack";
		const transcript = path.join(root, `${id}.jsonl`);
		fs.writeFileSync(transcript, "", "utf8");
		const durableRow = {
			id: "coalesced-acked-row",
			text: "coalesced ACK body",
			isSteered: false,
			createdAt: 1,
			deliveryState: "awaiting-ack",
			deliveryAttempt: 1,
			deliveryPromptId: "coalesced-acked-row",
		} as const;
		appendPromptAuthorDispatch(id, {
			promptId: durableRow.id,
			dispatchedAt: 1,
			modelText: durableRow.text,
			source: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		appendPromptAuthorSettlement(id, {
			promptId: durableRow.id,
			settledAt: 2,
			outcome: "echoed",
			messageId: "coalesced-acked-echo",
		});
		const ps: any = {
			...persisted(id),
			agentSessionFile: transcript,
			messageQueue: [durableRow],
		};
		let listener: ((event: any) => void) | undefined;
		const bridge = startLatchedBridge("v1");
		bridge.stop = vi.fn(async () => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.sendCommand = vi.fn(async (command: any) => {
			if (command.type === "switch_session") {
				listener?.({
					type: "message_end",
					message: { id: "coalesced-acked-echo", role: "user", content: durableRow.text },
				});
				listener?.({
					type: "entry_appended",
					entry: {
						type: "custom",
						customType: "bobbit:prompt-delivery-ack-v1",
						data: { protocolVersion: 1, promptId: durableRow.id, digest: digest(durableRow.text) },
					},
				});
			}
			return { success: true };
		});
		registerRpcBridgeFactory(() => bridge);

		const manager = makeManager();
		configureRealRestore(manager, ps);
		putSession(manager, id, { prompt: vi.fn() }, {
			status: "terminated",
			dormant: true,
			promptQueue: new PromptQueue([durableRow]),
		});

		await manager._restoreSessionCoalesced(ps);
		const restored = manager.sessions.get(id);
		assert.ok(restored);
		assert.equal(restored.promptQueue.length, 0);
		assert.equal(bridge.promptWithId.mock.calls.length, 0, "validated replay ACK must prevent redrive after owner merge");
	});

	it("preserves two v1 owner rows and their stable FIFO identities when replay has only an echo", async () => {
		const id = "coalesced-v1-two-row-order";
		const transcript = path.join(root, `${id}.jsonl`);
		fs.writeFileSync(transcript, "", "utf8");
		const first = {
			id: "coalesced-first-row",
			text: "first crash-left body",
			isSteered: false,
			createdAt: 1,
			deliveryState: "awaiting-ack",
			deliveryAttempt: 1,
			deliveryPromptId: "coalesced-first-row",
		} as const;
		const second = {
			id: "coalesced-second-row",
			text: "second owner-only body",
			isSteered: false,
			createdAt: 2,
		} as const;
		appendPromptAuthorDispatch(id, {
			promptId: first.id,
			dispatchedAt: 1,
			modelText: first.text,
			source: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		appendPromptAuthorSettlement(id, {
			promptId: first.id,
			settledAt: 2,
			outcome: "echoed",
			messageId: "coalesced-first-echo",
		});
		const ps: any = {
			...persisted(id),
			agentSessionFile: transcript,
			messageQueue: [first],
		};
		let listener: ((event: any) => void) | undefined;
		const bridge = startLatchedBridge("v1");
		bridge.stop = vi.fn(async () => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.sendCommand = vi.fn(async (command: any) => {
			if (command.type === "switch_session") {
				listener?.({
					type: "message_end",
					message: { id: "coalesced-first-echo", role: "user", content: first.text },
				});
			}
			return { success: true };
		});
		registerRpcBridgeFactory(() => bridge);

		const manager = makeManager();
		configureRealRestore(manager, ps);
		putSession(manager, id, { prompt: vi.fn() }, {
			status: "terminated",
			dormant: true,
			promptQueue: new PromptQueue([first, second]),
		});

		await manager._restoreSessionCoalesced(ps);
		const restored = manager.sessions.get(id);
		assert.ok(restored);
		await waitFor(() => bridge.promptWithId.mock.calls.length === 1, "first stable row was not redriven");
		assert.deepEqual(bridge.promptWithId.mock.calls[0]?.slice(0, 2), [first.text, first.id]);
		assert.deepEqual(restored.promptQueue.toArray().map((row: any) => row.id), [first.id, second.id]);

		deliveryAck(manager, restored, first.id, first.text);
		restored.status = "idle";
		manager.drainQueue(restored);
		await waitFor(() => bridge.promptWithId.mock.calls.length === 2, "second row did not retain FIFO order");
		assert.deepEqual(bridge.promptWithId.mock.calls[1]?.slice(0, 2), [second.text, second.id]);
	});

	it("keeps legacy echo settlement during coalesced restore owner merge", async () => {
		const id = "coalesced-legacy-owner-merge";
		const transcript = path.join(root, `${id}.jsonl`);
		fs.writeFileSync(transcript, "", "utf8");
		const durableRow = {
			id: "coalesced-legacy-row",
			text: "legacy merge body",
			isSteered: false,
			createdAt: 1,
			deliveryState: "dispatching",
			deliveryAttempt: 1,
			deliveryPromptId: "coalesced-legacy-row",
		} as const;
		appendPromptAuthorDispatch(id, {
			promptId: durableRow.id,
			dispatchedAt: 1,
			modelText: durableRow.text,
			source: "user",
			author: { kind: "user", id: "user:local", label: "User" },
		});
		appendPromptAuthorSettlement(id, {
			promptId: durableRow.id,
			settledAt: 2,
			outcome: "echoed",
			messageId: "coalesced-legacy-echo",
		});
		const ps: any = {
			...persisted(id),
			agentSessionFile: transcript,
			messageQueue: [durableRow],
		};
		let listener: ((event: any) => void) | undefined;
		const bridge = startLatchedBridge("legacy");
		bridge.stop = vi.fn(async () => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.sendCommand = vi.fn(async (command: any) => {
			if (command.type === "switch_session") {
				listener?.({
					type: "message_end",
					message: { id: "coalesced-legacy-echo", role: "user", content: durableRow.text },
				});
			}
			return { success: true };
		});
		registerRpcBridgeFactory(() => bridge);

		const manager = makeManager();
		configureRealRestore(manager, ps);
		putSession(manager, id, { prompt: vi.fn() }, {
			status: "terminated",
			dormant: true,
			promptQueue: new PromptQueue([durableRow]),
		});

		await manager._restoreSessionCoalesced(ps);
		const restored = manager.sessions.get(id);
		assert.ok(restored);
		assert.equal(restored.promptQueue.length, 0);
		assert.equal(bridge.prompt.mock.calls.length, 0, "legacy echoed row must not be redriven");
	});

	it("hydrates before start without mutating v1 FIFO, then retains echoed rows for stable ordered redrive", async () => {
		const manager = makeManager();
		const bridge = startLatchedBridge("v1");
		const session = putSession(manager, "start-latched-v1-echo", bridge);
		const first = session.promptQueue.enqueue("first restored body");
		const second = session.promptQueue.enqueue("second restored body");
		session.promptQueue.markDelivery([first.id], "retrying", 1, first.id);
		session.promptQueue.markDelivery([second.id], "retrying", 1, second.id);
		const bindings = [
			restoredBinding(first.id, first.text, "echo-first"),
			restoredBinding(second.id, second.text, "echo-second"),
		];

		assert.equal(bridge.promptDeliveryProtocol, undefined, "capability is unknown before the real start boundary");
		hydratePromptAuthorBindings(session, bindings);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [first.id, second.id]);

		await bridge.start();
		assert.equal(bridge.promptDeliveryProtocol, "v1");
		assert.equal(reconcileRestoredPromptDelivery(session, bindings), 0);
		userEcho(manager, session, "echo-first", first.text);
		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.id),
			[first.id, second.id],
			"author echo precedes v1 transcript ACK and cannot settle either durable row",
		);

		manager.drainQueue(session);
		await waitFor(() => bridge.promptWithId.mock.calls.length === 1, "first restored row did not redrive");
		assert.deepEqual(bridge.promptWithId.mock.calls[0]?.slice(0, 2), [first.text, first.id]);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [first.id, second.id]);

		deliveryAck(manager, session, first.id, first.text);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [second.id]);
		session.status = "idle";
		manager.drainQueue(session);
		await waitFor(() => bridge.promptWithId.mock.calls.length === 2, "second restored row did not retain FIFO order");
		assert.deepEqual(bridge.promptWithId.mock.calls[1]?.slice(0, 2), [second.text, second.id]);
	});

	it("accepts a matching replayed v1 ACK only after start latches capability and validates its body digest", async () => {
		const manager = makeManager();
		const bridge = startLatchedBridge("v1");
		const session = putSession(manager, "start-latched-v1-ack", bridge);
		const row = session.promptQueue.enqueue("persisted ACK body");
		session.promptQueue.markDelivery([row.id], "awaiting-ack", 1, row.id);
		const bindings = [restoredBinding(row.id, row.text)];

		hydratePromptAuthorBindings(session, bindings);
		deliveryAck(manager, session, row.id, row.text);
		assert.equal(session.promptQueue.length, 1, "an ACK cannot claim v1 ownership before capability is latched");

		await bridge.start();
		assert.equal(reconcileRestoredPromptDelivery(session, bindings), 0);
		deliveryAck(manager, session, row.id, `${row.text} tampered`);
		assert.equal(session.promptQueue.length, 1, "digest mismatch must retain the durable row");
		deliveryAck(manager, session, row.id, row.text);
		assert.equal(session.promptQueue.length, 0);
	});

	it("preserves legacy echo settlement after start latches the absence of v1", async () => {
		const manager = makeManager();
		const bridge = startLatchedBridge("legacy");
		const session = putSession(manager, "start-latched-legacy", bridge);
		const row = session.promptQueue.enqueue("legacy restored body");
		session.promptQueue.markDelivery([row.id], "dispatching", 1, row.id);
		const bindings = [restoredBinding(row.id, row.text, "legacy-echo")];

		hydratePromptAuthorBindings(session, bindings);
		assert.equal(session.promptQueue.length, 1, "hydration is non-mutating while capability is pending");
		await bridge.start();
		assert.equal(bridge.promptDeliveryProtocol, undefined);
		assert.equal(reconcileRestoredPromptDelivery(session, bindings), 1);
		assert.equal(session.promptQueue.length, 0, "legacy author echo remains its settlement boundary");
	});

	it("fences restored retry ownership from generic controls through one stable redrive and ACK", async () => {
		const updates: any[] = [];
		const manager = makeManager({
			get: vi.fn(() => undefined),
			update: vi.fn((_id: string, update: any) => updates.push(structuredClone(update))),
		});
		const redrive = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const restored = {
			id: "restored-owned-row",
			text: "same durable restored body",
			isSteered: false,
			createdAt: 1,
			deliveryState: "awaiting-ack",
			deliveryAttempt: 1,
			deliveryPromptId: "restored-owned-row",
		} as const;
		const queue = new PromptQueue([restored]);
		const later = queue.enqueue("same durable restored body");
		const session = putSession(manager, "owned-control-fence", {
			promptDeliveryProtocol: "v1",
			promptWithId: redrive,
			prompt: vi.fn(),
		}, { promptQueue: queue });
		assert.equal((session.promptQueue.peek() as any).deliveryState, "retrying");

		assert.equal(manager.removeQueued(session.id, restored.id), false);
		assert.equal(manager.reorderQueue(session.id, [later.id]), true);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [restored.id, later.id]);
		assert.deepEqual(updates.at(-1).messageQueue.map((row: any) => row.id), [restored.id, later.id]);
		assert.equal(updates.at(-1).messageQueue[0].text, restored.text);

		manager.drainQueue(session);
		await waitFor(() => redrive.mock.calls.length === 1, "restored row did not redrive");
		assert.deepEqual(redrive.mock.calls[0]?.slice(0, 2), [restored.text, restored.id]);
		assert.equal(manager.removeQueued(session.id, restored.id), false, "awaiting ACK must remain immutable");
		assert.equal(manager.reorderQueue(session.id, [later.id, restored.id]), false);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [restored.id, later.id]);

		deliveryAck(manager, session, restored.id, restored.text);
		deliveryAck(manager, session, restored.id, restored.text);
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [later.id]);
		assert.equal(redrive.mock.calls.length, 1, "settlement cannot redrive the same owned row twice");
	});

	it.each([
		{ scenario: "busy", initialTexts: [] as string[], lastTurnErrored: false },
		{ scenario: "non-empty", initialTexts: ["older FIFO row"], lastTurnErrored: false },
		{ scenario: "error-cap", initialTexts: [] as string[], lastTurnErrored: true },
	])("does not acknowledge $scenario queued acceptance before atomic publication", async ({ scenario, initialTexts, lastTurnErrored }) => {
		const memfs = createMemFs();
		const stateDir = `/state/queued-acceptance-${scenario}`;
		const id = `queued-acceptance-${scenario}`;
		const initialQueue = new PromptQueue();
		for (const text of initialTexts) initialQueue.enqueue(text);
		const store = new SessionStore(stateDir, memfs);
		store.put({ ...persisted(id), messageQueue: initialQueue.toArray() });
		await store.flushAsync();
		const publication = delayNextSessionPublication(memfs, stateDir);
		const manager = makeManager(store);
		const session = putSession(manager, id, { prompt: vi.fn() }, {
			status: lastTurnErrored ? "idle" : "streaming",
			promptQueue: new PromptQueue(initialQueue.toArray()),
			lastTurnErrored,
			consecutiveErrorTurns: lastTurnErrored ? 99 : 0,
		});

		const acceptance = manager.enqueuePrompt(id, `new ${scenario} row`);
		let settled = false;
		void acceptance.then(() => { settled = true; }, () => { settled = true; });
		await publication.entered;

		assert.equal(settled, false, "queued acceptance must wait for the final atomic rename");
		assert.deepEqual(
			new SessionStore(stateDir, memfs).get(id)?.messageQueue?.map((row) => row.text) ?? [],
			initialTexts,
			"a fresh store cannot observe the accepted row before publication",
		);
		const inMemoryIds = session.promptQueue.toArray().map((row: any) => row.id);
		assert.equal(new Set(inMemoryIds).size, initialTexts.length + 1, "acceptance allocates exactly one new FIFO identity");

		publication.release();
		assert.deepEqual(await acceptance, { status: "queued" });
		const reloaded = new SessionStore(stateDir, memfs).get(id)?.messageQueue ?? [];
		assert.deepEqual(reloaded.map((row) => row.text), [...initialTexts, `new ${scenario} row`]);
		assert.deepEqual(reloaded.map((row) => row.id), inMemoryIds, "reload preserves exact FIFO row identities");
	});

	it("durably publishes a restore-window prompt owner before reporting queued", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/restore-window-acceptance";
		const id = "restore-window-acceptance";
		const store = new SessionStore(stateDir, memfs);
		store.put(persisted(id));
		await store.flushAsync();
		const publication = delayNextSessionPublication(memfs, stateDir);
		const manager = makeManager(store);
		const owner = putSession(manager, id, { prompt: vi.fn() }, { status: "terminated", dormant: true });
		manager._sessionReplacementCoordinators.set(id, {
			tail: new Promise<void>(() => {}),
			pending: 1,
			promptOwner: owner,
			coalesced: new Map(),
			drainOnRelease: false,
			validatedPromptDeliveryAcks: new Map(),
			bootContinuationPending: false,
		});

		const acceptance = manager.enqueuePrompt(id, "restore-window queued row");
		let settled = false;
		void acceptance.then(() => { settled = true; }, () => { settled = true; });
		await publication.entered;
		const row = owner.promptQueue.peek();
		assert.ok(row);
		assert.equal(settled, false);
		assert.deepEqual(new SessionStore(stateDir, memfs).get(id)?.messageQueue ?? [], []);

		publication.release();
		assert.deepEqual(await acceptance, { status: "queued" });
		const reloaded = new SessionStore(stateDir, memfs).get(id)?.messageQueue ?? [];
		assert.deepEqual(reloaded.map((item) => item.id), [row.id]);
		assert.deepEqual(reloaded.map((item) => item.text), [row.text]);
	});

	it("rolls back only a failed queued identity and a retry preserves and delivers the FIFO exactly once", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/queued-publication-rollback";
		const id = "queued-publication-rollback";
		const initialQueue = new PromptQueue();
		const first = initialQueue.enqueue("older first FIFO row");
		const second = initialQueue.enqueue("older second FIFO row");
		const store = new SessionStore(stateDir, memfs);
		store.put({ ...persisted(id), messageQueue: initialQueue.toArray() });
		await store.flushAsync();
		const failure = new Error("injected SessionStore publication failure");
		const failedPublication = rejectNextSessionPublication(memfs, stateDir, failure);
		const promptWithId = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const manager = makeManager(store);
		const session = putSession(manager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId,
			prompt: vi.fn(),
		}, {
			status: "streaming",
			promptQueue: new PromptQueue(initialQueue.toArray()),
		});

		const failedAcceptance = manager.enqueuePrompt(id, "retryable failed row");
		const rejection = assert.rejects(failedAcceptance, failure);
		await failedPublication.entered;
		const failedRow = session.promptQueue.toArray().at(-1);
		assert.ok(failedRow);
		assert.notEqual(failedRow.id, first.id);
		assert.notEqual(failedRow.id, second.id);
		failedPublication.release();
		await rejection;
		const failedIds = store.get(id)?.messageQueue?.map((row) => row.id) ?? [];
		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [first.id, second.id]);
		assert.deepEqual(failedIds, [first.id, second.id], "the authoritative store removes only the attempted identity");
		assert.deepEqual(
			new SessionStore(stateDir, memfs).get(id)?.messageQueue?.map((row) => row.id),
			[first.id, second.id],
			"the rollback generation is durable before rejection reaches the caller",
		);
		assert.equal(promptWithId.mock.calls.length, 0, "a failed acceptance cannot cross the delivery boundary");

		session.status = "idle";
		assert.deepEqual(await manager.enqueuePrompt(id, "retryable failed row"), { status: "queued" });
		const retryRows = session.promptQueue.toArray();
		const retried = retryRows.find((row: any) => row.text === "retryable failed row");
		assert.ok(retried);
		assert.notEqual(retried.id, failedRow.id, "retry allocates one fresh identity after rejection");
		assert.notEqual(retried.id, first.id);
		assert.notEqual(retried.id, second.id);
		assert.deepEqual(retryRows.map((row: any) => row.id), [first.id, second.id, retried.id]);
		assert.equal(retryRows.filter((row: any) => row.text === retried.text).length, 1);

		await waitFor(() => promptWithId.mock.calls.length === 1, "first preserved row did not drain");
		assert.deepEqual(promptWithId.mock.calls[0]?.slice(0, 2), [first.text, first.id]);
		deliveryAck(manager, session, first.id, first.text);
		session.status = "idle";
		manager.drainQueue(session);
		await waitFor(() => promptWithId.mock.calls.length === 2, "second preserved row did not drain");
		assert.deepEqual(promptWithId.mock.calls[1]?.slice(0, 2), [second.text, second.id]);
		deliveryAck(manager, session, second.id, second.text);
		session.status = "idle";
		manager.drainQueue(session);
		await waitFor(() => promptWithId.mock.calls.length === 3, "retried row did not drain");
		assert.deepEqual(promptWithId.mock.calls[2]?.slice(0, 2), [retried.text, retried.id]);
		deliveryAck(manager, session, retried.id, retried.text);
		session.status = "idle";
		manager.drainQueue(session);
		await flush();
		assert.equal(promptWithId.mock.calls.filter((call) => call[1] === retried.id).length, 1);
		assert.equal(session.promptQueue.length, 0);
	});

	it("removes a failed restore-window identity from both replacement owners and durable authority", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/restore-window-publication-rollback";
		const id = "restore-window-publication-rollback";
		const initialQueue = new PromptQueue();
		const older = initialQueue.enqueue("older restore FIFO row");
		const store = new SessionStore(stateDir, memfs);
		store.put({ ...persisted(id), messageQueue: initialQueue.toArray() });
		await store.flushAsync();
		const failure = new Error("injected restore-window publication failure");
		const failedPublication = rejectNextSessionPublication(memfs, stateDir, failure);
		const manager = makeManager(store);
		const owner = putSession(manager, id, { prompt: vi.fn() }, {
			status: "terminated",
			dormant: true,
			promptQueue: new PromptQueue(initialQueue.toArray()),
		});
		const coordinator = {
			tail: new Promise<void>(() => {}),
			pending: 1,
			promptOwner: owner,
			coalesced: new Map(),
			drainOnRelease: false,
			validatedPromptDeliveryAcks: new Map(),
			bootContinuationPending: false,
		};
		manager._sessionReplacementCoordinators.set(id, coordinator);

		const acceptance = manager.enqueuePrompt(id, "failed during replacement");
		const rejection = assert.rejects(acceptance, failure);
		await failedPublication.entered;
		const attempted = owner.promptQueue.toArray().at(-1);
		assert.ok(attempted);
		assert.notEqual(attempted.id, older.id);
		const replacement = putSession(manager, id, { prompt: vi.fn() }, {
			status: "preparing",
			promptQueue: new PromptQueue(owner.promptQueue.toArray()),
		});
		coordinator.promptOwner = replacement;

		failedPublication.release();
		await rejection;
		assert.deepEqual(owner.promptQueue.toArray().map((row: any) => row.id), [older.id]);
		assert.deepEqual(replacement.promptQueue.toArray().map((row: any) => row.id), [older.id]);
		assert.deepEqual(store.get(id)?.messageQueue?.map((row) => row.id), [older.id]);
		assert.deepEqual(new SessionStore(stateDir, memfs).get(id)?.messageQueue?.map((row) => row.id), [older.id]);
	});

	it("rolls back a failed fresh direct admission across every owner before caller retry delivers once", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/direct-publication-rollback";
		const id = "direct-publication-rollback";
		const initialQueue = new PromptQueue();
		const first = initialQueue.enqueue("published direct prefix one");
		const second = initialQueue.enqueue("published direct prefix two");
		const store = new SessionStore(stateDir, memfs);
		store.put({ ...persisted(id), messageQueue: initialQueue.toArray() });
		await store.flushAsync();
		const failure = new Error("injected fresh direct publication failure");
		const failedPublication = rejectNextSessionPublication(memfs, stateDir, failure);
		const promptWithId = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const bridge = {
			promptDeliveryProtocol: "v1",
			promptWithId,
			prompt: vi.fn(),
		};
		const manager = makeManager(store);
		const original = putSession(manager, id, bridge, {
			promptQueue: new PromptQueue(initialQueue.toArray()),
		});

		const failedDispatch = manager.dispatchDirectPrompt(original, "caller retries this direct body");
		const rejection = assert.rejects(failedDispatch, failure);
		await failedPublication.entered;
		const attempted = original.promptQueue.peek();
		assert.ok(attempted);
		assert.notEqual(attempted.id, first.id);
		assert.notEqual(attempted.id, second.id);

		const coordinatorOwner = {
			...original,
			status: "preparing",
			clients: new Set(),
			promptQueue: new PromptQueue(original.promptQueue.toArray()),
		};
		const coordinator = {
			tail: new Promise<void>(() => {}),
			pending: 1,
			promptOwner: coordinatorOwner,
			coalesced: new Map(),
			drainOnRelease: false,
			validatedPromptDeliveryAcks: new Map(),
			bootContinuationPending: false,
		};
		manager._sessionReplacementCoordinators.set(id, coordinator);
		const canonical = putSession(manager, id, bridge, {
			status: "preparing",
			promptQueue: new PromptQueue(original.promptQueue.toArray()),
		});

		failedPublication.release();
		await rejection;
		const prefixIds = [first.id, second.id];
		assert.deepEqual(original.promptQueue.toArray().map((row: any) => row.id), prefixIds);
		assert.deepEqual(coordinatorOwner.promptQueue.toArray().map((row: any) => row.id), prefixIds);
		assert.deepEqual(canonical.promptQueue.toArray().map((row: any) => row.id), prefixIds);
		assert.deepEqual(store.get(id)?.messageQueue?.map((row) => row.id), prefixIds);
		assert.deepEqual(
			new SessionStore(stateDir, memfs).get(id)?.messageQueue?.map((row) => row.id),
			prefixIds,
			"caller rejection waits for the row-free rollback generation",
		);
		assert.equal(promptWithId.mock.calls.length, 0, "failed admission cannot reach Pi");

		manager._sessionReplacementCoordinators.delete(id);
		canonical.status = "idle";
		assert.deepEqual(await manager.enqueuePrompt(id, "caller retries this direct body"), { status: "queued" });
		const retried = canonical.promptQueue.toArray().find((row: any) => row.text === "caller retries this direct body");
		assert.ok(retried);
		assert.notEqual(retried.id, attempted.id, "caller retry receives one fresh stable identity");
		assert.deepEqual(canonical.promptQueue.toArray().map((row: any) => row.id), [...prefixIds, retried.id]);

		await waitFor(() => promptWithId.mock.calls.length === 1, "first published prefix did not drain");
		assert.deepEqual(promptWithId.mock.calls[0]?.slice(0, 2), [first.text, first.id]);
		deliveryAck(manager, canonical, first.id, first.text);
		canonical.status = "idle";
		manager.drainQueue(canonical);
		await waitFor(() => promptWithId.mock.calls.length === 2, "second published prefix did not drain");
		assert.deepEqual(promptWithId.mock.calls[1]?.slice(0, 2), [second.text, second.id]);
		deliveryAck(manager, canonical, second.id, second.text);
		canonical.status = "idle";
		manager.drainQueue(canonical);
		await waitFor(() => promptWithId.mock.calls.length === 3, "caller retry did not drain");
		assert.deepEqual(promptWithId.mock.calls[2]?.slice(0, 2), [retried.text, retried.id]);
		deliveryAck(manager, canonical, retried.id, retried.text);
		canonical.status = "idle";
		manager.drainQueue(canonical);
		await flush();
		assert.equal(promptWithId.mock.calls.filter((call) => call[1] === retried.id).length, 1);
		assert.equal(promptWithId.mock.calls.some((call) => call[1] === attempted.id), false);
		assert.equal(canonical.promptQueue.length, 0);
	});

	it("retains an already-published direct row when redrive publication fails", async () => {
		const memfs = createMemFs();
		const stateDir = "/state/direct-redrive-publication-failure";
		const id = "direct-redrive-publication-failure";
		const initialQueue = new PromptQueue();
		const prefix = initialQueue.enqueue("published redrive prefix");
		const durable = initialQueue.enqueue("already published redrive body");
		const store = new SessionStore(stateDir, memfs);
		store.put({ ...persisted(id), messageQueue: initialQueue.toArray() });
		await store.flushAsync();
		const failure = new Error("injected durable redrive publication failure");
		const failedPublication = rejectNextSessionPublication(memfs, stateDir, failure);
		const promptWithId = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const manager = makeManager(store);
		const session = putSession(manager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId,
			prompt: vi.fn(),
		}, { promptQueue: new PromptQueue(initialQueue.toArray()) });

		const redrive = manager.dispatchDirectPrompt(
			session,
			durable.text,
			undefined,
			undefined,
			false,
			false,
			"user",
			undefined,
			durable.id,
		);
		const rejection = assert.rejects(redrive, failure);
		await failedPublication.entered;
		failedPublication.release();
		await rejection;

		assert.deepEqual(session.promptQueue.toArray().map((row: any) => row.id), [prefix.id, durable.id]);
		assert.equal(session.promptQueue.toArray().find((row: any) => row.id === durable.id)?.deliveryState, "retrying");
		assert.deepEqual(store.get(id)?.messageQueue?.map((row) => row.id), [prefix.id, durable.id]);
		assert.deepEqual(
			new SessionStore(stateDir, memfs).get(id)?.messageQueue?.map((row) => row.id),
			[prefix.id, durable.id],
			"previous durable authority retains the accepted redrive row",
		);
		assert.equal(promptWithId.mock.calls.length, 0);
	});

	it("allows a published FIFO prefix to drain without crossing a later row's publication barrier", async () => {
		const id = "queued-publication-prefix-drain";
		const initialQueue = new PromptQueue();
		const older = initialQueue.enqueue("published prefix row");
		const authoritative: any = { ...persisted(id), messageQueue: initialQueue.toArray() };
		const acceptanceBarrier = deferred<void>();
		let flushCalls = 0;
		const store = {
			get: vi.fn(() => authoritative),
			update: vi.fn((_id: string, updates: any) => Object.assign(authoritative, structuredClone(updates))),
			flushAsync: vi.fn(() => {
				flushCalls++;
				return flushCalls === 1 ? acceptanceBarrier.promise : Promise.resolve();
			}),
		};
		const promptWithId = vi.fn(async (_text: string, _promptId: string) => ({ success: true }));
		const manager = makeManager(store);
		const session = putSession(manager, id, {
			promptDeliveryProtocol: "v1",
			promptWithId,
			prompt: vi.fn(),
		}, {
			status: "streaming",
			promptQueue: new PromptQueue(initialQueue.toArray()),
		});

		const acceptance = manager.enqueuePrompt(id, "unpublished suffix row");
		await waitFor(() => store.flushAsync.mock.calls.length === 1, "acceptance did not enter its publication barrier");
		const suffix = session.promptQueue.toArray().at(-1);
		assert.ok(suffix);
		assert.notEqual(suffix.id, older.id);
		let accepted = false;
		void acceptance.then(() => { accepted = true; });

		session.status = "idle";
		manager.drainQueue(session);
		await waitFor(() => promptWithId.mock.calls.length === 1, "published prefix did not retain normal drain semantics");
		assert.equal(accepted, false);
		assert.deepEqual(promptWithId.mock.calls[0]?.slice(0, 2), [older.text, older.id]);
		assert.equal(promptWithId.mock.calls.some((call) => call[1] === suffix.id), false);
		assert.equal(session.promptQueue.toArray().find((row: any) => row.id === suffix.id)?.deliveryState, undefined);

		acceptanceBarrier.resolve();
		assert.deepEqual(await acceptance, { status: "queued" });
		await waitFor(
			() => session.promptQueue.toArray().find((row: any) => row.id === older.id)?.deliveryState === "awaiting-ack",
			"published prefix did not enter stable ACK ownership",
		);
		deliveryAck(manager, session, older.id, older.text);
		session.status = "idle";
		manager.drainQueue(session);
		await waitFor(() => promptWithId.mock.calls.length === 2, "suffix did not drain after its barrier published");
		assert.deepEqual(promptWithId.mock.calls[1]?.slice(0, 2), [suffix.text, suffix.id]);
		assert.equal(promptWithId.mock.calls.filter((call) => call[1] === suffix.id).length, 1);
	});

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
