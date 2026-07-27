import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs } from "../harness/mem-fs.js";

const tmpRoot = makeTmpDir("session-manager-spawn-tuple-boundary-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";

const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
const { PreferencesStore } = await import("../../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { modelRecencyRank } = await import("../../src/shared/model-ranks.ts");
const { registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");
const { applyRuntimeSessionThinkingSelection } = await import("../../src/server/ws/runtime-model-selection.ts");
const { initAuthorSidecarDir } = await import("../../src/server/agent/author-sidecar.ts");
const { initPromptDirs } = await import("../../src/server/agent/system-prompt.ts");
const { loadOrCreateToken } = await import("../../src/server/auth/token.ts");

initPromptDirs(stateDir);
initAuthorSidecarDir(stateDir, {
	secretsDir: path.join(tmpRoot, "private-secrets"),
	hmacKey: Buffer.alloc(32, 0x52),
});
loadOrCreateToken();

type StoredRecord = Record<string, any> & { id: string };
type StoreUpdate = { id: string; fields: Record<string, any> };

class RecordingStore {
	readonly records = new Map<string, StoredRecord>();
	readonly updates: StoreUpdate[] = [];

	put(record: StoredRecord): void {
		this.records.set(record.id, { ...record });
	}

	update(id: string, fields: Record<string, any>): void {
		this.updates.push({ id, fields: { ...fields } });
		this.records.set(id, { ...(this.records.get(id) ?? { id }), ...fields });
	}

	get(id: string): StoredRecord | undefined {
		return this.records.get(id);
	}

	archive(id: string): void {
		this.update(id, { archived: true, archivedAt: Date.now() });
	}

	getAll(): StoredRecord[] { return [...this.records.values()]; }
	getLive(): StoredRecord[] { return this.getAll().filter((row) => !row.archived); }
	getArchived(): StoredRecord[] { return this.getAll().filter((row) => row.archived); }
	flush(): void {}
}

function splitModel(model: string | undefined): { provider: string; id: string } | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function makeBridge(options: Record<string, any>, sessionId: string): any {
	const selected = splitModel(options.initialModel);
	let model = selected ?? { provider: "kimi-coding", id: "k2p5" };
	let thinkingLevel = options.initialThinkingLevel ?? "medium";
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
		prompt: vi.fn(async () => ({ success: true })),
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				model,
				thinkingLevel,
				sessionFile: path.join(agentDir, "sessions", `${sessionId}.jsonl`),
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
		onEvent: vi.fn(() => () => {}),
	};
}

function makePreferences(label: string): InstanceType<typeof PreferencesStore> {
	const prefs = new PreferencesStore(path.resolve(`/memfs/${label}`), createMemFs());
	// Make Anthropic rows authenticated without relying on the developer machine's
	// environment. No role/default model is set in the no-explicit-selection case.
	prefs.set("providerKey.anthropic", "test-anthropic-key");
	return prefs;
}

function expectedDefaultModel(models: any[]): string {
	const selectable = models
		.filter((model) => model.provider !== "kimi-coding" && model.sessionSelectable !== false)
		.sort((a, b) => {
			const authDelta = Number(Boolean(b.authenticated)) - Number(Boolean(a.authenticated));
			if (authDelta !== 0) return authDelta;
			const rankDelta = modelRecencyRank(b.id) - modelRecencyRank(a.id);
			if (rankDelta !== 0) return rankDelta;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
	assert.ok(selectable[0], "fixture requires at least one Bobbit session-selectable model");
	return `${selectable[0].provider}/${selectable[0].id}`;
}

function legacySessionRecord(id: string): StoredRecord {
	return {
		id,
		title: "Legacy session without a tuple",
		cwd: tmpRoot,
		agentSessionFile: path.join(agentDir, "sessions", `${id}.jsonl`),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		messageQueue: [],
		wasStreaming: false,
	};
}

async function flushMicrotasks(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
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

describe("actual SessionManager spawn tuple boundaries", () => {
	it("resolves a Bobbit-exposed model before a normal spawn with no explicit role/default model", async () => {
		const prefs = makePreferences("no-explicit-model");
		invalidateModelCache();
		const expectedModel = expectedDefaultModel(await getAvailableModels(prefs));
		const store = new RecordingStore();
		const bridgeOptions: Record<string, any>[] = [];
		const sessionId = "no-hidden-provider-spawn";
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, sessionId);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, { sessionId });
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		assert.equal(
			bridgeOptions[0]?.initialModel,
			expectedModel,
			"NO_HIDDEN_PROVIDER_SPAWN_RESOLUTION: a normal SessionManager spawn must choose the authenticated-first/shared-rank Bobbit catalog row before constructing Pi; an undefined pin lets Pi select hidden kimi-coding",
		);
		assert.notEqual(store.get(sessionId)?.modelProvider, "kimi-coding");
	});

	it("verifies and durably commits an explicit skip-auto reviewer tuple in one update", async () => {
		const prefs = makePreferences("skip-auto-reviewer");
		invalidateModelCache();
		const store = new RecordingStore();
		const sessionId = "skip-auto-reviewer-tuple";
		const model = "anthropic/claude-opus-5";
		const thinkingLevel = "xhigh";
		const bridgeOptions: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, sessionId);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId,
			roleName: "reviewer",
			skipAutoModel: true,
			skipAutoThinking: true,
			initialModel: model,
			initialThinkingLevel: thinkingLevel,
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		assert.equal(bridgeOptions[0]?.initialModel, model);
		assert.equal(bridgeOptions[0]?.initialThinkingLevel, thinkingLevel);
		const tupleWrites = store.updates
			.filter(({ id }) => id === sessionId)
			.map(({ fields }) => fields)
			.filter((fields) => ["modelProvider", "modelId", "effectiveThinkingLevel"]
				.some((key) => Object.prototype.hasOwnProperty.call(fields, key)));
		assert.deepEqual(
			tupleWrites,
			[{
				modelProvider: "anthropic",
				modelId: "claude-opus-5",
				effectiveThinkingLevel: "xhigh",
			}],
			"SKIP_AUTO_REVIEWER_TUPLE_DURABILITY: a spawn-pinned reviewer that skips auto mutation must still read back and atomically persist its exact verified model/thinking tuple",
		);
		assert.deepEqual(
			{
				modelProvider: store.get(sessionId)?.modelProvider,
				modelId: store.get(sessionId)?.modelId,
				effectiveThinkingLevel: store.get(sessionId)?.effectiveThinkingLevel,
			},
			{
				modelProvider: "anthropic",
				modelId: "claude-opus-5",
				effectiveThinkingLevel: "xhigh",
			},
		);
	});

	it("pins extension-only team spawns while preserving the generic raw-argument exemption", async () => {
		const prefs = makePreferences("team-extension-model");
		invalidateModelCache();
		const expectedModel = expectedDefaultModel(await getAvailableModels(prefs));
		const store = new RecordingStore();
		const bridgeOptions: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, `extension-args-${bridgeOptions.length}`);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const teamSession = await manager.createSession(
			tmpRoot,
			["--extension", path.join(tmpRoot, "team-lead-extension.ts")],
			"goal-with-team-lead",
			undefined,
			{ sessionId: "team-extension-only", roleName: "team-lead" },
		);
		if (teamSession.pendingMetadataPersist) await teamSession.pendingMetadataPersist;

		const rawSession = await manager.createSession(
			tmpRoot,
			["--some-generic-pi-flag", "raw-value"],
			undefined,
			undefined,
			{ sessionId: "generic-raw-args" },
		);
		if (rawSession.pendingMetadataPersist) await rawSession.pendingMetadataPersist;

		assert.deepEqual(
			{
				teamInitialModel: bridgeOptions[0]?.initialModel,
				rawInitialModel: bridgeOptions[1]?.initialModel,
			},
			{
				teamInitialModel: expectedModel,
				rawInitialModel: undefined,
			},
			"TEAM_EXTENSION_ARGS_EXPLICIT_PIN: Bobbit-owned extension-only team spawns must bind the current catalog default before Pi starts, without removing the existing generic raw-argument exemption",
		);
	});

	it("pins the current catalog default when cold-restoring a legacy row with no durable tuple", async () => {
		const prefs = makePreferences("legacy-cold-restore");
		invalidateModelCache();
		const expectedModel = expectedDefaultModel(await getAvailableModels(prefs));
		const sessionId = "legacy-cold-restore";
		const ps = legacySessionRecord(sessionId);
		fs.writeFileSync(ps.agentSessionFile, "");
		const store = new RecordingStore();
		store.put(ps);
		const bridgeOptions: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, sessionId);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		await manager.restoreSession(ps);

		assert.equal(
			bridgeOptions[0]?.initialModel,
			expectedModel,
			"LEGACY_RESTORE_EXPLICIT_PIN: cold restore must resolve a Bobbit-selectable catalog model before constructing Pi; an unpinned bridge can report and persist kimi-coding",
		);
		assert.notEqual(store.get(sessionId)?.modelProvider, "kimi-coding");
	});

	it("pins legacy role and force-abort replacements before constructing their new bridges", async () => {
		const prefs = makePreferences("legacy-direct-replacements");
		invalidateModelCache();
		const expectedModel = expectedDefaultModel(await getAvailableModels(prefs));
		const store = new RecordingStore();
		const bridgeOptions: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, options.env?.BOBBIT_SESSION_ID ?? `legacy-replacement-${bridgeOptions.length}`);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const roleSessionId = "legacy-role-replacement";
		const roleTranscript = path.join(agentDir, "sessions", `${roleSessionId}.jsonl`);
		fs.writeFileSync(roleTranscript, "");
		const roleSession = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId: roleSessionId,
			initialModel: expectedModel,
			initialThinkingLevel: "high",
		});
		if (roleSession.pendingMetadataPersist) await roleSession.pendingMetadataPersist;
		await flushMicrotasks();
		store.records.set(roleSessionId, {
			...store.get(roleSessionId),
			id: roleSessionId,
			agentSessionFile: roleTranscript,
			modelProvider: undefined,
			modelId: undefined,
			effectiveThinkingLevel: undefined,
		});
		const roleResult = await manager.assignRole(roleSessionId, {
			name: "legacy-role-without-model",
			promptTemplate: "Legacy role replacement fixture",
			accessory: "none",
		});
		assert.equal(roleResult, true);

		const forceSessionId = "legacy-force-abort-replacement";
		const forceTranscript = path.join(agentDir, "sessions", `${forceSessionId}.jsonl`);
		fs.writeFileSync(forceTranscript, "");
		const forceSession = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId: forceSessionId,
			initialModel: expectedModel,
			initialThinkingLevel: "high",
		});
		if (forceSession.pendingMetadataPersist) await forceSession.pendingMetadataPersist;
		await flushMicrotasks();
		store.records.set(forceSessionId, {
			...store.get(forceSessionId),
			id: forceSessionId,
			agentSessionFile: forceTranscript,
			modelProvider: undefined,
			modelId: undefined,
			effectiveThinkingLevel: undefined,
		});
		forceSession.status = "streaming";
		await manager.forceAbort(forceSessionId, 1);

		assert.deepEqual(
			{
				roleReplacement: bridgeOptions[1]?.initialModel,
				forceAbortReplacement: bridgeOptions[3]?.initialModel,
			},
			{
				roleReplacement: expectedModel,
				forceAbortReplacement: expectedModel,
			},
			"LEGACY_REPLACEMENTS_EXPLICIT_PIN: role and force-abort replacement bridges must resolve the current Bobbit catalog default when a legacy row has no durable tuple",
		);
	});

	it("does not let detached startup thinking overwrite a newer verified runtime selection", async () => {
		const prefs = makePreferences("startup-thinking-race");
		prefs.set("default.sessionThinkingLevel", "xhigh");
		invalidateModelCache();
		const store = new RecordingStore();
		const sessionId = "startup-thinking-stale-write";
		let thinkingLevel = "xhigh";
		let startupReadHeld = false;
		let releaseStartupRead!: () => void;
		const startupReadGate = new Promise<void>((resolve) => { releaseStartupRead = resolve; });
		const setThinkingLevel = vi.fn(async (level: string) => {
			thinkingLevel = level;
			return { success: true };
		});

		registerRpcBridgeFactory((options: Record<string, any>) => {
			const model = splitModel(options.initialModel) ?? { provider: "kimi-coding", id: "k2p5" };
			return {
				running: true,
				async start() {},
				async stop() {},
				async waitForReady() {},
				async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
				prompt: vi.fn(async () => ({ success: true })),
				steer: vi.fn(async () => ({ success: true })),
				abort: vi.fn(async () => ({ success: true })),
				getState: vi.fn(async () => {
					if (!startupReadHeld && store.get(sessionId)?.effectiveThinkingLevel === "xhigh") {
						startupReadHeld = true;
						await startupReadGate;
					}
					return {
						success: true,
						data: {
							model,
							thinkingLevel,
							sessionFile: path.join(agentDir, "sessions", `${sessionId}.jsonl`),
						},
					};
				}),
				getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
				setModel: vi.fn(async () => ({ success: true })),
				setThinkingLevel,
				compact: vi.fn(async () => ({ success: true })),
				sendCommand: vi.fn(async () => ({ success: true })),
				onEvent: vi.fn(() => () => {}),
			};
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId,
			initialModel: "anthropic/claude-opus-5",
			initialThinkingLevel: "xhigh",
		});
		await applyRuntimeSessionThinkingSelection(manager, session, "off");
		releaseStartupRead();
		await flushMicrotasks(20);
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		assert.deepEqual(
			{
				liveThinking: thinkingLevel,
				durableThinking: store.get(sessionId)?.effectiveThinkingLevel,
				lateXhighMutation: setThinkingLevel.mock.calls
					.slice(setThinkingLevel.mock.calls.findIndex(([level]) => level === "off") + 1)
					.some(([level]) => level === "xhigh"),
			},
			{
				liveThinking: "off",
				durableThinking: "off",
				lateXhighMutation: false,
			},
			"STARTUP_THINKING_STALE_WRITE: a detached startup xhigh verification must not mutate live or durable state after a newer runtime off selection commits",
		);
	});
});
