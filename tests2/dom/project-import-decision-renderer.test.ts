import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { ProjectImportDecisionRenderer } from "../../src/ui/tools/renderers/ProjectImportDecisionRenderer.js";
import {
	__resetProjectImportDecisionRequestsForTests,
	activateProjectImportDecisionRequests,
	answerProjectImportDecisionRequest,
	projectImportDecisionRequestsForProject,
	projectImportDecisionRequestsLoaded,
	type ProjectImportDecisionRequestProjection,
} from "../../src/app/project-import-decisions.js";
import type { DecisionValue } from "../../src/app/extension-decisions.js";
import "../../src/ui/components/AskUserChoicesWidget.js";

const PROJECT_ID = "project-import-ui";
const PENDING: ProjectImportDecisionRequestProjection = {
	id: "import-request-1",
	projectId: PROJECT_ID,
	status: "pending",
	decisionClass: "deferrable",
	title: "Choose import mode",
	question: "Which safe import mode should be used?",
	options: [
		{ value: "safe", label: "Safe mode" },
		{ value: "fast", label: "Fast mode" },
	],
};

function terminal(value: DecisionValue): unknown {
	return { request: { ...PENDING, status: "resolved", resolution: { value } } };
}

async function renderDecision(request: ProjectImportDecisionRequestProjection = PENDING): Promise<{ container: HTMLElement; widget: any }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	render(new ProjectImportDecisionRenderer().render(request), container);
	await customElements.whenDefined("ask-user-choices-widget");
	const widget = container.querySelector("ask-user-choices-widget") as any;
	await widget.updateComplete;
	return { container, widget };
}

afterEach(() => {
	vi.restoreAllMocks();
	__resetProjectImportDecisionRequestsForTests();
	document.body.innerHTML = "";
});

describe("ProjectImportDecisionRenderer", () => {
	it("reuses the existing Other-choice widget and posts only to the project import route", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(terminal({ kind: "other", text: "A custom safe mode" })), { status: 200 }));
		const { container, widget } = await renderDecision();

		expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(PENDING.question);
		expect(widget.sessionId).toBe("");
		expect(widget.toolUseId).toBe("");
		const other = container.querySelector(".ask-other-input") as HTMLInputElement;
		other.value = "A custom safe mode";
		other.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await widget.updateComplete;
		(container.querySelector(".ask-submit") as HTMLButtonElement).click();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(String(url)).toContain(`/api/projects/${PROJECT_ID}/import-decision-requests/import-request-1/answer`);
		expect(String(url)).not.toContain("/api/sessions/");
		expect(String(url)).not.toContain("ask-user");
		expect(JSON.parse(String(init?.body))).toEqual({ value: { kind: "other", text: "A custom safe mode" } });
	});

	it("treats an unavailable projection as loaded with no requests", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 500 }));
		const changed = vi.fn();
		const unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);

		await vi.waitFor(() => expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(true));
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalled();
		unsubscribe();
	});

	it("treats a network projection failure as loaded with no requests", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gateway restarted"));
		const unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, vi.fn());

		await vi.waitFor(() => expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(true));
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("reloads the durable pending projection and removes a settled request without a transcript", async () => {
		const fetch = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ requests: [PENDING] }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ requests: [PENDING] }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(terminal({ kind: "option", value: "safe" })), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(terminal({ kind: "option", value: "safe" })), { status: 200 }));
		const changed = vi.fn();
		let unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);
		await vi.waitFor(() => expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toHaveLength(1));
		// A reopened registration flow gets the same durable pending card from REST.
		unsubscribe();
		__resetProjectImportDecisionRequestsForTests();
		unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);
		await vi.waitFor(() => expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toHaveLength(1));

		await answerProjectImportDecisionRequest(PROJECT_ID, PENDING.id, { kind: "option", value: "safe" });
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		// A retry remains a route-level idempotent answer, not a session message.
		await answerProjectImportDecisionRequest(PROJECT_ID, PENDING.id, { kind: "option", value: "safe" });
		expect(fetch).toHaveBeenCalledTimes(4);
		for (const [url] of fetch.mock.calls) expect(String(url)).not.toContain("/api/sessions/");
		expect(changed).toHaveBeenCalled();
		unsubscribe();
	});
});
