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
import { applyRuntimeSessionModelSelection } from "../src/server/ws/runtime-model-selection.js";
import { generateImage } from "../src/server/agent/image-generation.js";
import { fallbackProviderAllowlistFromPrefs, resolveHostAgentProviderEnv } from "../src/server/agent/host-tokens.js";
import { PreferencesStore } from "../src/server/agent/preferences-store.js";
import { selectAigwModelForRoleTier } from "../src/server/agent/model-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SESSION_MANAGER_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts");
const SESSION_MODELS_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-models.ts");
const SESSION_REVIVE_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-revive.ts");
const SESSION_STEERING_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-steering.ts");
const SESSION_SETUP_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-setup.ts");
const VERIFICATION_HARNESS_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/verification-harness.ts");
const SERVER_SOURCE = path.join(PROJECT_ROOT, "src/server/server.ts");

type Prefs = Record<string, unknown>;
type ModelPair = [string, string];

// Mutable fixture consumed by the `discoverAigwModels` mock inside
// loadTryAutoSelectModel(). Set per-test via exerciseAutoSelect's
// `aigwModels` option (defaults to a single frontier model, matching the
// pre-existing fixture used by every test that doesn't care about the
// aigw rank-tier fix).
let currentMockAigwModels: { id: string }[] = [{ id: "us.anthropic.claude-opus-4-5" }];

function extractRouteSlice(src: string, startMarker: string, endMarker: string): string {
	const start = src.indexOf(startMarker);
	assert.ok(start >= 0, `could not find ${startMarker}`);
	const end = src.indexOf(endMarker, start);
	assert.ok(end > start, `could not find ${endMarker} after ${startMarker}`);
	return src.slice(start, end);
}

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
	const src = readFileSync(SESSION_MODELS_SOURCE, "utf-8");
	let body = extractMethodBody(src, "async tryAutoSelectModel(session: SessionInfo)");
	body = body
		.replace(/\s+as\s+string\s*\|\s*undefined/g, "")
		.replace(/SessionModels\.AIGW_CACHE_TTL_MS/g, "60_000");

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
	const discoverAigwModels = async () => currentMockAigwModels;
	const inferMeta = () => ({ reasoning: false });
	const sanitizeModelErrorText = (err: unknown) => err instanceof Error ? err.message : String(err);
	const sanitizeModelErrorForLog = sanitizeModelErrorText;
	const broadcast = (clients: Set<any>, message: any) => {
		for (const client of clients) client.messages.push(message);
	};
	// Minimal stand-in for session-runtime.ts::resolveSessionRuntime — the
	// fixture's persisted store always reports no prior runtime/model, so this
	// only ever needs to resolve to the non-"claude-code" default.
	const resolveSessionRuntime = (opts: { runtime?: string; modelProvider?: string }) => (
		opts.runtime ?? (opts.modelProvider === "claude-code" ? "claude-code" : "pi")
	);
	// Stub for the module-level helper `tryAutoSelectModel` uses to build the
	// `state` broadcast payload from the registry-backed resolver
	// (`resolveModelStateMeta`). The eval scope has no model-registry cache, so
	// mirror only the shape the assertions read (`data.model.{provider,id}`).
	const buildModelStateData = (provider: string, id: string) => ({
		model: { provider, id, reasoning: false },
	});

	// eslint-disable-next-line no-new-func
	return new Function(
		"applyModelString",
		"isSessionSelectableModelString",
		"getAigwUrl",
		"discoverAigwModels",
		"selectAigwModelForRoleTier",
		"inferMeta",
		"sanitizeModelErrorText",
		"sanitizeModelErrorForLog",
		"broadcast",
		"resolveSessionRuntime",
		"buildModelStateData",
		`return async function tryAutoSelectModel(session) {${body}\n};`,
	)(
		applyModelString,
		isSessionSelectableModelString,
		getAigwUrl,
		discoverAigwModels,
		selectAigwModelForRoleTier,
		inferMeta,
		sanitizeModelErrorText,
		sanitizeModelErrorForLog,
		broadcast,
		resolveSessionRuntime,
		buildModelStateData,
	);
}

const tryAutoSelectModel = loadTryAutoSelectModel();

