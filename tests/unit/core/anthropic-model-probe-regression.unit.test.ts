import { guardProcessEnv } from "./_helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { resetAgentDirStateForTests } from "../../../src/server/bobbit-dir.js";
import { completeModelText, testModelPreference, type ModelCompletionDependencies } from "../../../src/server/agent/model-completion.js";
import { modelProbeFailure, modelProbeFailureFromHttpStatus } from "../../../src/server/agent/model-probe-result.js";
import { PreferencesStore } from "../../../src/server/agent/preferences-store.js";
import { clearOAuthCache, getAvailableModels, invalidateModelCache, type ApiModel } from "../../../src/server/agent/model-registry.js";
import { createMemFs } from "../../support/harnesses/shared/mem-fs.js";

let agentDir: string | undefined;

function useAuth(auth: unknown): void {
	agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-probe-"));
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: auth }));
}

afterEach(() => {
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	resetAgentDirStateForTests();
	clearOAuthCache();
	invalidateModelCache();
});

function anthropicModel(id = "claude-opus-5"): ApiModel {
	return {
		id,
		name: id,
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		authenticated: true,
	};
}

// These synthetic outcomes preserve the two current evidence models alongside
// the established pre-5 Opus control; they do not claim live OAuth entitlement.
const CURRENT_ANTHROPIC_PROBE_MATRIX = [
	{ id: "claude-opus-5", status: 404 as const, code: "model_not_found" },
	{ id: "claude-sonnet-5", status: 429 as const, code: "rate_limited" },
	{ id: "claude-opus-4-6", status: 401 as const, code: "authentication_failed" },
] as const;

