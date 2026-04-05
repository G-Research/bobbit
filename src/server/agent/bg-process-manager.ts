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

let nextId = 1;

// Shell config is provided by the shared shell-util module

export class BgProcessManager {
	/** sessionId → Map<bgId, BgProcess> */
	private processes = new Map<string, Map<string, BgProcess>>();
	/** sessionId → Set<WebSocket> — populated by session manager */
	private clientsProvider: (sessionId: string) => Set<WebSocket> | undefined;

	constructor(clientsProvider: (sessionId: string) => Set<WebSocket> | undefined) {
		this.clientsProvider = clientsProvider;
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
		const id = `bg-${nextId++}`;
		const { shell: hostShell, args: hostArgs } = getShellConfig();

		// Inside the container: always /bin/sh, use the caller's cwd
		// (which is the container-internal worktree path for sandboxed sessions)
		const shell = containerId ? "/bin/sh" : hostShell;
		const args = containerId ? ["-c"] : hostArgs;
		const containerCwd = cwd;

		if (containerId) {
			console.log(`[bg-process] Docker exec in container ${containerId.substring(0, 12)}, cwd=${containerCwd}`);
		}
		const child = containerId
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

		// Unref so bg process doesn't prevent gateway from exiting (host spawns only)
		if (!containerId) child.unref();

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
		const map = this.processes.get(sessionId);
		if (!map) return;
		for (const [, bg] of map) {
			if (bg.status === "running") {
				try { bg.child.kill("SIGTERM"); } catch { /* ignore */ }
			}
		}
		this.processes.delete(sessionId);
	}

	/** Wait for a process to exit or timeout. Returns the process info and whether it timed out. */
	async waitForExit(sessionId: string, processId: string, timeoutMs: number): Promise<{ info: BgProcessInfo; timedOut: boolean } | null> {
		const bg = this.processes.get(sessionId)?.get(processId);
		if (!bg) return null;
		if (bg.status === "exited") return { info: this.toInfo(bg), timedOut: false };

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				bg.child.removeListener("exit", onExit);
				resolve({ info: this.toInfo(bg), timedOut: true });
			}, timeoutMs);

			const onExit = () => {
				clearTimeout(timer);
				// Small delay to let the exit handler update status
				setTimeout(() => resolve({ info: this.toInfo(bg), timedOut: false }), 50);
			};
			bg.child.once("exit", onExit);
		});
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