async function exerciseAutoSelect(options: {
	prefs: Prefs;
	roleModel?: string;
	roleThinkingLevel?: string;
	aigwModels?: { id: string }[];
	failModels?: string[];
	spawnPinnedModel?: string;
	initialBound?: { provider: string; id: string };
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
	let bound: { provider: string; id: string } | undefined = options.initialBound;
	const failModels = new Set(options.failModels ?? []);
	const client = { messages: [] as any[] };
	currentMockAigwModels = options.aigwModels ?? [{ id: "us.anthropic.claude-opus-4-5" }];
	const manager = {
		preferencesStore: { get: (key: string) => options.prefs[key] },
		resolveRoleModel: () => options.roleModel,
		resolveRoleThinkingLevel: () => options.roleThinkingLevel,
		resolveStoreForSession: () => ({
			get: () => undefined,
			update: (_sessionId: string, update: Record<string, unknown>) => persisted.push(update),
		}),
		_writeModelNameFile: (_sessionId: string, model: string) => modelFiles.push(model),
		broadcast: (clients: Set<any>, message: any) => {
			for (const target of clients) target.messages.push(message);
		},
		_aigwModelCache: undefined,
	};
	const session = {
		id: "session-under-test",
		role: "coder",
		spawnPinnedModel: options.spawnPinnedModel,
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

function makeRuntimeHarness(options: {
	prefs?: Prefs;
	failModels?: string[];
	readBack?: { provider: string; id: string };
	/** Runtime the session is already on before this `set_model` call — mirrors
	 *  the persisted `PersistedSession.runtime`/`modelProvider` fields
	 *  `resolveSessionRuntime()` reads. Defaults to unset ("pi"). */
	initialRuntime?: string;
	initialModelProvider?: string;
} = {}) {
	const setModelCalls: ModelPair[] = [];
	const persisted: Array<{ sessionId: string; provider: string; modelId: string }> = [];
	const modelFiles: string[] = [];
	const messages: any[] = [];
	let bound: { provider: string; id: string } | undefined;
	const fail = new Set(options.failModels ?? []);
	const sessionManager = {
		persistSessionModel(sessionId: string, provider: string, modelId: string) {
			persisted.push({ sessionId, provider, modelId });
		},
		getPersistedSession(sessionId: string) {
			const match = [...persisted].reverse().find((entry) => entry.sessionId === sessionId);
			if (match) return { runtime: options.initialRuntime, modelProvider: match.provider, modelId: match.modelId };
			if (options.initialRuntime || options.initialModelProvider) {
				return { runtime: options.initialRuntime, modelProvider: options.initialModelProvider };
			}
			return undefined;
		},
		updateModelNameFile(_sessionId: string, modelName: string) {
			modelFiles.push(modelName);
		},
	};
	const session = {
		id: "runtime-session",
		clients: new Set([{ readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) }]),
		rpcClient: {
			async setModel(provider: string, modelId: string) {
				setModelCalls.push([provider, modelId]);
				const key = `${provider}/${modelId}`;
				if (fail.has(key)) throw new Error(`controlled model fallback policy fixture: unavailable ${key}`);
				bound = { provider, id: modelId };
			},
			async getState() {
				return { model: options.readBack ?? bound ?? { provider: "unset", id: "unset" } };
			},
		},
	};
	const prefs = {
		get(key: string) {
			return options.prefs?.[key];
		},
	};
	const broadcast = (_clients: any, msg: any) => messages.push(msg);
	return { sessionManager, session, prefs, broadcast, setModelCalls, persisted, modelFiles, messages };
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

	it("off/absent setting: failing explicit role.model rejects and never falls through to AIGW — the exact risk that keeps built-in role.model unset", async () => {
		// This is the load-bearing evidence for VER-02 / F5-model-aigw: shipping
		// a hardcoded literal role.model default (e.g. a specific Anthropic
		// model string) on a built-in role would hard-fail every spawn of that
		// role on any install where that literal model isn't configured/
		// available, because role.model failures do NOT gracefully degrade
		// unless the operator has separately opted into
		// allowSessionModelFallback AND configured a working
		// default.sessionModel. Both are off by default.
		const result = await exerciseAutoSelect({
			prefs: { "aigw.baseUrl": "https://aigw.test" },
			roleModel: "anthropic/not-actually-configured",
			failModels: ["anthropic/not-actually-configured"],
		});

		assert.ok(
			result.error,
			"controlled model fallback policy: an unavailable role.model must reject instead of silently falling through to AIGW best-ranked",
		);
		assert.deepEqual(
			result.setModelCalls,
			[["anthropic", "not-actually-configured"]],
			"controlled model fallback policy: no AIGW setModel call is allowed after an explicit role.model fails with fallback off",
		);
		assert.equal(result.persisted.length, 0);
		assert.equal(result.modelFiles.length, 0);
		assert.equal(result.broadcastModels.length, 0);
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

	it("restore/respawn spawn-pinned model is verified and fails visibly when fallback is off", async () => {
		const result = await exerciseAutoSelect({
			prefs: { "aigw.baseUrl": "https://aigw.test" },
			spawnPinnedModel: "anthropic/stale-persisted",
			initialBound: { provider: "unset", id: "unset" },
		});

		assert.ok(result.error, "controlled model fallback policy: stale spawn-pinned persisted model must fail when fallback is off");
		assert.deepEqual(result.setModelCalls, [], "spawn-pinned verification must not call setModel for the failed selected model or AIGW");
		assert.equal(result.persisted.length, 0);
		assert.equal(result.broadcastModels.length, 0);
	});

	it("enabled setting: failing restore/respawn spawn-pinned model falls back only to default.sessionModel", async () => {
		const result = await exerciseAutoSelect({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "openai/fallback-session",
				"aigw.baseUrl": "https://aigw.test",
			},
			spawnPinnedModel: "anthropic/stale-persisted",
			initialBound: { provider: "unset", id: "unset" },
		});

		assert.equal(result.error, undefined);
		assert.deepEqual(result.setModelCalls, [["openai", "fallback-session"]]);
		assert.deepEqual(result.persisted, [{ modelProvider: "openai", modelId: "fallback-session" }]);
		assert.deepEqual(result.broadcastModels, [{ provider: "openai", id: "fallback-session" }]);
	});
});

describe("F5-model-aigw: aigw auto-select is role-tier aware", () => {
	// No role.model and no default.sessionModel — this is the "Fall back to
	// aigw best-ranked model" branch in tryAutoSelectModel. Before this fix it
	// always picked the single highest-modelRecencyRank discovered model for
	// EVERY session regardless of role, so a mechanical docs-only task burned
	// the same frontier-priced model as an architect (finding F5-model-aigw).
	const aigwModels = [
		{ id: "claude-opus-4-8" }, // highest rank
		{ id: "claude-3-5-haiku" }, // lowest rank
		{ id: "claude-sonnet-4-6" }, // mid
	];

	it("low-tier role (docs-writer today) auto-selects the cheapest discovered aigw model", async () => {
		const result = await exerciseAutoSelect({
			prefs: { "aigw.baseUrl": "https://aigw.test" },
			roleThinkingLevel: "low",
			aigwModels,
		});

		assert.equal(result.error, undefined);
		assert.deepEqual(result.setModelCalls, [["aigw", "claude-3-5-haiku"]]);
		assert.deepEqual(result.persisted, [{ modelProvider: "aigw", modelId: "claude-3-5-haiku" }]);
		assert.deepEqual(result.broadcastModels, [{ provider: "aigw", id: "claude-3-5-haiku" }]);
	});

	for (const tier of ["high", "medium", undefined] as const) {
		it(`${tier ?? "unset"}-tier role keeps today's behavior: auto-selects the highest-ranked discovered aigw model`, async () => {
			const result = await exerciseAutoSelect({
				prefs: { "aigw.baseUrl": "https://aigw.test" },
				roleThinkingLevel: tier,
				aigwModels,
			});

			assert.equal(result.error, undefined);
			assert.deepEqual(result.setModelCalls, [["aigw", "claude-opus-4-8"]]);
			assert.deepEqual(result.persisted, [{ modelProvider: "aigw", modelId: "claude-opus-4-8" }]);
		});
	}

	it("a single discovered model is picked regardless of role tier", async () => {
		const result = await exerciseAutoSelect({
			prefs: { "aigw.baseUrl": "https://aigw.test" },
			roleThinkingLevel: "low",
			aigwModels: [{ id: "claude-sonnet-4-6" }],
		});

		assert.equal(result.error, undefined);
		assert.deepEqual(result.setModelCalls, [["aigw", "claude-sonnet-4-6"]]);
	});
});

describe("controlled model fallback policy — runtime WS set_model", () => {
	// Regression coverage for the CC-841 reconcile: a live `set_model` request
	// crossing the Pi/Claude Code runtime boundary must be rejected by
	// `assertRuntimeSwitchAllowed()` (session-runtime.ts) with
	// `RUNTIME_SWITCH_REQUIRES_NEW_SESSION` BEFORE any RPC call is attempted —
	// not fall through to `applyModelString`, which would try to bind a
	// cross-runtime model onto whichever bridge the session already has. See
	// docs/design/claude-code-runtime-reconcile.md "Runtime dispatch seam".
	it("rejects a Pi session's set_model targeting claude-code with RUNTIME_SWITCH_REQUIRES_NEW_SESSION and never calls the RPC", async () => {
		const harness = makeRuntimeHarness({ initialRuntime: "pi", initialModelProvider: "anthropic" });

		await assert.rejects(
			applyRuntimeSessionModelSelection(
				harness.sessionManager as any,
				harness.session as any,
				"claude-code",
				"local-claude-opus-4-8",
				harness.prefs as any,
				harness.broadcast,
			),
			(err: any) => err?.code === "RUNTIME_SWITCH_REQUIRES_NEW_SESSION",
		);

		assert.deepEqual(harness.setModelCalls, [], "runtime-switch rejection must happen before any setModel RPC");
		assert.deepEqual(harness.persisted, []);
		assert.deepEqual(harness.modelFiles, []);
		assert.deepEqual(harness.messages, [], "runtime-switch rejection must not broadcast a model state");
	});

	it("rejects a Claude Code session's set_model targeting a Pi-backed provider with RUNTIME_SWITCH_REQUIRES_NEW_SESSION", async () => {
		const harness = makeRuntimeHarness({ initialRuntime: "claude-code", initialModelProvider: "claude-code" });

		await assert.rejects(
			applyRuntimeSessionModelSelection(
				harness.sessionManager as any,
				harness.session as any,
				"anthropic",
				"claude-opus-4-1",
				harness.prefs as any,
				harness.broadcast,
			),
			(err: any) => err?.code === "RUNTIME_SWITCH_REQUIRES_NEW_SESSION",
		);

		assert.deepEqual(harness.setModelCalls, []);
		assert.deepEqual(harness.persisted, []);
		assert.deepEqual(harness.modelFiles, []);
		assert.deepEqual(harness.messages, []);
	});

	it("allows a same-runtime Claude Code alias switch through to the RPC unaffected by the guard", async () => {
		const harness = makeRuntimeHarness({ initialRuntime: "claude-code", initialModelProvider: "claude-code" });

		const actual = await applyRuntimeSessionModelSelection(
			harness.sessionManager as any,
			harness.session as any,
			"claude-code",
			"local-claude-opus-4-8",
			harness.prefs as any,
			harness.broadcast,
		);

		assert.deepEqual(actual, { provider: "claude-code", id: "local-claude-opus-4-8" });
		assert.deepEqual(harness.setModelCalls, [["claude-code", "local-claude-opus-4-8"]]);
	});

	it("fallback off: read-back mismatch rejects and does not persist, broadcast, or update model file", async () => {
		const harness = makeRuntimeHarness({
			readBack: { provider: "anthropic", id: "still-old" },
		});

		await assert.rejects(
			applyRuntimeSessionModelSelection(
				harness.sessionManager as any,
				harness.session as any,
				"anthropic",
				"selected-new",
				harness.prefs as any,
				harness.broadcast,
			),
			/read-back mismatch|mismatch/i,
		);

		assert.deepEqual(harness.setModelCalls, [["anthropic", "selected-new"]]);
		assert.deepEqual(harness.persisted, [], "runtime set_model mismatch must not persist the selected model");
		assert.deepEqual(harness.modelFiles, [], "runtime set_model mismatch must not update .model state");
		assert.deepEqual(harness.messages, [], "runtime set_model mismatch must not broadcast a successful model state");
	});

	it("fallback on: failed non-default runtime selection falls back only to default.sessionModel and displays that actual model", async () => {
		const harness = makeRuntimeHarness({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "openai/fallback-session",
			},
			failModels: ["anthropic/dead-selected"],
		});

		const actual = await applyRuntimeSessionModelSelection(
			harness.sessionManager as any,
			harness.session as any,
			"anthropic",
			"dead-selected",
			harness.prefs as any,
			harness.broadcast,
		);

		assert.deepEqual(actual, { provider: "openai", id: "fallback-session" });
		assert.deepEqual(harness.setModelCalls, [["anthropic", "dead-selected"], ["openai", "fallback-session"]]);
		assert.deepEqual(harness.persisted, [{ sessionId: "runtime-session", provider: "openai", modelId: "fallback-session" }]);
		assert.deepEqual(harness.modelFiles, ["openai/fallback-session"]);
		assert.deepEqual(harness.messages.map((msg) => msg?.data?.model?.provider), ["openai"]);
		assert.deepEqual(harness.messages.map((msg) => msg?.data?.model?.id), ["fallback-session"]);
	});

	it("fallback on: same-as-selected default.sessionModel rejects without trying another fallback or persisting stale state", async () => {
		const harness = makeRuntimeHarness({
			prefs: {
				allowSessionModelFallback: true,
				"default.sessionModel": "anthropic/dead-selected",
			},
			failModels: ["anthropic/dead-selected"],
		});

		await assert.rejects(
			applyRuntimeSessionModelSelection(
				harness.sessionManager as any,
				harness.session as any,
				"anthropic",
				"dead-selected",
				harness.prefs as any,
				harness.broadcast,
			),
			/same as failed model|fallback rejected/i,
		);

		assert.deepEqual(harness.setModelCalls, [["anthropic", "dead-selected"]]);
		assert.deepEqual(harness.persisted, []);
		assert.deepEqual(harness.modelFiles, []);
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
		const postSpawnIdx = worktreeBody.indexOf("postSpawn(session, plan, ctx)");
		const idleIdx = worktreeBody.indexOf('broadcastStatus(session, "idle")');
		assert.ok(postSpawnIdx >= 0, "worktree setup must call postSpawn");
		assert.ok(idleIdx >= 0, "worktree setup must broadcast idle");
		assert.ok(
			postSpawnIdx < idleIdx,
			"controlled model fallback policy: worktree sessions must enforce model selection before becoming idle/live",
		);
	});
});

describe("controlled model fallback policy — restore/respawn lifecycle", () => {
	it("fork and continue routes verify inherited persisted models instead of skipping auto-selection", () => {
		const src = readFileSync(SERVER_SOURCE, "utf-8");
		const forkRoute = extractRouteSlice(src, "// POST /api/sessions/:id/fork", "// POST /api/sessions/:id/wait");
		const continueRoute = extractRouteSlice(src, "// POST /api/sessions/:archivedId/continue", "// GET /api/sessions/:id/output");

		for (const [label, route] of [["fork", forkRoute], ["continue", continueRoute]] as const) {
			assert.match(
				route,
				/if \(ps\.modelProvider && ps\.modelId\)[\s\S]*createOpts\.initialModel = `\$\{ps\.modelProvider\}\/\$\{ps\.modelId\}`/,
				`${label}: persisted model should still be spawn-pinned as the explicit selected model`,
			);
			assert.doesNotMatch(
				route,
				/skipAutoModel:\s*!!\(ps\.modelProvider && ps\.modelId\)/,
				`${label}: inherited explicit model must not bypass post-spawn read-back/fallback enforcement`,
			);
			assert.doesNotMatch(
				route,
				/persistSessionModel\([^,]+,\s*ps\.modelProvider,\s*ps\.modelId\)/,
				`${label}: route must not re-persist a stale inherited model after controlled fallback may have selected another model`,
			);
		}
	});

	it("restore verifies spawn-pinned persisted model before broadcasting idle", () => {
		const src = readFileSync(SESSION_REVIVE_SOURCE, "utf-8");
		const body = extractMethodBody(src, "async restoreSession(ps: PersistedSession)");

		assert.match(
			body,
			/spawnPinnedModel:\s*bridgeOptions\.initialModel/,
			"controlled model fallback policy: restored persisted initialModel must be carried as spawnPinnedModel for read-back verification",
		);
		const switchIdx = body.indexOf("if (!switchResp.success)");
		const verifyIdx = body.indexOf("await this.deps.host.tryAutoSelectModel(session)");
		const idleIdx = body.indexOf('broadcastStatus(session, "idle")', verifyIdx);
		assert.ok(switchIdx >= 0 && verifyIdx > switchIdx, "restore must verify model after switch_session succeeds");
		assert.ok(idleIdx > verifyIdx, "restore must verify controlled fallback policy before broadcasting idle");
	});

	it("role assignment and force-abort respawns verify spawn-pinned model before idle", () => {
		const src = readFileSync(SESSION_MANAGER_SOURCE, "utf-8");
		for (const [label, marker] of [
			["role assignment", "): Promise<boolean> {\n\t\tconst session = this.sessions.get(id);"],
			["force abort", "async forceAbort(id: string"],
		] as const) {
			const body = extractMethodBody(src, marker);
			const pinnedIdx = body.indexOf("session.spawnPinnedModel = bridgeOptions.initialModel");
			const verifyIdx = body.indexOf("await this.tryAutoSelectModel(session)", pinnedIdx);
			const idleIdx = body.indexOf('broadcastStatus(session, "idle")', verifyIdx);
			assert.ok(pinnedIdx >= 0, `${label}: respawn must carry initialModel as spawnPinnedModel`);
			assert.ok(verifyIdx > pinnedIdx, `${label}: respawn must verify spawn-pinned model`);
			assert.ok(idleIdx > verifyIdx, `${label}: respawn must verify model before broadcasting idle`);
		}
	});
});

describe("controlled model fallback policy — direct host provider env", () => {
	it("includes fallback provider credentials only when controlled fallback is enabled", () => {
		const makePrefs = (allow: boolean) => ({
			get(key: string) {
				return ({
					allowSessionModelFallback: allow,
					"default.sessionModel": "openai/fallback-session",
					"providerKey.anthropic": "anthropic-key",
					"providerKey.openai": "openai-key",
					"providerKey.xai": "xai-key",
				} as Record<string, unknown>)[key];
			},
		});

		const enabledPrefs = makePrefs(true);
		assert.deepEqual(
			resolveHostAgentProviderEnv(enabledPrefs as any, {
				model: "anthropic/selected-session",
				providers: fallbackProviderAllowlistFromPrefs(enabledPrefs as any),
			}),
			{ ANTHROPIC_API_KEY: "anthropic-key", OPENAI_API_KEY: "openai-key" },
			"enabled policy must allow credentials for selected provider and default.sessionModel fallback provider only",
		);

		const disabledPrefs = makePrefs(false);
		assert.deepEqual(
			resolveHostAgentProviderEnv(disabledPrefs as any, {
				model: "anthropic/selected-session",
				providers: fallbackProviderAllowlistFromPrefs(disabledPrefs as any),
			}),
			{ ANTHROPIC_API_KEY: "anthropic-key" },
			"disabled policy must not inject fallback provider credentials",
		);
	});

	it("normal setup, restore/respawn, and legacy verification use the fallback provider allowlist", () => {
		const setupSrc = readFileSync(SESSION_SETUP_SOURCE, "utf-8");
		const steeringSrc = readFileSync(SESSION_STEERING_SOURCE, "utf-8");
		const verificationSrc = readFileSync(VERIFICATION_HARNESS_SOURCE, "utf-8");

		assert.match(setupSrc, /providers:\s*fallbackProviderAllowlistFromPrefs\(ctx\.preferencesStore\)/);
		assert.match(steeringSrc, /providers:\s*fallbackProviderAllowlistFromPrefs\(this\.preferencesStore\)/);
		assert.match(verificationSrc, /providers:\s*fallbackProviderAllowlistFromPrefs\(this\.preferencesStore\)/);
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
