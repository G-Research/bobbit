#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "server", "cli.js");
const MOCK_AGENT_PATH = path.join(REPO_ROOT, "tests", "e2e", "mock-agent.mjs");
const WORKLOADS = new Set(["idle", "stream", "multi-tabs", "goal-team", "worktree-pool"]);
const DEFAULT_DURATION_SEC = 60;
const DEFAULT_RUNS = 3;
const SMOKE_DURATION_SEC = 5;
const DEFAULT_FLUSH_MS = 1000;

function usage() {
	return `Usage: node scripts/bench-server-cpu.mjs --workload <idle|stream|multi-tabs|goal-team|worktree-pool> [options]

Options:
  --workload <name>       Workload to run (default: idle, or idle in --smoke)
  --duration <seconds>    Steady-state workload duration per run (default: 60; smoke: 5)
  --runs <n>              Number of runs (default: 3; smoke: 1)
  --out <path>            Benchmark JSONL output (default: artifacts/cpu/<workload>.jsonl)
  --summary-out <path>    Summary JSON output (default: <out>.summary.json)
  --sessions <n>          Stream workload sessions (default: 1)
  --tabs <n>              Multi-tabs WebSocket clients (default: 5)
  --agents <n>            Goal-team worker agents (default: 3)
  --goals <n>             Worktree-pool goals to create (default: 3)
  --flush-ms <ms>         BOBBIT_CPU_DIAG_FLUSH_MS (default: 1000; smoke: 250)
  --smoke                 CI-friendly idle run defaults: duration=5, runs=1, flush=250
  --keep-temp             Keep per-run temp project/state directories
  --help                  Show this help

Examples:
  npm run build:server
  node scripts/bench-server-cpu.mjs --workload idle --duration 60 --runs 3 --out artifacts/cpu/idle.jsonl
  node scripts/bench-server-cpu.mjs --smoke --out artifacts/cpu/smoke.jsonl
`;
}

