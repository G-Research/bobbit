/**
 * Pins the iOS-PWA safe-area CSS for the connected mobile layout.
 *
 * The in-flow layouts (sidebar/landing/disconnected) get their status-bar
 * inset from `.app-shell { padding-top: env(safe-area-inset-top) }`. But the
 * connected chat view renders its header as `position: fixed`, which anchors
 * to the viewport and IGNORES the shell's padding — so the header lands under
 * the status bar ("top cut off") unless it carries the inset itself. The
 * bottom is handled by NOT reserving the home-indicator inset at all (the
 * composer runs edge-to-edge), since reserving it just left an empty dark band
 * below the composer in the full-screen PWA. This regression test guards the
 * scoped rules that zero the shell's top/bottom insets and move the top inset
 * onto the fixed header.
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

	it("connected mobile layout zeroes the shell's top/bottom insets (fixed header owns top; composer runs edge-to-edge at bottom)", () => {
		assert.match(
			block,
			/\.app-shell\[data-mobile-header\]\s*\{[^}]*padding-top:\s*0[^}]*padding-bottom:\s*0/,
			"the [data-mobile-header] shell must zero top/bottom padding so the fixed header fills the top and the composer fills the bottom edge",
		);
	});

	it("fixed header carries the top inset itself (it ignores the shell's padding)", () => {
		assert.match(
			block,
			/\[data-mobile-header\]\s*#app-header\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/,
		);
	});

	it("does NOT reserve a bottom safe-area inset in the connected layout (no empty band below the composer)", () => {
		// The home-indicator inset would only render as wasted dark space here,
		// so nothing in the standalone block should pad the bottom for it except
		// the shell's base rule (which the [data-mobile-header] override zeroes).
		assert.doesNotMatch(
			block,
			/agent-input-area[^}]*env\(safe-area-inset-bottom\)/,
			"the composer must not reserve the bottom inset (it runs edge-to-edge)",
		);
	});
});
