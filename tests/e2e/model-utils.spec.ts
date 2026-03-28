/**
 * Unit-style tests for inferMeta() and modelRecencyRank().
 *
 * These import from the built dist/ modules (compiled by npm run build:server
 * before E2E tests run). No server needed — pure function tests.
 */

import { test, expect } from "@playwright/test";
import { inferMeta } from "../../dist/server/agent/aigw-manager.js";
import { modelRecencyRank } from "../../dist/server/agent/model-registry.js";

// ── inferMeta tests ────────────────────────────────────────────────

test.describe("inferMeta()", () => {
	test("Claude Opus → 1M context, 32K max, reasoning=true", () => {
		const meta = inferMeta("claude-opus-4-6");
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.maxTokens).toBe(32_768);
		expect(meta.reasoning).toBe(true);
		expect(meta.input).toContain("image");
	});

	test("Claude Opus (Bedrock style) → 1M context", () => {
		const meta = inferMeta("us.anthropic.claude-opus-4-5-v1:0");
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.maxTokens).toBe(32_768);
		expect(meta.reasoning).toBe(true);
	});

	test("Claude Sonnet → 1M context, 16K max, reasoning=true", () => {
		const meta = inferMeta("claude-sonnet-4-6");
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.maxTokens).toBe(16_384);
		expect(meta.reasoning).toBe(true);
		expect(meta.input).toContain("image");
	});

	test("Claude Sonnet 4.5 → 1M context", () => {
		const meta = inferMeta("claude-sonnet-4-5-20250929");
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.reasoning).toBe(true);
	});

	test("Claude Haiku → 200K context, reasoning=false", () => {
		const meta = inferMeta("claude-haiku-4-5");
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.maxTokens).toBe(8_192);
		expect(meta.reasoning).toBe(false);
		expect(meta.input).toContain("image");
	});

	test("generic Claude model → 200K context", () => {
		const meta = inferMeta("claude-3-5-turbo");
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.reasoning).toBe(false);
	});

	test("GPT-5 → 400K context", () => {
		const meta = inferMeta("gpt-5");
		expect(meta.contextWindow).toBe(400_000);
		expect(meta.maxTokens).toBe(32_768);
		expect(meta.input).toContain("image");
	});

	test("GPT-5.2 → 400K context", () => {
		const meta = inferMeta("openai/gpt-5.2");
		expect(meta.contextWindow).toBe(400_000);
	});

	test("o4-mini → 200K context, reasoning=true", () => {
		const meta = inferMeta("o4-mini");
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.maxTokens).toBe(65_536);
		expect(meta.reasoning).toBe(true);
	});

	test("o3 → 200K context, reasoning=true", () => {
		const meta = inferMeta("o3");
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.reasoning).toBe(true);
		expect(meta.input).toContain("image");
	});

	test("o3-mini → 200K context, reasoning=true", () => {
		const meta = inferMeta("o3-mini");
		expect(meta.contextWindow).toBe(200_000);
		expect(meta.maxTokens).toBe(65_536);
		expect(meta.reasoning).toBe(true);
	});

	test("GPT-4o → 128K context", () => {
		const meta = inferMeta("gpt-4o");
		expect(meta.contextWindow).toBe(128_000);
		expect(meta.reasoning).toBe(false);
	});

	test("Qwen → 1M context", () => {
		const meta = inferMeta("qwen3-coder-480b");
		expect(meta.contextWindow).toBe(1_000_000);
		expect(meta.maxTokens).toBe(32_768);
	});

	test("Qwen (prefixed) → 1M context", () => {
		const meta = inferMeta("gresearch/qwen3-coder-480b-a35b");
		expect(meta.contextWindow).toBe(1_000_000);
	});

	test("Unknown model → 128K default context", () => {
		const meta = inferMeta("totally-unknown-model-xyz");
		expect(meta.contextWindow).toBe(128_000);
		expect(meta.maxTokens).toBe(16_384);
		expect(meta.reasoning).toBe(false);
	});

	test("all results include compat flags", () => {
		const models = [
			"claude-opus-4-6", "claude-sonnet-4-5", "gpt-5", "o4-mini",
			"qwen3-coder", "unknown-model",
		];
		for (const id of models) {
			const meta = inferMeta(id);
			expect(meta.compat).toBeDefined();
			expect(meta.compat!.supportsStore).toBe(false);
		}
	});
});