function parsePositiveNumber(name, value, { integer = false } = {}) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
		throw new Error(`Expected ${name} to be a positive ${integer ? "integer" : "number"}, got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function readFlagValue(argv, index, name) {
	const arg = argv[index];
	const eq = arg.indexOf("=");
	if (eq !== -1) return { value: arg.slice(eq + 1), nextIndex: index };
	if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
		throw new Error(`Missing value for ${name}`);
	}
	return { value: argv[index + 1], nextIndex: index + 1 };
}

export function parseArgs(argv = process.argv.slice(2)) {
	const explicit = new Set();
	const opts = {
		workload: "idle",
		durationSec: DEFAULT_DURATION_SEC,
		runs: DEFAULT_RUNS,
		out: undefined,
		summaryOut: undefined,
		sessions: 1,
		tabs: 5,
		agents: 3,
		goals: 3,
		flushMs: DEFAULT_FLUSH_MS,
		smoke: false,
		keepTemp: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			opts.help = true;
			continue;
		}
		if (arg === "--smoke") {
			opts.smoke = true;
			continue;
		}
		if (arg === "--keep-temp") {
			opts.keepTemp = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		const { value, nextIndex } = readFlagValue(argv, i, name);
		i = nextIndex;
		explicit.add(name);

		switch (name) {
			case "--workload": opts.workload = value; break;
			case "--duration": opts.durationSec = parsePositiveNumber(name, value); break;
			case "--runs": opts.runs = parsePositiveNumber(name, value, { integer: true }); break;
			case "--out": opts.out = value; break;
			case "--summary-out": opts.summaryOut = value; break;
			case "--sessions": opts.sessions = parsePositiveNumber(name, value, { integer: true }); break;
			case "--tabs": opts.tabs = parsePositiveNumber(name, value, { integer: true }); break;
			case "--agents": opts.agents = parsePositiveNumber(name, value, { integer: true }); break;
			case "--goals": opts.goals = parsePositiveNumber(name, value, { integer: true }); break;
			case "--flush-ms": opts.flushMs = parsePositiveNumber(name, value, { integer: true }); break;
			default: throw new Error(`Unknown option: ${name}`);
		}
	}

	if (opts.smoke) {
		if (!explicit.has("--duration")) opts.durationSec = SMOKE_DURATION_SEC;
		if (!explicit.has("--runs")) opts.runs = 1;
		if (!explicit.has("--flush-ms")) opts.flushMs = 250;
		if (!explicit.has("--workload")) opts.workload = "idle";
	}

	if (!WORKLOADS.has(opts.workload)) {
		throw new Error(`Unknown workload ${JSON.stringify(opts.workload)}. Expected one of: ${[...WORKLOADS].join(", ")}`);
	}
	if (!opts.out) opts.out = path.join("artifacts", "cpu", `${opts.workload}.jsonl`);
	if (!opts.summaryOut) opts.summaryOut = defaultSummaryPath(opts.out);
	return opts;
}

function defaultSummaryPath(outPath) {
	return outPath.endsWith(".jsonl") ? outPath.replace(/\.jsonl$/u, ".summary.json") : `${outPath}.summary.json`;
}

function round(value, digits = 3) {
	if (value === null || value === undefined || !Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function median(values) {
	const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const mid = Math.floor(nums.length / 2);
	return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values, p) {
	const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
	return nums[index];
}

function minMax(values) {
	const nums = values.filter((v) => Number.isFinite(v));
	if (nums.length === 0) return { min: null, max: null };
	return { min: Math.min(...nums), max: Math.max(...nums) };
}

function numeric(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sampleCpuPct(sample) {
	const direct = numeric(sample.cpuPct);
	if (direct !== null) return direct;
	const wallMs = numeric(sample.wallMs);
	const user = numeric(sample.cpuUserMs) ?? 0;
	const system = numeric(sample.cpuSystemMs) ?? 0;
	if (wallMs && wallMs > 0) return ((user + system) / wallMs) * 100;
	return null;
}

function sampleDelayP95(sample) {
	return numeric(sample.delayP95Ms)
		?? numeric(sample.eventLoopDelayMs?.p95)
		?? numeric(sample.eventLoopDelay?.p95Ms)
		?? null;
}

function isDiagnosticSample(sample) {
	return !!sample && typeof sample === "object" && (
		sample.kind === "cpu"
		|| sampleCpuPct(sample) !== null
		|| sample.rest
		|| sample.ws
	);
}

export function summarizeDiagnostics(samples, opts = {}) {
	const diagnosticSamples = samples.filter(isDiagnosticSample);
	const cpuPct = [];
	const delayP95 = [];
	const restP95 = [];
	let wallMs = 0;
	let restRequestCount = 0;
	let wsFrameCount = 0;
	let wsByteCount = 0;
	let wsRecipientCount = 0;
	let childCount = 0;
	const restRoutes = {};
	const wsTypes = {};

	for (const sample of diagnosticSamples) {
		const cpu = sampleCpuPct(sample);
		if (cpu !== null) cpuPct.push(cpu);
		const delay = sampleDelayP95(sample);
		if (delay !== null) delayP95.push(delay);
		if (numeric(sample.wallMs) !== null) wallMs += sample.wallMs;

		if (sample.rest && typeof sample.rest === "object") {
			for (const [route, stats] of Object.entries(sample.rest)) {
				if (!stats || typeof stats !== "object") continue;
				const count = numeric(stats.count) ?? 0;
				const p95 = numeric(stats.p95Ms) ?? numeric(stats.p95) ?? null;
				const bytes = numeric(stats.bytes) ?? numeric(stats.responseBytes) ?? numeric(stats.totalBytes) ?? 0;
				restRequestCount += count;
				if (p95 !== null) restP95.push(p95);
				const prev = restRoutes[route] ?? { count: 0, bytes: 0, maxP95Ms: null };
				prev.count += count;
				prev.bytes += bytes;
				prev.maxP95Ms = prev.maxP95Ms === null ? p95 : (p95 === null ? prev.maxP95Ms : Math.max(prev.maxP95Ms, p95));
				restRoutes[route] = prev;
			}
		}

		if (sample.ws && typeof sample.ws === "object") {
			for (const [type, stats] of Object.entries(sample.ws)) {
				if (!stats || typeof stats !== "object") continue;
				const frames = numeric(stats.frames) ?? numeric(stats.count) ?? numeric(stats.sends) ?? 0;
				const bytes = numeric(stats.bytes) ?? numeric(stats.totalBytes) ?? 0;
				const recipients = numeric(stats.recipients) ?? numeric(stats.recipientCount) ?? 0;
				wsFrameCount += frames;
				wsByteCount += bytes;
				wsRecipientCount += recipients;
				const prev = wsTypes[type] ?? { frames: 0, bytes: 0, recipients: 0 };
				prev.frames += frames;
				prev.bytes += bytes;
				prev.recipients += recipients;
				wsTypes[type] = prev;
			}
		}

		if (sample.child && typeof sample.child === "object") {
			for (const stats of Object.values(sample.child)) {
				if (!stats || typeof stats !== "object") continue;
				childCount += numeric(stats.count) ?? 0;
			}
		}
	}

	const durationSec = numeric(opts.durationSec) ?? (wallMs > 0 ? wallMs / 1000 : null);
	return {
		sampleCount: diagnosticSamples.length,
		wallMs: round(wallMs),
		durationSec: round(durationSec),
		medianCpuPct: round(median(cpuPct)),
		p95CpuPct: round(percentile(cpuPct, 95)),
		cpuPctMinMax: Object.fromEntries(Object.entries(minMax(cpuPct)).map(([k, v]) => [k, round(v)])),
		p95EventLoopDelayMs: round(percentile(delayP95, 95)),
		restRequestCount,
		restRequestsPerSec: durationSec ? round(restRequestCount / durationSec) : null,
		restP95Ms: round(percentile(restP95, 95)),
		wsFrameCount,
		wsFramesPerSec: durationSec ? round(wsFrameCount / durationSec) : null,
		wsByteCount,
		wsBytesPerSec: durationSec ? round(wsByteCount / durationSec) : null,
		wsRecipientCount,
		childProcessCount: childCount,
		restRoutes,
		wsTypes,
	};
}

export function readJsonl(filePath) {
	if (!fs.existsSync(filePath)) return { records: [], parseErrors: 0 };
	const text = fs.readFileSync(filePath, "utf-8").trim();
	if (!text) return { records: [], parseErrors: 0 };
	const records = [];
	let parseErrors = 0;
	for (const line of text.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		try { records.push(JSON.parse(line)); }
		catch { parseErrors++; }
	}
	return { records, parseErrors };
}

function appendJsonl(filePath, obj) {
	fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function nowIso() {
	return new Date().toISOString();
}

function gitCommit() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

function gitDirty() {
	try {
		return execFileSync("git", ["status", "--short"], { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
	} catch {
		return null;
	}
}

function commandMetadata(opts) {
	return {
		kind: "benchmark_metadata",
		commit: gitCommit(),
		gitDirty: gitDirty(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		os: { type: os.type(), release: os.release(), platform: os.platform(), arch: os.arch() },
		cpuCores: os.cpus()?.length ?? null,
		workload: opts.workload,
		runs: opts.runs,
		durationSec: opts.durationSec,
		options: {
			sessions: opts.sessions,
			tabs: opts.tabs,
			agents: opts.agents,
			goals: opts.goals,
			flushMs: opts.flushMs,
			smoke: opts.smoke,
		},
		artifacts: { out: path.resolve(opts.out), summaryOut: path.resolve(opts.summaryOut) },
		command: [process.execPath, ...process.argv.slice(1)],
	};
}

function makeWorkflowBlock() {
	const benchmark = {
		id: "benchmark",
		name: "Benchmark",
		description: "Fast benchmark workflow with command-only verification.",
		gates: [
			{
				id: "design-doc",
				name: "Design Document",
				content: true,
				inject_downstream: true,
				verify: [{ name: "Content present", type: "command", run: "echo ok" }],
			},
			{
				id: "implementation",
				name: "Implementation",
				depends_on: ["design-doc"],
				verify: [{ name: "Quick check", type: "command", component: "bench", command: "check" }],
			},
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				depends_on: ["implementation"],
				verify: [{ name: "Ready", type: "command", run: "echo ok" }],
			},
		],
	};
	return { benchmark, general: { ...benchmark, id: "general", name: "General Benchmark" } };
}

function makeComponent() {
	return {
		name: "bench",
		repo: ".",
		commands: {
			check: "echo ok",
			build: "echo ok",
			unit: "echo ok",
			e2e: "echo ok",
		},
	};
}

function runGit(args, cwd) {
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function prepareProject(tempRoot, workload) {
	const projectRoot = path.join(tempRoot, "project");
	fs.mkdirSync(projectRoot, { recursive: true });
	fs.writeFileSync(path.join(projectRoot, "README.md"), `# Bobbit CPU benchmark\n\nWorkload: ${workload}\n`);
	fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "# Benchmark fixture\n\nTemporary project for CPU benchmark runs.\n");
	fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".bobbit/\n*-wt/\nnode_modules/\n");

	if (workload === "worktree-pool") {
		runGit(["init"], projectRoot);
		runGit(["checkout", "-B", "master"], projectRoot);
		runGit(["config", "user.name", "Bobbit Benchmark"], projectRoot);
		runGit(["config", "user.email", "bench@example.invalid"], projectRoot);
		runGit(["add", "README.md", "AGENTS.md", ".gitignore"], projectRoot);
		runGit(["commit", "-m", "Initial benchmark fixture"], projectRoot);
	}

	return projectRoot;
}

