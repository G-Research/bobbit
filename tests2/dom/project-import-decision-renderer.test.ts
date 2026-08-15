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
	projectImportDecisionProjectionError,
	projectImportDecisionRequestsForProject,
	projectImportDecisionRequestsLoaded,
	refreshProjectImportDecisionRequests,
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

	it("keeps a 503 decision projection failure distinct from an authoritative empty projection and retries", async () => {
		let decisionReads = 0;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("/import-proposals")) return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
			if (url.includes("/import-decision-requests?state=pending")) {
				decisionReads++;
				return decisionReads === 1
					? new Response("unavailable", { status: 503 })
					: new Response(JSON.stringify({ requests: [] }), { status: 200 });
			}
			throw new Error(`unexpected import fetch: ${url}`);
		});
		const changed = vi.fn();
		const unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);

		await vi.waitFor(() => expect(projectImportDecisionProjectionError(PROJECT_ID)?.message).toContain("Retry"));
		expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(false);
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-proposals"))).toHaveLength(1);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-decision-requests?state=pending"))).toHaveLength(1);

		await refreshProjectImportDecisionRequests(PROJECT_ID);
		expect(projectImportDecisionProjectionError(PROJECT_ID)).toBeNull();
		expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(true);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-proposals"))).toHaveLength(2);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-decision-requests?state=pending"))).toHaveLength(2);
		expect(changed).toHaveBeenCalled();
		unsubscribe();
	});

	it("keeps a network failure from either required projection blocked instead of treating it as empty", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("gateway restarted"));
		const unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, vi.fn());

		await vi.waitFor(() => expect(projectImportDecisionProjectionError(PROJECT_ID)).not.toBeNull());
		expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(false);
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-decision-requests?state=pending"))).toHaveLength(1);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("/import-proposals"))).toHaveLength(1);
		unsubscribe();
	});

	it("reloads pending decisions and proposal drafts by endpoint before allowing a settled import", async () => {
		let decisionReads = 0;
		let proposalReads = 0;
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("/import-proposals")) {
				proposalReads++;
				return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
			}
			if (url.includes("/import-decision-requests?state=pending")) {
				decisionReads++;
				return new Response(JSON.stringify({ requests: decisionReads <= 2 ? [PENDING] : [] }), { status: 200 });
			}
			if (url.includes(`/import-decision-requests/${PENDING.id}/answer`)) {
				return new Response(JSON.stringify(terminal({ kind: "option", value: "safe" })), { status: 200 });
			}
			throw new Error(`unexpected import fetch: ${url}`);
		});
		const changed = vi.fn();
		let unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);
		await vi.waitFor(() => expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toHaveLength(1));
		// A reopened registration flow gets the same durable pending card from REST.
		unsubscribe();
		__resetProjectImportDecisionRequestsForTests();
		unsubscribe = activateProjectImportDecisionRequests(PROJECT_ID, changed);
		await vi.waitFor(() => expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toHaveLength(1));

		await answerProjectImportDecisionRequest(PROJECT_ID, PENDING.id, { kind: "option", value: "safe" });
		expect(projectImportDecisionRequestsLoaded(PROJECT_ID)).toBe(true);
		expect(projectImportDecisionRequestsForProject(PROJECT_ID)).toEqual([]);
		// A retry remains a route-level idempotent answer plus authoritative refresh, not a session message.
		await answerProjectImportDecisionRequest(PROJECT_ID, PENDING.id, { kind: "option", value: "safe" });
		expect(decisionReads).toBe(4);
		expect(proposalReads).toBe(4);
		expect(fetch.mock.calls.filter(([url]) => String(url).includes(`/import-decision-requests/${PENDING.id}/answer`))).toHaveLength(2);
		for (const [url] of fetch.mock.calls) expect(String(url)).not.toContain("/api/sessions/");
		expect(changed).toHaveBeenCalled();
		unsubscribe();
	});
});
