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
import { execFileSync } from "node:child_process";
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

describe("support packaging — npm pack contents", () => {
	it("npm pack --dry-run --json lists docs/ and src/ entries", () => {
		const isWin = process.platform === "win32";
		const npm = isWin ? "npm.cmd" : "npm";
		const stdout = execFileSync(npm, ["pack", "--dry-run", "--json"], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			windowsHide: true,
			maxBuffer: 64 * 1024 * 1024,
			// Node >=18 refuses to spawn .cmd/.bat without a shell on Windows (EINVAL).
			shell: isWin,
		});
		// npm may prepend non-JSON noise; slice from the first array bracket.
		const start = stdout.indexOf("[");
		assert.ok(start >= 0, "npm pack --json produced no JSON array");
		const parsed = JSON.parse(stdout.slice(start)) as Array<{ files?: Array<{ path: string }> }>;
		const entries = parsed.flatMap((p) => p.files ?? []).map((f) => f.path.replace(/\\/g, "/"));
		assert.ok(
			entries.some((p) => p.startsWith("docs/")),
			"npm pack contents must contain at least one docs/ entry",
		);
		assert.ok(
			entries.some((p) => p.startsWith("src/")),
			"npm pack contents must contain at least one src/ entry",
		);
	}, 120_000);
});

describe("support packaging — bundled path resolver", () => {
	it("resolveBundledDocsDir()/resolveBundledSrcDir() return existing directories", () => {
		for (const dir of [resolveBundledDocsDir(), resolveBundledSrcDir()]) {
			assert.ok(fs.existsSync(dir), `resolved bundled dir must exist: ${dir}`);
			assert.ok(fs.statSync(dir).isDirectory(), `resolved bundled path must be a directory: ${dir}`);
		}
	});
});
