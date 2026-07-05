#!/usr/bin/env node
/**
 * parity.mjs — Test Suite v2 parity / guard proof.
 *
 * The mass-migration gate runs:  node scripts/testing-v2/parity.mjs --scope core
 *
 * For `--scope core` the authoritative check is BUCKET MEMBERSHIP + GUARD
 * SELF-COVERAGE (the script-side twin of tests2/core/guard-v2.test.ts):
 *
 *   1. No dangling v2Path — every v2-core/dom/integration entry whose `v2Path`
 *      is set must point at a file that exists under tests2/.
 *   2. No orphans — every actual test file under tests2/{core,dom,integration}
 *      is claimed either by an entry's `v2Path` or by the curated `v2Native`
 *      allowlist. A stray new file that is neither fails.
 *   3. No retired-without-replacement — any entry with method
 *      "retire-with-mapping" must carry a non-empty `replacement[]` (journey
 *      ids or tests2 paths) or a `v2Path`.
 *   4. Guard self-coverage — tests2/core/guard-v2.test.ts must exist and be on
 *      the `v2Native` allowlist, and every v2Native path must resolve.
 *
 * "Pending" entries (managed bucket, not yet migrated, no v2Path) are NOT a
 * violation during migration — they are reported as a count. The gate reviewer
 * reads the pending count to gauge migration progress; the hard invariants
 * above are what keep tests-map.json honest as files land.
 *
 * A report is written to
 *   .profiles/testing-v2/parity/<timestamp>-<scope>.json
 * Exit 0 on pass; non-zero (with a printed list) on any violation.
 *
 * // TODO: V8 coverage comparison (parity-proof gate) — compare per-area
 * // line+branch coverage against the gate-1 baselines and assert
 * // non-regression. Deferred: the mass-migration gate only needs bucket
 * // membership + guard self-coverage; the coverage baselines land with the
 * // dedicated parity-proof gate.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./lib-census.mjs";

const SUPPORT_DIRS = new Set(["_quarantine", "_setup", "_e2e", "helpers"]);
const MANAGED = [
	["v2-core", "tests2/core"],
	["v2-dom", "tests2/dom"],
	["v2-integration", "tests2/integration"],
];
const MANAGED_BUCKETS = new Set(MANAGED.map(([b]) => b));
const GUARD_PATH = "tests2/core/guard-v2.test.ts";

const toPosix = (p) => p.replace(/\\/g, "/");

function parseArgs(argv) {
	const out = { scope: "core" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--scope") out.scope = argv[++i];
		else if (a.startsWith("--scope=")) out.scope = a.slice("--scope=".length);
	}
	return out;
}

/** Recursively list *.test.ts / *.spec.ts under a tests2 subtree (repo-relative posix). */
function listActual(rootRel) {
	const abs = join(REPO_ROOT, rootRel);
	const out = [];
	const walk = (dir) => {
		let ents;
		try {
			ents = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // subtree may not exist yet during early migration
		}
		for (const e of ents) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (SUPPORT_DIRS.has(e.name)) continue;
				walk(full);
			} else if (/\.(test|spec)\.ts$/.test(e.name)) {
				out.push(toPosix(full.slice(REPO_ROOT.length + 1)));
			}
		}
	};
	walk(abs);
	return out.sort();
}

