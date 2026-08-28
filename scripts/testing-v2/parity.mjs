#!/usr/bin/env node
/**
 * parity.mjs — Test Suite v2 parity / guard proof.
 *
 * Usage:
 *   node scripts/testing-v2/parity.mjs --scope core   (default, fast — discovery only)
 *   node scripts/testing-v2/parity.mjs --scope all    (full proof: coverage + spec + discovery)
 *
 * --scope core verifies convention discovery, exactly-once ownership, and guard
 * self-coverage without invoking a test runner.
 *
 * --scope all runs those checks plus V8 coverage comparison, story-registry
 * contract completeness, and Git-history baseline honesty.
 *
 * Output: .profiles/testing-v2/parity/<timestamp>-<scope>.json
 * Exit 0 on pass; non-zero (with printed list) on any violation.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { discoverTests, REPO_ROOT } from "./test-discovery.mjs";

const GUARD_PATH = "tests2/core/guard-v2.test.ts";

const toPosix = (p) => p.replace(/\\/g, "/");

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = { scope: "core", skipRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--scope") out.scope = argv[++i];
		else if (a.startsWith("--scope=")) out.scope = a.slice("--scope=".length);
		else if (a === "--skip-run") out.skipRun = true;
	}
	return out;
}

// ─── Convention inventory checks (scope core) ────────────────────────────────

function runCoreChecks(discovery) {
	const violations = [];
	if (!existsSync(join(REPO_ROOT, GUARD_PATH))) {
		violations.push(`GUARD MISSING: ${GUARD_PATH} does not exist.`);
	}
	if (!discovery.core.includes(GUARD_PATH)) {
		violations.push(`GUARD NOT DISCOVERED: ${GUARD_PATH} must follow the tests2/core/**/*.test.ts convention.`);
	}
	const duplicates = discovery.all.filter((file, index) => discovery.all.indexOf(file) !== index);
	for (const file of [...new Set(duplicates)].sort()) {
		violations.push(`DUPLICATE DISCOVERY: ${file} is assigned to more than one lane.`);
	}
	return {
		violations,
		counts: {
			total: discovery.all.length,
			unit: discovery.unit.length,
			browser: discovery.browser.length,
			e2e: Object.values(discovery.e2eGroups).flat().length,
			manual: discovery.manual.length,
			duplicates: duplicates.length,
		},
	};
}

// ─── V8 Coverage (scope all) ─────────────────────────────────────────────────

/** Aggregated per-area coverage metrics. */
function aggregateCoverage(rawSummary) {
	const AREAS = ["src/server", "src/app", "src/ui"];
	const result = {};
	for (const area of AREAS) {
		result[area] = { lines: { total: 0, covered: 0 }, branches: { total: 0, covered: 0 } };
	}

	for (const [filePath, data] of Object.entries(rawSummary)) {
		if (filePath === "total") continue;
		const posix = toPosix(filePath);
		for (const area of AREAS) {
			if (posix.includes("/" + area + "/") || posix.includes("\\" + area + "\\")) {
				result[area].lines.total += data.lines?.total ?? 0;
				result[area].lines.covered += data.lines?.covered ?? 0;
				result[area].branches.total += data.branches?.total ?? 0;
				result[area].branches.covered += data.branches?.covered ?? 0;
			}
		}
	}

	// Compute percentages.
	for (const area of AREAS) {
		const r = result[area];
		r.lines.pct = r.lines.total > 0 ? (r.lines.covered / r.lines.total) * 100 : 0;
		r.branches.pct = r.branches.total > 0 ? (r.branches.covered / r.branches.total) * 100 : 0;
	}

	return result;
}

/** Run vitest with V8 coverage. Returns exit code. */
function runVitestCoverage() {
	const isWin = process.platform === "win32";
	const vitestBin = isWin
		? join(REPO_ROOT, "node_modules", ".bin", "vitest.cmd")
		: join(REPO_ROOT, "node_modules", ".bin", "vitest");

	console.log("\n[parity] Running vitest with V8 coverage (this may take ~90s)…");
	const result = spawnSync(
		vitestBin,
		["run", "--config", join(REPO_ROOT, "vitest.config.ts"), "--coverage"],
		{
			stdio: "inherit",
			cwd: REPO_ROOT,
			shell: isWin,
			env: { ...process.env, VITEST_MAX_WORKERS: "3" },
		},
	);
	return result.status ?? 1;
}

/** Parse coverage-summary.json produced by vitest @vitest/coverage-v8. */
function parseCoverageSummary() {
	const summaryPath = join(REPO_ROOT, ".profiles", "testing-v2", "coverage", "coverage-summary.json");
	if (!existsSync(summaryPath)) {
		throw new Error(`Coverage summary not found at ${toPosix(summaryPath)}.\nRun: vitest run --coverage`);
	}
	return JSON.parse(readFileSync(summaryPath, "utf8"));
}

// ─── Story-registry spec check (scope all) ───────────────────────────────────

/** Run spec-check-helper.ts via vite-node and return parsed data. */
function runSpecCheck() {
	const isWin = process.platform === "win32";
	const viteNodeBin = isWin
		? join(REPO_ROOT, "node_modules", ".bin", "vite-node.cmd")
		: join(REPO_ROOT, "node_modules", ".bin", "vite-node");

	const helperPath = join(REPO_ROOT, "scripts", "testing-v2", "spec-check-helper.ts");

	console.log("\n[parity] Running story-registry spec check…");
	const result = spawnSync(
		viteNodeBin,
		[helperPath],
		{
			cwd: REPO_ROOT,
			shell: isWin,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if ((result.status ?? 1) !== 0) {
		const errMsg = result.stderr ?? result.error?.message ?? "(no stderr)";
		throw new Error(`spec-check-helper failed (exit ${result.status}):\n${errMsg}`);
	}

	return JSON.parse(result.stdout.trim());
}

/** Summarise contractCompleteness output into a comparable baseline shape. */
function summariseSpecData(specData) {
	const completeness = specData.completeness ?? [];
	const fullyConvered = completeness.filter((c) => c.coverage >= 1).length;
	let totalVariations = 0;
	let coveredVariations = 0;
	for (const c of completeness) {
		totalVariations += c.variations.length;
		coveredVariations += c.variations.filter((v) => v.coveredBy !== null).length;
	}
	return {
		contracts: specData.contracts,
		stories: specData.stories,
		fullyCovered: fullyConvered,
		variations: {
			total: totalVariations,
			covered: coveredVariations,
			pct: totalVariations > 0 ? (coveredVariations / totalVariations) * 100 : 0,
		},
		// Keep the full completeness for detailed reporting.
		completeness,
	};
}

// ─── Baseline helpers ─────────────────────────────────────────────────────────

const COVERAGE_BASELINE_PATH = join(REPO_ROOT, "tests2", "v2-baseline-coverage.json");
const SPEC_BASELINE_PATH = join(REPO_ROOT, "tests2", "v2-baseline-spec.json");

function loadBaseline(path) {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}

function saveBaseline(path, data) {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, "\t") + "\n", "utf8");
}

// ─── Git honesty check ───────────────────────────────────────────────────────

/**
 * Check if a baseline file was bar-lowered vs. the committed version.
 * Returns a violation string, or null if clean.
 *
 * This prevents the workflow:
 *   1. Someone edits baseline.json to lower thresholds.
 *   2. Parity runs and compares current coverage against the (now-lower) baseline.
 *   3. Parity incorrectly passes.
 *
 * If the working-tree baseline has LOWER numbers than the last committed
 * version, we flag it. Re-raising the bar after a genuine regression is
 * allowed (no flag for increases).
 */
function checkBaselineHonesty(baselinePath, baselineLabel) {
	const violations = [];
	const relPath = toPosix(relative(REPO_ROOT, baselinePath));

	let committedJson;
	try {
		committedJson = execSync(`git show HEAD:"${relPath}"`, {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		// Not committed yet — skip honesty check (first-run scenario).
		return [];
	}

	let committed;
	try {
		committed = JSON.parse(committedJson);
	} catch {
		return []; // malformed committed baseline — not our problem to enforce here
	}

	const current = loadBaseline(baselinePath);
	if (!current) return [];

	if (baselineLabel === "coverage") {
		const areas = Object.keys(committed.areas ?? {});
		for (const area of areas) {
			const c = current.areas?.[area];
			const h = committed.areas?.[area];
			if (!c || !h) continue;
			// Allow up to 0.5% tolerance for floating-point / file-count variance.
			const TOLERANCE = 0.5;
			if (c.lines.pct < h.lines.pct - TOLERANCE) {
				violations.push(
					`HONESTY VIOLATION: ${relPath} bar-lowered — ${area} lines.pct ` +
					`${c.lines.pct.toFixed(1)}% < committed ${h.lines.pct.toFixed(1)}%`,
				);
			}
			if (c.branches.pct < h.branches.pct - TOLERANCE) {
				violations.push(
					`HONESTY VIOLATION: ${relPath} bar-lowered — ${area} branches.pct ` +
					`${c.branches.pct.toFixed(1)}% < committed ${h.branches.pct.toFixed(1)}%`,
				);
			}
		}
	} else if (baselineLabel === "spec") {
		const TOLERANCE = 0.5;
		const curPct = current.variations?.pct ?? 0;
		const comPct = committed.variations?.pct ?? 0;
		if (curPct < comPct - TOLERANCE) {
			violations.push(
				`HONESTY VIOLATION: ${relPath} bar-lowered — variations.pct ` +
				`${curPct.toFixed(1)}% < committed ${comPct.toFixed(1)}%`,
			);
		}
		if ((current.fullyCovered ?? 0) < (committed.fullyCovered ?? 0)) {
			violations.push(
				`HONESTY VIOLATION: ${relPath} bar-lowered — fullyCovered ` +
				`${current.fullyCovered} < committed ${committed.fullyCovered}`,
			);
		}
	}

	return violations;
}

// ─── Full parity proof (scope all) ───────────────────────────────────────────

function runScopeAll(opts = {}) {
	const violations = [];

	// ── Step 1: Run vitest with V8 coverage ──────────────────────────────────
	let vitestExit = 0;
	if (opts.skipRun) {
		console.log("\n[parity] --skip-run: skipping vitest run, using existing coverage-summary.json");
	} else {
		vitestExit = runVitestCoverage();
	}
	const vitestFailed = vitestExit !== 0;
	if (vitestFailed) {
		violations.push(`VITEST FAILED: vitest run --coverage exited ${vitestExit}. Fix test failures before parity check.`);
		// Coverage may still have been written even if some tests failed (e.g.
		// snapshot mismatches), so we continue to parse it. If the file doesn't
		// exist we'll surface a separate error below.
	}

	// ── Step 2: Parse coverage summary ───────────────────────────────────────
	let coverageAreas = null;
	let rawSummary = null;
	try {
		rawSummary = parseCoverageSummary();
		coverageAreas = aggregateCoverage(rawSummary);
	} catch (e) {
		violations.push(`COVERAGE PARSE ERROR: ${e.message}`);
	}

	// ── Step 3: Run story-registry spec check ─────────────────────────────────
	let specSummary = null;
	try {
		const specData = runSpecCheck();
		specSummary = summariseSpecData(specData);
	} catch (e) {
		violations.push(`SPEC CHECK ERROR: ${e.message}`);
	}

	// ── Step 4: Load/compare baselines ───────────────────────────────────────
	let firstRun = false;
	const coverageBaseline = loadBaseline(COVERAGE_BASELINE_PATH);
	const specBaseline = loadBaseline(SPEC_BASELINE_PATH);

	if (!coverageBaseline || !specBaseline) {
		firstRun = true;
	}

	if (firstRun && coverageAreas && specSummary) {
		// First run: write baselines and exit 0.
		const now = new Date().toISOString();
		saveBaseline(COVERAGE_BASELINE_PATH, { generatedAt: now, areas: coverageAreas });
		saveBaseline(SPEC_BASELINE_PATH, {
			generatedAt: now,
			contracts: specSummary.contracts,
			stories: specSummary.stories,
			fullyCovered: specSummary.fullyCovered,
			variations: specSummary.variations,
		});
		console.log("\n[parity] First run — baselines created:");
		console.log(`  ${toPosix(COVERAGE_BASELINE_PATH.slice(REPO_ROOT.length + 1))}`);
		console.log(`  ${toPosix(SPEC_BASELINE_PATH.slice(REPO_ROOT.length + 1))}`);
	} else {
		// Compare against baselines.
		if (coverageAreas && coverageBaseline?.areas) {
			const TOLERANCE = 0.5;
			for (const area of Object.keys(coverageBaseline.areas)) {
				const cur = coverageAreas[area];
				const base = coverageBaseline.areas[area];
				if (!cur || !base) continue;
				if (cur.lines.pct < base.lines.pct - TOLERANCE) {
					violations.push(
						`COVERAGE REGRESSION: ${area} lines.pct ${cur.lines.pct.toFixed(1)}% < baseline ${base.lines.pct.toFixed(1)}%`,
					);
				}
				if (cur.branches.pct < base.branches.pct - TOLERANCE) {
					violations.push(
						`COVERAGE REGRESSION: ${area} branches.pct ${cur.branches.pct.toFixed(1)}% < baseline ${base.branches.pct.toFixed(1)}%`,
					);
				}
			}
		}

		if (specSummary && specBaseline) {
			const TOLERANCE = 0.5;
			if (specSummary.variations.pct < specBaseline.variations?.pct - TOLERANCE) {
				violations.push(
					`SPEC REGRESSION: story variations.pct ${specSummary.variations.pct.toFixed(1)}% < baseline ${specBaseline.variations.pct.toFixed(1)}%`,
				);
			}
			if (specSummary.fullyCovered < specBaseline.fullyCovered) {
				violations.push(
					`SPEC REGRESSION: fullyCovered contracts ${specSummary.fullyCovered} < baseline ${specBaseline.fullyCovered}`,
				);
			}
		}

		// ── Step 5: Git honesty check ─────────────────────────────────────────
		if (existsSync(COVERAGE_BASELINE_PATH)) {
			violations.push(...checkBaselineHonesty(COVERAGE_BASELINE_PATH, "coverage"));
		}
		if (existsSync(SPEC_BASELINE_PATH)) {
			violations.push(...checkBaselineHonesty(SPEC_BASELINE_PATH, "spec"));
		}
	}

	return {
		firstRun,
		violations,
		coverage: coverageAreas
			? {
				areas: coverageAreas,
				totalLines: rawSummary?.total?.lines ?? null,
				totalBranches: rawSummary?.total?.branches ?? null,
			}
			: null,
		spec: specSummary
			? {
				contracts: specSummary.contracts,
				stories: specSummary.stories,
				fullyCovered: specSummary.fullyCovered,
				variations: specSummary.variations,
			}
			: null,
	};
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main() {
	const { scope, skipRun } = parseArgs(process.argv.slice(2));
	let discovery;
	try {
		discovery = discoverTests();
	} catch (error) {
		console.error(`parity: discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}

	// Always run convention placement and exactly-once checks.
	const core = runCoreChecks(discovery);
	const violations = [...core.violations];

	// Full proof when --scope all.
	let fullResult = null;
	if (scope === "all") {
		fullResult = runScopeAll({ skipRun });
		violations.push(...fullResult.violations);
	}

	// ── Build report ──────────────────────────────────────────────────────────
	const report = {
		generatedBy: "scripts/testing-v2/parity.mjs",
		scope,
		timestamp: new Date().toISOString(),
		pass: violations.length === 0,
		counts: {
			...core.counts,
			violations: violations.length,
		},
		violations,
		coverage: fullResult?.coverage ?? null,
		spec: fullResult?.spec ?? null,
		firstRun: fullResult?.firstRun ?? null,
	};

	const stamp = report.timestamp.replace(/[:.]/g, "-");
	const outDir = join(REPO_ROOT, ".profiles", "testing-v2", "parity");
	mkdirSync(outDir, { recursive: true });
	const artifactPath = join(outDir, `${stamp}-${scope}.json`);
	writeFileSync(artifactPath, JSON.stringify(report, null, "\t") + "\n", "utf8");

	// ── Print summary ─────────────────────────────────────────────────────────
	const relArtifact = toPosix(artifactPath.slice(REPO_ROOT.length + 1));

	if (violations.length > 0) {
		console.error(`\nparity (--scope ${scope}): FAIL — ${violations.length} violation(s)\n`);
		for (const v of violations) console.error("  - " + v);
		console.error(`\nReport: ${relArtifact}`);
		process.exit(1);
	}

	console.log(`\nparity (--scope ${scope}): PASS`);

	const c = core.counts;
	console.log(
		`\n  total=${c.total} unit=${c.unit} browser=${c.browser} e2e=${c.e2e} ` +
		`manual=${c.manual} duplicates=${c.duplicates} violations=0`,
	);

	if (fullResult?.coverage) {
		console.log("\n  Coverage per area:");
		for (const [area, data] of Object.entries(fullResult.coverage.areas)) {
			console.log(
				`    ${area}: lines ${data.lines.pct.toFixed(1)}% (${data.lines.covered}/${data.lines.total}), ` +
				`branches ${data.branches.pct.toFixed(1)}% (${data.branches.covered}/${data.branches.total})`,
			);
		}
		if (fullResult.coverage.totalLines) {
			const tl = fullResult.coverage.totalLines;
			console.log(`\n  Overall lines: ${tl.pct ?? "?"}% (${tl.covered}/${tl.total})`);
		}
	}

	if (fullResult?.spec) {
		const s = fullResult.spec;
		console.log(
			`\n  Story-registry: ${s.stories} stories, ${s.contracts} contracts, ` +
			`${s.fullyCovered} fully covered, ` +
			`${s.variations.covered}/${s.variations.total} variations (${s.variations.pct.toFixed(1)}%)`,
		);
	}

	if (fullResult?.firstRun) {
		console.log("\n  NOTE: first run — baselines created. Commit them to lock the thresholds.");
	}

	console.log(`\nReport: ${relArtifact}`);
	process.exit(0);
}

main();
