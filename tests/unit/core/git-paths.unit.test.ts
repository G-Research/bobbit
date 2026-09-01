import { describe, expect, it } from "vitest";
import { parseNullDelimitedGitPaths } from "../../../scripts/testing/git-paths.mjs";

describe("NUL-safe Git paths", () => {
	it("preserves whitespace, newlines, and Windows separators", () => {
		expect(parseNullDelimitedGitPaths(Buffer.from(
			"tests/dom/a b.dom.test.ts\0tests/dom/line\nb.dom.test.ts\0tests\\dom\\windows.dom.test.ts\0",
		))).toEqual([
			"tests/dom/a b.dom.test.ts",
			"tests/dom/line\nb.dom.test.ts",
			"tests\\dom\\windows.dom.test.ts",
		]);
	});

	it("accepts text output and ignores the final empty record", () => {
		expect(parseNullDelimitedGitPaths("tests/unit/core/one.unit.test.ts\0")).toEqual([
			"tests/unit/core/one.unit.test.ts",
		]);
	});
});
