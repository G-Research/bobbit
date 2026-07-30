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
 *           grace period (default 5s, 1s when called from cancellation). Root
 *           exit is an ownership boundary: never signal a numeric PGID after
 *           it; report cleanup as unverified rather than risk PGID reuse.
 *   Windows — `taskkill /T /F /PID <pid>` (the `/T` flag walks the tree), but
 *           only while the root process has not emitted `exit`. Root exit is
 *           the PID-reuse boundary: no later numeric-PID action is safe.
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
	/** Test seam for checking whether the detached POSIX process group remains live. */
	isProcessGroupAlive?: (pgid: number) => boolean;
	/** Test seam for sending a signal to the detached POSIX process group. */
	signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
	/** Optional — helper owns the timer; cleared on full process closure. */
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
	 * On POSIX, SIGTERM is sent first; SIGKILL escalates after grace while the
	 * root process still witnesses the owned group. Root exit fails closed.
	 * `graceMsOverride` shortens (or lengthens) the SIGKILL escalation
	 * window for this kill specifically (e.g. cancellation uses 1000ms).
	 */
	killTree(signal?: "SIGTERM" | "SIGKILL", graceMsOverride?: number): void;
	/**
	 * Wait a bounded interval for a previously-requested tree kill to finish.
	 * On POSIX this observes the owned process group while the root remains a
	 * valid ownership witness; otherwise it fails closed. On Windows it waits
	 * for the scoped `taskkill /T /F` invocation to complete.
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
	/** The root process exited. This is distinct from `close`, which follows after stdio closes. */
	_exited: boolean;
	/** The child and all of its inherited stdio handles have closed. */
	_closed: boolean;
	/** Once a POSIX group is observed empty, its numeric PGID is no longer owned. */
	_processGroupOwnershipLost: boolean;
	/** A terminal POSIX group signal was sent; never signal that numeric PGID again. */
	_posixFinalSignalSent: boolean;
	/**
	 * The root identity boundary passed before we could establish tree completion.
	 * The numeric POSIX PGID / Windows PID is no longer safe to probe or target.
	 */
	_treeCompletionUnverified: boolean;
	_survivesShutdown: boolean;
	_escalationTimer?: NodeJS.Timeout;
	_timeoutTimer?: NodeJS.Timeout;
	/** Resolves to the outcome of the one scoped Windows taskkill invocation. */
	_windowsTreeKill?: Promise<boolean>;
}

const TREE_EXIT_POLL_MS = 25;
const TREE_EXIT_SETTLE_MS = 1_500;

