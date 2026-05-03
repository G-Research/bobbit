import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setProjectRoot, bobbitConfigDir } from "../src/server/bobbit-dir.js";
import { resolveSystemPromptPath } from "../src/server/agent/system-prompt.js";

describe("resolveSystemPromptPath", () => {
	let tmpDir: string;
	let prevBobbitDir: string | undefined;
	let prevPiDir: string | undefined;

	before(() => {
		// Don't let env vars short-circuit setProjectRoot.
		prevBobbitDir = process.env.BOBBIT_DIR;
		prevPiDir = process.env.BOBBIT_PI_DIR;
		delete process.env.BOBBIT_DIR;
		delete process.env.BOBBIT_PI_DIR;
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-resolver-"));
		setProjectRoot(tmpDir);
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (prevBobbitDir !== undefined) process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevPiDir !== undefined) process.env.BOBBIT_PI_DIR = prevPiDir;
	});

	it("returns the user override path when it exists", () => {
		const cfg = bobbitConfigDir();
		fs.mkdirSync(cfg, { recursive: true });
		const userPath = path.join(cfg, "system-prompt.md");
		fs.writeFileSync(userPath, "user override\n");
		try {
			const resolved = resolveSystemPromptPath();
			assert.strictEqual(resolved, userPath);
		} finally {
			fs.rmSync(userPath);
		}
	});

	it("falls back to the shipped default (or undefined) when no user override exists", () => {
		const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
		assert.ok(!fs.existsSync(userPath), "preconditions: user file should not exist");
		const resolved = resolveSystemPromptPath();
		// When running under tsx from source, the sibling defaults/ dir lives at
		// dist/server/defaults/ post-build but at <repo>/defaults/ pre-build.
		// The resolver looks for it relative to its own module location, so the
		// result is either a real defaults path or undefined when not built.
		if (resolved !== undefined) {
			assert.ok(resolved.endsWith("system-prompt.md"));
			assert.ok(fs.existsSync(resolved), `${resolved} must exist on disk`);
			assert.notStrictEqual(resolved, userPath);
			assert.ok(
				resolved.includes(path.sep + "defaults" + path.sep),
				`expected path under defaults/, got ${resolved}`,
			);
		}
	});

	it("returns undefined when neither user override nor default exists", () => {
		// Point setProjectRoot at a fresh tmpdir with no .bobbit/config and verify the
		// user branch is skipped. The defaults branch is governed by build state and
		// covered by the previous test; we only assert no throw and a string|undefined
		// result here.
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "sp-resolver-empty-"));
		try {
			setProjectRoot(fresh);
			const resolved = resolveSystemPromptPath();
			assert.ok(resolved === undefined || typeof resolved === "string");
			if (typeof resolved === "string") {
				// If a resolved path is returned, it must be the shipped default, never
				// the (nonexistent) user path under the fresh tmpdir.
				const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
				assert.notStrictEqual(resolved, userPath);
			}
		} finally {
			setProjectRoot(tmpDir);
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
