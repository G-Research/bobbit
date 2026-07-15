#!/usr/bin/env node
/**
 * coverage-delta.mjs — PER-FILE line/branch coverage delta report (Test Suite v2).
 *
 * parity.mjs compares only per-AREA aggregate coverage (src/server, src/app,
 * src/ui). That aggregate masks localized regressions: a browser-e2e
 * consolidation can drop a single UI file's coverage from 90% → 30% while the
 * area aggregate barely moves. This script surfaces those localized drops,
 * file-by-file, sorted by drop size.
 *
 * Two modes:
 *
 *   (default) baseline mode — compares the current v2 coverage-summary.json
 *     against a COMMITTED per-file baseline (tests2/v2-baseline-coverage-per-file.json).
 *     First run writes the baseline and exits 0. Subsequent runs report any file
 *     whose line or branch pct dropped vs baseline (beyond tolerance), plus files
 *     that vanished from coverage entirely. A git-history honesty check refuses a
 *     silently bar-lowered committed baseline.
 *
 *   A/B mode (--baseline <A.json> --current <B.json>) — compares two arbitrary
 *     coverage-summary.json files directly (e.g. legacy-suite coverage vs v2).
 *     No committed baseline is consulted; use this to answer "did consolidating
 *     the 184 browser specs into ~35 journeys drop any file's coverage?".
 *
 * Usage:
 *   node scripts/testing-v2/coverage-delta.mjs                 # baseline mode, uses existing summary
 *   node scripts/testing-v2/coverage-delta.mjs --run           # run vitest --coverage first (HEAVY)
 *   node scripts/testing-v2/coverage-delta.mjs --update-baseline
 *   node scripts/testing-v2/coverage-delta.mjs --baseline a.json --current b.json
 *   node scripts/testing-v2/coverage-delta.mjs --threshold 1.0 # min pct drop to flag (default 0.01)
 *   node scripts/testing-v2/coverage-delta.mjs --fail-on-drop  # exit 1 if any file dropped
 *
 * Outputs (committed): .profiles/testing-v2/coverage-delta.json and .md
 *
 * Result coding is honest: a file present in baseline but ABSENT from current is
 * reported as a full loss (pct → 0); a file NEW in current is informational only.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { REPO_ROOT } from "./lib-census.mjs";

const toPosix = (p) => p.replace(/\\/g, "/");

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = {
		run: false,
		updateBaseline: false,
		baseline: null,
		current: null,
		threshold: 0.01,
		failOnDrop: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--run") out.run = true;
		else if (a === "--update-baseline") out.updateBaseline = true;
		else if (a === "--fail-on-drop") out.failOnDrop = true;
		else if (a === "--baseline") out.baseline = argv[++i];
		else if (a === "--current") out.current = argv[++i];
		else if (a === "--threshold") out.threshold = parseFloat(argv[++i]);
		else if (a.startsWith("--threshold=")) out.threshold = parseFloat(a.slice("--threshold=".length));
	}
	return out;
}

// ─── Paths ─────────────────────────────────────────────────────────────────────

const DEFAULT_SUMMARY = join(REPO_ROOT, ".profiles", "testing-v2", "coverage", "coverage-summary.json");
const PER_FILE_BASELINE = join(REPO_ROOT, "tests2", "v2-baseline-coverage-per-file.json");
const OUT_DIR = join(REPO_ROOT, ".profiles", "testing-v2");
const OUT_JSON = join(OUT_DIR, "coverage-delta.json");
const OUT_MD = join(OUT_DIR, "coverage-delta.md");
// Committed summary mirror (the .profiles tree is gitignored; docs/ is tracked).
const OUT_MD_DOCS = join(REPO_ROOT, "docs", "testing-v2", "coverage-delta.md");

// Areas we care about for the browser-consolidation question. A file's area is
// the first matching prefix; anything else is "other".
const AREA_PREFIXES = ["src/app", "src/ui", "src/server"];

function areaOf(relFile) {
	for (const p of AREA_PREFIXES) {
		if (relFile === p || relFile.startsWith(p + "/")) return p;
	}
	return "other";
}

// ─── Coverage summary parsing ──────────────────────────────────────────────────

/**
 * Normalise a coverage-summary.json (istanbul/@vitest/coverage-v8 json-summary
 * shape) into a Map<relPosixPath, { lines:{pct,covered,total}, branches:{...} }>.
 * Absolute paths in the summary are re-rooted to repo-relative. The synthetic
 * "total" entry is dropped.
 */
