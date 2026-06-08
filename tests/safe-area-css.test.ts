/**
 * Pins the iOS-PWA safe-area CSS for the connected mobile layout.
 *
 * Two distinct iOS-standalone bugs are covered:
 *
 *   1. "Top cut off" — the connected chat view's header is `position: fixed`,
 *      which anchors to the viewport and IGNORES the shell's padding, so it
 *      must carry the status-bar inset itself.
 *
 *   2. "Blank band at the bottom" — `100dvh` resolves SHORT by the
 *      home-indicator inset on installed iOS PWAs, so the shell stops above
 *      the screen bottom and the body background shows through. The standalone
 *      block re-anchors the height chain to the document (height:100%) so the
 *      shell fills the true screen edge; the composer then carries the bottom
 *      inset so its background fills the indicator region with controls above.
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

	it("anchors the height chain to the document so the shell fills the full screen (no 100dvh bottom gap)", () => {
		assert.match(
			block,
			/html\s*,\s*body\s*,\s*#app\s*\{\s*height:\s*100%/,
			"standalone must set html/body/#app to height:100% so the shell reaches the true screen edge",
		);
		assert.match(block, /\.app-shell\s*\{\s*height:\s*100%/);
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

	it("composer carries the bottom inset so its background fills the home-indicator region", () => {
		assert.match(
			block,
			/\[data-mobile-header\][^{]*\.agent-input-area\s*\{[^}]*padding-bottom:\s*calc\(0\.25rem \+ env\(safe-area-inset-bottom\)\)/,
		);
	});
});
