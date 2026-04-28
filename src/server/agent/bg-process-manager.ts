/**
 * Background process manager — spawns and tracks long-running shell processes
 * per session. Agents create bg processes via bash_bg_create tool (extension),
 * which calls the gateway REST API. The manager broadcasts real-time events
 * (output, exit) to connected WebSocket clients.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { getShellConfig } from "./shell-util.js";

/**
 * Function used to spawn the underlying child process. Injected via the
 * constructor so unit tests can supply a fake EventEmitter-backed child
 * without touching the OS. Production wiring uses {@link defaultSpawn}.
 */
export type SpawnFn = (command: string, cwd: string, containerId: string | undefined) => ChildProcess;

function defaultSpawn(command: string, cwd: string, containerId: string | undefined): ChildProcess {
	const { shell: hostShell, args: hostArgs } = getShellConfig();
	// Inside the container: always /bin/sh, use the caller's cwd
	// (which is the container-internal worktree path for sandboxed sessions)
	const shell = containerId ? "/bin/sh" : hostShell;
	const args = containerId ? ["-c"] : hostArgs;
	const containerCwd = cwd;

	if (containerId) {
		console.log(`[bg-process] Docker exec in container ${containerId.substring(0, 12)}, cwd=${containerCwd}`);
	}
	return containerId
		? spawn("docker", ["exec", "-w", containerCwd, containerId, shell, ...args, command], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false, // docker exec manages the process
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		})
		: spawn(shell, [...args, command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: process.env,
		});
}

export interface LogEntry {
	ts: number;
	text: string;
}

export interface BgProcess {
	id: string;
	/** Short human-readable name (max 3 words, agent-generated) */
	name: string;
	command: string;
	pid: number;
	child: ChildProcess;
	stdout: string[];
	stderr: string[];
	/** Combined interleaved output (capped at MAX_LOG_LINES) */
	log: LogEntry[];
	status: "running" | "exited";
	exitCode: number | null;
	startTime: number;
	cwd: string;
	/** If set, process was spawned inside this Docker container */
	containerId?: string;
	/**
	 * Resolves once the child has emitted `exit` AND `status`/`exitCode` have
	 * been updated. Awaiters are guaranteed to observe the post-exit snapshot.
	 * This eliminates the previous "50ms slack" between the exit event and
	 * `status === 'exited'" — and removes a long-standing flake source.
	 */
	exited: Promise<void>;
}

export interface BgProcessInfo {
	id: string;
	/** Short human-readable name (max 3 words, agent-generated) */
	name: string;
	command: string;
	pid: number;
	status: "running" | "exited";
	exitCode: number | null;
	startTime: number;
}

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 512 * 1024; // 512KB per process

// Shell config is provided by the shared shell-util module

export class BgProcessManager {
	/** sessionId → Map<bgId, BgProcess> */
	private processes = new Map<string, Map<string, BgProcess>>();
	/** sessionId → Set<WebSocket> — populated by session manager */
	private clientsProvider: (sessionId: string) => Set<WebSocket> | undefined;
	/** sessionId → in-flight wait AbortControllers. Aborted when a steer arrives. */
	private waits = new Map<string, Set<AbortController>>();
	/** Per-instance id sequence — keeps test runs isolated from each other. */
	private nextId = 1;
	/** Spawner — overridable in tests so unit tests don't touch the OS. */
	private spawnFn: SpawnFn;

	constructor(
		clientsProvider: (sessionId: string) => Set<WebSocket> | undefined,
		spawnFn: SpawnFn = defaultSpawn,
	) {
		this.clientsProvider = clientsProvider;
		this.spawnFn = spawnFn;
	}

