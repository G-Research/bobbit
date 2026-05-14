#!/usr/bin/env node
/**
 * scripts/perf-backfill-kind.mjs
 *
 * One-off backfill: tag every existing `docs/perf/history/*.json` with an
 * explicit `kind` field ("baseline" | "experiment") plus, for A/B runs,
 * `experimentTag` and `experimentCondition`. See task 1460c955 for the
 * rationale — the cross-commit report previously rendered fixture-growth
 * baselines and code-change experiments identically, which was misread as
 * a code regression.
 *
 * Run once (idempotent — safe to re-run):
 *   node scripts/perf-backfill-kind.mjs
 *
 * The harness now sets `kind` directly via `BOBBIT_PERF_HISTORY_KIND`, so
 * future runs don't need this script.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = join(ROOT, "docs", "perf", "history");

// Filename → { kind, experimentTag?, experimentCondition? }. Each entry
// represents a fixture / harness change (baseline) or one half of an A/B
// (experiment). See task 1460c955 §5.
const BACKFILL = {
	"999bdc2ed47e.json":                          { kind: "baseline" },
	"c25e40be730b.json":                          { kind: "baseline" },
	"c25e40be730b-large.json":                    { kind: "baseline" },
	"5309f93c5ee8-realistic-medium.json":         { kind: "baseline" },
	"5309f93c5ee8-realistic-large.json":          { kind: "baseline" },
	"294bd68da3c8-realistic-medium-rapid.json":   { kind: "baseline" },
	"294bd68da3c8-realistic-large-rapid.json":    { kind: "baseline" },
	"d6585b472604-opt-b-off.json":                { kind: "experiment", experimentTag: "opt-b", experimentCondition: "off" },
	"d6585b472604-opt-b-on.json":                 { kind: "experiment", experimentTag: "opt-b", experimentCondition: "on" },
};

let modified = 0;
const present = new Set(readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")));
for (const [name, fields] of Object.entries(BACKFILL)) {
	if (!present.has(name)) {
		console.warn(`[backfill] skip missing ${name}`);
		continue;
	}
	const p = join(HISTORY_DIR, name);
	const j = JSON.parse(readFileSync(p, "utf-8"));
	let changed = false;
	for (const [k, v] of Object.entries(fields)) {
		if (j[k] !== v) { j[k] = v; changed = true; }
	}
	if (changed) {
		// Preserve the existing key order as much as possible: re-emit with
		// `kind` etc. inserted near the other metadata fields, before `spans`.
		const { spans, ...rest } = j;
		const out = { ...rest, ...fields, spans };
		writeFileSync(p, JSON.stringify(out, null, 2) + "\n", "utf-8");
		console.log(`[backfill] ${name}: set ${Object.keys(fields).join(", ")}`);
		modified++;
	}
}
console.log(`[backfill] done (${modified} file(s) modified, ${present.size - modified} already current)`);
