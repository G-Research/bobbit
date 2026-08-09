import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
const { clampThinkingLevelForModel } = await import("../../src/server/agent/thinking-level-clamp.ts");
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

const DYNAMIC_PROVIDER = "local-reasoner";
const DYNAMIC_MODEL_ID = "reasoner-v1";
const DYNAMIC_MODEL = `${DYNAMIC_PROVIDER}/${DYNAMIC_MODEL_ID}`;

async function makeDynamicReasoningPreferences(label: string): Promise<InstanceType<typeof PreferencesStore>> {
	const prefs = makePreferences(label);
	prefs.set("customProviders", [{
		id: DYNAMIC_PROVIDER,
		name: DYNAMIC_PROVIDER,
		type: "manual",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-key",
		models: [{ id: DYNAMIC_MODEL_ID, name: "Dynamic local reasoner" }],
	}]);
	invalidateModelCache();
	const models = await getAvailableModels(prefs);
	const row = models.find((model) => model.provider === DYNAMIC_PROVIDER && model.id === DYNAMIC_MODEL_ID);
	assert.ok(row, "fixture requires a current custom/local catalog row");
	// Manual discovery supplies the same mutable ApiModel shape as Ollama/LM Studio.
	// Mark this arbitrary, non-heuristic ID as the reasoning metadata those dynamic
	// providers report; the registry cache is the production metadata authority.
	row.reasoning = true;
	return prefs;
}

function startDynamicAigw(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url === "/.well-known/opencode") {
			const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				model: "local:reasoner-v1",
				provider: {
					local: {
						npm: "@ai-sdk/openai",
						options: { baseURL: `${origin}/v1` },
						models: {
							"reasoner-v1": {
								name: "Discovered gateway reasoner",
								reasoning: true,
								tool_call: true,
								variants: { none: {}, low: {}, high: {}, xhigh: {}, max: {} },
								limit: { context: 64_000, output: 8_192 },
								modalities: { input: ["text"] },
							},
						},
					},
				},
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		close: () => new Promise<void>((done) => server.close(() => done())),
	})));
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

const RETIRED_MODEL = "retired-custom/retired-opus";
const SELECTABLE_DEFAULT = "anthropic/claude-opus-5";
const RETIRED_TUPLE = {
	modelProvider: "retired-custom",
	modelId: "retired-opus",
	effectiveThinkingLevel: "high",
} as const;

function durableSessionRecord(id: string): StoredRecord {
	return {
		...legacySessionRecord(id),
		title: "Session with a previously verified durable tuple",
		...RETIRED_TUPLE,
	};
}

function durableTupleBytes(record: StoredRecord | undefined): string {
	return JSON.stringify({
		modelProvider: record?.modelProvider,
		modelId: record?.modelId,
		effectiveThinkingLevel: record?.effectiveThinkingLevel,
	});
}

async function makeCatalogDriftPreferences(label: string): Promise<InstanceType<typeof PreferencesStore>> {
	const prefs = makePreferences(label);
	prefs.set("default.sessionModel", SELECTABLE_DEFAULT);
	invalidateModelCache();
	const models = await getAvailableModels(prefs);
	assert.ok(
		models.some((model) => `${model.provider}/${model.id}` === SELECTABLE_DEFAULT && model.sessionSelectable !== false),
		"catalog-drift fixture requires a different selectable default",
	);
	assert.ok(
		!models.some((model) => `${model.provider}/${model.id}` === RETIRED_MODEL),
		"catalog-drift fixture requires the previously verified durable model to be absent",
	);
	return prefs;
}

function trackConstructedBridges(): {
	options: Record<string, any>[];
	getStartCount: () => number;
	reset: () => void;
} {
	const options: Record<string, any>[] = [];
	let startCount = 0;
	registerRpcBridgeFactory((bridgeOptions: Record<string, any>) => {
		options.push({ ...bridgeOptions });
		const sessionId = bridgeOptions.env?.BOBBIT_SESSION_ID ?? `tracked-${options.length}`;
		const bridge = makeBridge(bridgeOptions, sessionId);
		bridge.start = vi.fn(async () => { startCount += 1; });
		return bridge;
	});
	return {
		options,
		getStartCount: () => startCount,
		reset: () => {
			options.length = 0;
			startCount = 0;
		},
	};
}