function loadSummary(summaryPath) {
	if (!existsSync(summaryPath)) {
		throw new Error(`coverage-summary.json not found at ${toPosix(summaryPath)}`);
	}
	const raw = JSON.parse(readFileSync(summaryPath, "utf8"));
	const map = new Map();
	for (const [key, data] of Object.entries(raw)) {
		if (key === "total") continue;
		let rel = toPosix(key);
		// Re-root absolute paths to repo-relative.
		const rootPosix = toPosix(REPO_ROOT);
		if (rel.startsWith(rootPosix + "/")) rel = rel.slice(rootPosix.length + 1);
		else {
			// May already be relative, or from a different absolute root — keep the
			// tail from the first src/ segment if present so baselines line up
			// across machines/worktrees.
			const idx = rel.indexOf("/src/");
			if (idx !== -1) rel = rel.slice(idx + 1);
		}
		map.set(rel, {
			lines: pickMetric(data.lines),
			branches: pickMetric(data.branches),
			statements: pickMetric(data.statements),
			functions: pickMetric(data.functions),
		});
	}
	return map;
}

function pickMetric(m) {
	if (!m) return { pct: 0, covered: 0, total: 0 };
	return {
		pct: typeof m.pct === "number" ? m.pct : (m.total > 0 ? (m.covered / m.total) * 100 : 0),
		covered: m.covered ?? 0,
		total: m.total ?? 0,
	};
}

/** Serialise a coverage Map into a stable committed-baseline object. */
function summaryToBaseline(map) {
	const files = {};
	for (const rel of [...map.keys()].sort()) {
		const d = map.get(rel);
		files[rel] = {
			lines: { pct: round(d.lines.pct), covered: d.lines.covered, total: d.lines.total },
			branches: { pct: round(d.branches.pct), covered: d.branches.covered, total: d.branches.total },
		};
	}
	return { generatedAt: new Date().toISOString(), files };
}

const round = (n) => Math.round(n * 100) / 100;

// ─── vitest --coverage (opt-in, HEAVY) ──────────────────────────────────────────

function runVitestCoverage() {
	const isWin = process.platform === "win32";
	const vitestBin = isWin
		? join(REPO_ROOT, "node_modules", ".bin", "vitest.cmd")
		: join(REPO_ROOT, "node_modules", ".bin", "vitest");
	console.log("\n[coverage-delta] Running vitest with V8 coverage (HEAVY ~90s+)…");
	// Scope: v2-core + v2-core-isolated + v2-dom. The v2-integration project boots
	// a real gateway per fork and is unstable under V8 coverage instrumentation
	// (ERR_IPC_CHANNEL_CLOSED); its src/server coverage is measured separately by
	// parity.mjs. This scope covers all src/app + src/ui (browser) code plus the
	// server-logic units — the browser-consolidation question — and matches the
	// committed per-file baseline. Override with BOBBIT_COVERAGE_PROJECTS if needed.
	const projects = (process.env.BOBBIT_COVERAGE_PROJECTS || "v2-core,v2-core-isolated,v2-dom")
		.split(",").map((p) => p.trim()).filter(Boolean);
	const projectArgs = projects.flatMap((p) => ["--project", p]);
	const result = spawnSync(
		vitestBin,
		["run", "--config", join(REPO_ROOT, "vitest.config.ts"), ...projectArgs, "--coverage"],
		{ stdio: "inherit", cwd: REPO_ROOT, shell: isWin, env: { ...process.env, VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS || "3" } },
	);
	return result.status ?? 1;
}

// ─── Delta computation ───────────────────────────────────────────────────────

/**
 * Compare a baseline coverage Map against a current coverage Map. Returns
 * per-file drops (line and/or branch pct decreased beyond `threshold`), files
 * removed from coverage entirely, files improved, and files newly covered.
 */
