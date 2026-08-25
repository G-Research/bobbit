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
 *   POSIX — spawn with `detached: true` and a same-group sentinel that ignores
 *           SIGTERM, so the child becomes a process-group leader (pgid ===
 *           child.pid) whose PGID remains owned through root exit. Kill the
 *           whole tree via `process.kill(-pgid, sig)`. SIGTERM → SIGKILL
 *           escalation after a grace period (default 5s, 1s when called from
 *           cancellation). At root exit, the sentinel keeps ownership live for
 *           the final group kill; it is never signalled after that final kill.
 *   Windows — spawn a PowerShell/.NET job-object supervisor. It creates the
 *           payload suspended, assigns it to a KILL_ON_JOB_CLOSE job, atomically
 *           acknowledges that assignment to the parent, then resumes it.
 *           Closing or terminating the supervisor closes the job and atomically
 *           reaps every descendant without PID retargeting.
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

import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { realClock, type Clock } from "../clock.js";

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
	/** Enable the POSIX same-group sentinel (production default). */
	posixTreeSentinel?: boolean;
	/**
	 * Optional durable identity record written by the POSIX sentinel itself.
	 * Restart recovery uses it to prove the surviving process still owns the
	 * original group before it sends the final group kill.
	 */
	posixSentinelIdentity?: { file: string; nonce: string };
	/** Test seam for validating a retained POSIX sentinel before its final signal. */
	posixSentinelIdentityInspector?: (pid: number) => { pgid: number; startTokenKind: string; startToken: string; sentinelNonce?: string } | undefined;
	/**
	 * Docker-exec transport only: retain the exact POSIX sentinel after its CLI
	 * root exits so container payload cleanup can finish before host transport
	 * cleanup. Requires `posixSentinelIdentity`; ordinary POSIX spawns retain
	 * the default immediate root-exit reaping behavior.
	 */
	retainPosixSentinelForContainerTransport?: boolean;
	/** Spawn-site ownership prerequisite composed into the single public readiness boundary. */
	extraOwnershipReady?: Promise<void>;
	/** Nonce-bound Windows Job completion proof for restart recovery. */
	windowsJobCompletion?: { file: string; nonce: string };
	/**
	 * Enable the Windows job-object supervisor. Production Windows spawns enable
	 * it by default; lifecycle seams opt in explicitly to avoid requiring
	 * PowerShell in platform-neutral tests.
	 */
	windowsJobSupervisor?: boolean;
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
	 * root process exits, it synchronously sends the final group signal while
	 * that owned process group is still live.
	 * `graceMsOverride` shortens (or lengthens) the SIGKILL escalation
	 * window for this kill specifically (e.g. cancellation uses 1000ms).
	 */
	killTree(signal?: "SIGTERM" | "SIGKILL", graceMsOverride?: number): void;
	/**
	 * Wait a bounded interval for a previously-requested tree kill to finish.
	 * On POSIX this observes the owned process group after its final signal. On
	 * Windows it joins the spawn-time Job supervisor's close barrier.
	 */
	waitForTreeExit(timeoutMs?: number): Promise<boolean>;
	killed(): boolean;
	timedOut(): boolean;
	/**
	 * Resolves only after the platform ownership barrier is established: the
	 * POSIX sentinel acknowledges FD 3, or the Windows supervisor atomically
	 * acknowledges Job assignment before resuming the payload. Rejects when that
	 * barrier fails, after fail-closed cleanup is initiated.
	 */
	readonly ownershipReady: Promise<void>;
	/**
	 * Request gateway-shutdown survival. `killAllTracked()` honors it only after
	 * a durable ownership barrier: the POSIX sentinel FD-3 acknowledgement or
	 * the Windows supervisor's pre-resume Job acknowledgement (see
	 * `_resumeCommandStep`).
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
	/** Docker-exec handoff retains its exact sentinel after the CLI root exits. */
	_retainPosixSentinelForContainerTransport: boolean;
	/** Durable exact sentinel record required by a retained transport handoff. */
	_posixSentinelIdentity?: { file: string; nonce: string };
	/** Spawn-time sentinel keeps the original POSIX process group identity live. */
	_posixSentinelOwned: boolean;
	/** The sentinel installed its signal dispositions and acknowledged FD 3. */
	_posixSentinelReady: boolean;
	/** A kill requested before the sentinel handshake, replayed once ready. */
	_pendingPosixKill?: { signal: "SIGTERM" | "SIGKILL"; graceMsOverride?: number };
	/** Root exited before the sentinel handshake; finalize as soon as it arrives. */
	_pendingPosixFinalization: boolean;
	/**
	 * The root identity boundary passed before we could establish tree completion.
	 * The numeric POSIX PGID / Windows PID is no longer safe to probe or target.
	 */
	_treeCompletionUnverified: boolean;
	_survivesShutdown: boolean;
	_escalationTimer?: NodeJS.Timeout;
	_timeoutTimer?: NodeJS.Timeout;
	/** The supervisor is configured to assign the payload to a KILL_ON_JOB_CLOSE Job. */
	_windowsJobOwned: boolean;
	/** The supervisor observed Job assignment before the payload was resumed. */
	_windowsJobSurvivalReady: boolean;
	/** Resolves when the tracked supervisor's stdio and job handle have closed. */
	_windowsSupervisorClosed: Promise<void>;
	/** Private supervisor control endpoint; never inherited by the payload. */
	_windowsJobShutdownPipe?: string;
	_resolveWindowsSupervisorClosed: () => void;
}

