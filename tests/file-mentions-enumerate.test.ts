/**
 * Unit tests for enumerateFiles — see design §3 / §8.2.
 *
 * Builds a tmp fixture tree (including gitignored/excluded dirs) and asserts
 * inclusion/exclusion, caps, and query ranking.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cwdDir: string;

function touch(rel: string, body = "x") {
	const abs = path.join(cwdDir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body, "utf-8");
}

before(() => {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-enum-test-"));
	touch("README.md");
	touch("src/index.ts");
	touch("src/util/helpers.ts");
	touch("src/components/Button.tsx");
	touch(".gitignore", "dist/\nsecret.env");
	// Gitignored / untracked files MUST still be enumerated.
	touch("secret.env", "TOKEN=abc");
	touch("build-artifact.log");
	// Excluded directories must be skipped.
	touch(".git/config");
	touch("node_modules/dep/index.js");
	touch("dist/bundle.js");
	touch(".bobbit/state/x.json");
});

after(() => {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { enumerateFiles, DEFAULT_RESULT_CAP, MAX_RESULT_CAP } =
	await import("../src/server/skills/file-enumeration.ts");

describe("enumerateFiles", () => {
	it("includes gitignored/untracked files, excludes noise dirs", async () => {
		const files = await enumerateFiles(cwdDir);
		assert.ok(files.includes("secret.env"), "gitignored file should be included");
		assert.ok(files.includes(".gitignore"));
		assert.ok(files.includes("src/index.ts"));
		assert.ok(!files.some((f) => f.startsWith(".git/")), ".git excluded");
		assert.ok(!files.some((f) => f.startsWith("node_modules/")), "node_modules excluded");
		assert.ok(!files.some((f) => f.startsWith("dist/")), "dist excluded");
		assert.ok(!files.some((f) => f.startsWith(".bobbit/")), ".bobbit excluded");
	});

	it("returns forward-slash relative paths", async () => {
		const files = await enumerateFiles(cwdDir);
		assert.ok(files.every((f) => !f.includes("\\")));
		assert.ok(files.includes("src/util/helpers.ts"));
	});

	it("query substring filter is case-insensitive", async () => {
		const files = await enumerateFiles(cwdDir, { query: "BUTTON" });
		assert.ok(files.includes("src/components/Button.tsx"));
		assert.ok(!files.includes("README.md"));
	});

	it("basename matches rank ahead of path-only matches", async () => {
		touch("util.ts");
		const files = await enumerateFiles(cwdDir, { query: "util" });
		// "util.ts" (basename match) should outrank "src/util/helpers.ts" (path-only).
		assert.equal(files[0], "util.ts");
	});

	it("respects the result cap (limit), clamped to MAX_RESULT_CAP", async () => {
		const limited = await enumerateFiles(cwdDir, { limit: 2 });
		assert.equal(limited.length, 2);
		// Over-max limit clamps rather than returning more than MAX_RESULT_CAP.
		const clamped = await enumerateFiles(cwdDir, { limit: MAX_RESULT_CAP + 5000 });
		assert.ok(clamped.length <= MAX_RESULT_CAP);
	});

	it("walk cap stops enumeration early", async () => {
		const capped = await enumerateFiles(cwdDir, { walkCap: 1 });
		assert.ok(capped.length <= DEFAULT_RESULT_CAP);
	});

	it("never throws on an unreadable / missing root", async () => {
		const files = await enumerateFiles(path.join(cwdDir, "does-not-exist"));
		assert.deepEqual(files, []);
	});
});
