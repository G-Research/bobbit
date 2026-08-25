// focused clear transaction, fencing, and rollback coverage.

import { guardProcessEnv } from "../core/_helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTmpDir } from "../../support/helpers/shared/tmp.ts";
import { createManualClock } from "../../support/harnesses/shared/clock.js";

const tmpRoot = makeTmpDir("context-clear-lifecycle-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });

const { resetAgentDirStateForTests } = await import("../../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../../../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../../../src/server/agent/prompt-queue.ts");
const { initAuthorSidecarDir } = await import("../../../src/server/agent/author-sidecar.ts");
const { initCompactionSidecarDir } = await import("../../../src/server/agent/compaction-sidecar.ts");
const { activeAgentSessionsDir } = await import("../../../src/server/agent/agent-session-path.ts");

const PROVIDER = "anthropic";
const MODEL_ID = "claude-clear-fixture";
const THINKING = "high";
const managers: any[] = [];

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 12): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function generationPath(label: string): string {
	const dir = path.join(activeAgentSessionsDir(), "--context-clear-lifecycle--");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${label}.jsonl`);
}

function oldEntries() {
	return [
		{
			type: "message", id: "entry-user", parentId: null,
			message: { role: "user", content: [{ type: "text", text: "SECRET_OLD_USER" }], timestamp: 1_700_000_000_001 },
		},
		{
			type: "message", id: "entry-assistant", parentId: "entry-user",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-old", name: "read", arguments: { path: "SECRET_OLD_TOOL_INPUT" } }],
				provider: PROVIDER,
				model: MODEL_ID,
				stopReason: "toolUse",
				timestamp: 1_700_000_000_002,
			},
		},
		{
			type: "message", id: "entry-tool", parentId: "entry-assistant",
			message: {
				role: "toolResult", toolCallId: "tool-old", toolName: "read",
				content: [{ type: "text", text: "SECRET_OLD_TOOL_RESULT" }], isError: false,
				timestamp: 1_700_000_000_003,
			},
		},
	];
}

function oldMessages() {
	return oldEntries().map((entry) => entry.message);
}

function writeOldTranscript(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${oldEntries().map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function makeClient(): any {
	return {
		readyState: 1,
		bufferedAmount: 0,
		frames: [] as any[],
		send(payload: string) { this.frames.push(JSON.parse(payload)); },
		close: vi.fn(),
	};
}

class AtomicStore {
	record: Record<string, any>;
	readonly updates: Record<string, any>[] = [];
	failUpdate = false;
	failNextFlush = false;
	readonly flushAsync = vi.fn(async () => {
		if (!this.failNextFlush) return;
		this.failNextFlush = false;
		throw new Error("fixture atomic clear flush failed");
	});

	constructor(record: Record<string, any>) {
		this.record = structuredClone(record);
	}

	get = vi.fn((_id: string) => this.record);
	getLive = vi.fn(() => [this.record]);
	getAll = vi.fn(() => [this.record]);
	put = vi.fn((record: Record<string, any>) => { this.record = structuredClone(record); });
	archive = vi.fn(() => {});
	archiveAsync = vi.fn(async () => {});
	update = vi.fn((_id: string, patch: Record<string, any>) => {
		if (this.failUpdate) throw new Error("fixture atomic clear publication failed");
		this.updates.push(structuredClone(patch));
		this.record = { ...this.record, ...structuredClone(patch) };
	});
}

interface BridgeOptions {
	oldPath: string;
	newPaths?: string[];
	newSessionGate?: Deferred<any>;
	cancel?: boolean;
	samePath?: boolean;
	newMessages?: readonly any[];
	newEntries?: readonly any[];
	modelReadbackMismatch?: boolean;
	getMessagesImpl?: () => Promise<any>;
}

function makeGenerationBridge(options: BridgeOptions): any {
	const newPaths = [...(options.newPaths ?? [generationPath("generation-b")])];
	let generation = 0;
	let model = { provider: PROVIDER, id: MODEL_ID };
	let thinkingLevel = THINKING;
	let switchedToOld = false;
	const listeners = new Set<(event: any) => void>();
	const prompt = vi.fn(async () => ({ success: true }));
	const steer = vi.fn(async () => ({ success: true }));
	const getMessages = vi.fn(async () => {
		if (options.getMessagesImpl) return options.getMessagesImpl();
		const messages = generation === 0 ? oldMessages() : (options.newMessages ?? []);
		return { success: true, data: { messages } };
	});
	const bridge: any = {
		running: true,
		prompt,
		promptWhenReady: prompt,
		steer,
		abort: vi.fn(async () => ({ success: true })),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		waitForReady: vi.fn(async () => {}),
		getMessages,
		getTranscriptCursorSnapshot: vi.fn(async () => ({ success: true, data: { forkMessages: [], entries: [], leafId: null } })),
		getTranscriptEntries: vi.fn(async () => {
			const entries = generation === 0 ? oldEntries() : (options.newEntries ?? []);
			return { success: true, data: { entries, leafId: entries.at(-1)?.id ?? null } };
		}),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				sessionFile: generation === 0 || options.samePath ? options.oldPath : newPaths[Math.min(generation - 1, newPaths.length - 1)],
				model: options.modelReadbackMismatch && generation > 0 ? { provider: PROVIDER, id: "wrong-model" } : model,
				thinkingLevel,
				messageCount: generation === 0 ? oldMessages().length : (options.newMessages?.length ?? 0),
				pendingMessageCount: 0,
			},
		})),
		setModel: vi.fn(async (provider: string, id: string) => {
			model = { provider, id };
			return { success: true };
		}),
		setThinkingLevel: vi.fn(async (level: string) => {
			thinkingLevel = level;
			return { success: true };
		}),
		newSession: vi.fn(async () => {
			if (options.newSessionGate) await options.newSessionGate.promise;
			if (options.cancel) return { type: "response", command: "new_session", success: true, data: { cancelled: true } };
			generation += 1;
			return { type: "response", command: "new_session", success: true, data: { cancelled: false } };
		}),
		compact: vi.fn(async () => ({ success: true })),
		sendCommand: vi.fn(async (command: any) => {
			if (command?.type === "switch_session") {
				generation = 0;
				switchedToOld = true;
			}
			return { success: true };
		}),
		onEvent(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: any) { for (const listener of listeners) listener(event); },
		completeLateNewSession() { generation += 1; },
		get generation() { return generation; },
		get switchedToOld() { return switchedToOld; },
	};
	return bridge;
}

function persisted(id: string, oldPath: string): Record<string, any> {
	return {
		id,
		title: "Context clear lifecycle fixture",
		cwd: tmpRoot,
		agentSessionFile: oldPath,
		projectId: "clear-project",
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_000,
		modelProvider: PROVIDER,
		modelId: MODEL_ID,
		effectiveThinkingLevel: THINKING,
		sandboxed: false,
	};
}

function makeFixture(options: Omit<BridgeOptions, "oldPath"> & { id?: string; oldFileExists?: boolean } = {}): {
	manager: any;
	session: any;
	bridge: any;
	store: AtomicStore;
	client: any;
	oldPath: string;
} {
	const id = options.id ?? `clear-${managers.length + 1}`;
	const oldPath = generationPath(`${id}-generation-a`);
	if (options.oldFileExists !== false) writeOldTranscript(oldPath);
	const record = persisted(id, oldPath);
	const store = new AtomicStore(record);
	const clock = createManualClock(1_700_000_010_000);
	const manager: any = new SessionManager({
		clock,
		stateDir,
		projectContextManager: {} as any,
	});
	if (manager._statusHeartbeatTimer) {
		clock.clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager.projectContextManager = null;
	manager._testStore = store;
	manager.getSessionStore = () => store;
	manager.resolveStoreForSession = () => store;
	manager.resolveStoreForId = () => store;
	manager.readCompactionTranscriptEntries = vi.fn(async () => undefined);
	manager.finalizeCompactionSidecar = vi.fn(async () => undefined);
	manager.assemblePrompt = vi.fn(() => undefined);
	const bridge = makeGenerationBridge({ ...options, oldPath });
	const client = makeClient();
	const session: any = {
		id,
		title: record.title,
		titleGenerated: true,
		cwd: record.cwd,
		status: "idle",
		statusVersion: 0,
		createdAt: record.createdAt,
		lastActivity: record.lastActivity,
		clients: new Set([client]),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		isCompacting: false,
		setupComplete: true,
		projectId: record.projectId,
		sandboxed: false,
		spawnPinnedModel: `${PROVIDER}/${MODEL_ID}`,
		spawnPinnedThinkingLevel: THINKING,
		unsubscribe: vi.fn(),
		rpcClient: bridge,
	};
	manager.sessions.set(id, session);
	manager._testClock = clock;
	managers.push(manager);
	return { manager, session, bridge, store, client, oldPath };
}

function contextClearedFrames(client: any): any[] {
	return client.frames.filter((frame: any) =>
		frame.type === "event" && frame.data?.type === "context_cleared");
}

function clearPublishUpdates(store: AtomicStore): Record<string, any>[] {
	return store.updates.filter((patch) => Object.prototype.hasOwnProperty.call(patch, "contextClearBoundaries"));
}

beforeAll(() => {
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "secrets"),
		hmacKey: Buffer.alloc(32, 0x43),
	});
	initCompactionSidecarDir(stateDir);
});

afterEach(() => {
	while (managers.length > 0) {
		const manager = managers.pop();
		manager.sessionsWithConnectedClients?.clear?.();
		manager.sessions?.clear?.();
		if (manager._statusHeartbeatTimer) manager._testClock?.clearInterval(manager._statusHeartbeatTimer);
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SessionManager context clear transaction", () => {
	it("commits one A-to-B boundary only after a verified empty generation and never leaks old rows", async () => {
		const newPath = generationPath("success-generation-b");
		const { manager, session, bridge, store, client, oldPath } = makeFixture({ newPaths: [newPath] });
		const identity = session;

		await manager.clearContext(session.id);

		expect(manager.sessions.get(session.id)).toBe(identity);
		expect(bridge.newSession).toHaveBeenCalledTimes(1);
		expect(bridge.setModel).toHaveBeenCalledWith(PROVIDER, MODEL_ID);
		expect(bridge.setThinkingLevel).toHaveBeenCalledWith(THINKING);
		expect(store.record.agentSessionFile).toBe(newPath);
		expect(store.record.contextClearBoundaries).toEqual([
			expect.objectContaining({
				schemaVersion: 1,
				previousAgentSessionFile: oldPath,
				activatedAgentSessionFile: newPath,
				previousTranscriptMaterialized: true,
				activatedTranscriptMaterialized: false,
			}),
		]);
		const publications = clearPublishUpdates(store);
		expect(publications).toHaveLength(1);
		expect(publications[0]).toEqual(expect.objectContaining({
			agentSessionFile: newPath,
			contextClearBoundaries: store.record.contextClearBoundaries,
		}));
		expect(contextClearedFrames(client)).toHaveLength(1);

		const piMessages = await bridge.getMessages();
		expect(piMessages.data.messages).toEqual([]);
		const visible = await manager.getMessagesSnapshotBase(session);
		expect(JSON.stringify(visible)).not.toMatch(/SECRET_OLD_|\/clear|__context_cleared/);
	});

	it("creates stable ordered A-to-B and empty B-to-C boundaries without materializing lazy files", async () => {
		const pathB = generationPath("repeat-generation-b");
		const pathC = generationPath("repeat-generation-c");
		const fx = makeFixture({ id: "repeat-clear", newPaths: [pathB, pathC] });

		await fx.manager.clearContext(fx.session.id);
		await fx.manager.clearContext(fx.session.id);

		expect(fs.existsSync(pathB)).toBe(false);
		expect(fs.existsSync(pathC)).toBe(false);
		expect(fx.store.record.agentSessionFile).toBe(pathC);
		expect(fx.store.record.contextClearBoundaries).toEqual([
			expect.objectContaining({
				previousAgentSessionFile: fx.oldPath,
				activatedAgentSessionFile: pathB,
				previousTranscriptMaterialized: true,
			}),
			expect.objectContaining({
				previousAgentSessionFile: pathB,
				activatedAgentSessionFile: pathC,
				previousTranscriptMaterialized: false,
			}),
		]);
		expect(new Set(fx.store.record.contextClearBoundaries.map((boundary: any) => boundary.id)).size).toBe(2);
		expect(contextClearedFrames(fx.client)).toHaveLength(2);
		expect((await fx.bridge.getTranscriptEntries()).data.entries).toEqual([]);
	});

	it("fences prompt, direct steer, and snapshot reads until clear publishes, then releases FIFO exactly once", async () => {
		const gate = deferred<any>();
		const newPath = generationPath("fenced-generation-b");
		const fx = makeFixture({ id: "active-clear", newPaths: [newPath], newSessionGate: gate });
		fx.session.status = "streaming";
		const clear = fx.manager.clearContext(fx.session.id);
		await vi.waitFor(() => expect(fx.bridge.newSession).toHaveBeenCalledTimes(1));
		expect(fx.manager.getSessionReplacementAdmission(fx.session.id)).toEqual({
			active: true,
			generation: expect.any(Number),
		});

		const promptAdmission = fx.manager.enqueuePrompt(fx.session.id, "PROMPT_AFTER_CLEAR", { intentId: "intent-clear-prompt" });
		const steerAdmission = fx.manager.deliverLiveSteer(fx.session.id, "STEER_AFTER_CLEAR", { intentId: "intent-clear-steer" });
		await Promise.all([promptAdmission, steerAdmission]);
		const snapshot = fx.manager.getMessagesSnapshotBase(fx.session);
		let snapshotSettled = false;
		void snapshot.finally(() => { snapshotSettled = true; });
		await flushMicrotasks();

		expect(fx.bridge.prompt).not.toHaveBeenCalled();
		expect(fx.bridge.steer).not.toHaveBeenCalled();
		expect(snapshotSettled).toBe(false);
		expect(fx.session.promptQueue.toArray()).toMatchObject([
			{ id: "intent-clear-prompt", kind: "prompt", targetTurn: "next-turn", deliveryState: "queued" },
			{ id: "intent-clear-steer", kind: "steer", targetTurn: "next-turn", deliveryState: "queued" },
		]);

		gate.resolve({ success: true, data: { cancelled: false } });
		await clear;
		await flushMicrotasks();
		expect((await snapshot).data).toEqual(expect.objectContaining({ messages: [] }));
		expect(fx.bridge.prompt).toHaveBeenCalledTimes(1);
		expect(fx.bridge.prompt.mock.calls[0]?.[0]).toContain("PROMPT_AFTER_CLEAR");
		expect(fx.bridge.steer).not.toHaveBeenCalled();

		fx.manager.handleAgentLifecycle(fx.session, {
			type: "message_end",
			message: { id: "assistant-after-clear", role: "assistant", stopReason: "stop", content: "done" },
		});
		fx.manager.handleAgentLifecycle(fx.session, { type: "agent_end", willRetry: false, messages: [] });
		fx.manager.handleAgentLifecycle(fx.session, { type: "agent_settled" });
		await flushMicrotasks();
		expect(fx.bridge.prompt).toHaveBeenCalledTimes(2);
		expect(fx.bridge.prompt.mock.calls[1]?.[0]).toContain("STEER_AFTER_CLEAR");
		expect(fx.bridge.steer).not.toHaveBeenCalled();
		expect(fx.session.promptQueue.toArray()).toEqual([]);
		expect(fx.manager.getSessionReplacementAdmission(fx.session.id)).toEqual({
			active: false,
			generation: fx.session.lifecycleGeneration,
		});
	});

	it("rechecks compaction immediately before new_session and retains the old generation", async () => {
		const metadataGate = deferred<void>();
		const fx = makeFixture({ id: "compact-wins-preflight" });
		fx.session.pendingMetadataPersist = metadataGate.promise;

		const clear = fx.manager.clearContext(fx.session.id);
		await vi.waitFor(() => expect(fx.manager.getSessionReplacementAdmission(fx.session.id).active).toBe(true));
		fx.session.isCompacting = true;
		metadataGate.resolve(undefined);

		await expect(clear).rejects.toMatchObject({ code: "CLEAR_ACTIVE" });
		expect(fx.bridge.newSession).not.toHaveBeenCalled();
		expect(fx.bridge.sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switch_session" }));
		expect(fx.store.record.agentSessionFile).toBe(fx.oldPath);
		expect(fx.store.record.contextClearBoundaries).toBeUndefined();
		expect(fx.session.lifecycleFenced).not.toBe(true);
		expect(fx.manager.getSessionReplacementAdmission(fx.session.id).active).toBe(false);
	});

	it("retries a snapshot started before admission so stale A rows cannot publish after B commits", async () => {
		const staleRead = deferred<any>();
		let reads = 0;
		let bridgeRef: any;
		const fx = makeFixture({
			id: "snapshot-race-clear",
			newPaths: [generationPath("snapshot-race-generation-b")],
			getMessagesImpl: async () => {
				reads += 1;
				if (reads === 1) return staleRead.promise;
				return bridgeRef.generation === 0
					? { success: true, data: { messages: oldMessages() } }
					: { success: true, data: { messages: [] } };
			},
		});
		bridgeRef = fx.bridge;
		const startedBeforeClear = fx.manager.getMessagesSnapshotBase(fx.session);
		await vi.waitFor(() => expect(fx.bridge.getMessages).toHaveBeenCalledTimes(1));
		const clear = fx.manager.clearContext(fx.session.id);
		await vi.waitFor(() => expect(fx.bridge.newSession).toHaveBeenCalledTimes(1));
		staleRead.resolve({ success: true, data: { messages: oldMessages() } });

		await clear;
		const result = await startedBeforeClear;
		expect(JSON.stringify(result)).not.toContain("SECRET_OLD_");
		expect(fx.bridge.getMessages.mock.calls.length).toBeGreaterThanOrEqual(3);
	});
});

describe("SessionManager context clear rollback", () => {
	it.each([
		[
			"timed-out response",
			(gate: Deferred<any>) => gate.reject(new Error("new_session RPC timed out")),
			/timed out/i,
		],
		[
			"wrong-command success response",
			(gate: Deferred<any>) => gate.resolve({
				type: "response", command: "compact", success: true, data: { cancelled: false },
			}),
			/invalid response/i,
		],
		[
			"success response missing a cancelled boolean",
			(gate: Deferred<any>) => gate.resolve({
				type: "response", command: "new_session", success: true, data: {},
			}),
			/invalid response/i,
		],
	] as const)("stops an ambiguous %s before late completion and restores queued work once", async (_label, settleResponse, errorPattern) => {
		const responseGate = deferred<any>();
		const lateCompletionGate = deferred<void>();
		const fx = makeFixture({ id: `ambiguous-${String(_label).replaceAll(" ", "-")}-clear` });
		const staleBridge = fx.bridge;
		const order: string[] = [];
		staleBridge.newSession.mockImplementation(() => {
			void lateCompletionGate.promise.then(() => {
				order.push("stale-new-session-completed");
				staleBridge.completeLateNewSession();
			});
			return responseGate.promise;
		});
		staleBridge.stop.mockImplementation(async () => { order.push("stale-bridge-stopped"); });

		const restoredBridge = makeGenerationBridge({ oldPath: fx.oldPath });
		let restoredSession: any;
		fx.manager.restoreSession = vi.fn(async (record: Record<string, any>) => {
			order.push("old-context-restore-started");
			expect(record.agentSessionFile).toBe(fx.oldPath);
			expect(record.contextClearBoundaries).toBeUndefined();
			restoredSession = {
				...fx.session,
				status: "idle",
				clients: new Set(),
				promptQueue: new PromptQueue(record.messageQueue ?? []),
				eventBuffer: new EventBuffer(),
				lifecycleFenced: true,
				dormant: false,
				unsubscribe: vi.fn(),
				rpcClient: restoredBridge,
			};
			fx.manager.sessions.set(record.id, restoredSession);
		});
		const lifecycleSpy = vi.spyOn(fx.manager, "handleAgentLifecycle");
		fx.session.status = "streaming";

		const clear = fx.manager.clearContext(fx.session.id);
		await vi.waitFor(() => expect(staleBridge.newSession).toHaveBeenCalledTimes(1));
		await fx.manager.enqueuePrompt(fx.session.id, "FOLLOW_UP_AFTER_AMBIGUOUS_RESPONSE", {
			intentId: "intent-ambiguous-response-follow-up",
		});
		staleBridge.emit({ type: "agent_settled" });
		settleResponse(responseGate);
		await vi.waitFor(() => expect(staleBridge.stop).toHaveBeenCalledTimes(1));
		lateCompletionGate.resolve(undefined);

		await expect(clear).rejects.toThrow(errorPattern);
		await flushMicrotasks();

		expect(order).toEqual([
			"stale-bridge-stopped",
			"old-context-restore-started",
			"stale-new-session-completed",
		]);
		expect(staleBridge.sendCommand.mock.calls.some(([command]: [any]) => command?.type === "switch_session")).toBe(false);
		expect(staleBridge.prompt).not.toHaveBeenCalled();
		expect(staleBridge.generation).toBe(1);
		expect(fx.manager.sessions.get(fx.session.id)).toBe(restoredSession);
		expect((await restoredBridge.getState()).data).toEqual(expect.objectContaining({
			sessionFile: fx.oldPath,
			model: { provider: PROVIDER, id: MODEL_ID },
			thinkingLevel: THINKING,
		}));
		expect(restoredBridge.setModel).toHaveBeenCalledWith(PROVIDER, MODEL_ID);
		expect(restoredBridge.setThinkingLevel).toHaveBeenCalledWith(THINKING);
		expect(restoredBridge.prompt).toHaveBeenCalledTimes(1);
		expect(restoredBridge.prompt.mock.calls[0]?.[0]).toContain("FOLLOW_UP_AFTER_AMBIGUOUS_RESPONSE");
		expect(restoredSession.promptQueue.toArray()).toEqual([]);
		expect(lifecycleSpy.mock.calls.filter(([, event]: any[]) => event?.type === "agent_settled")).toHaveLength(1);
		expect(fx.store.record.agentSessionFile).toBe(fx.oldPath);
		expect(fx.store.record.contextClearBoundaries).toBeUndefined();
		expect(clearPublishUpdates(fx.store)).toEqual([]);
		expect(contextClearedFrames(fx.client)).toEqual([]);
	});

	it.each([
		["cancelled new_session", { cancel: true }, /cancel/i, false],
		["same replacement path", { samePath: true }, /path|session/i, true],
		["non-empty replacement messages", { newMessages: [{ role: "user", content: "LEAK_IN_NEW_GENERATION" }] }, /empty|message/i, true],
		["non-empty replacement entries", { newEntries: [{ type: "message", id: "unexpected", parentId: null, message: { role: "user", content: "LEAK" } }] }, /empty|entr/i, true],
		["model readback mismatch", { modelReadbackMismatch: true }, /model|configuration/i, true],
	] as const)("retains A and emits no boundary when %s", async (_label, bridgeOptions, errorPattern, expectsRollbackSwitch) => {
		const fx = makeFixture({ id: `failure-${String(_label).replaceAll(" ", "-")}`, ...bridgeOptions });
		const before = structuredClone(fx.store.record);

		await expect(fx.manager.clearContext(fx.session.id)).rejects.toThrow(errorPattern);

		expect(fx.store.record.agentSessionFile).toBe(before.agentSessionFile);
		expect(fx.store.record.contextClearBoundaries).toBeUndefined();
		expect(clearPublishUpdates(fx.store)).toEqual([]);
		expect(contextClearedFrames(fx.client)).toEqual([]);
		expect(fx.bridge.switchedToOld).toBe(expectsRollbackSwitch);
		expect(fx.session.lifecycleFenced).not.toBe(true);
	});

	it("rolls back when non-empty old history cannot be captured", async () => {
		const fx = makeFixture({ id: "missing-old-history", oldFileExists: false });
		await expect(fx.manager.clearContext(fx.session.id)).rejects.toThrow(/history|transcript|capture|file/i);
		expect(fx.store.record.agentSessionFile).toBe(fx.oldPath);
		expect(fx.store.record.contextClearBoundaries).toBeUndefined();
		expect(fx.bridge.switchedToOld).toBe(true);
		expect(contextClearedFrames(fx.client)).toEqual([]);
	});

	it.each([
		["update", (store: AtomicStore) => { store.failUpdate = true; }, /publication failed/i],
		["flush", (store: AtomicStore) => { store.failNextFlush = true; }, /flush failed/i],
	] as const)("does not expose a pointer-boundary split when atomic store %s fails", async (_phase, fail, errorPattern) => {
		const fx = makeFixture({ id: `store-${_phase}-failure-clear` });
		fail(fx.store);
		await expect(fx.manager.clearContext(fx.session.id)).rejects.toThrow(errorPattern);
		expect(fx.store.record.agentSessionFile).toBe(fx.oldPath);
		expect(fx.store.record.contextClearBoundaries).toBeUndefined();
		expect(fx.bridge.switchedToOld).toBe(true);
		expect(contextClearedFrames(fx.client)).toEqual([]);
	});
});
