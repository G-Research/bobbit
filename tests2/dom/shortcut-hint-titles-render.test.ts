import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/shortcut-hint-titles-render.spec.ts (v2-dom tier).
// Pins the boot-order fix in src/app/main.ts::initApp(): a lit `title` binding of
// the form `title=${`New goal${shortcutHint("new-goal")}`}` is stamped as a bare
// title on the first render (before any shortcut is registered), then must be
// refreshed by the post-registration render so the (Alt+G) hint appears.
//
// This port wires the REAL shortcutHint/registerShortcut/startListening from
// src/app/shortcut-registry.ts to a lit template that mirrors the production
// new-goal button, then drives the same boot sequence including the post-
// registration render. Removing that final render (here AND in main.ts)
// reproduces the original stale-title bug.
import { afterEach, describe, expect, it } from "vitest";
import { html, render } from "lit";
import {
	registerShortcut,
	shortcutHint,
	startListening,
	unregisterShortcut,
} from "../../src/app/shortcut-registry.js";

const newGoalButton = () => html`
	<button
		data-new-goal-trigger
		title=${`New goal${shortcutHint("new-goal")}`}
	>New goal</button>
`;

afterEach(() => {
	unregisterShortcut("new-goal");
	document.body.innerHTML = "";
	delete document.body.dataset.shortcutsReady;
});

describe("shortcut hint titles render after boot", () => {
	it("button title rendered before shortcut registration includes the shortcut suffix after boot completes", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		// Ensure no stale registration leaks in from another file's registry.
		unregisterShortcut("new-goal");

		// Step 1: initial render — BEFORE any shortcut is registered.
		// shortcutHint("new-goal") returns "" so the title is stamped bare.
		render(newGoalButton(), container);
		expect(container.querySelector<HTMLButtonElement>("button[data-new-goal-trigger]")?.title).toBe("New goal");

		// Step 2: shortcut registration (Alt+G) — mirrors main.ts.
		registerShortcut({
			id: "new-goal",
			label: "New goal",
			category: "Goals",
			defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
			handler: () => {},
		});

		// Step 3+4: startListening() + shortcutsReady marker.
		startListening();
		document.body.dataset.shortcutsReady = "1";

		// Step 5: post-registration render — refreshes the stale hint stamped in
		// step 1. This is the fix; removing it reproduces the bug.
		render(newGoalButton(), container);

		expect(document.body.dataset.shortcutsReady).toBe("1");
		const title = container.querySelector<HTMLButtonElement>("button[data-new-goal-trigger]")?.title ?? null;
		expect(title, `Expected button title ${JSON.stringify(title)} to include 'Alt+G'`).toContain("Alt+G");
	});
});
