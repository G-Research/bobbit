#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const PAIRS = Number.parseInt(process.env.EXP003_PAIRS || "10", 10);
const OUT_JSON = path.join(projectRoot, "docs", "experiments", "EXP-003-warm-pool-spawn-latency-results.json");
const OUT_MD = path.join(projectRoot, "docs", "experiments", "EXP-003-warm-pool-spawn-latency-summary.md");
const MOCK_AGENT = path.join(projectRoot, "tests", "e2e", "mock-agent.mjs");

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { cwd: opts.cwd || projectRoot, encoding: "utf8", stdio: opts.stdio || "pipe" }).trim();
}

function pct(n) {
	return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n) {
	return `${n.toFixed(1)} ms`;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p90(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
}

function summarize(values) {
	return {
		n: values.length,
		medianMs: median(values),
		p90Ms: p90(values),
		meanMs: values.reduce((a, b) => a + b, 0) / values.length,
		minMs: Math.min(...values),
		maxMs: Math.max(...values),
	};
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function poolCounters(pool) {
	return pool.getMetrics();
}

function diffCounters(before, after) {
	const out = {};
	for (const key of Object.keys(after)) out[key] = after[key] - (before[key] ?? 0);
	return out;
}

async function waitForPoolIdle(pool, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pool.getStatus().every(s => !s.filling)) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for warm pool fills to finish; status=${JSON.stringify(pool.getStatus())}`);
}

async function waitForPoolReady(pool, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = pool.getStatus();
		if (status.some(s => s.ready > 0) && status.every(s => !s.filling)) return status;
		await sleep(25);
	}
	throw new Error(`timed out waiting for a ready warm pool entry; status=${JSON.stringify(pool.getStatus())}`);
}

function idlePoolEntries(pool) {
	const pools = pool.pools;
	if (!(pools instanceof Map)) return [];
	const entries = [];
	for (const [key, state] of pools.entries()) {
		for (const entry of state.entries || []) entries.push({ key, entry });
	}
	return entries;
}

function rssKbForPid(pid) {
	if (!pid) return undefined;
	try {
		const raw = run("ps", ["-o", "rss=", "-p", String(pid)]);
		const n = Number.parseInt(raw.trim(), 10);
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

function idlePoolRssSamples(pool) {
	return idlePoolEntries(pool).map(({ key, entry }) => {
		const pid = entry.rpcClient?.process?.pid;
		const rssKb = rssKbForPid(pid);
		return {
			key,
			poolOwnedId: entry.id,
			pid: pid ?? null,
			rssKb: rssKb ?? null,
			rssMiB: rssKb === undefined ? null : rssKb / 1024,
		};
	});
}

async function createHarness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-exp003-"));
	const bobbitDir = fs.realpathSync(root);
	const agentDir = path.join(bobbitDir, "agent");
	const defaultProjectRoot = path.join(bobbitDir, "default-project");
	fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(defaultProjectRoot, { recursive: true });
	fs.writeFileSync(path.join(bobbitDir, "state", "projects.json"), "[]");
	fs.writeFileSync(path.join(bobbitDir, "state", "setup-complete"), "exp003\n");
	fs.writeFileSync(path.join(defaultProjectRoot, "README.md"), "# EXP-003 fixture\n");

	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_SECRETS_DIR = path.join(bobbitDir, ".secrets");
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_TEST_NO_REMOTE = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";
	process.env.BOBBIT_WARM_POOL_TARGET_SIZE = "1";
	process.env.BOBBIT_WARM_POOL_TTL_MS = "600000";
	process.env.BOBBIT_WARM_POOL = "0";

	const { setProjectRoot, resetAgentDirStateForTests } = await import("../dist/server/bobbit-dir.js");
	const { scaffoldBobbitDir } = await import("../dist/server/scaffold.js");
	const { loadOrCreateToken } = await import("../dist/server/auth/token.js");
	const { createGateway } = await import("../dist/server/server.js");

	resetAgentDirStateForTests();
	setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	const token = loadOrCreateToken();
	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: bobbitDir,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
	});
	const port = await gw.start();
	const gatewayUrl = `http://127.0.0.1:${port}`;
	process.env.BOBBIT_GATEWAY_URL = gatewayUrl;
	process.env.BOBBIT_TOKEN = token;
	fs.writeFileSync(path.join(bobbitDir, "state", "gateway-url"), gatewayUrl);

	const projectResp = await fetch(`${gatewayUrl}/api/projects`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ name: "exp003", rootPath: defaultProjectRoot, upsert: true, acceptCanonical: true }),
	});
	if (!projectResp.ok) {
		throw new Error(`project registration failed: ${projectResp.status} ${await projectResp.text()}`);
	}
	const project = await projectResp.json();
	return { gw, bobbitDir, defaultProjectRoot, projectId: project.id };
}

