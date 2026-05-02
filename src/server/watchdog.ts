#!/usr/bin/env node

/**
 * Dev harness watchdog — a separate process that monitors the dev harness
 * and restarts it if it becomes unresponsive.
 *
 * Runs independently from the harness itself for resilience: if the harness
 * crashes hard (e.g. segfault, OOM, stuck event loop), the watchdog detects
 * the port going down and relaunches the entire harness.
 *
 * Health check: probes the gateway HTTPS port. If N consecutive checks fail,
 * the harness process tree is killed and restarted.
 *
 * Usage:
 *   node dist/server/watchdog.js [-- ...args forwarded to harness/cli]
 *   npm run dev:watchdog [-- -- ...args]
 *
 * The watchdog itself is a lightweight loop with no dependencies on the
 * gateway code beyond port detection and pi-dir resolution.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bobbitStateDir } from "./bobbit-dir.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const HARNESS_PATH = path.join(__dirname, "harness.js");

/** Watchdog state file — records harness PID and last healthy timestamp */
const STATE_FILE = path.join(bobbitStateDir(), "watchdog.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Extra CLI args forwarded to the harness (everything after `--`) */
const forwardedArgs = (() => {
	const argv = process.argv.slice(2);
	const sep = argv.indexOf("--");
	return sep >= 0 ? argv.slice(sep + 1) : argv;
})();

/** Detect a CLI flag value from forwarded args */
function detectFlag(flag: string): string | undefined {
	const idx = forwardedArgs.indexOf(flag);
	if (idx >= 0 && forwardedArgs[idx + 1]) {
		return forwardedArgs[idx + 1];
	}
	return undefined;
}

/** Detect the port from forwarded args, defaulting to 3001 */
function detectPort(): number {
	const v = detectFlag("--port");
	return v ? parseInt(v, 10) : 3001;
}

/**
 * Detect the host to probe.
 *
 * The server binds to the address given via --host (or auto-detected NordLynx IP).
 * The watchdog must probe that same address — probing 127.0.0.1 fails when the
 * server is bound to a non-loopback interface.
 *
 * Strategy:
 *  1. Use --host from forwarded args if present
 *  2. Read .bobbit/state/gateway-url written by the CLI on startup
 *  3. Fall back to 127.0.0.1
 */
function detectHost(): string {
	// 1. Explicit --host in forwarded args
	const explicit = detectFlag("--host");
	if (explicit) return explicit;

	// 2. Read persisted gateway URL
	try {
		const gwUrlFile = path.join(bobbitStateDir(), "gateway-url");
		const raw = fs.readFileSync(gwUrlFile, "utf-8").trim();
		const parsed = new URL(raw);
		return parsed.hostname;
	} catch {
		// File doesn't exist yet or is unparseable — expected on first launch
	}

	// 3. Fallback
	return "127.0.0.1";
}

const PORT = detectPort();
/** Cached probe host — re-resolved from gateway-url after each harness launch */
let probeHost = detectHost();

/** How often to probe the server (ms) */
const PROBE_INTERVAL_MS = 10_000;

/** Probe timeout — how long to wait for a response (ms) */
const PROBE_TIMEOUT_MS = 5_000;

/** How many consecutive failed probes before restarting */
const FAILURE_THRESHOLD = 3;

/** Grace period after launching harness before probing starts (ms) */
const STARTUP_GRACE_MS = 120_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let harnessChild: ChildProcess | null = null;
let consecutiveFailures = 0;
let isRestarting = false;
let lastLaunchTime = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

function probeHealth(): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, PROBE_TIMEOUT_MS);

		const req = https.request(
			{
				hostname: probeHost,
				port: PORT,
				path: "/api/health",
				method: "GET",
				rejectUnauthorized: false, // self-signed cert
				timeout: PROBE_TIMEOUT_MS,
			},
			(res) => {
				clearTimeout(timer);
				// Any response (even 401/404) means the server is alive
				resolve(true);
				res.resume(); // drain
			},
		);

		req.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});

		req.on("timeout", () => {
			clearTimeout(timer);
			req.destroy();
			resolve(false);
		});

		req.end();
	});
}

// ---------------------------------------------------------------------------
// Harness process management
// ---------------------------------------------------------------------------

