import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import type { InboxEntry } from "../../src/server/agent/inbox-store.js";
import "../../src/ui/inbox/InboxPanel.js";

const CONSENT_ENTRY: InboxEntry = {
	id: "inbox-consent-1",
	staffId: "staff-1",
	source: {
		type: "consent_pause",
		sourceKey: "consent-pause:project-1:request-1",
		requestId: "request-1",
		questionId: "question-1",
	},
	title: "Choose a safe mode",
	prompt: "Choose a safe mode",
	state: "pending",
	wake: false,
	createdAt: Date.now(),
};

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
	window.location.hash = "";
});

describe("consent inbox reference", () => {
	it("uses a non-destructive Review action that opens and focuses the existing decision card", async () => {
		const card = document.createElement("section");
		card.dataset.decisionRequestId = "request-1";
		card.scrollIntoView = vi.fn();
		card.focus = vi.fn();
		document.body.appendChild(card);

		const container = document.createElement("div");
		document.body.appendChild(container);
		render(
			// Review is only a reference: no inbox-specific answer or cancellation route is used.
			html`<inbox-panel .entries=${[CONSENT_ENTRY]} sessionId="session-1" staffId="staff-1"></inbox-panel>`,
			container,
		);
		const panel = container.querySelector("inbox-panel") as any;
		await panel.updateComplete;
		const review = panel.querySelector(".inbox-review-consent-btn") as HTMLButtonElement;

		expect(panel.textContent).toContain("consent");
		expect(review.textContent).toContain("Review");
		expect(panel.querySelector(".inbox-cancel-btn")).toBeNull();
		review.click();

		expect(window.location.hash).toBe("#/session/session-1");
		expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
		expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it("keeps an advisory as an ordinary non-interrupting inbox item", async () => {
		const advisory: InboxEntry = {
			...CONSENT_ENTRY,
			id: "advisory-1",
			source: { type: "extension_advisory", packId: "pack-1", hookId: "hook-1" },
		};
		const container = document.createElement("div");
		document.body.appendChild(container);
		render(html`<inbox-panel .entries=${[advisory]} sessionId="session-1" staffId="staff-1"></inbox-panel>`, container);
		const panel = container.querySelector("inbox-panel") as any;
		await panel.updateComplete;

		expect(panel.textContent).toContain("advisory");
		expect(panel.querySelector(".inbox-review-consent-btn")).toBeNull();
		expect(panel.querySelector(".inbox-cancel-btn")).not.toBeNull();
	});
});
