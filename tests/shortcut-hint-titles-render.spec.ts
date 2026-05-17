// Reproduces the "stale shortcut hint titles" bug.
//
// In src/app/main.ts::initApp() the boot order is:
//   1. renderApp()                                   (~line 389)
//   2. registerShortcut("new-goal", ...)             (~line 651, inside the
//                                                     shortcut-registry block)
//   3. await loadSavedBindings(); startListening();   (lines ~711–712)
//   4. document.body.dataset.shortcutsReady = "1";    (~line 717)
//
// There is NO `renderApp()` call after step 4. Lit templates of the form
//     title=${`New goal${shortcutHint("new-goal")}`}
// evaluate `shortcutHint("new-goal")` at render time. Step 1 stamps the empty
// string (no shortcuts registered yet) so the button's title is just
// "New goal". Without a post-registration re-render the title stays stale —
// users hovering after a cold boot see no `(Alt+G)` hint until some
// incidental render fires.
//
// This file:// fixture wires the REAL `shortcutHint`/`registerShortcut` from
// src/app/shortcut-registry.ts to a Lit template that mirrors the production
// new-goal button, then drives the same boot sequence. The assertion below
// fails on master and passes once the missing `renderApp()` is added.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/shortcut-hint-titles-render.html");
const BUNDLE = path.resolve("tests/fixtures/shortcut-hint-titles-render-bundle.js");
const ENTRY = path.resolve("tests/fixtures/shortcut-hint-titles-render-entry.ts");
const REGISTRY_SRC = path.resolve("src/app/shortcut-registry.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, REGISTRY_SRC] });
});

const PAGE = `file://${FIXTURE}`;

test("button title rendered before shortcut registration includes the shortcut suffix after boot completes", async ({ page }) => {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

	// Simulate the production boot order.
	await page.evaluate(() => {
		const container = document.getElementById("container")!;
		// Step 1: initial render — happens BEFORE any shortcut is registered.
		// shortcutHint("new-goal") returns "" so the title is stamped bare.
		(window as any).__renderInitial(container);
		// Step 2: shortcut registration (Alt+G).
		(window as any).__registerNewGoal();
		// Step 3+4: startListening() + shortcutsReady marker.
		// Crucially we do NOT call renderInitial() again here — production
		// code (src/app/main.ts) is missing that second render.
		(window as any).__finishInit();
	});

	// Wait until the boot-complete marker is set so we know step 4 ran.
	await page.waitForFunction(() => document.body.dataset.shortcutsReady === "1", null, { timeout: 5_000 });

	const title = await page.evaluate(() => (window as any).__getButtonTitle());

	// The button MUST end up with the (Alt+G) hint after the full boot
	// sequence. Failing here is the bug.
	expect(title, `Expected button title ${JSON.stringify(title)} to include 'Alt+G'`).toContain("Alt+G");
});
