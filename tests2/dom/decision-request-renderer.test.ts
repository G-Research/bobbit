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
	decisionClass: "deferrable",
	title: "Choose a mode",
	question: "Which mode should be used?",
	options: [
		{ value: "safe", label: "Safe mode" },
		{ value: "fast", label: "Fast mode" },
	],
};

function response(status: DecisionRequestProjection["status"], value?: DecisionValue): unknown {
	return {
		request: {
			...PENDING,
			status,
			...(value ? { resolution: { value } } : {}),
		},
	};
}

function terminal(value: DecisionValue): unknown {
	return response("resolved", value);
}

async function renderDecision(request: DecisionRequestProjection = PENDING): Promise<{ container: HTMLElement; widget: any }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(new DecisionRequestRenderer().render(request, "session-1"), container);
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

	it("keeps awaiting consent answerable through the existing typed POST", async () => {
		const request: DecisionRequestProjection = {
			...PENDING,
			id: "consent-1",
			status: "paused-awaiting-consent",
			decisionClass: "consent-required",
		};
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(terminal({ kind: "option", value: "safe" })), { status: 200 }));
		const container = document.createElement("div");
		document.body.appendChild(container);
		render(new DecisionRequestRenderer().render(request, "session-1"), container);
		await customElements.whenDefined("ask-user-choices-widget");
		const widget = container.querySelector("ask-user-choices-widget") as any;
		await widget.updateComplete;

		expect(container.textContent).toContain("Consent required");
		expect(container.textContent).toContain("Awaiting consent");
		widget.querySelector('[role="radio"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await new Promise(resolve => setTimeout(resolve, 75));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(String(fetch.mock.calls[0][0])).toContain("/decision-requests/consent-1/answer");
	});

	it.each([
		[
			"denied",
			{ ...PENDING, decisionClass: "consent-required" } satisfies DecisionRequestProjection,
			"This consent request was denied.",
		],
		[
			"paused-awaiting-consent",
			{ ...PENDING, status: "paused-awaiting-consent", decisionClass: "consent-required" } satisfies DecisionRequestProjection,
			"This consent request is still awaiting consent.",
		],
	] as const)("does not falsely accept an answer when POST returns %s without a resolution", async (status, request, message) => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response(status)), { status: 200 }));
		const { container, widget } = await renderDecision(request);

		widget.querySelector('[role="radio"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await new Promise(resolve => setTimeout(resolve, 75));
		await widget.updateComplete;

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain(message);
		expect(container.querySelector(".ask-widget")?.className).not.toContain("ask-answered");
		expect(container.querySelector(".ask-submit")).not.toBeNull();
		if (status === "paused-awaiting-consent") expect(container.textContent).toContain("Awaiting consent");
	});

	it("uses the server's resolved default instead of the clicked answer", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response("defaulted", { kind: "option", value: "fast" })), { status: 200 }));
		const { container, widget } = await renderDecision();

		widget.querySelector('[role="radio"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await new Promise(resolve => setTimeout(resolve, 75));
		await widget.updateComplete;

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".ask-widget")?.className).toContain("ask-answered");
		expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Fast mode");
	});

	it.each([
		["defaulted", "Default applied", "The safe default was applied."],
		["denied", "Denied", "This consent request was denied."],
	] as const)("renders %s as a read-only terminal state", async (status, label, message) => {
		const request: DecisionRequestProjection = { ...PENDING, status, decisionClass: "consent-required" };
		const container = document.createElement("div");
		document.body.appendChild(container);
		render(new DecisionRequestRenderer().render(request, "session-1"), container);
		await customElements.whenDefined("ask-user-choices-widget");
		const widget = container.querySelector("ask-user-choices-widget") as any;
		await widget.updateComplete;

		expect(container.textContent).toContain(label);
		expect(widget.submitAnswers).toBeUndefined();
		expect(container.textContent).toContain(message);
	});
});
