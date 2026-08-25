import test from "node:test";
import assert from "node:assert/strict";
import {
	THINKING_LEVELS,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isKnownThinkingLevel,
	supportsXHigh,
	type ModelLike,
} from "../../../src/shared/thinking-levels.ts";

const BASE = ["off", "minimal", "low", "medium", "high"];

test("THINKING_LEVELS contains the canonical ordered set", () => {
	assert.deepEqual([...THINKING_LEVELS], [...BASE, "xhigh", "max"]);
});

test("isKnownThinkingLevel validates and trims canonical tokens", () => {
	for (const level of THINKING_LEVELS) {
		assert.equal(isKnownThinkingLevel(level), level);
		assert.equal(isKnownThinkingLevel(` ${level} `), level);
	}
	for (const invalid of ["", "garbage", null, undefined, 7]) {
		assert.equal(isKnownThinkingLevel(invalid), undefined);
	}
});

test("model families never grant xhigh without an explicit map", () => {
	for (const model of [
		{ id: "claude-opus-4-8", provider: "anthropic", reasoning: true },
		{ id: "gpt-5.2-codex", provider: "openai", reasoning: true },
		{ id: "gpt-5.1-codex-max", provider: "openai", reasoning: true },
		{ id: "openai/gpt-5.6-luna", provider: "aigw", reasoning: true },
	] satisfies ModelLike[]) {
		assert.equal(supportsXHigh(model), false, `${model.provider}/${model.id}`);
		assert.deepEqual(getSupportedThinkingLevels(model), BASE);
		assert.equal(clampThinkingLevel("xhigh", model), "high");
		assert.equal(clampThinkingLevel("max", model), "high");
	}
});

test("only explicit non-null map entries grant extended levels", () => {
	const exact: ModelLike = {
		id: "future-reasoner",
		provider: "custom",
		reasoning: true,
		thinkingLevelMap: { off: "none", xhigh: "extra", max: "maximum" },
	};
	assert.equal(supportsXHigh(exact), true);
	assert.deepEqual(getSupportedThinkingLevels(exact), [...BASE, "xhigh", "max"]);
	assert.equal(clampThinkingLevel("xhigh", exact), "xhigh");
	assert.equal(clampThinkingLevel("max", exact), "max");

	const denied: ModelLike = {
		...exact,
		thinkingLevelMap: { xhigh: null, max: null },
	};
	assert.equal(supportsXHigh(denied), false);
	assert.deepEqual(getSupportedThinkingLevels(denied), BASE);
});

test("exact maps retain absent base tiers and drop explicit null tiers", () => {
	const fable: ModelLike = {
		id: "claude-fable-5",
		provider: "anthropic",
		reasoning: true,
		thinkingLevelMap: { off: null, xhigh: "xhigh" },
	};
	assert.deepEqual(getSupportedThinkingLevels(fable), ["minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel("off", fable), "minimal");
	assert.equal(clampThinkingLevel("max", fable), "xhigh");

	const droppedMiddle: ModelLike = {
		id: "exact-map",
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
	};
	assert.deepEqual(getSupportedThinkingLevels(droppedMiddle), ["off", "low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel("minimal", droppedMiddle), "low");
});

test("missing capability metadata is conservative", () => {
	const unavailable: ModelLike = { id: "gpt-5.6-luna", provider: "openai" };
	assert.deepEqual(getSupportedThinkingLevels(unavailable), ["off"]);
	assert.equal(clampThinkingLevel("high", unavailable), "off");
	assert.equal(clampThinkingLevel("xhigh", unavailable), "off");
});

test("non-reasoning metadata permits only off even when a map advertises tiers", () => {
	const model: ModelLike = {
		id: "non-reasoner",
		reasoning: false,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	};
	assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
	assert.equal(clampThinkingLevel("max", model), "off");
});

test("unknown requests become off and allowEmpty preserves inheritance", () => {
	const model: ModelLike = { id: "reasoner", reasoning: true };
	assert.equal(clampThinkingLevel("garbage", model), "off");
	assert.equal(clampThinkingLevel(undefined, model, { allowEmpty: true }), undefined);
	assert.equal(clampThinkingLevel("", model, { allowEmpty: true }), undefined);
	assert.equal(clampThinkingLevel(undefined, model), "off");
});
