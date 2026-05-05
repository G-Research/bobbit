/**
 * Unit tests for `parseShortstat` — the regex-based parser for
 * `git diff --shortstat` output. See
 * `src/server/skills/git-status-native.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShortstat } from "../src/server/skills/git-status-native.ts";

describe("parseShortstat", () => {
	it("both present, plural", () => {
		assert.deepStrictEqual(
			parseShortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)"),
			{ insertions: 12, deletions: 4 },
		);
	});

	it("both present, singular", () => {
		assert.deepStrictEqual(
			parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)"),
			{ insertions: 1, deletions: 1 },
		);
	});

	it("insertions only", () => {
		assert.deepStrictEqual(
			parseShortstat(" 1 file changed, 5 insertions(+)"),
			{ insertions: 5, deletions: 0 },
		);
	});

	it("deletions only", () => {
		assert.deepStrictEqual(
			parseShortstat(" 2 files changed, 3 deletions(-)"),
			{ insertions: 0, deletions: 3 },
		);
	});

	it("empty string", () => {
		assert.deepStrictEqual(parseShortstat(""), { insertions: 0, deletions: 0 });
	});

	it("'0 files changed' (no insertions/deletions clauses)", () => {
		assert.deepStrictEqual(
			parseShortstat(" 0 files changed"),
			{ insertions: 0, deletions: 0 },
		);
	});

	it("garbage input → 0/0", () => {
		assert.deepStrictEqual(
			parseShortstat("not a shortstat output at all"),
			{ insertions: 0, deletions: 0 },
		);
	});

	it("insertions singular only", () => {
		assert.deepStrictEqual(
			parseShortstat(" 1 file changed, 1 insertion(+)"),
			{ insertions: 1, deletions: 0 },
		);
	});

	it("deletions singular only", () => {
		assert.deepStrictEqual(
			parseShortstat(" 1 file changed, 1 deletion(-)"),
			{ insertions: 0, deletions: 1 },
		);
	});
});
