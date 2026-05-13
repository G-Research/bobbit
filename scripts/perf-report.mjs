#!/usr/bin/env node
/**
 * scripts/perf-report.mjs
 *
 * Reads every `docs/perf/history/*.json` (one per commit) and emits
 * `docs/perf/sidebar-nav-report.html` — a single, fully self-contained
 * HTML page with:
 *
 *   • Header                  — generated timestamp + commit count + range
 *   • Headlines strip         — top 6 movers by |Δp50 ms|, green / red / flat
 *   • Summary table           — span × first × latest × Δp50 × Δp95 × n × spark,
 *                               grouped by category (nav / api / render),
 *                               sorted by |Δp50 ms| within each group
 *   • Per-span trend charts   — inline-SVG line charts, p50 solid + p95 dashed,
 *                               auto-scaled Y, commit short SHA on the X axis
 *   • Runs table              — full commit list, latest row highlighted
 *
 * Plain Node, no deps. Inline SVG. Uses Bobbit CSS custom-property tokens
 * (`--background`, `--foreground`, `--card`, `--border`, `--muted-foreground`,
 * `--chart-1`, `--chart-4`, `--positive`, `--negative`) so the report adopts
 * the user's theme when previewed inside Bobbit. `:root` fallbacks cover the
 * preview-bridge HMR race per `defaults/docs/html-rendering.md`.
 *
 * Invoked by `tests/manual-integration/perf-sidebar-nav.spec.ts` at the end
 * of every harness run. Safe to run standalone too:
 *   node scripts/perf-report.mjs
 *
 * The visual structure mirrors the static mockup at
 * `docs/perf/mockups/sidebar-nav-report.html` — keep them in sync if you
 * change either.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const HISTORY_DIR = join(ROOT, "docs", "perf", "history");
const OUT = join(ROOT, "docs", "perf", "sidebar-nav-report.html");

// Canonical span order + category. Spans not listed here fall into "other"
// and render at the end. Keep in sync with the harness gate set.
const SPAN_CATEGORIES = [
	{
		label: "Navigation — click → ready",
		spans: [
			"nav.session.ready",
			"nav.goal.ready",
			"nav.session.cold",
			"nav.goal.cold",
			"nav.click",
		],
	},
	{
		label: "API — REST calls on the critical path",
		spans: [
			"api.session.fetch",
			"api.goal.fetch",
			"api.goal.gates.fetch",
			"api.goal.agents.fetch",
		],
	},
	{
		label: "Render & runtime",
		spans: [
			"ws.attach",
			"paint.first",
			"paint.tool-content.lazy",
			"reducer.rehydrate",
		],
	},
];

const CANONICAL = SPAN_CATEGORIES.flatMap((c) => c.spans);

// Classify a delta. "Flat" if both relative and absolute movement are small —
// avoids flagging 0.05ms → 0.10ms as a 100% regression.
function classify(first, latest) {
	if (first == null || latest == null) return "missing";
	const dms = latest - first;
	const pct = first === 0 ? (latest === 0 ? 0 : Infinity) : (dms / first) * 100;
	if (Math.abs(dms) < 1 && Math.abs(pct) < 5) return "flat";
	return dms < 0 ? "good" : "bad";
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]));
}

function fmt(n) {
	if (n == null || !isFinite(n)) return "—";
	if (Math.abs(n) >= 100) return n.toFixed(0);
	if (Math.abs(n) >= 10)  return n.toFixed(1);
	return n.toFixed(2);
}

function fmtSigned(n) {
	if (n == null || !isFinite(n)) return "—";
	const s = fmt(Math.abs(n));
	return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

function fmtPctSigned(n) {
	if (n == null || !isFinite(n)) return "—";
	const s = Math.abs(n).toFixed(1) + "%";
	return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

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

// ─────────────────────────────────────────────────────────────────────────
// SVG helpers
// ─────────────────────────────────────────────────────────────────────────

function sparkline(values) {
	// values: array of {value, present} — emits a tiny inline line. Missing
	// values create gaps (separate polylines).
	const W = 80, H = 22, PAD_Y = 3;
	const present = values.filter((v) => v.present && isFinite(v.value));
	if (present.length < 2) {
		return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
	}
	const lo = Math.min(...present.map((v) => v.value));
	const hi = Math.max(...present.map((v) => v.value));
	const range = hi - lo || 1;
	const x = (i) => (W * i) / Math.max(1, values.length - 1);
	const y = (v) => PAD_Y + (H - 2 * PAD_Y) * (1 - (v - lo) / range);

	// Build polyline segments that skip missing points
	const segments = [];
	let cur = [];
	values.forEach((v, i) => {
		if (v.present && isFinite(v.value)) {
			cur.push(`${x(i).toFixed(1)},${y(v.value).toFixed(1)}`);
		} else if (cur.length) {
			segments.push(cur);
			cur = [];
		}
	});
	if (cur.length) segments.push(cur);

	return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" aria-hidden="true">${segments
		.filter((s) => s.length >= 2)
		.map((s) => `<polyline fill="none" stroke="var(--chart-1)" stroke-width="1.5" points="${s.join(" ")}"/>`)
		.join("")}</svg>`;
}

function chartSvg(span, runs) {
	const W = 360, H = 160;
	const PAD_L = 50, PAD_R = 10, PAD_T = 18, PAD_B = 28;
	const plotW = W - PAD_L - PAD_R;
	const plotH = H - PAD_T - PAD_B;

	// Collect (index, p50, p95) per run, marking present/absent so the
	// polyline can skip gaps cleanly.
	const series = runs.map((r, i) => {
		const s = r.spans?.[span];
		return {
			i,
			r,
			p50: s?.p50 != null && isFinite(s.p50) ? s.p50 : null,
			p95: s?.p95 != null && isFinite(s.p95) ? s.p95 : null,
			n: s?.n ?? 0,
		};
	});
	const present50 = series.filter((p) => p.p50 != null);
	const present95 = series.filter((p) => p.p95 != null);

	if (present50.length === 0 && present95.length === 0) {
		return `<div class="chart-empty">No samples for <code>${esc(span)}</code> yet.</div>`;
	}

	// Y range: a touch above the max so the top line doesn't kiss the gridline
	const ys = [...present50.map((p) => p.p50), ...present95.map((p) => p.p95)];
	let yMax = Math.max(1, ...ys);
	// "Nice" yMax — round up to a clean number
	const niceCeil = (v) => {
		if (v <= 1) return 1;
		const pow = Math.pow(10, Math.floor(Math.log10(v)));
		const norm = v / pow;
		const step = norm <= 1.2 ? 1.5 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10;
		return step * pow;
	};
	yMax = niceCeil(yMax * 1.1);

	const xMax = Math.max(1, runs.length - 1);
	const x = (i) => PAD_L + (xMax === 0 ? plotW / 2 : (plotW * i) / xMax);
	const y = (v) => PAD_T + plotH * (1 - v / yMax);

	// Y gridlines (4 steps, top = yMax, bottom = 0)
	const gridLines = [];
	for (let k = 0; k <= 4; k++) {
		const yv = (yMax * (4 - k)) / 4;
		const yy = PAD_T + (plotH * k) / 4;
		gridLines.push(
			`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border)" opacity="0.4"/>`,
			`<text x="${(PAD_L - 6).toFixed(1)}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="var(--muted-foreground)">${fmt(yv)}</text>`,
		);
	}

	// Build polyline segments per series (skip missing)
	const segments = (key) => {
		const segs = [];
		let cur = [];
		series.forEach((p) => {
			const v = p[key];
			if (v != null) {
				cur.push(`${x(p.i).toFixed(1)},${y(v).toFixed(1)}`);
			} else if (cur.length) {
				segs.push(cur);
				cur = [];
			}
		});
		if (cur.length) segs.push(cur);
		return segs.filter((s) => s.length >= 2);
	};

	// Light p50 area fill below the line — only when we have a continuous
	// segment, to avoid weird polygons crossing missing points.
	const areaPaths = segments("p50").map((seg) => {
		const first = seg[0].split(",");
		const last = seg[seg.length - 1].split(",");
		const top = seg.join(" L ");
		return `<path d="M ${first[0]} ${(PAD_T + plotH).toFixed(1)} L ${top} L ${last[0]} ${(PAD_T + plotH).toFixed(1)} Z" fill="color-mix(in oklch, var(--chart-1) 12%, transparent)"/>`;
	}).join("");

	const p50Paths = segments("p50").map((s) =>
		`<polyline fill="none" stroke="var(--chart-1)" stroke-width="2" points="${s.join(" ")}"/>`).join("");
	const p95Paths = segments("p95").map((s) =>
		`<polyline fill="none" stroke="var(--chart-4)" stroke-width="1.75" stroke-dasharray="5 3" points="${s.join(" ")}"/>`).join("");

	const dots50 = present50.map((p) =>
		`<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.p50).toFixed(1)}" r="2.5" fill="var(--chart-1)"><title>${esc(p.r.commit?.slice(0, 7) || "?")}  p50=${fmt(p.p50)}ms  n=${p.n}</title></circle>`).join("");
	const dots95 = present95.map((p) =>
		`<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.p95).toFixed(1)}" r="2" fill="var(--chart-4)"><title>${esc(p.r.commit?.slice(0, 7) || "?")}  p95=${fmt(p.p95)}ms  n=${p.n}</title></circle>`).join("");

	// X-axis tick labels — show ~5 evenly spaced + always the last
	const tickIdxs = (() => {
		const N = runs.length;
		if (N <= 6) return runs.map((_, i) => i);
		const out = new Set();
		for (let k = 0; k < 5; k++) out.add(Math.round((k * (N - 1)) / 4));
		out.add(N - 1);
		return Array.from(out).sort((a, b) => a - b);
	})();
	const xLabels = tickIdxs.map((i) => {
		const sha = String(runs[i].commit || "").slice(0, 7);
		return `<text x="${x(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="var(--muted-foreground)">${esc(sha)}</text>`;
	}).join("");

	return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(span)} trend">
		${gridLines.join("")}
		${areaPaths}
		${p95Paths}
		${p50Paths}
		${dots95}
		${dots50}
		${xLabels}
	</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Header / sections
// ─────────────────────────────────────────────────────────────────────────

function firstLatestForSpan(span, runs) {
	let first = null, latest = null;
	for (const r of runs) {
		const s = r.spans?.[span];
		if (s && (s.p50 != null || s.p95 != null)) {
			if (first == null) first = { run: r, span: s };
			latest = { run: r, span: s };
		}
	}
	return { first, latest };
}

function renderHeadlines(rowsByCategory) {
	// Flatten, keep only spans that have first & latest p50, rank by |dms p50|,
	// take top 6. Tie-break by |delta %| then by span name.
	const ranked = rowsByCategory.flatMap((g) => g.rows)
		.filter((r) => r.firstP50 != null && r.latestP50 != null)
		.map((r) => ({
			...r,
			absDms: Math.abs(r.latestP50 - r.firstP50),
			absPct: r.firstP50 === 0 ? 0 : Math.abs((r.latestP50 - r.firstP50) / r.firstP50) * 100,
		}))
		.sort((a, b) => b.absDms - a.absDms || b.absPct - a.absPct || a.span.localeCompare(b.span))
		.slice(0, 6);

	if (ranked.length === 0) {
		return `<section class="headlines"><div class="headline flat"><div class="label">No comparable spans yet</div><div class="value"><span class="now">—</span></div><div class="delta delta-flat">Need ≥1 run with p50 samples.</div></div></section>`;
	}

	const cards = ranked.map((r) => {
		const cls = classify(r.firstP50, r.latestP50);
		const dms = r.latestP50 - r.firstP50;
		const pct = r.firstP50 === 0 ? 0 : (dms / r.firstP50) * 100;
		const deltaCls = cls === "good" ? "delta-good" : cls === "bad" ? "delta-bad" : "delta-flat";
		const borderCls = cls === "good" ? "good" : cls === "bad" ? "bad" : "flat";
		return `<div class="headline ${borderCls}">
			<div class="label">${esc(r.span)} (p50)</div>
			<div class="value"><span class="now">${fmt(r.latestP50)}</span><span class="unit">ms</span></div>
			<div class="delta ${deltaCls}">${fmtSigned(dms)} ms (${fmtPctSigned(pct)}) vs first</div>
		</div>`;
	}).join("");

	return `<section class="headlines">${cards}</section>`;
}

function renderSummary(rowsByCategory, runs) {
	const groups = rowsByCategory
		.map((g) => {
			// sort rows within group by |dms p50| desc, missing/new last
			const rows = [...g.rows].sort((a, b) => {
				const ka = (a.firstP50 != null && a.latestP50 != null) ? Math.abs(a.latestP50 - a.firstP50) : -1;
				const kb = (b.firstP50 != null && b.latestP50 != null) ? Math.abs(b.latestP50 - b.firstP50) : -1;
				return kb - ka || a.span.localeCompare(b.span);
			});
			return { ...g, rows };
		})
		.filter((g) => g.rows.length > 0);

	const renderDeltaCell = (first, latest) => {
		if (first == null && latest == null) {
			return `<td class="delta flat"><span class="pill">—</span></td>`;
		}
		if (first == null && latest != null) {
			return `<td class="delta flat"><span class="pill">new</span></td>`;
		}
		if (first != null && latest == null) {
			return `<td class="delta flat"><span class="pill">gone</span></td>`;
		}
		const cls = classify(first, latest);
		const dms = latest - first;
		const pct = first === 0 ? 0 : (dms / first) * 100;
		const tdCls = cls === "good" ? "good" : cls === "bad" ? "bad" : "flat";
		return `<td class="delta ${tdCls}"><span class="pill">${fmtSigned(dms)} / ${fmtPctSigned(pct)}</span></td>`;
	};

	const renderRow = (r) => {
		const sparkVals = runs.map((run) => {
			const s = run.spans?.[r.span];
			return { value: s?.p50, present: s?.p50 != null };
		});
		return `<tr>
			<td class="name">${esc(r.span)}</td>
			<td class="num">${fmt(r.firstP50)}</td>
			<td class="num">${fmt(r.latestP50)}</td>
			${renderDeltaCell(r.firstP50, r.latestP50)}
			<td class="num">${fmt(r.firstP95)}</td>
			<td class="num">${fmt(r.latestP95)}</td>
			${renderDeltaCell(r.firstP95, r.latestP95)}
			<td class="num">${r.latestN ?? "—"}</td>
			<td class="spark">${sparkline(sparkVals)}</td>
		</tr>`;
	};

	const body = groups.map((g) => `
		<tr class="group"><td colspan="9">${esc(g.label)}</td></tr>
		${g.rows.map(renderRow).join("")}
	`).join("");

	return `<div class="table-wrap"><table class="summary">
		<thead><tr>
			<th>span</th>
			<th class="num">first p50</th>
			<th class="num">latest p50</th>
			<th class="num">Δ p50</th>
			<th class="num">first p95</th>
			<th class="num">latest p95</th>
			<th class="num">Δ p95</th>
			<th class="num">n</th>
			<th>trend p50</th>
		</tr></thead>
		<tbody>${body}</tbody>
	</table></div>`;
}

function renderCharts(rowsByCategory, runs) {
	// All rows in canonical order, sorted within category by |dms p50| desc.
	const cards = rowsByCategory.flatMap((g) => {
		return [...g.rows]
			.sort((a, b) => {
				const ka = (a.firstP50 != null && a.latestP50 != null) ? Math.abs(a.latestP50 - a.firstP50) : -1;
				const kb = (b.firstP50 != null && b.latestP50 != null) ? Math.abs(b.latestP50 - b.firstP50) : -1;
				return kb - ka || a.span.localeCompare(b.span);
			})
			.filter((r) => r.latestN > 0 || r.firstN > 0)
			.map((r) => {
				const cls = classify(r.firstP50, r.latestP50);
				let pillCls = "", pillText = "flat";
				if (r.firstP50 == null && r.latestP50 != null) { pillCls = ""; pillText = "new"; }
				else if (r.firstP50 != null && r.latestP50 == null) { pillCls = ""; pillText = "gone"; }
				else if (cls === "good") { pillCls = "good"; pillText = fmtPctSigned((r.latestP50 - r.firstP50) / r.firstP50 * 100); }
				else if (cls === "bad")  { pillCls = "bad";  pillText = fmtPctSigned((r.latestP50 - r.firstP50) / r.firstP50 * 100); }
				else { pillCls = ""; pillText = "flat"; }

				const valSummary = `${fmt(r.latestP50 ?? r.firstP50)} / ${fmt(r.latestP95 ?? r.firstP95)} ms`;
				return `<article class="chart-card">
					<header>
						<h3>${esc(r.span)}</h3>
						<div class="meta">
							<span class="pill ${pillCls}">${esc(pillText)}</span>
							<span>n=${r.latestN ?? r.firstN ?? 0}</span>
							<span>${valSummary}</span>
						</div>
					</header>
					${chartSvg(r.span, runs)}
				</article>`;
			});
	}).join("");

	return `<div class="charts-grid">${cards}</div>`;
}

function renderRunsTable(runs) {
	const rows = runs.map((r, i) => {
		const isLatest = i === runs.length - 1;
		const sha = String(r.commit || "").slice(0, 12);
		const branch = String(r.branch || "—");
		const ts = String(r.timestamp || "—").replace("T", " ").replace(/\.\d+Z?$/, "Z").slice(0, 16);
		const spanCount = Object.keys(r.spans || {}).length;
		return `<tr${isLatest ? ' class="latest"' : ""}>
			<td>${i + 1}</td>
			<td class="mono">${esc(sha)}</td>
			<td class="mono">${esc(branch)}</td>
			<td class="mono">${esc(ts)}</td>
			<td class="num">${spanCount}</td>
		</tr>`;
	}).join("");
	return `<div class="table-wrap"><table class="runs-table">
		<thead><tr>
			<th>#</th>
			<th>commit</th>
			<th>branch</th>
			<th>timestamp</th>
			<th class="num">spans</th>
		</tr></thead>
		<tbody>${rows}</tbody>
	</table></div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level render
// ─────────────────────────────────────────────────────────────────────────

function buildRows(runs) {
	// Collect every span seen across runs; place canonicals in their declared
	// category, leftovers under "Other spans".
	const seenSpans = new Set();
	for (const r of runs) for (const k of Object.keys(r.spans || {})) seenSpans.add(k);

	const placed = new Set();
	const categories = SPAN_CATEGORIES.map((g) => {
		const rows = g.spans
			.filter((sp) => seenSpans.has(sp) || CANONICAL.includes(sp))
			.map((sp) => { placed.add(sp); return rowFor(sp, runs); });
		return { label: g.label, rows };
	});

	const leftovers = [...seenSpans].filter((s) => !placed.has(s)).sort();
	if (leftovers.length > 0) {
		categories.push({
			label: "Other spans",
			rows: leftovers.map((sp) => rowFor(sp, runs)),
		});
	}

	return categories;
}

function rowFor(span, runs) {
	const { first, latest } = firstLatestForSpan(span, runs);
	return {
		span,
		firstP50: first?.span?.p50 ?? null,
		firstP95: first?.span?.p95 ?? null,
		firstN:   first?.span?.n   ?? 0,
		latestP50: latest?.span?.p50 ?? null,
		latestP95: latest?.span?.p95 ?? null,
		latestN:   latest?.span?.n   ?? 0,
	};
}

function fmtNow() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render(runs) {
	const rowsByCategory = buildRows(runs);
	const first = runs[0];
	const latest = runs[runs.length - 1];
	const firstSha = String(first?.commit || "").slice(0, 7);
	const latestSha = String(latest?.commit || "").slice(0, 7);
	const range = first === latest ? firstSha : `${firstSha} → ${latestSha}`;
	const latestBranch = String(latest?.branch || "—");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar nav perf — cross-commit report</title>
<style>
	:root {
		color-scheme: light dark;
		/* Defensive fallbacks for the preview-bridge HMR race; the parent's
		   tokens always win when present. See defaults/docs/html-rendering.md. */
		--chart-1: oklch(0.58 0.16 250);
		--chart-2: oklch(0.62 0.16 65);
		--chart-3: oklch(0.55 0.16 145);
		--chart-4: oklch(0.55 0.18 25);
		--chart-5: oklch(0.55 0.16 305);
		--chart-6: oklch(0.60 0.14 195);
		--positive: oklch(0.55 0.15 145);
		--negative: oklch(0.55 0.18 25);
		--warning: oklch(0.62 0.15 75);
	}
	* { box-sizing: border-box; }
	body {
		font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
		margin: 0;
		padding: 2rem clamp(1rem, 4vw, 3rem) 4rem;
		background: var(--background);
		color: var(--foreground);
		line-height: 1.45;
		font-size: 14px;
	}
	a { color: var(--chart-1); }
	code, .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 0.92em; }

	header.page {
		display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.75rem 1.25rem;
		padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem;
	}
	header.page h1 { font-size: 1.35rem; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
	header.page .meta { color: var(--muted-foreground); font-size: 0.85rem; display: flex; gap: 0.5rem 1rem; flex-wrap: wrap; }
	header.page .meta strong { color: var(--foreground); font-weight: 500; }

	.headlines {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem; margin-bottom: 2rem;
	}
	.headline {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 0.7rem 0.9rem; display: flex; flex-direction: column; gap: 0.15rem;
	}
	.headline .label {
		font-family: ui-monospace, monospace; font-size: 0.78rem;
		color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.headline .value { display: flex; align-items: baseline; gap: 0.4rem; font-variant-numeric: tabular-nums; }
	.headline .value .now { font-size: 1.25rem; font-weight: 600; font-family: ui-monospace, monospace; }
	.headline .value .unit { font-size: 0.75rem; color: var(--muted-foreground); }
	.headline .delta { font-size: 0.78rem; font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
	.delta-good { color: var(--positive); }
	.delta-bad  { color: var(--negative); }
	.delta-flat { color: var(--muted-foreground); }
	.headline.good { border-top: 2px solid var(--positive); }
	.headline.bad  { border-top: 2px solid var(--negative); }
	.headline.flat { border-top: 2px solid var(--border); }

	h2 { font-size: 1rem; margin: 2.25rem 0 0.6rem; font-weight: 600; letter-spacing: -0.005em; }
	h2 .count { color: var(--muted-foreground); font-weight: 400; font-size: 0.85em; margin-left: 0.4rem; }

	.table-wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--card); }
	table.summary { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
	table.summary th, table.summary td { padding: 7px 12px; text-align: left; border-bottom: 1px solid var(--border); }
	table.summary tbody tr:last-child td { border-bottom: none; }
	table.summary thead th {
		background: color-mix(in oklch, var(--chart-1) 6%, transparent);
		font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--muted-foreground); position: sticky; top: 0;
	}
	table.summary tbody tr.group td {
		background: color-mix(in oklch, var(--muted-foreground) 8%, transparent);
		font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--muted-foreground); padding: 5px 12px;
	}
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
	td.name { font-family: ui-monospace, monospace; font-size: 0.85rem; }
	td.delta { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; font-size: 0.82rem; }
	td.delta .pill { display: inline-block; min-width: 4.6em; padding: 1px 6px; border-radius: 4px; text-align: right; }
	td.delta.good .pill { background: color-mix(in oklch, var(--positive) 14%, transparent); color: var(--positive); }
	td.delta.bad  .pill { background: color-mix(in oklch, var(--negative) 14%, transparent); color: var(--negative); }
	td.delta.flat .pill { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
	td.spark { width: 90px; padding: 4px 12px; }
	td.spark svg { display: block; }

	.charts-grid { display: grid; grid-template-columns: 1fr; gap: 0.85rem; margin-top: 0.6rem; }
	@media (min-width: 900px)  { .charts-grid { grid-template-columns: 1fr 1fr; } }
	@media (min-width: 1400px) { .charts-grid { grid-template-columns: 1fr 1fr 1fr; } }

	.chart-card {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 0.6rem 0.85rem 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;
	}
	.chart-card header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
	.chart-card h3 { font-family: ui-monospace, monospace; font-size: 0.85rem; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
	.chart-card .meta { font-size: 0.72rem; color: var(--muted-foreground); display: flex; gap: 0.5rem; font-variant-numeric: tabular-nums; }
	.chart-card .meta .pill { padding: 0 6px; border-radius: 3px; background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); }
	.chart-card .meta .pill.good { background: color-mix(in oklch, var(--positive) 14%, transparent); color: var(--positive); }
	.chart-card .meta .pill.bad  { background: color-mix(in oklch, var(--negative) 14%, transparent); color: var(--negative); }
	.chart-card svg { display: block; width: 100%; height: auto; }
	.chart-empty {
		font-size: 0.82rem; color: var(--muted-foreground); font-style: italic;
		padding: 0.75rem; text-align: center;
	}

	.runs-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; font-family: ui-monospace, monospace; }
	.runs-table th, .runs-table td { padding: 5px 12px; text-align: left; border-bottom: 1px solid var(--border); }
	.runs-table thead th {
		font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--muted-foreground); font-weight: 600; font-family: system-ui, sans-serif;
		background: color-mix(in oklch, var(--chart-1) 6%, transparent);
	}
	.runs-table tbody tr:last-child td { border-bottom: none; }
	.runs-table .latest td { background: color-mix(in oklch, var(--chart-1) 6%, transparent); }
	.runs-table .latest td:nth-child(2)::after {
		content: "← latest"; font-family: system-ui, sans-serif; color: var(--chart-1);
		margin-left: 0.5rem; font-size: 0.75rem;
	}

	footer.page {
		margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border);
		color: var(--muted-foreground); font-size: 0.78rem;
	}

	.empty-state {
		border: 1px dashed var(--border); border-radius: 8px;
		padding: 2rem; text-align: center; color: var(--muted-foreground); margin: 2rem 0;
	}
