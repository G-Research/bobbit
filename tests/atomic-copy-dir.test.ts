/**
 * Pinning test for scripts/lib/atomic-copy-dir.mjs, used by
 * scripts/copy-defaults.mjs and scripts/copy-builtin-packs.mjs to rebuild
 * dist/server/defaults and dist/server/builtin-packs/market-packs.
 *
 * Root cause this guards against: those two dirs are bind-mounted read-only
 * into sandbox Docker containers (docker-args.ts, as /tools-builtin and
 * /market-packs-builtin). The old `shx rm -rf <dest> && copy(...)` build step
 * left a real ~150ms window (measured) where <dest> was either completely
 * absent or only partially repopulated. `docker run -v <dest>:...:ro` auto-
 * creates a missing bind-mount source with NO error, so a sandbox spawn whose
 * container-create call landed in that window silently got an empty mount for
 * its entire lifetime — reproduced independently at a ~75% hit rate against a
 * churning rebuild loop. atomicReplaceDir closes (most of) this by building
 * into a staging dir and swapping it into place via rename(2), so any
 * concurrent reader only ever observes the fully-old or fully-new tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicReplaceDir } from "../scripts/lib/atomic-copy-dir.mjs";

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

test("atomicReplaceDir populates a fresh (previously nonexistent) dest", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-fresh-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		writeTree(src, { "tools/a/tool.yaml": "a", "tools/b/tool.yaml": "b" });

		atomicReplaceDir(src, dest);

		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/b/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "a");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomicReplaceDir fully replaces stale content — no leftover files from the old tree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-replace-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");

		writeTree(src, { "tools/a/tool.yaml": "a", "tools/stale-group/tool.yaml": "stale" });
		atomicReplaceDir(src, dest);
		assert.ok(fs.existsSync(path.join(dest, "tools/stale-group/tool.yaml")));

		// Second build: stale-group is gone from source, new-group appears.
		fs.rmSync(path.join(src, "tools/stale-group"), { recursive: true, force: true });
		writeTree(src, { "tools/new-group/tool.yaml": "new" });
		atomicReplaceDir(src, dest);

		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/new-group/tool.yaml"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomicReplaceDir leaves no .tmp-/.old- staging debris behind after a successful swap", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-debris-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		writeTree(src, { "tools/a/tool.yaml": "a" });

		atomicReplaceDir(src, dest); // fresh
		atomicReplaceDir(src, dest); // steady-state re-run

		const siblings = fs.readdirSync(path.dirname(dest));
		for (const name of siblings) {
			assert.ok(
				!name.includes(".tmp-") && !name.includes(".old-"),
				`unexpected staging debris left behind: ${name}`,
			);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomicReplaceDir recovers cleanly from debris left by a previous crashed run", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-crash-recovery-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");
		writeTree(src, { "tools/a/tool.yaml": "a" });
		atomicReplaceDir(src, dest);

		// Simulate a previous run that died mid-copy, leaving staging/old debris
		// using the same naming scheme atomicReplaceDir uses.
		fs.mkdirSync(`${dest}.tmp-99999-1`, { recursive: true });
		fs.writeFileSync(path.join(`${dest}.tmp-99999-1`, "half-written"), "x");
		fs.mkdirSync(`${dest}.old-99999-1`, { recursive: true });

		writeTree(src, { "tools/b/tool.yaml": "b" });
		atomicReplaceDir(src, dest);

		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/b/tool.yaml"]);
		assert.ok(!fs.existsSync(`${dest}.tmp-99999-1`));
		assert.ok(!fs.existsSync(`${dest}.old-99999-1`));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("atomicReplaceDir supports a custom populate() for callers with per-entry copy rules", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-populate-"));
	try {
		const dest = path.join(root, "dist", "builtin-packs", "market-packs");
		atomicReplaceDir("", dest, {
			populate: (staging) => {
				writeTree(staging, { "pack-a/pack.yaml": "a", "pack-b/pack.yaml": "b" });
			},
		});
		assert.deepEqual(listFilesSorted(dest), ["pack-a/pack.yaml", "pack-b/pack.yaml"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("swapping over a pre-existing dest (e.g. dist/ from a prior build) ends in a complete, debris-free tree", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-copy-transition-"));
	try {
		const src = path.join(root, "src");
		const dest = path.join(root, "dist", "defaults");

		// Pre-create dest as a plain directory (bypassing atomicReplaceDir),
		// simulating pre-existing build output from before this fix.
		writeTree(dest, { "tools/a/tool.yaml": "old" });

		writeTree(src, { "tools/a/tool.yaml": "new", "tools/b/tool.yaml": "b" });
		atomicReplaceDir(src, dest);

		assert.deepEqual(listFilesSorted(dest), ["tools/a/tool.yaml", "tools/b/tool.yaml"]);
		assert.equal(fs.readFileSync(path.join(dest, "tools/a/tool.yaml"), "utf8"), "new");
		for (const name of fs.readdirSync(path.dirname(dest))) {
			assert.ok(!name.includes(".tmp-") && !name.includes(".old-"), `unexpected staging debris: ${name}`);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
