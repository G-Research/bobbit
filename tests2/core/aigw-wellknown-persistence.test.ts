// v2-native — NOT a migrated legacy test. Discovered from its `tests2/core` path.
// AIGW models.json persistence and conservative ID migration coverage.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	GATEWAY, loadFixture, normalizeAigwModelString, removeAigwModelsJson, resetAgentDirStateForTests,
	translateWellKnown, writeAigwModelsJson,
} from "./helpers/aigw-wellknown-test-helpers.js";

describe("writeAigwModelsJson — authoritative per-model api/baseUrl", () => {
	let tmpAgentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		prevAgentDir = process.env.BOBBIT_AGENT_DIR;
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-wk-models-"));
		process.env.BOBBIT_AGENT_DIR = tmpAgentDir;
		resetAgentDirStateForTests();
	});
	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("emits per-model api/baseUrl for well-known models and never sends reasoning_effort+tools on a forbidden completions model", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		writeAigwModelsJson(`${GATEWAY}/v1`, models);
		const data = JSON.parse(fs.readFileSync(path.join(tmpAgentDir, "models.json"), "utf-8"));
		const entries: any[] = data.providers.aigw.models;

		const sol = entries.find((m) => m.id === "gpt-5.6-sol");
		assert.ok(sol, "expected gpt-5.6-sol entry with bare id");
		assert.equal(sol.api, "openai-responses");
		assert.equal(sol.upstreamProvider, "openai");
		assert.equal(sol.baseUrl, "http://aigw-local.t3.zone/openai/v1");

		const claude = entries.find((m) => m.id === "us.anthropic.claude-opus-4-6");
		assert.equal(claude.api, "bedrock-converse-stream");
		assert.equal(claude.baseUrl, "http://aigw-local.t3.zone/aws");

		const qwen = entries.find((m) => m.id === "qwen3-coder-480b-a35b");
		assert.equal(qwen.api, "openai-completions");
		assert.equal(qwen.baseUrl, "http://aigw-local.t3.zone/gresearch/v1");

		// The forbidden combo (reasoning_effort + tools on plain chat/completions)
		// cannot occur: every gpt-5.6 model routes to openai-responses, never
		// openai-completions.
		const forbidden = entries.filter((m) => m.id.startsWith("gpt-5.6") && m.api === "openai-completions");
		assert.deepEqual(forbidden, [], "gpt-5.6 models must never be routed to openai-completions");
	});

	it("normalizes legacy AIGW provider-prefixed ids when the bare well-known id exists", () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		writeAigwModelsJson(`${GATEWAY}/v1`, models);

		assert.equal(normalizeAigwModelString("aigw/openai/gpt-5.6-sol"), "aigw/gpt-5.6-sol");
		assert.equal(normalizeAigwModelString("aigw/aws-mantle/gpt-oss-120b"), "aigw/gpt-oss-120b");
		assert.equal(normalizeAigwModelString("aigw/unknown/gpt-5.6-sol"), "aigw/gpt-5.6-sol");
		assert.equal(normalizeAigwModelString("aigw/gresearch/not-present"), "aigw/gresearch/not-present");
		assert.equal(normalizeAigwModelString("aigw/unknown/multi/segment"), "aigw/unknown/multi/segment");
	});

	it("preserves legacy prefixes while an old models file has duplicate bare ids", () => {
		fs.writeFileSync(path.join(tmpAgentDir, "models.json"), JSON.stringify({ providers: { aigw: { models: [
			{ id: "shared", upstreamProvider: "first" },
			{ id: "shared", upstreamProvider: "second" },
		] } } }));
		assert.equal(normalizeAigwModelString("aigw/first/shared"), "aigw/first/shared");
	});

	it("adds a forward-only marker and Pi 0.84.1 ignores it while loading the model", async () => {
		const models = translateWellKnown(loadFixture(), GATEWAY);
		writeAigwModelsJson(`${GATEWAY}/v1`, models);
		const modelsPath = path.join(tmpAgentDir, "models.json");
		const data = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		assert.deepEqual(data.providers.aigw["x-bobbit-managed"], {
			kind: "aigw-publication", version: 1,
		});

		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: path.join(tmpAgentDir, "auth.json"),
			allowModelNetwork: false,
		});
		assert.equal(runtime.getError(), undefined);
		const loaded = runtime.getModel("aigw", "gpt-5.6-sol");
		assert.ok(loaded, "Pi must load models from a provider carrying the marker");
		assert.equal(loaded.contextWindow, 272_000);
	});

	it("refreshes only managed fields in marked JSONC and preserves comments and unknown fields", () => {
		const modelsPath = path.join(tmpAgentDir, "models.json");
		const original = `{
  // user root comment
  "unknownRoot": { "keep": true },
  "providers": {
    "anthropic": { "apiKey": "user-secret" },
    "aigw": {
      // keep provider comment
      "x-bobbit-managed": { "kind": "aigw-publication", "version": 1 },
      "baseUrl": "https://old.invalid/v1",
      "apiKey": "none",
      "api": "openai-completions",
      "headers": { "X-User": "keep" },
      "models": [],
      "unknownProviderField": { "keep": true }
    }
  },
  "modelOverrides": { "user": true }
}
`;
		fs.writeFileSync(modelsPath, original);
		writeAigwModelsJson(`${GATEWAY}/v1`, translateWellKnown(loadFixture(), GATEWAY));
		const refreshed = fs.readFileSync(modelsPath, "utf-8");
		for (const preserved of [
			"// user root comment",
			"// keep provider comment",
			'"unknownRoot": { "keep": true }',
			'"anthropic": { "apiKey": "user-secret" }',
			'"X-User": "keep"',
			'"unknownProviderField": { "keep": true }',
			'"modelOverrides": { "user": true }',
		]) assert.ok(refreshed.includes(preserved), `expected byte-preserved fragment: ${preserved}`);
		const parsed = JSON.parse(refreshed.replace(/^\s*\/\/.*$/gm, ""));
		assert.equal(parsed.providers.aigw.baseUrl, `${GATEWAY}/v1`);
		assert.ok(parsed.providers.aigw.models.length > 0);
	});

	it("fails closed and leaves unmarked, malformed, and ambiguous documents byte-identical", () => {
		const modelsPath = path.join(tmpAgentDir, "models.json");
		const fixtures = [
			'{"providers":{"aigw":{"baseUrl":"https://user.invalid","models":[]}},"unknown":true}',
			'{ "providers": { /* malformed */ ',
			'{"providers":{},"providers":{"other":{}}}',
			'{"providers":{"aigw":{},"aigw":{"models":[]}}}',
			'{"providers":{"aigw":{"x-bobbit-managed":{"kind":"aigw-publication","version":1},"baseUrl":"one","baseUrl":"two"}}}',
		];
		for (const fixture of fixtures) {
			fs.writeFileSync(modelsPath, fixture);
			assert.throws(
				() => writeAigwModelsJson(`${GATEWAY}/v1`, translateWellKnown(loadFixture(), GATEWAY)),
				/refusing|user-owned|duplicate|malformed/,
			);
			assert.equal(fs.readFileSync(modelsPath, "utf-8"), fixture);
		}
	});

	it("removes only a marked generated provider and never removes an unmarked user provider", () => {
		const modelsPath = path.join(tmpAgentDir, "models.json");
		const unmarked = '{"providers":{"aigw":{"baseUrl":"https://user.invalid","models":[]}},"keep":true}';
		fs.writeFileSync(modelsPath, unmarked);
		removeAigwModelsJson();
		assert.equal(fs.readFileSync(modelsPath, "utf-8"), unmarked);

		fs.rmSync(modelsPath);
		writeAigwModelsJson(`${GATEWAY}/v1`, translateWellKnown(loadFixture(), GATEWAY));
		removeAigwModelsJson();
		const removed = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		assert.equal(removed.providers.aigw, undefined);
	});

});