function buildGatewayEnv(projectRoot, tempRoot, diagPath, opts) {
	const env = { ...process.env };
	env.NODE_ENV = "test";
	env.BOBBIT_DIR = path.join(projectRoot, ".bobbit");
	env.BOBBIT_AGENT_DIR = path.join(tempRoot, "agent");
	env.BOBBIT_CPU_DIAG = "1";
	env.BOBBIT_CPU_DIAG_JSONL = diagPath;
	env.BOBBIT_CPU_DIAG_FLUSH_MS = String(opts.flushMs);
	env.BOBBIT_E2E_PROFILE = "1";
	env.BOBBIT_E2E_PROFILE_FLUSH_MS = String(Math.max(opts.flushMs, 1000));
	env.BOBBIT_TIMING_LOG = "1";
	env.BOBBIT_SKIP_MCP = "1";
	env.BOBBIT_SKIP_NPM_CI = "1";
	env.BOBBIT_TEST_NO_PUSH = "1";
	env.BOBBIT_E2E = "1";
	env.BOBBIT_LLM_REVIEW_SKIP = "1";
	env.BOBBIT_NO_OPEN = "1";
	env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	env.BOBBIT_SKIP_TITLE_GEN = "1";
	if (opts.workload === "worktree-pool") delete env.BOBBIT_SKIP_WORKTREE_POOL;
	else env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	delete env.BOBBIT_GATEWAY_URL;
	delete env.BOBBIT_TOKEN;
	return env;
}

