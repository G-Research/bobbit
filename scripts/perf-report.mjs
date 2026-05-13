#!/usr/bin/env node
/**
 * scripts/perf-report.mjs
 *
 * Reads every `docs/perf/history/*.json` (one per commit) and emits
 * `docs/perf/sidebar-nav-report.html` — a single, fully self-contained
 * HTML page with:
 *
 *   • Summary table: span × first-baseline × latest × delta (ms, %)
 *   • One inline-SVG line chart per canonical span, p50 (solid) + p95 (dashed)
 *     plotted across commits ordered by timestamp, x-axis labelled with the
 *     short SHA.
 *
 * Plain Node, no deps. Inline SVG. Uses Bobbit's CSS custom-property tokens
 * (--background, --foreground, --chart-1..6, etc.) so it adopts the user's
 * theme when previewed inside Bobbit; falls back to readable light defaults
 * otherwise.
 *
 * Invoked by `tests/manual-integration/perf-sidebar-nav.spec.ts` at the end
 * of every harness run. Safe to run standalone too:
 *   node scripts/perf-report.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const HISTORY_DIR = join(ROOT, "docs", "perf", "history");
const OUT = join(ROOT, "docs", "perf", "sidebar-nav-report.html");

const CANONICAL = [
	"nav.session.ready",
	"nav.goal.ready",
	"nav.session.cold",
	"nav.goal.cold",
	"nav.click",
	"api.session.fetch",
	"api.goal.fetch",
	"api.goal.gates.fetch",
	"api.goal.agents.fetch",
	"ws.attach",
	"reducer.rehydrate",
	"paint.first",
	"paint.tool-content.lazy",
];

function loadHistory() {
	let files;
	try { files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")); }
	catch { return []; }
	const runs = [];
	for (const f of files) {
		try {
			const j = JSON.parse(readFileSync(join(HISTORY_DIR, f), "utf-8"));
			runs.push(j);
		} catch (err) {
			console.warn(`[perf-report] skipping malformed ${f}: ${err.message}`);
		}
	}
	runs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
	return runs;
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]));
}

function fmt(n) {
	if (n == null || !isFinite(n)) return "—";
	return n < 10 ? n.toFixed(2) : n.toFixed(1);
}

function deltaCell(first, latest) {
	if (first == null || latest == null) return `<td class="num">—</td><td class="num">—</td>`;
	const dms = latest - first;
	const pct = first === 0 ? 0 : (dms / first) * 100;
	const sign = dms > 0 ? "+" : "";
	const cls = dms > 0 ? "delta-bad" : dms < 0 ? "delta-good" : "";
	return `<td class="num ${cls}">${sign}${fmt(dms)}</td><td class="num ${cls}">${sign}${pct.toFixed(1)}%</td>`;
}

function svgChart(span, runs) {
	const W = 720, H = 200, PAD_L = 56, PAD_R = 16, PAD_T = 16, PAD_B = 40;
	const pts = runs
		.map((r, i) => ({ i, r, s: r.spans?.[span] }))
		.filter((p) => p.s && p.s.n > 0);
	if (pts.length === 0) {
		return `<div class="chart-empty">No samples for <code>${esc(span)}</code> yet.</div>`;
	}
	const xMax = Math.max(1, runs.length - 1);
	const yVals = pts.flatMap((p) => [p.s.p50, p.s.p95]).filter((v) => isFinite(v));
	const yMax = Math.max(1, ...yVals) * 1.15;
	const x = (i) => PAD_L + ((W - PAD_L - PAD_R) * (xMax === 0 ? 0.5 : i / xMax));
	const y = (v) => H - PAD_B - ((H - PAD_T - PAD_B) * (v / yMax));

	const path = (key, dash) => {
		const d = pts
			.map((p, k) => `${k === 0 ? "M" : "L"} ${x(p.i).toFixed(1)} ${y(p.s[key]).toFixed(1)}`)
			.join(" ");
		return `<path d="${d}" fill="none" stroke="${dash ? "var(--chart-2, #f59e0b)" : "var(--chart-1, #4f46e5)"}" stroke-width="2" ${dash ? 'stroke-dasharray="4 3"' : ""}/>`;
	};
	const dots = (key, dash) => pts.map((p) =>
		`<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.s[key]).toFixed(1)}" r="2.5" fill="${dash ? "var(--chart-2, #f59e0b)" : "var(--chart-1, #4f46e5)"}">
			<title>${esc(p.r.commit?.slice(0, 7) || "?")} ${key}=${fmt(p.s[key])}ms n=${p.s.n}</title>
		</circle>`).join("");

	// Y axis: 4 gridlines
	const grid = [];
	for (let k = 0; k <= 4; k++) {
		const yv = (yMax * k) / 4;
		const yy = y(yv);
		grid.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border, #ddd)" stroke-width="1" opacity="0.6"/>`);
		grid.push(`<text x="${PAD_L - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted-foreground, #666)">${fmt(yv)}</text>`);
	}

	// X axis labels: show every commit's short SHA (rotated if many)
	const stride = Math.max(1, Math.ceil(runs.length / 10));
	const xlabels = runs.map((r, i) => {
		if (i % stride !== 0 && i !== runs.length - 1) return "";
		const sha = String(r.commit || "").slice(0, 7);
		return `<text x="${x(i).toFixed(1)}" y="${(H - PAD_B + 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted-foreground, #666)" font-family="ui-monospace,monospace">${esc(sha)}</text>`;
	}).join("");

	return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(span)} chart">
		<rect x="0" y="0" width="${W}" height="${H}" fill="var(--card, transparent)"/>
		${grid.join("")}
		${path("p95", true)}
		${path("p50", false)}
		${dots("p95", true)}
		${dots("p50", false)}
		${xlabels}
		<text x="${PAD_L}" y="${PAD_T - 4}" font-size="11" fill="var(--foreground, #111)" font-weight="600">${esc(span)} (ms)</text>
		<g transform="translate(${W - PAD_R - 110}, ${PAD_T})">
			<line x1="0" y1="6" x2="14" y2="6" stroke="var(--chart-1, #4f46e5)" stroke-width="2"/>
			<text x="18" y="10" font-size="10" fill="var(--muted-foreground, #666)">p50</text>
			<line x1="42" y1="6" x2="56" y2="6" stroke="var(--chart-2, #f59e0b)" stroke-width="2" stroke-dasharray="4 3"/>
			<text x="60" y="10" font-size="10" fill="var(--muted-foreground, #666)">p95</text>
		</g>
	</svg>`;
}

function render(runs) {
	const spans = Array.from(new Set([
		...CANONICAL,
		...runs.flatMap((r) => Object.keys(r.spans || {})),
	]));
	const first = runs[0];
	const latest = runs[runs.length - 1];

	const summaryRows = spans.map((span) => {
		const f = first?.spans?.[span];
		const l = latest?.spans?.[span];
		const fp50 = f?.p50 ?? null;
		const lp50 = l?.p50 ?? null;
		const fp95 = f?.p95 ?? null;
		const lp95 = l?.p95 ?? null;
		return `<tr>
			<td class="name">${esc(span)}</td>
			<td class="num">${fmt(fp50)}</td>
			<td class="num">${fmt(lp50)}</td>
			${deltaCell(fp50, lp50)}
			<td class="num">${fmt(fp95)}</td>
			<td class="num">${fmt(lp95)}</td>
			${deltaCell(fp95, lp95)}
			<td class="num">${l?.n ?? "—"}</td>
		</tr>`;
	}).join("");

	const charts = spans.map((s) => `<section class="chart-card"><div class="chart-svg">${svgChart(s, runs)}</div></section>`).join("");

	const runsList = runs.map((r) => `<li><code>${esc((r.commit || "").slice(0, 12))}</code> <span class="muted">${esc(r.branch || "")}</span> <span class="muted">${esc(r.timestamp || "")}</span></li>`).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar nav perf — cross-commit report</title>
<style>
	:root {
		color-scheme: light dark;
	}
	body {
		font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
		margin: 0;
		padding: 2rem clamp(1rem, 4vw, 3rem);
		background: var(--background, #ffffff);
		color: var(--foreground, #111111);
		line-height: 1.45;
	}
	h1 { font-size: 1.4rem; margin: 0 0 0.4rem; }
	h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }
	.subtitle { color: var(--muted-foreground, #666); margin: 0 0 1.5rem; font-size: 0.9rem; }
	.muted { color: var(--muted-foreground, #888); }
	code { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 0.9em; }
	table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.85rem; }
	th, td {
		border-bottom: 1px solid var(--border, #e5e7eb);
		padding: 6px 10px;
		text-align: left;
	}
	th {
		background: color-mix(in oklch, var(--chart-1, #4f46e5) 10%, transparent);
		font-weight: 600;
	}
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
	td.name { font-family: ui-monospace, monospace; }
	.delta-good { color: var(--positive, #16a34a); }
	.delta-bad  { color: var(--negative, #dc2626); }
	.chart-card {
		background: var(--card, transparent);
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 6px;
		padding: 0.5rem 0.75rem 0.75rem;
		margin: 0.75rem 0;
	}
	.chart-empty {
		font-size: 0.85rem;
		color: var(--muted-foreground, #666);
		font-style: italic;
		padding: 0.75rem;
	}
	.charts-grid { display: grid; grid-template-columns: 1fr; gap: 0.25rem; }
	@media (min-width: 1100px) { .charts-grid { grid-template-columns: 1fr 1fr; } }
	ul.runs { list-style: none; padding: 0; font-family: ui-monospace, monospace; font-size: 0.8rem; }
	ul.runs li { padding: 2px 0; }
	footer { margin-top: 2rem; color: var(--muted-foreground, #888); font-size: 0.8rem; }
</style>
</head>
<body>
<h1>Sidebar nav perf — cross-commit report</h1>
<p class="subtitle">${runs.length} run(s). First: <code>${esc((first?.commit || "").slice(0, 12))}</code> · Latest: <code>${esc((latest?.commit || "").slice(0, 12))}</code></p>

<h2>Summary: first baseline vs latest</h2>
<table>
	<thead><tr>
		<th class="name">span</th>
		<th class="num">first p50</th>
		<th class="num">latest p50</th>
		<th class="num">Δms</th>
		<th class="num">Δ%</th>
		<th class="num">first p95</th>
		<th class="num">latest p95</th>
		<th class="num">Δms</th>
		<th class="num">Δ%</th>
		<th class="num">latest n</th>
	</tr></thead>
	<tbody>${summaryRows}</tbody>
</table>

<h2>Per-span trend (p50 solid, p95 dashed)</h2>
<div class="charts-grid">${charts}</div>

<h2>Runs included</h2>
<ul class="runs">${runsList}</ul>

<footer>Generated by <code>scripts/perf-report.mjs</code> from <code>docs/perf/history/*.json</code>. Re-run the manual harness to refresh.</footer>
</body>
</html>`;
}

function main() {
	const runs = loadHistory();
	if (runs.length === 0) {
		console.warn(`[perf-report] no history under ${HISTORY_DIR} — writing empty placeholder`);
	}
	mkdirSync(dirname(OUT), { recursive: true });
	const html = render(runs);
	writeFileSync(OUT, html);
	console.log(`[perf-report] wrote ${OUT} (${runs.length} run(s))`);
}

main();
