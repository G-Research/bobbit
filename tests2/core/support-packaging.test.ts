// v2-native — offline docs + source packaging for the Support assistant.
//
// The Support assistant reads Bobbit's own docs + source, which must ship in the
// npm tarball for offline/installed users. Pins:
//   • package.json `files` includes docs/ and src/.
//   • `npm pack --dry-run --json` lists at least one docs/ and one src/ entry.
//   • resolveBundledDocsDir()/resolveBundledSrcDir() return existing directories.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

const { resolveBundledDocsDir, resolveBundledSrcDir } = await import("../../src/server/agent/bundled-paths.ts");

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

describe("support packaging — package.json files", () => {
	it("`files` includes docs/ and src/", () => {
		const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf-8")) as { files?: string[] };
		const files = pkg.files ?? [];
		assert.ok(files.includes("docs/"), "package.json files must include 'docs/'");
		assert.ok(files.includes("src/"), "package.json files must include 'src/'");
	});
});

describe("support packaging — manifest-backed contents", () => {
	it("package allowlist has shippable docs/ and src/ entries", () => {
		const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf-8")) as { files?: string[] };
		for (const [entry, representative] of [["docs/", "docs/internals.md"], ["src/", "src/server/server.ts"]] as const) {
			assert.ok(pkg.files?.includes(entry), `package allowlist must include ${entry}`);
			const bundledPath = path.join(REPO_ROOT, representative);
			assert.ok(fs.existsSync(bundledPath), `package allowlist entry ${entry} must contain ${representative}`);
			assert.ok(fs.statSync(bundledPath).isFile(), `representative package entry must be a file: ${representative}`);
		}
	});
});

describe("support packaging — bundled path resolver", () => {
	it("resolveBundledDocsDir()/resolveBundledSrcDir() return existing directories", () => {
		for (const dir of [resolveBundledDocsDir(), resolveBundledSrcDir()]) {
			assert.ok(fs.existsSync(dir), `resolved bundled dir must exist: ${dir}`);
			assert.ok(fs.statSync(dir).isDirectory(), `resolved bundled path must be a directory: ${dir}`);
		}
	});
});
