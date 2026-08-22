// v2-native — executable cold/live recovery coverage for lazy clear generations.

import { guardProcessEnv } from "../core/helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs } from "../harness/mem-fs.js";

const tmpRoot = makeTmpDir("context-clear-recovery-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });

const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { PreferencesStore } = await import("../../src/server/agent/preferences-store.ts");
const { invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");
const { initAuthorSidecarDir } = await import("../../src/server/agent/author-sidecar.ts");
const { initCompactionSidecarDir } = await import("../../src/server/agent/compaction-sidecar.ts");
const { activeAgentSessionsDir } = await import("../../src/server/agent/agent-session-path.ts");

const PROVIDER = "clear-recovery-provider";
const MODEL_ID = "clear-recovery-model";
const THINKING = "high";
const MODEL = `${PROVIDER}/${MODEL_ID}`;
const SYSTEM_PROMPT_MARKER = "CURRENT_SYSTEM_PROMPT_AND_TOOLS";
const OLD_HISTORY_MARKERS = [
	"SECRET_GENERATION_A_USER",
	"SECRET_GENERATION_A_ASSISTANT",
	"SECRET_GENERATION_A_TOOL_INPUT",
	"SECRET_GENERATION_A_TOOL_RESULT",
	"SECRET_GENERATION_A_COMPACTION_SUMMARY",
	"/clear",
	"__context_cleared",
];
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

async function flushMicrotasks(turns = 16): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function hostGeneration(label: string): string {
	return path.join(activeAgentSessionsDir(), "--context-clear-recovery--", `${label}.jsonl`);
}

function containerGeneration(label: string): string {
	return `/home/node/.bobbit/agent/sessions/--context-clear-recovery--/${label}.jsonl`;
}

function boundary(id: string, previous: string, activated: string, previousMaterialized: boolean): Record<string, any> {
	return {
		schemaVersion: 1,
		id,
		clearedAt: "2026-08-22T10:00:00.000Z",
		previousAgentSessionFile: previous,
		activatedAgentSessionFile: activated,
		activatedTranscriptMaterialized: false,
		previousTranscriptMaterialized: previousMaterialized,
		compactionIds: [],
	};
}

function persistedEmptyGeneration(options: {
	id: string;
	sandboxed: boolean;
	repeated?: boolean;
	messageQueue?: any[];
}): Record<string, any> {
	const pathFor = options.sandboxed ? containerGeneration : hostGeneration;
	const pathA = pathFor(`${options.id}-a`);
	const pathB = pathFor(`${options.id}-b-missing`);
	const first = boundary(`clr_${options.id}_a`, pathA, pathB, true);
	if (!options.repeated) {
		return {
			id: options.id,
			title: `Empty clear recovery ${options.id}`,
			cwd: options.sandboxed ? "/workspace" : tmpRoot,
			projectId: "clear-recovery-project",
			agentSessionFile: pathB,
			contextClearBoundaries: [first],
			createdAt: 1_700_000_000_000,
			lastActivity: 1_700_000_000_000,
			modelProvider: PROVIDER,
			modelId: MODEL_ID,
			effectiveThinkingLevel: THINKING,
			sandboxed: options.sandboxed,
			messageQueue: options.messageQueue ?? [],
		};
	}
	const pathC = pathFor(`${options.id}-c-missing`);
	return {
		id: options.id,
		title: `Repeated empty clear recovery ${options.id}`,
		cwd: options.sandboxed ? "/workspace" : tmpRoot,
		projectId: "clear-recovery-project",
		agentSessionFile: pathC,
		contextClearBoundaries: [
			first,
			boundary(`clr_${options.id}_b`, pathB, pathC, false),
		],
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_000,
		modelProvider: PROVIDER,
		modelId: MODEL_ID,
		effectiveThinkingLevel: THINKING,
		sandboxed: options.sandboxed,
		messageQueue: options.messageQueue ?? [],
	};
}

class RecoveryStore {
	record: Record<string, any>;
	readonly updates: Record<string, any>[] = [];
	readonly flushAsync = vi.fn(async () => {});
	failRepair = false;

	constructor(record: Record<string, any>) {
		this.record = structuredClone(record);
	}

	get = vi.fn((_id: string) => this.record);
	getLive = vi.fn(() => [this.record]);
	getAll = vi.fn(() => [this.record]);
	put = vi.fn((next: Record<string, any>) => { this.record = structuredClone(next); });
	archive = vi.fn(() => {});
	archiveAsync = vi.fn(async () => {});
	update = vi.fn((_id: string, patch: Record<string, any>) => {
		if (this.failRepair && Object.prototype.hasOwnProperty.call(patch, "contextClearBoundaries")) {
			throw new Error("fixture recovery publication failed");
		}
		this.updates.push(structuredClone(patch));
		this.record = { ...this.record, ...structuredClone(patch) };
	});
}

interface RecoveryBridgeOptions {
	freshPath: string;
	startGate?: Deferred<void>;
	startFailure?: Error;
	nonEmpty?: boolean;
	wrongTuple?: boolean;
}

function makeRecoveryBridge(options: RecoveryBridgeOptions): any {
	let model = { provider: PROVIDER, id: MODEL_ID };
	let thinkingLevel = THINKING;
	const commandJournal: any[] = [];
	const providerRequests: any[] = [];
	const listeners = new Set<(event: any) => void>();
	const prompt = vi.fn(async (text: string) => {
		commandJournal.push({ type: "prompt", text });
		providerRequests.push({
			systemPrompt: SYSTEM_PROMPT_MARKER,
			messages: options.nonEmpty
				? [{ role: "user", content: OLD_HISTORY_MARKERS.join(" ") }, { role: "user", content: text }]
				: [{ role: "user", content: text }],
		});
		return { success: true };
	});
	const bridge: any = {
		running: true,
		commandJournal,
		providerRequests,
		start: vi.fn(async () => {
			if (options.startFailure) throw options.startFailure;
			if (options.startGate) await options.startGate.promise;
		}),
		stop: vi.fn(async () => {}),
		waitForReady: vi.fn(async () => {}),
		prompt,
		promptWhenReady: prompt,
		steer: vi.fn(async (text: string) => {
			commandJournal.push({ type: "steer", text });
			return { success: true };
		}),
		abort: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				sessionFile: options.freshPath,
				model: options.wrongTuple ? { provider: PROVIDER, id: "wrong-model" } : model,
				thinkingLevel,
				messageCount: options.nonEmpty ? 1 : 0,
				pendingMessageCount: 0,
			},
		})),
		getMessages: vi.fn(async () => ({
			success: true,
			data: { messages: options.nonEmpty ? [{ role: "user", content: OLD_HISTORY_MARKERS.join(" ") }] : [] },
		})),
		getTranscriptEntries: vi.fn(async () => ({
			success: true,
			data: {
				entries: options.nonEmpty
					? [{ type: "message", id: "leaked-old", parentId: null, message: { role: "user", content: OLD_HISTORY_MARKERS.join(" ") } }]
					: [],
				leafId: options.nonEmpty ? "leaked-old" : null,
			},
		})),
		getTranscriptCursorSnapshot: vi.fn(async () => ({ success: true, data: { forkMessages: [], entries: [], leafId: null } })),
		setModel: vi.fn(async (provider: string, id: string) => {
			model = { provider, id };
			return { success: true };
		}),
		setThinkingLevel: vi.fn(async (level: string) => {
			thinkingLevel = level;
			return { success: true };
		}),
		newSession: vi.fn(async () => ({
			type: "response", command: "new_session", success: true, data: { cancelled: false },
		})),
		compact: vi.fn(async () => ({ success: true })),
		sendCommand: vi.fn(async (command: any) => {
			commandJournal.push(command);
			return { success: true };
		}),
		onEvent(listener: (event: any) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: any) { for (const listener of listeners) listener(event); },
	};
	return bridge;
}

