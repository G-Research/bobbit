import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "vitest";

const renderSource = fs.readFileSync("src/app/render.ts", "utf8");
const htmlRendererSource = fs.readFileSync("src/ui/tools/renderers/HtmlRenderer.ts", "utf8");
const bridgeSource = fs.readFileSync("src/shared/preview-bridge-scripts.ts", "utf8");

describe("repository preview frame isolation source guards", () => {
	it("uses the exact script-only sandbox at all three repository HTML iframe sites", () => {
		assert.equal((renderSource.match(/sandbox="allow-scripts"/g) ?? []).length, 1);
		assert.equal((htmlRendererSource.match(/sandbox="allow-scripts"/g) ?? []).length, 2);
		assert.doesNotMatch(renderSource, /allow-same-origin/);
		assert.doesNotMatch(htmlRendererSource, /allow-same-origin/);
	});

	it("keeps opaque-frame compatibility free of parent and child DOM access", () => {
		assert.doesNotMatch(bridgeSource, /parent\.document|parent\.getComputedStyle/);
		assert.doesNotMatch(htmlRendererSource, /contentDocument|document\.open|document\.write/);
		assert.match(htmlRendererSource, /iframe\.srcdoc\s*=\s*prepareInlineHtml\(content\)/);
	});
});
