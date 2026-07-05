/**
 * Pinning test for scripts/lib/gapless-symlink-swap.mjs — the zero-window
 * swap variant used by scripts/copy-defaults.mjs and
 * scripts/copy-builtin-packs.mjs where the platform supports it.
 *
 * Background: PR #160 shipped atomic-copy-dir.mjs's two-rename swap (old dest
 * -> `.old-*`, staging -> dest) to close the tools-builtin Docker mount race,
 * but documented an honest residual risk tied to filesystem propagation
 * across those two renames, and a prototyped-but-unshipped fully gapless
 * design: stable symlink indirection, swapped via a SINGLE rename(). This
 * test file is that design's pinning test — see gapless-symlink-swap.mjs's
 * header for the full design + Windows/npm-publish fail-open rationale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	atomicReplaceDirGapless,
	_resetGaplessCapabilityCacheForTests,
	_gaplessCapabilityCacheForTests,
} from "../scripts/lib/gapless-symlink-swap.mjs";

function writeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}
}

function listFilesSorted(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string, prefix: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
			else out.push(rel);
		}
	};
	if (fs.existsSync(dir)) walk(dir, "");
	return out.sort();
}

function debrisSiblings(dest: string): string[] {
	return fs
		.readdirSync(path.dirname(dest))
		.filter((name) => name.includes(".tmp-link-") || name.includes(".migrating-"));
}

test("atomicReplaceDirGapless populates a fresh (previously nonexistent) dest as a symlink", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-fresh-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		writeTree(src, { "tools/a/tool.yaml": "a", "tools/b/tool.yaml": "b" });

		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, "dest should be a symlink, not a real dir");
		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/b/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "a");
		assert.deepEqual(debrisSiblings(dest), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomicReplaceDirGapless steady-state re-run: single-rename swap flips content, no debris", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-steady-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");

		writeTree(src, { "tools/a/tool.yaml": "old", "tools/stale/tool.yaml": "stale" });
		atomicReplaceDirGapless(src, dest);
		assert.ok(fs.existsSync(path.join(dest, "tools/stale/tool.yaml")));

		fs.rmSync(path.join(src, "tools/stale"), { recursive: true, force: true });
		writeTree(src, { "tools/a/tool.yaml": "new", "tools/fresh/tool.yaml": "fresh" });
		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/fresh/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "new");
		assert.deepEqual(debrisSiblings(dest), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent reader that resolved dest just before a swap still sees a complete (old, never partial) tree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-concurrent-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		// Deterministic pruning: keep only current + immediately-previous once
		// a version is no longer either of those, regardless of wall-clock age
		// (production default is a 5s grace period on top of that — see the
		// "aggressive churn" test below for why).
		const opts = { retentionWindowMs: 0 };

		writeTree(src, { "tools/a/tool.yaml": "gen1" });
		atomicReplaceDirGapless(src, dest, opts);

		// Simulate a reader (e.g. `docker run -v <dest>:...:ro`) that resolved
		// `dest` to its real target just before the next swap runs.
		const readerResolvedPath = fs.realpathSync(dest);
		const readerSnapshot = listFilesSorted(readerResolvedPath);
		assert.deepEqual(readerSnapshot, ["tools/a/tool.yaml"]);

		writeTree(src, { "tools/a/tool.yaml": "gen2" });
		atomicReplaceDirGapless(src, dest, opts);

		// The generation the reader resolved into is retained for one more
		// generation (see file header) — its content must still be fully
		// present and unmodified, never deleted out from under an in-flight
		// mount and never partially rewritten in place.
		assert.deepEqual(listFilesSorted(readerResolvedPath), ["tools/a/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(readerResolvedPath, "tools/a/tool.yaml"), "utf8"), "gen1");

		// `dest` itself now resolves to the new generation.
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "gen2");

		// Only the current + immediately-previous generation are retained.
		const versionsDir = `${dest}.versions`;
		assert.equal(fs.readdirSync(versionsDir).length, 2);

		// A THIRD swap prunes the now-two-generations-old reader snapshot.
		writeTree(src, { "tools/a/tool.yaml": "gen3" });
		atomicReplaceDirGapless(src, dest, opts);
		assert.equal(fs.existsSync(readerResolvedPath), false, "generation older than current+previous should be pruned");
		assert.equal(fs.readdirSync(versionsDir).length, 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("aggressive-churn grace period keeps versions older than current+previous alive within retentionWindowMs", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-grace-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		const opts = { retentionWindowMs: 60_000 }; // effectively "never prune during this test"

		writeTree(src, { "tools/a/tool.yaml": "gen1" });
		atomicReplaceDirGapless(src, dest, opts);
		const gen1Path = fs.realpathSync(dest);

		for (const gen of ["gen2", "gen3", "gen4"]) {
			writeTree(src, { "tools/a/tool.yaml": gen });
			atomicReplaceDirGapless(src, dest, opts);
		}

		// Even though gen1 is now 3 generations behind current, it survives
		// because it's within the (generous) retention window — this is the
		// margin that fixed a real reproduced regression: under aggressive
		// churn, a `docker run` bind-mount resolving a version can take longer
		// than the time between swaps, so a fixed keep-2-by-count policy could
		// prune a version an in-flight container hadn't finished mounting yet.
		assert.equal(fs.existsSync(gen1Path), true, "old version must survive within the retention window");
		assert.equal(fs.readFileSync(path.join(gen1Path, "tools/a/tool.yaml"), "utf8"), "gen1");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("migrates a pre-existing real-directory dest (prior scheme) onto the symlink scheme cleanly", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-migrate-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");

		// Pre-create dest as a plain directory, simulating build output from
		// atomicReplaceDir (or a pre-this-change build).
		writeTree(dest, { "tools/a/tool.yaml": "old" });
		assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);

		writeTree(src, { "tools/a/tool.yaml": "new", "tools/b/tool.yaml": "b" });
		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), true, "dest should now be a symlink");
		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/b/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "new");
		assert.deepEqual(debrisSiblings(dest), []);

		// Every subsequent build is a true single-rename gapless swap.
		writeTree(src, { "tools/a/tool.yaml": "newer" });
		atomicReplaceDirGapless(src, dest);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "newer");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("supports a custom populate() for callers with per-entry copy rules", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-populate-"));
	try {
		const dest = path.join(root, "dist", "builtin-packs", "market-packs");
		atomicReplaceDirGapless("", dest, {
			populate: (staging) => {
				writeTree(staging, { "pack-a/pack.yaml": "a", "pack-b/pack.yaml": "b" });
			},
		});
		assert.deepEqual(listFilesSorted(dest), ["pack-a/pack.yaml", "pack-b/pack.yaml"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("capability probe fails open to a real-directory fallback, and the result is cached (not re-probed)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-fallback-"));
	const prevEnv = process.env.BOBBIT_DIST_NO_SYMLINK;
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		writeTree(src, { "tools/a/tool.yaml": "a" });

		_resetGaplessCapabilityCacheForTests();
		process.env.BOBBIT_DIST_NO_SYMLINK = "1";
		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), false, "fallback must produce a real directory");
		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml"]);
		assert.equal(_gaplessCapabilityCacheForTests(), false);

		// Remove the forcing env var but DO NOT reset the cache: the probe
		// result must be cached per-process, so this second call must still
		// take the fallback path even though symlinks are actually available
		// on this machine.
		delete process.env.BOBBIT_DIST_NO_SYMLINK;
		writeTree(src, { "tools/a/tool.yaml": "b" });
		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), false, "cached fallback result must be reused, not re-probed");
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "b");
	} finally {
		if (prevEnv === undefined) delete process.env.BOBBIT_DIST_NO_SYMLINK;
		else process.env.BOBBIT_DIST_NO_SYMLINK = prevEnv;
		_resetGaplessCapabilityCacheForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("falling back after a prior gapless run reclaims the orphaned .versions dir", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapless-fallback-reclaim-"));
	const prevEnv = process.env.BOBBIT_DIST_NO_SYMLINK;
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");

		_resetGaplessCapabilityCacheForTests();
		delete process.env.BOBBIT_DIST_NO_SYMLINK;
		writeTree(src, { "tools/a/tool.yaml": "a" });
		atomicReplaceDirGapless(src, dest);
		assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
		assert.ok(fs.existsSync(`${dest}.versions`));

		// Simulate capability becoming unsupported in a later process (e.g. a
		// different, more restricted environment) by resetting the cache and
		// forcing the probe to fail.
		_resetGaplessCapabilityCacheForTests();
		process.env.BOBBIT_DIST_NO_SYMLINK = "1";
		writeTree(src, { "tools/a/tool.yaml": "b" });
		atomicReplaceDirGapless(src, dest);

		assert.equal(fs.lstatSync(dest).isSymbolicLink(), false);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "b");
		assert.equal(fs.existsSync(`${dest}.versions`), false, "orphaned versions dir must be reclaimed");
	} finally {
		if (prevEnv === undefined) delete process.env.BOBBIT_DIST_NO_SYMLINK;
		else process.env.BOBBIT_DIST_NO_SYMLINK = prevEnv;
		_resetGaplessCapabilityCacheForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