function tailAppend(current, chunk, max = 20_000) {
	const next = current + chunk;
	return next.length <= max ? next : next.slice(next.length - max);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 100, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await predicate();
			if (value) return value;
		} catch (err) {
			lastError = err;
		}
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

async function waitForGatewayFiles(projectRoot, child) {
	const stateDir = path.join(projectRoot, ".bobbit", "state");
	const gatewayUrlPath = path.join(stateDir, "gateway-url");
	const tokenPath = path.join(stateDir, "token");
	return waitFor(() => {
		if (child.exitCode !== null) throw new Error(`gateway exited early with code ${child.exitCode}`);
		if (!fs.existsSync(gatewayUrlPath) || !fs.existsSync(tokenPath)) return null;
		const gatewayUrl = fs.readFileSync(gatewayUrlPath, "utf-8").trim();
		const token = fs.readFileSync(tokenPath, "utf-8").trim();
		return gatewayUrl && token ? { gatewayUrl, token, stateDir } : null;
	}, { timeoutMs: 45_000, intervalMs: 100, label: "gateway-url/token files" });
}

async function waitForHealth(gatewayUrl, token) {
	await waitFor(async () => {
		const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
		const res = await fetch(new URL("/api/health", gatewayUrl), { headers });
		return res.ok ? true : null;
	}, { timeoutMs: 20_000, intervalMs: 200, label: "/api/health" });
}

async function terminateProcess(child) {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	const graceful = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
	if (!graceful && child.exitCode === null) {
		child.kill("SIGKILL");
		await Promise.race([exited, sleep(3000)]);
	}
}

async function apiFetch(ctx, apiPath, init = {}) {
	const headers = {
		Authorization: `Bearer ${ctx.token}`,
		...(init.body ? { "Content-Type": "application/json" } : {}),
		...(init.headers || {}),
	};
	return fetch(new URL(apiPath, ctx.gatewayUrl), { ...init, headers });
}

