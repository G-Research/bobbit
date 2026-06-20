/**
 * Reproducing tests for the OpenRouter key bridge goal.
 *
 * These are failing-first pins for the current bug:
 *   1. A saved Settings key (`providerKey.openrouter`) authenticates the model
 *      registry, but a restored direct/non-sandbox agent spawn does not receive
 *      `OPENROUTER_API_KEY` in `RpcBridgeOptions.env`.
 *   2. A provider-auth prompt failure (`No API key found for openrouter`) must
 *      leave the session clearly idle/retryable, persist `wasStreaming:false`,
 *      clear stale streaming timestamps, and surface a credential fix/retry action.
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("openrouter-key-bridge-repro-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");
const { initPromptDirs } = await import("../src/server/agent/system-prompt.ts");

initPromptDirs(stateDir);

const FAKE_OPENROUTER_KEY = "sk-or-repro-openrouter-key-never-persist";
const AUTH_ERROR = "No API key found for openrouter";

const managers: any[] = [];
let previousOpenRouterEnv: string | undefined;

afterEach(() => {
	registerRpcBridgeFactory(null);
	if (previousOpenRouterEnv === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = previousOpenRouterEnv;
	previousOpenRouterEnv = undefined;
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear?.();
	}
});

function makeClient(): any {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [] as any[],
		send(data: string) { this.sent.push(JSON.parse(data)); },
		close() { this.readyState = 3; },
	};
}

function makeBridge(overrides: Record<string, any> = {}): any {
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		async promptWhenReady(text: string, images?: any) { return this.prompt(text, images); },
		prompt: mock.fn(async () => ({ success: true })),
		steer: mock.fn(async () => ({ success: true })),
		abort: mock.fn(async () => ({ success: true })),
		getState: mock.fn(async () => ({ success: true })),
		getMessages: mock.fn(async () => ({ success: true, data: { messages: [] } })),
		setModel: mock.fn(async () => ({ success: true })),
		setThinkingLevel: mock.fn(async () => ({ success: true })),
		compact: mock.fn(async () => ({ success: true })),
		sendCommand: mock.fn(async () => ({ success: true })),
		onEvent: mock.fn(() => () => {}),
		...overrides,
	};
}

function preferencesWithOpenRouterKey(): any {
	const prefs = new PreferencesStore(stateDir);
	prefs.set("providerKey.openrouter", FAKE_OPENROUTER_KEY);
	return prefs;
}

function persistedOpenRouterSession(id = "s-openrouter-direct"): any {
	const agentSessionDir = path.join(agentDir, "sessions", "openrouter-repro");
	fs.mkdirSync(agentSessionDir, { recursive: true });
	const agentSessionFile = path.join(agentSessionDir, `${id}.jsonl`);
	fs.writeFileSync(agentSessionFile, '{"type":"init"}\n', "utf-8");
	return {
		id,
		title: "OpenRouter direct session",
		cwd: tmpRoot,
		agentSessionFile,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		modelProvider: "openrouter",
		modelId: "anthropic/claude-3.5-sonnet",
		sandboxed: false,
	};
}

describe("OpenRouter provider key bridge (reproducing)", () => {
	it("restored direct/non-sandbox OpenRouter sessions pass providerKey.openrouter to RpcBridgeOptions.env without persisting the key", async () => {
		previousOpenRouterEnv = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;

		const prefs = preferencesWithOpenRouterKey();
		const ps = persistedOpenRouterSession();
		const storeUpdates: any[] = [];
		let capturedOptions: any | undefined;
		registerRpcBridgeFactory((options: any) => {
			capturedOptions = options;
			return makeBridge();
		});

		const manager: any = new SessionManager({ preferencesStore: prefs });
		manager._testStore = {
			get: mock.fn(() => ps),
			update: mock.fn((_id: string, fields: any) => { storeUpdates.push(fields); }),
			archive: mock.fn(() => {}),
		};
		managers.push(manager);

		await manager.restoreSession(ps);

		const serializedPersisted = JSON.stringify({ ps, storeUpdates, liveSession: manager.sessions.get(ps.id) });
		assert.doesNotMatch(
			serializedPersisted,
			new RegExp(FAKE_OPENROUTER_KEY),
			"fake OpenRouter key must never appear in persisted session metadata, store updates, or live session JSON",
		);

		assert.equal(
			capturedOptions?.env?.OPENROUTER_API_KEY,
			FAKE_OPENROUTER_KEY,
			"OPENROUTER_KEY_BRIDGE_MISSING: providerKey.openrouter from Settings must be injected into direct/non-sandbox RpcBridgeOptions.env as OPENROUTER_API_KEY",
		);
	});

	it("provider-auth prompt failures clear wasStreaming/streamingStartedAt and surface a credential fix or retry action", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const updates: any[] = [];
		const client = makeClient();
		const prompt = mock.fn(async () => ({ success: false, error: AUTH_ERROR }));
		const manager: any = new SessionManager();
		manager._testStore = {
			get: mock.fn(() => undefined),
			update: mock.fn((_id: string, fields: any) => { updates.push(fields); }),
		};
		managers.push(manager);

		const session: any = {
			id: "s-openrouter-auth-failure",
			title: "OpenRouter auth failure",
			titleGenerated: true,
			cwd: tmpRoot,
			status: "idle",
			statusVersion: 0,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			clients: new Set([client]),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			modelProvider: "openrouter",
			modelId: "anthropic/claude-3.5-sonnet",
			inFlightSteerTexts: [],
			unsubscribe: () => {},
			rpcClient: makeBridge({ prompt }),
		};
		manager.sessions.set(session.id, session);

		await assert.rejects(
			() => manager.enqueuePrompt(session.id, "hello OpenRouter"),
			/No API key found for openrouter/,
		);

		assert.equal(session.status, "idle", "provider-auth dispatch failure must not leave the session streaming");
		assert.equal(session.promptQueue.length, 1, "failed auth prompt should remain recoverable in the queue");

		const persistedStreamingFalse = updates.some((u) => u?.wasStreaming === false && "streamingStartedAt" in u);
		const staleStreamingTimestampCleared = session.streamingStartedAt === undefined;
		const visiblePayload = JSON.stringify(client.sent);
		const surfacedCredentialAction = /openrouter/i.test(visiblePayload)
			&& /(?:credential|api key|provider[-_ ]?auth|No API key)/i.test(visiblePayload)
			&& /(?:retry|fix|settings|switch provider|abort|respawn)/i.test(visiblePayload);

		const missing: string[] = [];
		if (!persistedStreamingFalse) missing.push("persist wasStreaming:false + streamingStartedAt:undefined");
		if (!staleStreamingTimestampCleared) missing.push("clear in-memory streamingStartedAt");
		if (!surfacedCredentialAction) missing.push("surface OpenRouter credential fix/retry action to clients");
		assert.deepEqual(
			missing,
			[],
			`OPENROUTER_PROVIDER_AUTH_RECOVERY_MISSING: ${missing.join("; ")}. Updates=${JSON.stringify(updates)} clientFrames=${visiblePayload}`,
		);
	});
});
