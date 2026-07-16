#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PRELOAD_URL = pathToFileURL(join(HERE, "child-process-profile-preload.mjs")).href;
export const VITEST_ENTRY = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const VITEST_CONFIG = join(REPO_ROOT, "vitest.config.ts");
const DEFAULT_ROOT = join(REPO_ROOT, ".profiles", "testing-v2", "windows-process-profile");
const DEFAULT_PROJECTS = ["v2-core", "v2-integration", "v2-dom", "v2-isolated"];
const PROJECT_ALIASES = new Map([
	["core", "v2-core"],
	["integration", "v2-integration"],
	["dom", "v2-dom"],
	["isolated", "v2-isolated"],
	...DEFAULT_PROJECTS.map((project) => [project, project]),
]);
const LEGACY_DIR_NAMES = new Map([
	["v2-core", "core"],
	["v2-integration", "integration"],
	["v2-dom", "dom"],
	["v2-isolated", "isolated"],
]);
const FIXED_WORKER_CAP = 3;

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function requiredValue(argv, index, flag) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function normalizeProject(value) {
	const project = PROJECT_ALIASES.get(String(value || "").toLowerCase());
	if (!project) throw new Error(`Unknown project ${JSON.stringify(value)}; expected ${DEFAULT_PROJECTS.join(", ")}`);
	return project;
}

