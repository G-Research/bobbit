// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// Retained AIGW catalog availability during transient discovery failures.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { SessionManager } from "../../src/server/agent/session-manager.js";
import { registerRpcBridgeFactory } from "../../src/server/agent/rpc-bridge.js";
import {
	findSessionSelectableModel,
	getAvailableModels,
	invalidateModelCache,
	resolveModelStateMeta,
} from "../../src/server/agent/model-registry.js";
import { clampThinkingLevelForModel } from "../../src/server/agent/thinking-level-clamp.js";

const RETAINED_ID = "gpt-5.4";
const RETAINED_COST = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };

type DiscoveryMode = "failure" | "success" | "empty";

function startGateway(): Promise<{
	url: string;
	setMode: (mode: DiscoveryMode) => void;
	close: () => Promise<void>;
}> {
	let mode: DiscoveryMode = "failure";
	const server = http.createServer((req, res) => {
		if (req.url === "/.well-known/opencode") {
			res.writeHead(mode === "failure" ? 503 : 404);
			res.end();
			return;
		}
		if (req.url === "/v1/models") {
			if (mode === "failure") {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "temporarily unavailable" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: mode === "empty" ? [] : [{ id: "openai/replacement-model", object: "model" }],
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				setMode: (next) => { mode = next; },
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

function writeRetainedCatalog(
	agentDir: string,
	configuredUrl: string,
	providerUrl = configuredUrl,
	jsonc = false,
	managed = true,
): void {
	const strict = JSON.stringify({
		providers: {
			aigw: {
				...(managed ? { "x-bobbit-managed": { kind: "aigw-publication", version: 1 } } : {}),
				baseUrl: providerUrl,
				apiKey: "none",
				api: "openai-completions",
				models: [{
					id: RETAINED_ID,
					name: "Retained GPT 5.4",
					upstreamProvider: "openai",
					api: "openai-responses",
					baseUrl: `${configuredUrl}/openai/v1`,
					contextWindow: 1_000_000,
					maxTokens: 128_000,
					reasoning: true,
					thinkingLevelMap: { xhigh: "xhigh", max: "max" },
					input: ["text", "image"],
					cost: RETAINED_COST,
					compat: { supportsReasoningEffort: true, supportsStrictTools: true },
				}],
			},
		},
	}, null, 2);
	const source = jsonc
		? strict.replace("{\n", "{\n  // Retained authoritative AIGW publication.\n").replace(/\n}$/, ",\n}")
		: strict;
	fs.writeFileSync(path.join(agentDir, "models.json"), source);
}

function startCustomCatalog(): Promise<{
	url: string;
	setMode: (mode: DiscoveryMode) => void;
	close: () => Promise<void>;
}> {
	let mode: DiscoveryMode = "success";
	const server = http.createServer((req, res) => {
		if (req.url !== "/v1/models") {
			res.writeHead(404).end();
			return;
		}
		if (mode === "failure") {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "temporarily unavailable" }));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			data: mode === "empty" ? [] : [{ id: "vision-custom", context_length: 96_000, max_tokens: 12_000 }],
		}));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				setMode: (next) => { mode = next; },
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

describe("AIGW retained catalog on discovery failure", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	const managers: any[] = [];

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-retained-"));
		process.env.BOBBIT_AGENT_DIR = agentDir;
		resetAgentDirStateForTests();
		invalidateModelCache();
	});

	afterEach(() => {
		registerRpcBridgeFactory(null);
		while (managers.length > 0) {
			const manager = managers.pop();
			if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
			manager?.sessions?.clear?.();
		}
		vi.restoreAllMocks();
		invalidateModelCache();
		if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("retains a matching persisted JSONC catalog only while discovery fails", async () => {
		const gateway = await startGateway();
		try {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			writeRetainedCatalog(agentDir, gateway.url, gateway.url, true);
			const retainedSource = fs.readFileSync(path.join(agentDir, "models.json"), "utf-8");

			const unavailableModels = await getAvailableModels(prefs);
			assert.equal(
				fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"),
				retainedSource,
				"read-only JSONC retention must not normalize or rewrite user-owned bytes",
			);
			const retained = findSessionSelectableModel(unavailableModels, "aigw", RETAINED_ID);
			assert.ok(retained, "a transient HTTP 503 must retain the exact persisted AIGW model for restore/spawn validation");
			assert.deepEqual(retained, {
				id: RETAINED_ID,
				name: "Retained GPT 5.4",
				provider: "aigw",
				upstreamProvider: "openai",
				api: "openai-responses",
				baseUrl: `${gateway.url}/openai/v1`,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text", "image"],
				cost: RETAINED_COST,
				compat: { supportsReasoningEffort: true, supportsStrictTools: true },
				authenticated: true,
			});

			writeRetainedCatalog(agentDir, gateway.url, "http://127.0.0.1:9");
			invalidateModelCache();
			const mismatchedModels = await getAvailableModels(prefs);
			assert.equal(
				findSessionSelectableModel(mismatchedModels, "aigw", RETAINED_ID),
				undefined,
				"retained routing from a different AIGW URL must not become selectable",
			);

			for (const invalidSource of [
				`{ "providers": {}, "providers": { "aigw": { "baseUrl": ${JSON.stringify(gateway.url)}, "models": [] } } }`,
				`{ "providers": { "aigw": { "baseUrl": ${JSON.stringify(gateway.url)}, "models": [ } } }`,
			]) {
				fs.writeFileSync(path.join(agentDir, "models.json"), invalidSource);
				invalidateModelCache();
				const rejected = await getAvailableModels(prefs);
				assert.equal(findSessionSelectableModel(rejected, "aigw", RETAINED_ID), undefined);
				assert.equal(
					fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"),
					invalidSource,
					"malformed or ambiguous JSONC must fail closed without mutating bytes",
				);
			}

			writeRetainedCatalog(agentDir, gateway.url);
			gateway.setMode("success");
			invalidateModelCache();
			const refreshedModels = await getAvailableModels(prefs);
			assert.equal(
				findSessionSelectableModel(refreshedModels, "aigw", RETAINED_ID),
				undefined,
				"a successful discovery omission is authoritative catalog drift",
			);
			const replacement = findSessionSelectableModel(refreshedModels, "aigw", "openai/replacement-model");
			assert.ok(replacement, "the successful live discovery catalog must replace retained availability");

			fs.rmSync(path.join(agentDir, "models.json"));
			gateway.setMode("failure");
			now += 5_001;
			const failedRefresh = await getAvailableModels(prefs);
			assert.deepEqual(
				findSessionSelectableModel(failedRefresh, "aigw", "openai/replacement-model"),
				replacement,
				"without a persisted fallback, an unchanged failed AIGW source must retain its full exact row",
			);

			gateway.setMode("empty");
			now += 5_001;
			const authoritativeEmpty = await getAvailableModels(prefs);
			assert.equal(
				findSessionSelectableModel(authoritativeEmpty, "aigw", "openai/replacement-model"),
				undefined,
				"a successful empty AIGW catalog must remove the previously retained row",
			);
		} finally {
			await gateway.close();
		}
	});

	it("uses an unmarked user AIGW target realm instead of reachable discovery at every spawn boundary", async () => {
		const gateway = await startGateway();
		gateway.setMode("success");
		try {
			const prefs = new PreferencesStore(path.join(agentDir, "unmarked-state"));
			prefs.set("aigw.url", gateway.url);
			writeRetainedCatalog(agentDir, gateway.url, gateway.url, true, false);
			const userSource = fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")
				.replace(RETAINED_ID, "user-only")
				.replace("Retained GPT 5.4", "User target model");
			fs.writeFileSync(path.join(agentDir, "models.json"), userSource);

			const models = await getAvailableModels(prefs);
			assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"), userSource);
			assert.equal(findSessionSelectableModel(models, "aigw", "openai/replacement-model"), undefined);
			const userModel = findSessionSelectableModel(models, "aigw", "user-only");
			assert.ok(userModel, "the exact row Pi composes from the unmarked provider must remain selectable");
			assert.equal(userModel.contextWindow, 1_000_000);
			assert.equal(userModel.reasoning, true);
			assert.deepEqual(userModel.input, ["text", "image"]);
			assert.deepEqual(resolveModelStateMeta("aigw", "user-only"), {
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text", "image"],
				source: "cache",
			});
			assert.equal(clampThinkingLevelForModel("max", "aigw", "user-only"), "max");

			let bridgeConstructions = 0;
			registerRpcBridgeFactory(() => {
				bridgeConstructions += 1;
				return { running: false, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as any;
			});
			const manager: any = new SessionManager({
				preferencesStore: prefs,
				stateDir: path.join(agentDir, "unmarked-manager-state"),
			});
			managers.push(manager);

			await assert.rejects(
				manager.finalizeSpawnOptions({
					cwd: agentDir,
					initialModel: "aigw/openai/replacement-model",
					initialThinkingLevel: "high",
					args: [],
				}, { model: "aigw/openai/replacement-model", thinkingLevel: "high" }),
				/not currently available for session selection/i,
			);
			assert.equal(bridgeConstructions, 0, "normal finalization must reject before RpcBridge construction");

			const transcript = path.join(agentDir, "unmarked-restore.jsonl");
			fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", version: 3, id: "unmarked-restore-rejection" })}\n`);
			const persisted = {
				id: "unmarked-restore-rejection",
				title: "Unmarked target restore",
				cwd: agentDir,
				projectId: "project-unmarked",
				agentSessionFile: transcript,
				createdAt: Date.now() - 1000,
				lastActivity: Date.now(),
				messageQueue: [],
				wasStreaming: false,
				modelProvider: "aigw",
				modelId: "openai/replacement-model",
				effectiveThinkingLevel: "high",
			};
			const store = { get: vi.fn(() => persisted), update: vi.fn(), archive: vi.fn() };
			manager._testStore = store;
			const ordinaryRestore = vi.spyOn(manager, "_restoreSessionCoalesced").mockResolvedValue(undefined);
			await manager.restoreOneSession(persisted);
			assert.equal(ordinaryRestore.mock.calls.length, 0);
			assert.deepEqual(manager.getSession(persisted.id)?.condition, {
				code: "MODEL_SELECTION_REQUIRED",
				provider: "aigw",
				modelId: "openai/replacement-model",
			});
			assert.equal(
				bridgeConstructions,
				1,
				"restore may create only its inert dormant placeholder, never a selected Pi bridge",
			);

			await assert.rejects(
				manager.finalizeSpawnOptions({
					cwd: agentDir,
					initialModel: "aigw/openai/replacement-model",
					initialThinkingLevel: "high",
					args: [],
					sandboxed: true,
					containerId: "unmarked-sandbox",
				}, { model: "aigw/openai/replacement-model", thinkingLevel: "high" }),
				/not currently available for session selection/i,
			);
			assert.equal(bridgeConstructions, 1, "sandbox rejection must not construct another RpcBridge");
			assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"), userSource);

			for (const invalidSource of [
				`{ "providers": {}, "providers": { "aigw": { "models": [] } } }`,
				`{ "providers": { "aigw": { "models": [ } } }`,
			]) {
				fs.writeFileSync(path.join(agentDir, "models.json"), invalidSource);
				invalidateModelCache();
				const rejected = await getAvailableModels(prefs);
				assert.equal(findSessionSelectableModel(rejected, "aigw", "openai/replacement-model"), undefined);
				assert.equal(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8"), invalidSource);
			}
		} finally {
			await gateway.close();
		}
	});

	it("retains exact custom rows only for unchanged failed sources", async () => {
		const custom = await startCustomCatalog();
		try {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const prefs = new PreferencesStore(path.join(agentDir, "custom-state"));
			const config = {
				id: "retained-custom",
				name: "retained-custom",
				type: "vllm" as const,
				baseUrl: custom.url,
			};
			prefs.set("customProviders", [config]);

			const initialModels = await getAvailableModels(prefs);
			const initial = findSessionSelectableModel(initialModels, config.name, "vision-custom");
			assert.deepEqual(initial, {
				id: "vision-custom",
				name: "vision-custom",
				provider: config.name,
				api: "openai-completions",
				baseUrl: `${custom.url}/v1`,
				contextWindow: 96_000,
				maxTokens: 12_000,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				authenticated: true,
			});

			custom.setMode("failure");
			now += 5_001;
			const failedRefresh = await getAvailableModels(prefs);
			assert.deepEqual(
				findSessionSelectableModel(failedRefresh, config.name, "vision-custom"),
				initial,
				"an expired failed refresh must retain the complete exact composed row",
			);
			assert.deepEqual(resolveModelStateMeta(config.name, "vision-custom"), {
				contextWindow: 96_000,
				maxTokens: 12_000,
				reasoning: false,
				input: ["text"],
				source: "cache",
			});
			assert.equal(
				clampThinkingLevelForModel("high", config.name, "vision-custom"),
				"off",
				"thinking clamping must continue to consume the retained exact non-reasoning row",
			);

			custom.setMode("empty");
			now += 5_001;
			const authoritativeEmpty = await getAvailableModels(prefs);
			assert.equal(findSessionSelectableModel(authoritativeEmpty, config.name, "vision-custom"), undefined);
			assert.equal(resolveModelStateMeta(config.name, "vision-custom").source, "unavailable");
			assert.equal(clampThinkingLevelForModel("high", config.name, "vision-custom"), undefined);

			custom.setMode("success");
			now += 5_001;
			assert.ok(findSessionSelectableModel(await getAvailableModels(prefs), config.name, "vision-custom"));
			custom.setMode("failure");
			invalidateModelCache();
			assert.equal(
				findSessionSelectableModel(await getAvailableModels(prefs), config.name, "vision-custom"),
				undefined,
				"explicit invalidation must not retain rows from the previous source snapshot",
			);

			custom.setMode("success");
			now += 5_001;
			assert.ok(findSessionSelectableModel(await getAvailableModels(prefs), config.name, "vision-custom"));
			custom.setMode("failure");
			prefs.set("customProviders", [{ ...config, baseUrl: `${custom.url}/changed` }]);
			now += 5_001;
			assert.equal(
				findSessionSelectableModel(await getAvailableModels(prefs), config.name, "vision-custom"),
				undefined,
				"a changed source identity must never inherit exact rows from the old configuration",
			);
		} finally {
			await custom.close();
		}
	});

	it("enters session recovery only after a successful authoritative omission", async () => {
		const gateway = await startGateway();
		try {
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			writeRetainedCatalog(agentDir, gateway.url);

			const transcript = path.join(agentDir, "retained-session.jsonl");
			fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", version: 3, id: "aigw-recovery-authority" })}\n`);
			const persisted = {
				id: "aigw-recovery-authority",
				title: "AIGW recovery authority",
				cwd: agentDir,
				projectId: "project-aigw",
				agentSessionFile: transcript,
				createdAt: Date.now() - 1000,
				lastActivity: Date.now(),
				messageQueue: [],
				wasStreaming: false,
				modelProvider: "aigw",
				modelId: RETAINED_ID,
				effectiveThinkingLevel: "xhigh",
			};
			const store = {
				get: vi.fn(() => persisted),
				update: vi.fn(),
				archive: vi.fn(),
			};
			registerRpcBridgeFactory(() => ({
				running: false,
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			} as any));

			const manager: any = new SessionManager({
				preferencesStore: prefs,
				stateDir: path.join(agentDir, "manager-state"),
			});
			manager._testStore = store;
			managers.push(manager);
			const ordinaryRestore = vi.spyOn(manager, "_restoreSessionCoalesced").mockResolvedValue(undefined);

			await manager.restoreOneSession(persisted);
			assert.equal(
				ordinaryRestore.mock.calls.length,
				1,
				"a transient discovery failure must keep the last-published tuple selectable and use ordinary restore",
			);
			assert.equal(
				manager.getSession(persisted.id),
				undefined,
				"transient discovery must not fabricate MODEL_SELECTION_REQUIRED recovery state",
			);

			ordinaryRestore.mockClear();
			gateway.setMode("success");
			invalidateModelCache();
			await manager.restoreOneSession(persisted);

			assert.equal(
				ordinaryRestore.mock.calls.length,
				0,
				"a successful catalog omission must enter recovery before attempting the retired tuple",
			);
			assert.deepEqual(
				manager.getSession(persisted.id)?.condition,
				{ code: "MODEL_SELECTION_REQUIRED", provider: "aigw", modelId: RETAINED_ID },
				"successful AIGW omission must reach the stable session recovery condition",
			);
			assert.equal(store.update.mock.calls.length, 0, "authority classification must not rewrite the durable tuple");
			assert.equal(persisted.modelProvider, "aigw");
			assert.equal(persisted.modelId, RETAINED_ID);
		} finally {
			await gateway.close();
		}
	});
});
