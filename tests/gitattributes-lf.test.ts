/**
 * Guard test for `.gitattributes` line-ending policy.
 *
 * Motivation: on Windows with the Git for Windows default `core.autocrlf=true`,
 * a bare `* text=auto` rule defers EOL policy to per-user config, producing
 * CRLF in the working tree against LF blobs in the index. That causes phantom
 * `git status` modifications and "LF will be replaced by CRLF" warnings.
 *
 * The fix pins `eol=lf` globally and opts Windows-script files (`.cmd`,
 * `.bat`, `.ps1`) into CRLF explicitly. This test guards that policy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gitattributesPath = path.resolve(__dirname, "..", ".gitattributes");

describe("gitattributes-lf-policy", () => {
	const content = fs.readFileSync(gitattributesPath, "utf8");

	it("contains global '* text=auto eol=lf' rule", () => {
		assert.match(
			content,
			/^\s*\*\s+text=auto\s+eol=lf\s*$/m,
			"gitattributes missing global eol=lf: expected a line matching `* text=auto eol=lf` to pin LF on checkout across all platforms",
		);
	});

	it("does NOT contain a bare '* text=auto' line lacking eol=lf", () => {
		assert.doesNotMatch(
			content,
			/^\s*\*\s+text=auto\s*$/m,
			"gitattributes has bare '* text=auto' without eol=lf: this defers EOL policy to per-user core.autocrlf and causes phantom CRLF diffs on Windows",
		);
	});

	it("contains explicit CRLF rule for *.cmd", () => {
		assert.match(
			content,
			/^\s*\*\.cmd\s+text\s+eol=crlf\s*$/m,
			"gitattributes missing CRLF rule for *.cmd: expected a line `*.cmd text eol=crlf`",
		);
	});

	it("contains explicit CRLF rule for *.bat", () => {
		assert.match(
			content,
			/^\s*\*\.bat\s+text\s+eol=crlf\s*$/m,
			"gitattributes missing CRLF rule for *.bat: expected a line `*.bat text eol=crlf`",
		);
	});

	it("contains explicit CRLF rule for *.ps1", () => {
		assert.match(
			content,
			/^\s*\*\.ps1\s+text\s+eol=crlf\s*$/m,
			"gitattributes missing CRLF rule for *.ps1: expected a line `*.ps1 text eol=crlf`",
		);
	});

	it("does NOT contain legacy '*.sh text eol=lf' line", () => {
		assert.doesNotMatch(
			content,
			/^\s*\*\.sh\s+text\s+eol=lf\s*$/m,
			"gitattributes has redundant legacy '*.sh text eol=lf' line: now covered by the global '* text=auto eol=lf' rule",
		);
	});
});
