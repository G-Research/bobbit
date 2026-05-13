/**
 * Unit tests for `src/shared/thinking-levels.ts` — the single source of
 * truth for per-model thinking-level capabilities.
 *
 * Table-driven coverage of the capability matrix from the design doc, plus
 * the clamping rules (clamp-down by rank; unknown → off; allowEmpty for
 * role-override / pref "inherit").
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	THINKING_LEVELS,
	getSupportedThinkingLevels,
	clampThinkingLevel,
	isKnownThinkingLevel,
	supportsXHigh,
	type ModelLike,
	type ThinkingLevel,
} from "../src/shared/thinking-levels.ts";

const ALL_BASE: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const ALL_PLUS_XHIGH: ThinkingLevel[] = [...ALL_BASE, "xhigh"];

interface MatrixRow {
	model: ModelLike;
	expected: ThinkingLevel[];
	label: string;
}

const matrix: MatrixRow[] = [
	// Anthropic Opus 4.6+ → xhigh
	{ label: "Claude Opus 4-7", model: { id: "claude-opus-4-7-20251101", provider: "anthropic", reasoning: true }, expected: ALL_PLUS_XHIGH },
	{ label: "Claude Opus 4-6", model: { id: "claude-opus-4-6-20251015", provider: "anthropic", reasoning: true }, expected: ALL_PLUS_XHIGH },
	// Future Opus 4-10 should also get xhigh (digit-range regex).
	{ label: "Claude Opus 4-10 (future)", model: { id: "claude-opus-4-10", provider: "anthropic", reasoning: true }, expected: ALL_PLUS_XHIGH },
	// Older Opus / other Anthropic — no xhigh.
	{ label: "Claude Opus 4-5", model: { id: "claude-opus-4-5-20250920", provider: "anthropic", reasoning: true }, expected: ALL_BASE },
	{ label: "Claude Sonnet 4-6", model: { id: "claude-sonnet-4-6-20251101", provider: "anthropic", reasoning: true }, expected: ALL_BASE },
	{ label: "Claude Haiku 4-5 (non-reasoning)", model: { id: "claude-haiku-4-5", provider: "anthropic", reasoning: false }, expected: ["off"] },
	// OpenAI families that get xhigh.
	{ label: "gpt-5.2-codex", model: { id: "gpt-5.2-codex", provider: "openai", reasoning: true }, expected: ALL_PLUS_XHIGH },
	{ label: "gpt-5.2", model: { id: "gpt-5.2", provider: "openai", reasoning: true }, expected: ALL_PLUS_XHIGH },
	{ label: "gpt-5.1-codex-max", model: { id: "gpt-5.1-codex-max", provider: "openai", reasoning: true }, expected: ALL_PLUS_XHIGH },
	// OpenAI families that do NOT get xhigh.
	{ label: "gpt-5.1-codex (no -max)", model: { id: "gpt-5.1-codex", provider: "openai", reasoning: true }, expected: ALL_BASE },
	{ label: "gpt-5", model: { id: "gpt-5", provider: "openai", reasoning: true }, expected: ALL_BASE },
	{ label: "gpt-4o (non-reasoning)", model: { id: "gpt-4o", provider: "openai", reasoning: false }, expected: ["off"] },
	// Google / other.
	{ label: "Gemini 3.1 Pro", model: { id: "gemini-3.1-pro", provider: "google", reasoning: true }, expected: ALL_BASE },
	// aigw-routed Opus 4-7 — provider is "aigw" but id carries the canonical family.
	{ label: "aigw/claude-opus-4-7", model: { id: "claude-opus-4-7-20251101", provider: "aigw", reasoning: true }, expected: ALL_PLUS_XHIGH },
	// aigw-routed gpt-5.2 — same rule.
	{ label: "aigw/gpt-5.2", model: { id: "gpt-5.2", provider: "aigw", reasoning: true }, expected: ALL_PLUS_XHIGH },
];

test("THINKING_LEVELS contains the canonical 6-element ordered set", () => {
	assert.deepEqual(
		[...THINKING_LEVELS],
		["off", "minimal", "low", "medium", "high", "xhigh"],
	);
});

test("isKnownThinkingLevel: accepts valid, rejects unknown / empty / non-string", () => {
	for (const lvl of THINKING_LEVELS) {
		assert.equal(isKnownThinkingLevel(lvl), lvl);
		assert.equal(isKnownThinkingLevel(`  ${lvl}  `), lvl);
	}
	assert.equal(isKnownThinkingLevel("garbage"), undefined);
	assert.equal(isKnownThinkingLevel(""), undefined);
	assert.equal(isKnownThinkingLevel("   "), undefined);
	assert.equal(isKnownThinkingLevel(null), undefined);
	assert.equal(isKnownThinkingLevel(undefined), undefined);
	assert.equal(isKnownThinkingLevel(7), undefined);
});

test("supportsXHigh: returns true only for Opus 4.6+ and gpt-5.1-codex-max / gpt-5.2*", () => {
	assert.equal(supportsXHigh({ id: "claude-opus-4-7-x", provider: "anthropic" }), true);
	assert.equal(supportsXHigh({ id: "claude-opus-4-6-x", provider: "anthropic" }), true);
	assert.equal(supportsXHigh({ id: "claude-opus-4-5-x", provider: "anthropic" }), false);
	assert.equal(supportsXHigh({ id: "claude-sonnet-4-6-x", provider: "anthropic" }), false);
	assert.equal(supportsXHigh({ id: "gpt-5.2-codex", provider: "openai" }), true);
	assert.equal(supportsXHigh({ id: "gpt-5.2", provider: "openai" }), true);
	assert.equal(supportsXHigh({ id: "gpt-5.1-codex-max", provider: "openai" }), true);
	assert.equal(supportsXHigh({ id: "gpt-5.1-codex", provider: "openai" }), false);
	assert.equal(supportsXHigh({ id: "gpt-5", provider: "openai" }), false);
	assert.equal(supportsXHigh({ id: "gemini-3.1-pro", provider: "google" }), false);
});

for (const row of matrix) {
	test(`getSupportedThinkingLevels: ${row.label}`, () => {
		assert.deepEqual(getSupportedThinkingLevels(row.model), row.expected);
	});
}

test("clampThinkingLevel: returns input unchanged when supported", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	for (const lvl of THINKING_LEVELS) {
		assert.equal(clampThinkingLevel(lvl, opus47), lvl);
	}
});

test("clampThinkingLevel: xhigh on Opus 4.5 clamps to high", () => {
	const opus45: ModelLike = { id: "claude-opus-4-5-20250920", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel("xhigh", opus45), "high");
});

test("clampThinkingLevel: xhigh on Opus 4.7 stays xhigh", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel("xhigh", opus47), "xhigh");
});

test("clampThinkingLevel: non-reasoning model collapses everything to off", () => {
	const gpt4o: ModelLike = { id: "gpt-4o", provider: "openai", reasoning: false };
	assert.equal(clampThinkingLevel("high", gpt4o), "off");
	assert.equal(clampThinkingLevel("medium", gpt4o), "off");
	assert.equal(clampThinkingLevel("xhigh", gpt4o), "off");
	assert.equal(clampThinkingLevel("minimal", gpt4o), "off");
	assert.equal(clampThinkingLevel("off", gpt4o), "off");
});

test("clampThinkingLevel: medium on gpt-5.2 stays medium", () => {
	const gpt52: ModelLike = { id: "gpt-5.2", provider: "openai", reasoning: true };
	assert.equal(clampThinkingLevel("medium", gpt52), "medium");
});

test("clampThinkingLevel: unknown token clamps to off on any model", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel("garbage", opus47), "off");
	const gpt4o: ModelLike = { id: "gpt-4o", provider: "openai", reasoning: false };
	assert.equal(clampThinkingLevel("garbage", gpt4o), "off");
});

test("clampThinkingLevel: undefined with allowEmpty returns undefined", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel(undefined, opus47, { allowEmpty: true }), undefined);
	assert.equal(clampThinkingLevel("", opus47, { allowEmpty: true }), undefined);
	assert.equal(clampThinkingLevel(null, opus47, { allowEmpty: true }), undefined);
});

test("clampThinkingLevel: undefined without allowEmpty returns off", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel(undefined, opus47), "off");
	assert.equal(clampThinkingLevel("", opus47), "off");
});

test("clampThinkingLevel: trims whitespace before validating", () => {
	const opus47: ModelLike = { id: "claude-opus-4-7", provider: "anthropic", reasoning: true };
	assert.equal(clampThinkingLevel("  high  ", opus47), "high");
	assert.equal(clampThinkingLevel("\txhigh\n", opus47), "xhigh");
});

test("getSupportedThinkingLevels: undefined reasoning defaults to reasoning-capable", () => {
	// Used by client state where reasoning may be momentarily undefined.
	const model: ModelLike = { id: "claude-opus-4-7", provider: "anthropic" };
	assert.deepEqual(getSupportedThinkingLevels(model), ALL_PLUS_XHIGH);
});
