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
 * gateway code beyond port detection, path resolution, and dependency validation.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { bobbitStateDir } from "./bobbit-dir.js";
import { validateDependencies, type DependencyValidationResult } from "./harness-deps.js";

export type WatchdogRecoveryDecision =
	| { action: "none"; previousFailures?: number }
	| { action: "preserve-live-harness"; validation: Exclude<DependencyValidationResult, { ok: true }> }
	| { action: "restart-live-harness" }
	| { action: "wait-for-dependencies"; validation: Exclude<DependencyValidationResult, { ok: true }> }
	| { action: "launch-dead-harness" };

export interface WatchdogRecoveryPolicyOptions {
	failureThreshold: number;
	validate: () => DependencyValidationResult;
}

export interface WatchdogRecoveryActions {
	preserveLiveHarness: (validation: Exclude<DependencyValidationResult, { ok: true }>) => void | Promise<void>;
	restartLiveHarness: () => void | Promise<void>;
	waitForDependencies: (validation: Exclude<DependencyValidationResult, { ok: true }>) => void | Promise<void>;
	launchDeadHarness: () => void | Promise<void>;
}

export async function applyWatchdogRecoveryDecision(
	decision: WatchdogRecoveryDecision,
	actions: WatchdogRecoveryActions,
): Promise<void> {
	switch (decision.action) {
		case "preserve-live-harness":
			await actions.preserveLiveHarness(decision.validation);
			break;
		case "restart-live-harness":
			await actions.restartLiveHarness();
			break;
		case "wait-for-dependencies":
			await actions.waitForDependencies(decision.validation);
			break;
		case "launch-dead-harness":
			await actions.launchDeadHarness();
			break;
	}
}

const MANUAL_RECOVERY = "Stop Bobbit and the development stack, run `npm install` manually, then retry or restart.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Pure watchdog recovery policy. Process launches and timers stay with the
 * executable wiring below; tests can drive this state machine with an injected
 * read-only validator and no OS side effects.
 */
export class WatchdogRecoveryPolicy {
	private failures = 0;
	private waitingForDependencies = false;

	constructor(private readonly options: WatchdogRecoveryPolicyOptions) {
		if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
			throw new Error("failureThreshold must be a positive integer");
		}
	}

	get consecutiveFailures(): number {
		return this.failures;
	}

	get isWaitingForDependencies(): boolean {
		return this.waitingForDependencies;
	}

	recordHealthProbe(healthy: boolean): WatchdogRecoveryDecision {
		if (healthy) {
			const previousFailures = this.failures;
			this.failures = 0;
			this.waitingForDependencies = false;
			return previousFailures > 0 ? { action: "none", previousFailures } : { action: "none" };
		}

		this.failures++;
		if (this.failures < this.options.failureThreshold) return { action: "none" };

		// Reaching the threshold consumes the accumulated pressure regardless of
		// validation outcome. An invalid install must not immediately retrigger a
		// kill on the next health tick.
		this.failures = 0;
		const validation = this.validateSafely();
		if (!validation.ok) {
			return { action: "preserve-live-harness", validation };
		}
		return { action: "restart-live-harness" };
	}

	markHarnessExited(): void {
		this.failures = 0;
		this.waitingForDependencies = true;
	}

	markHarnessLaunched(): void {
		this.failures = 0;
		this.waitingForDependencies = false;
	}

	pollDeadHarness(): WatchdogRecoveryDecision {
		if (!this.waitingForDependencies) return { action: "none" };
		const validation = this.validateSafely();
		if (!validation.ok) return { action: "wait-for-dependencies", validation };
		this.waitingForDependencies = false;
		return { action: "launch-dead-harness" };
	}

	private validateSafely(): DependencyValidationResult {
		try {
			return this.options.validate();
		} catch (error) {
			return {
				ok: false,
				message: `Dependency validation failed: ${errorMessage(error)}. ${MANUAL_RECOVERY}`,
			};
		}
	}
}

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

/** Delay before checking whether an unexpectedly exited harness can relaunch. */
const UNEXPECTED_EXIT_RETRY_DELAY_MS = 3_000;

/** Bounded polling cadence while manual dependency repair is required. */
const DEPENDENCY_RECHECK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let harnessChild: ChildProcess | null = null;
let isRestarting = false;
let lastLaunchTime = 0;
let shuttingDown = false;
let dependencyRecheckTimer: ReturnType<typeof setTimeout> | null = null;

const recoveryPolicy = new WatchdogRecoveryPolicy({
	failureThreshold: FAILURE_THRESHOLD,
	validate: () => validateDependencies(PROJECT_ROOT),
});

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

	if (dependencyRecheckTimer) {
		clearTimeout(dependencyRecheckTimer);
		dependencyRecheckTimer = null;
	}

	const child = spawn(process.execPath, [HARNESS_PATH, ...forwardedArgs], {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		env: { ...process.env },
	});
	harnessChild = child;
	recoveryPolicy.markHarnessLaunched();
	lastLaunchTime = Date.now();

	// Re-resolve probe host after the server has time to write gateway-url
	setTimeout(() => {
		const newHost = detectHost();
		if (newHost !== probeHost) {
			console.log(`[watchdog] Probe host updated: ${probeHost} → ${newHost}`);
			probeHost = newHost;
		}
	}, STARTUP_GRACE_MS + 2000);

	child.on("exit", (code, signal) => {
		const reason = signal ? `signal ${signal}` : `code ${code}`;
		console.log(`[watchdog] Harness exited (${reason})`);

		// A timed-out kill can finish after a replacement has launched. Never let
		// that stale exit clear or schedule recovery for the current child.
		if (harnessChild !== child) return;
		harnessChild = null;

		if (!shuttingDown && !isRestarting) {
			recoveryPolicy.markHarnessExited();
			console.log("[watchdog] Harness died unexpectedly — validating before relaunch...");
			scheduleDeadHarnessRecovery(UNEXPECTED_EXIT_RETRY_DELAY_MS);
		}
	});

	writeState();
}

