// Content-hash test result cache.
//
// A test's PASS is reusable only while its complete dependency closure and the
// runner fingerprint are unchanged. The cache is deliberately checkout-local;
// callers may override repoRoot/cacheDir only for isolated tests.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./graph.mjs";

const LOCKFILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
]);

const FINGERPRINT_FILES = [
	"tests2/tests-map.json",
	"scripts/testing-v2/test-map-execution.mjs",
	"scripts/testing-v2/repo-source-closure.mjs",
	"scripts/affected/graph.mjs",
	"scripts/affected/impact-rules.mjs",
	"scripts/affected/classification.mjs",
	"scripts/affected/cache.mjs",
	"scripts/affected/run.mjs",
];

const PACKAGE_EXECUTION_KEYS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"overrides",
	"resolutions",
	"workspaces",
	"packageManager",
	"type",
	"imports",
	"exports",
	"engines",
	"os",
	"cpu",
	"libc",
];

function paths(options = {}) {
	const repoRoot = options.repoRoot ?? REPO_ROOT;
	const cacheDir = options.cacheDir ?? join(repoRoot, ".profiles", "test-cache");
	return { repoRoot, cacheDir, cacheFile: options.cacheFile ?? join(cacheDir, "results.json") };
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

/** Pure package projection for fields that can change test execution. */
export function packageExecutionProjection(pkg) {
	const projection = {};
	for (const key of PACKAGE_EXECUTION_KEYS) {
		if (Object.prototype.hasOwnProperty.call(pkg, key)) projection[key] = pkg[key];
	}
	return stableValue(projection);
}

function fileDigest(repoRoot, relPath) {
	try {
		return createHash("sha256").update(readFileSync(join(repoRoot, relPath))).digest("hex");
	} catch {
		return "missing";
	}
}

function rootFingerprintFiles(repoRoot) {
	let names = [];
	try {
		names = readdirSync(repoRoot);
	} catch {
		// The explicit entries below still produce a deterministic missing-root fingerprint.
	}
	const broadFiles = names.filter((name) =>
		LOCKFILES.has(name)
		|| /^tsconfig(?:\..+)?\.json$/u.test(name)
		|| /^vitest\.config\.[^.]+$/u.test(name));
	return [...new Set([...FINGERPRINT_FILES, ...broadFiles])].sort();
}

/** Stable content hash of a test's dependency closure. */
export function testHash(testFile, deps, options = {}) {
	const { repoRoot } = paths(options);
	const closure = new Set(deps ?? []);
	closure.add(testFile);
	const hash = createHash("sha256");
	for (const file of [...closure].sort()) {
		hash.update(file).update("\0").update(fileDigest(repoRoot, file)).update("\0");
	}
	return hash.digest("hex").slice(0, 24);
}

/**
 * Namespace cache records by runtime identity and every input that controls
 * test ownership, selection, resolution, or execution.
 */
export function runnerFingerprint(options = {}) {
	const { repoRoot } = paths(options);
	const hash = createHash("sha256");
	hash.update(stableJson({ node: process.versions.node, platform: process.platform, arch: process.arch }));

	let packageProjection = "malformed";
	let malformedPackageDigest = "";
	let vitest = "?";
	try {
		const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
		packageProjection = stableJson(packageExecutionProjection(pkg));
		vitest = pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest ?? "?";
	} catch {
		// Distinguish malformed contents without letting scripts/publication metadata
		// invalidate a valid semantic package projection.
		malformedPackageDigest = fileDigest(repoRoot, "package.json");
	}
	hash.update("\0vitest\0").update(String(vitest));
	hash.update("\0package-execution\0").update(packageProjection).update(malformedPackageDigest);

	for (const file of rootFingerprintFiles(repoRoot)) {
		hash.update("\0").update(file).update("\0").update(fileDigest(repoRoot, file));
	}
	return `affected-v2-${hash.digest("hex").slice(0, 32)}`;
}

export function loadCache(options = {}) {
	const { cacheFile } = paths(options);
	if (!existsSync(cacheFile)) return {};
	try {
		const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function saveCache(cache, options = {}) {
	const { cacheDir, cacheFile } = paths(options);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(cacheFile, JSON.stringify(isRecord(cache) ? cache : {}));
}

/** Partition a bounded candidate set into {hits, misses}. */
export function partition(cache, fingerprint, graph, tests, options = {}) {
	const candidateBucket = isRecord(cache) ? cache[fingerprint] : undefined;
	const bucket = isRecord(candidateBucket) ? candidateBucket : {};
	const hits = new Set();
	const misses = new Set();
	for (const test of tests) {
		const deps = graph.testDeps.get(test);
		if (!deps) {
			misses.add(test);
			continue;
		}
		const hash = testHash(test, deps, options);
		const cached = bucket[test];
		if (isRecord(cached) && cached.hash === hash && cached.verdict === "pass") hits.add(test);
		else misses.add(test);
	}
	return { hits, misses };
}

/**
 * Record per-file verdicts. Only PASS records are retained; a failure or
 * ambiguous verdict removes any stale PASS for that file.
 */
export function record(cache, fingerprint, graph, tests, verdict, options = {}) {
	const safeCache = isRecord(cache) ? cache : {};
	const existing = safeCache[fingerprint];
	const bucket = isRecord(existing) ? existing : (safeCache[fingerprint] = {});
	for (const test of tests) {
		if (verdict !== "pass") {
			delete bucket[test];
			continue;
		}
		const deps = graph.testDeps.get(test);
		if (!deps) {
			delete bucket[test];
			continue;
		}
		bucket[test] = { hash: testHash(test, deps, options), verdict: "pass" };
	}
	return safeCache;
}