function main() {
	const { scope } = parseArgs(process.argv.slice(2));
	const mapPath = join(REPO_ROOT, "tests2", "tests-map.json");

	let map;
	try {
		map = JSON.parse(readFileSync(mapPath, "utf8"));
	} catch (e) {
		console.error(`parity: could not read/parse ${mapPath}: ${e.message}`);
		process.exit(2);
	}
	const entries = Array.isArray(map) ? map : map.entries;
	if (!Array.isArray(entries)) {
		console.error("parity: tests-map.json has no entries array.");
		process.exit(2);
	}
	const v2Native = (map && !Array.isArray(map) && Array.isArray(map.v2Native)) ? map.v2Native : [];

	const violations = [];

	// Index of every path claimed by a legacy entry's v2Path.
	const claimed = new Set(
		entries.filter((e) => typeof e.v2Path === "string" && e.v2Path).map((e) => e.v2Path),
	);
	const nativePaths = new Set(v2Native.map((n) => n.path));

	// (1) No dangling v2Path.
	for (const e of entries) {
		if (MANAGED_BUCKETS.has(e.bucket) && typeof e.v2Path === "string" && e.v2Path) {
			if (!existsSync(join(REPO_ROOT, e.v2Path))) {
				violations.push(`DANGLING v2Path: ${e.file} -> ${e.v2Path} (file does not exist).`);
			}
		}
	}

	// (2) No orphans — every actual tests2 file is claimed or v2Native.
	const actual = MANAGED.flatMap(([, rel]) => listActual(rel));
	const orphans = actual.filter((f) => !claimed.has(f) && !nativePaths.has(f));
	for (const f of orphans) {
		violations.push(
			`ORPHAN tests2 file: ${f} — not claimed by any v2Path and not in tests-map.json "v2Native".`,
		);
	}

	// (3) No retired-without-replacement.
	for (const e of entries) {
		if (e.method === "retire-with-mapping") {
			const hasRepl = Array.isArray(e.replacement) && e.replacement.length > 0;
			const hasPath = typeof e.v2Path === "string" && e.v2Path.length > 0;
			if (!hasRepl && !hasPath) {
				violations.push(`RETIRED-WITHOUT-REPLACEMENT: ${e.file} (method retire-with-mapping, empty replacement[], no v2Path).`);
			}
		}
	}

	// (4) Guard self-coverage.
	if (!existsSync(join(REPO_ROOT, GUARD_PATH))) {
		violations.push(`GUARD MISSING: ${GUARD_PATH} does not exist (the v2 bucket-membership guard test).`);
	}
	if (!nativePaths.has(GUARD_PATH)) {
		violations.push(`GUARD NOT SELF-COVERED: ${GUARD_PATH} is not listed in tests-map.json "v2Native".`);
	}
	for (const n of v2Native) {
		if (!existsSync(join(REPO_ROOT, n.path))) {
			violations.push(`V2NATIVE MISSING: ${n.path} listed in v2Native but not present on disk.`);
		}
	}

	// Counts for the report.
	const migrated = entries.filter((e) => typeof e.v2Path === "string" && e.v2Path).length;
	const daily = entries.filter((e) => e.bucket === "daily").length;
	const pending = entries.filter((e) => MANAGED_BUCKETS.has(e.bucket) && !(typeof e.v2Path === "string" && e.v2Path)).length;

	const report = {
		generatedBy: "scripts/testing-v2/parity.mjs",
		scope,
		timestamp: new Date().toISOString(),
		pass: violations.length === 0,
		counts: {
			total: entries.length,
			migrated,
			daily,
			pending,
			v2Native: v2Native.length,
			actualTests2Files: actual.length,
			orphans: orphans.length,
			violations: violations.length,
		},
		violations,
		// coverage: null,  // TODO: V8 coverage comparison (parity-proof gate)
	};

	const stamp = report.timestamp.replace(/[:.]/g, "-");
	const outDir = join(REPO_ROOT, ".profiles", "testing-v2", "parity");
	mkdirSync(outDir, { recursive: true });
	const artifactPath = join(outDir, `${stamp}-${scope}.json`);
	writeFileSync(artifactPath, JSON.stringify(report, null, "\t") + "\n", "utf8");

	if (violations.length > 0) {
		console.error(`parity (--scope ${scope}): FAIL — ${violations.length} violation(s)\n`);
		for (const v of violations) console.error("  - " + v);
		console.error(`\nReport: ${toPosix(artifactPath.slice(REPO_ROOT.length + 1))}`);
		process.exit(1);
	}

	console.log(`parity (--scope ${scope}): PASS`);
	console.log(
		`\n  total=${report.counts.total} migrated=${migrated} daily=${daily} pending=${pending} ` +
			`v2Native=${v2Native.length} orphans=${orphans.length} violations=0`,
	);
	console.log(`\nReport: ${toPosix(artifactPath.slice(REPO_ROOT.length + 1))}`);
	process.exit(0);
}

main();