const TREE_EXIT_POLL_MS = 25;
const TREE_EXIT_SETTLE_MS = 1_500;
const POSIX_SENTINEL_READINESS_FAILURE = "POSIX sentinel ownership was not established";
const WINDOWS_JOB_READINESS_FAILURE = "Windows Job ownership was not established";

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

function inspectPosixSentinelIdentity(pid: number, platform: NodeJS.Platform): { pgid: number; startTokenKind: string; startToken: string; sentinelNonce?: string } | undefined {
	try {
		if (platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
			const pgid = Number(fields[2]); // field 5; fields begin at state (field 3)
			const startToken = fields[19]; // field 22
			return Number.isFinite(pgid) && !!startToken ? { pgid, startTokenKind: "linux-proc-stat-22", startToken } : undefined;
		}
		if (platform === "darwin") {
			const startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
			const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			const sentinelNonce = /bobbit-posix-sentinel:([^\s]+)/.exec(command)?.[1];
			return Number.isFinite(pgid) && !!startToken ? { pgid, startTokenKind: "darwin-lstart-argv-nonce", startToken, sentinelNonce } : undefined;
		}
	} catch { /* missing/reused process is not exact ownership */ }
	return undefined;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function unrefTimer(timer: NodeJS.Timeout | undefined): void {
	timer?.unref?.();
}

/** Child stdio is typed as a generic readable/writable stream, but FD 3 is a Socket. */
function unrefReadyPipe(pipe: unknown): void {
	const unref = (pipe as { unref?: unknown } | undefined)?.unref;
	if (typeof unref === "function") unref.call(pipe);
}

/** Ask the still-live Windows supervisor to terminate its payload and close its Job. */
function requestWindowsJobClose(pipeName: string): void {
	try {
		const socket = connect(`\\\\.\\pipe\\${pipeName}`);
		socket.once("connect", () => { socket.end("x"); });
		socket.once("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
		socket.unref?.();
	} catch { /* the supervisor may already have crossed its close boundary */ }
}

/**
 * The Windows supervisor publishes this file only after assigning its suspended
 * payload to the Job. The watch is armed before the supervisor is spawned, and
 * `confirm()` closes the no-event race without polling.
 */
interface WindowsJobReadiness {
	file: string;
	ready: Promise<void>;
	confirm(): boolean;
	fail(): void;
	cleanup(): void;
}

function createWindowsJobReadiness(): WindowsJobReadiness {
	const directory = mkdtempSync(join(tmpdir(), "bobbit-windows-job-"));
	const file = join(directory, "owned");
	let watcher: FSWatcher | undefined;
	let settled = false;
	let established = false;
	let resolveReady!: () => void;
	let rejectReady!: () => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// A spawn can throw after this watcher is armed. Keep failure observed even
	// before spawnTracked has returned the promise to a caller.
	void ready.catch(() => {});
	const cleanup = () => {
		try { watcher?.close(); } catch { /* ignore */ }
		watcher = undefined;
		try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
	};
	const finish = (success: boolean) => {
		if (settled) return;
		settled = true;
		if (success) resolveReady(); else rejectReady();
	};
	const confirm = () => {
		if (established) return true;
		if (settled || !existsSync(file)) return false;
		established = true;
		finish(true);
		return true;
	};
	const fail = () => finish(false);
	try {
		watcher = watch(directory, { persistent: false }, confirm);
		watcher.unref?.();
		watcher.once("error", fail);
		confirm();
	} catch {
		fail();
	}
	return { file, ready, confirm, fail, cleanup };
}

/** A bounded wait that never leaves its losing timeout referenced. */
function waitWithTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
		timer.unref?.();
		void promise.then(finish, () => finish(false));
	});
}

/*
 * This fixed, dependency-free supervisor is the Windows ownership primitive.
 * Its own std handles can be null/invalid under headless Windows runners. The
 * native helper substitutes owned, inheritable NUL handles only for those
 * missing descriptors, so CreateProcess always receives a valid stdio triple.
 * Supplied pipe/console handles retain their original ownership.
 * It must assign the payload before it resumes it: assigning a running root
 * leaves a window where a fast payload can spawn an unowned child. The job's
 * KILL_ON_JOB_CLOSE flag makes both normal completion and cancellation close
 * the entire tree without ever acting on a PID after its exit event.
 */