async function safeTerminate(sessionManager, sessionId) {
	try { await sessionManager.terminateSession(sessionId); } catch {}
}

async function measureCreate({ sessionManager, projectId, cwd, arm, pair, phase, pool }) {
	const before = poolCounters(pool);
	const t0 = performance.now();
	const session = await sessionManager.createSession(cwd, undefined, undefined, undefined, {
		projectId,
		title: `EXP-003 ${arm} ${phase} ${pair}`,
	});
	const latencyMs = performance.now() - t0;
	const after = poolCounters(pool);
	return {
		pair,
		arm,
		phase,
		sessionId: session.id,
		status: session.status,
		latencyMs,
		poolBefore: before,
		poolAfter: after,
		poolDelta: diffCounters(before, after),
	};
}

async function main() {
	if (!Number.isFinite(PAIRS) || PAIRS < 10) {
		throw new Error(`EXP003_PAIRS must be >= 10; got ${process.env.EXP003_PAIRS || "10"}`);
	}
	const commit = run("git", ["rev-parse", "HEAD"]);
	const preregCommit = run("git", ["rev-parse", "a6948372"]);
	const generatedAt = new Date().toISOString();
	const harness = await createHarness();
	const rows = [];
	const memorySamples = [];
	const notes = [
		"Measurement uses an isolated in-process gateway and the repo mock-agent as a real RpcBridge child process, not the InProcessMockBridge shortcut.",
		"Primary ready signal is SessionManager.createSession returning a session whose normal setup path has set status to idle.",
	];
	let shutdownError;
	try {
		const sessionManager = harness.gw.sessionManager;
		const pool = sessionManager.getPiProcessPool();
		const cwd = harness.defaultProjectRoot;

		for (let pair = 1; pair <= PAIRS; pair++) {
			process.env.BOBBIT_WARM_POOL = "0";
			await waitForPoolIdle(pool).catch(() => {});
			await pool.drain();

			const off = await measureCreate({ sessionManager, projectId: harness.projectId, cwd, arm: "off", pair, phase: "measured", pool });
			rows.push(off);
			await safeTerminate(sessionManager, off.sessionId);

			process.env.BOBBIT_WARM_POOL = "1";
			await pool.drain();

			const warmup = await measureCreate({ sessionManager, projectId: harness.projectId, cwd, arm: "on", pair, phase: "warmup", pool });
			rows.push(warmup);
			await safeTerminate(sessionManager, warmup.sessionId);
			const readyStatus = await waitForPoolReady(pool);
			memorySamples.push({ pair, at: "after-warmup", status: readyStatus, samples: idlePoolRssSamples(pool) });

			const on = await measureCreate({ sessionManager, projectId: harness.projectId, cwd, arm: "on", pair, phase: "measured", pool });
			rows.push(on);
			await safeTerminate(sessionManager, on.sessionId);
			await waitForPoolIdle(pool);
		}
	} finally {
		try { await harness.gw.shutdown(); } catch (err) { shutdownError = err instanceof Error ? err.message : String(err); }
		try { fs.rmSync(harness.bobbitDir, { recursive: true, force: true }); } catch {}
	}

	const measuredOff = rows.filter(r => r.arm === "off" && r.phase === "measured");
	const measuredOn = rows.filter(r => r.arm === "on" && r.phase === "measured");
	const warmups = rows.filter(r => r.arm === "on" && r.phase === "warmup");
	const offByPair = new Map(measuredOff.map(r => [r.pair, r]));
	const paired = measuredOn.map(on => {
		const off = offByPair.get(on.pair);
		return {
			pair: on.pair,
			offMs: off?.latencyMs ?? null,
			onMs: on.latencyMs,
			reductionMs: off ? off.latencyMs - on.latencyMs : null,
			reductionPct: off ? (off.latencyMs - on.latencyMs) / off.latencyMs : null,
			onPoolHit: on.poolDelta.hits > 0,
		};
	});
	const onHits = measuredOn.filter(r => r.poolDelta.hits > 0).length;
	const onMisses = measuredOn.filter(r => r.poolDelta.misses > 0).length;
	const warmupMisses = warmups.filter(r => r.poolDelta.misses > 0).length;
	const rssMiB = memorySamples.flatMap(s => s.samples.map(x => x.rssMiB).filter(x => typeof x === "number"));
	const memory = rssMiB.length > 0
		? { measurable: true, samples: rssMiB.length, medianIdleRssMiB: median(rssMiB), p90IdleRssMiB: p90(rssMiB), maxIdleRssMiB: Math.max(...rssMiB) }
		: { measurable: false, reason: "No child process RSS samples were available from idle pool entries." };

	const offSummary = summarize(measuredOff.map(r => r.latencyMs));
	const onSummary = summarize(measuredOn.map(r => r.latencyMs));
	const pairedReductionPct = paired.map(p => p.reductionPct).filter(x => typeof x === "number");
	const summary = {
		experimentId: "EXP-003",
		generatedAt,
		commit,
		preregistrationCommit: preregCommit,
		command: "node scripts/exp-warm-pool-report.mjs",
		pairs: PAIRS,
		arms: { off: offSummary, on: onSummary },
		pool: {
			measuredOnHits: onHits,
			measuredOnMisses: onMisses,
			measuredOnHitRate: onHits / measuredOn.length,
			warmupMisses,
		},
		paired: {
			medianReductionPct: median(pairedReductionPct),
			medianReductionMs: median(paired.map(p => p.reductionMs).filter(x => typeof x === "number")),
			p90RegressionPct: (onSummary.p90Ms - offSummary.p90Ms) / offSummary.p90Ms,
			rows: paired,
		},
		memory,
		shutdownError: shutdownError ?? null,
		notes,
	};

	let recommendation = "inconclusive";
	if (
		measuredOff.length >= 10 &&
		measuredOn.length >= 10 &&
		summary.pool.measuredOnHitRate >= 0.8 &&
		summary.paired.medianReductionPct >= 0.2 &&
		summary.paired.p90RegressionPct <= 0.1 &&
		(!memory.measurable || memory.maxIdleRssMiB < 200)
	) {
		recommendation = "recommend-default-on-follow-up";
	} else if (
		measuredOff.length >= 10 &&
		measuredOn.length >= 10 &&
		(onSummary.medianMs > offSummary.medianMs || summary.pool.measuredOnHitRate < 0.5 || (memory.measurable && memory.maxIdleRssMiB > 300))
	) {
		recommendation = "keep-dark";
	}
	summary.recommendation = recommendation;

	fs.writeFileSync(OUT_JSON, `${JSON.stringify({ summary, rows, memorySamples }, null, 2)}\n`);
	const md = `# EXP-003 Warm Pool Spawn Latency Results

Generated: ${generatedAt} (UTC)

Command: \`node scripts/exp-warm-pool-report.mjs\`

Commit: \`${commit}\`
Pre-registration commit: \`${preregCommit}\`

Recommendation: \`${recommendation}\`

| Metric | off | on |
|---|---:|---:|
| Measured spawns | ${offSummary.n} | ${onSummary.n} |
| Median latency | ${fmtMs(offSummary.medianMs)} | ${fmtMs(onSummary.medianMs)} |
| Mean latency | ${fmtMs(offSummary.meanMs)} | ${fmtMs(onSummary.meanMs)} |
| p90 latency | ${fmtMs(offSummary.p90Ms)} | ${fmtMs(onSummary.p90Ms)} |
| Min latency | ${fmtMs(offSummary.minMs)} | ${fmtMs(onSummary.minMs)} |
| Max latency | ${fmtMs(offSummary.maxMs)} | ${fmtMs(onSummary.maxMs)} |

| Pool metric | Value |
|---|---:|
| Measured on-arm hits | ${onHits} |
| Measured on-arm misses | ${onMisses} |
| Measured on-arm hit rate | ${pct(summary.pool.measuredOnHitRate)} |
| Warm-up misses | ${warmupMisses} |

| Paired effect | Value |
|---|---:|
| Median paired reduction | ${pct(summary.paired.medianReductionPct)} |
| Median paired reduction | ${fmtMs(summary.paired.medianReductionMs)} |
| p90 regression vs off | ${pct(summary.paired.p90RegressionPct)} |

| Memory | Value |
|---|---:|
| Measurable | ${memory.measurable ? "yes" : "no"} |
| Median idle RSS per ready process | ${memory.measurable ? `${memory.medianIdleRssMiB.toFixed(1)} MiB` : "n/a"} |
| p90 idle RSS per ready process | ${memory.measurable ? `${memory.p90IdleRssMiB.toFixed(1)} MiB` : "n/a"} |
| Max idle RSS per ready process | ${memory.measurable ? `${memory.maxIdleRssMiB.toFixed(1)} MiB` : "n/a"} |

Notes:

${notes.map(n => `- ${n}`).join("\n")}
`;
	fs.writeFileSync(OUT_MD, md);
	console.log(md);
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});