const preferencesStore = new PreferencesStore(path.resolve("/memfs/context-clear-recovery"), createMemFs());
preferencesStore.set("customProviders", [{
	id: PROVIDER,
	name: "Clear recovery fixture",
	type: "manual",
	baseUrl: "http://127.0.0.1:9",
	apiKey: "fixture-key",
	models: [{ id: MODEL_ID, name: "Clear Recovery Model", reasoning: true }],
}]);
preferencesStore.set("default.sessionModel", MODEL);

function makeManager(store: RecoveryStore, bridgeFactory: (options: any) => any): any {
	invalidateModelCache();
	registerRpcBridgeFactory(bridgeFactory);
	const manager: any = new SessionManager({
		projectContextManager: {} as any,
		preferencesStore,
		stateDir,
	});
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager._testStore = store;
	manager.projectContextManager = {
		all: () => [],
		getAllLiveSessions: () => store.getLive(),
	};
	manager.getSessionStore = () => store;
	manager.resolveStoreForSession = () => store;
	manager.resolveStoreForId = () => store;
	manager.assemblePrompt = vi.fn(() => path.join(stateDir, "current-system-prompt.md"));
	manager.applyScopedGatewayCredentials = vi.fn(() => {});
	manager.applyDirectProviderEnv = vi.fn(async () => {});
	manager.ensureMcpManagerForContext = vi.fn(async () => {});
	manager.buildToolActivationArgs = vi.fn(() => ({ args: [], runtimeExtensions: [], env: {} }));
	// Model catalog selection is covered by dedicated suites. Keep this recovery
	// harness on its exact persisted tuple so only lifecycle verification is live.
	manager.requireCurrentCatalogSpawnModel = vi.fn(async (model: string) => model);
	manager.resolveCurrentCatalogSpawnModel = vi.fn(async (models: string[]) => models.find(Boolean));
	manager.resolveCurrentCatalogPreferredThinkingLevel = vi.fn(async () => THINKING);
	manager.resolveCurrentCatalogThinkingLevel = vi.fn(async () => THINKING);
	manager.finalizeSpawnOptions = vi.fn(async (options: any, requested: any) => {
		options.initialModel = requested.model ?? MODEL;
		options.initialThinkingLevel = requested.thinkingLevel ?? THINKING;
	});
	manager.sessionSecretStore = {
		getOrCreateSecret: () => "context-clear-recovery-secret",
		remove: () => {},
	};
	managers.push(manager);
	return manager;
}

