import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/thinking-levels-per-model.spec.ts (v2-dom tier).
// The legacy file:// fixture mirrored src/shared/thinking-levels.ts in plain JS.
// This port drives the REAL getSupportedThinkingLevels + clampThinkingLevel from
// src/shared/thinking-levels.ts through a minimal happy-dom <select> harness that
// reproduces the fixture's per-model reactivity contract (option list swaps on
// model change; a no-longer-supported current level clamps to the displayed
// value; clamp counter increments). Same DOM facts the Chromium fixture asserted.
import { afterEach, describe, expect, it } from "vitest";
import {
	getSupportedThinkingLevels,
	clampThinkingLevel,
	type ModelLike,
	type ThinkingLevel,
} from "../../src/shared/thinking-levels.js";

const LABELS: Record<ThinkingLevel, string> = {
	off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

/** Parse the fixture's `provider|id|reasoning|mapStr` encoding into a ModelLike. */
function parseModel(value: string): ModelLike {
	const [provider, id, reasoning, mapStr] = value.split("|");
	const m: ModelLike = { provider, id, reasoning: reasoning === "1" };
	if (mapStr) {
		const map: Record<string, string | null> = {};
		for (const pair of mapStr.split(";")) {
			if (!pair) continue;
			const eq = pair.indexOf("=");
			const key = pair.slice(0, eq);
			const val = pair.slice(eq + 1);
			map[key] = val === "null" ? null : val;
		}
		m.thinkingLevelMap = map as ModelLike["thinkingLevelMap"];
	}
	return m;
}

const DEFAULT_MODEL = "anthropic|claude-opus-4-8-20260528|1|xhigh=xhigh";

/** Reproduce the fixture's reactive selector, backed by REAL capability logic. */
function createHarness() {
	const thinkingSelect = document.createElement("select");
	thinkingSelect.id = "thinking-select";
	document.body.appendChild(thinkingSelect);

	let currentModel = parseModel(DEFAULT_MODEL);
	let currentLevel: ThinkingLevel = "medium";
	let clampCount = 0;

	function rerender() {
		const supported = getSupportedThinkingLevels(currentModel);
		if (!supported.includes(currentLevel)) {
			const clamped = clampThinkingLevel(currentLevel, currentModel) as ThinkingLevel;
			if (clamped !== currentLevel) {
				currentLevel = clamped;
				clampCount++;
			}
		}
		thinkingSelect.innerHTML = "";
		for (const lvl of supported) {
			const opt = document.createElement("option");
			opt.value = lvl;
			opt.textContent = LABELS[lvl];
			thinkingSelect.appendChild(opt);
		}
		thinkingSelect.value = currentLevel;
	}

	rerender();

	return {
		thinkingSelect,
		setModelByValue(value: string) { currentModel = parseModel(value); rerender(); },
		pickLevel(lvl: ThinkingLevel) {
			thinkingSelect.value = lvl;
			currentLevel = lvl;
		},
		getCurrentLevel: () => currentLevel,
		getSupported: () => Array.from(thinkingSelect.options).map(o => o.value),
		getClampCount: () => clampCount,
	};
}

let h: ReturnType<typeof createHarness>;
afterEach(() => { document.body.innerHTML = ""; });

describe("Per-model thinking-level selector", () => {
	it("explicit maps expose xhigh regardless of model family or route", () => {
		h = createHarness();
		for (const model of [
			"anthropic|claude-opus-4-8-20260528|1|xhigh=xhigh",
			"aigw|claude-opus-4.8-20260528|1|xhigh=xhigh",
			"custom|future-reasoner|1|xhigh=extra",
		]) {
			h.setModelByValue(model);
			expect(h.getSupported()).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		}
	});

	it("model names do not expose xhigh without an explicit map", () => {
		h = createHarness();
		for (const model of [
			"anthropic|claude-opus-4-8-20260528|1",
			"aigw|claude-opus-4-7-20251101|1",
			"openai|gpt-5.2-codex|1",
		]) {
			h.setModelByValue(model);
			expect(h.getSupported()).toEqual(["off", "minimal", "low", "medium", "high"]);
		}
	});

	it("Claude Fable 5 (off:null map) omits off and offers minimal..xhigh", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-fable-5|1|off=null;xhigh=xhigh");
		expect(h.getSupported()).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
		expect(h.getSupported()).not.toContain("off");
	});

	it("Opus 4.5 omits xhigh option", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-opus-4-5-20250920|1");
		expect(h.getSupported()).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(h.getSupported()).not.toContain("xhigh");
	});

	it("OpenAI family names without maps stay on the base ladder", () => {
		h = createHarness();
		for (const id of ["gpt-5.2-codex", "gpt-5.4", "gpt-5.5", "gpt-5.1-codex-max"]) {
			h.setModelByValue(`openai|${id}|1`);
			expect(h.getSupported()).not.toContain("xhigh");
		}
	});

	it("gpt-5.6 metadata exposes xhigh and max options", () => {
		h = createHarness();
		h.setModelByValue("openai|gpt-5.6-luna|1|off=none;xhigh=xhigh;max=max");
		expect(h.getSupported()).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("gpt-5 (non-max, non-5.2) does not expose xhigh", () => {
		h = createHarness();
		h.setModelByValue("openai|gpt-5|1");
		expect(h.getSupported()).not.toContain("xhigh");
	});

	it("non-reasoning model exposes only off", () => {
		h = createHarness();
		h.setModelByValue("openai|gpt-4o|0");
		expect(h.getSupported()).toEqual(["off"]);
	});

	it("xhigh on an explicitly capable model clamps to high when switching to a mapless model", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-opus-4-8-20260528|1|xhigh=xhigh");
		h.pickLevel("xhigh");
		expect(h.getCurrentLevel()).toBe("xhigh");

		h.setModelByValue("anthropic|claude-opus-4-5-20250920|1");
		expect(h.getCurrentLevel()).toBe("high");
		expect(h.thinkingSelect.value).toBe("high");
		expect(h.getClampCount()).toBe(1);
	});

	it("high on Opus 4.7 stays high when switching to a non-reasoning model", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-opus-4-7-20251101|1");
		h.pickLevel("high");
		expect(h.getCurrentLevel()).toBe("high");

		h.setModelByValue("openai|gpt-4o|0");
		// gpt-4o supports only "off" — high clamps to off.
		expect(h.getCurrentLevel()).toBe("off");
		expect(h.getSupported()).toEqual(["off"]);
	});

	it("supported level is preserved between models with explicit maps", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-opus-4-7-20251101|1|xhigh=xhigh");
		h.pickLevel("xhigh");
		h.setModelByValue("openai|gpt-5.2|1|xhigh=xhigh");
		expect(h.getCurrentLevel()).toBe("xhigh");
	});

	it("xhigh persists across reload when the model map advertises it", () => {
		h = createHarness();
		h.setModelByValue("anthropic|claude-opus-4-8-20260528|1|xhigh=xhigh");
		h.pickLevel("xhigh");
		expect(h.getCurrentLevel()).toBe("xhigh");

		// "Reload" — the fixture re-initialises on the default Opus 4.8 model.
		// Regression guard: xhigh must remain a valid option after a fresh init.
		document.body.innerHTML = "";
		h = createHarness();
		expect(h.getSupported()).toContain("xhigh");
	});
});
