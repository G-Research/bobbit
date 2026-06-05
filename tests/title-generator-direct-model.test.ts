import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { PreferencesStore } from "../src/server/agent/preferences-store.js";
import { invalidateModelCache, type ApiModel } from "../src/server/agent/model-registry.js";
import { generateSessionTitle } from "../src/server/agent/title-generator.js";
import { completeModelText, testModelPreference } from "../src/server/agent/model-completion.js";

const previousSkipTitleGen = process.env.BOBBIT_SKIP_TITLE_GEN;
const previousAgentDir = process.env.BOBBIT_AGENT_DIR;
const directModel: ApiModel = {
	id: "direct-title-model",
	name: "Direct Title Model",
	provider: "direct",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9/v1",
	contextWindow: 8192,
	maxTokens: 4096,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	authenticated: true,
};

afterEach(() => {
	if (previousSkipTitleGen === undefined) delete process.env.BOBBIT_SKIP_TITLE_GEN;
	else process.env.BOBBIT_SKIP_TITLE_GEN = previousSkipTitleGen;
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	invalidateModelCache();
});

function prefsWithManualProvider(): { prefs: PreferencesStore; dir: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-title-direct-"));
	const prefs = new PreferencesStore(dir);
	prefs.set("customProviders", [{
		id: "direct",
		name: "direct",
		type: "manual",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "sk-test",
		models: [{ id: "direct-title-model", name: "Direct Title Model" }],
	}]);
	return { prefs, dir };
}

describe("title generation with non-AI-Gateway naming models", () => {
	it("uses the configured direct naming model and forces thinking off", async () => {
		delete process.env.BOBBIT_SKIP_TITLE_GEN;
		const calls: any[] = [];
		const title = await generateSessionTitle(
			[{ role: "user", content: "Please fix the direct model title path." }],
			{
				namingModel: "direct/direct-title-model",
				thinkingLevel: "high",
				availableModels: [directModel],
				directModelCompleter: async (model, args) => {
					calls.push({ model, args });
					return "<title>Direct Works</title>";
				},
			},
		);
		assert.equal(title, "Direct Works");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model.provider, "direct");
		assert.equal(calls[0].model.id, "direct-title-model");
		assert.equal(calls[0].args.thinkingLevel, "off");
	});

	it("uses the session model as fallback when no naming model is set", async () => {
		delete process.env.BOBBIT_SKIP_TITLE_GEN;
		const calls: any[] = [];
		const title = await generateSessionTitle(
			[{ role: "user", content: "Please diagnose why automatic names stopped changing." }],
			{
				fallbackModel: "openai-codex/direct-title-model",
				availableModels: [{ ...directModel, provider: "openai-codex" }],
				directModelCompleter: async (model, args) => {
					calls.push({ model, args });
					return "<title>Rename Diagnosis</title>";
				},
			},
		);
		assert.equal(title, "Rename Diagnosis");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model.provider, "openai-codex");
		assert.equal(calls[0].args.thinkingLevel, "off");
	});

	it("model completions reuse OpenAI Codex OAuth credentials, matching chat auth", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "bobbit-title-auth-"));
		process.env.BOBBIT_AGENT_DIR = dir;
		writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "codex-oauth-token" } }));
		const calls: any[] = [];
		try {
			await completeModelText({ ...directModel, provider: "openai-codex", api: "openai-codex-responses" }, undefined, {
				systemPrompt: "test",
				userPrompt: "test",
			}, async (model, _context, options) => {
				calls.push({ model, options });
				return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
			});
			assert.equal(calls[0].options.apiKey, "codex-oauth-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("model test helper works for non-AI-Gateway models", async () => {
		const { prefs, dir } = prefsWithManualProvider();
		const calls: any[] = [];
		try {
			const result = await testModelPreference(prefs, "direct/direct-title-model", async (model, _prefs, args) => {
				calls.push({ model, args });
				return "OK";
			});
			assert.equal(result.ok, true);
			assert.equal(result.modelResolved, "direct-title-model");
			assert.equal(calls.length, 1);
			assert.equal(calls[0].model.provider, "direct");
			assert.equal(calls[0].model.id, "direct-title-model");
			assert.equal(calls[0].args.thinkingLevel, "off");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