function describeValidationFailure(result: Exclude<DependencyValidationResult, { ok: true }>): string {
	return [result.message, ...(result.diagnostics ?? [])].join("\n");
}

function scheduleDeadHarnessRecovery(delayMs = DEPENDENCY_RECHECK_INTERVAL_MS): void {
	if (dependencyRecheckTimer || shuttingDown || harnessChild) return;
	dependencyRecheckTimer = setTimeout(async () => {
		dependencyRecheckTimer = null;
		if (shuttingDown || harnessChild) return;

		try {
			const decision = recoveryPolicy.pollDeadHarness();
			await applyWatchdogRecoveryDecision(decision, recoveryActions);
		} catch (error) {
			console.error("[watchdog] Dead-harness recovery failed:", error);
			if (!harnessChild && !shuttingDown) {
				recoveryPolicy.markHarnessExited();
				scheduleDeadHarnessRecovery(UNEXPECTED_EXIT_RETRY_DELAY_MS);
			}
		} finally {
			writeState();
		}
	}, delayMs);
}

function killHarness(): Promise<void> {
	const child = harnessChild;
	if (!child) return Promise.resolve();

	return new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			console.log("[watchdog] Force-killing harness...");
			child.kill("SIGKILL");
			resolve();
		}, 8000);

		child.on("exit", () => {
			clearTimeout(timeout);
			if (harnessChild === child) harnessChild = null;
			resolve();
		});

		if (process.platform === "win32") {
			try {
				execSync(`taskkill /pid ${child.pid} /T /F`, {
					stdio: "ignore",
					shell: true as unknown as string,
				});
			} catch {
				child.kill("SIGKILL");
			}
		} else {
			child.kill("SIGTERM");
		}
	});
}

// ---------------------------------------------------------------------------
// Restart cycle
// ---------------------------------------------------------------------------

async function restartHarnessAfterValidation(): Promise<void> {
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
		if (!harnessChild && !shuttingDown) {
			recoveryPolicy.markHarnessExited();
			scheduleDeadHarnessRecovery(UNEXPECTED_EXIT_RETRY_DELAY_MS);
		}
	} finally {
		isRestarting = false;
	}
}

const recoveryActions: WatchdogRecoveryActions = {
	preserveLiveHarness: (validation) => {
		console.error(`[watchdog] ${describeValidationFailure(validation)}`);
		console.log("[watchdog] Dependency validation failed; leaving the live harness and sentinel watcher untouched.");
	},
	restartLiveHarness: restartHarnessAfterValidation,
	waitForDependencies: (validation) => {
		console.error(`[watchdog] ${describeValidationFailure(validation)}`);
		console.log(`[watchdog] Harness remains stopped; dependencies will be checked again in ${DEPENDENCY_RECHECK_INTERVAL_MS / 1000}s.`);
		scheduleDeadHarnessRecovery();
	},
	launchDeadHarness: launchHarness,
};

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
			consecutiveFailures: recoveryPolicy.consecutiveFailures,
			waitingForDependencies: recoveryPolicy.isWaitingForDependencies,
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

	if (!harnessChild) {
		recoveryPolicy.markHarnessExited();
		scheduleDeadHarnessRecovery(0);
		writeState();
		scheduleNextProbe();
		return;
	}

	const healthy = await probeHealth();
	if (!harnessChild) {
		recoveryPolicy.markHarnessExited();
		scheduleDeadHarnessRecovery(0);
		writeState();
		scheduleNextProbe();
		return;
	}

	const priorFailures = recoveryPolicy.consecutiveFailures;
	const decision = recoveryPolicy.recordHealthProbe(healthy);

	if (healthy) {
		if (decision.action === "none" && decision.previousFailures) {
			console.log(`[watchdog] Server recovered after ${decision.previousFailures} failed probe(s)`);
		}
	} else {
		console.log(
			`[watchdog] Probe failed (${priorFailures + 1}/${FAILURE_THRESHOLD})`,
		);
		if (decision.action === "restart-live-harness") {
			console.log(
				`[watchdog] ${FAILURE_THRESHOLD} consecutive failures with healthy dependencies — restarting harness`,
			);
		}
		await applyWatchdogRecoveryDecision(decision, recoveryActions);
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
	if (dependencyRecheckTimer) {
		clearTimeout(dependencyRecheckTimer);
		dependencyRecheckTimer = null;
	}

	console.log("\n[watchdog] Shutting down...");
	await killHarness();

	// Clean up state file
	try {
		fs.unlinkSync(STATE_FILE);
	} catch { /* ignore */ }

	process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	console.log("[watchdog] Dev harness watchdog starting");
	console.log(`[watchdog] Probe host:        ${probeHost}`);
	console.log(`[watchdog] Port:              ${PORT}`);
	console.log(`[watchdog] Probe interval:    ${PROBE_INTERVAL_MS / 1000}s`);
	console.log(`[watchdog] Failure threshold: ${FAILURE_THRESHOLD} consecutive failures`);
	console.log(`[watchdog] Startup grace:     ${STARTUP_GRACE_MS / 1000}s`);

	launchHarness();
	scheduleNextProbe();
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
	main();
}
