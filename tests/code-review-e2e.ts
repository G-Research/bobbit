/**
 * E2E test for the code review workflow.
 * 
 * Usage: npx tsx tests/code-review-e2e.ts [--runs N] [--verbose]
 */

import https from "node:https";
import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GATEWAY_HOST = process.env.GATEWAY_HOST || "localhost";
const GATEWAY_PORT = 3001;
const AUTH_TOKEN = fs.readFileSync(path.join(process.cwd(), ".bobbit", "state", "token"), "utf-8").trim();
const BASE_URL = `https://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const WS_BASE = `wss://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const REPO_PATH = process.cwd();
const STATE_DIR = path.join(os.homedir(), ".pi", "workflow-state");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose") || args.includes("-v");
const runsIdx = args.indexOf("--runs");
const NUM_RUNS = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 1;
const branchIdx = args.indexOf("--branch");
const FEATURE_BRANCH = branchIdx >= 0 ? args[branchIdx + 1] : "test/realistic-change";
const baseIdx = args.indexOf("--base");
const BASE_BRANCH = baseIdx >= 0 ? args[baseIdx + 1] : "master";

interface PhaseInfo { name: string; durationMs: number }
interface RunResult {
	runNumber: number;
	totalMs: number;
	phases: PhaseInfo[];
	status: "completed" | "failed" | "timeout";
	error?: string;
	workflowState?: any;
}

function log(...a: any[]) {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}]`, ...a);
}
function vlog(...a: any[]) { if (VERBOSE) log(...a); }

async function apiRequest(method: string, urlPath: string, body?: any): Promise<any> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlPath, BASE_URL);
		const req = https.request({
			method, hostname: url.hostname, port: url.port, path: url.pathname,
			headers: { "Authorization": `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" },
			rejectUnauthorized: false,
		}, (res) => {
			let data = "";
			res.on("data", (c: Buffer) => data += c);
			res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
		});
		req.on("error", reject);
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}

function connectWS(sessionId: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`, { rejectUnauthorized: false });
		ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token: AUTH_TOKEN })); });
		const h = (data: Buffer) => {
			const msg = JSON.parse(data.toString());
			if (msg.type === "auth_ok") { ws.removeListener("message", h); resolve(ws); }
			else if (msg.type === "auth_failed") { reject(new Error("Auth failed")); }
		};
		ws.on("message", h);
		ws.on("error", reject);
	});
}

/** Read workflow state from the state file (written by the extension) */
function readWorkflowState(sessionId: string): any | null {
	// The extension uses the agent session directory name, not the gateway session ID.
	// Try scanning for files that might match this session
	try {
		const files = fs.readdirSync(STATE_DIR);
		for (const f of files) {
			const fp = path.join(STATE_DIR, f);
			try {
				const state = JSON.parse(fs.readFileSync(fp, "utf-8"));
				if (state.workflowId === "code-review") {
					// Check if this was created recently (within the last 10 min)
					if (state.startedAt > Date.now() - 600_000) {
						return state;
					}
				}
			} catch { /* skip */ }
		}
	} catch { /* no state dir */ }
	return null;
}

/** Get phase timings from workflow state */
function getPhaseTimings(state: any): PhaseInfo[] {
	const timings: PhaseInfo[] = [];
	if (!state?.phaseHistory) return timings;
	for (const ph of state.phaseHistory) {
		if (ph.status === "completed" && ph.completedAt && ph.startedAt) {
			timings.push({ name: ph.phaseId, durationMs: ph.completedAt - ph.startedAt });
		}
	}
	return timings;
}

async function runCodeReview(runNumber: number): Promise<RunResult> {
	const startTime = Date.now();

	log(`\n========== Run ${runNumber} ==========`);

	// Clean up any recent workflow state files to avoid confusion
	try {
		const files = fs.readdirSync(STATE_DIR);
		for (const f of files) {
			const fp = path.join(STATE_DIR, f);
			try {
				const state = JSON.parse(fs.readFileSync(fp, "utf-8"));
				if (state.workflowId === "code-review" && state.startedAt > Date.now() - 60_000) {
					fs.unlinkSync(fp);
				}
			} catch { /* skip */ }
		}
	} catch { /* no state dir */ }

	const session = await apiRequest("POST", "/api/sessions", { cwd: REPO_PATH });
	const sessionId = session.id;
	log(`Session: ${sessionId}`);

	const ws = await connectWS(sessionId);
	log("Connected");

	return new Promise<RunResult>((resolve) => {
		const TIMEOUT_MS = 10 * 60 * 1000;
		let resolved = false;
		let agentTurns = 0;

		const finish = (status: RunResult["status"], error?: string, wfState?: any) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timeout);
			ws.close();
			const totalMs = Date.now() - startTime;
			const phases = wfState ? getPhaseTimings(wfState) : [];
			log(`${status.toUpperCase()} in ${(totalMs / 1000).toFixed(1)}s`);
			for (const p of phases) {
				log(`  ${p.name}: ${(p.durationMs / 1000).toFixed(1)}s`);
			}
			resolve({ runNumber, totalMs, phases, status, error, workflowState: wfState });
		};

		const timeout = setTimeout(() => {
			finish("timeout", `Timed out`);
		}, TIMEOUT_MS);

		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString());

			// Verbose tool tracking
			if (msg.type === "event" && msg.data?.type === "tool_execution_start") {
				vlog(`  Tool: ${msg.data.toolName || ""}`);
			}
			if (msg.type === "event" && msg.data?.type === "tool_execution_update") {
				const details = msg.data.details;
				if (details?.delegates) {
					const summary = details.delegates.map((d: any) => `${d.name}:${d.status}`).join(", ");
					log(`  Delegates: ${summary}`);
				}
			}

			// Detect workflow completion via WS
			if (msg.type === "workflow_completed" || (msg.type === "workflow_state" && msg.data?.status === "completed")) {
				const wfState = msg.data || readWorkflowState(sessionId);
				finish("completed", undefined, wfState);
				return;
			}

			// Detect agent_end — check workflow state file
			if (msg.type === "event" && msg.data?.type === "agent_end") {
				agentTurns++;
				log(`  Agent turn ${agentTurns} ended`);

				// Check workflow state file 
				setTimeout(() => {
					const wfState = readWorkflowState(sessionId);
					if (wfState) {
						if (wfState.status === "completed") {
							// Calculate total from workflow state (more accurate)
							const wfTotal = (wfState.completedAt || Date.now()) - wfState.startedAt;
							log(`  Workflow completed (state file). Workflow time: ${(wfTotal / 1000).toFixed(1)}s`);
							finish("completed", undefined, wfState);
						} else if (wfState.status === "failed") {
							finish("failed", wfState.context?.failure_reason, wfState);
						} else {
							log(`  Workflow status: ${wfState.status}, phase: ${wfState.currentPhaseIndex}`);
						}
					} else {
						log(`  No workflow state found`);
					}
				}, 500);
			}
		});

		ws.on("close", () => {
			if (!resolved) finish("failed", "WebSocket closed");
		});

		const prompt = [
			`Run a code review of branch "${FEATURE_BRANCH}" against "${BASE_BRANCH}" in this repo (${REPO_PATH}).`,
			``,
			`Use the workflow tool. Start the code-review workflow and follow each phase's instructions exactly.`,
			`Be fast — use parallel tool calls where possible and skip unnecessary commentary.`,
		].join("\n");

		log("Prompt sent");
		ws.send(JSON.stringify({ type: "prompt", text: prompt }));
	});
}

