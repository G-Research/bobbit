#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { readLedger } from "./ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PRELOAD_URL = pathToFileURL(join(HERE, "child-process-profile-preload.mjs")).href;
const UNIT_RUNNER = join(HERE, "run-unit-lanes.mjs");
const DEFAULT_ROOT = join(REPO_ROOT, ".profiles", "testing-v2", "windows-process-profile");
const KNOWN_LANES = ["core", "integration", "dom"];
const PRODUCTION_WORKERS = { core: 3, integration: 4, dom: 1 };

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function parseArgs(argv) {
	const opts = { lanes: [], outRoot: DEFAULT_ROOT, top: 20, fromDir: null, workers: null, allowLoaded: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--lane") opts.lanes.push(String(argv[++i] || ""));
		else if (arg.startsWith("--lane=")) opts.lanes.push(arg.slice(7));
		else if (arg === "--out-dir") opts.outRoot = resolve(REPO_ROOT, argv[++i]);
		else if (arg.startsWith("--out-dir=")) opts.outRoot = resolve(REPO_ROOT, arg.slice(10));
		else if (arg === "--from-dir") opts.fromDir = resolve(REPO_ROOT, argv[++i]);
		else if (arg.startsWith("--from-dir=")) opts.fromDir = resolve(REPO_ROOT, arg.slice(11));
		else if (arg === "--top") opts.top = Math.max(1, Number(argv[++i]) || 20);
		else if (arg === "--workers") opts.workers = Math.max(1, Number(argv[++i]) || 1);
		else if (arg.startsWith("--workers=")) opts.workers = Math.max(1, Number(arg.slice(10)) || 1);
		else if (arg === "--allow-loaded") opts.allowLoaded = true;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!opts.lanes.length) opts.lanes = [...KNOWN_LANES];
	for (const lane of opts.lanes) if (!KNOWN_LANES.includes(lane)) throw new Error(`Unknown lane ${JSON.stringify(lane)}`);
	return opts;
}

function usage() {
	return `Usage: node scripts/testing-v2/profile-windows-unit.mjs [--lane core|integration|dom] [--workers N] [--out-dir PATH] [--allow-loaded]\n\nRuns selected lanes sequentially with child-process telemetry. Defaults to the production three-suite allocation (core=3, integration=4, dom=1) and refuses a contaminated concurrency ledger unless --allow-loaded is explicit. Arguments and environment values are never recorded.`;
}

function nodeOptionsWithPreload(existing = "") {
	const flag = `--import=${PRELOAD_URL}`;
	return existing.includes(PRELOAD_URL) ? existing : [existing, flag].filter(Boolean).join(" ");
}

function runLane(lane, laneDir, workers) {
	mkdirSync(laneDir, { recursive: true });
	const start = performance.now();
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [UNIT_RUNNER, "--lane", lane], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				NODE_OPTIONS: nodeOptionsWithPreload(process.env.NODE_OPTIONS),
				BOBBIT_V2_CHILD_PROFILE_DIR: join(laneDir, "processes"),
				BOBBIT_V2_LEDGER_PARENT: `profile-${process.pid}-${lane}`,
				BOBBIT_V2_SLOTS_VITEST: String(workers),
			},
			stdio: "inherit",
		});
		child.once("error", (error) => resolveRun({ lane, code: 1, wallMs: performance.now() - start, error: String(error) }));
		child.once("close", (code, signal) => {
			const sourceLog = join(REPO_ROOT, ".profiles", "unit-lanes", `${lane}.log`);
			const copiedLog = join(laneDir, "vitest.log");
			if (existsSync(sourceLog)) copyFileSync(sourceLog, copiedLog);
			resolveRun({ lane, code: code ?? (signal ? 1 : 0), signal, wallMs: performance.now() - start, logPath: existsSync(copiedLog) ? copiedLog : null });
		});
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
		`Ledger at start: ${report.ledgerAtStart.reserved}/${report.ledgerAtStart.totalCores} workers reserved${report.contaminated ? " (loaded profile)" : " (quiet profile)"}`,
		"",
	];
	for (const lane of report.lanes) {
		lines.push(`## ${lane.lane}`, "", `- Workers: ${lane.workers ?? "unknown"}`, `- Exit: ${lane.code}`, `- Wall: ${(lane.wallMs / 1000).toFixed(1)}s`, `- Completed children: ${lane.processes.completed}`, `- Incomplete children: ${lane.processes.incomplete}`, `- Peak concurrent children: ${lane.processes.peakConcurrent}`);
		if (lane.vitest?.duration) lines.push(`- ${lane.vitest.duration}`);
		lines.push("", "| Executable | Spawned | OK | Failed | Timeouts | Errors | Incomplete | Cumulative | Max |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
		for (const row of lane.processes.byExecutable.slice(0, top)) {
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
	const ledgerAtStart = readLedger();
	const reservedAtStart = ledgerAtStart.reservations.reduce((sum, row) => sum + (row.workerSlots || 0), 0);
	if (!opts.fromDir && !opts.allowLoaded && reservedAtStart > 0) {
		throw new Error(`Refusing contaminated profile: concurrency ledger already has ${reservedAtStart}/${ledgerAtStart.totalCores} workers reserved (pass --allow-loaded to override)`);
	}
	const runDir = opts.fromDir || join(opts.outRoot, timestamp());
	mkdirSync(runDir, { recursive: true });
	const laneRuns = [];
	if (!opts.fromDir) {
		for (const lane of opts.lanes) {
			console.log(`[windows-profile] starting ${lane}`);
			const workers = opts.workers ?? PRODUCTION_WORKERS[lane];
			console.log(`[windows-profile] ${lane} workers=${workers}`);
			laneRuns.push({ ...(await runLane(lane, join(runDir, lane), workers)), workers });
		}
	}
	const lanes = opts.lanes.map((lane) => {
		const laneRun = laneRuns.find((r) => r.lane === lane) || { lane, code: null, wallMs: 0, logPath: join(runDir, lane, "vitest.log") };
		const records = readProfileRecords(join(runDir, lane, "processes"));
		return { ...laneRun, processes: aggregateProcessRecords(records), vitest: vitestTiming(laneRun.logPath) };
	});
	const report = { generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, runDir, ledgerAtStart: { reserved: reservedAtStart, totalCores: ledgerAtStart.totalCores }, contaminated: reservedAtStart > 0, lanes };
	writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(runDir, "report.md"), markdown(report, opts.top));
	console.log(`[windows-profile] report: ${join(runDir, "report.md")}`);
	if (lanes.some((lane) => lane.code != null && lane.code !== 0)) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => { console.error(error); process.exit(1); });
