/**
 * Pins the proposal-panel lazy-load error contract: a failed chunk import must
 * surface an error card with Retry / Reload affordances, NEVER an indefinite
 * spinner.
 *
 * Regression: the goal-proposal panel is lazy-loaded via proposal-panels-lazy.ts.
 * Its `import("./proposal-panels.js")` had no `.catch`, so when the dev-server's
 * vite optimizer cache was wiped (504 on the chunk's deps) the dynamic import
 * rejected silently and the panel spun forever. The loader now records the
 * failure and renders this error state instead.
 *
 * Mirrors the analogous tool-renderer invariant in
 * tests/lazy-renderer-placeholder.spec.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProposalPanelPlaceholder } from "../src/app/proposal-panel-placeholder.ts";

test("error state renders the error card (not a spinner) with retry/reload", () => {
	const tr = renderProposalPanelPlaceholder({
		error: new Error("Failed to fetch dynamically imported module"),
		onRetry: () => {},
		onReload: () => {},
	});
	const staticHtml = tr.strings.join("\u0000");
	assert.match(staticHtml, /proposal-panel-load-error/, "error testid present");
	assert.match(staticHtml, /proposal-panel-retry/, "retry button present");
	assert.match(staticHtml, /Reload page/, "reload affordance present");
	// The failure detail is interpolated as a dynamic value.
	assert.ok(
		tr.values.includes("Failed to fetch dynamically imported module"),
		"surfaces the underlying error message",
	);
});

test("non-Error rejection values are stringified into the detail", () => {
	const tr = renderProposalPanelPlaceholder({ error: "boom", onRetry: () => {}, onReload: () => {} });
	assert.ok(tr.values.includes("boom"));
});

test("retry and reload click handlers are wired to the supplied callbacks", () => {
	let retried = 0;
	let reloaded = 0;
	const tr = renderProposalPanelPlaceholder({
		error: new Error("x"),
		onRetry: () => { retried++; },
		onReload: () => { reloaded++; },
	});
	// The two @click bindings are the only function values in the template.
	const handlers = tr.values.filter((v): v is () => void => typeof v === "function");
	assert.equal(handlers.length, 2, "exactly the retry + reload click handlers");
	for (const h of handlers) h();
	assert.equal(retried, 1, "retry callback invoked");
	assert.equal(reloaded, 1, "reload callback invoked");
});
