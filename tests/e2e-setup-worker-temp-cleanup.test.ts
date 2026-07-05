/**
 * Unit coverage for `cleanupWorkerTempCwds()` in tests/e2e/e2e-setup.ts
 * (Finding W2.R).
 *
 * `nonGitCwd()`/`gitCwd()` memoize one directory each per Playwright worker
 * process directly under `os.tmpdir()` — NOT under the harness's own
 * `bobbitDir`/`defaultProjectRoot`, which in-process-harness.ts and
 * gateway-harness.ts already `awaitableRm()` at worker teardown. Nothing
 * ever removed these two, so every worker in every E2E run left one or two
 * `bobbit-e2e-<port>-*` / `bobbit-e2e-git-<port>-*` directories behind
 * permanently — confirmed by a live host survey finding 21k+ stale entries
 * under the shared E2E temp root after a night of repeated full-suite runs.
 *
 * Lives at the top level (tests/*.test.ts, not tests/e2e/**) so it is
 * claimed by the unit·node phase only, mirroring e2e-build-staleness.test.ts
 * — a copy under tests/e2e/ would additionally be collected as a Playwright
 * spec by the "api" project's default `**\/*.test.ts` testMatch (see
 * tests/test-phase-invariant.test.ts) and fail there for using node:test
 * instead of @playwright/test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cleanupWorkerTempCwds, gitCwd, nonGitCwd } from "./e2e/e2e-setup.ts";

test("cleanupWorkerTempCwds removes the memoized nonGitCwd()/gitCwd() directories", async () => {
	const nonGit = nonGitCwd();
	const git = gitCwd();
	assert.ok(existsSync(nonGit), "nonGitCwd() should create its directory");
	assert.ok(existsSync(git), "gitCwd() should create its directory");

	await cleanupWorkerTempCwds();

	assert.ok(!existsSync(nonGit), "cleanupWorkerTempCwds() should remove the nonGitCwd() directory");
	assert.ok(!existsSync(git), "cleanupWorkerTempCwds() should remove the gitCwd() directory");
});

test("nonGitCwd()/gitCwd() re-create fresh directories after cleanup (memoization resets)", async () => {
	const before = nonGitCwd();
	await cleanupWorkerTempCwds();
	const after = nonGitCwd();

	assert.ok(existsSync(after), "nonGitCwd() should create a fresh directory after cleanup");
	assert.notStrictEqual(after, before, "a stale path must not be reused after the directory was removed");

	// Leave the environment clean for any later test in this process.
	await cleanupWorkerTempCwds();
});

test("cleanupWorkerTempCwds() is a safe no-op when nonGitCwd()/gitCwd() were never called", async () => {
	// Regression guard: a worker whose spec files never touch nonGitCwd()/
	// gitCwd() must not throw when its teardown unconditionally awaits
	// cleanupWorkerTempCwds() (both in-process-harness.ts and
	// gateway-harness.ts call it unconditionally at worker teardown).
	await cleanupWorkerTempCwds();
	await cleanupWorkerTempCwds();
});
