import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, extractFileBlocks, looksLikeDiff, applyUnifiedDiff } from "../scripts/glm-worker.mjs";

describe("glm-worker.mjs pure helpers", () => {
	describe("parseArgs", () => {
		it("parses spec/workdir/env-file/round/token flags", () => {
			const args = parseArgs([
				"--spec", "spec.json",
				"--workdir", "/tmp/foo",
				"--env-file", "/tmp/.env",
				"--max-rounds", "2",
				"--max-tokens", "4096",
			]);
			assert.equal(args.spec, "spec.json");
			assert.equal(args.workdir, "/tmp/foo");
			assert.equal(args.envFile, "/tmp/.env");
			assert.equal(args.maxRounds, 2);
			assert.equal(args.maxTokens, 4096);
		});

		it("returns an empty object when no flags are given", () => {
			assert.deepEqual(parseArgs([]), {});
		});
	});

	describe("extractFileBlocks", () => {
		it("extracts a single FILE block with a full-file replacement", () => {
			const text = [
				"Here is the fix:",
				"",
				"FILE: src/foo.ts",
				"```typescript",
				"export const x = 1;",
				"```",
			].join("\n");
			const blocks = extractFileBlocks(text);
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0].filePath, "src/foo.ts");
			assert.equal(blocks[0].lang, "typescript");
			assert.equal(blocks[0].body, "export const x = 1;\n");
		});

		it("extracts multiple FILE blocks across a multi-file reply", () => {
			const text = [
				"FILE: a.ts",
				"```ts",
				"const a = 1;",
				"```",
				"",
				"FILE: b.ts",
				"```ts",
				"const b = 2;",
				"```",
			].join("\n");
			const blocks = extractFileBlocks(text);
			assert.deepEqual(
				blocks.map((b) => b.filePath),
				["a.ts", "b.ts"]
			);
		});

		it("returns no blocks when the model didn't follow the format", () => {
			assert.deepEqual(extractFileBlocks("I fixed it, trust me."), []);
		});
	});

	describe("looksLikeDiff", () => {
		it("treats a ```diff language tag as a diff", () => {
			assert.equal(looksLikeDiff("diff", "anything"), true);
		});

		it("treats unified-diff markers as a diff even without a language tag", () => {
			assert.equal(looksLikeDiff("", "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n"), true);
			assert.equal(looksLikeDiff("", "@@ -1,1 +1,1 @@\n-old\n+new\n"), true);
		});

		it("treats a plain full-file body as not a diff", () => {
			assert.equal(looksLikeDiff("typescript", "export const x = 1;\n"), false);
		});
	});

	describe("applyUnifiedDiff", () => {
		it("applies a single-hunk diff (add/remove/context lines)", () => {
			const original = ["line1", "line2", "line3", "line4"].join("\n");
			const diff = [
				"--- a/f.ts",
				"+++ b/f.ts",
				"@@ -1,4 +1,4 @@",
				" line1",
				"-line2",
				"+line2-fixed",
				" line3",
				" line4",
			].join("\n");
			const result = applyUnifiedDiff(original, diff);
			assert.equal(result, ["line1", "line2-fixed", "line3", "line4"].join("\n"));
		});

		it("applies a diff that only adds lines", () => {
			const original = ["a", "b"].join("\n");
			const diff = ["@@ -1,2 +1,3 @@", " a", "+inserted", " b"].join("\n");
			const result = applyUnifiedDiff(original, diff);
			assert.equal(result, ["a", "inserted", "b"].join("\n"));
		});

		it("applies a diff that only removes lines", () => {
			const original = ["a", "b", "c"].join("\n");
			const diff = ["@@ -1,3 +1,2 @@", " a", "-b", " c"].join("\n");
			const result = applyUnifiedDiff(original, diff);
			assert.equal(result, ["a", "c"].join("\n"));
		});
	});
});
