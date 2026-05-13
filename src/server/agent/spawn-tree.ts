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

export interface SpawnTrackedOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdio?: StdioOptions;
	windowsHide?: boolean;
	/** Optional — helper owns the timer; cleared on close/exit. */
	timeoutMs?: number;
	/** SIGTERM → SIGKILL escalation delay (POSIX only). Default 5000ms. */
	killGraceMs?: number;
	/** Invoked once when the timer fires, before the tree kill. */
	onTimeout?: () => void;
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
	killed(): boolean;
	timedOut(): boolean;
}

const registry: Set<InternalTracked> = new Set();

interface InternalTracked extends TrackedChild {
	_pid: number | undefined;
	_killed: boolean;
	_timedOut: boolean;
	_closed: boolean;
	_escalationTimer?: NodeJS.Timeout;
	_timeoutTimer?: NodeJS.Timeout;
}

/** Spawn a process whose entire tree we can later kill. */
export function spawnTracked(
	cmd: string,
	args: readonly string[],
	opts: SpawnTrackedOptions = {},
): TrackedChild {
	const isWin = process.platform === "win32";
	const killGraceMs = opts.killGraceMs ?? 5000;

	const child = spawn(cmd, args as string[], {
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
		killed: () => tracked._killed,
		timedOut: () => tracked._timedOut,
		killTree(signal: "SIGTERM" | "SIGKILL" = "SIGTERM", graceMsOverride?: number) {
			if (tracked._closed) return;
			tracked._killed = true;
			const pid = tracked._pid;
			if (pid == null) return;

			if (isWin) {
				// Windows: taskkill /T walks the whole tree; /F is forceful.
				// Fire-and-forget — we don't await its exit.
				try {
					const tk = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
						stdio: "ignore",
						windowsHide: true,
					});
					tk.on("error", () => { /* taskkill not on PATH? best-effort */ });
				} catch { /* ignore */ }
				return;
			}

			// POSIX: kill the process group (pgid === pid because detached:true).
			try { process.kill(-pid, signal); } catch { /* already dead */ }

			// Escalate to SIGKILL after the grace window if the child is still
			// open. We only schedule one escalation; subsequent killTree calls
			// reset the timer if needed.
			if (signal === "SIGTERM") {
				if (tracked._escalationTimer) clearTimeout(tracked._escalationTimer);
				const grace = graceMsOverride ?? killGraceMs;
				tracked._escalationTimer = setTimeout(() => {
					if (tracked._closed) return;
					try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
				}, grace);
				tracked._escalationTimer.unref();
			}
		},
	};

	// Optional helper-owned timeout.
	if (opts.timeoutMs != null && opts.timeoutMs > 0) {
		tracked._timeoutTimer = setTimeout(() => {
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
		if (tracked._timeoutTimer) clearTimeout(tracked._timeoutTimer);
		if (tracked._escalationTimer) clearTimeout(tracked._escalationTimer);
		registry.delete(tracked);
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
export function killAllTracked(signal: "SIGTERM" | "SIGKILL" = "SIGKILL"): void {
	for (const t of Array.from(registry)) {
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