function liveSession(record: Record<string, any>, bridge: any, clients = new Set<any>()): any {
	return {
		id: record.id,
		title: record.title,
		titleGenerated: true,
		cwd: record.cwd,
		status: "idle",
		statusVersion: 4,
		createdAt: record.createdAt,
		lastActivity: record.lastActivity,
		clients,
		promptQueue: new PromptQueue(record.messageQueue ?? []),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		isCompacting: false,
		setupComplete: true,
		projectId: record.projectId,
		sandboxed: record.sandboxed,
		spawnPinnedModel: MODEL,
		spawnPinnedThinkingLevel: THINKING,
		unsubscribe: vi.fn(),
		rpcClient: bridge,
	};
}

function repairUpdates(store: RecoveryStore): Record<string, any>[] {
	return store.updates.filter((patch) =>
		Object.prototype.hasOwnProperty.call(patch, "agentSessionFile")
		&& Object.prototype.hasOwnProperty.call(patch, "contextClearBoundaries"));
}

function latestBoundary(record: Record<string, any>): any {
	return record.contextClearBoundaries.at(-1);
}

beforeAll(() => {
	fs.writeFileSync(path.join(stateDir, "current-system-prompt.md"), SYSTEM_PROMPT_MARKER, "utf8");
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "secrets"),
		hmacKey: Buffer.alloc(32, 0x52),
	});
	initCompactionSidecarDir(stateDir);
});

afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const manager = managers.pop();
		manager.sessionsWithConnectedClients?.clear?.();
		manager.sessions?.clear?.();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("unmaterialized clear generation cold recovery", () => {
	for (const sandboxed of [false, true]) {
		for (const repeated of [false, true]) {
			test(`repairs only the latest ${sandboxed ? "sandbox" : "host"} ${repeated ? "repeated" : "first"} clear generation without historical switch`, async () => {
				const realm = sandboxed ? "sandbox" : "host";
				const record = persistedEmptyGeneration({ id: `cold-${realm}-${repeated}`, sandboxed, repeated });
				const before = structuredClone(record);
				const freshPath = sandboxed
					? containerGeneration(`cold-${realm}-${repeated}-fresh`)
					: hostGeneration(`cold-${realm}-${repeated}-fresh`);
				const store = new RecoveryStore(record);
				const bridge = makeRecoveryBridge({ freshPath });
				const manager = makeManager(store, () => bridge);
				if (sandboxed) {
					manager.applySandboxWiring = vi.fn(async (options: any) => {
						options.containerId = "clear-recovery-container";
						options.sandboxed = true;
						return true;
					});
				}

				await manager._restoreSessionCoalesced(store.record);

				expect(manager.sessions.get(record.id)?.id).toBe(record.id);
				expect(store.record.agentSessionFile).toBe(freshPath);
				expect(store.record.contextClearBoundaries).toHaveLength(before.contextClearBoundaries.length);
				expect(store.record.contextClearBoundaries.slice(0, -1)).toEqual(before.contextClearBoundaries.slice(0, -1));
				expect(latestBoundary(store.record)).toEqual({
					...latestBoundary(before),
					activatedAgentSessionFile: freshPath,
				});
				expect(latestBoundary(store.record).activatedTranscriptMaterialized).toBe(false);
				expect(repairUpdates(store)).toHaveLength(1);
				expect(bridge.sendCommand.mock.calls.some(([command]: [any]) => command?.type === "switch_session")).toBe(false);
				expect(bridge.setModel).toHaveBeenCalledWith(PROVIDER, MODEL_ID);
				expect(bridge.setThinkingLevel).toHaveBeenCalledWith(THINKING);
				expect((await bridge.getMessages()).data.messages).toEqual([]);
				expect((await bridge.getTranscriptEntries()).data.entries).toEqual([]);
				if (sandboxed) expect(manager.applySandboxWiring).toHaveBeenCalled();
			});
		}
	}

	test("a follow-up provider request keeps the current runtime but contains no prior generation content", async () => {
		const record = persistedEmptyGeneration({ id: "cold-non-leak", sandboxed: false });
		const freshPath = hostGeneration("cold-non-leak-fresh");
		const store = new RecoveryStore(record);
		const bridge = makeRecoveryBridge({ freshPath });
		const manager = makeManager(store, () => bridge);

		await manager._restoreSessionCoalesced(store.record);
		await manager.enqueuePrompt(record.id, "ONLY_NEW_GENERATION_PROMPT", { intentId: "intent-only-new" });
		await flushMicrotasks();

		expect(bridge.providerRequests).toHaveLength(1);
		const serialized = JSON.stringify(bridge.providerRequests[0]);
		expect(serialized).toContain(SYSTEM_PROMPT_MARKER);
		expect(serialized).toContain("ONLY_NEW_GENERATION_PROMPT");
		for (const marker of OLD_HISTORY_MARKERS) expect(serialized).not.toContain(marker);
	});
});

describe("unmaterialized clear generation live respawn", () => {
	test("parks prompt and steer across live respawn and releases each once only after atomic repair", async () => {
		const record = persistedEmptyGeneration({ id: "live-repair-queue", sandboxed: false });
		const before = structuredClone(record);
		const freshPath = hostGeneration("live-repair-queue-fresh");
		const startGate = deferred<void>();
		const replacement = makeRecoveryBridge({ freshPath, startGate });
		const store = new RecoveryStore(record);
		const manager = makeManager(store, () => replacement);
		const oldBridge = makeRecoveryBridge({ freshPath: record.agentSessionFile });
		oldBridge.stop = vi.fn(async () => {});
		manager.sessions.set(record.id, liveSession(record, oldBridge));
		const order: string[] = [];
		store.update.mockImplementation((_id: string, patch: Record<string, any>) => {
			if (Object.prototype.hasOwnProperty.call(patch, "contextClearBoundaries")) order.push("repair-published");
			store.updates.push(structuredClone(patch));
			store.record = { ...store.record, ...structuredClone(patch) };
		});
		replacement.prompt.mockImplementation(async (text: string) => {
			order.push(`prompt:${text.includes("PROMPT_DURING_REPAIR") ? "P" : "S"}`);
			return { success: true };
		});

		const restart = manager.restartAgent(record.id);
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		const promptAdmission = manager.enqueuePrompt(record.id, "PROMPT_DURING_REPAIR", { intentId: "intent-repair-prompt" });
		const steerAdmission = manager.deliverLiveSteer(record.id, "STEER_DURING_REPAIR", { intentId: "intent-repair-steer" });
		await Promise.all([promptAdmission, steerAdmission]);
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(replacement.steer).not.toHaveBeenCalled();

		startGate.resolve(undefined);
		await restart;
		await flushMicrotasks();
		const restored = manager.sessions.get(record.id);
		expect(store.record.contextClearBoundaries).toHaveLength(before.contextClearBoundaries.length);
		expect(latestBoundary(store.record)).toEqual({
			...latestBoundary(before),
			activatedAgentSessionFile: freshPath,
		});
		expect(order[0]).toBe("repair-published");
		expect(replacement.prompt).toHaveBeenCalledTimes(1);
		expect(replacement.steer).not.toHaveBeenCalled();

		manager.handleAgentLifecycle(restored, {
			type: "message_end",
			message: { id: "assistant-repaired", role: "assistant", stopReason: "stop", content: "done" },
		});
		manager.handleAgentLifecycle(restored, { type: "agent_end", willRetry: false, messages: [] });
		manager.handleAgentLifecycle(restored, { type: "agent_settled" });
		await flushMicrotasks();
		expect(replacement.prompt).toHaveBeenCalledTimes(2);
		expect(replacement.prompt.mock.calls.filter(([text]: [string]) => text.includes("PROMPT_DURING_REPAIR"))).toHaveLength(1);
		expect(replacement.prompt.mock.calls.filter(([text]: [string]) => text.includes("STEER_DURING_REPAIR"))).toHaveLength(1);
		expect(replacement.steer).not.toHaveBeenCalled();
		expect(restored.promptQueue.toArray()).toEqual([]);
		expect(replacement.sendCommand.mock.calls.some(([command]: [any]) => command?.type === "switch_session")).toBe(false);
	});
});