async function apiJson(ctx, apiPath, init = {}) {
	const res = await apiFetch(ctx, apiPath, init);
	const text = await res.text();
	let body = null;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	if (!res.ok) {
		throw new Error(`${init.method || "GET"} ${apiPath} failed: ${res.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
	}
	return body;
}

async function safeApi(ctx, apiPath, init = {}) {
	try {
		const res = await apiFetch(ctx, apiPath, init);
		await res.arrayBuffer().catch(() => null);
		return { ok: res.ok, status: res.status };
	} catch (err) {
		return { ok: false, error: err.message || String(err) };
	}
}

async function registerBenchmarkProject(ctx) {
	return apiJson(ctx, "/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: "bench",
			rootPath: ctx.projectRoot,
			upsert: true,
			acceptCanonical: true,
			components: [makeComponent()],
			workflows: makeWorkflowBlock(),
		}),
	});
}

async function createSession(ctx, body = {}) {
	const created = await apiJson(ctx, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: ctx.projectRoot, projectId: ctx.projectId, ...body }),
	});
	return created.id;
}

async function createGoal(ctx, body = {}) {
	return apiJson(ctx, "/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `CPU Bench ${ctx.opts.workload} ${Date.now()}`,
			projectId: ctx.projectId,
			workflowId: "benchmark",
			autoStartTeam: false,
			...body,
		}),
	});
}

function wsUrl(ctx, pathPart) {
	const base = new URL(ctx.gatewayUrl);
	base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
	base.pathname = pathPart;
	base.search = "";
	return base.toString();
}

let WebSocketCtor = null;
async function getWebSocketCtor() {
	if (!WebSocketCtor) {
		const mod = await import("ws");
		WebSocketCtor = mod.default ?? mod.WebSocket;
	}
	return WebSocketCtor;
}

async function connectWs(ctx, pathPart) {
	const WebSocket = await getWebSocketCtor();
	const ws = new WebSocket(wsUrl(ctx, pathPart), { perMessageDeflate: false });
	const messages = [];
	const waiters = [];
	let bytes = 0;
	let frames = 0;

	const conn = {
		ws,
		messages,
		get bytes() { return bytes; },
		get frames() { return frames; },
		messageCount: () => messages.length,
		send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
		close: () => {
			try { ws.close(); } catch { /* ignore */ }
		},
		waitForFrom(fromIndex, predicate, timeoutMs = 15_000) {
			const existing = messages.slice(fromIndex).find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`WS waitForFrom timed out after ${timeoutMs}ms`)), timeoutMs);
				waiters.push({ fromIndex, predicate, resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
			});
		},
	};

	ws.on("message", (raw) => {
		frames++;
		bytes += raw.length ?? Buffer.byteLength(String(raw));
		let msg;
		try { msg = JSON.parse(raw.toString()); }
		catch { msg = { type: "__parse_error", raw: raw.toString() }; }
		messages.push(msg);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			if (messages.length - 1 >= waiter.fromIndex && waiter.predicate(msg)) {
				waiter.resolve(msg);
				waiters.splice(i, 1);
			}
		}
	});

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`WS open timeout for ${pathPart}`)), 10_000);
		ws.once("open", () => {
			clearTimeout(timer);
			ws.send(JSON.stringify({ type: "auth", token: ctx.token }));
			resolve();
		});
		ws.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});

	await conn.waitForFrom(0, (msg) => msg.type === "auth_ok", 10_000);
	return conn;
}

function closeAll(conns) {
	for (const conn of conns) conn?.close?.();
}

async function driveIdle(ctx, deadline) {
	let healthChecks = 0;
	while (Date.now() < deadline) {
		await sleep(Math.min(5000, Math.max(100, deadline - Date.now())));
		if (Date.now() < deadline) {
			await safeApi(ctx, "/api/health");
			healthChecks++;
		}
	}
	await safeApi(ctx, "/api/health");
	return { ok: true, healthChecks };
}

async function driveStream(ctx, deadline) {
	const conns = [];
	let prompts = 0;
	let agentEnds = 0;
	try {
		for (let i = 0; i < ctx.opts.sessions; i++) {
			const sessionId = await createSession(ctx, { title: `CPU stream ${i + 1}` });
			const conn = await connectWs(ctx, `/ws/${sessionId}`);
			conns.push(conn);
		}
		while (Date.now() < deadline) {
			const waits = [];
			for (const conn of conns) {
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: `STAY_BUSY:propose_goal:12 CPU_STREAM_${prompts}` });
				prompts++;
				waits.push(conn.waitForFrom(cursor, (m) => m.type === "event" && m.data?.type === "agent_end", 12_000).then(() => { agentEnds++; }).catch(() => null));
			}
			await Promise.race([Promise.all(waits), sleep(2500)]);
			await safeApi(ctx, "/api/sessions");
		}
		return { ok: true, sessions: conns.length, prompts, agentEnds, wsFrames: conns.reduce((n, c) => n + c.frames, 0), wsBytes: conns.reduce((n, c) => n + c.bytes, 0) };
	} finally {
		closeAll(conns);
	}
}

async function driveMultiTabs(ctx, deadline) {
	const conns = [];
	let prompts = 0;
	let polls = 0;
	try {
		const sessionId = await createSession(ctx, { title: "CPU multi-tabs" });
		for (let i = 0; i < ctx.opts.tabs; i++) conns.push(await connectWs(ctx, `/ws/${sessionId}`));
		conns.push(await connectWs(ctx, "/ws/viewer"));
		let nextPrompt = 0;
		while (Date.now() < deadline) {
			if (Date.now() >= nextPrompt) {
				const cursor = conns[0].messageCount();
				conns[0].send({ type: "prompt", text: `STAY_BUSY:propose_goal:8 CPU_MULTI_${prompts}` });
				prompts++;
				nextPrompt = Date.now() + 10_000;
				conns[0].waitForFrom(cursor, (m) => m.type === "event" && m.data?.type === "agent_end", 15_000).catch(() => null);
			}
			await Promise.all([
				safeApi(ctx, "/api/sessions"),
				safeApi(ctx, "/api/goals"),
				safeApi(ctx, "/api/projects"),
			]);
			polls += 3;
			await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
		}
		return { ok: true, sessionId, tabs: ctx.opts.tabs, prompts, polls, wsFrames: conns.reduce((n, c) => n + c.frames, 0), wsBytes: conns.reduce((n, c) => n + c.bytes, 0) };
	} finally {
		closeAll(conns);
	}
}

async function driveGoalTeam(ctx, deadline) {
	const conns = [];
	let spawned = 0;
	let polls = 0;
	let gateSignaled = false;
	const roles = ["coder", "reviewer", "test-engineer", "docs-writer", "qa-tester"];
	try {
		const goal = await createGoal(ctx, { title: `CPU Goal Team ${Date.now()}` });
		conns.push(await connectWs(ctx, "/ws/viewer"));
		const goalSessionId = await createSession(ctx, { goalId: goal.id, title: "CPU goal observer" });
		conns.push(await connectWs(ctx, `/ws/${goalSessionId}`));
		await apiJson(ctx, `/api/goals/${goal.id}/team/start`, { method: "POST" });
		for (let i = 0; i < ctx.opts.agents; i++) {
			const role = roles[i % roles.length];
			try {
				await apiJson(ctx, `/api/goals/${goal.id}/team/spawn`, {
					method: "POST",
					body: JSON.stringify({ role, task: `STAY_BUSY:500 CPU goal-team worker ${i + 1}` }),
				});
				spawned++;
			} catch (err) {
				if (spawned === 0) throw err;
			}
		}
		try {
			await apiJson(ctx, `/api/goals/${goal.id}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Benchmark design\n\nCPU benchmark signal." }),
			});
			gateSignaled = true;
		} catch {
			gateSignaled = false;
		}
		while (Date.now() < deadline) {
			await Promise.all([
				safeApi(ctx, `/api/goals/${goal.id}`),
				safeApi(ctx, `/api/goals/${goal.id}/team`),
				safeApi(ctx, `/api/goals/${goal.id}/team/agents`),
				safeApi(ctx, `/api/goals/${goal.id}/tasks`),
				safeApi(ctx, `/api/goals/${goal.id}/gates`),
				safeApi(ctx, `/api/goals/${goal.id}/verifications/active`),
				safeApi(ctx, `/api/goals/${goal.id}/cost`),
			]);
			polls += 7;
			await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
		}
		await safeApi(ctx, `/api/goals/${goal.id}/team/teardown`, { method: "POST" });
		return { ok: true, goalId: goal.id, spawnedAgents: spawned, gateSignaled, polls, wsFrames: conns.reduce((n, c) => n + c.frames, 0), wsBytes: conns.reduce((n, c) => n + c.bytes, 0) };
	} finally {
		closeAll(conns);
	}
}

