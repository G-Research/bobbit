import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Test that reproduces the annotation dismiss focus bug (PI-24b).
 * After pressing Escape to dismiss the annotation popover, focus should
 * return to the review document content area, not be lost to document.body.
 */

const REVIEW_DOC_PATH = path.resolve(
	import.meta.dirname ?? __dirname,
	"../src/ui/components/review/ReviewDocument.ts",
);

test.describe("Annotation Focus Bug", () => {
	let source: string;

	test.beforeAll(() => {
		source = fs.readFileSync(REVIEW_DOC_PATH, "utf-8");
	});

	test("BUG: _onAnnotationCancel does not restore focus after dismiss (PI-24b)", () => {
		// Bug 5: When user presses Escape to dismiss the annotation popover,
		// _onAnnotationCancel() cleans up annotation state but performs no focus
		// management. Focus is lost to document.body.
		//
		// The fix: After setting _popoverOpen = false in _onAnnotationCancel,
		// focus the review document's content wrapper or the host element.

		// Extract the _onAnnotationCancel method body
		const cancelMethodStart = source.indexOf("_onAnnotationCancel(): void {");
		expect(cancelMethodStart).toBeGreaterThan(-1);

		// Get the method body (find the matching closing brace)
		const methodSource = source.substring(cancelMethodStart, cancelMethodStart + 500);

		// BUG: The method doesn't contain any focus() call
		// After fix, it should focus the content area or host element
		const hasFocusCall = /\.focus\(\)/.test(methodSource);
		expect(hasFocusCall).toBe(true);
	});
});
