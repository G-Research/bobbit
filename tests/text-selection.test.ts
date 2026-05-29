import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectText } from "../src/server/utils/text-selection.js";

function numberedLines(count: number, prefix = "line"): string {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

function outputLines(text: string): string[] {
	return text.length ? text.split("\n") : [];
}

function assertNoDefaultHint(result: { omittedHint?: string }): void {
	assert.equal(result.omittedHint, undefined, "explicit selection modes must not add the default omission hint");
}

describe("selectText", () => {
	it("defaults to a bounded tail with an agent-facing omission hint", () => {
		const result = selectText(numberedLines(120), {});

		assert.equal(result.mode, "tail");
		assert.equal(result.totalLines, 120);
		assert.deepEqual(result.range, { from: 41, to: 120 });
		assert.equal(outputLines(result.text).length, 80);
		assert.ok(!result.text.includes("line-40"));
		assert.ok(result.text.includes("line-41"));
		assert.ok(result.text.includes("line-120"));
		assert.match(result.omittedHint ?? "", /40 lines omitted.*mode="grep".*mode="slice"/i);
	});

	it("does not add the default omission hint for explicit head, tail, or slice modes", () => {
		const text = numberedLines(20);

		const tail = selectText(text, { mode: "tail", lines: 5 });
		assert.deepEqual(tail.range, { from: 16, to: 20 });
		assert.deepEqual(outputLines(tail.text), ["line-16", "line-17", "line-18", "line-19", "line-20"]);
		assertNoDefaultHint(tail);

		const head = selectText(text, { mode: "head", lines: 4 });
		assert.deepEqual(head.range, { from: 1, to: 4 });
		assert.deepEqual(outputLines(head.text), ["line-1", "line-2", "line-3", "line-4"]);
		assertNoDefaultHint(head);

		const slice = selectText(text, { mode: "slice", from: 7, to: 9 });
		assert.deepEqual(slice.range, { from: 7, to: 9 });
		assertNoDefaultHint(slice);
	});

	it("slice validates bounds and prefixes selected lines with stable line numbers", () => {
		const result = selectText(numberedLines(10), { mode: "slice", from: 3, to: 5 });

		assert.equal(result.mode, "slice");
		assert.equal(result.totalLines, 10);
		assert.deepEqual(result.range, { from: 3, to: 5 });
		assert.match(result.text, /^3\b.*line-3/m);
		assert.match(result.text, /^4\b.*line-4/m);
		assert.match(result.text, /^5\b.*line-5/m);
		assert.doesNotMatch(result.text, /line-2|line-6/);
		assert.equal(result.truncated, false);

		assert.throws(() => selectText(numberedLines(10), { mode: "slice", from: 0, to: 2 }), /from.*>=?\s*1|invalid.*range/i);
		assert.throws(() => selectText(numberedLines(10), { mode: "slice", from: 6, to: 5 }), /from.*to|invalid.*range/i);
		assert.throws(() => selectText(numberedLines(10), { mode: "slice", from: 1.5, to: 5 }), /integer|invalid.*range/i);
		assert.throws(() => selectText(numberedLines(10), { mode: "slice", from: 1 }), /to|required|invalid.*range/i);
	});

	it("grep handles regex matches, merged context ranges, zero matches, and invalid regex", () => {
		const text = [
			"one",
			"two",
			"before first",
			"ERROR first failure",
			"between failures",
			"failed second failure",
			"after second",
			"eight",
		].join("\n");

		const result = selectText(text, { mode: "grep", pattern: "ERROR|failed", context: 1 });

		assert.equal(result.mode, "grep");
		assert.equal(result.totalLines, 8);
		assert.equal(result.matchCount, 2);
		assert.equal(result.shownMatches, 2);
		assert.match(result.text, /^3\b.*before first/m);
		assert.match(result.text, /^4\b.*ERROR first failure/m);
		assert.match(result.text, /^5\b.*between failures/m);
		assert.match(result.text, /^6\b.*failed second failure/m);
		assert.match(result.text, /^7\b.*after second/m);
		assert.doesNotMatch(result.text, /^2\b|^8\b/m);
		assert.equal(outputLines(result.text).length, 5, "overlapping grep contexts should merge into one emitted range");
		assert.equal(result.truncated, false);

		const none = selectText(text, { mode: "grep", pattern: "NO_MATCH" });
		assert.equal(none.matchCount, 0);
		assert.equal(none.shownMatches, 0);
		assert.equal(none.text, "");
		assert.equal(none.truncated, false);

		assert.throws(() => selectText(text, { mode: "grep", pattern: "(" }), /invalid regex|unterminated|regular expression/i);
	});

	it("grep caps emitted matches with max_results metadata", () => {
		const text = Array.from({ length: 60 }, (_, i) => `ERROR cap-${i + 1}`).join("\n");
		const result = selectText(text, { mode: "grep", pattern: "ERROR", max_results: 3 });

		assert.equal(result.matchCount, 60);
		assert.equal(result.shownMatches, 3);
		assert.equal(outputLines(result.text).length, 3);
		assert.match(result.text, /cap-1/);
		assert.match(result.text, /cap-2/);
		assert.match(result.text, /cap-3/);
		assert.doesNotMatch(result.text, /cap-4/);
		assert.equal(result.truncated, true);
		assert.match(result.truncationReason ?? "", /max_results|matches/i);
	});

	it("full mode is an explicit escape hatch but still bounded", () => {
		const result = selectText(numberedLines(2_100), { mode: "full" });

		assert.equal(result.mode, "full");
		assert.equal(result.totalLines, 2_100);
		assert.ok(outputLines(result.text).length <= 2_000, "full mode must respect the selected-line budget");
		assert.equal(result.truncated, true);
		assert.match(result.truncationReason ?? "", /line|budget|limit|truncated/i);
		assert.equal(result.omittedHint, undefined);
	});
});
