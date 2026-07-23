#!/usr/bin/env node

/**
 * Dev server harness.
 *
 * Wraps the gateway server as a child process and restarts it on demand.
 * Agents (or humans) trigger a restart by running `npm run restart-server`,
 * which touches a sentinel file that this harness watches.
 *
 * Lifecycle on restart signal:
 *   1. Kill the running server child process
 *   2. Wait for the port to become free
 *   3. Validate installed dependencies
 *   4. Rebuild server TypeScript
 *   5. Re-launch the server
 *
 * Usage:
 *   node dist/server/harness.js [-- ...args forwarded to cli.js]
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restartSentinelPath } from "./harness-signal.js";
import { runHarnessLifecycle, validateDependencies } from "./harness-deps.js";
import { windowsGatewayKillArgs } from "./harness-kill.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (two levels up from dist/server/) */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** The compiled CLI entry point we spawn as the child */
const CLI_PATH = path.join(__dirname, "cli.js");

/** Sentinel file — any write triggers a restart */
const SENTINEL = restartSentinelPath();

// Ensure the sentinel directory exists
const sentinelDir = path.dirname(SENTINEL);
if (!fs.existsSync(sentinelDir)) {
	fs.mkdirSync(sentinelDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Extra CLI args forwarded to the server (everything after `--`) */
const forwardedArgs = (() => {
	const argv = process.argv.slice(2);
	const sep = argv.indexOf("--");
	return sep >= 0 ? argv.slice(sep + 1) : argv;
})();

/** Detect the port from forwarded args, defaulting to 3001 (same as cli.ts) */
function detectPort(): number {
	const idx = forwardedArgs.indexOf("--port");
	if (idx >= 0 && forwardedArgs[idx + 1]) {
		return parseInt(forwardedArgs[idx + 1], 10);
	}
	return 3001;
}

const PORT = detectPort();
const PORT_WAIT_TIMEOUT_MS = 10_000;
const PORT_POLL_INTERVAL_MS = 250;
const BUILD_TIMEOUT_MS = 30_000;

/**
 * Crash-loop guard.
 *
 * If the gateway child crashes within HEALTHY_UPTIME_MS of launch, count it
 * as a "quick" crash. After CRASH_LOOP_THRESHOLD consecutive quick crashes,
 * stop auto-restarting and log a clear directive — without this, the
 * harness would relaunch the gateway every 1s forever, masking whatever
 * boot-time error is making the gateway crash and burning CPU.
 *
 * The counter resets to 0 in two cases:
 *   1. The child stays alive at least HEALTHY_UPTIME_MS after launch
 *      (`child.on("exit")` checks elapsed since `lastLaunchAt`).
 *   2. The user touches the restart sentinel (`npm run restart-server`),
 *      which is the explicit "I've fixed the underlying problem, please
 *      try again" signal.
 */
const HEALTHY_UPTIME_MS = 10_000;
const CRASH_LOOP_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null;
let restarting = false;

let consecutiveQuickCrashes = 0;
let lastLaunchAt = 0;
let crashLoopHalted = false;

function launchServer(): void {
	if (crashLoopHalted) {
		// Belt-and-braces — should never reach here while the flag is set.
		console.log("[harness] Auto-restart suppressed (crash loop). Run `npm run restart-server` to resume.");
		return;
	}
	console.log(`\n[harness] Launching server (port ${PORT})...`);
	lastLaunchAt = Date.now();
	child = spawn(process.execPath, [CLI_PATH, ...forwardedArgs], {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		env: { ...process.env, BOBBIT_DEV_HARNESS: "1" },
	});

	child.on("exit", (code, signal) => {
		const reason = signal ? `signal ${signal}` : `code ${code}`;
		const uptimeMs = Date.now() - lastLaunchAt;
		console.log(`[harness] Server exited (${reason}, uptime ${uptimeMs}ms)`);
		child = null;

		// If we didn't initiate this exit, restart automatically — but bound
		// the blast radius via the crash-loop guard. A child that lives
		// HEALTHY_UPTIME_MS or longer counts as healthy; anything shorter is
		// a "quick crash" and pushes us closer to the auto-restart cap.
		if (!restarting) {
			if (uptimeMs < HEALTHY_UPTIME_MS) {
				consecutiveQuickCrashes++;
			} else {
				consecutiveQuickCrashes = 0;
			}

			if (consecutiveQuickCrashes >= CRASH_LOOP_THRESHOLD) {
				crashLoopHalted = true;
				console.error(
					`[harness] Crash loop detected (${consecutiveQuickCrashes} quick crashes). ` +
					`Stopping auto-restart. Run \`npm run restart-server\` to resume after fixing the root cause.`,
				);
				return;
			}

			console.log("[harness] Unexpected exit — restarting in 1s...");
			setTimeout(() => {
				void applyLifecycle("crash-relaunch").catch((err) => {
					console.error("[harness] Automatic crash relaunch failed:", err);
				});
			}, 1000);
		}
	});
}

async function killServer(): Promise<void> {
	if (!child) return;

	return new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			console.log("[harness] Forcefully killing server...");
			child?.kill("SIGKILL");
			resolve();
		}, 5000);

		child!.on("exit", () => {
			clearTimeout(timeout);
			child = null;
			resolve();
		});

		// On Windows, SIGTERM doesn't work well — force-kill the gateway. We kill
		// ONLY the gateway PID (no `/T` tree-kill): `/T` would walk the child-process
		// tree and euthanize the detached `bash_bg` wrappers we want to survive the
		// restart. See harness-kill.ts for the full rationale.
		if (process.platform === "win32") {
			try {
				execSync(windowsGatewayKillArgs(child!.pid!).join(" "), { stdio: "ignore", shell: true as unknown as string });
			} catch {
				child?.kill("SIGKILL");
			}
		} else {
			child!.kill("SIGTERM");
		}
	});
}

