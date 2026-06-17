import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(__dirname, "../..");
export const currentMetricsDir = resolve(projectRoot, ".profiles", "metrics");
export const baselineMetricsDir = resolve(projectRoot, "docs", "testing-metrics");
export const schemaVersion = 1;

export function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
}

export function removeDir(dir) {
	rmSync(dir, { recursive: true, force: true });
}

export function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
	ensureDir(dirname(file));
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function pathFromRoot(...parts) {
	return resolve(projectRoot, ...parts);
}

export function metricFile(name, dir = currentMetricsDir) {
	return join(dir, `${name}.json`);
}

export function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function npxCommand() {
	return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function npmRunArgs(script, extraArgs = []) {
	return ["run", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
}

export function runSyncStep(label, command, args, options = {}) {
	console.log(`\n[metrics] ${label}: ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: projectRoot,
		stdio: "inherit",
		shell: options.shell ?? false,
		env: { ...process.env, ...(options.env || {}) },
	});
	if (result.error) throw result.error;
	if ((result.status ?? 1) !== 0) {
		throw new Error(`${label} exited with ${result.status ?? result.signal}`);
	}
}

export function ensureServerBuild() {
	if (existsSync(pathFromRoot("dist", "server"))) return;
	runSyncStep("build server", npmCommand(), npmRunArgs("build:server"), { shell: process.platform === "win32" });
}

export function ensureFullBuild() {
	runSyncStep("build", npmCommand(), ["run", "build", "--silent"], { shell: process.platform === "win32" });
}

function parseArgsForLog(args) {
	return args.map((arg) => String(arg));
}

function childEnv(extraEnv = {}) {
	return {
		...process.env,
		NODE_ENV: "test",
		BOBBIT_TEST_NO_EXTERNAL: process.env.BOBBIT_TEST_NO_EXTERNAL || "1",
		BOBBIT_TEST_NO_REMOTE: process.env.BOBBIT_TEST_NO_REMOTE || "1",
		...extraEnv,
	};
}

function runProcessListCommand() {
	if (process.platform === "win32") {
		const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
		const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
			cwd: projectRoot,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
		});
		if (res.status !== 0 || !res.stdout.trim()) return [];
		const raw = JSON.parse(res.stdout);
		const rows = Array.isArray(raw) ? raw : [raw];
		return rows.map((row) => ({
			pid: Number(row.ProcessId),
			ppid: Number(row.ParentProcessId),
			rssBytes: Number(row.WorkingSetSize) || 0,
			cpuMs: ((Number(row.KernelModeTime) || 0) + (Number(row.UserModeTime) || 0)) / 10_000,
		})).filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid));
	}

	const res = spawnSync("ps", ["-eo", "pid=,ppid=,rss=,pcpu="], {
		cwd: projectRoot,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (res.status !== 0 || !res.stdout.trim()) return [];
	return res.stdout.trim().split(/\r?\n/).map((line) => {
		const [pid, ppid, rssKb, pcpu] = line.trim().split(/\s+/);
		return {
			pid: Number(pid),
			ppid: Number(ppid),
			rssBytes: (Number(rssKb) || 0) * 1024,
			pcpu: Number(pcpu) || 0,
		};
	}).filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid));
}

function processTree(rows, rootPid) {
	const byParent = new Map();
	for (const row of rows) {
		if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
		byParent.get(row.ppid).push(row);
	}
	const tree = [];
	const seen = new Set();
	const stack = [rootPid];
	while (stack.length) {
		const pid = stack.pop();
		if (seen.has(pid)) continue;
		seen.add(pid);
		const row = rows.find((candidate) => candidate.pid === pid);
		if (row) tree.push(row);
		for (const child of byParent.get(pid) || []) stack.push(child.pid);
	}
	return tree;
}

function sampleTree(rootPid, previous, intervalMs) {
	try {
		const rows = runProcessListCommand();
		const tree = processTree(rows, rootPid);
		const rssBytes = tree.reduce((sum, row) => sum + (row.rssBytes || 0), 0);
		let cpuPercent = 0;
		let absoluteCpuMs;
		if (process.platform === "win32") {
			absoluteCpuMs = tree.reduce((sum, row) => sum + (row.cpuMs || 0), 0);
			if (previous?.absoluteCpuMs != null && intervalMs > 0) {
				cpuPercent = Math.max(0, ((absoluteCpuMs - previous.absoluteCpuMs) / intervalMs) * 100);
			}
		} else {
			cpuPercent = tree.reduce((sum, row) => sum + (row.pcpu || 0), 0);
		}
		return { rssBytes, cpuPercent, absoluteCpuMs, processCount: tree.length };
	} catch {
		return { rssBytes: 0, cpuPercent: 0, absoluteCpuMs: previous?.absoluteCpuMs, processCount: 0 };
	}
}

export async function measureCommand({ name, kind, command, args = [], outFile = metricFile(name), env = {}, shell = false, cwd = projectRoot, parseArtifacts, stdio = "pipe" }) {
	ensureDir(dirname(outFile));
	console.log(`\n[metrics] ${name}: ${command} ${parseArgsForLog(args).join(" ")}`);
	const startWall = performance.now();
	const startedAt = new Date().toISOString();
	let peakRssBytes = 0;
	let peakCpuPercent = 0;
	let cpuPercentSamples = 0;
	let cpuPercentTotal = 0;
	let estimatedCpuMs = 0;
	let previousSample;
	let lastSampleAt = performance.now();
	const stdoutTail = [];
	const stderrTail = [];
	const tailLimit = 200;
	function appendTail(target, chunk) {
		for (const line of String(chunk).split(/\r?\n/)) {
			if (!line) continue;
			target.push(line);
			if (target.length > tailLimit) target.shift();
		}
	}

	const child = spawn(command, args, {
		cwd,
		env: childEnv(env),
		shell,
		stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
	});
	if (stdio !== "inherit") {
		child.stdout?.on("data", (chunk) => { process.stdout.write(chunk); appendTail(stdoutTail, chunk); });
		child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); appendTail(stderrTail, chunk); });
	}
	const sampler = setInterval(() => {
		const now = performance.now();
		const intervalMs = now - lastSampleAt;
		lastSampleAt = now;
		const sample = sampleTree(child.pid, previousSample, intervalMs);
		previousSample = sample;
		peakRssBytes = Math.max(peakRssBytes, sample.rssBytes || 0);
		peakCpuPercent = Math.max(peakCpuPercent, sample.cpuPercent || 0);
		if (sample.cpuPercent > 0) {
			cpuPercentSamples += 1;
			cpuPercentTotal += sample.cpuPercent;
			estimatedCpuMs += intervalMs * (sample.cpuPercent / 100);
		}
	}, Number.parseInt(process.env.BOBBIT_METRICS_SAMPLE_MS || "1000", 10) || 1000);

	const exit = await new Promise((resolveExit) => {
		child.on("close", (code, signal) => resolveExit({ code: code ?? (signal ? 1 : 0), signal }));
		child.on("error", (error) => resolveExit({ code: 1, error }));
	});
	clearInterval(sampler);
	const durationMs = Math.round(performance.now() - startWall);
	let artifactData = {};
	let artifactError;
	if (parseArtifacts) {
		try {
			artifactData = await parseArtifacts({ exitCode: exit.code, durationMs });
		} catch (error) {
			artifactError = String(error?.stack || error);
		}
	}
	const metric = {
		schemaVersion,
		metricName: name,
		kind,
		createdAt: new Date().toISOString(),
		startedAt,
		status: exit.code === 0 && !artifactError ? "passed" : "failed",
		exitCode: exit.code || (artifactError ? 1 : 0),
		signal: exit.signal || null,
		command: { command, args: parseArgsForLog(args), cwd: relative(projectRoot, cwd) || "." },
		durationMs,
		cpu: {
			estimatedCpuMs: Math.round(estimatedCpuMs),
			averageCpuPercent: cpuPercentSamples ? Number((cpuPercentTotal / cpuPercentSamples).toFixed(2)) : 0,
			peakCpuPercent: Number(peakCpuPercent.toFixed(2)),
			sampleMs: Number.parseInt(process.env.BOBBIT_METRICS_SAMPLE_MS || "1000", 10) || 1000,
		},
		memory: { peakRssBytes },
		...artifactData,
	};
	if (exit.error) metric.error = String(exit.error?.stack || exit.error);
	if (artifactError) metric.artifactError = artifactError;
	if (exit.code !== 0) metric.outputTail = { stdout: stdoutTail, stderr: stderrTail };
	writeJson(outFile, metric);
	console.log(`[metrics] wrote ${relative(projectRoot, outFile)}`);
	if (metric.exitCode !== 0) process.exitCode = metric.exitCode;
	return metric;
}

export function parseLcovTotals(file = pathFromRoot("coverage", "lcov.info")) {
	const text = readFileSync(file, "utf8");
	const totals = {
		lines: { covered: 0, total: 0, pct: 100 },
		functions: { covered: 0, total: 0, pct: 100 },
		branches: { covered: 0, total: 0, pct: 100 },
	};
	for (const line of text.split(/\r?\n/)) {
		const [key, raw] = line.split(":");
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		if (key === "LF") totals.lines.total += value;
		if (key === "LH") totals.lines.covered += value;
		if (key === "FNF") totals.functions.total += value;
		if (key === "FNH") totals.functions.covered += value;
		if (key === "BRF") totals.branches.total += value;
		if (key === "BRH") totals.branches.covered += value;
	}
	for (const bucket of Object.values(totals)) {
		bucket.pct = bucket.total ? Number(((bucket.covered / bucket.total) * 100).toFixed(2)) : 100;
	}
	return totals;
}

function walkPlaywrightSuites(suites, tests = []) {
	for (const suite of suites || []) {
		for (const spec of suite.specs || []) {
			for (const test of spec.tests || []) tests.push(test);
		}
		walkPlaywrightSuites(suite.suites, tests);
	}
	return tests;
}

export function parsePlaywrightJson(file) {
	if (!existsSync(file)) return undefined;
	const report = readJson(file);
	const tests = walkPlaywrightSuites(report.suites || []);
	const summary = {
		total: tests.length,
		passed: 0,
		failed: 0,
		skipped: 0,
		flaky: 0,
		durationMs: 0,
		projects: {},
	};
	for (const test of tests) {
		const project = test.projectName || "unknown";
		if (!summary.projects[project]) summary.projects[project] = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };
		const target = summary.projects[project];
		const expected = test.expectedStatus;
		const actual = test.status;
		const duration = (test.results || []).reduce((sum, result) => sum + (result.duration || 0), 0);
		for (const bucket of [summary, target]) {
			bucket.total += bucket === target ? 1 : 0;
			bucket.durationMs += duration;
			if (actual === "skipped" || expected === "skipped") bucket.skipped += 1;
			else if (actual === "expected") bucket.passed += 1;
			else if (actual === "flaky") { bucket.passed += 1; bucket.flaky += 1; }
			else bucket.failed += 1;
		}
	}
	// The loop increments summary.total directly from tests.length; avoid double count.
	summary.total = tests.length;
	return summary;
}

export function listJsonFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => file.endsWith(".json") && statSync(join(dir, file)).isFile()).sort();
}

export function copyMetricToBaseline(name) {
	const source = metricFile(name, currentMetricsDir);
	const target = metricFile(name, baselineMetricsDir);
	if (!existsSync(source)) throw new Error(`Missing current metric ${source}`);
	writeJson(target, readJson(source));
}
