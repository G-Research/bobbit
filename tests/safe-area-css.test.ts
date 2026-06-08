/**
 * Pins the iOS-PWA full-screen / safe-area CSS for installed standalone PWAs.
 *
 * Three distinct iOS-standalone bugs are covered (all observed on-device — iOS
 * safe-area insets and the "viewport lie" can't be emulated in headless
 * Chromium, so we assert on the stylesheet/HTML source, same approach as
 * tests/index-html-meta.test.ts):
 *
 *   1. "Bottom dead band" — iOS standalone reports a layout viewport SHORTER
 *      than the screen (by safe-area-inset-top) and pins content to the top,
 *      leaving a dead band at the bottom. `100dvh`/`100%`/`-webkit-fill-available`
 *      all resolve to the short value; only making html/body 1px TALLER than the
 *      lying viewport forces iOS to recalculate to the true screen height.
 *      We use `100vh` (the static large viewport) NOT `100dvh` so the on-screen
 *      keyboard opening/closing doesn't re-trigger iOS's slide animation.
 *      Mirrored inline in index.html so the recalc fires at first paint.
 *
 *   2. "Top cut off" — the connected chat view's header is `position: fixed`,
 *      which anchors to the viewport and IGNORES the shell's padding, so it
 *      must carry the status-bar inset itself.
 *
 *   3. Composer bottom padding reserves only HALF the home-indicator inset so
 *      the UI sits flush with the indicator line rather than wasting the whole
 *      strip (the rounded screen corners eat the extreme bottom anyway).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const css = readFileSync(resolve(root, "src", "ui", "app.css"), "utf8");
const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");

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

describe("ui/app.css — iOS PWA full-screen + safe-area rules", () => {
	const block = standaloneBlock(css);

	it("triggers the iOS viewport recalc with calc(100vh + 1px) on html/body (NOT 100dvh — keyboard would re-animate)", () => {
		assert.match(
			block,
			/html\s*,\s*body\s*\{\s*height:\s*calc\(100vh \+ 1px\)/,
			"html/body must be 1px taller than the lying viewport via 100vh (static across the keyboard)",
		);
		// Guard against a regression back to the dynamic unit that re-fires the slide.
		assert.doesNotMatch(block, /height:\s*calc\(100dvh \+ 1px\)/);
		assert.match(block, /\.app-shell\s*\{\s*height:\s*100vh/);
	});

	it("base .app-shell reserves all four safe-area insets", () => {
		assert.match(block, /\.app-shell\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/);
		assert.match(block, /\.app-shell\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
	});

	it("connected mobile layout zeroes the shell's top/bottom insets (fixed header + composer own them)", () => {
		assert.match(
			block,
			/\.app-shell\[data-mobile-header\]\s*\{[^}]*padding-top:\s*0[^}]*padding-bottom:\s*0/,
			"the [data-mobile-header] shell must zero top/bottom padding; the fixed header and composer carry those insets",
		);
	});

	it("fixed header carries the top inset itself (it ignores the shell's padding)", () => {
		assert.match(
			block,
			/\[data-mobile-header\]\s*#app-header\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/,
		);
	});

	it("composer reserves only HALF the bottom inset (flush with the home-indicator line, no wasted strip)", () => {
		assert.match(
			block,
			/\[data-mobile-header\][^{]*\.agent-input-area\s*\{[^}]*padding-bottom:\s*calc\(0\.25rem \+ env\(safe-area-inset-bottom\) \/ 2\)/,
		);
	});
});

describe("index.html — inline iOS viewport recalc trigger", () => {
	it("mirrors the calc(100vh + 1px) trigger inline so the recalc fires at first paint (hidden behind the launch animation)", () => {
		assert.match(
			indexHtml,
			/@media \(display-mode: standalone\)\s*\{\s*html,\s*body\s*\{\s*height:\s*calc\(100vh \+ 1px\)/,
		);
	});
});
