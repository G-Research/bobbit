/**
 * Reproducing test for the Claude Fable 5 thinking-level metadata bug.
 *
 * Bug: `getSupportedThinkingLevels` in `src/shared/thinking-levels.ts` does
 * not honor `thinkingLevelMap`. Fable's map is `{ off: null, xhigh: "xhigh" }`
 * — `off: null` means forced adaptive thinking (thinking cannot be disabled),
 * so "off" must be EXCLUDED from the supported set. The authoritative pi-ai
 * `getSupportedThinkingLevels` returns `["minimal","low","medium","high","xhigh"]`.
 *
 * On CURRENT (pre-fix) code the function ignores the `off: null` entry and
 * returns the full ladder including "off", and `clampThinkingLevel("off", …)`
 * returns an unsupported "off" instead of stepping up to "minimal".
 *
 * This file fails today and passes after the fix. Do NOT weaken these
 * assertions — they encode pi-ai's ground-truth semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	getSupportedThinkingLevels,
	clampThinkingLevel,
	type ModelLike,
} from "../src/shared/thinking-levels.ts";

const fable: ModelLike = {
	id: "claude-fable-5",
	provider: "anthropic",
	reasoning: true,
	thinkingLevelMap: { off: null, xhigh: "xhigh" },
};

test("repro: Fable off:null map excludes off from supported thinking levels", () => {
	assert.deepEqual(
		getSupportedThinkingLevels(fable),
		["minimal", "low", "medium", "high", "xhigh"],
		"Fable supported thinking levels regressed: off must be excluded (off:null = forced adaptive), full ladder minus off expected",
	);
});

test("repro: clampThinkingLevel(off) on Fable clamps up to minimal", () => {
	assert.equal(
		clampThinkingLevel("off", fable),
		"minimal",
		"clamp must step UP to lowest supported level when off is unsupported",
	);
});
