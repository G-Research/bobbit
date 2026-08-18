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
const { SessionManager, buildModelStateData } = await import("../../src/server/agent/session-manager.ts");
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

function explicitConditionClearFrames(client: any): any[] {
	return client.send.mock.calls
		.map(([payload]: [unknown]) => JSON.parse(String(payload)))
		.filter((frame: any) => frame?.type === "state"
			&& Object.prototype.hasOwnProperty.call(frame.data, "condition")
			&& frame.data.condition === null);
}

function readFixtureUtf8(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const bytes = Buffer.alloc(fs.fstatSync(fd).size);
		fs.readSync(fd, bytes, 0, bytes.length, 0);
		return bytes.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function replacementBridge(options: Record<string, any>, overrides: Record<string, any> = {}): any {
	const model = String(options.initialModel);
	const slash = model.indexOf("/");
	let provider = model.slice(0, slash);
	let modelId = model.slice(slash + 1);
	let thinkingLevel = options.initialThinkingLevel ?? "medium";
	return {
		running: true,
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onEvent: vi.fn(() => () => {}),
		sendCommand: vi.fn(async () => ({ success: true })),
		getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
		getState: vi.fn(async () => ({
			success: true,
			data: { model: { provider, id: modelId }, thinkingLevel },
		})),
		setModel: vi.fn(async (nextProvider: string, nextModelId: string) => {
			provider = nextProvider;
			modelId = nextModelId;
			return { success: true };
		}),
		setThinkingLevel: vi.fn(async (next: string) => {
			thinkingLevel = next;
			return { success: true };
		}),
		prompt: vi.fn(async () => ({ success: true })),
		promptWhenReady: vi.fn(async () => ({ success: true })),
		...overrides,
	};
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
	it("omits input modalities when exact recovery metadata is unavailable", () => {
		invalidateModelCache();
		const state = buildModelStateData("custom", "unavailable-recovery-model");
		assert.deepEqual(state.model, {
			provider: "custom",
			id: "unavailable-recovery-model",
		});
		assert.equal(Object.prototype.hasOwnProperty.call(state.model, "input"), false);
	});

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
			messageQueue: [{ id: "persisted-queued", text: "leave me parked", isSteered: false, createdAt: 1 }],
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
		const placeholderPrompt = vi.fn(async () => ({ success: true }));
		registerRpcBridgeFactory(() => ({
			running: false,
			start: vi.fn(async () => { piStartCount += 1; }),
			stop: vi.fn(async () => {}),
			getMessages: placeholderGetMessages,
			prompt: placeholderPrompt,
		} as any));

		const manager: any = new SessionManager({ preferencesStore: preferences, stateDir });
		manager._testStore = store;
		// Keep the fixture at the model lifecycle boundary; gateway credential wiring
		// is independently covered and would add a repository-read audit dependency.
		manager.applyScopedGatewayCredentials = vi.fn();
		manager.applyDirectProviderEnv = vi.fn(async () => {});
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
		assert.equal(readFixtureUtf8(transcriptFile), transcriptBytes, "cold recovery must preserve transcript bytes exactly");
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

		const queueBeforeRejectedPrompt = recovered.promptQueue.toArray();
		const writesBeforeRejectedPrompt = store.updates.length;
		await assert.rejects(
			manager.enqueuePrompt(SESSION_ID, "must not be accepted"),
			(error: any) => error?.code === "MODEL_SELECTION_REQUIRED" && /Choose a replacement model/.test(error.message),
			"prompt admission must fail with an actionable stable condition",
		);
		assert.deepEqual(recovered.promptQueue.toArray(), queueBeforeRejectedPrompt, "rejection must precede queue acceptance");
		assert.equal(store.updates.length, writesBeforeRejectedPrompt, "rejection must precede persistence");

		recovered.manualRetryRequired = true;
		const conditionedStateBefore = JSON.stringify({
			queue: recovered.promptQueue.toArray(),
			manualRetryRequired: recovered.manualRetryRequired,
			restoreError: recovered.restoreError,
		});
		for (const operation of [
			() => manager.retryLastPrompt(SESSION_ID),
			() => manager.restartAgent(SESSION_ID),
			() => manager.ensureSessionAlive(SESSION_ID),
			() => manager.deliverLiveSteer(SESSION_ID, "must not steer"),
		]) {
			await assert.rejects(operation, (error: any) => error?.code === "MODEL_SELECTION_REQUIRED");
		}
		manager.drainQueue(recovered);
		assert.equal(JSON.stringify({
			queue: recovered.promptQueue.toArray(),
			manualRetryRequired: recovered.manualRetryRequired,
			restoreError: recovered.restoreError,
		}), conditionedStateBefore, "retry/restart/ensure/steer/drain must leave conditioned state unchanged");
		assert.equal(store.updates.length, writesBeforeRejectedPrompt, "condition bypasses must not persist");
		assert.equal(placeholderPrompt.mock.calls.length, 0, "condition bypasses must not dispatch RPC");
		assert.equal(restoreSession.mock.calls.length, 0, "condition bypasses must not attempt restore");

		const replacement = catalog.find((model: any) =>
			model.provider === "anthropic"
			&& model.sessionSelectable !== false
			&& Array.isArray(model.input)
			&& model.input.length === 2
			&& model.input[0] === "text"
			&& model.input[1] === "image",
		);
		assert.ok(replacement, "fixture requires a current session-selectable text/image replacement");

		let failedOptions: Record<string, any> | undefined;
		let failedBridge: any;
		registerRpcBridgeFactory((options: Record<string, any>) => {
			failedOptions = { ...options };
			failedBridge = replacementBridge(options, {
				start: vi.fn(async () => { throw new Error("Bearer sk-fixture-secret activation failed"); }),
			});
			return failedBridge;
		});
		await assert.rejects(
			manager.recoverModelSelectionRequired(SESSION_ID, replacement.provider, replacement.id, "high"),
			(error: any) => error?.code === "MODEL_RECOVERY_FAILED"
				&& /Choose another available model or retry/.test(error.message)
				&& !error.message.includes("sk-fixture-secret"),
			"failed activation must be sanitized and actionable",
		);
		assert.equal(failedOptions?.initialModel, `${replacement.provider}/${replacement.id}`, "failure must attempt only the selected exact tuple");
		assert.equal(failedBridge.stop.mock.calls.length, 1, "failed activation must stop its candidate");
		assert.equal(manager.getSession(SESSION_ID), recovered, "failed activation must retain the original capsule");
		assert.deepEqual(recovered.condition, EXPECTED_CONDITION, "failed activation must retain recovery state");
		assert.equal(store.get(SESSION_ID)?.modelProvider, RETIRED_PROVIDER, "failed activation must retain durable provider");
		assert.equal(store.get(SESSION_ID)?.modelId, RETIRED_MODEL_ID, "failed activation must retain durable model");
		assert.equal(recovered.clients.has(firstClient), true, "failed activation must retain attached clients");
		assert.equal(explicitConditionClearFrames(firstClient).length, 0, "failed activation must not publish a recovery-condition clear");

		const poisonedTranscriptBytes = transcriptBytes + JSON.stringify({
			type: "message",
			id: "poisoned-user",
			parentId: "assistant-1",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "image", data: "fixture-image", mimeType: "image/png" },
				],
			},
		}) + "\n";
		fs.writeFileSync(transcriptFile, poisonedTranscriptBytes, "utf-8");
		let readbackFailureBridge: any;
		registerRpcBridgeFactory((options: Record<string, any>) => {
			readbackFailureBridge = replacementBridge(options, {
				getState: vi.fn(async () => ({
					success: true,
					data: { model: { provider: "wrong-provider", id: "wrong-model" }, thinkingLevel: "high" },
				})),
			});
			return readbackFailureBridge;
		});
		await assert.rejects(
			manager.recoverModelSelectionRequired(SESSION_ID, replacement.provider, replacement.id, "high"),
			(error: any) => error?.code === "MODEL_RECOVERY_FAILED",
			"post-switch tuple verification failure must roll back",
		);
		assert.equal(readFixtureUtf8(transcriptFile), poisonedTranscriptBytes, "failed recovery must restore sanitizer-mutated transcript bytes");
		assert.equal(readbackFailureBridge.sendCommand.mock.calls.length, 1, "fixture must fail after switch_session");
		assert.equal(readbackFailureBridge.stop.mock.calls.length, 1, "failed staged bridge must be stopped");
		assert.equal(manager.getSession(SESSION_ID), recovered);
		assert.deepEqual(recovered.condition, EXPECTED_CONDITION);
		assert.equal(store.get(SESSION_ID)?.modelProvider, RETIRED_PROVIDER);
		assert.equal(store.get(SESSION_ID)?.modelId, RETIRED_MODEL_ID);
		assert.equal(explicitConditionClearFrames(firstClient).length, 0);

		// Force the trusted no-follow rollback boundary to reject the transcript after
		// provisional sanitization. This simulates a path replacement/I/O failure
		// without weakening the production path checks or adding a lifecycle seam.
		const rollbackFailureFile = `${transcriptFile}.rollback-failure`;
		let rollbackFailureBridge: any;
		let rollbackFailureCandidate: any;
		registerRpcBridgeFactory((options: Record<string, any>) => {
			rollbackFailureBridge = replacementBridge(options);
			return rollbackFailureBridge;
		});
		manager.bgProcessManager = {
			restoreSession: vi.fn(async () => {
				fs.renameSync(transcriptFile, rollbackFailureFile);
				fs.mkdirSync(transcriptFile);
				rollbackFailureCandidate = manager.getSession(SESSION_ID);
				rollbackFailureCandidate.spawnPinnedModel = "wrong-provider/wrong-model";
			}),
		};
		let rollbackFailure: any;
		try {
			await manager.recoverModelSelectionRequired(
				SESSION_ID,
				replacement.provider,
				replacement.id,
				"high",
			);
		} catch (error) {
			rollbackFailure = error;
		}
		assert.equal(rollbackFailure?.code, "MODEL_RECOVERY_FAILED");
		assert.equal(rollbackFailure?.retryable, false, "unverified transcript rollback must not invite another activation attempt");
		assert.match(rollbackFailure?.message, /original conversation transcript could not be restored/i);
		assert.match(rollbackFailure?.message, /do not retry model selection/i);
		assert.doesNotMatch(rollbackFailure?.message, /choose another available model or retry/i);
		assert.notEqual(readFixtureUtf8(rollbackFailureFile), poisonedTranscriptBytes, "fixture must fail after provisional transcript sanitization");
		assert.equal(rollbackFailureBridge.stop.mock.calls.length, 1, "rollback failure must stop the provisional bridge");
		assert.equal(rollbackFailureCandidate?.lifecycleFenced, true, "rollback failure must fence the provisional candidate");
		assert.equal(rollbackFailureCandidate?.dormant, true);
		assert.equal(rollbackFailureCandidate?.status, "terminated");
		assert.equal(manager.getSession(SESSION_ID), recovered, "rollback failure must return ownership to the processless capsule");
		assert.equal(recovered.lifecycleFenced, false, "the processless capsule remains the canonical admission owner");
		assert.deepEqual(recovered.condition, EXPECTED_CONDITION);
		assert.equal(store.get(SESSION_ID)?.modelProvider, RETIRED_PROVIDER, "rollback failure must retain the unavailable durable provider");
		assert.equal(store.get(SESSION_ID)?.modelId, RETIRED_MODEL_ID, "rollback failure must retain the unavailable durable model");
		assert.equal(explicitConditionClearFrames(firstClient).length, 0, "rollback failure must not publish recovery success");
		fs.rmSync(transcriptFile, { recursive: true, force: true });
		fs.rmSync(rollbackFailureFile, { force: true });
		fs.writeFileSync(transcriptFile, poisonedTranscriptBytes, "utf-8");

		// A recovery request with no valid caller selection must not fabricate a
		// thinking level when the durable tuple also lacks one. It must fail before
		// spawning a replacement and preserve the recoverable capsule.
		store.update(SESSION_ID, { effectiveThinkingLevel: undefined });
		const noAuthorityBridgeFactory = vi.fn(() => replacementBridge({
			initialModel: `${replacement.provider}/${replacement.id}`,
		}));
		registerRpcBridgeFactory(noAuthorityBridgeFactory);
		await assert.rejects(
			manager.recoverModelSelectionRequired(SESSION_ID, replacement.provider, replacement.id),
			(error: any) => error?.code === "MODEL_RECOVERY_FAILED",
			"recovery without explicit or durable thinking authority must fail closed",
		);
		assert.equal(noAuthorityBridgeFactory.mock.calls.length, 0, "fail-closed recovery must not spawn a replacement");
		assert.equal(manager.getSession(SESSION_ID), recovered, "failed authority resolution must retain the recoverable capsule");
		assert.deepEqual(recovered.condition, EXPECTED_CONDITION, "failed authority resolution must retain recovery state");
		store.update(SESSION_ID, { effectiveThinkingLevel: "high" });

		let successfulOptions: Record<string, any> | undefined;
		let successfulBridge: any;
		let durableTupleAtConditionClear: Record<string, unknown> | undefined;
		firstClient.send.mockImplementation((payload: unknown) => {
			const frame = JSON.parse(String(payload));
			if (frame?.type === "state"
				&& Object.prototype.hasOwnProperty.call(frame.data, "condition")
				&& frame.data.condition === null) {
				const durable = store.get(SESSION_ID);
				durableTupleAtConditionClear = {
					modelProvider: durable?.modelProvider,
					modelId: durable?.modelId,
					effectiveThinkingLevel: durable?.effectiveThinkingLevel,
				};
			}
		});
		registerRpcBridgeFactory((options: Record<string, any>) => {
			successfulOptions = { ...options };
			successfulBridge = replacementBridge(options);
			return successfulBridge;
		});
		let releaseBgRestore!: () => void;
		const bgRestoreBlocked = new Promise<void>((resolve) => { releaseBgRestore = resolve; });
		const restoreBackgroundProcesses = vi.fn(() => bgRestoreBlocked);
		manager.bgProcessManager = { restoreSession: restoreBackgroundProcesses };
		const activation = manager.recoverModelSelectionRequired(
			SESSION_ID,
			replacement.provider,
			replacement.id,
		);

		await vi.waitFor(() => {
			assert.notEqual(manager.getSession(SESSION_ID), recovered, "fixture must reach the installed staged candidate");
			assert.equal(restoreBackgroundProcesses.mock.calls.length, 1, "fixture must hold activation after candidate install");
		});
		const stagedCandidate = manager.getSession(SESSION_ID);
		assert.deepEqual(stagedCandidate?.condition, EXPECTED_CONDITION, "canonical staging must retain the retired tuple condition");
		assert.deepEqual(
			manager.listSessions().find((session: any) => session.id === SESSION_ID)?.condition,
			EXPECTED_CONDITION,
			"session listings must not publish successful recovery before durable commit",
		);
		assert.deepEqual(
			manager.getModelSelectionRecoveryAdmission(SESSION_ID).condition,
			EXPECTED_CONDITION,
			"admission and public projections must agree throughout staged activation",
		);
		const duringActivationClient = makeClient("during-activation");
		assert.equal(manager.addClient(SESSION_ID, duringActivationClient), true);
		assert.equal(stagedCandidate?.clients.has(duringActivationClient), true, "a second attachment must join the conditioned candidate");
		assert.deepEqual(stagedCandidate?.condition, EXPECTED_CONDITION, "second attachment must not clear staged recovery state");
		assert.equal(explicitConditionClearFrames(firstClient).length, 0, "staging must not clear the original client's condition");
		assert.equal(explicitConditionClearFrames(duringActivationClient).length, 0, "staging must not clear the new client's condition");

		releaseBgRestore();
		const activated = await activation;
		assert.equal(successfulOptions?.initialModel, `${replacement.provider}/${replacement.id}`, "recovery must spawn pinned to the selected exact tuple");
		assert.equal(successfulOptions?.initialThinkingLevel, "high", "recovery without a caller override must retain the durable thinking tuple");
		assert.equal(activated.provider, replacement.provider);
		assert.equal(activated.modelId, replacement.id);
		assert.equal(manager.getSession(SESSION_ID)?.condition, undefined, "verified activation clears the condition");
		assert.equal(manager.listSessions().find((session: any) => session.id === SESSION_ID)?.condition, undefined, "verified activation clears the listing condition");
		assert.equal(manager.getSession(SESSION_ID)?.clients.has(firstClient), true, "verified activation transfers clients");
		assert.equal(manager.getSession(SESSION_ID)?.clients.has(duringActivationClient), true, "verified activation retains clients attached during staging");
		assert.equal(store.get(SESSION_ID)?.modelProvider, replacement.provider, "only verified activation publishes provider");
		assert.equal(store.get(SESSION_ID)?.modelId, replacement.id, "only verified activation publishes model");
		assert.equal(store.get(SESSION_ID)?.effectiveThinkingLevel, activated.thinkingLevel, "published thinking is the verified clamp");
		const firstConditionClearFrames = explicitConditionClearFrames(firstClient);
		const duringActivationConditionClearFrames = explicitConditionClearFrames(duringActivationClient);
		assert.equal(firstConditionClearFrames.length, 1, "verified activation must publish one explicit condition clear");
		assert.equal(duringActivationConditionClearFrames.length, 1, "verified activation must clear the condition for clients attached during staging");
		assert.deepEqual(
			firstConditionClearFrames[0]?.data?.model?.input,
			["text", "image"],
			"the full-replacement recovery frame must retain exact validated input modalities",
		);
		assert.deepEqual(
			duringActivationConditionClearFrames[0]?.data?.model?.input,
			["text", "image"],
			"clients attached during recovery must receive the same exact modalities",
		);
		assert.deepEqual(durableTupleAtConditionClear, {
			modelProvider: replacement.provider,
			modelId: replacement.id,
			effectiveThinkingLevel: activated.thinkingLevel,
		}, "the explicit condition clear must publish only after the verified tuple is durable");
		assert.ok(successfulBridge.getState.mock.calls.length >= 2, "activation must verify runtime read-back before publishing");
	});
});