const WINDOWS_JOB_SUPERVISOR = String.raw`
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BOBBIT_WINDOWS_JOB_PAYLOAD)) | ConvertFrom-Json
$readyFile = $env:BOBBIT_WINDOWS_JOB_READY_FILE
$completionFile = $env:BOBBIT_WINDOWS_JOB_COMPLETION_FILE
$completionNonce = $env:BOBBIT_WINDOWS_JOB_COMPLETION_NONCE
$shutdownPipe = $env:BOBBIT_WINDOWS_JOB_SHUTDOWN_PIPE
# The payload inherits this supervisor's environment; never leak the private
# command/ready-path envelope to the command process.
Remove-Item Env:BOBBIT_WINDOWS_JOB_PAYLOAD -ErrorAction SilentlyContinue
Remove-Item Env:BOBBIT_WINDOWS_JOB_READY_FILE -ErrorAction SilentlyContinue
Remove-Item Env:BOBBIT_WINDOWS_JOB_COMPLETION_FILE -ErrorAction SilentlyContinue
Remove-Item Env:BOBBIT_WINDOWS_JOB_COMPLETION_NONCE -ErrorAction SilentlyContinue
Remove-Item Env:BOBBIT_WINDOWS_JOB_SHUTDOWN_PIPE -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO.Pipes;
using System.Threading.Tasks;
public static class BobbitJobSupervisor {
  const uint CREATE_SUSPENDED = 4, STARTF_USESTDHANDLES = 0x100, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, HANDLE_FLAG_INHERIT = 1, INFINITE = 0xffffffff, GENERIC_READ = 0x80000000u, GENERIC_WRITE = 0x40000000u, FILE_SHARE_READ_WRITE = 3, OPEN_EXISTING = 3;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute; public uint dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr InheritableStdHandle(int n, uint access, out bool owned) { IntPtr h = GetStdHandle(n); owned = h == IntPtr.Zero || h == new IntPtr(-1); if (owned) { h = CreateFile("NUL", access, FILE_SHARE_READ_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero); if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error()); } Check(SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)); return h; }
  static string Quote(string s) { if (s.Length == 0) return "\"\""; if (s.IndexOfAny(new [] {' ', '\t', '"'}) < 0) return s; var b = new StringBuilder("\""); int slashes = 0; foreach (char c in s) { if (c == '\\') { slashes++; continue; } if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); slashes = 0; continue; } b.Append('\\', slashes); slashes = 0; b.Append(c); } b.Append('\\', slashes * 2); b.Append('"'); return b.ToString(); }
  // Construct/listen synchronously before ready publication and ResumeThread.
  // A Task which creates the server later leaves a kill window where the host
  // observes readiness but has no private Job-close control endpoint.
  static NamedPipeServerStream ArmShutdownPipe(string name, IntPtr process) { if (String.IsNullOrEmpty(name)) return null; var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None); Task.Run(() => { try { pipe.WaitForConnection(); pipe.ReadByte(); TerminateProcess(process, 1); } catch {} }); return pipe; }
  public static int Run(string file, string[] args, string cwd, string readyFile, string completionFile, string completionNonce, string shutdownPipe) { IntPtr job = IntPtr.Zero; PROCESS_INFORMATION pi = new PROCESS_INFORMATION(); STARTUPINFO si = new STARTUPINFO(); NamedPipeServerStream shutdown = null; bool assigned = false, ownIn = false, ownOut = false, ownErr = false; try { job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))); si.cb = Marshal.SizeOf(si); si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = InheritableStdHandle(-10, GENERIC_READ, out ownIn); si.hStdOutput = InheritableStdHandle(-11, GENERIC_WRITE, out ownOut); si.hStdError = InheritableStdHandle(-12, GENERIC_WRITE, out ownErr); var line = new StringBuilder(Quote(file)); foreach (var arg in args) line.Append(' ').Append(Quote(arg)); Check(CreateProcess(null, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, cwd, ref si, out pi)); Check(AssignProcessToJobObject(job, pi.hProcess)); assigned = true; shutdown = ArmShutdownPipe(shutdownPipe, pi.hProcess); if (!String.IsNullOrEmpty(readyFile)) { string pendingReadyFile = readyFile + ".tmp"; System.IO.File.WriteAllText(pendingReadyFile, "ready", Encoding.ASCII); System.IO.File.Move(pendingReadyFile, readyFile); } if (ResumeThread(pi.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error()); WaitForSingleObject(pi.hProcess, INFINITE); uint code; Check(GetExitCodeProcess(pi.hProcess, out code)); return unchecked((int)code); } finally { if (shutdown != null) shutdown.Dispose(); if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero && !assigned) TerminateProcess(pi.hProcess, 1); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess); if (ownIn && si.hStdInput != IntPtr.Zero) CloseHandle(si.hStdInput); if (ownOut && si.hStdOutput != IntPtr.Zero) CloseHandle(si.hStdOutput); if (ownErr && si.hStdError != IntPtr.Zero) CloseHandle(si.hStdError); if (job != IntPtr.Zero) { CloseHandle(job); if (assigned && !String.IsNullOrEmpty(completionFile) && !String.IsNullOrEmpty(completionNonce)) { string pendingCompletion = completionFile + ".tmp"; System.IO.File.WriteAllText(pendingCompletion, "{\"nonce\":\"" + completionNonce + "\",\"jobClosed\":true}", Encoding.ASCII); System.IO.File.Move(pendingCompletion, completionFile); } } } }
}
'@
exit [BobbitJobSupervisor]::Run([string]$payload.file, [string[]]$payload.args, [string]$payload.cwd, [string]$readyFile, [string]$completionFile, [string]$completionNonce, [string]$shutdownPipe)
`;

