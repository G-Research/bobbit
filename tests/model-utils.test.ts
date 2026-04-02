/**
 * Unit tests for inferMeta() and modelRecencyRank().
 *
 * These import from the built dist/ modules (compiled by npm run build:server
 * before tests run). No server needed — pure function tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferMeta } from "../dist/server/agent/aigw-manager.js";
import { modelRecencyRank } from "../dist/server/agent/model-registry.js";

// ── inferMeta tests ────────────────────────────────────────────────

describe("inferMeta()", () => {
	it("Claude Opus → 1M context, 32K max, reasoning=true", () => {
		const meta = inferMeta("claude-opus-4-6");
		assert.equal(meta.contextWindow, 1_000_000);
		assert.equal(meta.maxTokens, 32_768);
		assert.equal(meta.reasoning, true);
		assert.ok(meta.input!.includes("image"));
	});

	it("Claude Opus (Bedrock style) → 1M context", () => {
		const meta = inferMeta("us.anthropic.claude-opus-4-5-v1:0");
		assert.equal(meta.contextWindow, 1_000_000);
		assert.equal(meta.maxTokens, 32_768);
		assert.equal(meta.reasoning, true);
	});

	it("Claude Sonnet → 1M context, 16K max, reasoning=true", () => {
		const meta = inferMeta("claude-sonnet-4-6");
		assert.equal(meta.contextWindow, 1_000_000);
		assert.equal(meta.maxTokens, 16_384);
		assert.equal(meta.reasoning, true);
		assert.ok(meta.input!.includes("image"));
	});

	it("Claude Sonnet 4.5 → 1M context", () => {
		const meta = inferMeta("claude-sonnet-4-5-20250929");
		assert.equal(meta.contextWindow, 1_000_000);
		assert.equal(meta.reasoning, true);
	});

	it("Claude Haiku → 200K context, reasoning=false", () => {
		const meta = inferMeta("claude-haiku-4-5");
		assert.equal(meta.contextWindow, 200_000);
		assert.equal(meta.maxTokens, 8_192);
		assert.equal(meta.reasoning, false);
		assert.ok(meta.input!.includes("image"));
	});

	it("generic Claude model → 200K context", () => {
		const meta = inferMeta("claude-3-5-turbo");
		assert.equal(meta.contextWindow, 200_000);
		assert.equal(meta.reasoning, false);
	});

	it("GPT-5 → 400K context", () => {
		const meta = inferMeta("gpt-5");
		assert.equal(meta.contextWindow, 400_000);
		assert.equal(meta.maxTokens, 32_768);
		assert.ok(meta.input!.includes("image"));
	});

	it("GPT-5.2 → 400K context", () => {
		const meta = inferMeta("openai/gpt-5.2");
		assert.equal(meta.contextWindow, 400_000);
	});

	it("o4-mini → 200K context, reasoning=true", () => {
		const meta = inferMeta("o4-mini");
		assert.equal(meta.contextWindow, 200_000);
		assert.equal(meta.maxTokens, 65_536);
		assert.equal(meta.reasoning, true);
	});

	it("o3 → 200K context, reasoning=true", () => {
		const meta = inferMeta("o3");
		assert.equal(meta.contextWindow, 200_000);
		assert.equal(meta.reasoning, true);
		assert.ok(meta.input!.includes("image"));
	});

	it("o3-mini → 200K context, reasoning=true", () => {
		const meta = inferMeta("o3-mini");
		assert.equal(meta.contextWindow, 200_000);
		assert.equal(meta.maxTokens, 65_536);
		assert.equal(meta.reasoning, true);
	});

	it("GPT-4o → 128K context", () => {
		const meta = inferMeta("gpt-4o");
		assert.equal(meta.contextWindow, 128_000);
		assert.equal(meta.reasoning, false);
	});

	it("Qwen → 1M context", () => {
		const meta = inferMeta("qwen3-coder-480b");
		assert.equal(meta.contextWindow, 1_000_000);
		assert.equal(meta.maxTokens, 32_768);
	});

	it("Qwen (prefixed) → 1M context", () => {
		const meta = inferMeta("gresearch/qwen3-coder-480b-a35b");
		assert.equal(meta.contextWindow, 1_000_000);
	});

	it("Unknown model → 128K default context", () => {
		const meta = inferMeta("totally-unknown-model-xyz");
		assert.equal(meta.contextWindow, 128_000);
		assert.equal(meta.maxTokens, 16_384);
		assert.equal(meta.reasoning, false);
	});

	it("all results include compat flags", () => {
		const models = [
			"claude-opus-4-6", "claude-sonnet-4-5", "gpt-5", "o4-mini",
			"qwen3-coder", "unknown-model",
		];
		for (const id of models) {
			const meta = inferMeta(id);
			assert.ok(meta.compat !== undefined, `${id} should have compat`);
			assert.equal(meta.compat!.supportsStore, false);
		}
	});
});

// ── modelRecencyRank tests ─────────────────────────────────────────

describe("modelRecencyRank()", () => {
	it("Claude: opus-4-6 > sonnet-4-6 > opus-4-5", () => {
		const opus46 = modelRecencyRank("claude-opus-4-6");
		const sonnet46 = modelRecencyRank("claude-sonnet-4-6");
		const opus45 = modelRecencyRank("claude-opus-4-5");
		assert.ok(opus46 > sonnet46);
		assert.ok(sonnet46 > opus45);
	});

	it("Claude: sonnet-4-5 > sonnet-4 > haiku-4-5", () => {
		const sonnet45 = modelRecencyRank("claude-sonnet-4-5");
		const sonnet4 = modelRecencyRank("claude-sonnet-4");
		const haiku45 = modelRecencyRank("claude-haiku-4-5");
		assert.ok(sonnet45 > sonnet4);
		assert.ok(sonnet4 > haiku45);
	});

	it("OpenAI: gpt-5.4 > gpt-5.3 > gpt-5", () => {
		const gpt54 = modelRecencyRank("gpt-5.4");
		const gpt53 = modelRecencyRank("gpt-5.3");
		const gpt5 = modelRecencyRank("gpt-5");
		assert.ok(gpt54 > gpt53);
		assert.ok(gpt53 > gpt5);
	});

	it("OpenAI: o4-mini ranks highly", () => {
		const o4mini = modelRecencyRank("o4-mini");
		const gpt4o = modelRecencyRank("gpt-4o");
		assert.ok(o4mini > gpt4o);
	});

	it("Gemini: 3.1-pro > 2.5-pro > generic gemini", () => {
		const g31 = modelRecencyRank("gemini-3.1-pro");
		const g25 = modelRecencyRank("gemini-2.5-pro");
		const generic = modelRecencyRank("gemini-1.5-flash");
		assert.ok(g31 > g25);
		assert.ok(g25 > generic);
	});

	it("Grok: grok-4 > grok-3 > generic grok", () => {
		const g4 = modelRecencyRank("grok-4");
		const g3 = modelRecencyRank("grok-3");
		const generic = modelRecencyRank("grok-2");
		assert.ok(g4 > g3);
		assert.ok(g3 > generic);
	});

	it("DeepSeek: r1 > v3 > generic", () => {
		const r1 = modelRecencyRank("deepseek-r1");
		const v3 = modelRecencyRank("deepseek-v3");
		const generic = modelRecencyRank("deepseek-chat");
		assert.ok(r1 > v3);
		assert.ok(v3 > generic);
	});

	it("Qwen: qwen3-coder > qwen3 > generic qwen", () => {
		const coder = modelRecencyRank("qwen3-coder");
		const q3 = modelRecencyRank("qwen3");
		const generic = modelRecencyRank("qwen2");
		assert.ok(coder > q3);
		assert.ok(q3 > generic);
	});

	it("Mistral: devstral > codestral > generic mistral", () => {
		const dev = modelRecencyRank("devstral");
		const code = modelRecencyRank("codestral");
		const generic = modelRecencyRank("mistral-large");
		assert.ok(dev > code);
		assert.ok(code > generic);
	});

	it("Llama: llama-4 > generic llama", () => {
		const l4 = modelRecencyRank("llama-4");
		const generic = modelRecencyRank("llama-3.1-70b");
		assert.ok(l4 > generic);
	});

	it("unknown model returns 0", () => {
		assert.equal(modelRecencyRank("totally-unknown-model"), 0);
	});

	it("case-insensitive matching", () => {
		assert.equal(modelRecencyRank("Claude-Opus-4-6"), modelRecencyRank("claude-opus-4-6"));
		assert.equal(modelRecencyRank("GPT-5.4"), modelRecencyRank("gpt-5.4"));
	});
});
