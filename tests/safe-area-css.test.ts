/**
 * Pins the iOS-PWA safe-area CSS for the connected mobile layout.
 *
 * The in-flow layouts (sidebar/landing/disconnected) get their status-bar
 * inset from `.app-shell { padding-top: env(safe-area-inset-top) }`. But the
 * connected chat view renders its header as `position: fixed`, which anchors
 * to the viewport and IGNORES the shell's padding — so the header lands under
 * the status bar ("top cut off") unless it carries the inset itself, and the
 * shell's bottom inset shows as a detached blank band below the composer
 * ("blank space at bottom"). This regression test guards the scoped rules that
 * move those insets onto the header (top) and composer (bottom).
 *
 * iOS safe-area insets can't be emulated in Playwright/headless Chromium
 * (env(safe-area-inset-*) is always 0), so we assert on the stylesheet source
 * — same approach as tests/index-html-meta.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "..", "src", "ui", "app.css"), "utf8");

/** Extract the body of the `@media (display-mode: standalone) { ... }` block. */
function standaloneBlock(source: string): string {
	const start = source.indexOf("@media (display-mode: standalone)");
	assert.ok(start >= 0, "a @media (display-mode: standalone) block must exist");
	const braceStart = source.indexOf("{", start);
	let depth = 0;
	for (let i = braceStart; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(braceStart + 1, i);
		}
	}
	throw new Error("unbalanced braces in standalone media block");
}

describe("ui/app.css — iOS PWA safe-area rules", () => {
	const block = standaloneBlock(css);

	it("base .app-shell reserves all four safe-area insets", () => {
		assert.match(block, /\.app-shell\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/);
		assert.match(block, /\.app-shell\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
	});

	it("connected mobile layout drops the shell's top/bottom insets (fixed header + flush composer own them)", () => {
		assert.match(
			block,
			/\.app-shell\[data-mobile-header\]\s*\{[^}]*padding-top:\s*0[^}]*padding-bottom:\s*0/,
			"the [data-mobile-header] shell must zero top/bottom padding so the fixed header and composer fill those edges",
		);
	});

	it("fixed header carries the top inset itself (it ignores the shell's padding)", () => {
		assert.match(
			block,
			/\[data-mobile-header\]\s*#app-header\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/,
		);
	});

	it("composer extends through the bottom inset so there is no detached blank band", () => {
		assert.match(
			block,
			/\[data-mobile-header\][^{]*\.agent-input-area\s*\{[^}]*padding-bottom:\s*calc\(0\.25rem \+ env\(safe-area-inset-bottom\)\)/,
		);
	});
});