async function driveWorktreePool(ctx, deadline) {
	const createdGoals = [];
	let polls = 0;
	let createErrors = 0;
	let nextCreate = 0;
	let lastPoolStatus = null;
	while (Date.now() < deadline) {
		if (createdGoals.length < ctx.opts.goals && Date.now() >= nextCreate) {
			try {
				const goal = await createGoal(ctx, { title: `CPU Worktree Pool ${createdGoals.length + 1} ${Date.now()}`, autoStartTeam: false });
				createdGoals.push(goal.id);
			} catch {
				createErrors++;
			}
			nextCreate = Date.now() + 1000;
		}
		const poolRes = await apiFetch(ctx, `/api/worktree-pool?projectId=${encodeURIComponent(ctx.projectId)}`).catch(() => null);
		if (poolRes?.ok) {
			try { lastPoolStatus = await poolRes.json(); } catch { /* ignore */ }
		}
		await safeApi(ctx, "/api/goals");
		for (const goalId of createdGoals) await safeApi(ctx, `/api/goals/${goalId}`);
		polls += 2 + createdGoals.length;
		await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
	}
	return { ok: createdGoals.length > 0 && createErrors === 0, createdGoals: createdGoals.length, createErrors, polls, lastPoolStatus };
}

async function driveWorkload(ctx) {
	const deadline = Date.now() + ctx.opts.durationSec * 1000;
	switch (ctx.opts.workload) {
		case "idle": return driveIdle(ctx, deadline);
		case "stream": return driveStream(ctx, deadline);
		case "multi-tabs": return driveMultiTabs(ctx, deadline);
		case "goal-team": return driveGoalTeam(ctx, deadline);
		case "worktree-pool": return driveWorktreePool(ctx, deadline);
		default: throw new Error(`Unsupported workload: ${ctx.opts.workload}`);
	}
}

