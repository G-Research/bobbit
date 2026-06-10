/**
 * Unit tests for the pack-path symlink/TOCTOU guard
 * (src/server/extension-host/path-guard.ts).
 *
 * The lexical `path.relative` check alone follows a symlink that is lexically
 * inside the group dir but points outside the pack, disclosing/importing
 * arbitrary host files. `isPackPathWithinRoot` adds an `fs.realpathSync`
 * containment check on top of the lexical one.
 *
 * Pinned invariants:
 *   - A normal in-pack file resolves (true).
 *   - A symlinked entry that escapes the group dir is REJECTED (false).
 *   - A lexically-escaping path (../) is rejected (false).
 *   - A missing target (ENOENT) is tolerated (true) — caller handles not-found.
 *
 * Symlink creation can fail on platforms/accounts without the privilege
 * (Windows non-admin): those cases skip gracefully rather than fail.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPackPathWithinRoot } from "../src/server/extension-host/path-guard.ts";

let tmp: string;

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-host-pathguard-"));
});
after(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Create a symlink, returning false (so the test can skip) when the platform
 *  forbids it (e.g. Windows without the create-symlink privilege). */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath);
		return true;
	} catch (err: any) {
		if (err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "ENOSYS")) return false;
		throw err;
	}
}

describe("isPackPathWithinRoot", () => {
	it("allows a normal in-pack file", () => {
		const group = path.join(tmp, "case-ok", "group");
		fs.mkdirSync(group, { recursive: true });
		const file = path.join(group, "renderer.js");
		fs.writeFileSync(file, "export default 1;");
		assert.equal(isPackPathWithinRoot(group, file), true);
	});

	it("allows an in-pack file inside a subdirectory", () => {
		const group = path.join(tmp, "case-sub", "group");
		fs.mkdirSync(path.join(group, "sub"), { recursive: true });
		const file = path.join(group, "sub", "panel.js");
		fs.writeFileSync(file, "export default 1;");
		assert.equal(isPackPathWithinRoot(group, file), true);
	});

	it("rejects a lexically-escaping path", () => {
		const group = path.join(tmp, "case-lex", "group");
		fs.mkdirSync(group, { recursive: true });
		const outside = path.resolve(group, "..", "secret.js");
		assert.equal(isPackPathWithinRoot(group, outside), false);
	});

	it("rejects a symlink that escapes the group dir", () => {
		const root = path.join(tmp, "case-symlink");
		const group = path.join(root, "group");
		fs.mkdirSync(group, { recursive: true });
		// Host secret OUTSIDE the pack group dir.
		const secret = path.join(root, "secret.js");
		fs.writeFileSync(secret, "export const stolen = true;");
		// A pack entry lexically inside the group that symlinks to the secret.
		const link = path.join(group, "renderer.js");
		if (!trySymlink(secret, link)) {
			// Platform cannot create symlinks — nothing to assert.
			return;
		}
		// Lexical check passes (link is inside group), but realpath escapes → reject.
		assert.equal(isPackPathWithinRoot(group, link), false);
	});

	it("allows a symlink that stays within the group dir", () => {
		const group = path.join(tmp, "case-symlink-inside", "group");
		fs.mkdirSync(group, { recursive: true });
		const real = path.join(group, "real.js");
		fs.writeFileSync(real, "export default 1;");
		const link = path.join(group, "alias.js");
		if (!trySymlink(real, link)) return;
		assert.equal(isPackPathWithinRoot(group, link), true);
	});

	it("tolerates a missing target (ENOENT) so the caller's not-found path runs", () => {
		const group = path.join(tmp, "case-missing", "group");
		fs.mkdirSync(group, { recursive: true });
		const missing = path.join(group, "does-not-exist.js");
		assert.equal(isPackPathWithinRoot(group, missing), true);
	});

	it("rejects when the group root itself is missing", () => {
		const group = path.join(tmp, "case-no-group", "group");
		const file = path.join(group, "renderer.js");
		assert.equal(isPackPathWithinRoot(group, file), false);
	});
});