async function main() {
	log(`Code Review E2E — ${NUM_RUNS} run(s), branch=${FEATURE_BRANCH} vs ${BASE_BRANCH}`);

	const results: RunResult[] = [];
	for (let i = 1; i <= NUM_RUNS; i++) {
		try {
			results.push(await runCodeReview(i));
		} catch (err: any) {
			log(`Run ${i} error: ${err.message}`);
			results.push({ runNumber: i, totalMs: 0, phases: [], status: "failed", error: err.message });
		}
	}

	// Summary
	log("\n========== SUMMARY ==========");
	const completed = results.filter(r => r.status === "completed");
	for (const r of results) {
		const icon = r.status === "completed" ? "OK" : "FAIL";
		log(`  [${icon}] Run ${r.runNumber}: ${(r.totalMs / 1000).toFixed(1)}s`);
		for (const p of r.phases) log(`       ${p.name}: ${(p.durationMs / 1000).toFixed(1)}s`);
	}
	if (completed.length > 0) {
		const avg = completed.reduce((s, r) => s + r.totalMs, 0) / completed.length;
		log(`\n  Average: ${(avg / 1000).toFixed(1)}s (target: 120s)`);
		log(`  ${avg <= 120000 ? "TARGET MET" : `${((avg - 120000) / 1000).toFixed(1)}s over target`}`);
	}

	// Save results
	const outputPath = path.resolve("tests", "code-review-results.json");
	let existing: any;
	try { existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")); } catch { existing = { iterations: [] }; }
	existing.iterations.push({
		timestamp: new Date().toISOString(),
		runs: results,
		averageMs: completed.length > 0 ? completed.reduce((s, r) => s + r.totalMs, 0) / completed.length : null,
	});
	fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2));

	// Generate progress report
	generateReport(existing);
}

