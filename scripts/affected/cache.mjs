// Content-hash test result cache.
//
// A test's verdict is valid while the content hash of (its transitive source
// dependency closure + the runner fingerprint) is unchanged. A cache hit means
// the test does not need to run again — its prior PASS is replayed. This is the
// Bazel/Nx/Turborepo model, scoped to one repo checkout.
//
// Stored at .profiles/test-cache/results.json:  { fingerprint: { <test>: {hash, verdict} } }
// The `fingerprint` outer key namespaces by runner version + config so a Vitest
// or config bump transparently invalidates everything.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./graph.mjs";

const CACHE_DIR = join(REPO_ROOT, ".profiles", "test-cache");
const CACHE_FILE = join(CACHE_DIR, "results.json");

function fileHash(relPath) {
	try {
		return createHash("sha1").update(readFileSync(join(REPO_ROOT, relPath))).digest("hex").slice(0, 16);
	} catch {
		return "missing";
	}
}

/** Stable content hash of a test's dependency closure. */
export function testHash(testFile, deps) {
	const h = createHash("sha256");
	for (const f of [...deps].sort()) h.update(f).update("\0").update(fileHash(f)).update("\0");
	return h.digest("hex").slice(0, 24);
}

/** Runner fingerprint — bump-safe namespace. */
export function runnerFingerprint() {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const vitest = pkg.devDependencies?.vitest ?? "?";
	const cfg = fileHash("vitest.config.ts");
	return `vitest@${vitest}+cfg@${cfg}`;
}

export function loadCache() {
	if (!existsSync(CACHE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
	} catch {
		return {};
	}
}

export function saveCache(cache) {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
}

/** Partition a candidate test set into {hits, misses} against the cache. */
export function partition(cache, fingerprint, graph, tests) {
	const bucket = cache[fingerprint] || {};
	const hits = new Set();
	const misses = new Set();
	for (const t of tests) {
		const deps = graph.testDeps.get(t);
		if (!deps) {
			misses.add(t);
			continue;
		}
		const hash = testHash(t, deps);
		const rec = bucket[t];
		if (rec && rec.hash === hash && rec.verdict === "pass") hits.add(t);
		else misses.add(t);
	}
	return { hits, misses };
}

/** Record verdicts for a set of tests after a run. */
export function record(cache, fingerprint, graph, tests, verdict) {
	const bucket = (cache[fingerprint] = cache[fingerprint] || {});
	for (const t of tests) {
		const deps = graph.testDeps.get(t);
		if (!deps) continue;
		bucket[t] = { hash: testHash(t, deps), verdict };
	}
	return cache;
}
