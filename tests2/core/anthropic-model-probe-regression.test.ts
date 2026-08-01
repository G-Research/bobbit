import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { completeModelText, testModelPreference, type ModelCompletionDependencies } from "../../src/server/agent/model-completion.js";
import { modelProbeFailure } from "../../src/server/agent/model-probe-result.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import type { ApiModel } from "../../src/server/agent/model-registry.js";
import { createMemFs } from "../harness/mem-fs.js";

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

	it("clears only the matching persisted OAuth credential after a definitive primary completion rejection", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });

		await assert.rejects(
			() => completeModelText(
				anthropicModel(),
				undefined,
				{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
				async () => {
					throw new Error("HTTP request failed. status=401; url=https://api.anthropic.com/v1/messages; body=ignored");
				},
				{ env: {}, providerConfigReader: () => undefined },
			),
		);
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")), {});
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

	it("clears the OAuth credential when the model-test completion receives a definitive rejection", async () => {
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
					errorMessage: "HTTP request failed. status=403; url=https://api.anthropic.com/v1/messages; body=ignored",
				}) as any,
				{ env: {}, providerConfigReader: () => undefined },
			),
		);
		assert.deepEqual({ ok: result.ok, status: result.status, code: (result as any).code }, {
			ok: false,
			status: 403,
			code: "authentication_failed",
		});
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir!, "auth.json"), "utf-8")), {});
	});

	it("keeps mocked Pi provider-path failures model-specific across the current three-model matrix", async () => {
		const prefs = new PreferencesStore(path.resolve("/memfs/anthropic-model-probe"), createMemFs());
		const matrix = [
			{ id: "claude-opus-5", status: 404 as const, code: "model_not_found" },
			{ id: "claude-sonnet-5", status: 401 as const, code: "authentication_failed" },
			{ id: "claude-fable-5", status: 429 as const, code: "rate_limited" },
		];

		for (const expected of matrix) {
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

	it("recognizes only trusted Pi envelopes without classifying provider-body numerals", () => {
		const envelope = new Error("HTTP request failed. status=404; url=https://api.anthropic.com/v1/messages; body=provider said 401");
		assert.deepEqual({ status: modelProbeFailure(envelope).status, code: modelProbeFailure(envelope).code }, {
			status: 404,
			code: "model_not_found",
		});

		const untracked = new Error("HTTP request failed. status=500; url=https://api.anthropic.com/v1/messages; body=retry after HTTP 401");
		assert.deepEqual(
			{ status: modelProbeFailure(untracked).status, code: modelProbeFailure(untracked).code },
			{ status: undefined, code: undefined },
		);
	});
});
