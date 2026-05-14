#!/usr/bin/env node
/**
 * scripts/perf-report.mjs
 *
 * Reads every `docs/perf/history/*.json` (one per harness replicate) and
 * emits `docs/perf/sidebar-nav-report.html` — a single, fully self-contained
 * HTML page.
 *
 * Two reporting bugs (task 1460c955) shape the structure here:
 *
 *  Bug 1 — "fixture growth looks like a code regression". Two `kind`s of
 *          history entry exist now:
 *            • baseline   — a fixture or harness change. NOT comparable
 *                           across commits as a code-perf signal.
 *            • experiment — a code-change A/B run. Paired at the same
 *                           commit with another `experiment` whose
 *                           `experimentTag` matches and `experimentCondition`
 *                           differs (typical: `off` vs `on`).
 *          The Δ column / headline cards ONLY fire for matched
 *          experiment A/B pairs. Cross-commit comparison renders "n/a —
 *          fixture changed" instead of a misleading number.
 *
 *  Bug 2 — "a single lucky sample is not a win". Replicates are detected
 *          by filename: `<sha>-<tag-base>-<N>.json` (trailing integer).
 *          Files sharing a stem are grouped; per-span p50/p95 are
 *          aggregated as median-of-medians with min/max bands across
 *          replicates. Singletons render with a `(n=1)` badge so the
 *          reader can see the confidence level at a glance.
 *
 * History JSON shape (v2):
 *   { commit, parentCommit, branch, timestamp,
 *     seededSessions, fixtureSize, msgsPerSession, perfFlags, tag,
 *     kind: "baseline" | "experiment",          (default "baseline")
 *     experimentTag?: string,                    (e.g. "opt-b")
 *     experimentCondition?: "off"|"on"|string,   (the A/B leg)
 *     spans: { name: { p50, p95, p99, n, mean, max } } }
 *
 * Plain Node, no deps. Inline SVG. Uses Bobbit CSS custom-property tokens.
 *
 * Run standalone:  node scripts/perf-report.mjs
 * Run replicates:  node scripts/perf-bench.mjs --tag opt-x-on --n 5 ...
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

function median(arr) {
	const a = arr.filter((v) => v != null && isFinite(v)).slice().sort((x, y) => x - y);
	if (a.length === 0) return null;
	const m = Math.floor(a.length / 2);
	return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function minOf(arr) { const a = arr.filter((v) => v != null && isFinite(v)); return a.length ? Math.min(...a) : null; }
function maxOf(arr) { const a = arr.filter((v) => v != null && isFinite(v)); return a.length ? Math.max(...a) : null; }

// ─────────────────────────────────────────────────────────────────────────
// History loading + replicate grouping
// ─────────────────────────────────────────────────────────────────────────

// Parse filename → { stem, replicate }. A trailing `-<digits>` segment is
// the replicate index; everything before is the group stem. Files without a
// trailing integer suffix are treated as singletons (their stem is the bare
// filename without extension).
function parseFilename(file) {
	const noExt = file.replace(/\.json$/i, "");
	const m = noExt.match(/^(.+?)-(\d+)$/);
	if (m) return { stem: m[1], replicate: Number(m[2]) };
	return { stem: noExt, replicate: null };
}

function loadHistory() {
	let files;
	try { files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")); }
	catch { return []; }
	const runs = [];
	for (const f of files) {
		try {
			const j = JSON.parse(readFileSync(join(HISTORY_DIR, f), "utf-8"));
			const { stem, replicate } = parseFilename(f);
			j.__file = f;
			j.__stem = stem;
			j.__replicate = replicate;
			j.kind = j.kind || "baseline"; // default per schema
			runs.push(j);
		} catch (err) {
			console.warn(`[perf-report] skipping malformed ${f}: ${err.message}`);
		}
	}
	return runs;
}

// Build groups keyed by (commit, stem-minus-commit). Replicates within a
// group share the same commit + tag-base; we aggregate per-span across them.
function aggregateGroups(runs) {
	const byStem = new Map();
	for (const r of runs) {
		if (!byStem.has(r.__stem)) byStem.set(r.__stem, []);
		byStem.get(r.__stem).push(r);
	}

	const groups = [];
	for (const [stem, reps] of byStem) {
		reps.sort((a, b) => (a.__replicate ?? 0) - (b.__replicate ?? 0));
		const first = reps[0];

		// Derive experimentTag / experimentCondition for experiment groups.
		// Prefer explicit fields on any replicate; fall back to parsing the
		// `tag` field with a trailing `-(off|on|a|b|control|treatment)`.
		let experimentTag = null, experimentCondition = null;
		for (const r of reps) {
			if (r.experimentTag) experimentTag = r.experimentTag;
			if (r.experimentCondition) experimentCondition = r.experimentCondition;
		}
		if (first.kind === "experiment" && (!experimentTag || !experimentCondition) && first.tag) {
			// Strip trailing replicate suffix from tag, then peel off the last
			// segment as the condition.
			const tagNoRep = String(first.tag).replace(/-\d+$/, "");
			const m = tagNoRep.match(/^(.+)-([^-]+)$/);
			if (m) {
				experimentTag = experimentTag ?? m[1];
				experimentCondition = experimentCondition ?? m[2];
			}
		}

		// Collect every span name across replicates.
		const spanNames = new Set();
		for (const r of reps) for (const k of Object.keys(r.spans || {})) spanNames.add(k);

		const spans = {};
		for (const name of spanNames) {
			const p50s = reps.map((r) => r.spans?.[name]?.p50).filter((v) => v != null);
			const p95s = reps.map((r) => r.spans?.[name]?.p95).filter((v) => v != null);
			const ns = reps.map((r) => r.spans?.[name]?.n ?? 0);
			spans[name] = {
				p50: median(p50s),
				p95: median(p95s),
				p50Min: minOf(p50s),
				p50Max: maxOf(p50s),
				p95Min: minOf(p95s),
				p95Max: maxOf(p95s),
				nReplicates: p50s.length,
				nSamples: ns.reduce((s, v) => s + v, 0),
			};
		}

		// Pick the earliest timestamp across replicates so groups sort
		// stably in time.
		const timestamps = reps.map((r) => String(r.timestamp || "")).filter(Boolean).sort();

		groups.push({
			stem,
			commit: first.commit,
			parentCommit: first.parentCommit,
			branch: first.branch,
			timestamp: timestamps[0] || "",
			latestTimestamp: timestamps[timestamps.length - 1] || "",
			kind: first.kind,
			tag: first.tag ?? null,
			fixtureSize: first.fixtureSize ?? null,
			msgsPerSession: first.msgsPerSession ?? null,
			perfFlags: first.perfFlags ?? null,
			experimentTag,
			experimentCondition,
			replicates: reps.length,
			spans,
		});
	}

	groups.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
	return groups;
}

// Find experiment A/B pairs: groups at the same commit, kind=experiment,
// matching experimentTag, with differing experimentCondition. Yields
// { commit, experimentTag, off, on } where off / on are group refs. We
// canonicalise condition order: anything starting with "off"/"a"/"control"
// → control; otherwise → treatment. Falls back to alphabetical order.
function findABPairs(groups) {
	const pairs = [];
	const byCommitTag = new Map();
	for (const g of groups) {
		if (g.kind !== "experiment" || !g.experimentTag) continue;
		const key = `${g.commit}|${g.experimentTag}`;
		if (!byCommitTag.has(key)) byCommitTag.set(key, []);
		byCommitTag.get(key).push(g);
	}
	for (const [key, gs] of byCommitTag) {
		if (gs.length < 2) continue;
		// Pick the two with distinct conditions. If more than two, prefer
		// off + on; else first two alphabetically.
		const byCond = new Map();
		for (const g of gs) byCond.set(g.experimentCondition || "?", g);
		let ctrl, treat;
		const conds = [...byCond.keys()];
		const ctrlKey = conds.find((c) => /^(off|a|control|baseline)$/i.test(c));
		const treatKey = conds.find((c) => /^(on|b|treatment|flag)$/i.test(c));
		if (ctrlKey && treatKey) { ctrl = byCond.get(ctrlKey); treat = byCond.get(treatKey); }
		else { const sorted = conds.slice().sort(); ctrl = byCond.get(sorted[0]); treat = byCond.get(sorted[1]); }
		if (!ctrl || !treat || ctrl === treat) continue;
		const [commit, experimentTag] = key.split("|");
		pairs.push({ commit, experimentTag, control: ctrl, treatment: treat });
	}
	// Latest pair first so the report leads with the most recent A/B.
	pairs.sort((a, b) => String(b.treatment.timestamp).localeCompare(String(a.treatment.timestamp)));
	return pairs;
}

// Classify a Δ. "Flat" if both relative and absolute movement are small —
// avoids flagging 0.05ms → 0.10ms as a 100% regression.
function classify(first, latest) {
	if (first == null || latest == null) return "missing";
	const dms = latest - first;
	const pct = first === 0 ? (latest === 0 ? 0 : Infinity) : (dms / first) * 100;
	if (Math.abs(dms) < 1 && Math.abs(pct) < 5) return "flat";
	return dms < 0 ? "good" : "bad";
}

// Compare a Δ against the noise floor measured across replicates. Returns:
//   "sig"     — |Δ| exceeds the wider of the two conditions' min↔max spread.
//   "noise"   — within the noise floor; not a real signal.
//   "unknown" — either side has <2 replicates; noise floor undefined.
// We deliberately refuse to call n=1 vs n=1 "sig" — the whole point of the
// replicate change is that single samples can't be declared wins.
function deltaSignal(ctrl, treat) {
	if (!ctrl || !treat || ctrl.p50 == null || treat.p50 == null) return "unknown";
	if ((ctrl.nReplicates ?? 0) < 2 || (treat.nReplicates ?? 0) < 2) return "unknown";
	const cm = (ctrl.p50Max ?? ctrl.p50) - (ctrl.p50Min ?? ctrl.p50);
	const tm = (treat.p50Max ?? treat.p50) - (treat.p50Min ?? treat.p50);
	const noise = Math.max(cm || 0, tm || 0, 0);
	const dms = Math.abs(treat.p50 - ctrl.p50);
	return dms > noise ? "sig" : "noise";
}

// ─────────────────────────────────────────────────────────────────────────
// SVG helpers
// ─────────────────────────────────────────────────────────────────────────

function sparkline(values) {
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

function chartSvg(span, groups) {
	const W = 380, H = 170;
	const PAD_L = 50, PAD_R = 12, PAD_T = 18, PAD_B = 28;
	const plotW = W - PAD_L - PAD_R;
	const plotH = H - PAD_T - PAD_B;

	const points = groups.map((g, i) => {
		const s = g.spans?.[span];
		return {
			i, g,
			p50: s?.p50 ?? null,
			p95: s?.p95 ?? null,
			p50Min: s?.p50Min ?? null,
			p50Max: s?.p50Max ?? null,
			p95Min: s?.p95Min ?? null,
			p95Max: s?.p95Max ?? null,
			reps: s?.nReplicates ?? 0,
			n: s?.nSamples ?? 0,
		};
	});
	const present50 = points.filter((p) => p.p50 != null);
	const present95 = points.filter((p) => p.p95 != null);

	if (present50.length === 0 && present95.length === 0) {
		return `<div class="chart-empty">No samples for <code>${esc(span)}</code> yet.</div>`;
	}

	const ys = [
		...present50.flatMap((p) => [p.p50, p.p50Max].filter((v) => v != null)),
		...present95.flatMap((p) => [p.p95, p.p95Max].filter((v) => v != null)),
	];
	let yMax = Math.max(1, ...ys);
	const niceCeil = (v) => {
		if (v <= 1) return 1;
		const pow = Math.pow(10, Math.floor(Math.log10(v)));
		const norm = v / pow;
		const step = norm <= 1.2 ? 1.5 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10;
		return step * pow;
	};
	yMax = niceCeil(yMax * 1.1);

	const xMax = Math.max(1, groups.length - 1);
	const x = (i) => PAD_L + (xMax === 0 ? plotW / 2 : (plotW * i) / xMax);
	const y = (v) => PAD_T + plotH * (1 - v / yMax);

	const gridLines = [];
	for (let k = 0; k <= 4; k++) {
		const yv = (yMax * (4 - k)) / 4;
		const yy = PAD_T + (plotH * k) / 4;
		gridLines.push(
			`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border)" opacity="0.4"/>`,
			`<text x="${(PAD_L - 6).toFixed(1)}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill="var(--muted-foreground)">${fmt(yv)}</text>`,
		);
	}

	// Connecting line between medians (gaps over missing groups).
	const segments = (key) => {
		const segs = []; let cur = [];
		points.forEach((p) => {
			const v = p[key];
			if (v != null) cur.push(`${x(p.i).toFixed(1)},${y(v).toFixed(1)}`);
			else if (cur.length) { segs.push(cur); cur = []; }
		});
		if (cur.length) segs.push(cur);
		return segs.filter((s) => s.length >= 2);
	};
	const p50Paths = segments("p50").map((s) =>
		`<polyline fill="none" stroke="var(--chart-1)" stroke-width="1.5" opacity="0.7" points="${s.join(" ")}"/>`).join("");
	const p95Paths = segments("p95").map((s) =>
		`<polyline fill="none" stroke="var(--chart-4)" stroke-width="1.25" stroke-dasharray="5 3" opacity="0.6" points="${s.join(" ")}"/>`).join("");

	// Min/max error bars for p50 (replicate spread).
	const errBars50 = present50.filter((p) => p.reps >= 2 && p.p50Min != null && p.p50Max != null).map((p) => {
		const cx = x(p.i).toFixed(1);
		const yHi = y(p.p50Max).toFixed(1);
		const yLo = y(p.p50Min).toFixed(1);
		return `<g stroke="var(--chart-1)" stroke-width="1.5" opacity="0.6">
			<line x1="${cx}" x2="${cx}" y1="${yHi}" y2="${yLo}"/>
			<line x1="${(Number(cx) - 3).toFixed(1)}" x2="${(Number(cx) + 3).toFixed(1)}" y1="${yHi}" y2="${yHi}"/>
			<line x1="${(Number(cx) - 3).toFixed(1)}" x2="${(Number(cx) + 3).toFixed(1)}" y1="${yLo}" y2="${yLo}"/>
		</g>`;
	}).join("");

	// Median dots: filled for experiment, open for baseline. n=1 gets a "?"
	// halo so readers see the singleton-confidence at a glance.
	const dots50 = present50.map((p) => {
		const cx = x(p.i).toFixed(1);
		const cy = y(p.p50).toFixed(1);
		const isExp = p.g.kind === "experiment";
		const halo = p.reps === 1
			? `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="var(--warning)" stroke-width="0.8" stroke-dasharray="1 2"/>`
			: "";
		const title = `${p.g.commit?.slice(0,7) || "?"}${p.g.tag ? ` (${p.g.tag})` : ""}  ${p.g.kind}  p50=${fmt(p.p50)}ms  n_rep=${p.reps}  n=${p.n}${p.reps>=2?`  [${fmt(p.p50Min)}–${fmt(p.p50Max)}]`:""}`;
		const dot = isExp
			? `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--chart-1)"><title>${esc(title)}</title></circle>`
			: `<circle cx="${cx}" cy="${cy}" r="3" fill="var(--background)" stroke="var(--chart-1)" stroke-width="1.5"><title>${esc(title)}</title></circle>`;
		return `${halo}${dot}`;
	}).join("");
	const dots95 = present95.map((p) => {
		const cx = x(p.i).toFixed(1);
		const cy = y(p.p95).toFixed(1);
		return `<circle cx="${cx}" cy="${cy}" r="2" fill="var(--chart-4)" opacity="0.85"><title>${esc(`${p.g.commit?.slice(0,7) || "?"}  p95=${fmt(p.p95)}ms`)}</title></circle>`;
	}).join("");

	const tickIdxs = (() => {
		const N = groups.length;
		if (N <= 6) return groups.map((_, i) => i);
		const out = new Set();
		for (let k = 0; k < 5; k++) out.add(Math.round((k * (N - 1)) / 4));
		out.add(N - 1);
		return Array.from(out).sort((a, b) => a - b);
	})();
	const xLabels = tickIdxs.map((i) => {
		const sha = String(groups[i].commit || "").slice(0, 7);
		return `<text x="${x(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" fill="var(--muted-foreground)">${esc(sha)}</text>`;
	}).join("");

	return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(span)} trend">
		${gridLines.join("")}
		${p95Paths}
		${p50Paths}
		${errBars50}
		${dots95}
		${dots50}
		${xLabels}
	</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────

function renderLegend() {
	return `<aside class="legend">
		<div class="legend-row">
			<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="var(--chart-1)"/></svg>
			<span><strong>experiment</strong> — code-change A/B run; comparable to its pair at the same commit.</span>
		</div>
		<div class="legend-row">
			<svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="var(--background)" stroke="var(--chart-1)" stroke-width="1.5"/></svg>
			<span><strong>baseline</strong> — fixture or harness change; not comparable to other commits as a code-perf signal.</span>
		</div>
		<div class="legend-row">
			<svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
				<line x1="11" x2="11" y1="1" y2="11" stroke="var(--chart-1)" stroke-width="1.5" opacity="0.6"/>
				<line x1="7" x2="15" y1="1" y2="1" stroke="var(--chart-1)" stroke-width="1.5" opacity="0.6"/>
				<line x1="7" x2="15" y1="11" y2="11" stroke="var(--chart-1)" stroke-width="1.5" opacity="0.6"/>
				<circle cx="11" cy="6" r="3" fill="var(--chart-1)"/>
			</svg>
			<span>error bar = min ↔ max across replicates (median dot in the middle).</span>
		</div>
		<div class="legend-row">
			<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--warning)" stroke-width="0.8" stroke-dasharray="1 2"/><circle cx="7" cy="7" r="3" fill="var(--chart-1)"/></svg>
			<span><strong>n=1</strong> halo — single replicate, no noise floor. Treat as low-confidence; re-run with <code>scripts/perf-bench.mjs --n 5</code>.</span>
		</div>
		<div class="legend-row">
			<span class="muted">Δ column fires <strong>only</strong> when two <code>experiment</code> groups at the same commit form an A/B pair. Cross-commit comparisons show <code>n/a — fixture changed</code>.</span>
		</div>
	</aside>`;
}

function renderHeadlines(pairs) {
	if (pairs.length === 0) {
		return `<section class="headlines"><div class="headline flat"><div class="label">No A/B pairs on file</div><div class="value"><span class="now">—</span></div><div class="delta delta-flat">Run <code>scripts/perf-bench.mjs</code> with paired <code>--tag</code>s on the same commit.</div></div></section>`;
	}
	// For each pair, pick the canonical headline spans and rank by |Δ p50|.
	const rows = [];
	for (const pair of pairs) {
		for (const cat of SPAN_CATEGORIES) {
			for (const sp of cat.spans) {
				const c = pair.control.spans[sp];
				const t = pair.treatment.spans[sp];
				if (!c || !t || c.p50 == null || t.p50 == null) continue;
				const dms = t.p50 - c.p50;
				const pct = c.p50 === 0 ? 0 : (dms / c.p50) * 100;
				rows.push({ pair, span: sp, c, t, dms, pct, sig: deltaSignal(c, t) });
			}
		}
	}
	rows.sort((a, b) => Math.abs(b.dms) - Math.abs(a.dms));
	const top = rows.slice(0, 6);
	if (top.length === 0) {
		return `<section class="headlines"><div class="headline flat"><div class="label">A/B pair has no overlapping spans</div><div class="value"><span class="now">—</span></div><div class="delta delta-flat">Re-check the harness.</div></div></section>`;
	}

	const cards = top.map((r) => {
		const cls = classify(r.c.p50, r.t.p50);
		const deltaCls = cls === "good" ? "delta-good" : cls === "bad" ? "delta-bad" : "delta-flat";
		const borderCls = cls === "good" ? "good" : cls === "bad" ? "bad" : "flat";
		const noiseTag = r.sig === "sig"
			? `<span class="sig good">exceeds noise</span>`
			: r.sig === "noise"
				? `<span class="sig">within noise</span>`
				: `<span class="sig warn">n=1 — inconclusive</span>`;
		const ctrlBand = (r.c.p50Min != null && r.c.p50Max != null && r.c.nReplicates >= 2)
			? `${fmt(r.c.p50Min)}–${fmt(r.c.p50Max)}` : "n=1";
		const treatBand = (r.t.p50Min != null && r.t.p50Max != null && r.t.nReplicates >= 2)
			? `${fmt(r.t.p50Min)}–${fmt(r.t.p50Max)}` : "n=1";
		return `<div class="headline ${borderCls}">
			<div class="label">${esc(r.span)} · ${esc(r.pair.experimentTag)} @ ${esc(r.pair.commit.slice(0,7))}</div>
			<div class="value"><span class="now">${fmt(r.t.p50)}</span><span class="unit">ms ${noiseTag}</span></div>
			<div class="delta ${deltaCls}">${fmtSigned(r.dms)} ms (${fmtPctSigned(r.pct)}) vs ${esc(r.pair.control.experimentCondition || "ctrl")} ${fmt(r.c.p50)}</div>
			<div class="delta delta-flat">range: ${esc(r.pair.control.experimentCondition || "ctrl")} ${ctrlBand} · ${esc(r.pair.treatment.experimentCondition || "treat")} ${treatBand}</div>
		</div>`;
	}).join("");

	return `<section class="headlines">${cards}</section>`;
}

function renderPairsTable(pairs, groups) {
	if (pairs.length === 0) {
		return `<div class="empty-state"><strong>No A/B pairs yet.</strong> To compare two code paths, run <code>scripts/perf-bench.mjs --tag &lt;exp&gt;-off --n 5</code> then <code>--tag &lt;exp&gt;-on --n 5 --flags &lt;flag&gt;</code> on the same commit.</div>`;
	}
	const sections = pairs.map((pair) => {
		const rowsByCat = SPAN_CATEGORIES.map((cat) => {
			const rows = [];
			for (const sp of cat.spans) {
				const c = pair.control.spans[sp];
				const t = pair.treatment.spans[sp];
				if (!c && !t) continue;
				rows.push({ sp, c, t });
			}
			// Sort by |Δ p50| desc.
			rows.sort((a, b) => {
				const ka = (a.c?.p50 != null && a.t?.p50 != null) ? Math.abs(a.t.p50 - a.c.p50) : -1;
				const kb = (b.c?.p50 != null && b.t?.p50 != null) ? Math.abs(b.t.p50 - b.c.p50) : -1;
				return kb - ka || a.sp.localeCompare(b.sp);
			});
			return { label: cat.label, rows };
		}).filter((c) => c.rows.length > 0);

		const tableBody = rowsByCat.map((cat) => `
			<tr class="group"><td colspan="9">${esc(cat.label)}</td></tr>
			${cat.rows.map((r) => renderPairRow(r.sp, r.c, r.t)).join("")}
		`).join("");

		const ctrlLabel = pair.control.experimentCondition || "control";
		const treatLabel = pair.treatment.experimentCondition || "treatment";

		return `<section class="pair">
			<h3 class="pair-title">
				<span class="exp-tag">${esc(pair.experimentTag)}</span>
				<span class="mono">@${esc(pair.commit.slice(0, 7))}</span>
				<span class="muted">— ${esc(ctrlLabel)} vs ${esc(treatLabel)} · ${pair.control.replicates}+${pair.treatment.replicates} replicate(s)</span>
			</h3>
			<div class="table-wrap"><table class="summary">
				<thead><tr>
					<th>span</th>
					<th class="num">${esc(ctrlLabel)} p50</th>
					<th class="num">range</th>
					<th class="num">${esc(treatLabel)} p50</th>
					<th class="num">range</th>
					<th class="num">Δ p50</th>
					<th class="num">Δ p95</th>
					<th>signal</th>
					<th class="num">n_rep</th>
				</tr></thead>
				<tbody>${tableBody}</tbody>
			</table></div>
		</section>`;
	}).join("");
	return sections;
}

function renderPairRow(sp, c, t) {
	const bandC = (c && c.nReplicates >= 2) ? `[${fmt(c.p50Min)} – ${fmt(c.p50Max)}]` : "(n=1)";
	const bandT = (t && t.nReplicates >= 2) ? `[${fmt(t.p50Min)} – ${fmt(t.p50Max)}]` : "(n=1)";
	const dms50 = (c?.p50 != null && t?.p50 != null) ? t.p50 - c.p50 : null;
	const dms95 = (c?.p95 != null && t?.p95 != null) ? t.p95 - c.p95 : null;
	const cls50 = dms50 == null ? "flat" : classify(c.p50, t.p50);
	const cls95 = dms95 == null ? "flat" : classify(c.p95, t.p95);
	const sigResult = deltaSignal(c, t);
	const sig = sigResult === "sig" ? "good" : sigResult === "noise" ? "muted" : "warn";
	const sigLabel = sigResult === "sig"
		? "exceeds noise"
		: sigResult === "noise"
			? "within noise"
			: "n=1 — inconclusive";
	return `<tr>
		<td class="name">${esc(sp)}</td>
		<td class="num">${fmt(c?.p50)}</td>
		<td class="num band">${esc(bandC)}</td>
		<td class="num">${fmt(t?.p50)}</td>
		<td class="num band">${esc(bandT)}</td>
		<td class="delta ${cls50}"><span class="pill">${fmtSigned(dms50)}</span></td>
		<td class="delta ${cls95}"><span class="pill">${fmtSigned(dms95)}</span></td>
		<td class="sig ${sig === "good" ? "good" : sig === "warn" ? "warn" : ""}">${esc(sigLabel)}</td>
		<td class="num">${(c?.nReplicates ?? 0)}+${(t?.nReplicates ?? 0)}</td>
	</tr>`;
}

function renderTimelineTable(groups) {
	// Cross-group "trend" table — first vs latest per span across ALL groups
	// regardless of kind. Δ column is gated: only experiment groups at the
	// same commit get a number; everything else shows "n/a — fixture changed"
	// because cross-commit comparison is not a code-perf signal.
	const seen = new Set();
	for (const g of groups) for (const sp of Object.keys(g.spans)) seen.add(sp);
	const allSpans = SPAN_CATEGORIES.flatMap((c) => c.spans).filter((sp) => seen.has(sp))
		.concat([...seen].filter((sp) => !CANONICAL.includes(sp)).sort());

	const renderRow = (sp) => {
		// "first" and "latest" pick the chronologically first/last group that
		// has a measurement for `sp`.
		let first = null, latest = null;
		for (const g of groups) {
			const s = g.spans?.[sp];
			if (s?.p50 != null) {
				if (!first) first = g;
				latest = g;
			}
		}
		const fp = first?.spans?.[sp];
		const lp = latest?.spans?.[sp];

		const dCell = (() => {
			if (!fp || !lp) return `<td class="delta flat"><span class="pill">—</span></td>`;
			// Δ is only meaningful when first === latest commit AND both are
			// experiments. Otherwise: a fixture/harness change is in the mix.
			const sameCommit = first.commit && first.commit === latest.commit;
			if (!sameCommit || first.kind !== "experiment" || latest.kind !== "experiment") {
				return `<td class="delta flat"><span class="pill" title="cross-commit or baseline — code Δ undefined">n/a · fixture</span></td>`;
			}
			const dms = lp.p50 - fp.p50;
			const cls = classify(fp.p50, lp.p50);
			const tdCls = cls === "good" ? "good" : cls === "bad" ? "bad" : "flat";
			return `<td class="delta ${tdCls}"><span class="pill">${fmtSigned(dms)}</span></td>`;
		})();

		const sparkVals = groups.map((g) => {
			const s = g.spans?.[sp];
			return { value: s?.p50, present: s?.p50 != null };
		});

		return `<tr>
			<td class="name">${esc(sp)}</td>
			<td class="num">${fmt(fp?.p50)}</td>
			<td class="num">${fmt(lp?.p50)}</td>
			${dCell}
			<td class="num">${fmt(fp?.p95)}</td>
			<td class="num">${fmt(lp?.p95)}</td>
			<td class="num">${lp ? `${lp.nReplicates}×${lp.nSamples}` : "—"}</td>
			<td class="spark">${sparkline(sparkVals)}</td>
		</tr>`;
	};

	const body = SPAN_CATEGORIES.map((cat) => {
		const rows = cat.spans.filter((sp) => seen.has(sp));
		if (rows.length === 0) return "";
		return `<tr class="group"><td colspan="8">${esc(cat.label)}</td></tr>${rows.map(renderRow).join("")}`;
	}).join("") + (() => {
		const others = [...seen].filter((sp) => !CANONICAL.includes(sp)).sort();
		if (others.length === 0) return "";
		return `<tr class="group"><td colspan="8">Other spans</td></tr>${others.map(renderRow).join("")}`;
	})();

	return `<div class="table-wrap"><table class="summary">
		<thead><tr>
			<th>span</th>
			<th class="num">first p50</th>
			<th class="num">latest p50</th>
			<th class="num">Δ p50</th>
			<th class="num">first p95</th>
			<th class="num">latest p95</th>
			<th class="num">n_rep × n</th>
			<th>trend</th>
		</tr></thead>
		<tbody>${body}</tbody>
	</table></div>`;
}

function renderCharts(groups) {
	const seen = new Set();
	for (const g of groups) for (const sp of Object.keys(g.spans)) seen.add(sp);
	const cards = SPAN_CATEGORIES.flatMap((cat) => cat.spans.filter((sp) => seen.has(sp)).map((sp) => {
		// Pull latest median for quick header.
		let latest = null;
		for (const g of groups) if (g.spans?.[sp]?.p50 != null) latest = g;
		const ls = latest?.spans[sp];
		const kindTag = latest?.kind === "experiment" ? "exp" : "base";
		return `<article class="chart-card">
			<header>
				<h3>${esc(sp)}</h3>
				<div class="meta">
					<span class="pill ${kindTag === "exp" ? "" : "open"}">${esc(kindTag)}</span>
					${ls?.nReplicates >= 2 ? `<span>n_rep=${ls.nReplicates}</span>` : `<span class="warn">n_rep=1 (?)</span>`}
					<span>${fmt(ls?.p50)} / ${fmt(ls?.p95)} ms</span>
				</div>
			</header>
			${chartSvg(sp, groups)}
		</article>`;
	})).concat([...seen].filter((sp) => !CANONICAL.includes(sp)).sort().map((sp) => {
		let latest = null;
		for (const g of groups) if (g.spans?.[sp]?.p50 != null) latest = g;
		const ls = latest?.spans[sp];
		return `<article class="chart-card">
			<header><h3>${esc(sp)}</h3><div class="meta"><span>${fmt(ls?.p50)} / ${fmt(ls?.p95)} ms</span></div></header>
			${chartSvg(sp, groups)}
		</article>`;
	})).join("");
	return `<div class="charts-grid">${cards}</div>`;
}

function renderRunsTable(groups) {
	const rows = groups.map((g, i) => {
		const isLatest = i === groups.length - 1;
		const sha = String(g.commit || "").slice(0, 12);
		const branch = String(g.branch || "—");
		const ts = String(g.timestamp || "—").replace("T", " ").replace(/\.\d+Z?$/, "Z").slice(0, 16);
		const spanCount = Object.keys(g.spans || {}).length;
		const tag = g.tag ? `<span class="mono">${esc(g.tag)}</span>` : "—";
		const kindBadge = g.kind === "experiment"
			? `<span class="kind exp">${esc(g.experimentCondition ? `exp · ${g.experimentCondition}` : "exp")}</span>`
			: `<span class="kind base">baseline</span>`;
		return `<tr${isLatest ? ' class="latest"' : ""}>
			<td>${i + 1}</td>
			<td class="mono">${esc(sha)}</td>
			<td>${kindBadge}</td>
			<td>${tag}</td>
			<td class="num">${g.replicates}</td>
			<td class="mono">${esc(branch)}</td>
			<td class="mono">${esc(ts)}</td>
			<td class="num">${spanCount}</td>
		</tr>`;
	}).join("");
	return `<div class="table-wrap"><table class="runs-table">
		<thead><tr>
			<th>#</th>
			<th>commit</th>
			<th>kind</th>
			<th>tag</th>
			<th class="num">n_rep</th>
			<th>branch</th>
			<th>timestamp</th>
			<th class="num">spans</th>
		</tr></thead>
		<tbody>${rows}</tbody>
	</table></div>`;
}

function fmtNow() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render(groups, runs, pairs) {
	const first = groups[0];
	const latest = groups[groups.length - 1];
	const firstSha = String(first?.commit || "").slice(0, 7);
	const latestSha = String(latest?.commit || "").slice(0, 7);
	const range = first === latest ? firstSha : `${firstSha} → ${latestSha}`;
	const latestBranch = String(latest?.branch || "—");
	const expCount = groups.filter((g) => g.kind === "experiment").length;
	const baseCount = groups.length - expCount;
	const totalReps = runs.length;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar nav perf — cross-commit report</title>
<style>
	:root {
		color-scheme: light dark;
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
		margin: 0; padding: 2rem clamp(1rem, 4vw, 3rem) 4rem;
		background: var(--background); color: var(--foreground);
		line-height: 1.45; font-size: 14px;
	}
	a { color: var(--chart-1); }
	code, .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 0.92em; }
	.muted { color: var(--muted-foreground); }

	header.page {
		display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.75rem 1.25rem;
		padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem;
	}
	header.page h1 { font-size: 1.35rem; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
	header.page .meta { color: var(--muted-foreground); font-size: 0.85rem; display: flex; gap: 0.5rem 1rem; flex-wrap: wrap; }
	header.page .meta strong { color: var(--foreground); font-weight: 500; }

	.legend {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 0.75rem 0.9rem; margin-bottom: 1.5rem;
		display: grid; gap: 0.45rem; font-size: 0.82rem;
	}
	.legend-row { display: flex; align-items: center; gap: 0.6rem; }
	.legend-row svg { flex-shrink: 0; }

	.headlines {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 0.75rem; margin-bottom: 2rem;
	}
	.headline {
		background: var(--card); border: 1px solid var(--border); border-radius: 8px;
		padding: 0.7rem 0.9rem; display: flex; flex-direction: column; gap: 0.18rem;
	}
	.headline .label {
		font-family: ui-monospace, monospace; font-size: 0.76rem;
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
	.sig { font-family: ui-monospace, monospace; font-size: 0.65rem; padding: 1px 4px; border-radius: 3px; margin-left: 0.3rem; background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
	.sig.good { background: color-mix(in oklch, var(--positive) 14%, transparent); color: var(--positive); }
	.sig.warn { background: color-mix(in oklch, var(--warning) 14%, transparent); color: var(--warning); }

	h2 { font-size: 1rem; margin: 2.25rem 0 0.6rem; font-weight: 600; letter-spacing: -0.005em; }
	h2 .count { color: var(--muted-foreground); font-weight: 400; font-size: 0.85em; margin-left: 0.4rem; }

	.pair { margin: 1.25rem 0; }
	.pair-title { font-size: 0.92rem; margin: 0 0 0.4rem; font-weight: 600; display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
	.pair-title .exp-tag { background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1); padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.82rem; }

	.table-wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--card); }
	table.summary { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
	table.summary th, table.summary td { padding: 6px 11px; text-align: left; border-bottom: 1px solid var(--border); }
	table.summary tbody tr:last-child td { border-bottom: none; }
	table.summary thead th {
		background: color-mix(in oklch, var(--chart-1) 6%, transparent);
		font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--muted-foreground);
	}
	table.summary tbody tr.group td {
		background: color-mix(in oklch, var(--muted-foreground) 8%, transparent);
		font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--muted-foreground); padding: 4px 11px;
	}
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
	td.name { font-family: ui-monospace, monospace; font-size: 0.84rem; }
	td.band { color: var(--muted-foreground); font-size: 0.78rem; }
	td.delta { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; font-size: 0.82rem; }
	td.delta .pill { display: inline-block; min-width: 4.6em; padding: 1px 6px; border-radius: 4px; text-align: right; }
	td.delta.good .pill { background: color-mix(in oklch, var(--positive) 14%, transparent); color: var(--positive); }
	td.delta.bad  .pill { background: color-mix(in oklch, var(--negative) 14%, transparent); color: var(--negative); }
	td.delta.flat .pill { background: color-mix(in oklch, var(--muted-foreground) 10%, transparent); color: var(--muted-foreground); }
	td.spark { width: 90px; padding: 3px 11px; }
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
	.chart-card .meta { font-size: 0.72rem; color: var(--muted-foreground); display: flex; gap: 0.5rem; font-variant-numeric: tabular-nums; align-items: baseline; }
	.chart-card .meta .pill { padding: 0 6px; border-radius: 3px; background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1); }
	.chart-card .meta .pill.open { background: transparent; border: 1px solid var(--chart-1); color: var(--chart-1); }
	.chart-card .meta .warn { color: var(--warning); }
	.chart-card svg { display: block; width: 100%; height: auto; }
	.chart-empty {
		font-size: 0.82rem; color: var(--muted-foreground); font-style: italic;
		padding: 0.75rem; text-align: center;
	}

	.runs-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; font-family: ui-monospace, monospace; }
	.runs-table th, .runs-table td { padding: 5px 11px; text-align: left; border-bottom: 1px solid var(--border); }
	.runs-table thead th {
		font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--muted-foreground); font-weight: 600; font-family: system-ui, sans-serif;
		background: color-mix(in oklch, var(--chart-1) 6%, transparent);
	}
	.runs-table tbody tr:last-child td { border-bottom: none; }
	.runs-table .latest td { background: color-mix(in oklch, var(--chart-1) 6%, transparent); }
	.runs-table .latest td:nth-child(2)::after {
		content: "← latest"; font-family: system-ui, sans-serif; color: var(--chart-1);
		margin-left: 0.5rem; font-size: 0.72rem;
	}
	.kind { font-family: ui-monospace, monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 3px; }
	.kind.exp { background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1); }
	.kind.base { background: transparent; border: 1px solid var(--border); color: var(--muted-foreground); }

	footer.page {
		margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border);
		color: var(--muted-foreground); font-size: 0.78rem;
	}
	.empty-state {
		border: 1px dashed var(--border); border-radius: 8px;
		padding: 1.25rem; text-align: center; color: var(--muted-foreground); margin: 0.5rem 0 2rem;
	}
</style>
</head>
<body>

<header class="page">
	<h1>Sidebar nav perf — cross-commit report</h1>
	<div class="meta">
		<span>Generated <strong>${esc(fmtNow())}</strong></span>
		<span><strong>${groups.length}</strong> group${groups.length === 1 ? "" : "s"} (${expCount} experiment, ${baseCount} baseline) from <strong>${totalReps}</strong> replicate JSON${totalReps === 1 ? "" : "s"}</span>
		${groups.length > 0 ? `<span>Range <span class="mono">${esc(range)}</span></span>` : ""}
		${groups.length > 0 ? `<span>Latest branch <span class="mono">${esc(latestBranch)}</span></span>` : ""}
	</div>
</header>

${renderLegend()}

${groups.length === 0
	? `<div class="empty-state">No history under <code>docs/perf/history/</code> yet. Run the manual perf harness to produce the first baseline.</div>`
	: `
		<h2>Headlines <span class="count">A/B pairs, ranked by |Δ p50| — control vs treatment at the same commit</span></h2>
		${renderHeadlines(pairs)}

		<h2>A/B comparisons <span class="count">paired experiment groups, full span table</span></h2>
		${renderPairsTable(pairs, groups)}

		<h2>Per-span timeline <span class="count">median dots · min/max bands · ${groups.length} group${groups.length === 1 ? "" : "s"}</span></h2>
		${renderCharts(groups)}

		<h2>Cross-group trend table <span class="count">first vs latest measurement per span (Δ gated by kind/commit)</span></h2>
		${renderTimelineTable(groups)}

		<h2>Groups <span class="count">${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalReps} replicate JSON${totalReps === 1 ? "" : "s"}, oldest first</span></h2>
		${renderRunsTable(groups)}
	`
}

<footer class="page">
	Generated by <code>scripts/perf-report.mjs</code> from <code>docs/perf/history/*.json</code>.
	Run replicates with <code>node scripts/perf-bench.mjs --tag &lt;name&gt; --n 5 ...</code>; the harness will land 5 JSONs which this report groups automatically.
	See <a href="./README.md"><code>README.md</code></a> for the schema and the decision rule (≥100 ms p50 reduction AND delta &gt; noise floor).
</footer>

</body>
</html>`;
}

function main() {
	const runs = loadHistory();
	const groups = aggregateGroups(runs);
	const pairs = findABPairs(groups);
	if (runs.length === 0) {
		console.warn(`[perf-report] no history under ${HISTORY_DIR} — writing empty placeholder`);
	}
	mkdirSync(dirname(OUT), { recursive: true });
	const html = render(groups, runs, pairs);
	writeFileSync(OUT, html);
	console.log(`[perf-report] wrote ${OUT} (${groups.length} group(s), ${runs.length} replicate(s), ${pairs.length} A/B pair(s))`);
}

main();
