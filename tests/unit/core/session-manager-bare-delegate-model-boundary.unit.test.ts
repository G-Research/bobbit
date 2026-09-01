import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir } from "../../helpers/tmp.ts";
import { createMemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

const tmpRoot = makeTmpDir("session-manager-bare-delegate-model-boundary-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";

const { resetAgentDirStateForTests } = await import("../../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../../src/server/agent/session-manager.ts");
const { PreferencesStore } = await import("../../../src/server/agent/preferences-store.ts");
const {
	findSessionSelectableModel,
	getAvailableModels,
	invalidateModelCache,
} = await import("../../../src/server/agent/model-registry.ts");
const { registerRpcBridgeFactory } = await import("../../../src/server/agent/rpc-bridge.ts");
const { initAuthorSidecarDir } = await import("../../../src/server/agent/author-sidecar.ts");
const { initPromptDirs } = await import("../../../src/server/agent/system-prompt.ts");
const { loadOrCreateToken } = await import("../../../src/server/auth/token.ts");

initPromptDirs(stateDir);
initAuthorSidecarDir(stateDir, {
	secretsDir: path.join(tmpRoot, "private-secrets"),
	hmacKey: Buffer.alloc(32, 0x45),
});
loadOrCreateToken();

const PARENT_ID = "bare-delegate-parent";
const MOCK_PROVIDER = "delegate-boundary-local";
const DEFAULT_MODEL_ID = "supported-default";
const KIMI_NAMED_MODEL_ID = "kimi-coding/claude-opus-5";
const SUPPORTED_KIMI_NAMED_MODEL = `${MOCK_PROVIDER}/${KIMI_NAMED_MODEL_ID}`;

type StoredRecord = Record<string, any> & { id: string };

class RecordingStore {
	readonly records = new Map<string, StoredRecord>();
	readonly puts: string[] = [];
	readonly putSnapshots: StoredRecord[] = [];

	put(record: StoredRecord): void {
		this.puts.push(record.id);
		this.putSnapshots.push({ ...record });
		this.records.set(record.id, { ...record });
	}

	update(id: string, fields: Record<string, any>): void {
		this.records.set(id, { ...(this.records.get(id) ?? { id }), ...fields });
	}

	get(id: string): StoredRecord | undefined { return this.records.get(id); }
	getAll(): StoredRecord[] { return [...this.records.values()]; }
	getLive(): StoredRecord[] { return this.getAll().filter((row) => !row.archived); }
	getArchived(): StoredRecord[] { return this.getAll().filter((row) => row.archived); }
	archive(id: string): void { this.update(id, { archived: true, archivedAt: Date.now() }); }
	flush(): void {}
}

function splitModel(model: string | undefined): { provider: string; id: string } {
	assert.ok(model, "delegate bridge must receive an explicit model");
	const slash = model.indexOf("/");
	assert.ok(slash > 0 && slash < model.length - 1, `invalid model fixture: ${model}`);
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function makeBridge(options: Record<string, any>, counters: { starts: number }): any {
	let model = splitModel(options.initialModel);
	let thinkingLevel = options.initialThinkingLevel ?? "medium";
	const listeners = new Set<(event: any) => void>();
	return {
		running: true,
		async start() { counters.starts++; },
		async stop() {},
		async waitForReady() {},
		async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
		prompt: vi.fn(async () => {
			for (const listener of listeners) listener({ type: "agent_start" });
			return { success: true };
		}),
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				model,
				thinkingLevel,
				sessionFile: path.join(agentDir, "sessions", `${options.env?.BOBBIT_SESSION_ID ?? "delegate"}.jsonl`),
			},
		})),
		getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
		setModel: vi.fn(async (provider: string, id: string) => {
			model = { provider, id };
			return { success: true };
		}),
		setThinkingLevel: vi.fn(async (level: string) => {
			thinkingLevel = level;
			return { success: true };
		}),
		compact: vi.fn(async () => ({ success: true })),
		sendCommand: vi.fn(async () => ({ success: true })),
		onEvent: vi.fn((listener: (event: any) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
}

function makeFixture(label: string): {
	manager: any;
	store: RecordingStore;
	bridgeOptions: Record<string, any>[];
	counters: { starts: number };
} {
	const preferences = new PreferencesStore(path.resolve(`/memfs/bare-delegate-boundary-${label}`), createMemFs());
	preferences.set("customProviders", [{
		id: MOCK_PROVIDER,
		name: MOCK_PROVIDER,
		type: "manual",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-key",
		models: [
			{ id: DEFAULT_MODEL_ID, name: "Delegate boundary default" },
			{ id: KIMI_NAMED_MODEL_ID, name: "Supported Kimi-named local model" },
		],
	}]);
	preferences.set("default.sessionModel", `${MOCK_PROVIDER}/${DEFAULT_MODEL_ID}`);
	preferences.set("default.sessionThinkingLevel", "high");
	invalidateModelCache();

	const store = new RecordingStore();
	store.put({
		id: PARENT_ID,
		title: "Bare delegate parent fixture",
		cwd: tmpRoot,
		agentSessionFile: path.join(agentDir, "sessions", `${PARENT_ID}.jsonl`),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		messageQueue: [],
		wasStreaming: false,
		modelProvider: MOCK_PROVIDER,
		modelId: DEFAULT_MODEL_ID,
		effectiveThinkingLevel: "high",
	});
	store.puts.length = 0;

	const bridgeOptions: Record<string, any>[] = [];
	const counters = { starts: 0 };
	registerRpcBridgeFactory((options: Record<string, any>) => {
		bridgeOptions.push({ ...options });
		return makeBridge(options, counters);
	});

	const manager: any = new SessionManager({ preferencesStore: preferences, stateDir });
	manager._testStore = store;
	managers.push(manager);
	return { manager, store, bridgeOptions, counters };
}

const managers: any[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	invalidateModelCache();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("actual SessionManager bare-delegate model boundary", () => {
	it("persists TeamStore-derived ownership in the bare delegate's initial row", async () => {
		const { manager, store } = makeFixture("teamstore-ownership");
		const trustedGoalId = "teamstore-referenced-goal";
		manager.getTrustedTeamGoalIdForSession = (id: string) =>
			id === PARENT_ID ? trustedGoalId : store.get(id)?.teamGoalId;

		const child = await manager.createDelegateSession(PARENT_ID, {
			instructions: "Preserve supplemental team ownership",
			cwd: tmpRoot,
		});
		if (child.pendingMetadataPersist) await child.pendingMetadataPersist;

		const initial = store.putSnapshots.find((row) => row.id === child.id);
		assert.ok(initial, "delegate setup must publish an initial structural row");
		assert.equal(initial.teamGoalId, trustedGoalId, "initial row carries TeamStore-derived ownership");
		assert.equal(store.get(child.id)?.teamGoalId, trustedGoalId, "final metadata keeps the same trusted stamp");
	});

	it("rejects exact deferred provider before RpcBridge construction or child persistence", async () => {
		const { manager, store, bridgeOptions, counters } = makeFixture("deferred-provider");
		let rejection: unknown;
		try {
			await manager.createDelegateSession(PARENT_ID, {
				instructions: "Exercise the bare delegate provider boundary",
				cwd: tmpRoot,
				initialModel: "kimi-coding/k2p5",
				initialThinkingLevel: "high",
			});
		} catch (error) {
			rejection = error;
		}

		expect.soft(
			rejection,
			"BARE_DELEGATE_DEFERRED_PROVIDER_PRESPAWN: exact kimi-coding must be rejected before executePlan can construct or start RpcBridge",
		).toBeInstanceOf(Error);
		expect.soft(String((rejection as Error | undefined)?.message ?? "")).toMatch(
			/not currently available|not session-selectable|unavailable/i,
		);
		expect.soft(bridgeOptions, "deferred provider must not reach RpcBridge construction").toHaveLength(0);
		expect.soft(counters.starts, "deferred provider must not start an agent process").toBe(0);
		expect.soft(store.puts, "rejected bare delegate must not write a child record").toEqual([]);
		expect.soft([...store.records.keys()], "only the parent fixture may remain durable").toEqual([PARENT_ID]);
		expect.soft(manager.sessions.size, "rejected bare delegate must not remain live").toBe(0);
	});

	it("preserves durable thinking for an arbitrary dynamic local reasoning row", async () => {
		const { manager, store, bridgeOptions, counters } = makeFixture("dynamic-reasoning");
		const row = findSessionSelectableModel(
			await getAvailableModels((manager as any).preferencesStore),
			MOCK_PROVIDER,
			DEFAULT_MODEL_ID,
		);
		assert.ok(row, "dynamic reasoning fixture must be selectable");
		row.reasoning = true;

		const child = await manager.createDelegateSession(PARENT_ID, {
			instructions: "Preserve the owner's dynamic reasoning level",
			cwd: tmpRoot,
		});
		if (child.pendingMetadataPersist) await child.pendingMetadataPersist;

		assert.equal(bridgeOptions[0]?.initialModel, `${MOCK_PROVIDER}/${DEFAULT_MODEL_ID}`);
		assert.equal(bridgeOptions[0]?.initialThinkingLevel, "high");
		assert.equal(store.get(child.id)?.effectiveThinkingLevel, "high");
		assert.equal(counters.starts, 1);
	});

	it("accepts a selectable custom provider when only the model ID contains kimi", async () => {
		const { manager, store, bridgeOptions, counters } = makeFixture("supported-kimi-id");
		const selectable = findSessionSelectableModel(
			await getAvailableModels((manager as any).preferencesStore),
			MOCK_PROVIDER,
			KIMI_NAMED_MODEL_ID,
		);
		assert.ok(selectable, "positive fixture must be a current Bobbit-selectable catalog row");

		const child = await manager.createDelegateSession(PARENT_ID, {
			instructions: "Preserve a supported provider identity",
			cwd: tmpRoot,
			initialModel: SUPPORTED_KIMI_NAMED_MODEL,
			initialThinkingLevel: "high",
		});
		if (child.pendingMetadataPersist) await child.pendingMetadataPersist;

		assert.equal(bridgeOptions.length, 1);
		assert.equal(bridgeOptions[0].initialModel, SUPPORTED_KIMI_NAMED_MODEL);
		assert.equal(bridgeOptions[0].initialThinkingLevel, "off", "the exact non-reasoning catalog row must beat model-ID heuristics");
		assert.equal(counters.starts, 1);
		assert.deepEqual(
			{
				provider: store.get(child.id)?.modelProvider,
				modelId: store.get(child.id)?.modelId,
				thinking: store.get(child.id)?.effectiveThinkingLevel,
				delegateOf: store.get(child.id)?.delegateOf,
			},
			{
				provider: MOCK_PROVIDER,
				modelId: KIMI_NAMED_MODEL_ID,
				thinking: "off",
				delegateOf: PARENT_ID,
			},
			"provider filtering must use exact provider identity and preserve slash-containing Kimi-named IDs",
		);
	});
});