async function runOne(runIndex, opts, metadata) {
	if (!fs.existsSync(CLI_PATH)) {
		throw new Error(`Built gateway not found at ${CLI_PATH}. Run npm run build:server first.`);
	}
	if (!fs.existsSync(MOCK_AGENT_PATH)) {
		throw new Error(`Mock agent not found at ${MOCK_AGENT_PATH}`);
	}

	const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bobbit-cpu-bench-"));
	let projectRoot;
	try {
		projectRoot = prepareProject(tempRoot, opts.workload);
	} catch (err) {
		if (!opts.keepTemp) {
			try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		throw err;
	}
	const outBase = path.resolve(opts.out).replace(/\.jsonl$/u, "");
	const diagPath = `${outBase}.run-${runIndex}.gateway.jsonl`;
	ensureParentDir(diagPath);
	try { fs.rmSync(diagPath, { force: true }); } catch { /* ignore */ }

	const child = spawn(process.execPath, [
		CLI_PATH,
		"--cwd", projectRoot,
		"--host", "127.0.0.1",
		"--port", "0",
		"--no-ui",
		"--auth",
		"--no-tls",
		"--agent-cli", MOCK_AGENT_PATH,
	], {
		cwd: REPO_ROOT,
		env: buildGatewayEnv(projectRoot, tempRoot, diagPath, opts),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdoutTail = "";
	let stderrTail = "";
	child.stdout.on("data", (chunk) => { stdoutTail = tailAppend(stdoutTail, chunk.toString()); });
	child.stderr.on("data", (chunk) => { stderrTail = tailAppend(stderrTail, chunk.toString()); });

	const startedAt = Date.now();
	let project = null;
	let workloadResult = { ok: false, error: "not started" };
	let startupMs = null;
	let setupMs = null;
	let driveMs = null;
	try {
		const files = await waitForGatewayFiles(projectRoot, child);
		await waitForHealth(files.gatewayUrl, files.token);
		startupMs = Date.now() - startedAt;
		const setupStart = Date.now();
		const ctx = { ...files, projectRoot, tempRoot, opts, token: files.token, gatewayUrl: files.gatewayUrl };
		project = await registerBenchmarkProject(ctx);
		ctx.projectId = project.id;
		setupMs = Date.now() - setupStart;
		const driveStart = Date.now();
		workloadResult = await driveWorkload(ctx);
		driveMs = Date.now() - driveStart;
	} catch (err) {
		workloadResult = { ok: false, error: err.message || String(err) };
	} finally {
		await terminateProcess(child);
	}

	// Give diagnostics writers a brief chance to flush and close file handles.
	await sleep(250);
	const { records, parseErrors } = readJsonl(diagPath);
	const metrics = summarizeDiagnostics(records, { durationSec: opts.durationSec });
	const endedAt = Date.now();
	const result = {
		kind: "benchmark_run",
		run: runIndex,
		startedAt: new Date(startedAt).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		startupMs,
		setupMs,
		driveMs,
		workload: opts.workload,
		workloadResult,
		success: workloadResult.ok === true,
		projectId: project?.id ?? null,
		tempRoot: opts.keepTemp ? tempRoot : undefined,
		diagnosticsPath: path.resolve(diagPath),
		diagnosticsRecords: records.length,
		diagnosticsParseErrors: parseErrors,
		metrics,
		gatewayExitCode: child.exitCode,
		gatewaySignalCode: child.signalCode,
		gatewayStdoutTail: stdoutTail.slice(-4000),
		gatewayStderrTail: stderrTail.slice(-4000),
		metadata: {
			commit: metadata.commit,
			node: metadata.node,
			platform: metadata.platform,
			cpuCores: metadata.cpuCores,
		},
	};

	if (!opts.keepTemp) {
		try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	}
	return result;
}

export function aggregateRuns(metadata, runResults) {
	const cpu = runResults.map((r) => r.metrics?.medianCpuPct).filter((v) => Number.isFinite(v));
	const delay = runResults.map((r) => r.metrics?.p95EventLoopDelayMs).filter((v) => Number.isFinite(v));
	const rest = runResults.map((r) => r.metrics?.restP95Ms).filter((v) => Number.isFinite(v));
	const wsFrames = runResults.map((r) => r.metrics?.wsFramesPerSec).filter((v) => Number.isFinite(v));
	const wsBytes = runResults.map((r) => r.metrics?.wsBytesPerSec).filter((v) => Number.isFinite(v));
	return {
		kind: "benchmark_summary",
		generatedAt: nowIso(),
		metadata,
		workload: metadata.workload,
		runs: runResults.length,
		successfulRuns: runResults.filter((r) => r.success).length,
		medianCpuPct: round(median(cpu)),
		cpuPctMinMax: Object.fromEntries(Object.entries(minMax(cpu)).map(([k, v]) => [k, round(v)])),
		p95EventLoopDelayMs: round(percentile(delay, 95)),
		restP95Ms: round(percentile(rest, 95)),
		wsFramesPerSec: round(median(wsFrames)),
		wsBytesPerSec: round(median(wsBytes)),
		diagnosticsPaths: runResults.map((r) => r.diagnosticsPath),
		runSummaries: runResults.map((r) => ({
			run: r.run,
			success: r.success,
			startupMs: r.startupMs,
			setupMs: r.setupMs,
			driveMs: r.driveMs,
			workloadResult: r.workloadResult,
			diagnosticsRecords: r.diagnosticsRecords,
			diagnosticsParseErrors: r.diagnosticsParseErrors,
			metrics: r.metrics,
		})),
	};
}

export async function runBenchmark(opts) {
	const metadata = commandMetadata(opts);
	ensureParentDir(opts.out);
	ensureParentDir(opts.summaryOut);
	fs.writeFileSync(opts.out, "");
	appendJsonl(opts.out, { kind: "benchmark_start", generatedAt: nowIso(), metadata });
	const runResults = [];
	for (let runIndex = 1; runIndex <= opts.runs; runIndex++) {
		const result = await runOne(runIndex, opts, metadata);
		runResults.push(result);
		appendJsonl(opts.out, result);
	}
	const summary = aggregateRuns(metadata, runResults);
	appendJsonl(opts.out, summary);
	fs.writeFileSync(opts.summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

async function main() {
	let opts;
	try {
		opts = parseArgs();
	} catch (err) {
		console.error(err.message || String(err));
		console.error("\n" + usage());
		process.exit(2);
	}
	if (opts.help) {
		console.log(usage());
		return;
	}
	try {
		const summary = await runBenchmark(opts);
		console.log(JSON.stringify({
			workload: summary.workload,
			runs: summary.runs,
			successfulRuns: summary.successfulRuns,
			medianCpuPct: summary.medianCpuPct,
			p95EventLoopDelayMs: summary.p95EventLoopDelayMs,
			restP95Ms: summary.restP95Ms,
			wsFramesPerSec: summary.wsFramesPerSec,
			out: path.resolve(opts.out),
			summaryOut: path.resolve(opts.summaryOut),
		}, null, 2));
		if (summary.successfulRuns !== summary.runs) process.exitCode = 1;
	} catch (err) {
		console.error(err.stack || err.message || String(err));
		process.exit(1);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