const WINDOWS_JOB_SUPERVISOR_COMMAND = Buffer.from(WINDOWS_JOB_SUPERVISOR, "utf16le").toString("base64");

// The background shell remains in the detached process group but ignores the
// graceful signal. It makes root exit an ownership-safe place to send SIGKILL:
// no empty-group/PGID-reuse window exists until that final signal kills it.
// Run this in a separately invoked shell, rather than a background subshell.
// POSIX `/bin/sh` preserves the outer shell's `$$` in `( ... ) &`; a new shell
// gives the identity record the actual sentinel PID needed after root exit.
// A persisted POSIX identity must be an exact process-incarnation authority.
// Linux field 22 is kernel-stable for an incarnation. Node exposes no libproc
// binding, so Darwin combines its process start time with a cryptographic nonce
// held in the sentinel's argv. `lstart` alone is never accepted: a same-second
// PID reuse lacks the 128-bit nonce and fails closed during recovery.
const POSIX_TREE_SENTINEL_CHILD_SCRIPT = "trap '' HUP INT TERM; if [ -n \"$BOBBIT_POSIX_SENTINEL_IDENTITY_FILE\" ]; then case \"$(uname -s 2>/dev/null)\" in Linux) __bobbit_sentinel_start=$(awk '{print $22}' \"/proc/$$/stat\" 2>/dev/null || true); __bobbit_sentinel_kind=linux-proc-stat-22 ;; Darwin) __bobbit_sentinel_start=$(LC_ALL=C ps -o lstart= -p \"$$\" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); __bobbit_sentinel_kind=darwin-lstart-argv-nonce ;; *) exit 125 ;; esac; [ -n \"$__bobbit_sentinel_start\" ] || exit 125; __bobbit_sentinel_tmp=\"$BOBBIT_POSIX_SENTINEL_IDENTITY_FILE.$$.tmp\"; printf '{\"pid\":%s,\"pgid\":%s,\"nonce\":\"%s\",\"startTokenKind\":\"%s\",\"startToken\":\"%s\"}\\n' \"$$\" \"$BOBBIT_POSIX_SENTINEL_PGID\" \"$BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE\" \"$__bobbit_sentinel_kind\" \"$__bobbit_sentinel_start\" > \"$__bobbit_sentinel_tmp\" && mv \"$__bobbit_sentinel_tmp\" \"$BOBBIT_POSIX_SENTINEL_IDENTITY_FILE\" || { rm -f \"$__bobbit_sentinel_tmp\"; exit 125; }; fi; printf . >&3; exec 3>&-; while :; do sleep 2147483647 & wait $!; done";
// Capture the group leader before starting the sentinel. Its `$PPID` is not a
// stable identity: a fast root exit can reparent the background shell first.
// The sentinel's `$0` is a process-held nonce witness on Darwin. It is not
// inherited by the payload, which starts only after these variables are unset.
const POSIX_TREE_SENTINEL_SCRIPT = "__bobbit_sentinel_pgid=$$; export BOBBIT_POSIX_SENTINEL_PGID=\"$__bobbit_sentinel_pgid\"; /bin/sh -c \"$BOBBIT_POSIX_TREE_SENTINEL_CHILD_SCRIPT\" \"bobbit-posix-sentinel:$BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE\" & unset BOBBIT_POSIX_SENTINEL_PGID BOBBIT_POSIX_SENTINEL_IDENTITY_FILE BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE BOBBIT_POSIX_TREE_SENTINEL_CHILD_SCRIPT; exec 3>&-; exec \"$@\"";

