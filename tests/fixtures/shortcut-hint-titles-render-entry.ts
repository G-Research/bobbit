// Test entry — wires the REAL `shortcutHint`/`registerShortcut` from
// src/app/shortcut-registry.ts to a Lit template that mirrors the production
// new-goal button title (`title=${`New goal${shortcutHint("new-goal")}`}`).
//
// The test exercises the boot order of src/app/main.ts::initApp():
//   1. initial render (line ~389) — happens BEFORE any shortcut is registered,
//      so the title is stamped with an empty hint suffix;
//   2. shortcut registration (registerShortcut("new-goal") at line ~651);
//   3. startListening() + `document.body.dataset.shortcutsReady = "1"` (~717).
//
// After step 3 a second `renderApp()` runs (~line 724 of main.ts — the fix
// for the original stale-title bug). The pinning test asserts that, after
// the full boot sequence including that final render, the button's title
// contains the `(Alt+G)` suffix. Remove the final render call from
// src/app/main.ts AND the page.evaluate block in the spec and the bug
// returns.
import { html, render } from "lit";
import { registerShortcut, shortcutHint, startListening } from "../../src/app/shortcut-registry.js";

const newGoalButton = () => html`
	<button
		data-new-goal-trigger
		title=${`New goal${shortcutHint("new-goal")}`}
	>New goal</button>
`;

function renderInitial(container: HTMLElement) {
	// Simulates src/app/main.ts line ~389 — the first renderApp() call,
	// which runs BEFORE any shortcut has been registered. shortcutHint
	// returns "" at this point, so Lit stamps a bare "New goal" title.
	render(newGoalButton(), container);
}

function registerNewGoal() {
	// Simulates registerShortcut("new-goal") in src/app/main.ts line ~651.
	// Default binding is Alt+G — matches production.
	registerShortcut({
		id: "new-goal",
		label: "New goal",
		category: "Goals",
		defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
		handler: () => {},
	});
}

function finishInit() {
	// Simulates src/app/main.ts lines ~711–717:
	//   await loadSavedBindings();   (skipped — no IndexedDB needed for this pin)
	//   startListening();
	//   document.body.dataset.shortcutsReady = "1";
	startListening();
	document.body.dataset.shortcutsReady = "1";
}

(window as any).__renderInitial = renderInitial;
(window as any).__registerNewGoal = registerNewGoal;
(window as any).__finishInit = finishInit;
(window as any).__getButtonTitle = () =>
	document.querySelector<HTMLButtonElement>("button[data-new-goal-trigger]")?.title ?? null;

(window as any).__ready = true;
