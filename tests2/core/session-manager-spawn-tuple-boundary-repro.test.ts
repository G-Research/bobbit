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
});