function generateReport(data: any) {
	const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Code Review Workflow — Performance Report</title>
<style>
body { font-family: system-ui; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; }
h1 { color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
h2 { color: #c9d1d9; margin-top: 2rem; }
.target { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
.target .value { font-size: 2rem; font-weight: bold; }
.met { color: #3fb950; }
.over { color: #f85149; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-weight: 600; }
.bar { height: 20px; border-radius: 3px; min-width: 2px; }
.bar-ok { background: #238636; }
.bar-fail { background: #da3633; }
.bar-target { background: #f0883e; opacity: 0.5; position: absolute; height: 20px; border-left: 2px dashed #f0883e; }
.chart { position: relative; margin: 1rem 0; }
.iteration { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; }
.phase-bar { display: inline-block; height: 16px; border-radius: 2px; margin-right: 1px; vertical-align: middle; }
.legend { display: flex; gap: 1rem; flex-wrap: wrap; margin: 0.5rem 0; }
.legend-item { display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
.legend-dot { width: 12px; height: 12px; border-radius: 2px; }
</style></head><body>
<h1>Code Review Workflow — Performance Optimization</h1>
<div class="target">
<div>Target: Complete code review in under <strong>2 minutes</strong> (120s) avg over 5 runs</div>
${(() => {
	const last = data.iterations[data.iterations.length - 1];
	if (!last?.averageMs) return '<div class="value over">No completed runs yet</div>';
	const avg = last.averageMs / 1000;
	const met = avg <= 120;
	return `<div class="value ${met ? 'met' : 'over'}">${avg.toFixed(1)}s average ${met ? '✓ TARGET MET' : ''}</div>`;
})()}
</div>

<h2>Run History</h2>
<table>
<tr><th>Iteration</th><th>Time</th><th>Runs</th><th>Average</th><th>Status</th><th>Visual</th></tr>
${data.iterations.map((it: any, idx: number) => {
	const completed = it.runs.filter((r: any) => r.status === "completed");
	const avg = it.averageMs ? (it.averageMs / 1000).toFixed(1) : "—";
	const met = it.averageMs && it.averageMs <= 120000;
	const maxMs = Math.max(...it.runs.map((r: any) => r.totalMs), 300000);
	return `<tr>
		<td>#${idx + 1}</td>
		<td>${new Date(it.timestamp).toLocaleString()}</td>
		<td>${completed.length}/${it.runs.length}</td>
		<td class="${met ? 'met' : 'over'}">${avg}s</td>
		<td>${met ? '✓' : '—'}</td>
		<td style="width:40%"><div class="chart">
			${it.runs.map((r: any) => {
				const w = Math.max(2, (r.totalMs / maxMs) * 100);
				const cls = r.status === "completed" ? "bar-ok" : "bar-fail";
				return `<div class="bar ${cls}" style="width:${w}%" title="${(r.totalMs/1000).toFixed(1)}s"></div>`;
			}).join("")}
			<div class="bar-target" style="left:${(120000/maxMs)*100}%" title="120s target"></div>
		</div></td>
	</tr>`;
}).join("")}
</table>

<h2>Phase Breakdown (Latest)</h2>
${(() => {
	const last = data.iterations[data.iterations.length - 1];
	if (!last?.runs?.length) return '<p>No data</p>';
	const phaseColors: Record<string,string> = {
		'gather-diff': '#58a6ff',
		'review-parallel': '#bc8cff',
		'synthesise-findings': '#3fb950',
		'complete-review': '#f0883e',
	};
	return last.runs.map((r: any, i: number) => {
		if (r.phases.length === 0) return `<div class="iteration">Run ${r.runNumber}: ${r.status} (${(r.totalMs/1000).toFixed(1)}s) — no phase data</div>`;
		const total = r.phases.reduce((s: number, p: any) => s + p.durationMs, 0);
		return `<div class="iteration">
			<strong>Run ${r.runNumber}:</strong> ${(r.totalMs/1000).toFixed(1)}s total
			<div style="margin:0.5rem 0">
			${r.phases.map((p: any) => {
				const w = Math.max(3, (p.durationMs / Math.max(total, 1)) * 100);
				const color = phaseColors[p.name] || '#8b949e';
				return `<div class="phase-bar" style="width:${w}%;background:${color}" title="${p.name}: ${(p.durationMs/1000).toFixed(1)}s"></div>`;
			}).join("")}
			</div>
			<div class="legend">
			${r.phases.map((p: any) => {
				const color = phaseColors[p.name] || '#8b949e';
				return `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${p.name}: ${(p.durationMs/1000).toFixed(1)}s</span>`;
			}).join("")}
			</div>
		</div>`;
	}).join("");
})()}

<h2>Optimization Log</h2>
<div id="log">
${data.iterations.map((it: any, idx: number) => 
	`<div class="iteration"><strong>#${idx + 1}</strong> (${new Date(it.timestamp).toLocaleString()}): avg=${it.averageMs ? (it.averageMs/1000).toFixed(1)+'s' : 'N/A'}${it.notes ? ' — ' + it.notes : ''}</div>`
).join("")}
</div>
</body></html>`;

	const reportPath = path.resolve("tests", "code-review-progress.html");
	fs.writeFileSync(reportPath, html);
	log(`Report: ${reportPath}`);
}

main().catch(console.error);
