// Pins the boot-order pattern for shortcut hint titles.
//
// src/app/main.ts::initApp() runs this sequence:
//   1. renderApp()                                   (~line 389)
//   2. registerShortcut("new-goal", ...)             (~line 651, inside the
//                                                     shortcut-registry block)
//   3. await loadSavedBindings(); startListening();   (lines ~711–712)
//   4. document.body.dataset.shortcutsReady = "1";    (~line 717)
//   5. renderApp()                                   (~line 724 — the fix)
//
// Lit templates of the form
//     title=${`New goal${shortcutHint("new-goal")}`}
// evaluate `shortcutHint("new-goal")` at render time. Step 1 stamps the empty
// string (no shortcuts registered yet) so the button's title is just
// "New goal". Without step 5 the title would stay stale — users hovering
// after a cold boot would see no `(Alt+G)` hint until some incidental render
// fired. Under heavy parallel e2e load this race caused ~10 flaky tests that
// waited for `button[title='New goal (Alt+G)']`.
//
// This file:// fixture wires the REAL `shortcutHint`/`registerShortcut` from
// src/app/shortcut-registry.ts to a Lit template that mirrors the production
// new-goal button, then drives the same boot sequence including the post-
// registration render. The assertion below pins step 5: remove that render
// here AND in src/app/main.ts and the bug returns.
//
// If you change the boot order in src/app/main.ts::initApp(), update the
// fixture entry (tests/fixtures/shortcut-hint-titles-render-entry.ts) and
// the page.evaluate block below to match.
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

	// Simulate the production boot order — mirrors src/app/main.ts::initApp().
	await page.evaluate(() => {
		const container = document.getElementById("container")!;
		// Step 1: initial render — happens BEFORE any shortcut is registered.
		// shortcutHint("new-goal") returns "" so the title is stamped bare.
		(window as any).__renderInitial(container);
		// Step 2: shortcut registration (Alt+G).
		(window as any).__registerNewGoal();
		// Step 3+4: startListening() + shortcutsReady marker.
		(window as any).__finishInit();
		// Step 5: post-registration render — refreshes the stale
		// `${shortcutHint(...)}` evaluation that was stamped as "" in step 1.
		// This is the fix. Removing this line reproduces the original bug.
		(window as any).__renderInitial(container);
	});

	// Wait until the boot-complete marker is set so we know step 4 ran.
	await page.waitForFunction(() => document.body.dataset.shortcutsReady === "1", null, { timeout: 5_000 });

	const title = await page.evaluate(() => (window as any).__getButtonTitle());

	// The button MUST end up with the (Alt+G) hint after the full boot
	// sequence. Failing here is the bug.
	expect(title, `Expected button title ${JSON.stringify(title)} to include 'Alt+G'`).toContain("Alt+G");
});
