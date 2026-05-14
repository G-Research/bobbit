#!/usr/bin/env node
// Summarise Opt-C A/B replicate runs.
// Reads docs/perf/history/<sha>-opt-c-{off,on}-{1..5}.json and prints
// median-of-medians + min/max range for the key spans.

import fs from "node:fs";
import path from "node:path";

const HIST = path.resolve("docs/perf/history");
const SHA = "52bbf9788ac6";

const SPANS = [
	"nav.session.ready",
	"nav.goal.ready",
	"api.session.fetch",
	"api.goal.fetch",
	"reducer.rehydrate",
	"paint.first",
	"rapidnav.keystroke.cached",
	"rapidnav.keystroke.uncached",
];

function load(tag) {
	const file = path.join(HIST, `${SHA}-${tag}.json`);
	const j = JSON.parse(fs.readFileSync(file, "utf8"));
	return j.spans || {};
}

const off = [1, 2, 3, 4, 5].map(i => load(`opt-c-off-${i}`));
const on  = [1, 2, 3, 4, 5].map(i => load(`opt-c-on-${i}`));

function median(arr) {
	const s = [...arr].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function fmt(n) {
	if (n === undefined || n === null || Number.isNaN(n)) return "—";
	return n.toFixed(1);
}

function row(span) {
	const offP50s = off.map(s => s[span]?.p50).filter(v => v !== undefined);
	const onP50s  = on.map(s => s[span]?.p50).filter(v => v !== undefined);
	const offP95s = off.map(s => s[span]?.p95).filter(v => v !== undefined);
	const onP95s  = on.map(s => s[span]?.p95).filter(v => v !== undefined);
	const offNs   = off.map(s => s[span]?.n).filter(v => v !== undefined);
	const onNs    = on.map(s => s[span]?.n).filter(v => v !== undefined);

	const offMedP50 = median(offP50s);
	const onMedP50  = median(onP50s);
	const offMedP95 = median(offP95s);
	const onMedP95  = median(onP95s);
	const dP50 = offMedP50 - onMedP50;
	const dP95 = offMedP95 - onMedP95;

	const offRange = `[${fmt(Math.min(...offP50s))}-${fmt(Math.max(...offP50s))}]`;
	const onRange  = `[${fmt(Math.min(...onP50s))}-${fmt(Math.max(...onP50s))}]`;

	console.log(`${span.padEnd(32)} | n: off ${offNs.join(",")} on ${onNs.join(",")}`);
	console.log(`  p50 off=${fmt(offMedP50).padStart(7)} ${offRange.padEnd(18)} on=${fmt(onMedP50).padStart(7)} ${onRange.padEnd(18)} Δ=${fmt(dP50).padStart(7)}ms`);
	console.log(`  p95 off=${fmt(offMedP95).padStart(7)} on=${fmt(onMedP95).padStart(7)} Δ=${fmt(dP95).padStart(7)}ms`);
}

console.log(`Opt-C prefetch-on-hover A/B (5 replicates each, SHA ${SHA}, fixture=medium)`);
console.log("=".repeat(80));
for (const s of SPANS) row(s);
console.log("=".repeat(80));
console.log("Decision rule: Δp50 ≥ 100ms on nav.session.ready, OR moves p50 below 100ms.");