// ---------------------------------------------------------------------------
// Port availability check
// ---------------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, "127.0.0.1");
	});
}

async function waitForPortFree(port: number): Promise<void> {
	const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isPortFree(port)) return;
		await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
	}
	throw new Error(`Port ${port} did not become free within ${PORT_WAIT_TIMEOUT_MS}ms`);
}

// ---------------------------------------------------------------------------
// Build and lifecycle policy
// ---------------------------------------------------------------------------

function buildServer(): void {
	console.log("[harness] Building server...");
	try {
		execSync("npm run build:server", {
			cwd: PROJECT_ROOT,
			stdio: "inherit",
			timeout: BUILD_TIMEOUT_MS,
			shell: true as unknown as string,
		});
		console.log("[harness] Build complete.");
	} catch (err) {
		console.error("[harness] Build failed:", err);
		throw err;
	}
}

async function applyLifecycle(trigger: "initial" | "sentinel-restart" | "crash-relaunch"): Promise<void> {
	await runHarnessLifecycle(trigger, {
		validate: () => validateDependencies(PROJECT_ROOT),
		build: buildServer,
		launch: launchServer,
		report: (message) => console.error(`[harness] ${message}`),
		exit: (code) => process.exit(code),
	});
}

// ---------------------------------------------------------------------------
// Restart cycle
// ---------------------------------------------------------------------------

async function restart(): Promise<void> {
	if (restarting) {
		console.log("[harness] Restart already in progress, ignoring signal.");
		return;
	}
	restarting = true;

	// Manual restart via the sentinel file is the explicit
	// "I have fixed the underlying problem, please try again" signal. Reset
	// the crash-loop counter and clear the halt flag so launchServer() runs.
	if (consecutiveQuickCrashes > 0 || crashLoopHalted) {
		console.log(
			`[harness] Manual restart trigger — clearing crash-loop counter (was ${consecutiveQuickCrashes}, halted=${crashLoopHalted}).`,
		);
	}
	consecutiveQuickCrashes = 0;
	crashLoopHalted = false;

	try {
		console.log("\n[harness] ======== RESTART TRIGGERED ========");

		// 1. Kill running server
		await killServer();

		// 2. Wait for port to clear
		console.log(`[harness] Waiting for port ${PORT} to be free...`);
		await waitForPortFree(PORT);

		// 3. Validate dependencies, then rebuild and relaunch when healthy.
		// Invalid dependencies or a failed build leave this watcher alive for a
		// later operator-triggered retry; stale output is never launched.
		await applyLifecycle("sentinel-restart");
	} catch (err) {
		console.error("[harness] Restart failed:", err);
	} finally {
		restarting = false;
	}
}

// ---------------------------------------------------------------------------
// Sentinel file watcher
// ---------------------------------------------------------------------------

function watchSentinel(): void {
	// Seed the file so fs.watch has something to watch
	if (!fs.existsSync(SENTINEL)) {
		fs.writeFileSync(SENTINEL, "", "utf-8");
	}

	console.log(`[harness] Watching sentinel: ${SENTINEL}`);

	// Track last-modified to debounce rapid writes — seed from current mtime
	// to avoid a spurious restart on the first poll cycle.
	let lastMtime = fs.statSync(SENTINEL).mtimeMs;

	// fs.watch can be flaky on some platforms — use polling fallback on Windows
	const usePolling = process.platform === "win32";

	if (usePolling) {
		setInterval(() => {
			try {
				const stat = fs.statSync(SENTINEL);
				const mtime = stat.mtimeMs;
				if (mtime > lastMtime) {
					lastMtime = mtime;
					restart();
				}
			} catch {
				// Sentinel deleted? Recreate it.
				try {
					fs.writeFileSync(SENTINEL, "", "utf-8");
				} catch { /* ignore */ }
			}
		}, 500);
	} else {
		fs.watch(SENTINEL, () => {
			try {
				const stat = fs.statSync(SENTINEL);
				if (stat.mtimeMs > lastMtime) {
					lastMtime = stat.mtimeMs;
					restart();
				}
			} catch { /* ignore */ }
		});
	}
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
	console.log("\n[harness] Shutting down...");
	restarting = true; // prevent auto-restart on child exit
	await killServer();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("[harness] Dev server harness starting");
	console.log(`[harness] Project root: ${PROJECT_ROOT}`);
	console.log(`[harness] Server port:  ${PORT}`);
	console.log(`[harness] Sentinel:     ${SENTINEL}`);
	console.log(`[harness] Trigger restart: npm run restart-server`);

	await applyLifecycle("initial");
	watchSentinel();
}

void main().catch((err) => {
	console.error("[harness] Initial startup failed — exiting:", err);
	process.exit(1);
});