	private broadcast(sessionId: string, msg: ServerMessage): void {
		const clients = this.clientsProvider(sessionId);
		if (!clients) return;
		const data = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState === 1) {
				client.send(data);
			}
		}
	}

	create(sessionId: string, command: string, cwd: string, containerId?: string, sandboxed?: boolean, name?: string): BgProcessInfo {
		if (sandboxed && !containerId) {
			throw new Error("Sandboxed session without containerId — refusing host-side execution");
		}
		const id = `bg-${this.nextId++}`;
		const child = this.spawnFn(command, cwd, containerId);

		// Unref so bg process doesn't prevent gateway from exiting (host spawns only)
		if (!containerId && typeof child.unref === "function") child.unref();

		let resolveExited!: () => void;
		const exited = new Promise<void>((res) => { resolveExited = res; });

		const bg: BgProcess = {
			id,
			name: name || id,
			command,
			pid: child.pid!,
			child,
			stdout: [],
			stderr: [],
			log: [],
			status: "running",
			exitCode: null,
			startTime: Date.now(),
			cwd,
			containerId,
			exited,
		};

		let logBytes = 0;

		const appendLog = (line: string) => {
			const entry: LogEntry = { ts: Date.now(), text: line };
			bg.log.push(entry);
			logBytes += line.length;
			// Trim oldest lines if over limits
			while (bg.log.length > MAX_LOG_LINES || logBytes > MAX_LOG_BYTES) {
				const removed = bg.log.shift();
				if (removed) logBytes -= removed.text.length;
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			const ts = Date.now();
			const lines = text.split("\n");
			for (const line of lines) {
				if (line.length > 0) {
					bg.stdout.push(line);
					appendLog(line);
				}
			}
			// Trim stdout buffer
			while (bg.stdout.length > MAX_LOG_LINES) bg.stdout.shift();

			this.broadcast(sessionId, {
				type: "bg_process_output",
				processId: id,
				stream: "stdout",
				text,
				ts,
			} as any);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			const ts = Date.now();
			const lines = text.split("\n");
			for (const line of lines) {
				if (line.length > 0) {
					bg.stderr.push(line);
					appendLog(line);
				}
			}
			while (bg.stderr.length > MAX_LOG_LINES) bg.stderr.shift();

			this.broadcast(sessionId, {
				type: "bg_process_output",
				processId: id,
				stream: "stderr",
				text,
				ts,
			} as any);
		});

		// Listen on 'exit' not 'close' — exit fires when the process itself ends,
		// close waits for all FD holders (grandchildren) to release pipes.
		child.on("exit", (code) => {
			bg.status = "exited";
			bg.exitCode = code;
			// Resolve BEFORE broadcast/destroy so any awaiter on `bg.exited`
			// observes status === 'exited' the moment they're scheduled.
			resolveExited();
			// Destroy pipes to avoid lingering from grandchild processes
			child.stdout?.destroy();
			child.stderr?.destroy();

			this.broadcast(sessionId, {
				type: "bg_process_exited",
				processId: id,
				exitCode: code,
			} as any);
		});

		if (!this.processes.has(sessionId)) {
			this.processes.set(sessionId, new Map());
		}
		this.processes.get(sessionId)!.set(id, bg);

		this.broadcast(sessionId, {
			type: "bg_process_created",
			process: this.toInfo(bg),
		} as any);

		return this.toInfo(bg);
	}

	list(sessionId: string): BgProcessInfo[] {
		const map = this.processes.get(sessionId);
		if (!map) return [];
		return Array.from(map.values()).map((bg) => this.toInfo(bg));
	}

	getLogs(sessionId: string, processId: string): { log: LogEntry[]; stdout: string[]; stderr: string[] } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log, stdout: bg.stdout, stderr: bg.stderr };
	}

	/** Search logs for a pattern (string or regex). Returns matching lines with context. */
	grepLogs(sessionId: string, processId: string, pattern: string, contextLines = 0, maxResults = 50): { matches: { line: number; ts: number; text: string }[]; total: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;

		let regex: RegExp;
		try {
			regex = new RegExp(pattern, "i");
		} catch {
			// Fall back to literal match if invalid regex
			regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		}

		const log = bg.log;
		const matchIndices: number[] = [];
		for (let i = 0; i < log.length; i++) {
			if (regex.test(log[i].text)) matchIndices.push(i);
		}

		const total = matchIndices.length;
		// Collect matches with context, deduplicating overlapping ranges
		const seen = new Set<number>();
		const matches: { line: number; ts: number; text: string }[] = [];
		for (const idx of matchIndices.slice(0, maxResults)) {
			const start = Math.max(0, idx - contextLines);
			const end = Math.min(log.length - 1, idx + contextLines);
			for (let i = start; i <= end; i++) {
				if (!seen.has(i)) {
					seen.add(i);
					matches.push({ line: i + 1, ts: log[i].ts, text: log[i].text });
				}
			}
		}

		return { matches, total };
	}

	/** Get first N lines of logs. */
	headLogs(sessionId: string, processId: string, lines = 50): { log: LogEntry[]; totalLines: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log.slice(0, lines), totalLines: bg.log.length };
	}

	/** Get a range of log lines (1-indexed). */
	sliceLogs(sessionId: string, processId: string, from: number, to: number): { log: LogEntry[]; totalLines: number } | null {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		return { log: bg.log.slice(Math.max(0, from - 1), to), totalLines: bg.log.length };
	}

	kill(sessionId: string, processId: string): boolean {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg || bg.status !== "running") return false;

		try {
			if (bg.containerId) {
				// Docker exec: kill the docker exec process on host, which signals the container process
				try { bg.child.kill("SIGTERM"); } catch { /* ignore */ }
			} else if (bg.child.pid) {
				// Kill the process group (detached processes get their own group)
				if (process.platform === "win32") {
					// Windows: use taskkill to kill the tree
					spawn("taskkill", ["/pid", String(bg.child.pid), "/T", "/F"], { stdio: "ignore" });
				} else {
					process.kill(-bg.child.pid, "SIGTERM");
				}
			}
		} catch {
			// Process may already be dead
			try { bg.child.kill("SIGKILL"); } catch { /* ignore */ }
		}
		return true;
	}

	/** Remove an exited process from the map. Returns true if removed. */
	remove(sessionId: string, processId: string): boolean {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return false;
		if (bg.status === "running") return false; // must kill first
		this.processes.get(sessionId)!.delete(processId);
		if (this.processes.get(sessionId)!.size === 0) this.processes.delete(sessionId);
		return true;
	}

	/** Clean up all bg processes for a session (on terminate) */
	cleanup(sessionId: string): void {
		// Release any hanging wait handlers first so the HTTP responses resolve cleanly.
		this.abortAllWaits(sessionId);
		const map = this.processes.get(sessionId);
		if (!map) return;
		for (const [, bg] of map) {
			if (bg.status === "running") {
				try { bg.child.kill("SIGTERM"); } catch { /* ignore */ }
			}
		}
		this.processes.delete(sessionId);
	}

	/**
	 * Register an AbortController so that `abortAllWaits(sessionId)` (called from
	 * live-steer call sites or on session termination) can cancel in-flight waits.
	 */
	registerWait(sessionId: string, controller: AbortController): void {
		let set = this.waits.get(sessionId);
		if (!set) {
			set = new Set();
			this.waits.set(sessionId, set);
		}
		set.add(controller);
	}

	/** Unregister a previously registered controller (called in the handler's finally). */
	unregisterWait(sessionId: string, controller: AbortController): void {
		const set = this.waits.get(sessionId);
		if (!set) return;
		set.delete(controller);
		if (set.size === 0) this.waits.delete(sessionId);
	}

	/** Abort every in-flight wait for a session. Leaves the bg processes untouched. */
	abortAllWaits(sessionId: string): void {
		const set = this.waits.get(sessionId);
		if (!set) return;
		for (const controller of set) {
			try { controller.abort(); } catch { /* ignore */ }
		}
		// cleanup happens via unregisterWait in the handler's finally
	}

	/**
	 * Wait for a process to exit, the timeout to fire, or the provided AbortSignal.
	 * Return shape is additive — happy-path/timeout set `aborted: false`; on abort
	 * the process is left running and `info` is a snapshot (status still running).
	 */
	async waitForExit(sessionId: string, processId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ info: BgProcessInfo; timedOut: boolean; aborted: boolean } | null> {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		if (bg.status === "exited") return { info: this.toInfo(bg), timedOut: false, aborted: false };
		if (signal?.aborted) return { info: this.toInfo(bg), timedOut: false, aborted: true };

		// Race exit / timeout / abort. We do NOT attach an "exit" listener to the
		// child — instead we await `bg.exited`, which is resolved by the single
		// listener installed in create() AFTER status/exitCode are updated. That
		// removes both the "50 ms slack" hack and the per-call exit-listener leak.
		let timer: ReturnType<typeof setTimeout> | null = null;
		let onAbort: (() => void) | null = null;

		const timeoutP = new Promise<"timeout">((res) => {
			timer = setTimeout(() => res("timeout"), timeoutMs);
		});
		const abortP = new Promise<"abort">((res) => {
			if (!signal) return; // never resolves — Promise.race ignores it
			onAbort = () => res("abort");
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const exitP = bg.exited.then(() => "exit" as const);

		try {
			const winner = await Promise.race([exitP, timeoutP, abortP]);
			return {
				info: this.toInfo(bg),
				timedOut: winner === "timeout",
				aborted: winner === "abort",
			};
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Remove exited processes from the map */
	prune(sessionId: string): void {
		const map = this.processes.get(sessionId);
		if (!map) return;
		for (const [id, bg] of map) {
			if (bg.status === "exited") map.delete(id);
		}
		if (map.size === 0) this.processes.delete(sessionId);
	}

	private toInfo(bg: BgProcess): BgProcessInfo {
		return {
			id: bg.id,
			name: bg.name,
			command: bg.command,
			pid: bg.pid,
			status: bg.status,
			exitCode: bg.exitCode,
			startTime: bg.startTime,
		};
	}
}
