import { afterEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import { ProjectImportProposalRenderer } from "../../src/ui/tools/renderers/ProjectImportProposalRenderer.js";
import type { ProjectImportProposalProjection } from "../../src/app/project-import-decisions.js";

const PROJECT_ID = "project-import-ui";

function proposal(requestId: string): ProjectImportProposalProjection {
	return {
		projectId: PROJECT_ID,
		requestId,
		proposalType: "goal",
		rev: 1,
		fields: { title: `Goal ${requestId}` },
		status: "created",
	};
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>(resolveResponse => { resolve = resolveResponse; });
	return { promise, resolve };
}

async function renderProposals(proposals: ProjectImportProposalProjection[]): Promise<{
	container: HTMLElement;
	renderCards: () => void;
}> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	let renderer!: ProjectImportProposalRenderer;
	const renderCards = () => {
		renderer.reconcile(proposals);
		render(html`${proposals.map(item => renderer.render(item))}`, container);
	};
	renderer = new ProjectImportProposalRenderer(renderCards);
	renderCards();
	await Promise.resolve();
	return { container, renderCards };
}

function actionButton(container: HTMLElement, requestId: string, action: "accept" | "reject"): HTMLButtonElement {
	return container.querySelector(`[data-project-import-proposal-id="${requestId}"] [data-testid="project-import-proposal-${action}"] button`) as HTMLButtonElement;
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("ProjectImportProposalRenderer", () => {
	it("locks both controls immediately while accepting and suppresses duplicate client submits", async () => {
		const pending = deferredResponse();
		const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
		const { container } = await renderProposals([proposal("request-a")]);

		actionButton(container, "request-a", "accept").click();
		await Promise.resolve();

		expect(actionButton(container, "request-a", "accept").disabled).toBe(true);
		expect(actionButton(container, "request-a", "reject").disabled).toBe(true);
		expect(actionButton(container, "request-a", "accept").textContent).toContain("Applying");
		actionButton(container, "request-a", "accept").click();
		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0][0])).toContain("/import-proposals/request-a/goal/accept");
	});

	it("keeps a failed accept alert through a re-render, clears it on retry, and restores controls", async () => {
		const retry = deferredResponse();
		const fetch = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Proposal revision is stale" }), { status: 409 }))
			.mockReturnValueOnce(retry.promise);
		const { container, renderCards } = await renderProposals([proposal("request-a")]);

		actionButton(container, "request-a", "accept").click();
		await vi.waitFor(() => expect(container.querySelector('[data-testid="project-import-proposal-error"]')?.textContent).toContain("revision is stale"));
		expect(actionButton(container, "request-a", "accept").disabled).toBe(false);
		expect(actionButton(container, "request-a", "reject").disabled).toBe(false);

		renderCards();
		expect(container.querySelector('[data-testid="project-import-proposal-error"]')?.textContent).toContain("revision is stale");
		actionButton(container, "request-a", "accept").click();
		await Promise.resolve();
		expect(container.querySelector('[data-testid="project-import-proposal-error"]')).toBeNull();
		expect(actionButton(container, "request-a", "accept").disabled).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("bounds failure text and cleans stale state when its proposal card is removed", async () => {
		const error = "x".repeat(400);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error }), { status: 409 }));
		const proposals = [proposal("request-a")];
		const { container, renderCards } = await renderProposals(proposals);

		actionButton(container, "request-a", "accept").click();
		await vi.waitFor(() => expect(container.querySelector('[data-testid="project-import-proposal-error"]')).not.toBeNull());
		expect(container.querySelector('[data-testid="project-import-proposal-error"]')?.textContent?.length).toBe(280);

		proposals.pop();
		renderCards();
		proposals.push(proposal("request-a"));
		renderCards();
		expect(container.querySelector('[data-testid="project-import-proposal-error"]')).toBeNull();
	});

	it("submits reject with its own pending label", async () => {
		const pending = deferredResponse();
		const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
		const { container } = await renderProposals([proposal("request-a")]);

		actionButton(container, "request-a", "reject").click();
		await Promise.resolve();

		expect(actionButton(container, "request-a", "reject").textContent).toContain("Rejecting");
		expect(actionButton(container, "request-a", "accept").disabled).toBe(true);
		expect(String(fetch.mock.calls[0][0])).toContain("/import-proposals/request-a/goal/reject");
	});

	it("keeps pending state isolated for independent request IDs", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => deferredResponse().promise);
		const { container } = await renderProposals([proposal("request-a"), proposal("request-b")]);

		actionButton(container, "request-a", "accept").click();
		await Promise.resolve();
		expect(actionButton(container, "request-a", "reject").disabled).toBe(true);
		expect(actionButton(container, "request-b", "accept").disabled).toBe(false);

		actionButton(container, "request-b", "reject").click();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(String(fetch.mock.calls[1][0])).toContain("/import-proposals/request-b/goal/reject");
	});
});
