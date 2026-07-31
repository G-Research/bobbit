/**
 * Real SessionManager and current-catalog boundary coverage for controlled model fallback.
 * Split from controlled-model-fallback.test.ts so lifecycle retries cannot consume the
 * selector/source invariant suite's tier-1 per-file wall budget.
 */

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, it, vi } from "vitest";

import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { createMemFs } from "../harness/mem-fs.js";

type ModelPair = [string, string];

// These boundary scenarios run through the real SessionManager spawn preflight so
// catalog rejection cannot accidentally bypass controlled fallback.
const BOUNDARY_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "controlled-model-fallback-boundary-"));
const BOUNDARY_STATE_DIR = path.join(BOUNDARY_TMP_ROOT, "state");
const BOUNDARY_AGENT_DIR = path.join(BOUNDARY_TMP_ROOT, "agent");
fs.mkdirSync(BOUNDARY_STATE_DIR, { recursive: true });
fs.mkdirSync(path.join(BOUNDARY_AGENT_DIR, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = BOUNDARY_TMP_ROOT;
process.env.BOBBIT_AGENT_DIR = BOUNDARY_AGENT_DIR;
process.env.BOBBIT_TEST_NO_REMOTE = "1";
process.env.BOBBIT_TEST_NO_EXTERNAL = "1";

const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.ts");
resetAgentDirStateForTests?.();
const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
const { getAvailableModels, invalidateModelCache } = await import("../../src/server/agent/model-registry.ts");
const { registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");
const { initAuthorSidecarDir } = await import("../../src/server/agent/author-sidecar.ts");
const { initPromptDirs } = await import("../../src/server/agent/system-prompt.ts");
const { loadOrCreateToken } = await import("../../src/server/auth/token.ts");

initPromptDirs(BOUNDARY_STATE_DIR);
initAuthorSidecarDir(BOUNDARY_STATE_DIR, {
	secretsDir: path.join(BOUNDARY_TMP_ROOT, "private-secrets"),
	hmacKey: Buffer.alloc(32, 0x43),
});
loadOrCreateToken();

const BOUNDARY_ROLE = "retired-fallback-role";
const BOUNDARY_RETIRED_MODEL = "retired-provider/claude-opus-4-5-retired";
const BOUNDARY_FALLBACK_PROVIDER = "controlled-fallback-local";
const BOUNDARY_FALLBACK_MODEL_ID = "claude-opus-5";
const BOUNDARY_FALLBACK_MODEL = `${BOUNDARY_FALLBACK_PROVIDER}/${BOUNDARY_FALLBACK_MODEL_ID}`;

type BoundaryRecord = Record<string, any> & { id: string };

class BoundaryStore {
	readonly records = new Map<string, BoundaryRecord>();
	readonly updates: Array<{ id: string; fields: Record<string, any> }> = [];

	put(record: BoundaryRecord): void {
		this.records.set(record.id, { ...record });
	}

	update(id: string, fields: Record<string, any>): void {
		this.updates.push({ id, fields: { ...fields } });
		this.records.set(id, { ...(this.records.get(id) ?? { id }), ...fields });
	}

	get(id: string): BoundaryRecord | undefined { return this.records.get(id); }
	getAll(): BoundaryRecord[] { return [...this.records.values()]; }
	getLive(): BoundaryRecord[] { return this.getAll().filter((row) => !row.archived); }
	getArchived(): BoundaryRecord[] { return this.getAll().filter((row) => row.archived); }
	archive(id: string): void { this.update(id, { archived: true, archivedAt: Date.now() }); }
	flush(): void {}
}

function splitBoundaryModel(model: string | undefined): { provider: string; id: string } {
	assert.ok(model, "controlled fallback must bind an explicit model before bridge construction");
	const slash = model.indexOf("/");
	assert.ok(slash > 0 && slash < model.length - 1, `invalid boundary model: ${model}`);
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

function makeBoundaryBridge(options: Record<string, any>, sessionId: string): any {
	let model = splitBoundaryModel(options.initialModel);
	let thinkingLevel = options.initialThinkingLevel ?? "medium";
	return {
		running: true,
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		waitForReady: vi.fn(async () => {}),
		promptWhenReady: vi.fn(async () => ({ success: true })),
		prompt: vi.fn(async () => ({ success: true })),
		steer: vi.fn(async () => ({ success: true })),
		abort: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			success: true,
			data: {
				model,
				thinkingLevel,
				sessionFile: path.join(BOUNDARY_AGENT_DIR, "sessions", `${sessionId}.jsonl`),
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

function makeBoundaryFixture(label: string): {
	manager: any;
	store: BoundaryStore;
	bridgeOptions: Record<string, any>[];
} {
	const preferences = new PreferencesStore(
		path.resolve(`/memfs/controlled-fallback-boundary-${label}`),
		createMemFs(),
	);
	preferences.set("customProviders", [{
		id: BOUNDARY_FALLBACK_PROVIDER,
		// Manual providers use their configured name as the runtime provider key.
		name: BOUNDARY_FALLBACK_PROVIDER,
		type: "manual",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "test-key",
		models: [{ id: BOUNDARY_FALLBACK_MODEL_ID, name: "Controlled fallback Opus" }],
	}]);
	preferences.set("default.sessionModel", BOUNDARY_FALLBACK_MODEL);
	preferences.set("default.sessionThinkingLevel", "high");
	preferences.set("allowSessionModelFallback", true as any);
	invalidateModelCache();

	const store = new BoundaryStore();
	const bridgeOptions: Record<string, any>[] = [];
	registerRpcBridgeFactory((options: Record<string, any>) => {
		bridgeOptions.push({ ...options });
		return makeBoundaryBridge(options, options.env?.BOBBIT_SESSION_ID ?? `boundary-${bridgeOptions.length}`);
	});
	const roleManager = {
		getRole(name: string) {
			if (name !== BOUNDARY_ROLE) return undefined;
			return {
				name,
				label: "Retired fallback role",
				promptTemplate: "Exercise controlled model fallback preflight.",
				model: BOUNDARY_RETIRED_MODEL,
				thinkingLevel: "high",
			};
		},
		listRoles: () => [],
	};
	const manager: any = new SessionManager({
		preferencesStore: preferences,
		roleManager: roleManager as any,
		stateDir: BOUNDARY_STATE_DIR,
	});
	manager._testStore = store;
	boundaryManagers.push(manager);
	return { manager, store, bridgeOptions };
}

function boundaryTuple(record: BoundaryRecord | undefined): Record<string, unknown> {
	return {
		provider: record?.modelProvider,
		modelId: record?.modelId,
		thinkingLevel: record?.effectiveThinkingLevel,
	};
}

const INHERITED_SELECTED_PROVIDER = "inherited-selected";
const INHERITED_SELECTED_MODEL_ID = "limited-reasoner";
const INHERITED_SELECTED_MODEL = `${INHERITED_SELECTED_PROVIDER}/${INHERITED_SELECTED_MODEL_ID}`;
const INHERITED_FALLBACK_PROVIDER = "inherited-fallback";
const INHERITED_FALLBACK_MODEL_ID = "extended-reasoner";
const INHERITED_FALLBACK_MODEL = `${INHERITED_FALLBACK_PROVIDER}/${INHERITED_FALLBACK_MODEL_ID}`;

type InheritedSetupMode = "normal" | "worktree";

async function makeInheritedThinkingFixture(
	label: string,
	opts: { failFallback?: boolean } = {},
): Promise<{
	manager: any;
	store: BoundaryStore;
	startedOptions: Record<string, any>[];
	setModelCalls: ModelPair[];
	setThinkingCalls: string[];
}> {
	const preferences = new PreferencesStore(
		path.resolve(`/memfs/controlled-fallback-inherited-${label}`),
		createMemFs(),
	);
	preferences.set("customProviders", [
		{
			id: INHERITED_SELECTED_PROVIDER,
			name: INHERITED_SELECTED_PROVIDER,
			type: "manual",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test-key",
			models: [{ id: INHERITED_SELECTED_MODEL_ID, name: "Limited reasoner" }],
		},
		{
			id: INHERITED_FALLBACK_PROVIDER,
			name: INHERITED_FALLBACK_PROVIDER,
			type: "manual",
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test-key",
			models: [{ id: INHERITED_FALLBACK_MODEL_ID, name: "Extended reasoner" }],
		},
	]);
	preferences.set("default.sessionModel", INHERITED_FALLBACK_MODEL);
	preferences.set("default.sessionThinkingLevel", "low");
	preferences.set("allowSessionModelFallback", true as any);
	invalidateModelCache();
	const models = await getAvailableModels(preferences);
	const selected = models.find((model: any) => (
		model.provider === INHERITED_SELECTED_PROVIDER && model.id === INHERITED_SELECTED_MODEL_ID
	));
	const fallback = models.find((model: any) => (
		model.provider === INHERITED_FALLBACK_PROVIDER && model.id === INHERITED_FALLBACK_MODEL_ID
	));
	assert.ok(selected && fallback, "fixture requires both current custom catalog rows");
	// The selected model clamps xhigh down to high. The fallback supports xhigh,
	// so the selector must re-clamp the raw inherited request rather than reuse
	// either that provisional high or the unrelated global low default.
	selected.reasoning = true;
	fallback.reasoning = true;
	fallback.thinkingLevelMap = { xhigh: "xhigh" };

	const store = new BoundaryStore();
	const startedOptions: Record<string, any>[] = [];
	const setModelCalls: ModelPair[] = [];
	const setThinkingCalls: string[] = [];
	registerRpcBridgeFactory((options: Record<string, any>) => {
		let model = { provider: "fixture-runtime", id: "spawn-readback-mismatch" };
		let thinkingLevel = options.initialThinkingLevel ?? "medium";
		return {
			running: true,
			start: vi.fn(async () => { startedOptions.push({ ...options }); }),
			stop: vi.fn(async () => {}),
			waitForReady: vi.fn(async () => {}),
			promptWhenReady: vi.fn(async () => ({ success: true })),
			prompt: vi.fn(async () => ({ success: true })),
			steer: vi.fn(async () => ({ success: true })),
			abort: vi.fn(async () => ({ success: true })),
			getState: vi.fn(async () => ({
				success: true,
				data: {
					model,
					thinkingLevel,
					sessionFile: path.join(BOUNDARY_AGENT_DIR, "sessions", `${label}.jsonl`),
				},
			})),
			getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
			setModel: vi.fn(async (provider: string, id: string) => {
				setModelCalls.push([provider, id]);
				if (opts.failFallback && `${provider}/${id}` === INHERITED_FALLBACK_MODEL) {
					throw new Error("fixture fallback bind failed");
				}
				model = { provider, id };
				return { success: true };
			}),
			setThinkingLevel: vi.fn(async (level: string) => {
				setThinkingCalls.push(level);
				thinkingLevel = level;
				return { success: true };
			}),
			compact: vi.fn(async () => ({ success: true })),
			sendCommand: vi.fn(async () => ({ success: true })),
			onEvent: vi.fn(() => () => {}),
		};
	});
	const manager: any = new SessionManager({
		preferencesStore: preferences,
		stateDir: BOUNDARY_STATE_DIR,
	});
	manager._testStore = store;
	boundaryManagers.push(manager);
	return { manager, store, startedOptions, setModelCalls, setThinkingCalls };
}

async function createInheritedThinkingSession(
	fixture: Awaited<ReturnType<typeof makeInheritedThinkingFixture>>,
	mode: InheritedSetupMode,
	sessionId: string,
): Promise<any> {
	const createOpts: Record<string, any> = {
		sessionId,
		initialModel: INHERITED_SELECTED_MODEL,
		initialThinkingLevel: "xhigh",
	};
	if (mode === "worktree") {
		const projectId = `project-${sessionId}`;
		const worktreePath = path.join(BOUNDARY_TMP_ROOT, `prebuilt-${sessionId}`);
		fs.mkdirSync(worktreePath, { recursive: true });
		// The setup-failure canary deliberately rejects after claiming this fake
		// prebuilt worktree. Seed a second live owner so failure cleanup exercises
		// the shared-worktree guard instead of launching an unrelated real Git cleanup.
		fixture.store.put({
			id: `shared-owner-${sessionId}`,
			title: "Shared fixture owner",
			cwd: worktreePath,
			worktreePath,
			repoPath: BOUNDARY_TMP_ROOT,
			branch: `fixture/${sessionId}`,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			agentSessionFile: "",
		});
		fixture.manager.worktreePools.set(projectId, {
			claim: vi.fn(async () => ({ worktreePath })),
		});
		Object.assign(createOpts, {
			projectId,
			worktreeOpts: { repoPath: BOUNDARY_TMP_ROOT },
			awaitWorktreeSetup: true,
		});
	}
	return fixture.manager.createSession(
		BOUNDARY_TMP_ROOT,
		[],
		undefined,
		undefined,
		createOpts,
	);
}

const boundaryManagers: any[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	invalidateModelCache();
	while (boundaryManagers.length > 0) {
		const manager = boundaryManagers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
});

afterAll(() => {
	fs.rmSync(BOUNDARY_TMP_ROOT, { recursive: true, force: true });
});

describe("controlled model fallback policy — real SessionManager preflight", () => {
	it("fails closed before bridge construction when a complete durable restore tuple left the catalog", async () => {
		const { manager, store, bridgeOptions } = makeBoundaryFixture("durable-restore");
		const sessionId = "durable-restore-fail-closed";
		const transcript = path.join(BOUNDARY_AGENT_DIR, "sessions", `${sessionId}.jsonl`);
		fs.writeFileSync(transcript, "");
		const durable = {
			id: sessionId,
			title: "Durable restore must fail closed",
			cwd: BOUNDARY_TMP_ROOT,
			agentSessionFile: transcript,
			createdAt: Date.now() - 1_000,
			lastActivity: Date.now() - 500,
			messageQueue: [],
			wasStreaming: false,
			modelProvider: "retired-provider",
			modelId: "claude-opus-4-5-retired",
			effectiveThinkingLevel: "high",
		};
		store.put(durable);
		const before = boundaryTuple(store.get(sessionId));

		let failure: unknown;
		try {
			await manager.restoreSession(durable);
		} catch (error) {
			failure = error;
		}

		assert.match(String((failure as Error | undefined)?.message), /not currently available for session selection/i);
		assert.deepEqual(bridgeOptions, [], "a complete unavailable durable tuple must fail before constructing a fallback bridge");
		assert.deepEqual(boundaryTuple(store.get(sessionId)), before, "controlled fallback must not replace the previous durable tuple");
		assert.equal(manager.sessions.has(sessionId), false);
	});

	it("lets an unavailable role candidate use the selectable configured fallback before a new-session bridge is built", async () => {
		const { manager, store, bridgeOptions } = makeBoundaryFixture("role-new-session");
		const sessionId = "eligible-role-fallback-preflight";

		let session: any;
		let failure: unknown;
		try {
			session = await manager.createSession(
				BOUNDARY_TMP_ROOT,
				[],
				undefined,
				undefined,
				{ sessionId, role: BOUNDARY_ROLE },
			);
			if (session.pendingMetadataPersist) await session.pendingMetadataPersist;
		} catch (error) {
			failure = error;
		}

		assert.deepEqual(
			{
				failure: failure instanceof Error ? failure.message : failure,
				bridgeModels: bridgeOptions.map((options) => options.initialModel),
				live: manager.sessions.has(sessionId),
				durable: boundaryTuple(store.get(sessionId)),
			},
			{
				failure: undefined,
				bridgeModels: [BOUNDARY_FALLBACK_MODEL],
				live: true,
				durable: {
					provider: BOUNDARY_FALLBACK_PROVIDER,
					modelId: BOUNDARY_FALLBACK_MODEL_ID,
					// The manual row is authoritatively non-reasoning, so high clamps to off.
					thinkingLevel: "off",
				},
			},
			"ROLE_FALLBACK_PREFLIGHT: an unavailable role on an eligible new session must use the current default.sessionModel instead of being rejected before controlled fallback can run",
		);
	});

	it.each(["normal", "worktree"] as const)(
		"preserves an explicit inherited thinking request through %s post-spawn controlled fallback",
		async (mode) => {
			const fixture = await makeInheritedThinkingFixture(`success-${mode}`);
			const sessionId = `inherited-thinking-${mode}`;
			const session = await createInheritedThinkingSession(fixture, mode, sessionId);
			if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

			assert.equal(fixture.startedOptions.at(-1)?.initialModel, INHERITED_SELECTED_MODEL);
			assert.equal(
				fixture.startedOptions.at(-1)?.initialThinkingLevel,
				"high",
				"the spawn pin is only the provisional clamp for the selected model",
			);
			assert.deepEqual(fixture.setModelCalls, [[INHERITED_FALLBACK_PROVIDER, INHERITED_FALLBACK_MODEL_ID]]);
			assert.deepEqual(
				fixture.setThinkingCalls,
				["xhigh"],
				"EXPLICIT_INHERITED_FALLBACK_THINKING_LOST_TO_GLOBAL_DEFAULT",
			);
			assert.deepEqual(boundaryTuple(fixture.store.get(sessionId)), {
				provider: INHERITED_FALLBACK_PROVIDER,
				modelId: INHERITED_FALLBACK_MODEL_ID,
				thinkingLevel: "xhigh",
			});
			assert.equal(
				fixture.manager._setupInitialThinkingAuthorities?.size ?? 0,
				0,
				"temporary raw setup authority must clear after successful setup",
			);
		},
	);

	it.each(["normal", "worktree"] as const)(
		"clears explicit inherited thinking authority when %s post-spawn fallback fails",
		async (mode) => {
			const fixture = await makeInheritedThinkingFixture(`failure-${mode}`, { failFallback: true });
			const sessionId = `inherited-thinking-failure-${mode}`;

			await assert.rejects(
				createInheritedThinkingSession(fixture, mode, sessionId),
				/controlled fallback did not bind|fixture fallback bind failed/i,
			);
			assert.equal(
				fixture.manager._setupInitialThinkingAuthorities?.size ?? 0,
				0,
				"temporary raw setup authority must clear after failed setup",
			);
		},
	);
});

