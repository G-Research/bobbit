import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { DecisionRequestRenderer } from "../../src/ui/tools/renderers/DecisionRequestRenderer.js";
import { __resetDecisionRequestsForTests, type DecisionRequestProjection, type DecisionValue } from "../../src/app/extension-decisions.js";
import "../../src/ui/components/AskUserChoicesWidget.js";

const PENDING: DecisionRequestProjection = {
	id: "request-1",
	sessionId: "session-1",
	status: "pending",
	title: "Choose a mode",
	question: "Which mode should be used?",
	options: [
		{ value: "safe", label: "Safe mode" },
		{ value: "fast", label: "Fast mode" },
	],
};

function terminal(value: DecisionValue): unknown {
	return {
		request: {
			...PENDING,
			status: "resolved",
			resolution: { value },
		},
	};
}

async function renderDecision(): Promise<{ container: HTMLElement; widget: any }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(new DecisionRequestRenderer().render(PENDING, "session-1"), container);
	await customElements.whenDefined("ask-user-choices-widget");
	const widget = container.querySelector("ask-user-choices-widget") as any;
	await widget.updateComplete;
	return { container, widget };
}

afterEach(() => {
	vi.restoreAllMocks();
	__resetDecisionRequestsForTests();
	document.body.innerHTML = "";
});

describe("DecisionRequestRenderer", () => {
	it("reuses the ask widget's Other, ARIA, validation, and decision-only transport", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(terminal({ kind: "other", text: "A custom mode" })), { status: 200 }));
		const { container, widget } = await renderDecision();

		expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(PENDING.question);
		expect(container.querySelector(".ask-submit")).toBeNull();
		const other = container.querySelector(".ask-other-input") as HTMLInputElement;
		other.value = "A custom mode";
		other.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await widget.updateComplete;
		const submit = container.querySelector(".ask-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		submit.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		await widget.updateComplete;

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(String(url)).toContain("/api/sessions/session-1/decision-requests/request-1/answer");
		expect(String(url)).not.toContain("/api/internal/user-question/submit");
		expect(JSON.parse(String(init?.body))).toEqual({ value: { kind: "other", text: "A custom mode" } });
		expect(container.querySelector(".ask-widget")?.className).toContain("ask-answered");
		expect(container.querySelector(".ask-other-input")?.hasAttribute("disabled")).toBe(true);
	});

	it("keeps the widget's number-key selection while posting the stored option value", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(terminal({ kind: "option", value: "safe" })), { status: 200 }));
		const { container, widget } = await renderDecision();
		widget.querySelector(".ask-widget")?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
		await new Promise(resolve => setTimeout(resolve, 75));
		await widget.updateComplete;

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ value: { kind: "option", value: "safe" } });
		expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Safe mode");
	});
});
