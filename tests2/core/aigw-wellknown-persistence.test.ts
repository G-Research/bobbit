// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// AIGW models.json persistence and conservative ID migration coverage.

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	GATEWAY, loadFixture, normalizeAigwModelString, resetAgentDirStateForTests,
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

});