describe("unmaterialized recovery failures", () => {
	test.each([
		["bridge start", { startFailure: new Error("fixture fresh bridge start failed") }, /start failed/i],
		["non-empty runtime", { nonEmpty: true }, /empty|message/i],
		["configuration readback", { wrongTuple: true }, /model|configuration/i],
	] as const)("keeps the durable pointer/boundary pair fenced when %s fails", async (_label, bridgeOptions, errorPattern) => {
		const record = persistedEmptyGeneration({ id: `failed-${String(_label).replaceAll(" ", "-")}`, sandboxed: false });
		const before = structuredClone(record);
		const store = new RecoveryStore(record);
		const candidate = makeRecoveryBridge({
			freshPath: hostGeneration(`failed-${String(_label).replaceAll(" ", "-")}-fresh`),
			...bridgeOptions,
		});
		const manager = makeManager(store, () => candidate);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(manager._restoreSessionCoalesced(store.record)).rejects.toThrow(errorPattern);

		expect(store.record.agentSessionFile).toBe(before.agentSessionFile);
		expect(store.record.contextClearBoundaries).toEqual(before.contextClearBoundaries);
		expect(repairUpdates(store)).toEqual([]);
		expect(candidate.prompt).not.toHaveBeenCalled();
		expect(candidate.steer).not.toHaveBeenCalled();
		expect(candidate.sendCommand.mock.calls.some(([command]: [any]) => command?.type === "switch_session")).toBe(false);
		expect(candidate.stop).toHaveBeenCalledTimes(1);
	});

	test("store publication failure retains the old durable pair and does not drain accepted live work", async () => {
		const record = persistedEmptyGeneration({ id: "failed-live-store-repair", sandboxed: true });
		const before = structuredClone(record);
		const store = new RecoveryStore(record);
		store.failRepair = true;
		const candidate = makeRecoveryBridge({ freshPath: containerGeneration("failed-live-store-repair-fresh") });
		const manager = makeManager(store, () => candidate);
		manager.applySandboxWiring = vi.fn(async (options: any) => {
			options.containerId = "failed-repair-container";
			options.sandboxed = true;
			return true;
		});
		const oldBridge = makeRecoveryBridge({ freshPath: record.agentSessionFile });
		manager.sessions.set(record.id, liveSession(record, oldBridge));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const restart = manager.restartAgent(record.id);
		await vi.waitFor(() => expect(candidate.start).toHaveBeenCalledTimes(1));
		await manager.enqueuePrompt(record.id, "PARK_ON_FAILED_REPAIR", { intentId: "intent-failed-repair" });
		await expect(restart).rejects.toThrow(/publication failed/i);

		expect(store.record.agentSessionFile).toBe(before.agentSessionFile);
		expect(store.record.contextClearBoundaries).toEqual(before.contextClearBoundaries);
		expect(candidate.prompt).not.toHaveBeenCalled();
		expect(candidate.steer).not.toHaveBeenCalled();
		expect(candidate.sendCommand.mock.calls.some(([command]: [any]) => command?.type === "switch_session")).toBe(false);
		expect(candidate.stop).toHaveBeenCalledTimes(1);
		const capsule = manager.sessions.get(record.id);
		expect(capsule?.promptQueue.toArray()).toEqual([
			expect.objectContaining({ id: "intent-failed-repair", deliveryState: "queued" }),
		]);
		expect(capsule?.lifecycleFenced ?? true).toBe(true);
	});
});
