#!/usr/bin/env node
/**
 * check-inventory.mjs — validate tests2/tests-map.json against the live census.
 *
 * Exits non-zero (with a clear message) on ANY of:
 *   - a census file (tests/**) missing from the map      (orphan)
 *   - a map entry whose file no longer exists            (phantom)
 *   - a census file mapped more than once                (duplicate)
 *   - an entry with an invalid bucket or method
 *   - a retire-with-mapping / retired entry with an empty replacement[]
 *   - a replacement journey ID not present in the map's journey catalogue
 *
 * On success: prints a per-bucket reconciliation summing to the census total,
 * and exits 0. This script is the single gate for the inventory deliverable and
 * is also the generator's self-check.
 *
 * No new dependencies — pure Node ESM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { census, REPO_ROOT, BUCKETS, METHODS } from "./lib-census.mjs";

function fail(lines) {
	console.error("check-inventory: FAIL\n");
	for (const l of lines) console.error("  - " + l);
	console.error(`\n${lines.length} violation(s).`);
	process.exit(1);
}

function main() {
	const mapPath = join(REPO_ROOT, "tests2", "tests-map.json");
	let raw;
	try {
		raw = JSON.parse(readFileSync(mapPath, "utf8"));
	} catch (e) {
		fail([`Could not read/parse ${mapPath}: ${e.message}. Run: node scripts/testing-v2/gen-inventory.mjs`]);
	}

	const entries = Array.isArray(raw) ? raw : raw.entries;
	if (!Array.isArray(entries)) {
		fail(["tests-map.json must be an array of entries or an object with an `entries` array."]);
	}
	const journeys = (raw && !Array.isArray(raw) && raw.journeys) || {};
	const knownJourneys = new Set(Object.keys(journeys));

	const censusFiles = new Set(census());
	const problems = [];

	// Per-entry validation + duplicate detection.
	const seen = new Map(); // file -> count
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const where = e && e.file ? e.file : `entry[${i}]`;
		if (!e || typeof e.file !== "string") {
			problems.push(`${where}: missing string "file".`);
			continue;
		}
		seen.set(e.file, (seen.get(e.file) ?? 0) + 1);

		if (!BUCKETS.includes(e.bucket)) {
			problems.push(`${e.file}: invalid bucket "${e.bucket}" (allowed: ${BUCKETS.join(", ")}).`);
		}
		if (!METHODS.includes(e.method)) {
			problems.push(`${e.file}: invalid method "${e.method}" (allowed: ${METHODS.join(", ")}).`);
		}
		const repl = e.replacement;
		if (repl !== undefined && !Array.isArray(repl)) {
			problems.push(`${e.file}: "replacement" must be an array when present.`);
		}
		if (e.method === "retire-with-mapping") {
			if (!Array.isArray(repl) || repl.length === 0) {
				problems.push(`${e.file}: method "retire-with-mapping" requires a non-empty replacement[].`);
			} else {
				for (const r of repl) {
					if (knownJourneys.size > 0 && r.startsWith("journey-") && !knownJourneys.has(r)) {
						problems.push(`${e.file}: replacement journey "${r}" is not in the map journey catalogue.`);
					}
				}
			}
		}
		if (typeof e.rationale !== "string" || e.rationale.trim() === "") {
			problems.push(`${e.file}: missing non-empty "rationale".`);
		}
	}

	// Duplicates.
	for (const [file, count] of seen) {
		if (count > 1) problems.push(`DUPLICATE: ${file} mapped ${count} times (must appear exactly once).`);
	}

	// Orphans: census files not in the map.
	for (const f of censusFiles) {
		if (!seen.has(f)) problems.push(`ORPHAN: ${f} — present in census but not classified in tests-map.json.`);
	}

	// Phantoms: map files not in the census (deleted/renamed).
	for (const f of seen.keys()) {
		if (!censusFiles.has(f)) problems.push(`PHANTOM: ${f} — in tests-map.json but not in the census (deleted/renamed?).`);
	}

	if (problems.length > 0) fail(problems);

	// Success — print reconciliation.
	const byBucket = {};
	const byMethod = {};
	for (const e of entries) {
		byBucket[e.bucket] = (byBucket[e.bucket] ?? 0) + 1;
		byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
	}
	const total = entries.length;
	console.log("check-inventory: PASS");
	console.log(`\nCensus total: ${censusFiles.size} — mapped: ${total} (exactly once each).`);
	console.log("\nPer-bucket:");
	let sum = 0;
	for (const b of BUCKETS) {
		const n = byBucket[b] ?? 0;
		sum += n;
		console.log(`  ${b.padEnd(16)} ${n}`);
	}
	console.log(`  ${"= total".padEnd(16)} ${sum}`);
	console.log("\nPer-method:");
	for (const m of METHODS) console.log(`  ${m.padEnd(20)} ${byMethod[m] ?? 0}`);
	const retired = entries.filter((e) => e.method === "retire-with-mapping").length;
	console.log(`\nJourneys defined: ${knownJourneys.size}; retired specs mapped to journeys: ${retired}.`);

	if (sum !== censusFiles.size) {
		fail([`Reconciliation mismatch: bucket sum ${sum} != census ${censusFiles.size}.`]);
	}
	process.exit(0);
}

main();
