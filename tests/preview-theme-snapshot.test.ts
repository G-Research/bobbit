/**
 * Unit tests for `src/server/preview/theme-snapshot.ts`.
 *
 * The snapshot reads `src/ui/app.css` from the live source tree at module
 * load and caches the result. We verify (a) the parser, (b) the public
 * `getPreviewThemeSnapshot()` shape against the real app.css.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getPreviewThemeSnapshot,
	parseThemeBlocks,
	_resetPreviewThemeSnapshotCache,
} from "../src/server/preview/theme-snapshot.ts";

describe("parseThemeBlocks", () => {
	it("captures top-level :root and .dark declarations", () => {
		const css = `
:root {
	--background: oklch(0.9 0 0);
	--foreground: #111;
}
.dark {
	--background: #000;
	--foreground: oklch(0.95 0 0);
}
`;
		const { root, dark } = parseThemeBlocks(css);
		assert.equal(root["--background"], "oklch(0.9 0 0)");
		assert.equal(root["--foreground"], "#111");
		assert.equal(dark["--background"], "#000");
		assert.equal(dark["--foreground"], "oklch(0.95 0 0)");
	});

	it("merges multiple :root blocks (last-wins)", () => {
		const css = `
:root { --a: 1; --b: 2; }
:root { --a: 3; --c: 4; }
`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--a"], "3");
		assert.equal(root["--b"], "2");
		assert.equal(root["--c"], "4");
	});

	it("ignores non-custom-property declarations", () => {
		const css = `:root { color: red; --x: 1; font-size: 12px; }`;
		const { root } = parseThemeBlocks(css);
		assert.deepEqual(Object.keys(root).sort(), ["--x"]);
	});

	it("strips block comments", () => {
		const css = `:root { /* --hidden: x; */ --visible: y; }`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--visible"], "y");
		assert.equal(root["--hidden"], undefined);
	});

	it("handles selector lists like ':root, .foo'", () => {
		const css = `:root, [data-x] { --a: 1; }`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--a"], "1");
	});

	it("skips at-rule blocks (e.g. @media)", () => {
		const css = `
@media (min-width: 1px) {
	:root { --inside-media: nope; }
}
:root { --top: yes; }
`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--top"], "yes");
		assert.equal(root["--inside-media"], undefined);
	});

	it("skips simple at-rules (e.g. @import; @source)", () => {
		const css = `
@import "x.css";
@source "../foo";
:root { --a: 1; }
`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--a"], "1");
	});

	it("preserves balanced parens in values (oklch with spaces)", () => {
		const css = `:root { --c: oklch(0.21 0.008 145); --d: rgb(1, 2, 3); }`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--c"], "oklch(0.21 0.008 145)");
		assert.equal(root["--d"], "rgb(1, 2, 3)");
	});

	it("rejects malformed token names", () => {
		const css = `:root { --good: 1; --bad name: 2; }`;
		const { root } = parseThemeBlocks(css);
		assert.equal(root["--good"], "1");
		// "--bad name" should not be captured.
		assert.equal(Object.keys(root).filter(k => k.includes(" ")).length, 0);
	});
});

describe("getPreviewThemeSnapshot (live app.css)", () => {
	it("returns a single <style> block wrapping :root and .dark blocks", () => {
		_resetPreviewThemeSnapshotCache();
		const snap = getPreviewThemeSnapshot();
		assert.ok(snap.length > 0, "snapshot must be non-empty");
		// One opening + one closing style tag.
		assert.equal((snap.match(/<style\b/g) || []).length, 1);
		assert.equal((snap.match(/<\/style>/g) || []).length, 1);
		assert.match(snap, /data-bobbit-preview-theme="snapshot"/);
		assert.match(snap, /:root\s*\{/);
		assert.match(snap, /\.dark\s*\{/);
	});

	it("contains canonical theme tokens", () => {
		const snap = getPreviewThemeSnapshot();
		// Spot-check the headline tokens used in the design-system contract.
		for (const tok of [
			"--background",
			"--foreground",
			"--card",
			"--muted-foreground",
			"--border",
			"--primary",
			"--chart-1",
			"--positive",
			"--negative",
			"--warning",
			"--info",
		]) {
			assert.ok(snap.includes(`${tok}:`), `expected ${tok} in snapshot`);
		}
	});

	it("is cached on subsequent calls (same instance)", () => {
		const a = getPreviewThemeSnapshot();
		const b = getPreviewThemeSnapshot();
		assert.equal(a, b);
	});
});
