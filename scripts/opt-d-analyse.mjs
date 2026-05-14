// Quick analyser for Opt-D A/B replicates.
// Reads docs/perf/history/606833ce8450-opt-d-{off,on}-{1..5}.json,
// prints median / min / max of each span's p50 across replicates per arm,
// plus the per-arm median-of-medians delta and verdict.

import fs from "node:fs";
import path from "node:path";

const HISTORY = "docs/perf/history";
const SHA = "606833ce8450";
const SPANS = [
	"nav.goal.cold",
	"nav.goal.ready",
	"api.goal.fetch",
	"api.goal.gates.fetch",
	"api.goal.agents.fetch",
	"api.session.fetch",
	"nav.session.ready",
	"nav.session.cold",
];

function load(arm, i) {
	const p = path.join(HISTORY, `${SHA}-opt-d-${arm}-${i}.json`);
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	if (n === 0) return NaN;
	if (n % 2) return s[(n - 1) / 2];
	return (s[n / 2 - 1] + s[n / 2]) / 2;
}

function statsFor(arm) {
	const runs = [1, 2, 3, 4, 5].map((i) => load(arm, i));
	const out = {};
	for (const span of SPANS) {
		const p50s = runs.map((r) => r.spans[span]?.p50).filter((x) => Number.isFinite(x));
		const p95s = runs.map((r) => r.spans[span]?.p95).filter((x) => Number.isFinite(x));
		const ns = runs.map((r) => r.spans[span]?.n).filter((x) => Number.isFinite(x));
		out[span] = {
			p50: { med: median(p50s), min: Math.min(...p50s), max: Math.max(...p50s), n: p50s.length },
			p95: { med: median(p95s), min: Math.min(...p95s), max: Math.max(...p95s), n: p95s.length },
			sampleN: ns.length ? `${Math.min(...ns)}-${Math.max(...ns)}` : "?",
			raw: p50s,
		};
	}
	return out;
}

const off = statsFor("off");
const on = statsFor("on");

function fmt(x) { return Number.isFinite(x) ? x.toFixed(1).padStart(7) : "    ?  "; }

console.log("\nOpt-D A/B replicates (n=5 per arm), commit", SHA);
console.log("Fixture: medium (50 msgs/session × 32 sessions). Same SHA, same env.\n");
console.log("Span                       |  OFF p50 med [min..max]       |   ON p50 med [min..max]       |     Δmed |   per-run samples");
console.log("-".repeat(140));
for (const span of SPANS) {
	const o = off[span].p50, n = on[span].p50;
	const d = n.med - o.med;
	const winner = d <= -100 ? "  WIN" : d >= 100 ? " regress" : "      ";
	console.log(
		span.padEnd(26),
		"|",
		fmt(o.med),
		"[",
		fmt(o.min),
		"..",
		fmt(o.max),
		"]   |",
		fmt(n.med),
		"[",
		fmt(n.min),
		"..",
		fmt(n.max),
		"]   |",
		fmt(d),
		winner,
		"|  off:",
		off[span].sampleN,
		" on:",
		on[span].sampleN,
	);
}

console.log("\nRaw p50 series (off vs on) for the key cold span:\n");
console.log("  nav.goal.cold OFF :", off["nav.goal.cold"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  nav.goal.cold ON  :", on["nav.goal.cold"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.gates.fetch OFF :", off["api.goal.gates.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.gates.fetch ON  :", on["api.goal.gates.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.agents.fetch OFF:", off["api.goal.agents.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.agents.fetch ON :", on["api.goal.agents.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.fetch OFF       :", off["api.goal.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
console.log("  api.goal.fetch ON        :", on["api.goal.fetch"].raw.map((x) => x.toFixed(1)).join(", "));