</style>
</head>
<body>

<header class="page">
	<h1>Sidebar nav perf — cross-commit report</h1>
	<div class="meta">
		<span>Generated <strong>${esc(fmtNow())}</strong> from <strong>${runs.length} commit${runs.length === 1 ? "" : "s"}</strong></span>
		${runs.length > 0 ? `<span>Range <span class="mono">${esc(range)}</span></span>` : ""}
		${runs.length > 0 ? `<span>Latest branch <span class="mono">${esc(latestBranch)}</span></span>` : ""}
	</div>
</header>

${runs.length === 0
	? `<div class="empty-state">No history under <code>docs/perf/history/</code> yet. Run the manual perf harness to produce the first baseline.</div>`
	: runs.length === 1
		? `<div class="empty-state">Only one run on file — first-vs-latest deltas will appear once a second harness run lands. Showing the single run below.</div>${renderSummary(rowsByCategory, runs)}<h2>Per-span values <span class="count">single commit</span></h2>${renderCharts(rowsByCategory, runs)}<h2>Runs <span class="count">${runs.length} commit</span></h2>${renderRunsTable(runs)}`
		: `${renderHeadlines(rowsByCategory)}<h2>Summary <span class="count">first baseline vs latest, ordered by |Δms| within group</span></h2>${renderSummary(rowsByCategory, runs)}<h2>Per-span trend <span class="count">p50 solid · p95 dashed · ${runs.length} commits</span></h2>${renderCharts(rowsByCategory, runs)}<h2>Runs <span class="count">${runs.length} commits, oldest first</span></h2>${renderRunsTable(runs)}`
}

<footer class="page">
	Generated by <code>scripts/perf-report.mjs</code> from <code>docs/perf/history/*.json</code>.
	Re-run the manual harness (<code>npx playwright test --config playwright-manual.config.ts --grep perf-sidebar-nav</code>) to refresh.
	See <a href="./sidebar-nav-baseline.md"><code>sidebar-nav-baseline.md</code></a> for repro instructions
	and <a href="./mockups/sidebar-nav-report.html">the static mockup</a> for the canonical visual reference.
</footer>

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