export function parseArgs(argv) {
	const opts = { projects: [], outRoot: DEFAULT_ROOT, top: 20, fromDir: null, workers: null, filters: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			opts.filters.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "--project" || arg === "--lane") {
			opts.projects.push(normalizeProject(requiredValue(argv, i, arg)));
			i += 1;
		} else if (arg.startsWith("--project=")) opts.projects.push(normalizeProject(arg.slice(10)));
		else if (arg.startsWith("--lane=")) opts.projects.push(normalizeProject(arg.slice(7)));
		else if (arg === "--out-dir") {
			opts.outRoot = resolve(REPO_ROOT, requiredValue(argv, i, arg));
			i += 1;
		} else if (arg.startsWith("--out-dir=")) opts.outRoot = resolve(REPO_ROOT, arg.slice(10));
		else if (arg === "--from-dir") {
			opts.fromDir = resolve(REPO_ROOT, requiredValue(argv, i, arg));
			i += 1;
		} else if (arg.startsWith("--from-dir=")) opts.fromDir = resolve(REPO_ROOT, arg.slice(11));
		else if (arg === "--top") {
			opts.top = Math.max(1, Number(requiredValue(argv, i, arg)) || 20);
			i += 1;
		} else if (arg.startsWith("--top=")) opts.top = Math.max(1, Number(arg.slice(6)) || 20);
		else if (arg === "--workers") {
			opts.workers = Math.max(1, Math.floor(Number(requiredValue(argv, i, arg)) || 1));
			i += 1;
		} else if (arg.startsWith("--workers=")) opts.workers = Math.max(1, Math.floor(Number(arg.slice(10)) || 1));
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown profiler argument: ${arg}; put Vitest filters after --`);
		else opts.filters.push(arg);
	}
	opts.projectsSpecified = opts.projects.length > 0;
	if (!opts.projects.length) opts.projects = [...DEFAULT_PROJECTS];
	else opts.projects = [...new Set(opts.projects)];
	return opts;
}

function usage() {
	return `Usage: node scripts/testing-v2/profile-windows-unit.mjs [options] [TEST_FILTER ...]\n\nRuns selected Vitest projects sequentially with child-process telemetry.\n\nOptions:\n  --project NAME   Select v2-core, v2-integration, v2-dom, or v2-isolated (repeatable)\n  --lane NAME      Backward-compatible alias for --project; core-style names are accepted\n  --workers N      Lower the fixed three-worker cap (never raises VITEST_MAX_WORKERS)\n  --out-dir PATH   Root for a new timestamped profile\n  --from-dir PATH  Rebuild a report from an existing profile directory without running tests\n  --top N          Executable rows per project in the Markdown report (default: 20)\n  -h, --help       Show this help\n\nPositional values, or values after --, are forwarded as Vitest test-file filters.\nExample: npm run test:v2:profile-windows -- --project v2-core tests2/core/windows-process-profile.test.ts\n\nThe profiler invokes node_modules/vitest/vitest.mjs directly with vitest.config.ts, the selected project, and --silent=passed-only. Arguments and environment values are never recorded.`;
}

function nodeOptionsWithPreload(existing = "") {
	const flag = `--import=${PRELOAD_URL}`;
	return existing.includes(PRELOAD_URL) ? existing : [existing, flag].filter(Boolean).join(" ");
}

export function resolveWorkerLimit(environmentValue, requestedValue) {
	const limits = [FIXED_WORKER_CAP];
	for (const value of [environmentValue, requestedValue]) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 1) limits.push(Math.floor(parsed));
	}
	return Math.min(...limits);
}

export function buildVitestArgs(project, filters = []) {
	return [
		"run",
		"--config", VITEST_CONFIG,
		"--project", normalizeProject(project),
		"--silent=passed-only",
		...filters,
	];
}

function findProjectDir(runDir, project) {
	const current = join(runDir, project);
	if (existsSync(current)) return current;
	return join(runDir, LEGACY_DIR_NAMES.get(project) || project);
}

function readExistingReport(runDir) {
	const reportPath = join(runDir, "report.json");
	if (!existsSync(reportPath)) return null;
	try { return JSON.parse(readFileSync(reportPath, "utf8")); }
	catch { return null; }
}

function reportProjects(report) {
	if (Array.isArray(report?.projects)) return report.projects.map((row) => normalizeProject(row.project));
	if (Array.isArray(report?.lanes)) return report.lanes.map((row) => normalizeProject(row.lane));
	return [];
}

function priorProjectRun(report, project) {
	const current = report?.projects?.find((row) => normalizeProject(row.project) === project);
	if (current) return current;
	return report?.lanes?.find((row) => normalizeProject(row.lane) === project) || null;
}

function runProject(project, projectDir, workers, filters) {
	mkdirSync(projectDir, { recursive: true });
	const logPath = join(projectDir, "vitest.log");
	const log = createWriteStream(logPath, { flags: "w" });
	const start = performance.now();
	return new Promise((resolveRun) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			log.end(() => resolveRun({ project, wallMs: performance.now() - start, logPath, ...result }));
		};
		const child = spawn(process.execPath, [VITEST_ENTRY, ...buildVitestArgs(project, filters)], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS),
				BOBBIT_V2_CHILD_PROFILE_DIR: join(projectDir, "processes"),
				VITEST_MAX_WORKERS: String(workers),
			},
			stdio: ["inherit", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
		child.stderr.on("data", (chunk) => { process.stderr.write(chunk); log.write(chunk); });
		child.once("error", (error) => finish({ code: 1, error: String(error) }));
		child.once("close", (code, signal) => finish({ code: code ?? (signal ? 1 : 0), signal }));
	});
}

export function readProfileRecords(processDir) {
	if (!existsSync(processDir)) return [];
	const records = [];
	for (const name of readdirSync(processDir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(processDir, name), "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try { records.push(JSON.parse(line)); } catch { /* retain profiling even after a torn final line */ }
		}
	}
	return records;
}

export function aggregateProcessRecords(records) {
	const starts = new Map(records.filter((r) => r.type === "start").map((r) => [r.id, r]));
	const ends = records.filter((r) => r.type === "end");
	const ownerEnds = new Map(records.filter((r) => r.type === "owner_end").map((r) => [r.ownerPid, r.endedAt]));
	const latestTimestamp = records.reduce((max, record) => Math.max(max, Number(record.endedAt ?? record.startedAt) || 0), 0);
	const byExecutable = new Map();
	const intervals = [];
	for (const end of ends) {
		const name = String(end.executable || "<unknown>").toLowerCase();
		const row = byExecutable.get(name) || { executable: name, count: 0, ok: 0, failed: 0, timeouts: 0, errors: 0, incomplete: 0, cumulativeMs: 0, maxMs: 0 };
		row.count += 1;
		if (end.outcome === "ok") row.ok += 1;
		else if (end.outcome === "timeout") row.timeouts += 1;
		else if (end.outcome === "error" || end.outcome === "throw") row.errors += 1;
		else row.failed += 1;
		const duration = Math.max(0, Number(end.durationMs) || 0);
		row.cumulativeMs += duration;
		row.maxMs = Math.max(row.maxMs, duration);
		byExecutable.set(name, row);
		if (Number.isFinite(end.startedAt) && Number.isFinite(end.endedAt)) intervals.push([end.startedAt, 1], [end.endedAt, -1]);
	}
	const completedIds = new Set(ends.map((record) => record.id));
	for (const start of starts.values()) {
		if (completedIds.has(start.id)) continue;
		const name = String(start.executable || "<unknown>").toLowerCase();
		const row = byExecutable.get(name) || { executable: name, count: 0, ok: 0, failed: 0, timeouts: 0, errors: 0, incomplete: 0, cumulativeMs: 0, maxMs: 0 };
		row.count += 1;
		row.incomplete += 1;
		byExecutable.set(name, row);
		const endedAt = Number(ownerEnds.get(start.ownerPid)) || latestTimestamp;
		if (Number.isFinite(start.startedAt) && endedAt >= start.startedAt) intervals.push([start.startedAt, 1], [endedAt, -1]);
	}
	intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let active = 0;
	let peakConcurrent = 0;
	for (const [, delta] of intervals) { active += delta; peakConcurrent = Math.max(peakConcurrent, active); }
	return {
		completed: ends.length,
		incomplete: Math.max(0, starts.size - completedIds.size),
		peakConcurrent,
		byExecutable: [...byExecutable.values()].sort((a, b) => b.cumulativeMs - a.cumulativeMs || b.count - a.count),
	};
}

function stripAnsi(text) { return text.replace(/\x1b\[[0-9;]*m/g, ""); }
function vitestTiming(logPath) {
	if (!logPath || !existsSync(logPath)) return null;
	const text = stripAnsi(readFileSync(logPath, "utf8"));
	const lines = text.split(/\r?\n/);
	const duration = [...lines].reverse().find((line) => /^\s*Duration\s+/.test(line));
	const files = [...lines].reverse().find((line) => /^\s*Test Files\s+/.test(line));
	const tests = [...lines].reverse().find((line) => /^\s*Tests\s+/.test(line));
	return { duration: duration?.trim() || null, files: files?.trim() || null, tests: tests?.trim() || null };
}

function markdown(report, top) {
	const lines = [
		"# Windows unit child-process profile",
		"",
		`Generated: ${report.generatedAt}`,
		`Platform: ${report.platform} ${report.arch}; Node ${report.node}`,
		`Vitest worker cap: ${report.workerCap}`,
		"",
	];
	for (const project of report.projects) {
		lines.push(`## ${project.project}`, "", `- Workers: ${project.workers ?? "unknown"}`, `- Exit: ${project.code}`, `- Wall: ${(project.wallMs / 1000).toFixed(1)}s`, `- Completed children: ${project.processes.completed}`, `- Incomplete children: ${project.processes.incomplete}`, `- Peak concurrent children: ${project.processes.peakConcurrent}`);
		if (project.vitest?.duration) lines.push(`- ${project.vitest.duration}`);
		lines.push("", "| Executable | Spawned | OK | Failed | Timeouts | Errors | Incomplete | Cumulative | Max |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
		for (const row of project.processes.byExecutable.slice(0, top)) {
			lines.push(`| \`${row.executable}\` | ${row.count} | ${row.ok} | ${row.failed} | ${row.timeouts} | ${row.errors} | ${row.incomplete} | ${(row.cumulativeMs / 1000).toFixed(1)}s | ${(row.maxMs / 1000).toFixed(1)}s |`);
		}
		lines.push("");
	}
	lines.push("Arguments and environment values are intentionally not captured.", "");
	return lines.join("\n");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) { console.log(usage()); return; }
	if (!opts.fromDir && !existsSync(VITEST_ENTRY)) throw new Error(`Vitest entry not found: ${VITEST_ENTRY}; run npm install first`);
	const runDir = opts.fromDir || join(opts.outRoot, timestamp());
	mkdirSync(runDir, { recursive: true });
	const existingReport = opts.fromDir ? readExistingReport(runDir) : null;
	if (opts.fromDir && !opts.projectsSpecified) {
		const existingProjects = reportProjects(existingReport);
		if (existingProjects.length) opts.projects = [...new Set(existingProjects)];
	}
	const workerCap = resolveWorkerLimit(process.env.VITEST_MAX_WORKERS, opts.workers ?? existingReport?.workerCap);
	const projectRuns = [];
	if (!opts.fromDir) {
		for (const project of opts.projects) {
			const workers = project === "v2-isolated" ? 1 : workerCap;
			console.log(`[windows-profile] starting ${project} workers=${workers}`);
			projectRuns.push({ ...(await runProject(project, join(runDir, project), workers, opts.filters)), workers });
		}
	}
	const projects = opts.projects.map((project) => {
		const projectDir = findProjectDir(runDir, project);
		const prior = priorProjectRun(existingReport, project);
		const projectRun = projectRuns.find((run) => run.project === project) || {
			project,
			code: prior?.code ?? null,
			wallMs: prior?.wallMs ?? 0,
			workers: prior?.workers ?? (project === "v2-isolated" ? 1 : workerCap),
			logPath: join(projectDir, "vitest.log"),
		};
		const records = readProfileRecords(join(projectDir, "processes"));
		return { ...projectRun, processes: aggregateProcessRecords(records), vitest: vitestTiming(projectRun.logPath) };
	});
	const report = { generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, runDir, workerCap, projects };
	writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(runDir, "report.md"), markdown(report, opts.top));
	console.log(`[windows-profile] report: ${join(runDir, "report.md")}`);
	if (projects.some((project) => project.code != null && project.code !== 0)) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });
