/**
 * Analyse Playwright trace.zip files to find per-test hotspots.
 *
 * The trace file is test.trace (inside the zip, one JSON event per line).
 * For API-style tests that use raw fetch (not apiRequestContext.fetch), the
 * trace only records expect() spans — so the time BETWEEN expects is the
 * interesting bit: that's where REST + WS + sleeps happen. We treat each
 * gap as a "hidden span" and label it with the stdout/stderr log lines
 * emitted during the gap to give a hint at what the server was doing.
 *
 * Output: reports/profiles/<test>/analysis.md + reports/profiles/aggregate.md
 */

import { readFileSync, readdirSync, writeFileSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const TRACE_ROOT = join(ROOT, "reports", "profiles", "test-results");

function allTraces(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...allTraces(full));
		} else if (entry === "trace.zip") {
			out.push(full);
		}
	}
	return out;
}

function readTraceEvents(zipPath) {
	const work = join(tmpdir(), "pwtrace-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
	mkdirSync(work, { recursive: true });
	// unzip is available under MSYS Git Bash on Windows.
	execFileSync("unzip", ["-q", zipPath, "-d", work], { stdio: "pipe" });
	let txt = "";
	for (const name of ["test.trace", "trace.trace"]) {
		try { txt = readFileSync(join(work, name), "utf-8"); break; } catch {}
	}
	const events = [];
	for (const line of txt.split(/\r?\n/)) {
		if (!line) continue;
		try { events.push(JSON.parse(line)); } catch {}
	}
	try { rmSync(work, { recursive: true, force: true }); } catch {}
	return events;
}

function analyse(events) {
	// Build a timeline of { t, kind, label, callId? }.
	// kind: "before" | "after" | "stdout" | "stderr"
	const timeline = [];
	for (const e of events) {
		if (e.type === "before") {
			const name = e.apiName || e.method || e.title || "?";
			const detail = e.params ? JSON.stringify(e.params).slice(0, 100) : "";
			timeline.push({ t: e.startTime, kind: "before", name, detail, callId: e.callId });
		} else if (e.type === "after") {
			timeline.push({ t: e.endTime, kind: "after", callId: e.callId });
		} else if (e.type === "stdout" || e.type === "stderr") {
			timeline.push({ t: e.timestamp, kind: e.type, text: (e.text || "").trim() });
		}
	}
	timeline.sort((a, b) => a.t - b.t);

	// Compute spans: for each before/after pair, record duration.
	const openSpans = new Map();
	const spans = [];
	for (const ev of timeline) {
		if (ev.kind === "before") openSpans.set(ev.callId, ev);
		else if (ev.kind === "after") {
			const b = openSpans.get(ev.callId);
			if (b) {
				spans.push({ name: b.name, detail: b.detail, start: b.t, end: ev.t, dur: ev.t - b.t });
				openSpans.delete(ev.callId);
			}
		}
	}

	// Compute gaps — time between the END of one span and the START of the next.
	// Gather stdout lines emitted inside each gap.
	const sortedByEnd = [...spans].sort((a, b) => a.end - b.end);
	const gaps = [];
	for (let i = 0; i < sortedByEnd.length - 1; i++) {
		const cur = sortedByEnd[i];
		const next = sortedByEnd[i + 1];
		// Only count meaningful gaps
		const gapDur = next.start - cur.end;
		if (gapDur < 50) continue; // ignore micro-gaps < 50 ms
		// Collect stdout/stderr in this gap
		const logs = timeline
			.filter(t => (t.kind === "stdout" || t.kind === "stderr") && t.t >= cur.end && t.t <= next.start)
			.map(t => t.text)
			.filter(Boolean)
			.slice(0, 4);
		gaps.push({ afterName: cur.name, beforeName: next.name, dur: gapDur, start: cur.end, end: next.start, logs });
	}

	const byName = new Map();
	for (const s of spans) {
		const cur = byName.get(s.name) ?? { count: 0, total: 0, max: 0 };
		cur.count++; cur.total += s.dur; cur.max = Math.max(cur.max, s.dur);
		byName.set(s.name, cur);
	}
	const summary = [...byName.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.total - a.total);
	const topSpans = [...spans].sort((a, b) => b.dur - a.dur).slice(0, 15);
	const topGaps = [...gaps].sort((a, b) => b.dur - a.dur).slice(0, 15);
	const totalSpanMs = spans.reduce((a, b) => a + b.dur, 0);
	const totalGapMs = gaps.reduce((a, b) => a + b.dur, 0);
	return { summary, topSpans, topGaps, spanCount: spans.length, totalSpanMs, totalGapMs };
}

function fmtMs(ms) {
	if (ms >= 10000) return (ms / 1000).toFixed(1) + "s";
	if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
	return ms.toFixed(0) + "ms";
}

function render(testName, a) {
	const lines = [];
	lines.push("# " + testName);
	lines.push("");
	lines.push("- span count: " + a.spanCount);
	lines.push("- total span time: " + fmtMs(a.totalSpanMs));
	lines.push("- total gap time between spans: " + fmtMs(a.totalGapMs) + "  ← most of the wall time is usually here for API tests");
	lines.push("");
	lines.push("## Top 15 gaps (what happens between expects)");
	lines.push("| # | Duration | After | Before next | Log hint |");
	lines.push("|---:|---:|---|---|---|");
	a.topGaps.forEach((g, i) => {
		const hint = (g.logs[0] || "").replace(/\|/g, "\\|").slice(0, 150);
		lines.push("| " + (i + 1) + " | " + fmtMs(g.dur) + " | " + g.afterName + " | " + g.beforeName + " | " + hint + " |");
	});
	lines.push("");
	lines.push("## By API (spans)");
	lines.push("| API | Count | Total | Max |");
	lines.push("|---|---:|---:|---:|");
	for (const row of a.summary.slice(0, 15)) {
		lines.push("| " + row.name + " | " + row.count + " | " + fmtMs(row.total) + " | " + fmtMs(row.max) + " |");
	}
	return lines.join("\n");
}

const traces = allTraces(TRACE_ROOT);
console.log(`Found ${traces.length} traces`);

const allSummaries = [];
for (const t of traces) {
	const testDir = basename(dirname(t));
	try {
		const events = readTraceEvents(t);
		if (events.length === 0) { console.log(`[skip] ${testDir} — no events`); continue; }
		const a = analyse(events);
		writeFileSync(join(dirname(t), "analysis.md"), render(testDir, a));
		allSummaries.push({ testDir, a });
		const top3gaps = a.topGaps.slice(0, 3).map(g => fmtMs(g.dur)).join("/");
		console.log(`[ok] ${testDir} — spans=${a.spanCount} totalGap=${fmtMs(a.totalGapMs)} top3gaps=${top3gaps}`);
	} catch (err) {
		console.log(`[err] ${testDir}: ${err.message}`);
	}
}

allSummaries.sort((a, b) => b.a.totalGapMs - a.a.totalGapMs);
const agg = ["# Aggregate analysis — sorted by wall time (gap time)", "", "| Test | Spans | Total gap | Top gap | Top-gap log hint |", "|---|---:|---:|---:|---|"];
for (const { testDir, a } of allSummaries) {
	const tg = a.topGaps[0];
	const hint = (tg?.logs[0] || "").replace(/\|/g, "\\|").slice(0, 150);
	agg.push("| " + testDir + " | " + a.spanCount + " | " + fmtMs(a.totalGapMs) + " | " + (tg ? fmtMs(tg.dur) : "-") + " | " + hint + " |");
}
writeFileSync(join(ROOT, "reports", "profiles", "aggregate.md"), agg.join("\n"));
console.log("Wrote reports/profiles/aggregate.md");