function withPosixSentinelReadyPipe(stdio: StdioOptions | undefined): StdioOptions {
	if (Array.isArray(stdio)) return [...stdio.slice(0, 3), "pipe", ...stdio.slice(3)] as StdioOptions;
	const standard = stdio ?? "pipe";
	return [standard, standard, standard, "pipe"] as StdioOptions;
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
	// Only a real Windows spawn enables the supervisor by default. Platform
	// seams must opt in so their fake root remains inspectable and does not
	// require PowerShell merely to exercise state transitions.
	const posixTreeSentinel = opts.posixTreeSentinel ?? (!isWin && opts.spawnImpl == null);
	const retainPosixSentinelForContainerTransport = !!opts.retainPosixSentinelForContainerTransport;
	if (retainPosixSentinelForContainerTransport && (!posixTreeSentinel || !opts.posixSentinelIdentity)) {
		throw new Error("Container transport sentinel retention requires a POSIX sentinel identity.");
	}
	const windowsJobSupervisor = opts.windowsJobSupervisor ?? (isWin && opts.spawnImpl == null);
	// Arm the observer before spawning the supervisor: a fast successful
	// assignment cannot publish and exit between spawn() and watch().
	const windowsJobReadiness = windowsJobSupervisor ? createWindowsJobReadiness() : undefined;
	// Completion-proof transports must be closed by their supervisor, not by
	// TerminateProcess on the only process capable of writing that proof.
	const windowsJobShutdownPipe = windowsJobSupervisor && opts.windowsJobCompletion
		? `bobbit-job-${randomUUID()}`
		: undefined;
	const windowsPayload = windowsJobSupervisor
		? Buffer.from(JSON.stringify({
			file: cmd,
			args,
			cwd: opts.cwd ?? process.cwd(),
		}), "utf8").toString("base64")
		: undefined;
	const sentinelEnv = posixTreeSentinel
		? {
			...(opts.env ?? process.env),
			BOBBIT_POSIX_TREE_SENTINEL_CHILD_SCRIPT: POSIX_TREE_SENTINEL_CHILD_SCRIPT,
			...(opts.posixSentinelIdentity ? {
				BOBBIT_POSIX_SENTINEL_IDENTITY_FILE: opts.posixSentinelIdentity.file,
				BOBBIT_POSIX_SENTINEL_IDENTITY_NONCE: opts.posixSentinelIdentity.nonce,
			} : {}),
		}
		: opts.env;
	let child: ChildProcess;
	try {
		child = spawnImpl(
			windowsJobSupervisor ? "powershell.exe" : (posixTreeSentinel ? "/bin/sh" : cmd),
			(windowsJobSupervisor
				? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_JOB_SUPERVISOR_COMMAND]
				: posixTreeSentinel ? ["-c", POSIX_TREE_SENTINEL_SCRIPT, "bobbit-tree-sentinel", cmd, ...args] : args) as string[],
			{
				cwd: opts.cwd,
				env: windowsJobSupervisor
					? {
						...(opts.env ?? process.env),
						BOBBIT_WINDOWS_JOB_PAYLOAD: windowsPayload,
						BOBBIT_WINDOWS_JOB_READY_FILE: windowsJobReadiness!.file,
						...(opts.windowsJobCompletion ? {
							BOBBIT_WINDOWS_JOB_COMPLETION_FILE: opts.windowsJobCompletion.file,
							BOBBIT_WINDOWS_JOB_COMPLETION_NONCE: opts.windowsJobCompletion.nonce,
							...(windowsJobShutdownPipe ? { BOBBIT_WINDOWS_JOB_SHUTDOWN_PIPE: windowsJobShutdownPipe } : {}),
						} : {}),
					}
					: sentinelEnv,
				stdio: posixTreeSentinel ? withPosixSentinelReadyPipe(opts.stdio) : opts.stdio,
				// POSIX: detached:true puts the child in its own process group so we
				// can kill the whole tree via process.kill(-pgid, sig).
				detached: !isWin,
				windowsHide: opts.windowsHide ?? isWin,
			},
		);
	} catch (error) {
		windowsJobReadiness?.fail();
		windowsJobReadiness?.cleanup();
		throw error;
	}
	// Covers a supervisor that acknowledged synchronously before the watcher
	// callback could be dispatched; this is observation, never polling.
	windowsJobReadiness?.confirm();

	let resolveWindowsSupervisorClosed!: () => void;
	const windowsSupervisorClosed = new Promise<void>(resolve => { resolveWindowsSupervisorClosed = resolve; });
	let resolveOwnershipReady!: () => void;
	let rejectOwnershipReady!: (error: Error) => void;
	const platformOwnershipReady = (posixTreeSentinel || windowsJobSupervisor)
		? new Promise<void>((resolve, reject) => { resolveOwnershipReady = resolve; rejectOwnershipReady = reject; })
		: isWin
			? Promise.reject(new Error(WINDOWS_JOB_READINESS_FAILURE))
			: Promise.resolve();
	// Container witness publication is a spawn-site prerequisite, never a
	// second authority. Consumers observe one readiness boundary.
	const ownershipReady = opts.extraOwnershipReady
		? Promise.all([platformOwnershipReady, opts.extraOwnershipReady]).then(() => undefined)
		: platformOwnershipReady;
	// Production callers are not required to await this diagnostic/lifecycle
	// barrier. Observe rejection internally while retaining it for consumers.
	void ownershipReady.catch(() => {});
	const tracked: InternalTracked = {
		child,
		ownershipReady,
		_pid: child.pid,
		_killed: false,
		_timedOut: false,
		_exited: false,
		_closed: false,
		_processGroupOwnershipLost: false,
		_posixFinalSignalSent: false,
		_retainPosixSentinelForContainerTransport: retainPosixSentinelForContainerTransport,
		_posixSentinelIdentity: opts.posixSentinelIdentity,
		_posixSentinelOwned: posixTreeSentinel,
		_posixSentinelReady: !posixTreeSentinel,
		_pendingPosixFinalization: false,
		_treeCompletionUnverified: false,
		_survivesShutdown: false,
		_windowsJobOwned: windowsJobSupervisor,
		_windowsJobSurvivalReady: false,
		_windowsSupervisorClosed: windowsSupervisorClosed,
		_windowsJobShutdownPipe: windowsJobShutdownPipe,
		_resolveWindowsSupervisorClosed: resolveWindowsSupervisorClosed,
		killed: () => tracked._killed,
		timedOut: () => tracked._timedOut,
		markSurvival: () => {
			// Ordinary platform readiness remains synchronous at this boundary. Only
			// a container's additional witness must delay survival acknowledgement.
			if (!opts.extraOwnershipReady) {
				tracked._survivesShutdown = true;
				if (tracked._posixSentinelReady) unrefReadyPipe(readyPipe);
				return;
			}
			void ownershipReady.then(() => {
				tracked._survivesShutdown = true;
				if (tracked._posixSentinelReady) unrefReadyPipe(readyPipe);
			}, () => { tracked._survivesShutdown = false; });
		},
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
				// The supervisor owns a Job handle from before the payload first runs.
				// Its close is therefore an ownership-safe tree-completion barrier;
				// unlike taskkill it never names a PID after root exit.
				if (!tracked._windowsJobOwned) return false;
				if (tracked._closed) return true;
				return waitWithTimeout(tracked._windowsSupervisorClosed.then(() => true), timeout);
			}

			// SIGKILL delivery is asynchronous. Once it has been dispatched, later
			// checks are observation only: they never signal this numeric PGID again,
			// so a future reuse can at worst produce an unverified result, never
			// retarget an unrelated tree.
			if (tracked._posixFinalSignalSent) {
				while (Date.now() < deadline) {
					if (!groupIsAlive(pid)) {
						tracked._processGroupOwnershipLost = true;
						return true;
					}
					await delay(Math.min(TREE_EXIT_POLL_MS, Math.max(1, deadline - Date.now())));
				}
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
				// We only ever signal the still-live supervisor. Windows closes its Job
				// handle on supervisor termination, which kills the payload tree without
				// a taskkill/PID lookup. Never fall back after its exit boundary.
				if (!tracked._windowsJobOwned || tracked._exited || tracked._closed) return;
				tracked._killed = true;
				tracked._survivesShutdown = false;
				if (tracked._windowsJobShutdownPipe) {
					// The private pipe is consumed by the supervisor, which terminates the
					// payload then executes its finally block to close the Job and atomically
					// publish the nonce-bound completion proof.
					requestWindowsJobClose(tracked._windowsJobShutdownPipe);
					return;
				}
				try { child.kill(signal); } catch { /* supervisor may have just exited */ }
				return;
			}

			const pid = tracked._pid;
			if (pid == null || tracked._processGroupOwnershipLost || tracked._posixFinalSignalSent) return;
			if (tracked._posixSentinelOwned && !tracked._posixSentinelReady && signal !== "SIGKILL") {
				// Do not race the sentinel's trap installation with SIGTERM. Holding
				// that graceful intent until its FD-3 acknowledgement means our own
				// SIGTERM cannot kill the sentinel before it has made PGID ownership
				// durable. SIGKILL needs no trap and must not wait on an acknowledgement:
				// force cleanup must still settle `close` if the pre-exec shell never
				// reaches its FD-3 write.
				tracked._killed = true;
				tracked._survivesShutdown = false;
				tracked._pendingPosixKill = { signal, graceMsOverride };
				return;
			}
			// Once the docker CLI root exits, only the retained sentinel's exact
			// PID/start-token/PGID/nonce tuple may authorize the final host signal.
			// A missing or reused sentinel is pending/unverified, never proof that
			// the historical group completed and never authority to signal its number.
			if (tracked._retainPosixSentinelForContainerTransport && tracked._exited && !tracked._posixFinalSignalSent) {
				const identity = tracked._posixSentinelIdentity;
				let record: { pid?: unknown; pgid?: unknown; nonce?: unknown; startTokenKind?: unknown; startToken?: unknown } | undefined;
				try { record = identity ? JSON.parse(readFileSync(identity.file, "utf8")) : undefined; } catch { /* fail closed below */ }
				const sentinelPid = Number(record?.pid);
				const inspector = opts.posixSentinelIdentityInspector ?? (candidate => inspectPosixSentinelIdentity(candidate, opts.platform ?? process.platform));
				const current = Number.isFinite(sentinelPid) && sentinelPid > 0 ? inspector(sentinelPid) : undefined;
				const darwinNonceMatches = record?.startTokenKind !== "darwin-lstart-argv-nonce" || current?.sentinelNonce === identity?.nonce;
				if (!identity || record?.nonce !== identity.nonce || Number(record?.pgid) !== pid ||
					!current || current.pgid !== pid || current.startTokenKind !== record?.startTokenKind ||
					current.startToken !== record?.startToken || !darwinNonceMatches) {
					tracked._treeCompletionUnverified = true;
					tracked._processGroupOwnershipLost = true;
					registry.delete(tracked);
					return;
				}
			}
			if (!groupIsAlive(pid)) {
				if (tracked._retainPosixSentinelForContainerTransport && !tracked._posixFinalSignalSent) tracked._treeCompletionUnverified = true;
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

	// Register before observing any readiness failure. A missing/closed pipe can
	// settle synchronously; adding the entry afterwards would resurrect a child
	// that the failure path deliberately removed.
	registry.add(tracked);
	// A rejected external prerequisite (for example an in-container witness)
	// fails closed while this live tracked child is still the sole authority.
	if (opts.extraOwnershipReady) void opts.extraOwnershipReady.catch(() => tracked.killTree("SIGKILL"));

	// A timeout measures owned payload execution, not sentinel/Job setup. Arming
	// it before the ownership boundary races cold process startup and can kill a
	// payload before it ever runs. The readiness callbacks below invoke this
	// synchronously with their acknowledgement; platforms without a boundary arm
	// immediately to retain their existing attached-process semantics.
	const armTimeout = () => {
		if (tracked._timeoutTimer || opts.timeoutMs == null || opts.timeoutMs <= 0 || tracked._closed) return;
		tracked._timeoutTimer = clock.setTimeout(() => {
			if (tracked._closed) return;
			tracked._timedOut = true;
			try { opts.onTimeout?.(); } catch { /* ignore */ }
			tracked.killTree("SIGTERM");
		}, opts.timeoutMs);
		unrefTimer(tracked._timeoutTimer);
	};
	if (!posixTreeSentinel && !windowsJobSupervisor) armTimeout();

	if (windowsJobReadiness) {
		void windowsJobReadiness.ready.then(
			() => {
				tracked._windowsJobSurvivalReady = true;
				windowsJobReadiness.cleanup();
				armTimeout();
				resolveOwnershipReady();
			},
			() => {
				windowsJobReadiness.cleanup();
				rejectOwnershipReady(new Error(WINDOWS_JOB_READINESS_FAILURE));
				tracked._survivesShutdown = false;
				// A watcher/readiness failure is not evidence that a live supervisor
				// owns its payload. Reap it while its PID is still our witness.
				if (!tracked._closed) tracked.killTree("SIGKILL");
			},
		);
	}


	const clearEscalation = () => {
		if (tracked._escalationTimer) clock.clearTimeout(tracked._escalationTimer);
		tracked._escalationTimer = undefined;
	};
	const finishPosixAtRootExit = () => {
		const pid = tracked._pid;
		if (pid == null || tracked._processGroupOwnershipLost || tracked._posixFinalSignalSent) return;
		if (!tracked._posixSentinelOwned) {
			// A platform seam without the spawn-time sentinel has no durable PGID
			// ownership after root exit. Fail closed rather than retarget a number.
			tracked._treeCompletionUnverified = true;
			tracked._processGroupOwnershipLost = true;
			clearEscalation();
			registry.delete(tracked);
			return;
		}
		if (!tracked._posixSentinelReady) {
			tracked._pendingPosixFinalization = true;
			return;
		}
		// Container transport handoff deliberately retains this exact sentinel.
		// `docker exec` can report its root result before the host has durably
		// recorded it and reaped the exact in-container payload group. The live
		// sentinel preserves the PGID until that payload→transport handoff, and
		// also survives a crash for `_reapRecoveredPosixSentinel` to verify.
		if (tracked._retainPosixSentinelForContainerTransport) {
			clearEscalation();
			return;
		}
		// The sentinel ignores graceful terminal signals and is still a member of
		// this group until this final SIGKILL. That spawn-time ownership removes
		// the empty-group/PGID-reuse gap at root exit.
		try { signalProcessGroup(pid, "SIGKILL"); } catch { /* already gone */ }
		tracked._posixFinalSignalSent = true;
		clearEscalation();
		registry.delete(tracked);
	};
	const readyPipe = posixTreeSentinel ? child.stdio[3] : undefined;
	if (posixTreeSentinel && !readyPipe) {
		// This should be unreachable because we add FD 3 above. Do not silently
		// assume ownership if a future caller changes the stdio construction.
		tracked._treeCompletionUnverified = true;
		rejectOwnershipReady(new Error(POSIX_SENTINEL_READINESS_FAILURE));
	}
	readyPipe?.once("data", () => {
		tracked._posixSentinelReady = true;
		armTimeout();
		resolveOwnershipReady();
		if (tracked._pendingPosixFinalization) {
			tracked._pendingPosixFinalization = false;
			finishPosixAtRootExit();
			return;
		}
		const pending = tracked._pendingPosixKill;
		tracked._pendingPosixKill = undefined;
		if (pending) tracked.killTree(pending.signal, pending.graceMsOverride);
		// markSurvival() may happen before the asynchronous FD-3 handshake.
		// Once durable ownership is established, FD 3 must not retain the
		// gateway event loop for the lifetime of the surviving payload.
		if (tracked._survivesShutdown) unrefReadyPipe(readyPipe);
	});
	const failPosixSentinelHandshake = () => {
		if (tracked._posixSentinelReady || isWin) return;
		// Stream errors vary by platform and Node release. Consumers require one
		// stable, specific contract for a failed ownership barrier.
		rejectOwnershipReady(new Error(POSIX_SENTINEL_READINESS_FAILURE));
		const pid = tracked._pid;
		tracked._pendingPosixKill = undefined;
		tracked._pendingPosixFinalization = false;
		clearEscalation();
		// Before root exit, this detached leader is still our ownership witness.
		// Kill the group synchronously so a failed identity publication cannot
		// leave its payload alive. After root exit, never name its old PGID again.
		if (pid != null && !tracked._exited && !tracked._processGroupOwnershipLost && groupIsAlive(pid)) {
			try { signalProcessGroup(pid, "SIGKILL"); } catch { /* already gone */ }
			tracked._posixFinalSignalSent = true;
		} else {
			tracked._treeCompletionUnverified = true;
			tracked._processGroupOwnershipLost = true;
		}
		tracked._survivesShutdown = false;
		registry.delete(tracked);
	};
	if (posixTreeSentinel && !readyPipe) failPosixSentinelHandshake();
	readyPipe?.once("error", failPosixSentinelHandshake);
	readyPipe?.once("close", failPosixSentinelHandshake);
	// The shell/sentinel can fail before the listeners above are installed.
	// Node then records the stream terminal state without replaying `close` to a
	// late subscriber. Settle the exact production promise rather than leaving
	// a live caller awaiting a handshake that can no longer arrive.
	const sentinelReadyPipe = readyPipe as import("node:stream").Readable | undefined;
	if (sentinelReadyPipe && (sentinelReadyPipe.destroyed || sentinelReadyPipe.readableEnded)) {
		failPosixSentinelHandshake();
	}
	const onExit = () => {
		tracked._exited = true;
		if (!isWin) {
			// This also covers an apparently successful shell exit. A descendant
			// retaining inherited stdio must neither survive nor turn that root code
			// into a false successful command result.
			finishPosixAtRootExit();
		}
	};
	const onClose = () => {
		tracked._closed = true;
		if (isWin && windowsJobReadiness && !windowsJobReadiness.confirm()) {
			windowsJobReadiness.fail();
		}
		if (!isWin && tracked._posixSentinelOwned && !tracked._posixSentinelReady) {
			// A broken sentinel handshake means we never established the ownership
			// barrier. Never turn the leader's close into a successful tree result.
			tracked._treeCompletionUnverified = true;
			tracked._processGroupOwnershipLost = true;
		}
		tracked._resolveWindowsSupervisorClosed();
		if (tracked._timeoutTimer) clock.clearTimeout(tracked._timeoutTimer);
		if (!isWin) clearEscalation();
		registry.delete(tracked);
	};
	child.once("exit", onExit);
	child.once("close", onClose);
	child.once("error", () => {
		// On synchronous spawn failures the child never emits "close"; clear
		// timers and drop from the registry so we don't leak.
		onClose();
	});

	return tracked;
}

/**
 * Kill every tracked child whose subprocess tree is still alive.
 * Called from harness shutdown to ensure no chromium / playwright
 * descendants leak across gateway restarts.
 */
export function killAllTracked(signal: "SIGTERM" | "SIGKILL" = "SIGKILL", includeSurvival = false): void {
	for (const t of Array.from(registry)) {
		// Never infer readiness from a PID. POSIX must acknowledge its sentinel;
		// Windows must observe the supervisor's post-assignment, pre-resume proof.
		if (!includeSurvival && t._survivesShutdown && (
			(t._posixSentinelOwned && t._posixSentinelReady) || t._windowsJobSurvivalReady
		)) continue;
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
