import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUnifiedDiff } from "../src/server/pr-walkthrough/diff-parser.ts";
import { resolveLocalChangeset } from "../src/server/pr-walkthrough/git-changeset.ts";

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line one
-old two
+new two
 line three
+new four
@@ -20,2 +21,2 @@ function x()
-old twenty
+new twenty-one
diff --git a/old name.ts b/new name.ts
similarity index 90%
rename from old name.ts
rename to new name.ts
--- a/old name.ts
+++ b/new name.ts
@@ -1 +1 @@
-export const oldName = true;
+export const newName = true;
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const removed = true;
-goodbye
`;

describe("parseUnifiedDiff", () => {
	it("parses additions, deletions, multiple hunks, line numbers, and stable line ids", () => {
		const result = parseUnifiedDiff(SAMPLE_DIFF);
		const file = result.files[0];
		assert.equal(file.filePath, "src/a.ts");
		assert.equal(file.status, "modified");
		assert.equal(file.hunks.length, 2);
		assert.equal(file.additions, 3);
		assert.equal(file.deletions, 2);
		assert.deepEqual(file.hunks[0].lines.map(line => [line.kind, line.oldLine, line.newLine, line.text]), [
			["context", 1, 1, "line one"],
			["del", 2, undefined, "old two"],
			["add", undefined, 2, "new two"],
			["context", 3, 3, "line three"],
			["add", undefined, 4, "new four"],
		]);
		assert.equal(file.hunks[1].lines[0].id, `${file.id}:h1:l0`);
	});

	it("preserves renamed file paths", () => {
		const result = parseUnifiedDiff(SAMPLE_DIFF);
		const file = result.files[1];
		assert.equal(file.status, "renamed");
		assert.equal(file.oldPath, "old name.ts");
		assert.equal(file.filePath, "new name.ts");
	});

	it("marks binary files with warnings instead of failing", () => {
		const result = parseUnifiedDiff(SAMPLE_DIFF);
		const file = result.files[2];
		assert.equal(file.status, "binary");
		assert.equal(file.isBinary, true);
		assert.equal(file.hunks.length, 0);
		assert.ok(result.warnings.some(warning => warning.code === "binary-file" && warning.filePath === "assets/logo.png"));
	});

	it("preserves deleted files and old-side anchors", () => {
		const result = parseUnifiedDiff(SAMPLE_DIFF);
		const file = result.files[3];
		assert.equal(file.status, "deleted");
		assert.equal(file.filePath, "src/removed.ts");
		assert.deepEqual(file.hunks[0].lines.map(line => [line.kind, line.side, line.oldLine, line.newLine]), [
			["del", "old", 1, undefined],
			["del", "old", 2, undefined],
		]);
	});

	it("truncates large file hunks with a warning", () => {
		const result = parseUnifiedDiff(SAMPLE_DIFF, { maxLinesPerFile: 3 });
		const file = result.files[0];
		assert.equal(file.truncated, true);
		assert.equal(file.hunks[0].lines.length, 3);
		assert.ok(result.warnings.some(warning => warning.code === "file-lines-truncated" && warning.filePath === "src/a.ts"));
	});
});

describe("resolveLocalChangeset", () => {
	it("resolves real local git metadata and parsed diff files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "bobbit-pr-walkthrough-"));
		try {
			git(cwd, "init");
			git(cwd, "config", "user.email", "test@example.com");
			git(cwd, "config", "user.name", "Test User");
			git(cwd, "config", "core.autocrlf", "false");
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "file.ts"), "one\ntwo\nthree\n");
			git(cwd, "add", ".");
			git(cwd, "commit", "-m", "base");
			const baseSha = git(cwd, "rev-parse", "HEAD");

			writeFileSync(join(cwd, "src", "file.ts"), "one\nTWO\nthree\nfour\n");
			mkdirSync(join(cwd, "dist"), { recursive: true });
			writeFileSync(join(cwd, "dist", "bundle.js"), "console.log('generated');\n");
			git(cwd, "add", ".");
			git(cwd, "commit", "-m", "head");
			const headSha = git(cwd, "rev-parse", "HEAD");

			const result = await resolveLocalChangeset({ cwd, baseSha, headSha, limits: { maxLinesPerFile: 100, maxFiles: 10 } });
			assert.equal(result.changesetId, `${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`);
			assert.equal(result.changeset.provider, "local");
			assert.equal(result.changeset.filesChanged, 2);
			assert.ok(result.changeset.additions && result.changeset.additions >= 2);
			assert.ok(result.files.some(file => file.filePath === "src/file.ts" && file.hunks.length === 1));
			assert.ok(result.warnings.some(warning => warning.code === "generated-file" && warning.filePath === "dist/bundle.js"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
