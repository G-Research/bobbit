// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// Failing-first cold-restore reproducer for a persisted model retired from the selectable catalog.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { createMemFs } from "../harness/mem-fs.js";

const tmpRoot = makeTmpDir("model-selection-required-recovery-");
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
const { registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");

const SESSION_ID = "retired-model-cold-restore";
const RETIRED_PROVIDER = "retired-provider";
const RETIRED_MODEL_ID = "retired-model";
const RETIRED_MODEL = `${RETIRED_PROVIDER}/${RETIRED_MODEL_ID}`;
const EXPECTED_CONDITION = {
	code: "MODEL_SELECTION_REQUIRED",
	provider: RETIRED_PROVIDER,
	modelId: RETIRED_MODEL_ID,
} as const;

class RecordingStore {
	readonly records = new Map<string, Record<string, any>>();
	readonly updates: Array<{ id: string; fields: Record<string, any> }> = [];

	put(record: Record<string, any>): void {
		this.records.set(record.id, { ...record });
	}

	get(id: string): Record<string, any> | undefined {
		return this.records.get(id);
	}

	update(id: string, fields: Record<string, any>): void {
		this.updates.push({ id, fields: { ...fields } });
		this.records.set(id, { ...(this.records.get(id) ?? { id }), ...fields });
	}

	archive(id: string): void {
		this.update(id, { archived: true, archivedAt: Date.now() });
	}

	getAll(): Record<string, any>[] {
		return [...this.records.values()];
	}

	getLive(): Record<string, any>[] {
		return this.getAll().filter((record) => record.archived !== true);
	}

	getArchived(): Record<string, any>[] {
		return this.getAll().filter((record) => record.archived === true);
	}

	flush(): void {}
}

function makeClient(name: string): any {
	return {
		name,
		readyState: 1,
		bufferedAmount: 0,
		send: vi.fn(),
		close: vi.fn(),
	};
}

function messageRows(snapshot: { data?: unknown }): any[] {
	const data: any = snapshot.data;
	if (Array.isArray(data)) return data;
	return Array.isArray(data?.messages) ? data.messages : [];
}

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

const managers: any[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	invalidateModelCache();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessionsWithConnectedClients?.clear?.();
		manager?.sessions?.clear?.();
	}
	vi.restoreAllMocks();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("retired persisted model cold recovery", () => {
	it("keeps history attachable under MODEL_SELECTION_REQUIRED without spawning or retrying Pi", async () => {
		const preferences = new PreferencesStore(path.resolve("/memfs/model-selection-required"), createMemFs());
		preferences.set("providerKey.anthropic", "test-anthropic-key");
		invalidateModelCache();
		const catalog = await getAvailableModels(preferences);
		assert.equal(
			catalog.some((model: any) => model.provider === RETIRED_PROVIDER && model.id === RETIRED_MODEL_ID),
			false,
			"fixture requires an authoritative catalog that omits the retired tuple",
		);

		const transcriptFile = path.join(agentDir, "sessions", `${SESSION_ID}.jsonl`);
		const transcriptBytes = [
			JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpRoot }),
			JSON.stringify({ type: "message", id: "user-1", parentId: null, message: { role: "user", content: "historical question" } }),
			JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "text", text: "historical answer" }] } }),
		].join("\n") + "\n";
		fs.writeFileSync(transcriptFile, transcriptBytes, "utf-8");

		const persisted = {
			id: SESSION_ID,
			title: "Historical session on a retired model",
			cwd: tmpRoot,
			projectId: "project-1",
			agentSessionFile: transcriptFile,
			createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
			lastActivity: Date.parse("2026-01-01T00:01:00.000Z"),
			messageQueue: [],
			wasStreaming: false,
			modelProvider: RETIRED_PROVIDER,
			modelId: RETIRED_MODEL_ID,
			effectiveThinkingLevel: "high",
		};
		const durableTupleBefore = JSON.stringify({
			modelProvider: persisted.modelProvider,
			modelId: persisted.modelId,
			effectiveThinkingLevel: persisted.effectiveThinkingLevel,
		});
		const store = new RecordingStore();
		store.put(persisted);

		let piStartCount = 0;
		const placeholderGetMessages = vi.fn(async () => {
			throw new Error("conditioned history must not query an unstarted placeholder RPC");
		});
		registerRpcBridgeFactory(() => ({
			running: false,
			start: vi.fn(async () => { piStartCount += 1; }),
			stop: vi.fn(async () => {}),
			getMessages: placeholderGetMessages,
		} as any));

		const manager: any = new SessionManager({ preferencesStore: preferences, stateDir });
		manager._testStore = store;
		managers.push(manager);
		const restoreSession = vi.spyOn(manager, "restoreSession");
		vi.spyOn(console, "error").mockImplementation(() => {});

		await manager.restoreSessions();

		const recovered = manager.getSession(SESSION_ID);
		assert.deepEqual(
			recovered?.condition,
			EXPECTED_CONDITION,
			`MODEL_SELECTION_REQUIRED_RECOVERY_MISSING: cold restore must classify unavailable ${RETIRED_MODEL} as recoverable`,
		);
		assert.deepEqual(
			manager.listSessions().find((session: any) => session.id === SESSION_ID)?.condition,
			EXPECTED_CONDITION,
			"the stable recovery condition and unavailable tuple must be exposed in session listings",
		);
		assert.equal(recovered?.dormant, true, "the recoverable capsule must remain processless");
		assert.equal(restoreSession.mock.calls.length, 0, "authoritative omission must be classified before ordinary restore machinery");
		assert.equal(piStartCount, 0, "cold recovery must not spawn Pi or a fallback model");
		assert.equal(fs.readFileSync(transcriptFile, "utf-8"), transcriptBytes, "cold recovery must preserve transcript bytes exactly");
		assert.equal(store.updates.length, 0, "cold recovery must not rewrite persisted session metadata");
		assert.equal(
			JSON.stringify({
				modelProvider: store.get(SESSION_ID)?.modelProvider,
				modelId: store.get(SESSION_ID)?.modelId,
				effectiveThinkingLevel: store.get(SESSION_ID)?.effectiveThinkingLevel,
			}),
			durableTupleBefore,
			"cold recovery must preserve the exact unavailable durable tuple",
		);

		const history = await manager.getMessagesSnapshotBase(recovered);
		assert.equal(history.success, true, "conditioned history must remain readable without Pi");
		const messages = messageRows(history);
		assert.deepEqual(
			messages.map((message) => [message.role, textOf(message)]),
			[["user", "historical question"], ["assistant", "historical answer"]],
			"conditioned history must use the normal visible user/assistant transcript projection",
		);
		assert.equal(placeholderGetMessages.mock.calls.length, 0, "history reads must not call the placeholder RPC");

		const firstClient = makeClient("first");
		const secondClient = makeClient("second");
		assert.equal(manager.addClient(SESSION_ID, firstClient), true);
		assert.equal(manager.addClient(SESSION_ID, secondClient), true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.resolve();
		assert.equal(restoreSession.mock.calls.length, 0, "attaching repeatedly must not retry the known-doomed retired tuple");
		assert.equal(manager.getSession(SESSION_ID), recovered, "attachment must retain the same recoverable capsule");
		assert.equal(recovered.clients.has(firstClient), true, "the first client must attach to the recoverable capsule");
		assert.equal(recovered.clients.has(secondClient), true, "the second client must attach to the recoverable capsule");
	});
});
