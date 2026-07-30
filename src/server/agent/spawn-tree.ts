/**
 * Tracked subprocess spawn with process-tree kill.
 *
 * Problem this solves:
 *   Node's `child_process.spawn(..., { timeout })` only sends SIGTERM to the
 *   immediate child. When the child is `bash -c "<cmd>"`, descendants (npm,
 *   playwright, chromium, …) keep running. Same story for any manual
 *   `process.kill(child.pid, sig)` — the call only targets the immediate
 *   child, never its descendants.
 *
 * Approach:
 *   POSIX — spawn with `detached: true` so the child becomes its own process
 *           group leader (pgid === child.pid). Kill the whole tree via
 *           `process.kill(-pgid, sig)`. SIGTERM → SIGKILL escalation after a
 *           grace period (default 5s, 1s when called from cancellation).
 *   Windows — `taskkill /T /F /PID <pid>` (the `/T` flag walks the tree).
 *
 * The helper owns the timeout timer (`setTimeout`, `.unref()`'d) so a
 * long-running tracked child never holds the event loop open against a
 * graceful gateway exit. `killAllTracked` provides explicit cleanup on
 * harness shutdown for any children still in flight.
 *
 * Reusable primitive: any caller that spawns a shell which may itself
 * spawn descendants (test runners, browser drivers, package managers)
 * should prefer this helper over raw `spawn` to avoid orphan trees.
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";

export interface SpawnTrackedOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdio?: StdioOptions;
	windowsHide?: boolean;
	/** Override process spawning (primarily for deterministic process-lifecycle tests). */
	spawnImpl?: typeof spawn;
	/** Override the platform branch (primarily for platform-neutral lifecycle tests). */
	platform?: NodeJS.Platform;
	/** Optional — helper owns the timer; cleared on close/exit. */
	timeoutMs?: number;
	/** SIGTERM → SIGKILL escalation delay (POSIX only). Default 5000ms. */
	killGraceMs?: number;
	/** Invoked once when the timer fires, before the tree kill. */
	onTimeout?: () => void;
	clock?: Clock;
}

export interface TrackedChild {
	readonly child: ChildProcess;
	/**
	 * Kill the entire process tree. Idempotent.
	 * On POSIX, SIGTERM is sent first; SIGKILL escalates after grace.
	 * `graceMsOverride` shortens (or lengthens) the SIGKILL escalation
	 * window for this kill specifically (e.g. cancellation uses 1000ms).
	 */
	killTree(signal?: "SIGTERM" | "SIGKILL", graceMsOverride?: number): void;
	/**
	 * Wait a bounded interval for a previously-requested tree kill to finish.
	 * On POSIX this observes the owned process group, not merely the shell
	 * leader (which can exit while a descendant ignores SIGTERM). On Windows it
	 * waits for the scoped `taskkill /T /F` invocation to complete.
	 */
	waitForTreeExit(timeoutMs?: number): Promise<boolean>;
	killed(): boolean;
	timedOut(): boolean;
	/**
	 * Mark this tracked child as surviving gateway shutdown. When set,
	 * `killAllTracked()` skips this entry so the child outlives the
	 * gateway process — enabling Layer 1 restart-survival for detached
	 * verification command steps (see `_resumeCommandStep`).
	 */
	markSurvival(): void;
}

const registry: Set<InternalTracked> = new Set();

interface InternalTracked extends TrackedChild {
	_pid: number | undefined;
	_killed: boolean;
	_timedOut: boolean;
	_closed: boolean;
	_survivesShutdown: boolean;
	_escalationTimer?: NodeJS.Timeout;
	_timeoutTimer?: NodeJS.Timeout;
	/** Completes after the currently-running Windows taskkill invocation. */
	_windowsTreeKill?: Promise<void>;
}

const TREE_EXIT_POLL_MS = 25;
const TREE_EXIT_SETTLE_MS = 1_500;

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