function computeDeltas(baselineMap, currentMap, threshold) {
	const drops = [];
	const removed = [];
	const improved = [];
	const added = [];

	for (const [rel, base] of baselineMap) {
		const cur = currentMap.get(rel);
		if (!cur) {
			// File vanished from coverage report entirely — treat as full loss.
			removed.push({
				file: rel,
				area: areaOf(rel),
				baseLinesPct: round(base.lines.pct),
				baseBranchesPct: round(base.branches.pct),
				lineDrop: round(base.lines.pct),
				branchDrop: round(base.branches.pct),
			});
			continue;
		}
		const lineDrop = base.lines.pct - cur.lines.pct;
		const branchDrop = base.branches.pct - cur.branches.pct;
		const maxDrop = Math.max(lineDrop, branchDrop);
		if (lineDrop > threshold || branchDrop > threshold) {
			drops.push({
				file: rel,
				area: areaOf(rel),
				lineDrop: round(lineDrop),
				branchDrop: round(branchDrop),
				maxDrop: round(maxDrop),
				baseLinesPct: round(base.lines.pct),
				curLinesPct: round(cur.lines.pct),
				baseBranchesPct: round(base.branches.pct),
				curBranchesPct: round(cur.branches.pct),
				baseLines: `${base.lines.covered}/${base.lines.total}`,
				curLines: `${cur.lines.covered}/${cur.lines.total}`,
			});
		} else if (lineDrop < -threshold || branchDrop < -threshold) {
			improved.push({ file: rel, area: areaOf(rel), lineGain: round(-lineDrop), branchGain: round(-branchDrop) });
		}
	}
	for (const [rel, cur] of currentMap) {
		if (!baselineMap.has(rel)) {
			added.push({ file: rel, area: areaOf(rel), linesPct: round(cur.lines.pct), branchesPct: round(cur.branches.pct) });
		}
	}

	drops.sort((a, b) => b.maxDrop - a.maxDrop);
	removed.sort((a, b) => Math.max(b.lineDrop, b.branchDrop) - Math.max(a.lineDrop, a.branchDrop));
	return { drops, removed, improved, added };
}

// ─── Git honesty check on the committed per-file baseline ───────────────────────

/**
 * Refuse a silently bar-lowered committed baseline. If the working-tree baseline
 * has files whose recorded pct is LOWER than the committed version (beyond
 * tolerance), that is bar-lowering and is flagged. Raising the bar is allowed.
 */
