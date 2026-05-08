/**
 * Unit-level smoke check for the `parent === window` guard inside
 * `PREVIEW_THEME_BRIDGE`.
 *
 * A faithful runtime simulation would need a real browser context (parent
 * frame + cross-origin checks), which is the territory of the existing
 * Playwright `tests/e2e/ui/preview-new-tab.spec.ts` "standalone tab" test.
 * Here we just pin two structural invariants that the runtime guard depends
 * on:
 *
 *   1. The bridge string contains the `parent === window` early-return.
 *   2. The early-return appears *before* any `parent.document...` access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_THEME_BRIDGE } from "../src/shared/preview-bridge-scripts.ts";

describe("PREVIEW_THEME_BRIDGE — standalone-tab guard", () => {
	it("contains the parent === window early-return", () => {
		assert.match(PREVIEW_THEME_BRIDGE, /if\s*\(\s*parent\s*===\s*window\s*\)\s*return\s*;/);
	});

	it("guard appears before any parent.document access", () => {
		const guardIdx = PREVIEW_THEME_BRIDGE.search(/if\s*\(\s*parent\s*===\s*window\s*\)/);
		const accessIdx = PREVIEW_THEME_BRIDGE.indexOf("parent.document");
		assert.ok(guardIdx >= 0, "guard must be present");
		assert.ok(accessIdx >= 0, "bridge must still access parent.document for embedded iframes");
		assert.ok(guardIdx < accessIdx, "guard must precede every parent.document access");
	});

	it("evaluates without throwing when parent === window", () => {
		// Strip the <script>...</script> wrapper to get the raw IIFE body.
		const openIdx = PREVIEW_THEME_BRIDGE.indexOf("<script>");
		const closeIdx = PREVIEW_THEME_BRIDGE.indexOf("</script>");
		assert.ok(openIdx >= 0 && closeIdx > openIdx, "bridge must wrap an IIFE in <script> tags");
		const code = PREVIEW_THEME_BRIDGE.slice(openIdx + "<script>".length, closeIdx);
		// Minimal browser-shaped globals for the early-return path. The guard
		// hits BEFORE any DOM access, so we only need `parent` to equal `this`
		// (which we use as `window`).
		const fn = new Function("parent", "document", code);
		// In a standalone tab, parent === window. Pass the same object for both
		// `parent` and the function's `this` (via .call) — we only care that
		// the guard executes and the function returns cleanly.
		const fakeWindow = {} as Record<string, unknown>;
		assert.doesNotThrow(() => fn.call(fakeWindow, fakeWindow, {}));
	});
});
