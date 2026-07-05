/**
 * Unit coverage for the `isStale` mtime-comparison helper in
 * tests/e2e/e2e-global-setup.ts (FINDINGS TEST-03).
 *
 * e2e-global-setup.ts now skips build:server/build:ui/build:packs entirely
 * when dist/ is already newer than every watched source path, instead of the
 * old existence-only check that forced test:e2e's npm script to bolt on an
 * unconditional `npm run build` in front of every invocation. This pins the
 * comparison logic in isolation (no child_process, no real build) so the
 * staleness gate can't silently regress into "always stale" (defeats the
 * speedup) or "never stale" (serves a stale build).
 *
 * Lives at the top level (tests/*.test.ts, not tests/e2e/**) so it is claimed
 * by the unit·node phase only — a copy under tests/e2e/ would additionally be
 * collected as a Playwright spec by the "api" e2e project's default
 * `**\/*.test.ts` testMatch (see tests/test-phase-invariant.test.ts) and fail
 * there for using node:test instead of @playwright/test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStale } from "./e2e/e2e-global-setup.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-staleness-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function touch(path: string, timeSec: number): void {
	utimesSync(path, timeSec, timeSec);
}

test("isStale: missing reference file is always stale", () => {
	withTempDir((dir) => {
		const ref = join(dir, "dist-marker");
		const watched = join(dir, "src");
		mkdirSync(watched);
		assert.equal(isStale(ref, [watched]), true);
	});
});

test("isStale: unchanged tree (watch paths older than reference) is not stale", () => {
	withTempDir((dir) => {
		const ref = join(dir, "dist-marker");
		const watchedDir = join(dir, "src");
		mkdirSync(watchedDir);
		const nested = join(watchedDir, "nested");
		mkdirSync(nested);
		writeFileSync(join(watchedDir, "a.ts"), "a");
		writeFileSync(join(nested, "b.ts"), "b");

		touch(join(watchedDir, "a.ts"), 1_000);
		touch(join(nested, "b.ts"), 1_000);
		writeFileSync(ref, "built");
		touch(ref, 2_000);

		assert.equal(isStale(ref, [watchedDir]), false);
	});
});

test("isStale: a file newer than the reference (including nested) is detected", () => {
	withTempDir((dir) => {
		const ref = join(dir, "dist-marker");
		const watchedDir = join(dir, "src");
		mkdirSync(watchedDir);
		const nested = join(watchedDir, "nested");
		mkdirSync(nested);
		writeFileSync(join(watchedDir, "a.ts"), "a");
		writeFileSync(join(nested, "b.ts"), "b");
		writeFileSync(ref, "built");

		touch(join(watchedDir, "a.ts"), 1_000);
		touch(ref, 2_000);
		// Edit deep inside the tree after the reference was built.
		touch(join(nested, "b.ts"), 3_000);

		assert.equal(isStale(ref, [watchedDir]), true);
	});
});

test("isStale: a plain watched file (not a directory) newer than reference is detected", () => {
	withTempDir((dir) => {
		const ref = join(dir, "dist-marker");
		const watchedFile = join(dir, "package.json");
		writeFileSync(watchedFile, "{}");
		writeFileSync(ref, "built");

		touch(ref, 2_000);
		touch(watchedFile, 1_000);
		assert.equal(isStale(ref, [watchedFile]), false);

		touch(watchedFile, 3_000);
		assert.equal(isStale(ref, [watchedFile]), true);
	});
});

test("isStale: a nonexistent watch path is skipped, not treated as stale", () => {
	withTempDir((dir) => {
		const ref = join(dir, "dist-marker");
		writeFileSync(ref, "built");
		assert.equal(isStale(ref, [join(dir, "does-not-exist")]), false);
	});
});
