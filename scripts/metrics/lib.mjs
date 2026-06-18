import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(__dirname, "../..");
export const currentMetricsDir = resolve(projectRoot, ".profiles", "metrics");
export const baselineMetricsDir = resolve(projectRoot, "docs", "testing-metrics");
export const schemaVersion = 1;
export const requiredMetricNames = [
	"coverage",
	"unit-node",
	"unit-browser",
	"e2e-full",
	"e2e-api",
	"e2e-browser",
	"slice-renderer",
	"slice-scroll",
	"slice-sidebar",
];

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

export function normalizeMetricName(name) {
	return String(name).replace(/\\/g, "/").split("/").pop().replace(/\.json$/u, "").replace(/^baseline-/u, "");
}

export function metricFile(name, dir = currentMetricsDir) {
	return join(dir, `${normalizeMetricName(name)}.json`);
}

export function baselineMetricFile(name, dir = baselineMetricsDir) {
	return join(dir, `baseline-${normalizeMetricName(name)}.json`);
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

function normalizeReportPath(file) {
	if (!file || typeof file !== "string") return "<unknown>";
	const resolved = isAbsolute(file) ? file : resolve(projectRoot, file);
	let normalized = relative(projectRoot, resolved) || file;
	if (normalized.startsWith("..")) normalized = file;
	return normalized.replace(/\\/g, "/");
}

function summarizeTestStatus(test) {
	const expected = test.expectedStatus;
	const actual = test.status;
	if (actual === "skipped" || expected === "skipped") return "skipped";
	if (actual === "expected") return "passed";
	if (actual === "flaky") return "flaky";
	return "failed";
}

function emptyTestBucket() {
	return {
		total: 0,
		passed: 0,
		failed: 0,
		skipped: 0,
		flaky: 0,
		nonSkipped: 0,
		durationMs: 0,
	};
}

function addTestToBucket(bucket, status, duration) {
	bucket.total += 1;
	bucket.durationMs += duration;
	if (status === "skipped") bucket.skipped += 1;
	else {
		bucket.nonSkipped += 1;
		if (status === "passed") bucket.passed += 1;
		else if (status === "flaky") { bucket.passed += 1; bucket.flaky += 1; }
		else bucket.failed += 1;
	}
}

function ensureFileBucket(files, file) {
	if (!files[file]) files[file] = { ...emptyTestBucket(), titles: [] };
	return files[file];
}

function walkPlaywrightSuites(suites, entries = [], context = {}) {
	for (const suite of suites || []) {
		const file = suite.file || context.file;
		const suiteTitle = typeof suite.title === "string" ? suite.title : "";
		const fileLikeTitle = suite.file && normalizeReportPath(suiteTitle) === normalizeReportPath(suite.file);
		const titles = suiteTitle && !fileLikeTitle ? [...(context.titles || []), suiteTitle] : (context.titles || []);
		for (const spec of suite.specs || []) {
			const specFile = spec.file || file;
			const specTitle = typeof spec.title === "string" ? spec.title : "";
			const title = [...titles, specTitle].filter(Boolean).join(" >> ");
			for (const test of spec.tests || []) entries.push({ test, file: normalizeReportPath(specFile), title });
		}
		walkPlaywrightSuites(suite.suites, entries, { file, titles });
	}
	return entries;
}

export function parsePlaywrightJson(file) {
	if (!existsSync(file)) throw new Error(`Missing Playwright JSON report: ${file}`);
	const stat = statSync(file);
	if (!stat.isFile() || stat.size === 0) throw new Error(`Empty Playwright JSON report: ${file}`);
	const report = readJson(file);
	if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
		throw new Error(`Invalid Playwright JSON report (missing suites): ${file}`);
	}
	const testEntries = walkPlaywrightSuites(report.suites || []);
	if (testEntries.length === 0) throw new Error(`Playwright JSON report contains no tests: ${file}`);
	const summary = {
		...emptyTestBucket(),
		files: {},
		projects: {},
	};
	for (const { test, file: testFile, title } of testEntries) {
		const project = test.projectName || "unknown";
		if (!summary.projects[project]) summary.projects[project] = { ...emptyTestBucket(), files: {} };
		const target = summary.projects[project];
		const status = summarizeTestStatus(test);
		const duration = (test.results || []).reduce((sum, result) => sum + (result.duration || 0), 0);
		addTestToBucket(summary, status, duration);
		addTestToBucket(target, status, duration);
		for (const fileBucket of [ensureFileBucket(summary.files, testFile), ensureFileBucket(target.files, testFile)]) {
			addTestToBucket(fileBucket, status, duration);
			fileBucket.titles.push({ title, status, project });
		}
	}
	return summary;
}

export function listJsonFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((file) => file.endsWith(".json") && statSync(join(dir, file)).isFile()).sort();
}

export function copyMetricToBaseline(name) {
	const source = metricFile(name, currentMetricsDir);
	const target = baselineMetricFile(name, baselineMetricsDir);
	if (!existsSync(source)) throw new Error(`Missing current metric ${source}`);
	writeJson(target, readJson(source));
}
