import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headerToast, showHeaderToast } from "../../src/app/header-toast.js";
import { setRenderApp } from "../../src/app/state.js";

const FEEDBACK = '[data-testid="launcher-feedback"]';
const DISMISS = '[data-testid="launcher-feedback-dismiss"]';
const HEADER_TOAST = '[data-testid="header-toast"]';

let host: HTMLElement;

function repaint(): void {
	render(headerToast(), host);
}

function emitLauncherFeedback(kind: "pending" | "resolved" | "error", message = ""): void {
	window.dispatchEvent(new CustomEvent("bobbit-launcher-feedback", {
		detail: { kind, message },
	}));
	repaint();
}

beforeEach(() => {
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.appendChild(host);
	setRenderApp(repaint);
	emitLauncherFeedback("resolved");
});

afterEach(() => {
	emitLauncherFeedback("resolved");
	vi.runAllTimers();
	vi.clearAllTimers();
	vi.useRealTimers();
	setRenderApp(() => {});
	render(null, host);
	document.body.innerHTML = "";
});

describe("header launcher feedback", () => {
	it("renders extension-derived pending feedback until a resolved event", () => {
		emitLauncherFeedback("pending", "Starting Custom Extension…");

		const feedback = host.querySelector<HTMLElement>(FEEDBACK);
		expect(feedback?.dataset.kind).toBe("pending");
		expect(feedback?.textContent).toContain("Starting Custom Extension…");
		expect(feedback?.querySelector("svg.animate-spin")).not.toBeNull();
		expect(host.querySelector(DISMISS)).toBeNull();

		emitLauncherFeedback("resolved");
		expect(host.querySelector(FEEDBACK)).toBeNull();
	});

	it("keeps error feedback until its real dismiss control is clicked", () => {
		emitLauncherFeedback("error", "Could not start Custom Extension.");

		let feedback = host.querySelector<HTMLElement>(FEEDBACK);
		expect(feedback?.dataset.kind).toBe("error");
		expect(feedback?.textContent).toContain("Could not start Custom Extension.");
		expect(feedback?.querySelector("svg.animate-spin")).toBeNull();

		vi.advanceTimersByTime(60_000);
		repaint();
		expect(host.querySelector(FEEDBACK)).not.toBeNull();

		const dismiss = host.querySelector<HTMLButtonElement>(DISMISS);
		expect(dismiss?.title).toBe("Dismiss");
		dismiss?.click();
		repaint();
		feedback = host.querySelector(FEEDBACK);
		expect(feedback).toBeNull();
	});

	it("keeps transient header and persistent launcher timers independent", () => {
		emitLauncherFeedback("pending", "Starting Custom Extension…");
		showHeaderToast("Link copied");
		repaint();

		expect(host.querySelector(HEADER_TOAST)?.textContent).toBe("Link copied");
		expect(host.querySelector(FEEDBACK)?.textContent).toContain("Starting Custom Extension…");

		vi.advanceTimersByTime(2_499);
		repaint();
		expect(host.querySelector(HEADER_TOAST)).not.toBeNull();
		expect(host.querySelector(FEEDBACK)).not.toBeNull();

		vi.advanceTimersByTime(1);
		repaint();
		expect(host.querySelector(HEADER_TOAST)).toBeNull();
		expect(host.querySelector(FEEDBACK)?.textContent).toContain("Starting Custom Extension…");

		showHeaderToast("Second header message");
		emitLauncherFeedback("resolved");
		expect(host.querySelector(FEEDBACK)).toBeNull();
		expect(host.querySelector(HEADER_TOAST)?.textContent).toBe("Second header message");

		vi.advanceTimersByTime(2_500);
		repaint();
		expect(host.querySelector(HEADER_TOAST)).toBeNull();
	});
});