function checkBaselineHonesty(baselinePath) {
	const violations = [];
	const relPath = toPosix(relative(REPO_ROOT, baselinePath));
	let committedRaw;
	try {
		committedRaw = execSync(`git show HEAD:"${relPath}"`, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return []; // not committed yet — first-run scenario
	}
	let committed, current;
	try { committed = JSON.parse(committedRaw); } catch { return []; }
	try { current = JSON.parse(readFileSync(baselinePath, "utf8")); } catch { return []; }
	const TOL = 0.5;
	for (const [rel, c] of Object.entries(committed.files || {})) {
		const w = current.files?.[rel];
		if (!w) continue;
		if (w.lines.pct < c.lines.pct - TOL) {
			violations.push(`HONESTY: ${rel} lines baseline lowered ${w.lines.pct}% < committed ${c.lines.pct}%`);
		}
		if (w.branches.pct < c.branches.pct - TOL) {
			violations.push(`HONESTY: ${rel} branches baseline lowered ${w.branches.pct}% < committed ${c.branches.pct}%`);
		}
	}
	return violations;
}

// ─── Report ────────────────────────────────────────────────────────────────────

function renderMarkdown(report) {
	const L = [];
	L.push("# Per-file Coverage Delta — Test Suite v2");
	L.push("");
	L.push(`Generated: ${report.generatedAt}`);
	L.push(`Mode: **${report.mode}**  |  Threshold: ${report.threshold}%  |  Baseline: \`${report.baselineLabel}\`  |  Current: \`${report.currentLabel}\``);
	L.push("");
	if (report.firstRun) {
		L.push("> First run — per-file baseline created. Commit it to lock per-file thresholds.");
		L.push("");
	}
	L.push("## Summary");
	L.push("");
	L.push("| Metric | Count |");
	L.push("|--------|-------|");
	L.push(`| Files compared | ${report.filesCompared} |`);
	L.push(`| Files with a DROP (line or branch) | ${report.drops.length} |`);
	L.push(`| Files removed from coverage entirely | ${report.removed.length} |`);
	L.push(`| Files improved | ${report.improved.length} |`);
	L.push(`| Files newly covered (info) | ${report.added.length} |`);
	L.push("");

	// Per-area drop rollup.
	if (report.drops.length || report.removed.length) {
		const byArea = {};
		for (const d of [...report.drops, ...report.removed]) {
			const a = d.area;
			byArea[a] = byArea[a] || { files: 0, maxLineDrop: 0, maxBranchDrop: 0 };
			byArea[a].files++;
			byArea[a].maxLineDrop = Math.max(byArea[a].maxLineDrop, d.lineDrop || 0);
			byArea[a].maxBranchDrop = Math.max(byArea[a].maxBranchDrop, d.branchDrop || 0);
		}
		L.push("### Drops by area");
		L.push("");
		L.push("| Area | Files dropped | Worst line drop | Worst branch drop |");
		L.push("|------|---------------|-----------------|-------------------|");
		for (const [a, v] of Object.entries(byArea).sort((x, y) => y[1].files - x[1].files)) {
			L.push(`| ${a} | ${v.files} | ${v.maxLineDrop.toFixed(2)}pp | ${v.maxBranchDrop.toFixed(2)}pp |`);
		}
		L.push("");
	}

	if (report.removed.length) {
		L.push("## ⛔ Files removed from coverage (full loss)");
		L.push("");
		L.push("These files were covered in the baseline but appear in NO current test — the consolidation may have dropped their only exercising test.");
		L.push("");
		L.push("| File | Area | Baseline lines% | Baseline branches% |");
		L.push("|------|------|-----------------|--------------------|");
		for (const r of report.removed) {
			L.push(`| \`${r.file}\` | ${r.area} | ${r.baseLinesPct}% | ${r.baseBranchesPct}% |`);
		}
		L.push("");
	}

	if (report.drops.length) {
		L.push("## 🔻 Files with a coverage drop (sorted by drop size)");
		L.push("");
		L.push("| File | Area | Line % (base→cur) | Line drop | Branch % (base→cur) | Branch drop |");
		L.push("|------|------|-------------------|-----------|---------------------|-------------|");
		for (const d of report.drops) {
			L.push(`| \`${d.file}\` | ${d.area} | ${d.baseLinesPct}→${d.curLinesPct} | **${d.lineDrop}pp** | ${d.baseBranchesPct}→${d.curBranchesPct} | **${d.branchDrop}pp** |`);
		}
		L.push("");
	} else if (report.removed.length === 0) {
		L.push("## ✅ No per-file coverage drops beyond threshold");
		L.push("");
	}

	if (report.improved.length) {
		L.push(`## 🔺 Files improved (${report.improved.length})`);
		L.push("");
		L.push("<details><summary>Show improved files</summary>");
		L.push("");
		L.push("| File | Area | Line gain | Branch gain |");
		L.push("|------|------|-----------|-------------|");
		for (const d of report.improved.slice(0, 200)) {
			L.push(`| \`${d.file}\` | ${d.area} | ${d.lineGain}pp | ${d.branchGain}pp |`);
		}
		L.push("");
		L.push("</details>");
		L.push("");
	}

	L.push("## Methodology");
	L.push("");
	L.push("- Coverage is V8 (`@vitest/coverage-v8`) per-file `coverage-summary.json` from the tier-1 vitest run.");
	L.push("- `pp` = percentage-points (absolute pct difference), not a relative change.");
	L.push("- A file present in the baseline but absent from current coverage is a **full loss** (its only exercising test may have been retired in the browser consolidation).");
	L.push("- Baseline mode compares against the committed `tests2/v2-baseline-coverage-per-file.json`; a git-history honesty check refuses a silently bar-lowered baseline.");
	L.push("- A/B mode (`--baseline A --current B`) compares two `coverage-summary.json` files directly (e.g. legacy suite vs v2).");
	L.push("");
	return L.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const abMode = !!(opts.baseline && opts.current);

	// Resolve the CURRENT summary.
	let currentPath = opts.current || DEFAULT_SUMMARY;
	if (!abMode && opts.run) {
		const code = runVitestCoverage();
		if (code !== 0) console.warn(`[coverage-delta] vitest exited ${code} — parsing whatever summary was written.`);
	}

	let currentMap;
	try {
		currentMap = loadSummary(currentPath);
	} catch (e) {
		console.error(`[coverage-delta] ${e.message}`);
		console.error(abMode
			? "  In A/B mode both --baseline and --current must point at coverage-summary.json files."
			: "  Run tier-1 coverage first: `node scripts/testing-v2/coverage-delta.mjs --run` (HEAVY), or `vitest run --coverage`.");
		process.exit(2);
	}

	mkdirSync(OUT_DIR, { recursive: true });

	// ── A/B mode ────────────────────────────────────────────────────────────
	if (abMode) {
		let baselineMap;
		try { baselineMap = loadSummary(opts.baseline); }
		catch (e) { console.error(`[coverage-delta] baseline: ${e.message}`); process.exit(2); }
		const { drops, removed, improved, added } = computeDeltas(baselineMap, currentMap, opts.threshold);
		const report = {
			generatedBy: "scripts/testing-v2/coverage-delta.mjs",
			generatedAt: new Date().toISOString(),
			mode: "A/B",
			threshold: opts.threshold,
			baselineLabel: toPosix(relative(REPO_ROOT, opts.baseline)) || opts.baseline,
			currentLabel: toPosix(relative(REPO_ROOT, currentPath)) || currentPath,
			firstRun: false,
			filesCompared: baselineMap.size,
			drops, removed, improved, added,
		};
		writeReport(report);
		finish(report, opts);
		return;
	}

	// ── Baseline mode ─────────────────────────────────────────────────────────
	const haveBaseline = existsSync(PER_FILE_BASELINE);
	if (!haveBaseline || opts.updateBaseline) {
		const baseline = summaryToBaseline(currentMap);
		writeFileSync(PER_FILE_BASELINE, JSON.stringify(baseline, null, "\t") + "\n", "utf8");
		const report = {
			generatedBy: "scripts/testing-v2/coverage-delta.mjs",
			generatedAt: new Date().toISOString(),
			mode: "baseline",
			threshold: opts.threshold,
			baselineLabel: toPosix(relative(REPO_ROOT, PER_FILE_BASELINE)),
			currentLabel: toPosix(relative(REPO_ROOT, currentPath)),
			firstRun: !haveBaseline,
			filesCompared: currentMap.size,
			drops: [], removed: [], improved: [], added: [],
			note: haveBaseline ? "baseline updated (--update-baseline)" : "first run — baseline created",
		};
		writeReport(report);
		console.log(`\n[coverage-delta] ${report.note}: ${report.baselineLabel} (${currentMap.size} files). Commit to lock per-file thresholds.`);
		console.log(`Report: ${toPosix(relative(REPO_ROOT, OUT_MD))}`);
		process.exit(0);
	}

	const baselineRaw = JSON.parse(readFileSync(PER_FILE_BASELINE, "utf8"));
	const baselineMap = new Map(Object.entries(baselineRaw.files || {}).map(([rel, d]) => [rel, {
		lines: pickMetric(d.lines), branches: pickMetric(d.branches),
	}]));

	const { drops, removed, improved, added } = computeDeltas(baselineMap, currentMap, opts.threshold);
	const honesty = checkBaselineHonesty(PER_FILE_BASELINE);
	const report = {
		generatedBy: "scripts/testing-v2/coverage-delta.mjs",
		generatedAt: new Date().toISOString(),
		mode: "baseline",
		threshold: opts.threshold,
		baselineLabel: toPosix(relative(REPO_ROOT, PER_FILE_BASELINE)),
		currentLabel: toPosix(relative(REPO_ROOT, currentPath)),
		firstRun: false,
		filesCompared: baselineMap.size,
		drops, removed, improved, added,
		honestyViolations: honesty,
	};
	writeReport(report);
	finish(report, opts, honesty);
}

function writeReport(report) {
	const md = renderMarkdown(report);
	writeFileSync(OUT_JSON, JSON.stringify(report, null, "\t") + "\n", "utf8");
	writeFileSync(OUT_MD, md, "utf8");
	try {
		mkdirSync(join(REPO_ROOT, "docs", "testing-v2"), { recursive: true });
		writeFileSync(OUT_MD_DOCS, md, "utf8");
	} catch { /* docs mirror is best-effort */ }
}

function finish(report, opts, honesty = []) {
	console.log(`\n[coverage-delta] mode=${report.mode}  files=${report.filesCompared}  drops=${report.drops.length}  removed=${report.removed.length}  improved=${report.improved.length}`);
	for (const d of report.drops.slice(0, 15)) {
		console.log(`  🔻 ${d.file}  line ${d.baseLinesPct}→${d.curLinesPct} (-${d.lineDrop}pp)  branch ${d.baseBranchesPct}→${d.curBranchesPct} (-${d.branchDrop}pp)`);
	}
	for (const r of report.removed.slice(0, 15)) {
		console.log(`  ⛔ ${r.file}  removed from coverage (was ${r.baseLinesPct}% lines)`);
	}
	console.log(`\nReport: ${toPosix(relative(REPO_ROOT, OUT_MD))}`);
	console.log(`JSON:   ${toPosix(relative(REPO_ROOT, OUT_JSON))}`);

	if (honesty.length) {
		console.error("\n[coverage-delta] ❌ baseline honesty violations:");
		for (const v of honesty) console.error("  - " + v);
		process.exit(1);
	}
	const anyDrop = report.drops.length > 0 || report.removed.length > 0;
	if (opts.failOnDrop && anyDrop) {
		console.error("\n[coverage-delta] ❌ --fail-on-drop: per-file coverage regressions detected.");
		process.exit(1);
	}
	process.exit(0);
}

main();
