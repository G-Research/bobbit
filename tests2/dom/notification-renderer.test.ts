import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/notification-renderer.spec.ts (v2-dom tier).
// The legacy Playwright fixture MIRRORED the renderer logic in plain JS. This
// port renders the REAL system-notification message renderer (registered by
// src/app/custom-messages.ts, retrieved via the message-renderer registry) into
// happy-dom via lit — higher fidelity than the inlined copy. No geometry.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { render } from "lit";
import { getMessageRenderer, type MessageRenderer } from "../../src/ui/components/message-renderer-registry.js";

let notifRenderer: MessageRenderer;

beforeAll(async () => {
	// session-manager first breaks the pack-panels ⇄ session-manager TDZ cycle
	// before custom-messages → Messages.js → app/* imports hit it.
	await import("../../src/app/session-manager.js");
	// custom-messages registers its renderers via an explicit function (not a
	// top-level side-effect), so import it and invoke the registrar.
	const { registerCustomMessageRenderers } = await import("../../src/app/custom-messages.js");
	registerCustomMessageRenderers();
	__syncCE();
	const r = getMessageRenderer("system-notification");
	if (!r) throw new Error("system-notification renderer not registered");
	notifRenderer = r;
});

const makeNotif = (message: string, category?: string) => ({
	role: "system-notification" as const,
	message,
	variant: "default" as const,
	category: category as any,
	timestamp: new Date().toISOString(),
});

function renderAll(): HTMLElement {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	const notifs = [
		makeNotif("Test system notification", "system"),
		makeNotif("Test task notification", "task"),
		makeNotif("Test team notification", "team"),
		makeNotif("Test error notification", "error"),
		makeNotif("Default notification", undefined),
	];
	render(notifs.map(n => notifRenderer.render(n as any)), container);
	return container;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("notification renderer", () => {
	it("renders correct DOM structure per category", () => {
		const container = renderAll();
		const notifications = container.querySelectorAll(".notification-inline");
		expect(notifications.length).toBe(5);
		expect(notifications[0].className).toMatch(/notification-system/);
		expect(notifications[1].className).toMatch(/notification-task/);
		expect(notifications[2].className).toMatch(/notification-team/);
		expect(notifications[3].className).toMatch(/notification-error/);
		// Default (no category) falls back to system.
		expect(notifications[4].className).toMatch(/notification-system/);
	});

	it("each notification has icon, text, and time spans", () => {
		const container = renderAll();
		const first = container.querySelector(".notification-inline")!;
		expect(first.querySelectorAll(".notification-icon").length).toBe(1);
		expect(first.querySelectorAll(".notification-text").length).toBe(1);
		expect(first.querySelectorAll(".notification-time").length).toBe(1);
	});

	it("category icons are correct", () => {
		const container = renderAll();
		const icons = container.querySelectorAll(".notification-icon");
		expect(icons[0].textContent).toBe("\u27F3"); // system
		expect(icons[1].textContent).toBe("\u2713"); // task
		expect(icons[2].textContent).toBe("\u25CF"); // team
		expect(icons[3].textContent).toBe("\u2715"); // error
	});

	it("notification text content is rendered", () => {
		const container = renderAll();
		const texts = container.querySelectorAll(".notification-text");
		expect(texts[0].textContent).toBe("Test system notification");
		expect(texts[1].textContent).toBe("Test task notification");
		expect(texts[2].textContent).toBe("Test team notification");
		expect(texts[3].textContent).toBe("Test error notification");
	});
});
