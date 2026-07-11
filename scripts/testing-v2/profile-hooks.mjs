#!/usr/bin/env node
/**
 * profile-hooks.mjs — reusable Test Suite v2 timing profiler.
 *
 * Runs Vitest with its JSON reporter, writes a compact before/after-friendly
 * report under .profiles/testing-v2/hook-profile/, and intentionally avoids
 * vitest.config.ts changes. Vitest JSON does not expose per-hook attribution in
 * a stable API, so this reports exact file/test timing and a conservative
 * "file residual" bucket (file runtime minus reported test runtime). If the
 * integration harness exports cleanup stats into the run directory, they are
 * merged into the report.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".profiles", "testing-v2", "hook-profile");
const CLEANUP_STAT_KEYS = [
	"snapshots",
	"sweeps",
	"skippedSweeps",
	"defaultResets",
	"defaultRestores",
	"deletedSessions",
	"deletedGoals",
	"deletedProjects",
];

function usage() {
	return `Usage:
  npm run test:v2:profile-hooks -- [vitest file/project args]
  node scripts/testing-v2/profile-hooks.mjs --from-json <vitest-json>
  node scripts/testing-v2/profile-hooks.mjs --self-test

Options:
  --out-dir <dir>       Artifact parent directory (default: .profiles/testing-v2/hook-profile)
  --from-json <file>    Parse an existing Vitest JSON report instead of running Vitest
  --cleanup-stats <file> Merge integration harness cleanup stats JSON, if available
  --top <n>             Number of slow rows to include (default: 20)
  --self-test           Parse a synthetic report; no Vitest dependency required
  --help                Show this help

Unrecognized args are forwarded to: npx vitest run --config vitest.config.ts --reporter=json --outputFile <run>/vitest.json
Examples:
  npm run test:v2:profile-hooks -- tests2/core/team-manager.test.ts
  npm run test:v2:profile-hooks -- --project v2-integration tests2/integration/gateway-fixture-leak.test.ts`;
}

function parseArgs(argv) {
	const opts = {
		outDir: DEFAULT_OUT_DIR,
		fromJson: null,
		cleanupStatsPaths: [],
		top: 20,
		selfTest: false,
		help: false,
		vitestArgs: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			opts.vitestArgs.push(...argv.slice(i + 1));
			break;
		} else if (a === "--help" || a === "-h") {
			opts.help = true;
		} else if (a === "--self-test") {
			opts.selfTest = true;
		} else if (a === "--out-dir") {
			opts.outDir = resolvePath(argv[++i], REPO_ROOT);
		} else if (a.startsWith("--out-dir=")) {
			opts.outDir = resolvePath(a.slice("--out-dir=".length), REPO_ROOT);
		} else if (a === "--from-json") {
			opts.fromJson = resolvePath(argv[++i], REPO_ROOT);
		} else if (a.startsWith("--from-json=")) {
			opts.fromJson = resolvePath(a.slice("--from-json=".length), REPO_ROOT);
		} else if (a === "--cleanup-stats") {
			opts.cleanupStatsPaths.push(resolvePath(argv[++i], REPO_ROOT));
		} else if (a.startsWith("--cleanup-stats=")) {
			opts.cleanupStatsPaths.push(resolvePath(a.slice("--cleanup-stats=".length), REPO_ROOT));
		} else if (a === "--top") {
			opts.top = parsePositiveInt(argv[++i], "--top");
		} else if (a.startsWith("--top=")) {
			opts.top = parsePositiveInt(a.slice("--top=".length), "--top");
		} else {
			opts.vitestArgs.push(a);
		}
	}
	return opts;
}

function resolvePath(p, base) {
	if (!p) throw new Error("Expected a path value.");
	return isAbsolute(p) ? p : resolve(base, p);
}

function parsePositiveInt(value, flag) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer.`);
	return n;
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function npxCmd() {
	return process.platform === "win32" ? "npx.cmd" : "npx";
}

function toPosix(p) {
	return p.replace(/\\/g, "/");
}

function rel(p) {
	const r = toPosix(relative(REPO_ROOT, p));
	return r && !r.startsWith("..") ? r : toPosix(p);
}

function fmtMs(ms) {
	if (!Number.isFinite(ms)) return "n/a";
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}m`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
	return `${Math.round(ms)}ms`;
}

async function runVitest(jsonPath, runDir, vitestArgs) {
	mkdirSync(dirname(jsonPath), { recursive: true });
	const args = [
		"vitest",
		"run",
		"--config",
		"vitest.config.ts",
		"--reporter=json",
		`--outputFile=${jsonPath}`,
		...vitestArgs,
	];
	const start = performance.now();
	console.log(`[profile-hooks] running: ${npxCmd()} ${args.map(shellQuote).join(" ")}`);
	return new Promise((resolveRun) => {
		const child = spawn(npxCmd(), args, {
			cwd: REPO_ROOT,
			env: { ...process.env, BOBBIT_V2_HOOK_PROFILE_DIR: runDir },
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("close", (code, signal) => {
			resolveRun({ code: code ?? (signal ? 1 : 0), signal, wallMs: Math.round(performance.now() - start) });
		});
		child.on("error", (error) => {
			console.error(`[profile-hooks] failed to launch Vitest: ${error.message}`);
			resolveRun({ code: 1, error, wallMs: Math.round(performance.now() - start) });
		});
	});
}

function shellQuote(s) {
	return /\s/.test(s) ? JSON.stringify(s) : s;
}

function parseVitestJson(jsonPath) {
	const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
	const files = extractFiles(raw);
	const tests = files.flatMap((file) => file.tests.map((test) => ({ ...test, file: file.file })));
	return { raw, files, tests };
}

function extractFiles(raw) {
	if (Array.isArray(raw?.testResults)) return raw.testResults.map(fileFromJestLikeSuite).filter(Boolean);
	if (Array.isArray(raw?.files)) return raw.files.map(fileFromUnknownSuite).filter(Boolean);
	if (Array.isArray(raw)) return raw.map(fileFromUnknownSuite).filter(Boolean);
	const discovered = [];
	walk(raw, (value) => {
		if (value && typeof value === "object" && Array.isArray(value.tasks) && maybeFile(value)) {
			discovered.push(fileFromTaskSuite(value));
		}
	});
	return discovered.filter(Boolean);
}

function maybeFile(value) {
	return typeof value.filepath === "string" || typeof value.file === "string" || typeof value.name === "string";
}

function fileFromJestLikeSuite(suite) {
	const file = normalizeFile(suite.name ?? suite.testFilePath ?? suite.file ?? suite.filepath);
	if (!file) return null;
	const start = finiteNumber(suite.startTime ?? suite.perfStats?.start);
	const end = finiteNumber(suite.endTime ?? suite.perfStats?.end);
	const duration = firstFinite(
		suite.duration,
		suite.perfStats?.runtime,
		Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
	);
	const tests = Array.isArray(suite.assertionResults)
		? suite.assertionResults.map((t) => ({
			name: t.fullName ?? [...(t.ancestorTitles ?? []), t.title].filter(Boolean).join(" > "),
			status: t.status ?? "unknown",
			durationMs: finiteNumber(t.duration),
		})).filter((t) => t.name)
		: [];
	return normalizeFileSummary({ file, status: suite.status, durationMs: duration, tests });
}

function fileFromUnknownSuite(suite) {
	if (Array.isArray(suite?.assertionResults)) return fileFromJestLikeSuite(suite);
	if (Array.isArray(suite?.tasks)) return fileFromTaskSuite(suite);
	const file = normalizeFile(suite?.name ?? suite?.file ?? suite?.filepath ?? suite?.path);
	if (!file) return null;
	return normalizeFileSummary({
		file,
		status: suite.result?.state ?? suite.status,
		durationMs: firstFinite(suite.duration, suite.durationMs, suite.result?.duration),
		tests: [],
	});
}

function fileFromTaskSuite(suite) {
	const file = normalizeFile(suite.filepath ?? suite.file ?? suite.name);
	if (!file) return null;
	const tests = [];
	collectTaskTests(suite, [], tests);
	return normalizeFileSummary({
		file,
		status: suite.result?.state ?? suite.status,
		durationMs: firstFinite(suite.result?.duration, suite.duration, sumFinite(tests.map((t) => t.durationMs))),
		tests,
	});
}

function collectTaskTests(task, ancestors, out) {
	const name = task.name ?? task.title;
	const type = task.type ?? task.mode;
	const nextAncestors = name && type !== "test" ? [...ancestors, name] : ancestors;
	if (type === "test" || Array.isArray(task.result?.errors)) {
		out.push({
			name: [...ancestors, name].filter(Boolean).join(" > "),
			status: task.result?.state ?? task.status ?? "unknown",
			durationMs: finiteNumber(task.result?.duration ?? task.duration),
		});
	}
	if (Array.isArray(task.tasks)) {
		for (const child of task.tasks) collectTaskTests(child, nextAncestors, out);
	}
}

function normalizeFileSummary(file) {
	const testDurationMs = sumFinite(file.tests.map((t) => t.durationMs));
	const durationMs = finiteNumber(file.durationMs);
	return {
		file: file.file,
		status: file.status ?? "unknown",
		durationMs,
		testDurationMs,
		residualMs: Number.isFinite(durationMs) && Number.isFinite(testDurationMs) ? Math.max(0, durationMs - testDurationMs) : null,
		testCount: file.tests.length,
		tests: file.tests,
	};
}

function normalizeFile(file) {
	if (typeof file !== "string" || !file) return null;
	const normalized = toPosix(file);
	if (normalized.includes("/tests2/")) return normalized.slice(normalized.indexOf("/tests2/") + 1);
	if (normalized.startsWith("tests2/")) return normalized;
	return rel(resolve(REPO_ROOT, file));
}

function finiteNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function firstFinite(...values) {
	for (const value of values) {
		const n = finiteNumber(value);
		if (n !== null) return n;
	}
	return null;
}

function sumFinite(values) {
	let total = 0;
	let seen = false;
	for (const value of values) {
		if (Number.isFinite(value)) {
			total += value;
			seen = true;
		}
	}
	return seen ? total : null;
}

function walk(value, visit, seen = new Set()) {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	visit(value);
	for (const child of Object.values(value)) {
		if (child && typeof child === "object") walk(child, visit, seen);
	}
}

function loadCleanupStats(runDir, explicitPaths) {
	const files = [...explicitPaths];
	if (existsSync(runDir)) {
		for (const path of listJsonFiles(runDir)) {
			if (/cleanup|harness/i.test(path)) files.push(path);
		}
	}
	const merged = Object.fromEntries(CLEANUP_STAT_KEYS.map((key) => [key, 0]));
	const sources = [];
	for (const file of [...new Set(files)]) {
		if (!existsSync(file)) continue;
		try {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			const stats = raw.cleanupStats ?? raw.integrationHarnessCleanupStats ?? raw;
			if (!hasCleanupStats(stats)) continue;
			for (const key of CLEANUP_STAT_KEYS) {
				const n = Number(stats[key]);
				if (Number.isFinite(n)) merged[key] += n;
			}
			sources.push(rel(file));
		} catch (error) {
			console.warn(`[profile-hooks] ignored cleanup stats ${rel(file)}: ${error.message}`);
		}
	}
	return sources.length > 0 ? { available: true, sources, ...merged } : { available: false, sources: [] };
}

function hasCleanupStats(value) {
	return value && typeof value === "object" && CLEANUP_STAT_KEYS.some((key) => Number.isFinite(Number(value[key])));
}

function listJsonFiles(root) {
	const out = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
		}
	}
	return out;
}

function buildSummary({ jsonPath, runDir, parsed, wallMs, exitCode, cleanupStats, top }) {
	const slowFiles = [...parsed.files]
		.filter((f) => Number.isFinite(f.durationMs))
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, top);
	const slowResidualFiles = [...parsed.files]
		.filter((f) => Number.isFinite(f.residualMs) && f.residualMs > 0)
		.sort((a, b) => b.residualMs - a.residualMs)
		.slice(0, top);
	const slowTests = [...parsed.tests]
		.filter((t) => Number.isFinite(t.durationMs))
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, top);
	const summedFileMs = sumFinite(parsed.files.map((f) => f.durationMs));
	const summedTestMs = sumFinite(parsed.files.map((f) => f.testDurationMs));
	const summedResidualMs = sumFinite(parsed.files.map((f) => f.residualMs));
	return {
		createdAt: new Date().toISOString(),
		jsonPath: rel(jsonPath),
		runDir: rel(runDir),
		exitCode,
		wallMs: Number.isFinite(wallMs) ? wallMs : null,
		counts: {
			files: parsed.files.length,
			tests: parsed.tests.length,
			failedTests: parsed.tests.filter((t) => /fail|error/i.test(String(t.status))).length,
		},
		timing: {
			summedFileMs,
			summedTestMs,
			summedResidualMs,
			hookAttribution: "unavailable-from-vitest-json",
			note: "Vitest JSON exposes file/test durations, but not stable beforeAll/beforeEach/afterEach/afterAll timings. Residual is file duration minus reported test duration and may include hooks, module evaluation, fixtures, and reporter overhead.",
		},
		cleanupStats,
		slowestFiles: slowFiles.map(compactFile),
		slowestResidualFiles: slowResidualFiles.map(compactFile),
		slowestTests: slowTests.map((t) => ({ file: t.file, name: t.name, status: t.status, durationMs: t.durationMs })),
	};
}

function compactFile(f) {
	return {
		file: f.file,
		status: f.status,
		durationMs: f.durationMs,
		testDurationMs: f.testDurationMs,
		residualMs: f.residualMs,
		testCount: f.testCount,
	};
}

function renderMarkdown(report) {
	const lines = [];
	lines.push("# Test Suite v2 hook/file timing profile", "");
	lines.push(`Created: ${report.createdAt}`);
	lines.push(`Vitest exit code: ${report.exitCode}`);
	lines.push(`Vitest JSON: \`${report.jsonPath}\``);
	lines.push(`Artifacts: \`${report.runDir}\``, "");
	lines.push("## Summary", "");
	lines.push(`- Wall time: ${fmtMs(report.wallMs)}`);
	lines.push(`- Files: ${report.counts.files}`);
	lines.push(`- Tests: ${report.counts.tests} (${report.counts.failedTests} failed/error)`);
	lines.push(`- Summed file runtime: ${fmtMs(report.timing.summedFileMs)}`);
	lines.push(`- Summed reported test runtime: ${fmtMs(report.timing.summedTestMs)}`);
	lines.push(`- Summed file residual: ${fmtMs(report.timing.summedResidualMs)}`);
	lines.push(`- Hook attribution: ${report.timing.hookAttribution}`);
	lines.push(`- Note: ${report.timing.note}`, "");
	lines.push("## Integration harness cleanup stats", "");
	if (report.cleanupStats.available) {
		lines.push(`Sources: ${report.cleanupStats.sources.map((s) => `\`${s}\``).join(", ")}`, "");
		lines.push("| Metric | Count |", "|---|---:|");
		for (const key of CLEANUP_STAT_KEYS) lines.push(`| ${key} | ${report.cleanupStats[key] ?? 0} |`);
	} else {
		lines.push("Not available. The profiler sets `BOBBIT_V2_HOOK_PROFILE_DIR`; integration specs using the compat harness should export cleanup stats there during `afterAll`. If this is a non-integration run, no cleanup stats are expected.");
	}
	lines.push("", "## Slowest files", "");
	pushFileTable(lines, report.slowestFiles);
	lines.push("", "## Largest file residuals", "");
	pushFileTable(lines, report.slowestResidualFiles);
	lines.push("", "## Slowest tests", "");
	if (report.slowestTests.length === 0) lines.push("No per-test durations found.");
	else {
		lines.push("| Runtime | Status | File | Test |", "|---:|---|---|---|");
		for (const test of report.slowestTests) {
			lines.push(`| ${fmtMs(test.durationMs)} | ${test.status} | \`${test.file}\` | ${escapeCell(test.name)} |`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function pushFileTable(lines, files) {
	if (files.length === 0) {
		lines.push("No file durations found.");
		return;
	}
	lines.push("| Runtime | Test runtime | Residual | Tests | Status | File |", "|---:|---:|---:|---:|---|---|");
	for (const file of files) {
		lines.push(`| ${fmtMs(file.durationMs)} | ${fmtMs(file.testDurationMs)} | ${fmtMs(file.residualMs)} | ${file.testCount} | ${file.status} | \`${file.file}\` |`);
	}
}

function escapeCell(value) {
	return String(value ?? "").replace(/\|/g, "\\|");
}

function writeReports(report, runDir) {
	const jsonOut = join(runDir, "report.json");
	const mdOut = join(runDir, "report.md");
	writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
	const markdown = renderMarkdown(report);
	writeFileSync(mdOut, markdown);
	console.log(markdown);
	console.log(`[profile-hooks] wrote ${rel(jsonOut)} and ${rel(mdOut)}`);
}

async function selfTest(opts) {
	const runDir = join(opts.outDir, `self-test-${timestamp()}`);
	mkdirSync(runDir, { recursive: true });
	const jsonPath = join(runDir, "vitest.json");
	writeFileSync(jsonPath, JSON.stringify({
		testResults: [
			{
				name: join(REPO_ROOT, "tests2", "core", "alpha.test.ts"),
				status: "passed",
				startTime: 1000,
				endTime: 1750,
				assertionResults: [
					{ fullName: "alpha fast", status: "passed", duration: 50 },
					{ fullName: "alpha slow", status: "passed", duration: 200 },
				],
			},
			{
				name: join(REPO_ROOT, "tests2", "integration", "beta.test.ts"),
				status: "failed",
				duration: 1200,
				assertionResults: [{ fullName: "beta fails", status: "failed", duration: 900 }],
			},
		],
	}, null, 2));
	writeFileSync(join(runDir, "integration-harness-cleanup.json"), JSON.stringify({ snapshots: 2, sweeps: 1, skippedSweeps: 1, defaultResets: 0 }, null, 2));
	const parsed = parseVitestJson(jsonPath);
	const cleanupStats = loadCleanupStats(runDir, []);
	const report = buildSummary({ jsonPath, runDir, parsed, wallMs: 1500, exitCode: 0, cleanupStats, top: opts.top });
	assert.equal(report.counts.files, 2);
	assert.equal(report.counts.tests, 3);
	assert.equal(report.counts.failedTests, 1);
	assert.equal(report.cleanupStats.available, true);
	assert.equal(report.cleanupStats.skippedSweeps, 1);
	writeReports(report, runDir);
	console.log("[profile-hooks] self-test passed");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(usage());
		return;
	}
	if (opts.selfTest) {
		await selfTest(opts);
		return;
	}
	const runDir = join(opts.outDir, timestamp());
	mkdirSync(runDir, { recursive: true });
	const jsonPath = opts.fromJson ?? join(runDir, "vitest.json");
	let runResult = { code: 0, wallMs: null };
	if (!opts.fromJson) {
		runResult = await runVitest(jsonPath, runDir, opts.vitestArgs);
	}
	if (!existsSync(jsonPath)) {
		throw new Error(`Vitest JSON report not found: ${jsonPath}`);
	}
	const parsed = parseVitestJson(jsonPath);
	const cleanupStats = loadCleanupStats(runDir, opts.cleanupStatsPaths);
	const report = buildSummary({
		jsonPath,
		runDir,
		parsed,
		wallMs: runResult.wallMs,
		exitCode: runResult.code,
		cleanupStats,
		top: opts.top,
	});
	writeReports(report, runDir);
	process.exitCode = runResult.code;
}

main().catch((error) => {
	console.error(`[profile-hooks] fatal: ${error.stack ?? error.message ?? error}`);
	process.exitCode = 1;
});