function isProcessGroupAlive(pgid: number): boolean {
	if (!Number.isFinite(pgid) || pgid <= 0) return false;
	try {
		// Callers must separately preserve ownership continuity: after an empty
		// group releases this numeric PGID, the kernel may reuse it.
		process.kill(-pgid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function unrefTimer(timer: NodeJS.Timeout | undefined): void {
	timer?.unref?.();
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
	const groupIsAlive = opts.isProcessGroupAlive ?? isProcessGroupAlive;
	const signalProcessGroup = opts.signalProcessGroup ?? ((pgid, signal) => {
		process.kill(-pgid, signal);
	});
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
		_exited: false,
		_closed: false,
		_processGroupOwnershipLost: false,
		_posixFinalSignalSent: false,
		_treeCompletionUnverified: false,
		_survivesShutdown: false,
		killed: () => tracked._killed,
		timedOut: () => tracked._timedOut,
		markSurvival: () => { tracked._survivesShutdown = true; },
		async waitForTreeExit(timeoutMs?: number): Promise<boolean> {
			// Once the root's exit event fired without completion already observed,
			// neither a POSIX PGID nor a Windows PID remains an owned identity. Do not
			// turn a later numeric lookup into evidence for a recycled process tree.
			if (tracked._treeCompletionUnverified) return false;
			const pid = tracked._pid;
			if (pid == null) return true;
			const timeout = Math.max(0, timeoutMs ?? killGraceMs + TREE_EXIT_SETTLE_MS);
			const deadline = Date.now() + timeout;

			if (isWin) {
				// `exit` is a PID-reuse boundary. Do not probe or target that numeric
				// PID after it: the only trustworthy cleanup result is taskkill that
				// was started before the root exited.
				if (!tracked._windowsTreeKill) return false;
				return Promise.race([
					tracked._windowsTreeKill,
					delay(timeout).then(() => false),
				]);
			}

			// A final group signal may take a turn to become visible. Probe once only:
			// an empty group proves completion; a still-live number is deliberately
			// unverified rather than repeatedly polling into a later PGID reuse window.
			if (tracked._posixFinalSignalSent) {
				if (!groupIsAlive(pid)) {
					tracked._processGroupOwnershipLost = true;
					return true;
				}
				return false;
			}

			while (!tracked._processGroupOwnershipLost) {
				if (!groupIsAlive(pid)) {
					tracked._processGroupOwnershipLost = true;
					return true;
				}
				if (Date.now() >= deadline) return false;
				await delay(Math.min(TREE_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
			}
			return true;
		},
		killTree(signal: "SIGTERM" | "SIGKILL" = "SIGTERM", graceMsOverride?: number) {
			if (isWin) {
				// Unlike `close`, root `exit` is the identity boundary: Windows can
				// reuse this PID while descendants still retain inherited stdio. Never
				// begin a new taskkill after it, even as a best-effort fallback.
				if (tracked._exited || tracked._closed || tracked._windowsTreeKill) return;
				const pid = tracked._pid;
				if (pid == null) return;

				tracked._killed = true;
				tracked._survivesShutdown = false;
				let completeTreeKill!: (succeeded: boolean) => void;
				tracked._windowsTreeKill = new Promise<boolean>((resolve) => {
					completeTreeKill = resolve;
				});
				try {
					const tk = spawnImpl("taskkill", ["/T", "/F", "/PID", String(pid)], {
						stdio: "ignore",
						windowsHide: true,
					});
					let completed = false;
					const done = (succeeded: boolean) => {
						if (completed) return;
						completed = true;
						completeTreeKill(succeeded);
					};
					tk.once("close", (code: number | null) => done(code === 0));
					tk.once("error", () => done(false));
				} catch {
					completeTreeKill(false);
				}
				return;
			}

			const pid = tracked._pid;
			if (pid == null || tracked._processGroupOwnershipLost || tracked._posixFinalSignalSent) return;
			// Root exit is the POSIX ownership boundary just as it is for a Windows
			// PID. Descendants may retain stdio after it, but their old numeric PGID
			// can be released and recycled before an asynchronous timeout callback.
			// Failing closed is safer than signalling an unrelated process group.
			if (tracked._exited) {
				tracked._killed = true;
				tracked._treeCompletionUnverified = true;
				tracked._processGroupOwnershipLost = true;
				tracked._posixFinalSignalSent = true;
				if (tracked._escalationTimer) clock.clearTimeout(tracked._escalationTimer);
				tracked._escalationTimer = undefined;
				registry.delete(tracked);
				return;
			}
			if (!groupIsAlive(pid)) {
				tracked._processGroupOwnershipLost = true;
				registry.delete(tracked);
				return;
			}
			tracked._killed = true;
			// Restart survival is only for a still-running durable command. Once
			// cancellation/timeout requested cleanup, shutdown must retain ownership
			// and never skip this process tree.
			tracked._survivesShutdown = false;

			// POSIX: kill only the process group created by this detached spawn
			// (pgid === pid). Never fall back to a broad process scan or -1.
			try { signalProcessGroup(pid, signal); } catch { /* already dead */ }

			if (signal === "SIGTERM") {
				if (tracked._escalationTimer) clock.clearTimeout(tracked._escalationTimer);
				const grace = graceMsOverride ?? killGraceMs;
				tracked._escalationTimer = clock.setTimeout(() => {
					// The root process is a live ownership witness until its exit event.
					// After that event, `onExit` either kills surviving descendants
					// immediately or records an empty-group ownership loss; never defer a
					// numeric-PGID signal into a possible reuse window.
					if (!tracked._exited && !tracked._processGroupOwnershipLost && groupIsAlive(pid)) {
						try { signalProcessGroup(pid, "SIGKILL"); } catch { /* already dead */ }
						tracked._posixFinalSignalSent = true;
					} else if (!tracked._exited) {
						tracked._processGroupOwnershipLost = true;
					}
					// SIGKILL delivery is asynchronous. Drop shutdown ownership, but let
					// waitForTreeExit observe the group becoming empty before claiming it
					// has been reaped.
					registry.delete(tracked);
				}, grace);
				unrefTimer(tracked._escalationTimer);
			} else {
				if (tracked._escalationTimer) {
					clock.clearTimeout(tracked._escalationTimer);
					tracked._escalationTimer = undefined;
				}
				tracked._posixFinalSignalSent = true;
				// A final signal may take a turn to become visible to process.kill(0).
				// Keep that observation available to waiters but never retain a registry
				// entry that could cause a second negative-PID action after reuse.
				registry.delete(tracked);
			}
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
		unrefTimer(tracked._timeoutTimer);
	}

	const clearEscalation = () => {
		if (tracked._escalationTimer) clock.clearTimeout(tracked._escalationTimer);
		tracked._escalationTimer = undefined;
	};
	const onExit = () => {
		tracked._exited = true;
		if (!isWin && tracked._killed) {
			// An exit event can arrive before descendants close inherited stdio. If
			// SIGKILL was not already dispatched while the root was alive, the leader
			// no longer witnesses the numeric process-group identity: never re-arm a
			// negative-PID action and fail cleanup closed. A final signal that was sent
			// before this boundary gets exactly one non-destructive completion probe.
			if (!tracked._posixFinalSignalSent) {
				tracked._treeCompletionUnverified = true;
				tracked._processGroupOwnershipLost = true;
			}
			clearEscalation();
			registry.delete(tracked);
		}
	};
	const onClose = () => {
		tracked._closed = true;
		if (tracked._timeoutTimer) clock.clearTimeout(tracked._timeoutTimer);
		if (!isWin) clearEscalation();
		// A taskkill already started remains joinable, but root `exit` (and,
		// independently, full stream closure) forbids every new PID action.
		registry.delete(tracked);
	};
	child.once("exit", onExit);
	child.once("close", onClose);
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
 *
 * This is intentionally unsupported on Windows. A persisted PID has no stable
 * Job-object handle after a gateway restart, so taskkill could target a reused
 * PID. Callers must leave the command pending/retryable instead of issuing an
 * asynchronous best-effort taskkill or inferring that descendants died because
 * the persisted root disappeared.
 */
export type PersistedTreeKillResult = "signalled" | "unsupported" | "invalid";

export function killTreeByPid(
	pid: number,
	signal: NodeJS.Signals = "SIGKILL",
	opts: { platform?: NodeJS.Platform; killImpl?: (pid: number, signal: NodeJS.Signals) => void } = {},
): PersistedTreeKillResult {
	if (!Number.isFinite(pid) || pid <= 0) return "invalid";
	if ((opts.platform ?? process.platform) === "win32") return "unsupported";
	const kill = opts.killImpl ?? process.kill;
	// The detached wrapper makes its PID the process-group ID. Do not fall back
	// to the positive PID: a lost group is an ownership boundary, and a later
	// numeric-PID action could be retargeted after reuse.
	try {
		kill(-pid, signal);
		return "signalled";
	} catch {
		return "invalid";
	}
}

/** Test-only: number of tracked children currently registered. */
export function _trackedCount(): number {
	return registry.size;
}
