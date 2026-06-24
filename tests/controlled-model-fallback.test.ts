/**
 * Reproducing regression tests for the controlled session model fallback policy.
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/controlled-model-fallback.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	applyReviewModelOverrides,
	type ReviewModelRpc,
} from "../src/server/agent/review-model-override.js";
import { generateImage } from "../src/server/agent/image-generation.js";
import { PreferencesStore } from "../src/server/agent/preferences-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SESSION_MANAGER_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts");
const SESSION_SETUP_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-setup.ts");

type Prefs = Record<string, unknown>;
type ModelPair = [string, string];

function extractMethodBody(src: string, marker: string): string {
	const markerIndex = src.indexOf(marker);
	assert.ok(markerIndex >= 0, `could not find ${marker}`);
	const open = src.indexOf("{", markerIndex);
	assert.ok(open > markerIndex, `could not find opening brace for ${marker}`);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		if (ch === "}") depth--;
		if (depth === 0) return src.slice(open + 1, i);
	}
	throw new Error(`could not find closing brace for ${marker}`);
}

function loadTryAutoSelectModel(): (this: any, session: any) => Promise<void> {
	const src = readFileSync(SESSION_MANAGER_SOURCE, "utf-8");
	let body = extractMethodBody(src, "private async tryAutoSelectModel(session: SessionInfo)");
	body = body
		.replace(/\s+as\s+string\s*\|\s*undefined/g, "")
		.replace(/SessionManager\.AIGW_CACHE_TTL_MS/g, "60_000");

	const applyModelString = async (rpc: any, modelString: string, opts: any = {}) => {
		const slash = modelString.indexOf("/");
		if (slash <= 0 || slash >= modelString.length - 1) {
			throw new Error(`malformed ${opts.contextLabel ?? "model"}: ${modelString}`);
		}
		const provider = modelString.slice(0, slash);
		const modelId = modelString.slice(slash + 1);
		if (!opts.skipSetModel) await rpc.setModel(provider, modelId);
		const state = await rpc.getState();
		const bound = state?.data?.model ?? state?.model;
		if (bound?.provider !== provider || bound?.id !== modelId) {
			throw new Error(`setModel read-back mismatch for ${modelString}`);
		}
	};
	const isSessionSelectableModelString = (value: unknown) => (
		typeof value === "string" && /^[^/]+\/.+/.test(value) && !value.startsWith("image-only/")
	);
	const getAigwUrl = (prefs: { get: (key: string) => unknown }) => prefs.get("aigw.baseUrl") as string | undefined;
	const discoverAigwModels = async () => ([{ id: "us.anthropic.claude-opus-4-5" }]);
	const modelRecencyRank = () => 1;
	const inferMeta = () => ({ reasoning: false });
	const broadcast = (clients: Set<any>, message: any) => {
		for (const client of clients) client.messages.push(message);
	};

	// eslint-disable-next-line no-new-func
	return new Function(
		"applyModelString",
		"isSessionSelectableModelString",
		"getAigwUrl",
		"discoverAigwModels",
		"modelRecencyRank",
		"inferMeta",
		"broadcast",
		`return async function tryAutoSelectModel(session) {${body}\n};`,
	)(
		applyModelString,
		isSessionSelectableModelString,
		getAigwUrl,
		discoverAigwModels,
		modelRecencyRank,
		inferMeta,
		broadcast,
	);
}

const tryAutoSelectModel = loadTryAutoSelectModel();

async function exerciseAutoSelect(options: {
	prefs: Prefs;
	roleModel?: string;
	failModels?: string[];
}): Promise<{
	error: unknown;
	setModelCalls: ModelPair[];
	persisted: Array<Record<string, unknown>>;
	modelFiles: string[];
	broadcastModels: Array<{ provider: string; id: string }>;
}> {
	const setModelCalls: ModelPair[] = [];
	const persisted: Array<Record<string, unknown>> = [];
	const modelFiles: string[] = [];
	let bound: { provider: string; id: string } | undefined;
	const failModels = new Set(options.failModels ?? []);
	const client = { messages: [] as any[] };
	const manager = {
		preferencesStore: { get: (key: string) => options.prefs[key] },
		resolveRoleModel: () => options.roleModel,
		resolveStoreForSession: () => ({
			update: (_sessionId: string, update: Record<string, unknown>) => persisted.push(update),
		}),
		_writeModelNameFile: (_sessionId: string, model: string) => modelFiles.push(model),
		_aigwModelCache: undefined,
	};
	const session = {
		id: "session-under-test",
		role: "coder",
		spawnPinnedModel: undefined,
		clients: new Set([client]),
		rpcClient: {
			async setModel(provider: string, modelId: string) {
				setModelCalls.push([provider, modelId]);
				const key = `${provider}/${modelId}`;
				if (failModels.has(key)) {
					throw new Error(`controlled model fallback policy fixture: unavailable ${key}`);
				}
				bound = { provider, id: modelId };
			},
			async getState() {
				return { model: bound ?? { provider: "unset", id: "unset" } };
			},
		},
	};

	let error: unknown;
	try {
		await tryAutoSelectModel.call(manager, session);
	} catch (err) {
		error = err;
	}

	return {
		error,
		setModelCalls,
		persisted,
		modelFiles,
		broadcastModels: client.messages
			.map((msg) => msg?.data?.model)
			.filter(Boolean)
			.map((model) => ({ provider: model.provider, id: model.id })),
	};
}

function makeReviewRpc(failModels: string[] = []): ReviewModelRpc & {
	setModelCalls: ModelPair[];
	persistedModel?: { provider: string; id: string };
} {
	const setModelCalls: ModelPair[] = [];
	const fail = new Set(failModels);
	let bound: { provider: string; id: string } | undefined;
	return {
		setModelCalls,
		async setModel(provider: string, modelId: string) {
			setModelCalls.push([provider, modelId]);
			const key = `${provider}/${modelId}`;
			if (fail.has(key)) throw new Error(`controlled model fallback policy fixture: unavailable ${key}`);
			bound = { provider, id: modelId };
		},
		async getState() {
			return { model: bound ?? { provider: "unset", id: "unset" } };
		},
	} as any;
}

function tempPrefs(): { prefs: PreferencesStore; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-controlled-fallback-"));
	return {
		prefs: new PreferencesStore(dir),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("controlled model fallback policy — session auto-selection", () => {
	it("off/absent setting: failing explicit default.sessionModel rejects and never falls through to AIGW", async () => {
		const result = await exerciseAutoSelect({
			prefs: {
				"default.sessionModel": "aigw/dead-default",
				"aigw.baseUrl": "https://aigw.test",
			},
			failModels: ["aigw/dead-default"],
		});

		assert.ok(
			result.error,
			"controlled model fallback policy: failing explicit default.sessionModel must reject instead of selecting AIGW best-ranked",
		);
		assert.deepEqual(
			result.setModelCalls,
			[["aigw", "dead-default"]],
			"controlled model fallback policy: no AIGW best-ranked setModel call is allowed after explicit default.sessionModel fails",
		);
		assert.equal(result.persisted.length, 0, "controlled model fallback policy: failed explicit model must not persist another model");
		assert.equal(result.modelFiles.length, 0, "controlled model fallback policy: failed explicit model must not write a fallback .model file");
		assert.equal(result.broadcastModels.length, 0, "controlled model fallback policy: failed explicit model must not broadcast a fallback model");
	});

	it("enabled setting: failing explicit role model falls back exactly once to default.sessionModel and persists the actual fallback", async () => {
		const result = await exerciseAutoSelect({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "openai/fallback-session",
				"aigw.baseUrl": "https://aigw.test",
			},
			roleModel: "anthropic/dead-role",
			failModels: ["anthropic/dead-role"],
		});

		assert.equal(result.error, undefined, "controlled model fallback policy: enabled setting should allow role model to fall back to default.sessionModel");
		assert.deepEqual(
			result.setModelCalls,
			[["anthropic", "dead-role"], ["openai", "fallback-session"]],
			"controlled model fallback policy: role fallback may try only the selected model and default.sessionModel",
		);
		assert.deepEqual(
			result.persisted,
			[{ modelProvider: "openai", modelId: "fallback-session" }],
			"controlled model fallback policy: persisted model must be the actual default.sessionModel fallback",
		);
		assert.deepEqual(result.broadcastModels, [{ provider: "openai", id: "fallback-session" }]);
		assert.deepEqual(result.modelFiles, ["openai/fallback-session"]);
	});

	it("enabled setting: malformed explicit default.sessionModel fails loudly and never chooses AIGW/hardcoded fallback", async () => {
		const result = await exerciseAutoSelect({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "not-a-model-pref",
				"aigw.baseUrl": "https://aigw.test",
			},
		});

		assert.ok(result.error, "controlled model fallback policy: malformed explicit default.sessionModel must reject");
		assert.deepEqual(result.setModelCalls, [], "controlled model fallback policy: malformed default.sessionModel must not trigger AIGW/hardcoded setModel");
		assert.equal(result.persisted.length, 0, "controlled model fallback policy: malformed default.sessionModel must not persist a fallback");
	});

	it("enabled setting: missing, same-as-selected, or failing default.sessionModel never falls through to AIGW", async () => {
		const missing = await exerciseAutoSelect({
			prefs: { allowSessionModelFallback: true, "aigw.baseUrl": "https://aigw.test" },
			roleModel: "anthropic/dead-role",
			failModels: ["anthropic/dead-role"],
		});
		assert.ok(missing.error, "controlled model fallback policy: missing default.sessionModel must reject");
		assert.deepEqual(missing.setModelCalls, [["anthropic", "dead-role"]]);
		assert.equal(missing.persisted.length, 0);

		const same = await exerciseAutoSelect({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "anthropic/dead-role",
				"aigw.baseUrl": "https://aigw.test",
			},
			roleModel: "anthropic/dead-role",
			failModels: ["anthropic/dead-role"],
		});
		assert.ok(same.error, "controlled model fallback policy: same-as-selected default.sessionModel must reject");
		assert.deepEqual(same.setModelCalls, [["anthropic", "dead-role"]]);
		assert.equal(same.persisted.length, 0);

		const failingDefault = await exerciseAutoSelect({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "openai/dead-fallback",
				"aigw.baseUrl": "https://aigw.test",
			},
			roleModel: "anthropic/dead-role",
			failModels: ["anthropic/dead-role", "openai/dead-fallback"],
		});
		assert.ok(failingDefault.error, "controlled model fallback policy: failing default.sessionModel fallback must reject");
		assert.deepEqual(
			failingDefault.setModelCalls,
			[["anthropic", "dead-role"], ["openai", "dead-fallback"]],
			"controlled model fallback policy: failing fallback target should be tried exactly once, then stop without AIGW",
		);
		assert.equal(failingDefault.persisted.length, 0);
	});
});

describe("controlled model fallback policy — session setup visibility", () => {
	it("normal/worktree post-spawn model selection is awaited, not swallowed as a warning", () => {
		const src = readFileSync(SESSION_SETUP_SOURCE, "utf-8");
		const postSpawnBody = extractMethodBody(src, "async function postSpawn(session: SessionInfo");

		assert.match(
			postSpawnBody,
			/await\s+ctx\.tryAutoSelectModel\(session\)/,
			"controlled model fallback policy: post-spawn model selection must be awaited so explicit failures reject visibly",
		);
		assert.doesNotMatch(
			postSpawnBody,
			/tryAutoSelectModel\(session\)\.catch[\s\S]*Early model selection failed/,
			"controlled model fallback policy: model selection failures must not be swallowed as fire-and-forget warnings",
		);
		assert.match(
			postSpawnBody,
			/tryApplyDefaultThinkingLevel\(session\)\.catch[\s\S]*Early thinking level failed/,
			"thinking-level failures may remain non-fatal warnings",
		);

		const worktreeBody = extractMethodBody(src, "export async function executeWorktreeAsync");
		const postSpawnIdx = worktreeBody.indexOf("await postSpawn(session, plan, ctx)");
		const idleIdx = worktreeBody.indexOf('broadcastStatus(session, "idle")');
		assert.ok(postSpawnIdx >= 0, "worktree setup must call postSpawn");
		assert.ok(idleIdx >= 0, "worktree setup must broadcast idle");
		assert.ok(
			postSpawnIdx < idleIdx,
			"controlled model fallback policy: worktree sessions must enforce model selection before becoming idle/live",
		);
	});
});

describe("controlled model fallback policy — review model overrides", () => {
	it("enabled setting: failing explicit review model falls back only to default.sessionModel and persists that actual model", async () => {
		const rpc = makeReviewRpc(["aigw/dead-review"]);
		const persisted: Array<{ sessionId: string; provider: string; modelId: string }> = [];
		const prefs = {
			get(key: string) {
				return ({
					allowSessionModelFallback: true,
					"default.reviewModel": "aigw/dead-review",
					"default.sessionModel": "openai/fallback-session",
				} as Record<string, unknown>)[key] as string | undefined;
			},
		};

		await applyReviewModelOverrides(rpc, {
			prefs,
			sessionId: "review-session",
			sessionManager: {
				persistSessionModel(sessionId: string, provider: string, modelId: string) {
					persisted.push({ sessionId, provider, modelId });
				},
			},
			maxAttempts: 1,
			retryDelayMs: 0,
			controlledFallback: { enabled: true, model: "openai/fallback-session" },
		} as any);

		assert.deepEqual(
			rpc.setModelCalls,
			[["aigw", "dead-review"], ["openai", "fallback-session"]],
			"controlled model fallback policy: review fallback may try only the selected review model and default.sessionModel",
		);
		assert.deepEqual(
			persisted,
			[{ sessionId: "review-session", provider: "openai", modelId: "fallback-session" }],
			"controlled model fallback policy: review fallback must persist/display the actual default.sessionModel fallback",
		);
	});
});

describe("controlled model fallback policy — image generation remains separate", () => {
	it("explicit unavailable image model does not benefit from session fallback setting", async () => {
		const { prefs, cleanup } = tempPrefs();
		const previousFetch = globalThis.fetch;
		let fetchCalls = 0;
		try {
			prefs.set("allowSessionModelFallback", true as any);
			prefs.set("default.sessionModel", "openai/fallback-session");
			prefs.set("providerKey.openai", "test-openai-key");
			globalThis.fetch = (async () => {
				fetchCalls++;
				throw new Error("controlled model fallback policy: explicit image model fell through to a fallback image request");
			}) as typeof fetch;

			let error: unknown;
			try {
				await generateImage(prefs, { prompt: "test", model: "not-a-provider/not-an-image-model" });
			} catch (err) {
				error = err;
			}

			assert.ok(error, "controlled model fallback policy: explicit unavailable image model must fail loudly");
			assert.match(
				String((error as Error).message ?? error),
				/unknown|unavailable|unsupported|not configured|controlled model fallback policy/i,
				"controlled model fallback policy: image failure should identify unavailable explicit image model",
			);
			assert.equal(fetchCalls, 0, "controlled model fallback policy: image generation must not use fallback/default image model after explicit image selection fails");
		} finally {
			globalThis.fetch = previousFetch;
			cleanup();
		}
	});
});
