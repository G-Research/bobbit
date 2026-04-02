/**
 * Unit tests for parseQaReport() — extracts HTML from <qa_report> tags.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseQaReport } from "../dist/server/agent/verification-harness.js";

describe("parseQaReport", () => {
	it("extracts HTML from valid qa_report tags", () => {
		const output = "some text <qa_report><html><body>test</body></html></qa_report> more text";
		assert.equal(parseQaReport(output), "<html><body>test</body></html>");
	});

	it("returns null when no tags present", () => {
		assert.equal(parseQaReport("no report here"), null);
	});

	it("handles multiline HTML content", () => {
		const output = "<qa_report>\n<html>\n<body>\n<h1>Report</h1>\n</body>\n</html>\n</qa_report>";
		const result = parseQaReport(output);
		assert.ok(result?.includes("<h1>Report</h1>"));
	});

	it("is case-insensitive", () => {
		const output = "<QA_REPORT><html>test</html></QA_REPORT>";
		assert.equal(parseQaReport(output), "<html>test</html>");
	});

	it("trims whitespace from extracted content", () => {
		const output = "<qa_report>  \n  <html>report</html>  \n  </qa_report>";
		assert.equal(parseQaReport(output), "<html>report</html>");
	});

	it("returns empty string for empty tags", () => {
		const output = "<qa_report></qa_report>";
		assert.equal(parseQaReport(output), "");
	});

	it("extracts only the first match", () => {
		const output = "<qa_report>first</qa_report> <qa_report>second</qa_report>";
		assert.equal(parseQaReport(output), "first");
	});
});