function isProcessGroupAlive(pgid: number): boolean {
	if (!Number.isFinite(pgid) || pgid <= 0) return false;
	try {
		// Negative PID is intentionally limited to the process group created by
		// this module's detached spawn. A live group with this ID cannot have
		// been reused: the original group would first need to become empty.
		process.kill(-pgid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Spawn a process whose entire tree we can later kill. */
export function spawnTracked(
	cmd: string,
	args: readonly string[],
	opts: SpawnTrackedOptions = {},
): TrackedChild {
	const isWin = (opts.platform ?? process.platform) === "win32";
	const spawnImpl = opts.spawnImpl ?? spawn;
	const killGraceMs = opts.killGraceMs ?? 5000;
	const clock = opts.clock ?? realClock;

	const child = spawnImpl(cmd, args as string[], {
		cwd: opts.cwd,
		env: opts.env,
		stdio: opts.stdio,
		// POSIX: detached:true puts the child in its own process group so we
		// can kill the whole tree via process.kill(-pgid, sig).
		detached: !isWin,
		// Windows: spawn options handle tree kill via taskkill /T below.
		windowsHide: opts.windowsHide ?? isWin,
	});

	const tracked: InternalTracked = {
		child,
		_pid: child.pid,
		_killed: false,
		_timedOut: false,
		_closed: false,
		_survivesShutdown: false,
		killed: () => tracked._killed,
		timedOut: () => tracked._timedOut,
		markSurvival: () => { tracked._survivesShutdown = true; },
		async waitForTreeExit(timeoutMs?: number): Promise<boolean> {
			const pid = tracked._pid;
			if (pid == null) return true;
			const timeout = Math.max(0, timeoutMs ?? killGraceMs + TREE_EXIT_SETTLE_MS);
			const deadline = Date.now() + timeout;

			if (isWin) {
				// taskkill /T /F is synchronous with respect to its tree walk. Await
				// that owned helper rather than treating the root cmd.exe exit as proof
				// that descendants are gone.
				if (tracked._windowsTreeKill) {
					await Promise.race([tracked._windowsTreeKill, delay(timeout)]);
				}
				return !isPidAlive(pid);
			}

			// The child process can close as soon as its shell leader receives
			// SIGTERM. Continue checking the *owned* process group until it is
			// empty, so grandchildren that ignored SIGTERM cannot escape the later
			// SIGKILL escalation.
			while (isProcessGroupAlive(pid)) {
				if (Date.now() >= deadline) return false;
				await delay(Math.min(TREE_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
			}
			return true;
		},
		killTree(signal: "SIGTERM" | "SIGKILL" = "SIGTERM", graceMsOverride?: number) {
			if (isWin) {
				// A root-process close means this PID is no longer an identity we own.
				// Never taskkill it again: Windows can reuse PIDs, making a late kill
				// capable of targeting an unrelated process. Once cleanup begins, retain
				// its promise forever so all timeout/cancellation callers join one tree
				// walk rather than restarting taskkill after it finishes.
				if (tracked._closed || tracked._windowsTreeKill) return;
				const pid = tracked._pid;
				if (pid == null) return;

				tracked._killed = true;
				tracked._survivesShutdown = false;
				let completeTreeKill!: () => void;
				tracked._windowsTreeKill = new Promise<void>((resolve) => {
					completeTreeKill = resolve;
				});
				try {
					const tk = spawnImpl("taskkill", ["/T", "/F", "/PID", String(pid)], {
						stdio: "ignore",
						windowsHide: true,
					});
					const done = () => completeTreeKill();
					tk.once("close", done);
					tk.once("error", done);
				} catch {
					completeTreeKill();
				}
				return;
			}

			if (tracked._closed && !isProcessGroupAlive(tracked._pid ?? 0)) return;
			tracked._killed = true;
			// Restart survival is only for a still-running durable command. Once
			// cancellation/timeout requested cleanup, shutdown must retain ownership
			// and never skip this process tree.
			tracked._survivesShutdown = false;
			const pid = tracked._pid;
			if (pid == null) return;

			// POSIX: kill only the process group created by this detached spawn
			// (pgid === pid). Never fall back to a broad process scan or -1.
			try { process.kill(-pid, signal); } catch { /* already dead */ }

			// A shell leader can exit immediately after SIGTERM while descendants
			// remain in its process group. Do NOT gate escalation on `_closed`:
			// doing so orphaned npm/playwright workers. A live group proves this
			// group is still ours, so SIGKILL remains scoped to this command tree.
			if (signal === "SIGTERM") {
				if (tracked._escalationTimer) clock.clearTimeout(tracked._escalationTimer);
				const grace = graceMsOverride ?? killGraceMs;
				tracked._escalationTimer = clock.setTimeout(() => {
					if (isProcessGroupAlive(pid)) {
						try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
					}
					// SIGKILL has been issued (or the group was already empty), so this
					// entry no longer needs shutdown ownership.
					registry.delete(tracked);
				}, grace);
				tracked._escalationTimer.unref();
			} else if (tracked._escalationTimer) {
				clock.clearTimeout(tracked._escalationTimer);
				tracked._escalationTimer = undefined;
			}
			if (signal === "SIGKILL" && tracked._closed) registry.delete(tracked);
		},
	};

	// Optional helper-owned timeout.
	if (opts.timeoutMs != null && opts.timeoutMs > 0) {
		tracked._timeoutTimer = clock.setTimeout(() => {
			if (tracked._closed) return;
			tracked._timedOut = true;
			try { opts.onTimeout?.(); } catch { /* ignore */ }
			tracked.killTree("SIGTERM");
		}, opts.timeoutMs);
		// .unref() so a stuck child cannot block graceful exit; harness
		// shutdown calls killAllTracked() for explicit cleanup.
		tracked._timeoutTimer.unref();
	}

	const onClose = () => {
		tracked._closed = true;
		if (tracked._timeoutTimer) clock.clearTimeout(tracked._timeoutTimer);
		// Preserve a pending POSIX SIGTERM → SIGKILL escalation after the shell
		// leader closes. Its descendants may still be alive in the owned group.
		const descendantsStillAlive = !isWin && tracked._killed && isProcessGroupAlive(tracked._pid ?? 0);
		if (tracked._escalationTimer && !descendantsStillAlive) {
			clock.clearTimeout(tracked._escalationTimer);
			tracked._escalationTimer = undefined;
		}
		// Keep a pending tree in the registry until escalation fires. If the
		// gateway shuts down in this window, killAllTracked() must still find it
		// and send SIGKILL rather than letting unref'd timers abandon descendants.
		if (!descendantsStillAlive) registry.delete(tracked);
	};
	child.once("close", onClose);
	child.once("exit", onClose);
	child.once("error", () => {
		// On synchronous spawn failures the child never emits "close"; clear
		// timers and drop from the registry so we don't leak.
		onClose();
	});

	registry.add(tracked);
	return tracked;
}

/**
 * Kill every tracked child whose subprocess tree is still alive.
 * Called from harness shutdown to ensure no chromium / playwright
 * descendants leak across gateway restarts.
 */
export function killAllTracked(signal: "SIGTERM" | "SIGKILL" = "SIGKILL", includeSurvival = false): void {
	for (const t of Array.from(registry)) {
		if (!includeSurvival && t._survivesShutdown) continue;
		try { t.killTree(signal, 0); } catch { /* best-effort */ }
	}
}

/**
 * Tree-kill a process by PID from outside the spawn site — used by the
 * recovery path (`_resumeCommandStep`) where the persisted pid is also
 * the pgid (because the original spawn used `detached: true`).
 *
 * On Windows, falls back to `taskkill /T /F /PID <pid>`.
 */
export function killTreeByPid(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const tk = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
			tk.on("error", () => { /* best-effort */ });
			tk.unref?.();
		} catch { /* ignore */ }
		// If the shell/root process has already exited but a descendant kept an
		// inherited stdio handle open, taskkill by the root pid can miss it. Walk
		// ParentProcessId as a second best-effort pass so exit-close fallback paths
		// can reap those descendants instead of leaving them as orphaned test/verify
		// processes. The pid is numeric and passed as an argv element (no shell).
		try {
			const root = Math.trunc(pid);
			const script = `
$ErrorActionPreference = 'SilentlyContinue'
$seen = @{}
function Stop-BobbitTree([int]$Id) {
  if ($seen.ContainsKey($Id)) { return }
  $seen[$Id] = $true
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$Id")
  if (-not $children -and (Get-Command Get-WmiObject -ErrorAction SilentlyContinue)) { $children = @(Get-WmiObject Win32_Process -Filter "ParentProcessId=$Id") }
  foreach ($child in $children) { Stop-BobbitTree ([int]$child.ProcessId) }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}
Stop-BobbitTree ${root}
`;
			const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
				stdio: "ignore",
				windowsHide: true,
			});
			ps.on("error", () => { /* best-effort */ });
			ps.unref?.();
		} catch { /* ignore */ }
		return;
	}
	// Try pgid first (matches detached spawn). If the negative-pid call
	// fails (e.g. process wasn't detached, or pgid no longer exists), fall
	// back to the immediate-child kill so we at least target *something*.
	try { process.kill(-pid, signal); return; } catch { /* fall through */ }
	try { process.kill(pid, signal); } catch { /* already dead */ }
}

/** Test-only: number of tracked children currently registered. */
export function _trackedCount(): number {
	return registry.size;
}
