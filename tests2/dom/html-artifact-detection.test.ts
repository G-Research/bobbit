import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Migrated from tests/html-artifact-detection.spec.ts (v2-dom tier).
 *
 * The legacy fixture inlined `isHtmlContent` (a copy of the detection helper
 * that was extracted from goal-dashboard.ts for testing) and asserted a table
 * of 12 cases via window.__testResults. There is no exported real symbol in src
 * to import (the helper lives inline), so we port the exact function and the
 * exact case table, promoting each case to a first-class assertion so the same
 * user-visible behavior is pinned with no weakening.
 */
import { describe, expect, it } from "vitest";

/** isHtmlContent — extracted from goal-dashboard.ts for testing. */
function isHtmlContent(content: string): boolean {
	const trimmed = content.trimStart();
	return trimmed.startsWith("<!") || trimmed.startsWith("<html");
}

const cases: Array<{ input: string; expected: boolean; name: string }> = [
	// Should detect as HTML
	{ input: "<!DOCTYPE html><html><body>Hi</body></html>", expected: true, name: "doctype html" },
	{ input: "<html><body>Hi</body></html>", expected: true, name: "html tag" },
	{ input: "  <!DOCTYPE html>\n<html>", expected: true, name: "leading whitespace doctype" },
	{ input: '\n\n<html lang="en">', expected: true, name: "leading newlines html" },
	{ input: "<!DOCTYPE html>\n<html>\n<head>", expected: true, name: "full html start" },

	// Should NOT detect as HTML
	{ input: "# Markdown heading\nSome text", expected: false, name: "markdown" },
	{ input: '{"key": "value"}', expected: false, name: "json" },
	{ input: "Plain text content", expected: false, name: "plain text" },
	{ input: "<div>Not a full HTML doc</div>", expected: false, name: "html fragment div" },
	{ input: "<p>Paragraph</p>", expected: false, name: "html fragment p" },
	{ input: "", expected: false, name: "empty string" },
	{ input: "   \n  # Heading", expected: false, name: "whitespace then markdown" },
];

describe("isHtmlContent detection", () => {
	for (const c of cases) {
		it(`${c.name} → ${c.expected}`, () => {
			expect(isHtmlContent(c.input)).toBe(c.expected);
		});
	}
});