describe("Anthropic model probe regressions", () => {
	it("preserves API-key authentication selection for direct Pi model completions", async () => {
		useAuth({ type: "api-key", key: "test-anthropic-api-key" });
		const calls: any[] = [];
		const dependencies: ModelCompletionDependencies = {
			env: {},
			providerConfigReader: () => undefined,
		};

		const result = await completeModelText(
			anthropicModel(),
			undefined,
			{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
			async (_model, _context, options) => {
				calls.push(options);
				return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
			},
			dependencies,
		);

		assert.equal(result, "OK");
		assert.deepEqual(calls, [{ maxTokens: 5, timeoutMs: 30_000, maxRetries: 0, cacheRetention: "none", apiKey: "test-anthropic-api-key" }]);
	});

	it("never marks the Anthropic catalog authenticated for partial OAuth rows while preserving API-key auth", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		useAuth({ type: "oauth", access: randomUUID(), expires: Date.now() + 60_000 });
		const prefs = new PreferencesStore("/memfs/anthropic-partial-catalog", createMemFs());

		for (const credential of [
			{ type: "oauth", access: randomUUID(), expires: Date.now() + 60_000 },
			{ type: "oauth", access: randomUUID(), refresh: randomUUID() },
		]) {
			writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({ anthropic: credential }));
			clearOAuthCache();
			invalidateModelCache();
			const anthropic = (await getAvailableModels(prefs)).filter(model => model.provider === "anthropic");
			assert.ok(anthropic.length > 0, "fixture requires the Pi Anthropic catalog");
			assert.equal(anthropic.every(model => model.authenticated === false), true);
		}

		writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({ anthropic: { type: "api-key", key: "test-anthropic-api-key" } }));
		clearOAuthCache();
		invalidateModelCache();
		const anthropic = (await getAvailableModels(prefs)).filter(model => model.provider === "anthropic");
		assert.equal(anthropic.every(model => model.authenticated === true), true);
	});

	it.each([
		["access-only", () => ({ type: "oauth", access: randomUUID() })],
		["missing refresh", () => ({ type: "oauth", access: randomUUID(), expires: Date.now() + 60_000 })],
		["missing expiry", () => ({ type: "oauth", access: randomUUID(), refresh: randomUUID() })],
	])("rejects a %s Anthropic OAuth row before refresh or model completion", async (_name, createCredential) => {
		const credential = createCredential();
		useAuth(credential);
		let requests = 0;
		let refreshes = 0;

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => {
					requests++;
					return { role: "assistant", content: [{ type: "text", text: "unexpected" }], stopReason: "stop" } as any;
				},
				{
					env: {},
					providerConfigReader: () => undefined,
					anthropicOAuthTokenResolver: async () => {
						refreshes++;
						return randomUUID();
					},
				},
			),
			/Anthropic OAuth credential could not be resolved/,
		);

		assert.equal(refreshes, 0, "a partial OAuth row must not enter Pi refresh");
		assert.equal(requests, 0, "a partial OAuth access value must not reach Pi completion");
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")), { anthropic: credential });
	});

	it("does not send an expired OAuth access value when Pi refresh temporarily cannot resolve it", async () => {
		const access = randomUUID();
		const credential = { type: "oauth", access, refresh: randomUUID(), expires: Date.now() - 60_000 };
		useAuth(credential);
		let requests = 0;

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => {
					requests++;
					return { role: "assistant", content: [{ type: "text", text: "unexpected" }], stopReason: "stop" } as any;
				},
				{
					env: {},
					providerConfigReader: () => undefined,
					anthropicOAuthTokenResolver: async () => null,
				},
			),
			/Anthropic OAuth credential could not be resolved/,
		);

		assert.equal(requests, 0, "the stale access value must not reach Pi");
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")), { anthropic: credential });
	});

	it("replaces only the rejected OAuth row with a non-secret Pi-unresolvable tombstone", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => {
					// Current Pi Anthropic Messages errors lead with the SDK status.
					throw new Error("401 Unauthorized: credential rejected");
				},
				{ env: {}, providerConfigReader: () => undefined },
			),
		);

		const stored = JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8"));
		assert.deepEqual(Object.keys(stored), ["anthropic"]);
		assert.deepEqual(Object.keys(stored.anthropic).sort(), ["rejected", "type", "version"]);
		assert.equal(stored.anthropic.type, "oauth_rejected");
		assert.equal(stored.anthropic.version, 1);
		assert.match(stored.anthropic.rejected, /^[a-f0-9]{64}$/i, "the tombstone retains only a one-way rejection fingerprint");
		assert.equal("access" in stored.anthropic, false, "the rejected bearer must not survive");
		assert.equal("refresh" in stored.anthropic, false, "the renewable credential must not survive");
	});

	it.each([
		["saved", (prefs: PreferencesStore) => prefs.set("providerKey.anthropic", "saved-api-key"), {}, "saved-api-key"],
		["ambient", (_prefs: PreferencesStore) => {}, { ANTHROPIC_API_KEY: "ambient-api-key" }, "ambient-api-key"],
	])("uses a %s API key after an OAuth tombstone", async (_source, configure, env, expectedKey) => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });
		await assert.rejects(() => completeModelText(
			anthropicModel(),
			undefined,
			{ systemPrompt: "system", userPrompt: "reject", maxTokens: 5, thinkingLevel: "off" },
			async () => { throw new Error("401 Unauthorized: credential rejected"); },
			{ env: {}, providerConfigReader: () => undefined },
		));

		const prefs = new PreferencesStore(`/memfs/anthropic-tombstone-${randomUUID()}`, createMemFs());
		configure(prefs);
		const calls: any[] = [];
		assert.equal(await completeModelText(
			anthropicModel(),
			prefs,
			{ systemPrompt: "system", userPrompt: "recover", maxTokens: 5, thinkingLevel: "off" },
			async (_model, _context, options) => {
				calls.push(options);
				return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
			},
			{ env, providerConfigReader: () => undefined },
		), "OK");
		assert.equal(calls[0]?.apiKey, expectedKey);
	});

	it("does not remove a newer OAuth credential after an in-flight completion rejection", async () => {
		const access = randomUUID();
		const replacement = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => {
					writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({
						anthropic: { type: "oauth", access: replacement, refresh: randomUUID(), expires: Date.now() + 60_000 },
					}));
					throw new Error("HTTP request failed. status=401; url=https://api.anthropic.com/v1/messages; body=ignored");
				},
				{ env: {}, providerConfigReader: () => undefined },
			),
		);
		assert.equal(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")).anthropic.access, replacement);
	});

	it("retains API-key authentication after a rejection", async () => {
		const key = randomUUID();
		useAuth({ type: "api-key", key });

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => { throw new Error("HTTP request failed. status=403; url=https://api.anthropic.com/v1/messages; body=ignored"); },
				{ env: {}, providerConfigReader: () => undefined },
			),
		);
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")), {
			anthropic: { type: "api-key", key },
		});
	});

	it("retains the OAuth credential when a model-test completion receives a resource 403", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });
		const prefs = new PreferencesStore(path.resolve("/memfs/anthropic-model-test"), createMemFs());

		const result = await testModelPreference(prefs, "anthropic/claude-opus-5", (model, selectedPrefs, args) =>
			completeModelText(
				model,
				selectedPrefs,
				args,
				async () => ({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "403 Forbidden: credential rejected",
				}) as any,
				{ env: {}, providerConfigReader: () => undefined },
			),
		);
		assert.deepEqual({ ok: result.ok, status: result.status, code: (result as any).code }, {
			ok: false,
			status: 403,
			code: "authentication_failed",
		});
		assert.equal(
			JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")).anthropic.access,
			access,
			"only a 401 can invalidate the OAuth credential",
		);
	});

	it("keeps provider failures model-specific", async () => {
		const prefs = new PreferencesStore(path.resolve("/memfs/anthropic-model-probe"), createMemFs());
		for (const expected of CURRENT_ANTHROPIC_PROBE_MATRIX) {
			let calledModel: string | undefined;
			const result = await testModelPreference(prefs, `anthropic/${expected.id}`, async (model) => {
				calledModel = model.id;
				throw new Error(`HTTP request failed. status=${expected.status}; url=https://api.anthropic.com/v1/messages; body=ignored`);
			});
			const probe = result as typeof result & { code?: string };
			assert.equal(calledModel, expected.id, "Pi completion must receive the exact selected model");
			assert.deepEqual(
				{ status: probe.status, code: probe.code, modelResolved: probe.modelResolved },
				{ status: expected.status, code: expected.code, modelResolved: expected.id },
			);
		}
	});

	it("keeps model-not-found, authentication, and rate-limit probe outcomes distinct and redacted", () => {
		const sentinel = `upstream-secret-${"z".repeat(48)}`;
		const cases: Array<{ status: 401 | 403 | 404 | 429; code: string }> = [
			{ status: 404, code: "model_not_found" },
			{ status: 401, code: "authentication_failed" },
			{ status: 403, code: "authentication_failed" },
			{ status: 429, code: "rate_limited" },
		];

		for (const { status, code } of cases) {
			const error = new Error(`HTTP request failed. status=${status}; url=https://api.anthropic.com/v1/messages; body=Authorization: Bearer ${sentinel}`);
			const result = modelProbeFailure(error, { modelResolved: "claude-opus-5", latencyMs: 12 });
			assert.deepEqual({ status: result.status, code: result.code }, { status, code });
			assert.equal(result.ok, false);
			assert.equal(result.modelResolved, "claude-opus-5");
			assert.equal(result.error.includes(sentinel), false, `HTTP ${status} must redact provider payload secrets`);
			assert.match(result.error, /<redacted-token>/);
		}
	});

	it("recognizes current and legacy trusted Pi status prefixes without classifying provider-body numerals", () => {
		const current = new Error("401 Unauthorized: provider body said 404");
		assert.deepEqual({ status: modelProbeFailure(current).status, code: modelProbeFailure(current).code }, {
			status: 401,
			code: "authentication_failed",
		});

		const legacyEnvelope = new Error("HTTP request failed. status=404; url=https://api.anthropic.com/v1/messages; body=provider said 401");
		assert.deepEqual({ status: modelProbeFailure(legacyEnvelope).status, code: modelProbeFailure(legacyEnvelope).code }, {
			status: 404,
			code: "model_not_found",
		});

		const providerBodyOnly = new Error("Provider response: retry after HTTP 401");
		assert.deepEqual(
			{ status: modelProbeFailure(providerBodyOnly).status, code: modelProbeFailure(providerBodyOnly).code },
			{ status: undefined, code: undefined },
		);
	});

	it("maps directly observed gateway response statuses without parsing their bodies", () => {
		const cases: Array<{ status: 401 | 403 | 404 | 429; code: string }> = [
			{ status: 401, code: "authentication_failed" },
			{ status: 403, code: "authentication_failed" },
			{ status: 404, code: "model_not_found" },
			{ status: 429, code: "rate_limited" },
		];
		for (const { status, code } of cases) {
			const result = modelProbeFailureFromHttpStatus(status, { modelResolved: "gateway-model", latencyMs: 12 });
			assert.deepEqual(result, {
				ok: false,
				modelResolved: "gateway-model",
				latencyMs: 12,
				error: `Gateway returned HTTP ${status}`,
				status,
				code,
			});
		}
	});
});
