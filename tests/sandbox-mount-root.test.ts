/**
 * Tests for `resolveSandboxMountRoot` — the helper that picks the canonical
 * MAIN-repo working directory to bind-mount as the sandbox clone source.
 *
 * The regression it guards (Finding B): when the project root is a linked git
 * worktree, its `.git` is a gitdir-FILE pointing at the MAIN repo's object
 * store. Bind-mounting + `git clone`ing just the worktree dir fails (objects
 * aren't present). The helper must resolve the canonical MAIN repo root via
 * `git rev-parse --git-common-dir` so the mount source is always cloneable.
 *
 * Uses real temp git repos (follows tests/base-ref-parse.test.ts patterns).
 * Run via `node --test --test-force-exit` (npm run test:unit).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSandboxMountRoot } from "../src/server/skills/git.ts";

const tmpDirs: string[] = [];

function rmDir(p: string): void {
	try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

function makeTempRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mount-root-"));
	tmpDirs.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	git(root, "config", "commit.gpgsign", "false");
	git(root, "checkout", "-q", "-b", "master");
	fs.writeFileSync(path.join(root, "README.md"), "init\n");
	git(root, "add", "README.md");
	git(root, "commit", "-q", "-m", "init");
	return root;
}

/** realpath, falling back to resolve when the path doesn't exist. */
function realpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

after(() => {
	for (const d of tmpDirs) rmDir(d);
});

describe("resolveSandboxMountRoot", () => {
	it("returns realpath(repoRoot) for a normal (main) repo", async () => {
		const root = makeTempRepo();
		const result = await resolveSandboxMountRoot(root);
		assert.equal(result, realpath(root));
	});

	it("returns the MAIN repo root for a linked worktree (origin-less regression)", async () => {
		const main = makeTempRepo();
		// Place the linked worktree OUTSIDE the main repo so a naive realpath of
		// the worktree dir would NOT equal the main root.
		const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mount-wt-"));
		tmpDirs.push(wtPath);
		rmDir(wtPath); // `git worktree add` wants to create the dir itself
		git(main, "worktree", "add", "-q", "-b", "feature/x", wtPath);

		const result = await resolveSandboxMountRoot(wtPath);
		// Must resolve to the MAIN working tree, NOT the worktree path.
		assert.equal(result, realpath(main));
		assert.notEqual(result, realpath(wtPath));
	});

	it("falls back to a canonicalized path for a non-git directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mount-nongit-"));
		tmpDirs.push(dir);
		const result = await resolveSandboxMountRoot(dir);
		// Non-git → fallback canonicalizePath(repoPath). On win32 canonicalizePath
		// lowercases; compare case-insensitively to stay cross-platform.
		assert.equal(result.toLowerCase(), realpath(dir).toLowerCase());
	});
});