function isActionableUnavailableFailure(message: string | undefined): boolean {
	return !!message
		&& message.includes(RETIRED_MODEL)
		&& /not currently available for session selection/i.test(message);
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
	it("uses the exact dynamic catalog row for create and cold-restore thinking clamps", async () => {
		const prefs = await makeDynamicReasoningPreferences("dynamic-reasoning-create-restore");
		const store = new RecordingStore();
		const bridgeOptions: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			return makeBridge(options, options.env?.BOBBIT_SESSION_ID ?? `dynamic-${bridgeOptions.length}`);
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const createdId = "dynamic-reasoning-create";
		const created = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId: createdId,
			initialModel: DYNAMIC_MODEL,
			initialThinkingLevel: "high",
		});
		if (created.pendingMetadataPersist) await created.pendingMetadataPersist;

		const restoredId = "dynamic-reasoning-restore";
		const restoredRecord: StoredRecord = {
			...legacySessionRecord(restoredId),
			modelProvider: DYNAMIC_PROVIDER,
			modelId: DYNAMIC_MODEL_ID,
			effectiveThinkingLevel: "high",
		};
		fs.writeFileSync(restoredRecord.agentSessionFile, "");
		store.put(restoredRecord);
		await manager.restoreSession(restoredRecord);

		assert.deepEqual(
			{
				createSpawnThinking: bridgeOptions[0]?.initialThinkingLevel,
				createDurableThinking: store.get(createdId)?.effectiveThinkingLevel,
				restoreSpawnThinking: bridgeOptions[1]?.initialThinkingLevel,
				restoreDurableThinking: store.get(restoredId)?.effectiveThinkingLevel,
			},
			{
				createSpawnThinking: "high",
				createDurableThinking: "high",
				restoreSpawnThinking: "high",
				restoreDurableThinking: "high",
			},
			"DYNAMIC_MODEL_METADATA: an arbitrary custom/local reasoning row must not be downgraded by string heuristics at create or cold restore",
		);
	});

	it("uses discovered AIGW reasoning metadata for a non-heuristic model ID", async () => {
		const gateway = await startDynamicAigw();
		try {
			const prefs = makePreferences("dynamic-aigw-reasoning");
			prefs.set("aigw.url", gateway.url);
			invalidateModelCache();
			const row = (await getAvailableModels(prefs)).find((model) => model.provider === "aigw" && model.id === "reasoner-v1");
			assert.ok(row, "well-known discovery must expose the arbitrary AIGW row");
			assert.equal(row.reasoning, true);
			assert.deepEqual(row.thinkingLevelMap, {
				none: "none",
				low: "low",
				high: "high",
				xhigh: "xhigh",
				max: "max",
				off: "none",
			});

			const store = new RecordingStore();
			const bridgeOptions: Record<string, any>[] = [];
			registerRpcBridgeFactory((options: Record<string, any>) => {
				bridgeOptions.push({ ...options });
				return makeBridge(options, "dynamic-aigw-create");
			});
			const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
			manager._testStore = store;
			managers.push(manager);

			const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
				sessionId: "dynamic-aigw-create",
				initialModel: "aigw/reasoner-v1",
				initialThinkingLevel: "xhigh",
			});
			if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

			assert.equal(bridgeOptions[0]?.initialThinkingLevel, "xhigh");
			assert.equal(store.get(session.id)?.effectiveThinkingLevel, "xhigh");
		} finally {
			await gateway.close();
		}
	});

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

	it("binds an unset reviewer selection to the current catalog before createSession returns", async () => {
		const prefs = makePreferences("skip-auto-reviewer-without-model");
		invalidateModelCache();
		const expectedModel = expectedDefaultModel(await getAvailableModels(prefs));
		const expected = splitModel(expectedModel)!;
		const expectedThinking = clampThinkingLevelForModel("off", expected.provider, expected.id);
		assert.ok(expectedThinking, "fixture requires explicit off to clamp against the selected model");
		const store = new RecordingStore();
		const sessionId = "skip-auto-reviewer-without-model";
		const goalId = "goal-reviewer-without-model";
		const projectId = "project-reviewer-without-model";
		const bridgeOptions: Record<string, any>[] = [];
		let bridge: any;
		registerRpcBridgeFactory((options: Record<string, any>) => {
			bridgeOptions.push({ ...options });
			bridge = makeBridge(options, sessionId);
			return bridge;
		});

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		assert.equal(prefs.get("default.reviewModel"), undefined, "fixture must leave default.reviewModel unset");
		assert.equal(
			manager.resolveInitialReviewModel("reviewer", projectId),
			undefined,
			"fixture must leave the reviewer role model unset",
		);

		const session = await manager.createSession(tmpRoot, undefined, goalId, undefined, {
			sessionId,
			projectId,
			roleName: "reviewer",
			rolePrompt: "Review the Bobbit-owned goal without a role/default review model",
			skipAutoModel: true,
			skipAutoThinking: true,
			initialThinkingLevel: "off",
		});

		// Capture durability and manager-owned read-back before issuing our own
		// observation below. Verification spawns may skip role/preference mutation,
		// but createSession must still bind and verify a Bobbit catalog tuple before
		// its promise resolves.
		const durableAtReturn = store.get(sessionId);
		const tupleWritesAtReturn = store.updates
			.filter(({ id }) => id === sessionId)
			.map(({ fields }) => fields)
			.filter((fields) => ["modelProvider", "modelId", "effectiveThinkingLevel"]
				.some((key) => Object.prototype.hasOwnProperty.call(fields, key)));
		const stateReadsBeforeObservation = bridge.getState.mock.calls.length;
		const liveStateResponse = await session.rpcClient.getState();
		const liveState = liveStateResponse.data;

		assert.deepEqual(
			{
				bridgeInitialModel: bridgeOptions[0]?.initialModel,
				bridgeInitialThinking: bridgeOptions[0]?.initialThinkingLevel,
				goalExtensionContext: bridgeOptions[0]?.env?.BOBBIT_GOAL_ID,
				managerVerifiedReadBack: stateReadsBeforeObservation >= 2,
				liveProvider: liveState?.model?.provider,
				liveModelId: liveState?.model?.id,
				liveThinking: liveState?.thinkingLevel,
				durableProjectId: durableAtReturn?.projectId,
				durableGoalId: durableAtReturn?.goalId,
				durableProvider: durableAtReturn?.modelProvider,
				durableModelId: durableAtReturn?.modelId,
				durableThinking: durableAtReturn?.effectiveThinkingLevel,
				tupleWritesAtReturn,
				hiddenKimiSelected: bridgeOptions[0]?.initialModel?.startsWith("kimi-coding/") === true
					|| liveState?.model?.provider === "kimi-coding"
					|| durableAtReturn?.modelProvider === "kimi-coding",
			},
			{
				bridgeInitialModel: expectedModel,
				bridgeInitialThinking: expectedThinking,
				goalExtensionContext: goalId,
				managerVerifiedReadBack: true,
				liveProvider: expected.provider,
				liveModelId: expected.id,
				liveThinking: expectedThinking,
				durableProjectId: projectId,
				durableGoalId: goalId,
				durableProvider: expected.provider,
				durableModelId: expected.id,
				durableThinking: expectedThinking,
				tupleWritesAtReturn: [{
					modelProvider: expected.provider,
					modelId: expected.id,
					effectiveThinkingLevel: expectedThinking,
				}],
				hiddenKimiSelected: false,
			},
			"REVIEWER_UNSET_TUPLE_BOUNDARY: skipAuto flags must skip reviewer role/preference mutation, not explicit binding, read-back, and atomic durability of the current Bobbit catalog tuple",
		);
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

	it("pins extension-only team spawns and removes the generic raw-argument exemption", async () => {
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
				rawInitialModel: expectedModel,
			},
			"FINAL_ARGV_CATALOG_PIN: all spawns must bind the current catalog before Pi starts; unrelated raw arguments cannot exempt a process from final tuple validation",
		);
	});

	it("canonicalizes raw model/provider/thinking overrides against the exact final catalog row", async () => {
		const prefs = makePreferences("raw-final-tuple");
		invalidateModelCache();
		const models = await getAvailableModels(prefs);
		const target = models.find((model) => model.provider === "anthropic"
			&& model.sessionSelectable !== false
			&& `${model.provider}/${model.id}` !== SELECTABLE_DEFAULT);
		assert.ok(target, "fixture requires a second selectable Anthropic row");
		const store = new RecordingStore();
		const optionsSeen: Record<string, any>[] = [];
		registerRpcBridgeFactory((options: Record<string, any>) => {
			optionsSeen.push({ ...options, args: [...(options.args ?? [])] });
			return makeBridge(options, "raw-final-tuple");
		});
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const targetModel = `${target.provider}/${target.id}`;
		const expectedThinking = clampThinkingLevelForModel("xhigh", target.provider, target.id);
		await manager.createSession(tmpRoot, [
			"--provider", target.provider,
			"--model", target.id,
			"--thinking", "xhigh",
			"--extension", "/fixture/final.ts",
		], undefined, undefined, {
			sessionId: "raw-final-tuple",
			initialModel: SELECTABLE_DEFAULT,
			initialThinkingLevel: "low",
		});

		assert.deepEqual({
			requestedModel: optionsSeen[0]?.requestedModel,
			effectiveModel: optionsSeen[0]?.initialModel,
			requestedThinking: optionsSeen[0]?.requestedThinkingLevel,
			effectiveThinking: optionsSeen[0]?.initialThinkingLevel,
			hasFixtureExtension: optionsSeen[0]?.args?.includes("/fixture/final.ts"),
			hasRawSelectionFlag: optionsSeen[0]?.args?.some((arg: string) =>
				arg === "--provider" || arg === "--model" || arg === "--thinking"),
		}, {
			requestedModel: SELECTABLE_DEFAULT,
			effectiveModel: targetModel,
			requestedThinking: "low",
			effectiveThinking: expectedThinking,
			hasFixtureExtension: true,
			hasRawSelectionFlag: false,
		});
	});

	it("rejects a fabricated raw final tuple before bridge construction or persistence", async () => {
		const prefs = makePreferences("raw-final-tuple-reject");
		invalidateModelCache();
		const store = new RecordingStore();
		const tracker = trackConstructedBridges();
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		await assert.rejects(
			manager.createSession(tmpRoot, [
				"--provider", "retired-custom",
				"--model", "fabricated-model",
			], undefined, undefined, {
				sessionId: "raw-final-tuple-reject",
				initialModel: SELECTABLE_DEFAULT,
			}),
			/not currently available for session selection/i,
		);
		assert.equal(tracker.options.length, 0);
		assert.equal(tracker.getStartCount(), 0);
		assert.equal(store.get("raw-final-tuple-reject"), undefined);
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

	it("fails cold restore before spawn when its complete durable tuple left the current catalog", async () => {
		const prefs = await makeCatalogDriftPreferences("durable-cold-restore-catalog-drift");
		const sessionId = "durable-cold-restore-catalog-drift";
		const ps = durableSessionRecord(sessionId);
		fs.writeFileSync(ps.agentSessionFile, "");
		const store = new RecordingStore();
		store.put(ps);
		const durableBefore = durableTupleBytes(store.get(sessionId));
		const tracker = trackConstructedBridges();

		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		let failure: unknown;
		try {
			await manager.restoreSession(ps);
		} catch (error) {
			failure = error;
		}
		const failureMessage = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);

		assert.deepEqual(
			{
				actionableUnavailableFailure: isActionableUnavailableFailure(failureMessage),
				replacementConstructions: tracker.options.length,
				replacementStarts: tracker.getStartCount(),
				liveReplacementInstalled: manager.sessions.has(sessionId),
				durableTupleBytes: durableTupleBytes(store.get(sessionId)),
			},
			{
				actionableUnavailableFailure: true,
				replacementConstructions: 0,
				replacementStarts: 0,
				liveReplacementInstalled: false,
				durableTupleBytes: durableBefore,
			},
			"DURABLE_TUPLE_UNAVAILABLE_COLD_RESTORE: a complete previously verified tuple must fail closed when catalog drift removes it; a different selectable default is not a restore substitute",
		);
	});

	it("fails a model-less role replacement before spawn when its complete durable tuple left the current catalog", async () => {
		const prefs = await makeCatalogDriftPreferences("durable-role-replacement-catalog-drift");
		const sessionId = "durable-role-replacement-catalog-drift";
		const transcript = path.join(agentDir, "sessions", `${sessionId}.jsonl`);
		fs.writeFileSync(transcript, "");
		const store = new RecordingStore();
		const tracker = trackConstructedBridges();
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId,
			initialModel: SELECTABLE_DEFAULT,
			initialThinkingLevel: "high",
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;
		await flushMicrotasks();
		store.records.set(sessionId, {
			...store.get(sessionId),
			id: sessionId,
			agentSessionFile: transcript,
			...RETIRED_TUPLE,
		});
		const durableBefore = durableTupleBytes(store.get(sessionId));
		const originalBridge = session.rpcClient;
		const originalStop = vi.spyOn(originalBridge, "stop");
		tracker.reset();

		let failure: unknown;
		try {
			await manager.assignRole(sessionId, {
				name: "model-less-replacement-role",
				promptTemplate: "Role replacement without a model override",
				accessory: "none",
			});
		} catch (error) {
			failure = error;
		}
		const failureMessage = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);

		assert.deepEqual(
			{
				actionableUnavailableFailure: isActionableUnavailableFailure(failureMessage),
				replacementConstructions: tracker.options.length,
				replacementStarts: tracker.getStartCount(),
				originalBridgeStopped: originalStop.mock.calls.length > 0,
				originalBridgeRetained: manager.sessions.get(sessionId)?.rpcClient === originalBridge,
				durableTupleBytes: durableTupleBytes(store.get(sessionId)),
			},
			{
				actionableUnavailableFailure: true,
				replacementConstructions: 0,
				replacementStarts: 0,
				originalBridgeStopped: false,
				originalBridgeRetained: true,
				durableTupleBytes: durableBefore,
			},
			"DURABLE_TUPLE_UNAVAILABLE_ROLE_REPLACEMENT: a model-less role replacement must retain and validate its complete durable tuple instead of substituting a different selectable default",
		);
	});

	it("fails force-abort replacement before spawn when its complete durable tuple left the current catalog", async () => {
		const prefs = await makeCatalogDriftPreferences("durable-force-abort-catalog-drift");
		const sessionId = "durable-force-abort-catalog-drift";
		const transcript = path.join(agentDir, "sessions", `${sessionId}.jsonl`);
		fs.writeFileSync(transcript, "");
		const store = new RecordingStore();
		const tracker = trackConstructedBridges();
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir });
		manager._testStore = store;
		managers.push(manager);

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId,
			initialModel: SELECTABLE_DEFAULT,
			initialThinkingLevel: "high",
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;
		await flushMicrotasks();
		store.records.set(sessionId, {
			...store.get(sessionId),
			id: sessionId,
			agentSessionFile: transcript,
			...RETIRED_TUPLE,
		});
		const durableBefore = durableTupleBytes(store.get(sessionId));
		tracker.reset();
		session.status = "streaming";
		vi.spyOn(console, "error").mockImplementation(() => {});

		let failure: unknown;
		try {
			await manager.forceAbort(sessionId, 1);
		} catch (error) {
			failure = error;
		}
		const failureMessage = failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure);

		assert.deepEqual(
			{
				actionableUnavailableFailure: isActionableUnavailableFailure(failureMessage),
				status: manager.getSession(sessionId)?.status,
				replacementConstructions: tracker.options.length,
				replacementStarts: tracker.getStartCount(),
				durableTupleBytes: durableTupleBytes(store.get(sessionId)),
			},
			{
				actionableUnavailableFailure: true,
				status: "terminated",
				replacementConstructions: 0,
				replacementStarts: 0,
				durableTupleBytes: durableBefore,
			},
			"DURABLE_TUPLE_UNAVAILABLE_FORCE_ABORT: force-abort recovery must surface the unavailable durable model and terminate before constructing a replacement with a different selectable default",
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
