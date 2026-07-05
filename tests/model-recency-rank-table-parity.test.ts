/**
 * S9 (Extension-Seam Audit, seam-review/EXTENSION-SEAM-AUDIT.md §3): pins the
 * EXACT rank values of `modelRecencyRank()` (src/server/agent/model-registry.ts)
 * from BEFORE its if-ladder is converted into an ordered data table. This is a
 * pure "lookup table in disguise" refactor — every id below MUST resolve to the
 * SAME rank after the conversion.
 *
 * `tests/model-utils.test.ts` already pins the RELATIVE ordering/equality
 * invariants (e.g. "opus-4-6 > sonnet-4-6"); that survives many refactors that
 * would still silently renumber the absolute values (a data-table transcription
 * slip, a dropped default, a reordered rule pair). This file adds the byte-exact
 * absolute-value pin the audit's "rank-order parity test" calls for, generated
 * by RUNNING the pre-refactor function once (see PR description for the
 * generating command) — not hand-derived from reading the source, so a
 * transcription error in the ladder itself would already be baked into both.
 *
 * One deliberate PRE-EXISTING QUIRK is pinned as-is (not "fixed" — this PR only
 * moves representation, it does not change behavior): `"gpt-4.1-mini"` matches
 * the earlier `s.includes("gpt-4.1")` rule before it ever reaches the
 * `gpt-4o-mini || gpt-4.1-mini` rule, so it ranks equal to plain `"gpt-4.1"`
 * (68), not the lower rank the later rule's grouping might suggest. The ordered
 * data table must replicate this exact first-match-wins order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelRecencyRank, GPT_55_RECENCY_RANK } from "../src/server/agent/model-registry.ts";

// id -> expected rank, captured from the pre-refactor if-ladder implementation.
const EXPECTED_RANKS: Record<string, number> = {
	// ── Anthropic Claude ──
	"claude-opus-4-1": 96,
	"claude-opus-4-2": 92,
	"claude-opus-4-6": 100,
	"claude-opus-4-8": 104,
	"claude-opus-4-10": 108,
	"claude-opus-4.8": 104,
	"claude-opus-4-20250514": 95,
	"claude-opus-4": 95,
	"claude-sonnet-4-6": 99,
	"claude-sonnet-4.6": 99,
	"claude-sonnet-4-5": 97,
	"claude-sonnet-4.5": 97,
	"claude-sonnet-4": 94,
	"claude-haiku-4-5": 90,
	"claude-haiku-4.5": 90,
	"claude-3-7-sonnet": 80,
	"claude-3.7-sonnet": 80,
	"claude-3-5-sonnet": 70,
	"claude-3.5-sonnet": 70,
	"claude-3-5-haiku": 65,
	"claude-3.5-haiku": 65,
	"claude-3-opus": 60,
	"claude-unknown-variant": 50,
	// ── OpenAI ──
	"gpt-5.5": GPT_55_RECENCY_RANK,
	"gpt-5.4": 100,
	"gpt-5.3": 98,
	"gpt-5.2": 96,
	"gpt-5.1": 94,
	"gpt-5": 92,
	"o4-mini": 91,
	"o3-pro": 89,
	"o3": 88,
	"o3-mini": 85,
	"o1-pro": 80,
	"o1": 78,
	"gpt-4o": 70,
	"gpt-4.1": 68,
	"gpt-4o-mini": 65,
	// Pre-existing quirk (see file header): shadowed by the "gpt-4.1" rule above.
	"gpt-4.1-mini": 68,
	"gpt-4": 50,
	// ── Google Gemini ──
	"gemini-3.1-pro": 100,
	"gemini-3-pro": 98,
	"gemini-3.1-flash": 95,
	"gemini-3-flash": 95,
	"gemini-2.5-pro": 90,
	"gemini-2.5-flash": 85,
	"gemini-2.5-flash-lite": 80,
	"gemini-2.0": 60,
	"gemini-1.5": 40,
	"gemini-unknown": 30,
	// ── xAI Grok ──
	"grok-4": 100,
	"grok-3": 90,
	"grok-3-mini": 85,
	"grok-2": 70,
	"grok-unknown": 50,
	// ── DeepSeek ──
	"deepseek-v3.2": 95,
	"deepseek-v3.1": 90,
	"deepseek-r1": 88,
	"deepseek-v3": 85,
	"deepseek-unknown": 50,
	// ── Qwen ──
	"qwen3.5": 95,
	"qwen-3.5": 95,
	"qwen3-coder": 90,
	"qwen-3-coder": 90,
	"qwen3-next": 88,
	"qwen-3-next": 88,
	"qwen3": 85,
	"qwen-3": 85,
	"qwen-unknown": 50,
	// ── Mistral ──
	"devstral-medium": 90,
	"magistral": 88,
	"devstral": 85,
	"codestral": 80,
	"mistral-large": 75,
	"mistral-medium": 70,
	"mistral-unknown": 50,
	// ── Llama ──
	"llama-4": 90,
	"llama4": 90,
	"llama-3.3": 80,
	"llama3-3": 80,
	"llama-3.2": 70,
	"llama3-2": 70,
	"llama-unknown": 50,
	// ── Unknown / default ──
	"totally-unknown-model": 0,
	"": 0,
	// ── Case-insensitivity ──
	"CLAUDE-OPUS-4-6": 100,
	"GPT-5.4": 100,
};

describe("modelRecencyRank() — data-table parity pin (S9)", () => {
	for (const [id, expected] of Object.entries(EXPECTED_RANKS)) {
		it(`ranks ${JSON.stringify(id)} as ${expected}`, () => {
			assert.equal(modelRecencyRank(id), expected);
		});
	}

	it("covers every branch family the ladder/table dispatches on", () => {
		// Cheap sanity check that this fixture wasn't trimmed to something
		// smaller than the real branch surface as the registry grows.
		assert.ok(Object.keys(EXPECTED_RANKS).length >= 80);
	});
});