// ── modelRecencyRank tests ─────────────────────────────────────────

test.describe("modelRecencyRank()", () => {
	test("Claude: opus-4-6 > sonnet-4-6 > opus-4-5", () => {
		const opus46 = modelRecencyRank("claude-opus-4-6");
		const sonnet46 = modelRecencyRank("claude-sonnet-4-6");
		const opus45 = modelRecencyRank("claude-opus-4-5");
		expect(opus46).toBeGreaterThan(sonnet46);
		expect(sonnet46).toBeGreaterThan(opus45);
	});

	test("Claude: sonnet-4-5 > sonnet-4 > haiku-4-5", () => {
		const sonnet45 = modelRecencyRank("claude-sonnet-4-5");
		const sonnet4 = modelRecencyRank("claude-sonnet-4");
		const haiku45 = modelRecencyRank("claude-haiku-4-5");
		expect(sonnet45).toBeGreaterThan(sonnet4);
		expect(sonnet4).toBeGreaterThan(haiku45);
	});

	test("OpenAI: gpt-5.4 > gpt-5.3 > gpt-5", () => {
		const gpt54 = modelRecencyRank("gpt-5.4");
		const gpt53 = modelRecencyRank("gpt-5.3");
		const gpt5 = modelRecencyRank("gpt-5");
		expect(gpt54).toBeGreaterThan(gpt53);
		expect(gpt53).toBeGreaterThan(gpt5);
	});

	test("OpenAI: o4-mini ranks highly", () => {
		const o4mini = modelRecencyRank("o4-mini");
		const gpt4o = modelRecencyRank("gpt-4o");
		expect(o4mini).toBeGreaterThan(gpt4o);
	});

	test("Gemini: 3.1-pro > 2.5-pro > generic gemini", () => {
		const g31 = modelRecencyRank("gemini-3.1-pro");
		const g25 = modelRecencyRank("gemini-2.5-pro");
		const generic = modelRecencyRank("gemini-1.5-flash");
		expect(g31).toBeGreaterThan(g25);
		expect(g25).toBeGreaterThan(generic);
	});

	test("Grok: grok-4 > grok-3 > generic grok", () => {
		const g4 = modelRecencyRank("grok-4");
		const g3 = modelRecencyRank("grok-3");
		const generic = modelRecencyRank("grok-2");
		expect(g4).toBeGreaterThan(g3);
		expect(g3).toBeGreaterThan(generic);
	});

	test("DeepSeek: r1 > v3 > generic", () => {
		const r1 = modelRecencyRank("deepseek-r1");
		const v3 = modelRecencyRank("deepseek-v3");
		const generic = modelRecencyRank("deepseek-chat");
		expect(r1).toBeGreaterThan(v3);
		expect(v3).toBeGreaterThan(generic);
	});

	test("Qwen: qwen3-coder > qwen3 > generic qwen", () => {
		const coder = modelRecencyRank("qwen3-coder");
		const q3 = modelRecencyRank("qwen3");
		const generic = modelRecencyRank("qwen2");
		expect(coder).toBeGreaterThan(q3);
		expect(q3).toBeGreaterThan(generic);
	});

	test("Mistral: devstral > codestral > generic mistral", () => {
		const dev = modelRecencyRank("devstral");
		const code = modelRecencyRank("codestral");
		const generic = modelRecencyRank("mistral-large");
		expect(dev).toBeGreaterThan(code);
		expect(code).toBeGreaterThan(generic);
	});

	test("Llama: llama-4 > generic llama", () => {
		const l4 = modelRecencyRank("llama-4");
		const generic = modelRecencyRank("llama-3.1-70b");
		expect(l4).toBeGreaterThan(generic);
	});

	test("unknown model returns 0", () => {
		expect(modelRecencyRank("totally-unknown-model")).toBe(0);
	});

	test("case-insensitive matching", () => {
		expect(modelRecencyRank("Claude-Opus-4-6")).toBe(modelRecencyRank("claude-opus-4-6"));
		expect(modelRecencyRank("GPT-5.4")).toBe(modelRecencyRank("gpt-5.4"));
	});
});
