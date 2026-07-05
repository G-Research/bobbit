import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/model-thinking-selectors.spec.ts (v2-dom tier).
//
// The legacy file:// fixture mirrored the AgentInterface model-selector button
// (PI-15) and thinking-level selector (PI-16) as a self-contained DOM + JS
// harness (not the real component, which needs the full gateway/session graph to
// mount). We reproduce the same harness under happy-dom and assert the identical
// facts. Playwright visibility (toBeVisible/toBeHidden) maps to the fixture's own
// `.hidden{display:none}` class mechanism.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Model {
	id: string;
	reasoning: boolean;
	contextWindow: number;
}

function setup() {
	document.body.innerHTML = `
		<div class="stats-bar" id="stats-bar">
			<button id="model-btn" class="model-btn">
				<svg class="sparkles" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/>
				</svg>
				<span id="model-label"></span>
			</button>
			<select id="thinking-select" class="thinking-select">
				<option value="off">Off</option>
				<option value="minimal">Minimal</option>
				<option value="low">Low</option>
				<option value="medium">Medium</option>
				<option value="high">High</option>
			</select>
		</div>`;

	let modelClickCount = 0;
	const thinkingChanges: string[] = [];
	let showModelSelector = true;
	let showThinkingSelector = true;
	let model: Model | null = { id: "claude-sonnet-4-20250514", reasoning: true, contextWindow: 200000 };

	const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;
	const modelLabel = document.getElementById("model-label") as HTMLSpanElement;
	const thinkingSelect = document.getElementById("thinking-select") as HTMLSelectElement;

	modelLabel.textContent = model.id;
	thinkingSelect.value = "off";

	modelBtn.addEventListener("click", () => {
		modelClickCount++;
	});
	thinkingSelect.addEventListener("change", (e) => {
		thinkingChanges.push((e.target as HTMLSelectElement).value);
	});

	function updateVisibility() {
		if (!showModelSelector || !model) modelBtn.classList.add("hidden");
		else modelBtn.classList.remove("hidden");

		const supportsThinking = !!model && model.reasoning === true;
		if (!showThinkingSelector || !supportsThinking) thinkingSelect.classList.add("hidden");
		else thinkingSelect.classList.remove("hidden");
	}
	updateVisibility();

	return {
		modelBtn,
		modelLabel,
		thinkingSelect,
		getModelClickCount: () => modelClickCount,
		getThinkingChanges: () => thinkingChanges,
		setShowModelSelector: (v: boolean) => {
			showModelSelector = v;
			updateVisibility();
		},
		setShowThinkingSelector: (v: boolean) => {
			showThinkingSelector = v;
			updateVisibility();
		},
		setModelReasoning: (v: boolean) => {
			model = model ? { ...model, reasoning: v } : model;
			updateVisibility();
		},
		setModel: (m: Model | null) => {
			model = m;
			if (m) modelLabel.textContent = m.id;
			updateVisibility();
		},
		setThinkingLevel: (v: string) => {
			thinkingSelect.value = v;
		},
	};
}

type Harness = ReturnType<typeof setup>;
let h: Harness;

const isHidden = (el: Element) => el.classList.contains("hidden");
function selectOption(select: HTMLSelectElement, value: string) {
	select.value = value;
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("PI-15: Model selector button", () => {
	beforeEach(() => {
		h = setup();
	});

	it("displays current model ID text", () => {
		expect(h.modelLabel.textContent).toBe("claude-sonnet-4-20250514");
	});

	it("click fires onModelSelect callback", () => {
		h.modelBtn.click();
		expect(h.getModelClickCount()).toBe(1);
	});

	it("multiple clicks increment callback count", () => {
		h.modelBtn.click();
		h.modelBtn.click();
		h.modelBtn.click();
		expect(h.getModelClickCount()).toBe(3);
	});

	it("button has Sparkles icon SVG", () => {
		const svg = h.modelBtn.querySelector("svg.sparkles");
		expect(svg).not.toBeNull();
		expect(isHidden(h.modelBtn)).toBe(false);
	});

	it("button hidden when showModelSelector=false", () => {
		h.setShowModelSelector(false);
		expect(isHidden(h.modelBtn)).toBe(true);
	});

	it("button reappears when showModelSelector toggled back to true", () => {
		h.setShowModelSelector(false);
		expect(isHidden(h.modelBtn)).toBe(true);
		h.setShowModelSelector(true);
		expect(isHidden(h.modelBtn)).toBe(false);
	});

	it("button hidden when model is null", () => {
		h.setModel(null);
		expect(isHidden(h.modelBtn)).toBe(true);
	});

	it("updates label when model changes", () => {
		h.setModel({ id: "claude-opus-5", reasoning: true, contextWindow: 200000 });
		expect(h.modelLabel.textContent).toBe("claude-opus-5");
	});
});

describe("PI-16: Thinking level selector", () => {
	beforeEach(() => {
		h = setup();
	});

	it("shows current thinking level (default off)", () => {
		expect(h.thinkingSelect.value).toBe("off");
	});

	it("has all five options: off, minimal, low, medium, high", () => {
		const options = Array.from(h.thinkingSelect.querySelectorAll("option")).map((o) => ({
			value: (o as HTMLOptionElement).value,
			label: o.textContent!.trim(),
		}));
		expect(options).toEqual([
			{ value: "off", label: "Off" },
			{ value: "minimal", label: "Minimal" },
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		]);
	});

	it("change fires onThinkingChange with new value", () => {
		selectOption(h.thinkingSelect, "medium");
		expect(h.getThinkingChanges()).toEqual(["medium"]);
	});

	it("multiple changes tracked in order", () => {
		selectOption(h.thinkingSelect, "low");
		selectOption(h.thinkingSelect, "high");
		selectOption(h.thinkingSelect, "off");
		expect(h.getThinkingChanges()).toEqual(["low", "high", "off"]);
	});

	it("hidden when showThinkingSelector=false", () => {
		h.setShowThinkingSelector(false);
		expect(isHidden(h.thinkingSelect)).toBe(true);
	});

	it("reappears when showThinkingSelector toggled back to true", () => {
		h.setShowThinkingSelector(false);
		expect(isHidden(h.thinkingSelect)).toBe(true);
		h.setShowThinkingSelector(true);
		expect(isHidden(h.thinkingSelect)).toBe(false);
	});

	it("hidden when model does not support thinking (reasoning=false)", () => {
		h.setModelReasoning(false);
		expect(isHidden(h.thinkingSelect)).toBe(true);
	});

	it("reappears when model reasoning toggled back to true", () => {
		h.setModelReasoning(false);
		expect(isHidden(h.thinkingSelect)).toBe(true);
		h.setModelReasoning(true);
		expect(isHidden(h.thinkingSelect)).toBe(false);
	});

	it("hidden when model is null (no model loaded)", () => {
		h.setModel(null);
		expect(isHidden(h.thinkingSelect)).toBe(true);
	});

	it("respects pre-set thinking level", () => {
		h.setThinkingLevel("high");
		expect(h.thinkingSelect.value).toBe("high");
	});
});
