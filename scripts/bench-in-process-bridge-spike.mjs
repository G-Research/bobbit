#!/usr/bin/env node
/**
 * Spike benchmark for docs/design/in-process-bridge-spike.md.
 *
 * Measures, N=10 each, against the REAL pi-coding-agent binary (no mock):
 *   1. spawn-to-ready: child-process `--mode rpc` spawn -> first `get_state`
 *      response, vs. warm in-process `createAgentSession()` construction.
 *   2. steady-state round trip: repeated `get_state` over the RPC child's
 *      stdio, vs. in-process `session.state` property access.
 *
 * Neither measurement calls a real model (get_state/construction never hit
 * the network), so this runs with no API keys and no Docker — same
 * methodology the prior verification pass in
 * ~/Documents/dev/bobbit-fable-refactor/raw/analysis-in-process-vs-out.md
 * used (measured via `get_state`, not a real completion).
 *
 * Usage: node scripts/bench-in-process-bridge-spike.mjs
 * (run from the repo root so node_modules/@earendil-works/pi-coding-agent
 * resolves, and so the CLI path below is correct)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
	createAgentSession,
	createReadOnlyTools,
	AuthStorage,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const N = 10;
const cliPath = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

function median(times) {
	const sorted = [...times].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

// --- 1a. child-process spawn -> first get_state response ---
function childSpawnToReady() {
	return new Promise((resolve, reject) => {
		const t0 = performance.now();
		const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-approve", "--no-context-files", "--no-builtin-tools"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
		});
		let buf = "";
		let settled = false;
		child.stdout.on("data", (chunk) => {
			if (settled) return;
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (msg.type === "response" && msg.command === "get_state") {
					settled = true;
					resolve(performance.now() - t0);
					child.kill("SIGKILL");
					return;
				}
			}
		});
		child.on("error", reject);
		child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
		setTimeout(() => { if (!settled) { child.kill("SIGKILL"); reject(new Error("spawn timeout")); } }, 5000);
	});
}

// --- 1b. warm in-process AgentSession construction ---
async function inProcessConstruct() {
	const t0 = performance.now();
	const authStorage = AuthStorage.inMemory({});
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const sessionManager = SessionManager.inMemory();
	const cwd = process.cwd();
	const { session } = await createAgentSession({
		cwd, authStorage, modelRegistry, sessionManager,
		noTools: "all", customTools: createReadOnlyTools(cwd),
	});
	const ms = performance.now() - t0;
	session.dispose();
	return ms;
}

// --- 2. steady-state round trip on an already-running child ---
function childSteadyState() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-approve", "--no-context-files", "--no-builtin-tools"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
		});
		let buf = "", ready = false, pendingT0 = null, count = 0;
		const times = [];
		function sendNext() {
			pendingT0 = performance.now();
			child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
		}
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try { msg = JSON.parse(line); } catch { continue; }
				if (!ready) { ready = true; sendNext(); continue; }
				if (msg.type === "response" && msg.command === "get_state") {
					times.push(performance.now() - pendingT0);
					count++;
					if (count >= N) { child.kill("SIGKILL"); resolve(times); return; }
					sendNext();
				}
			}
		});
		child.on("error", reject);
		child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
		setTimeout(() => { if (count < N) { child.kill("SIGKILL"); reject(new Error(`steady-state timeout after ${count}`)); } }, 8000);
	});
}

async function main() {
	console.log(`=== spawn-to-ready (N=${N}) ===`);
	const childTimes = [];
	for (let i = 0; i < N; i++) childTimes.push(await childSpawnToReady());
	console.log("child-process (ms):", childTimes.map(t => t.toFixed(1)));
	console.log("child-process median (ms):", median(childTimes).toFixed(1));

	const inprocTimes = [];
	for (let i = 0; i < N; i++) inprocTimes.push(await inProcessConstruct());
	console.log("in-process, incl. first-call module load (ms):", inprocTimes.map(t => t.toFixed(2)));
	console.log("in-process median (ms):", median(inprocTimes).toFixed(2));
	console.log("in-process warm (runs 2..N) mean (ms):", (inprocTimes.slice(1).reduce((a, b) => a + b, 0) / (N - 1)).toFixed(2));

	console.log(`\n=== steady-state get_state round trip (N=${N}) ===`);
	const steadyTimes = await childSteadyState();
	console.log("child-process RPC round trip (ms):", steadyTimes.map(t => t.toFixed(3)));
	console.log("child-process median (ms):", median(steadyTimes).toFixed(3));

	const authStorage = AuthStorage.inMemory({});
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const sessionManager = SessionManager.inMemory();
	const cwd = process.cwd();
	const { session } = await createAgentSession({ cwd, authStorage, modelRegistry, sessionManager, noTools: "all", customTools: createReadOnlyTools(cwd) });
	const inprocStateTimes = [];
	for (let i = 0; i < N; i++) {
		const t0 = performance.now();
		void session.state.model;
		void session.messages;
		inprocStateTimes.push(performance.now() - t0);
	}
	console.log("in-process state-read (ms):", inprocStateTimes.map(t => t.toFixed(4)));
	console.log("in-process median (ms):", median(inprocStateTimes).toFixed(4));
	session.dispose();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
