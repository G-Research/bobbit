/**
 * Integration-level pin for the real git-backed implementation of
 * `ContentCacheGitDeps` (verification-logic.ts) used by
 * `buildContentStepCache` under `BOBBIT_GATE_CACHE=content` — see finding
 * VER-01 and docs/design/gate-step-cache.md.
 *
 * `tests/verification-logic.test.ts` covers the *decision logic* (hit/miss,
 * conservative fallbacks) against fake deps. This file instead proves the
 * two real git-backed functions (`gitListTrackedPaths`, `gitDiffIsClean`)
 * behave the way that decision logic assumes, against an actual repo:
 *
 *  - `git ls-tree -r --name-only <sha>` is glob-free and lists every tracked
 *    path (the existence guard's assumption).
 *  - `git diff --quiet <a> <b> -- <globs>` correctly reports "no differences"
 *    for a docs-only commit restricted to `src/**`, and correctly reports a
 *    real diff when the globbed path itself changes.
 *  - A glob that matches nothing (e.g. a typo'd directory) is NOT surfaced by
 *    `gitDiffIsClean` as a false "clean" — that guard lives in
 *    `buildContentStepCache`'s use of `gitListTrackedPaths` first, but this
 *    file pins the underlying fact that motivates it: `git diff --quiet`
 *    alone cannot tell "unchanged" from "pathspec matched nothing".
 *  - An unreachable commit SHA throws (never silently reports "clean").
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gitListTrackedPaths, gitDiffIsClean } from "../src/server/agent/verification-harness.ts";

describe("VER-01 gate content cache — real git deps", () => {
	let repo: string;
	let shaBase: string;
	let shaDocsOnly: string;
	let shaSrcChange: string;

	before(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-cache-git-"));
		const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "pipe" });
		git("git init -q");
		git('git config user.email "test@test.com"');
		git('git config user.name "Test"');
		fs.mkdirSync(path.join(repo, "src", "sub"), { recursive: true });
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(repo, "src", "sub", "b.ts"), "export const b = 2;\n");
		fs.writeFileSync(path.join(repo, "docs", "readme.md"), "hello\n");
		git("git add -A && git commit -qm base");
		shaBase = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

		fs.writeFileSync(path.join(repo, "docs", "readme.md"), "hello, updated\n");
		git("git add -A && git commit -qm docs-only-fix");
		shaDocsOnly = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();

		fs.writeFileSync(path.join(repo, "src", "sub", "b.ts"), "export const b = 3;\n");
		git("git add -A && git commit -qm src-fix");
		shaSrcChange = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
	});

	after(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("gitListTrackedPaths is glob-free and lists every tracked file", async () => {
		const paths = await gitListTrackedPaths(repo, shaSrcChange);
		assert.deepEqual([...paths].sort(), ["docs/readme.md", "src/a.ts", "src/sub/b.ts"]);
	});

	it("gitDiffIsClean(base, docsOnly, ['src/**']) is true — a docs-only commit doesn't touch src", async () => {
		assert.equal(await gitDiffIsClean(repo, shaBase, shaDocsOnly, ["src/**"]), true);
	});

	it("gitDiffIsClean(docsOnly, srcChange, ['src/**']) is false — the src commit touches a globbed path", async () => {
		assert.equal(await gitDiffIsClean(repo, shaDocsOnly, shaSrcChange, ["src/**"]), false);
	});

	it("gitDiffIsClean(docsOnly, srcChange, ['docs/**']) is true — the src-only commit doesn't touch docs", async () => {
		assert.equal(await gitDiffIsClean(repo, shaDocsOnly, shaSrcChange, ["docs/**"]), true);
	});

	it("a non-matching glob is reported 'clean' by git diff alone — this is exactly why buildContentStepCache gates on gitListTrackedPaths first, not on gitDiffIsClean alone", async () => {
		// This is not a bug in gitDiffIsClean — pathspec semantics are correct,
		// "no files under this pathspec changed" is a true statement when the
		// pathspec matches nothing. It's *unsafe on its own* as a reuse signal,
		// which is exactly what the existence guard in buildContentStepCache
		// (verification-logic.ts) exists to prevent.
		assert.equal(await gitDiffIsClean(repo, shaDocsOnly, shaSrcChange, ["nonexistent/**"]), true);
	});

	it("an unreachable commit SHA throws rather than silently reporting clean", async () => {
		await assert.rejects(() => gitDiffIsClean(repo, "0000000000000000000000000000000000000000", shaSrcChange, ["src/**"]));
	});
});