function launchHarness(): void {
	console.log(`\n[watchdog] Launching harness (port ${PORT})...`);

	// Use process.execPath (absolute path to the same node running this
	// process) rather than bare "node" — prevents `spawn node ENOENT`
	// when PATH is sanitised by an outer launcher.
	harnessChild = spawn(process.execPath, [HARNESS_PATH, ...forwardedArgs], {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		env: { ...process.env },
	});

	lastLaunchTime = Date.now();
	consecutiveFailures = 0;

	// Re-resolve probe host after the server has time to write gateway-url
	setTimeout(() => {
		const newHost = detectHost();
		if (newHost !== probeHost) {
			console.log(`[watchdog] Probe host updated: ${probeHost} → ${newHost}`);
			probeHost = newHost;
		}
	}, STARTUP_GRACE_MS + 2000);

	harnessChild.on("exit", (code, signal) => {
		const reason = signal ? `signal ${signal}` : `code ${code}`;
		console.log(`[watchdog] Harness exited (${reason})`);
		harnessChild = null;

		if (!shuttingDown && !isRestarting) {
			console.log("[watchdog] Harness died unexpectedly — restarting in 3s...");
			setTimeout(() => {
				if (!shuttingDown) launchHarness();
			}, 3000);
		}
	});

	writeState();
}

function killHarness(): Promise<void> {
	if (!harnessChild) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			console.log("[watchdog] Force-killing harness...");
			harnessChild?.kill("SIGKILL");
			resolve();
		}, 8000);

		harnessChild!.on("exit", () => {
			clearTimeout(timeout);
			harnessChild = null;
			resolve();
		});

		if (process.platform === "win32") {
			try {
				execSync(`taskkill /pid ${harnessChild!.pid} /T /F`, {
					stdio: "ignore",
					shell: true as unknown as string,
				});
			} catch {
				harnessChild?.kill("SIGKILL");
			}
		} else {
			harnessChild!.kill("SIGTERM");
		}
	});
}

// ---------------------------------------------------------------------------
// Restart cycle
// ---------------------------------------------------------------------------

async function restartHarness(): Promise<void> {
	if (isRestarting || shuttingDown) return;
	isRestarting = true;

	try {
		console.log("\n[watchdog] ======== HARNESS RESTART ========");

		await killHarness();

		// Brief pause to let ports clear
		await new Promise((r) => setTimeout(r, 2000));

		launchHarness();
	} catch (err) {
		console.error("[watchdog] Restart failed:", err);
		// Try launching anyway
		launchHarness();
	} finally {
		isRestarting = false;
	}
}

// ---------------------------------------------------------------------------
// State file (for external observability)
// ---------------------------------------------------------------------------

function writeState(): void {
	try {
		const state = {
			watchdogPid: process.pid,
			harnessPid: harnessChild?.pid ?? null,
			port: PORT,
			lastLaunch: new Date(lastLaunchTime).toISOString(),
			consecutiveFailures,
		};
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
	} catch {
		// Non-critical — don't crash the watchdog over state persistence
	}
}

// ---------------------------------------------------------------------------
// Probe loop
// ---------------------------------------------------------------------------

async function probeLoop(): Promise<void> {
	if (shuttingDown) return;

	// Skip probing during startup grace period
	const elapsed = Date.now() - lastLaunchTime;
	if (elapsed < STARTUP_GRACE_MS) {
		const remaining = Math.ceil((STARTUP_GRACE_MS - elapsed) / 1000);
		// Only log occasionally to reduce noise
		if (remaining % 10 === 0) {
			console.log(`[watchdog] Startup grace: ${remaining}s remaining`);
		}
		scheduleNextProbe();
		return;
	}

	const healthy = await probeHealth();

	if (healthy) {
		if (consecutiveFailures > 0) {
			console.log(`[watchdog] Server recovered after ${consecutiveFailures} failed probe(s)`);
		}
		consecutiveFailures = 0;
	} else {
		consecutiveFailures++;
		console.log(
			`[watchdog] Probe failed (${consecutiveFailures}/${FAILURE_THRESHOLD})`,
		);

		if (consecutiveFailures >= FAILURE_THRESHOLD) {
			console.log(
				`[watchdog] ${FAILURE_THRESHOLD} consecutive failures — restarting harness`,
			);
			await restartHarness();
		}
	}

	writeState();
	scheduleNextProbe();
}

function scheduleNextProbe(): void {
	if (!shuttingDown) {
		setTimeout(probeLoop, PROBE_INTERVAL_MS);
	}
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;

	console.log("\n[watchdog] Shutting down...");
	await killHarness();

	// Clean up state file
	try {
		fs.unlinkSync(STATE_FILE);
	} catch { /* ignore */ }

	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[watchdog] Dev harness watchdog starting");
console.log(`[watchdog] Probe host:        ${probeHost}`);
console.log(`[watchdog] Port:              ${PORT}`);
console.log(`[watchdog] Probe interval:    ${PROBE_INTERVAL_MS / 1000}s`);
console.log(`[watchdog] Failure threshold: ${FAILURE_THRESHOLD} consecutive failures`);
console.log(`[watchdog] Startup grace:     ${STARTUP_GRACE_MS / 1000}s`);

launchHarness();
scheduleNextProbe();
