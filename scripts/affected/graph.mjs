// Affected-test dependency graph.
//
// Builds, for every tests2 Vitest file, the set of repo-local source files it
// depends on, so a git diff can be mapped to the minimal set of tests to run.
//
// Two dynamic boundaries the static import scan cannot see are modelled
// explicitly (see docs/testing-v2/suite-speed-analysis.md §F4):
//   1. Gateway-boot tests reach the server through an esbuild prebundle
//      (loadServerTestRuntime). Booting loads the whole server runtime, so any
//      test transitively importing tests2/harness/gateway.ts depends on the
//      entire src/server/** tree (the "boot bucket").
//   2. happy-dom tests eagerly load the web entry bundle, so any test importing
//      the dom environment depends on src/app/** + src/ui/**.
//
// These buckets are coarse on purpose and are the reason the floor cannot drop
// below ~14% without decoupling production code. Everything else is fine-grained.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

export const GATEWAY_HARNESS = "tests2/harness/gateway.ts";
export const DOM_ENV = "tests2/harness/v2-dom-environment.ts";

const IMPORT_RE =
	/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:require|import)\(\s*['"]([^'"]+)['"]/g;

const norm = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === ".git") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

function resolveSpec(fromFile, spec) {
	if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare/package import
	const base = spec.startsWith("/") ? join(REPO_ROOT, spec) : resolve(dirname(fromFile), spec.replace(/[?#].*$/, ""));
	const noExt = base.replace(/\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/, "");
	const cands = [];
	for (const ext of [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]) cands.push(noExt + ext);
	for (const ext of [".ts", ".tsx", ".mjs", ".js"]) cands.push(join(noExt, "index" + ext));
	cands.push(base);
	for (const c of cands) {
		try {
			if (statSync(c).isFile()) return norm(c);
		} catch {
			/* miss */
		}
	}
	return null;
}

/**
 * Build the full graph. Returns:
 *  - testFiles:  string[] of tests2 *.test.ts / *.spec.ts (posix, repo-relative)
 *  - testDeps:   Map<test, Set<srcFile>>  (fine-grained + bucket-expanded)
 *  - srcToTests: Map<srcFile, Set<test>>
 *  - meta:       { serverFiles, uiFiles, bootTests:Set, domTests:Set }
 */
export function buildGraph() {
	const srcFiles = walk(join(REPO_ROOT, "src")).map(norm);
	const testTreeFiles = walk(join(REPO_ROOT, "tests2")).map(norm);
	const defaultFiles = walk(join(REPO_ROOT, "defaults")).map(norm);
	const all = [...srcFiles, ...testTreeFiles, ...defaultFiles];

	// Forward edges: file -> Set(repo-local files it imports).
	const edges = new Map();
	for (const nf of all) {
		const abs = join(REPO_ROOT, nf);
		let src;
		try {
			src = readFileSync(abs, "utf8");
		} catch {
			edges.set(nf, new Set());
			continue;
		}
		const deps = new Set();
		let m;
		IMPORT_RE.lastIndex = 0;
		while ((m = IMPORT_RE.exec(src))) {
			const spec = m[1] || m[2] || m[3] || m[4];
			if (!spec) continue;
			const r = resolveSpec(abs, spec);
			if (r) deps.add(r);
		}
		edges.set(nf, deps);
	}

	const serverFiles = srcFiles.filter((p) => p.startsWith("src/server/"));
	const uiFiles = srcFiles.filter((p) => p.startsWith("src/app/") || p.startsWith("src/ui/"));

	// Boundary (1): gateway-boot bucket.
	if (edges.has(GATEWAY_HARNESS)) {
		const s = edges.get(GATEWAY_HARNESS);
		for (const sf of serverFiles) s.add(sf);
	}

	function closure(start) {
		const seen = new Set();
		const stack = [start];
		while (stack.length) {
			const cur = stack.pop();
			for (const d of edges.get(cur) || []) if (!seen.has(d)) {
				seen.add(d);
				stack.push(d);
			}
		}
		return seen;
	}

	const testFiles = testTreeFiles.filter((p) => /\.(test|spec)\.ts$/.test(p));
	const testDeps = new Map();
	const bootTests = new Set();
	const domTests = new Set();
	for (const t of testFiles) {
		const c = closure(t);
		if (c.has(GATEWAY_HARNESS)) bootTests.add(t);
		const deps = new Set([...c].filter((p) => p.startsWith("src/")));
		// Boundary (2): dom bucket.
		if (c.has(DOM_ENV)) {
			domTests.add(t);
			for (const u of uiFiles) deps.add(u);
		}
		// The test file itself is a dependency of its own verdict.
		deps.add(t);
		testDeps.set(t, deps);
	}

	const srcToTests = new Map();
	for (const [t, deps] of testDeps) {
		for (const d of deps) {
			if (!srcToTests.has(d)) srcToTests.set(d, new Set());
			srcToTests.get(d).add(t);
		}
	}

	return {
		testFiles,
		testDeps,
		srcToTests,
		meta: { serverFiles, uiFiles, bootTests, domTests, allSrc: srcFiles },
	};
}

/**
 * Map a list of changed repo-relative paths to the affected test files.
 * Conservative fallbacks (run everything) for changes the graph cannot bound:
 *  - test harness / config / vitest config / this tool itself.
 * Returns { affected:Set<test>, runAll:boolean, reason?:string }.
 */
export function affectedTests(graph, changed) {
	const runAllTriggers = [
		/^tests2\/harness\//,
		/^vitest\.config\.ts$/,
		/^tsconfig.*\.json$/,
		/^package\.json$/,
		/^scripts\/affected\//,
		/^scripts\/testing-v2\/(server-prebundle|test-map-execution|server-runtime)/,
	];
	for (const ch of changed) {
		const n = ch.replace(/\\/g, "/");
		if (runAllTriggers.some((re) => re.test(n)))
			return { affected: new Set(graph.testFiles), runAll: true, reason: `broad change: ${n}` };
	}
	const affected = new Set();
	for (const ch of changed) {
		const n = ch.replace(/\\/g, "/");
		if (/\.(test|spec)\.ts$/.test(n) && n.startsWith("tests2/")) {
			if (graph.testDeps.has(n)) affected.add(n);
			continue;
		}
		for (const t of graph.srcToTests.get(n) || []) affected.add(t);
	}
	return { affected, runAll: false };
}
