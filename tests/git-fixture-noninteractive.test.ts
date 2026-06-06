/**
 * Regression test (TDD red step) for the E2E exit-hang.
 *
 * Root cause: the E2E git fixtures run `git tag` with NO hermetic /
 * non-interactive git environment. On a host whose global git config sets
 * `tag.gpgsign = true` and points `GIT_EDITOR` at an interactive editor,
 * `git tag <name>` becomes a signed/annotated tag that needs a message →
 * git launches the editor → blocks forever → the git/editor child keeps the
 * Playwright worker's event loop alive after `gw.shutdown()` → the suite
 * never exits. See the Issue Analysis gate.
 *
 * This test is HOST-INDEPENDENT: it injects the hostile config itself
 * (a temp `GIT_CONFIG_GLOBAL` with `tag.gpgsign=true` + `commit.gpgsign=true`)
 * so it reproduces on any machine, and uses a FAST-FAILING `GIT_EDITOR=false`
 * (never a blocking editor) so a buggy helper fails fast instead of hanging
 * the test runner.
 *
 * Expected results:
 *  - Current (non-hermetic) helper → `git tag v1.2.3` tries to create a
 *    signed/annotated tag → invokes `GIT_EDITOR=false` → git aborts non-zero
 *    → `execFileSync` throws → this test FAILS FAST. That RED is the goal.
 *  - After the fix (hermetic helper) → lightweight tag created instantly →
 *    this test PASSES.
 *
 * Run via `node --test --test-force-exit` (npm run test:unit) — joins the
 * `tests/*.test.ts` glob.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createGitFixtureRepo } from "./test-utils/git-fixture.ts";

/** Temporarily override env vars, restoring prior values (incl. unset) after. */
function withEnv<T>(overrides: Record<string, string>, fn: () => T): T {
	const prior: Record<string, string | undefined> = {};
	for (const key of Object.keys(overrides)) {
		prior[key] = process.env[key];
		process.env[key] = overrides[key];
	}
	try {
		return fn();
	} finally {
		for (const key of Object.keys(overrides)) {
			if (prior[key] === undefined) delete process.env[key];
			else process.env[key] = prior[key];
		}
	}
}

describe("git fixture is non-interactive under a hostile gpgsign host config", () => {
	it("creates a tag fast without invoking an editor (gpgsign=true, GIT_EDITOR=false)", () => {
		// Workspace + a hostile global gitconfig that turns `git tag` into a
		// signed/annotated tag requiring an editor-provided message.
		const work = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gitfixture-noninteractive-"));
		const hostileGitconfig = path.join(work, "hostile.gitconfig");
		fs.writeFileSync(
			hostileGitconfig,
			"[tag]\n\tgpgsign = true\n[commit]\n\tgpgsign = true\n",
		);
		const repoDir = path.join(work, "repo");

		const startedAt = Date.now();
		try {
			withEnv(
				{
					// Make the child git inherit the hostile config + a FAST-FAILING,
					// non-blocking editor (so the bug fails fast, never hangs).
					GIT_CONFIG_GLOBAL: hostileGitconfig,
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_EDITOR: "false",
					GIT_TERMINAL_PROMPT: "0",
				},
				() => createGitFixtureRepo(repoDir, { tags: ["v1.2.3"] }),
			);

			// The call must return promptly — no blocking editor.
			const elapsedMs = Date.now() - startedAt;
			assert.ok(
				elapsedMs < 10_000,
				`createGitFixtureRepo took ${elapsedMs}ms — expected a non-blocking, fast return`,
			);

			// And the tag must actually exist.
			const tags = execFileSync("git", ["tag", "-l"], { cwd: repoDir, encoding: "utf-8" }).trim();
			assert.ok(
				tags.split(/\r?\n/).includes("v1.2.3"),
				`expected tag "v1.2.3" to exist, got: ${JSON.stringify(tags)}`,
			);
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	});
});
