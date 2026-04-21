/**
 * Ensures index.html contains the meta tags required for correct iOS PWA
 * rendering (viewport-fit=cover + safe-area insets). Regression test for the
 * blank-gap at the top of the viewport on installed iPhone PWAs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "..", "index.html"), "utf8");

describe("index.html meta tags (iOS PWA)", () => {
	it("viewport meta includes viewport-fit=cover", () => {
		const m = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
		assert.ok(m, "viewport meta tag present");
		assert.match(m![1], /width=device-width/);
		assert.match(m![1], /initial-scale=1(\.0)?/);
		assert.match(m![1], /viewport-fit=cover/);
	});

	it("declares apple-mobile-web-app-capable (legacy) and mobile-web-app-capable (modern)", () => {
		assert.match(html, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
		assert.match(html, /<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
	});

	it("declares apple-mobile-web-app-status-bar-style=black-translucent", () => {
		assert.match(
			html,
			/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/,
		);
	});
});
