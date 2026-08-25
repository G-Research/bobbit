import { guardProcessEnv } from "./_helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { makeTmpDir } from "../../support/helpers/shared/tmp.ts";
import { createMemFs } from "../../support/harnesses/shared/mem-fs.js";
import { PromptQueue } from "../../../src/server/agent/prompt-queue.ts";

const tmpRoot = makeTmpDir("runtime-model-zombie-recovery-");
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
const { SessionStore } = await import("../../../src/server/agent/session-store.ts");
const { PreferencesStore } = await import("../../../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../../../src/server/agent/model-registry.ts");
const { applyRuntimeSessionModelSelection } = await import("../../../src/server/ws/runtime-model-selection.ts");

const SESSION_ID = "runtime-zombie-partial-mutation";
const DURABLE = {
	provider: "anthropic",
	id: "claude-sonnet-5",
	thinkingLevel: "high",
} as const;
const REQUESTED = {
	provider: "anthropic",
	id: "claude-opus-5",
	thinkingLevel: "xhigh",
} as const;
const FALLBACK = {
	provider: "anthropic",
	id: "claude-haiku-4-5",
	thinkingLevel: "high",
} as const;

const managers: any[] = [];

afterEach(async () => {
	invalidateModelCache();
	while (managers.length > 0) await managers.pop().shutdown();
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makePartiallyMutatingBridge() {
	let tuple: { provider: string; id: string; thinkingLevel: string } = { ...DURABLE };
	const setModel = vi.fn(async (provider: string, id: string) => {
		// The explicit request mutates Pi to an unrequested fallback. The bounded
		// rollback then also claims success without restoring the durable model.
		if ((provider === REQUESTED.provider && id === REQUESTED.id)
			|| (provider === DURABLE.provider && id === DURABLE.id)) {
			tuple = { ...FALLBACK };
		}
		return { success: true };
	});
	const setThinkingLevel = vi.fn(async (thinkingLevel: string) => {
		tuple.thinkingLevel = thinkingLevel;
		return { success: true };
	});
	const prompts: string[] = [];
	const bridge: any = {
		running: true,
		setModel,
		setThinkingLevel,
		getState: vi.fn(async () => ({
			success: true,
			data: {
				model: { provider: tuple.provider, id: tuple.id },
				thinkingLevel: tuple.thinkingLevel,
			},
		})),
		prompt: vi.fn(async (text: string) => {
			prompts.push(text);
			return { success: true };
		}),
		stop: vi.fn(async () => { bridge.running = false; }),
	};
	return { bridge, prompts, setModel, setThinkingLevel };
}

describe("runtime selection recovery for a role-less pre-transcript session", () => {
	it("does not leave a partially mutated bridge live after zombie recovery archives durability", async () => {
		const prefsFs = createMemFs();
		const prefs = new PreferencesStore(path.resolve("/memfs/runtime-zombie-recovery"), prefsFs);
		prefs.set("providerKey.anthropic", "test-anthropic-key");
		invalidateModelCache();
		const requestedCatalogRow = (await getAvailableModels(prefs)).find(
			(model: any) => model.provider === REQUESTED.provider && model.id === REQUESTED.id,
		);
		assert.equal(requestedCatalogRow?.thinkingLevelMap?.xhigh, "xhigh", "fixture requires selectable Opus 5 xhigh");

		const store = new SessionStore(stateDir);
		store.put({
			id: SESSION_ID,
			title: "Role-less pre-transcript session",
			cwd: tmpRoot,
			agentSessionFile: "",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			modelProvider: DURABLE.provider,
			modelId: DURABLE.id,
			effectiveThinkingLevel: DURABLE.thinkingLevel,
		});

		const manager: any = new SessionManager({ preferencesStore: prefs });
		manager._testStore = store;
		managers.push(manager);
		const { bridge, prompts, setModel, setThinkingLevel } = makePartiallyMutatingBridge();
		const session: any = {
			id: SESSION_ID,
			title: "Role-less pre-transcript session",
			titleGenerated: true,
			cwd: tmpRoot,
			status: "idle",
			statusVersion: 1,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			clients: new Set(),
			unsubscribe: () => {},
			rpcClient: bridge,
			spawnPinnedModel: `${DURABLE.provider}/${DURABLE.id}`,
			spawnPinnedThinkingLevel: DURABLE.thinkingLevel,
		};
		// Runtime termination now fences verifier-owned rows before stopping the
		// bridge. Production SessionInfo always has this durable queue; retain it in
		// this partial runtime-model fixture so the zombie path exercises ownership,
		// rather than failing on an impossible missing field.
		session.promptQueue = new PromptQueue();
		manager.sessions.set(SESSION_ID, session);

		let selectionError: Error | undefined;
		try {
			await applyRuntimeSessionModelSelection(
				manager,
				session,
				REQUESTED.provider,
				REQUESTED.id,
				REQUESTED.thinkingLevel,
				prefs,
			);
		} catch (error) {
			selectionError = error as Error;
		}

		assert.match(selectionError?.message ?? "", /runtime selection recovery failed/i);
		assert.deepEqual(
			setModel.mock.calls.map(([provider, id]) => [provider, id]),
			[
				[REQUESTED.provider, REQUESTED.id],
				[DURABLE.provider, DURABLE.id],
			],
			"selection must partially mutate once and make exactly one durable rollback attempt",
		);
		assert.equal(setThinkingLevel.mock.calls.length, 0, "fallback mismatch must fail before requested thinking is applied");

		const retained = manager.getSession(SESSION_ID);
		let retainedBridgeUsable = false;
		if (retained) {
			const promptResult = await retained.rpcClient.prompt("must not reach the partially mutated bridge");
			retainedBridgeUsable = promptResult?.success === true && prompts.length === 1;
		}
		const persisted = store.get(SESSION_ID);
		assert.deepEqual(
			{
				archived: persisted?.archived,
				durableTuple: {
					provider: persisted?.modelProvider,
					id: persisted?.modelId,
					thinkingLevel: persisted?.effectiveThinkingLevel,
				},
				retainedSameSession: retained === session,
				managerReportsLive: manager.isSessionLive(SESSION_ID),
				partialBridgeRunning: bridge.running,
				partialBridgeUsable: retainedBridgeUsable,
			},
			{
				archived: true,
				durableTuple: { ...DURABLE },
				retainedSameSession: false,
				managerReportsLive: false,
				partialBridgeRunning: false,
				partialBridgeUsable: false,
			},
			"UNSAFE_PARTIAL_RUNTIME_BRIDGE_REMAINS_LIVE: zombie recovery archived persistence but did not fence, stop, or remove the partially mutated in-memory session",
		);
	});
});
