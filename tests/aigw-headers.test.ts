/**
 * Unit tests for the provider-level `headers` block emitted by
 * `writeAigwModelsJson()` in `src/server/agent/aigw-manager.ts`.
 *
 * Contract:
 *   1. The `aigw` provider entry contains `headers["x-opencode-session"]`
 *      equal to the documented `!node -e "..."` literal.
 *   2. `headers` lives at the provider level, not on individual model entries.
 *   3. Provider-level `headers` is emitted regardless of whether models are
 *      Claude (Bedrock) or non-Claude (openai-completions). Bedrock ignores
 *      `model.headers` in pi-ai 0.67.5 — provider-level is harmless there.
 *   4. `removeAigwModelsJson()` drops the entire `aigw` provider, leaving no
 *      orphan `headers` block on other providers.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;
const EXPECTED_USER_AGENT = `Bobbit/${JSON.parse(readFileSync(path.resolve("package.json"), "utf-8")).version}`;

let tmp: string;
let previousAgentDir: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-aigw-hdr-"));
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = tmp;
	mkdirSync(tmp, { recursive: true });
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const f = path.join(tmp, "models.json");
	if (existsSync(f)) rmSync(f);
});

const { writeAigwModelsJson, removeAigwModelsJson } = await import("../src/server/agent/aigw-manager.js");

function readModels(): any {
	const f = path.join(tmp, "models.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf-8"));
}

const NON_CLAUDE_MODEL = {
	id: "qwen3-coder",
	name: "Qwen 3 Coder",
	api: "openai-completions",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	contextWindow: 1_000_000,
	maxTokens: 32_768,
};

const CLAUDE_MODEL = {
	id: "aws/us.anthropic.claude-sonnet-4-5-v1:0",
	name: "Claude Sonnet 4.5 (aws)",
	api: "openai-completions",
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	contextWindow: 1_000_000,
	maxTokens: 16_384,
};

describe("writeAigwModelsJson — provider-level AI Gateway headers", () => {
	it("emits the documented header literals at provider level (non-Claude models)", () => {
		writeAigwModelsJson("https://aigw.example/v1", [NON_CLAUDE_MODEL]);
		const data = readModels();
		assert.ok(data?.providers?.aigw, "providers.aigw must exist");
		const aigw = data.providers.aigw;
		assert.ok(aigw.headers, "providers.aigw.headers must exist");
		assert.equal(
			aigw.headers["User-Agent"],
			EXPECTED_USER_AGENT,
			"User-Agent must use the current package version",
		);
		assert.equal(
			aigw.headers["x-opencode-session"],
			EXPECTED_HEADER_VALUE,
			"header value must match the documented `!node -e` literal exactly",
		);
	});

	it("does NOT add `headers` to any individual model entry", () => {
		writeAigwModelsJson("https://aigw.example/v1", [NON_CLAUDE_MODEL, CLAUDE_MODEL]);
		const data = readModels();
		const models = data.providers.aigw.models;
		assert.ok(Array.isArray(models) && models.length === 2);
		for (const m of models) {
			assert.equal(m.headers, undefined, `model ${m.id} must not carry a per-model headers field`);
		}
	});

	it("emits provider-level header even when only Claude (Bedrock-routed) models are present", () => {
		// Bedrock provider in pi-ai ignores model.headers, but `headers` lives at
		// the provider level — emitting it is harmless and keeps the provider
		// shape uniform regardless of which models the gateway exposes.
		writeAigwModelsJson("https://aigw.example/v1", [CLAUDE_MODEL]);
		const data = readModels();
		assert.equal(data.providers.aigw.headers["User-Agent"], EXPECTED_USER_AGENT);
		assert.equal(
			data.providers.aigw.headers["x-opencode-session"],
			EXPECTED_HEADER_VALUE,
		);
		// And the Claude model is routed through bedrock-converse-stream.
		const claudeEntry = data.providers.aigw.models[0];
		assert.equal(claudeEntry.api, "bedrock-converse-stream");
		assert.equal(claudeEntry.headers, undefined);
	});

	it("header literal JSON-encodes to the documented escaped form", () => {
		writeAigwModelsJson("https://aigw.example/v1", [NON_CLAUDE_MODEL]);
		const f = path.join(tmp, "models.json");
		const raw = readFileSync(f, "utf-8");
		// JSON-encoded literal as documented in the design doc:
		assert.ok(
			raw.includes(`"!node -e \\"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\\""`),
			"file must contain the exact escaped JSON form",
		);
	});

	it("removeAigwModelsJson() drops the aigw block entirely (no orphan headers anywhere)", () => {
		// Pre-seed an unrelated provider to confirm we don't touch it.
		const seeded = {
			providers: {
				anthropic: { apiKey: "sk-test", models: [{ id: "claude-x" }] },
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeAigwModelsJson("https://aigw.example/v1", [NON_CLAUDE_MODEL]);
		removeAigwModelsJson();
		const data = readModels();
		assert.equal(data.providers.aigw, undefined, "aigw provider must be gone");
		// anthropic provider untouched + has no AI Gateway header leak.
		assert.ok(data.providers.anthropic, "anthropic provider must survive");
		assert.equal(data.providers.anthropic.headers, undefined, "no orphan headers on other providers");
	});

	it("does not leak AI Gateway headers onto non-aigw providers when re-written", () => {
		// Seed an anthropic provider, then run aigw write. Confirm anthropic is
		// left alone — no AI Gateway headers synthesised on it.
		const seeded = {
			providers: {
				anthropic: {
					apiKey: "sk-test",
					headers: { "X-Existing": "keep-me" },
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeAigwModelsJson("https://aigw.example/v1", [NON_CLAUDE_MODEL]);
		const data = readModels();
		assert.deepEqual(data.providers.anthropic.headers, { "X-Existing": "keep-me" });
		assert.equal(data.providers.anthropic.headers["User-Agent"], undefined);
		assert.equal(data.providers.anthropic.headers["x-opencode-session"], undefined);
		assert.equal(data.providers.aigw.headers["User-Agent"], EXPECTED_USER_AGENT);
		assert.equal(
			data.providers.aigw.headers["x-opencode-session"],
			EXPECTED_HEADER_VALUE,
		);
	});
});
