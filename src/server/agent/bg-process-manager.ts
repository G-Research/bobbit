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

	create(sessionId: string, command: string, cwd: string, containerId?: string): BgProcessInfo {
		const id = `bg-${nextId++}`;
		const { shell: hostShell, args: hostArgs } = getShellConfig();

		// Inside the container: always /bin/sh, workspace at /workspace
		const shell = containerId ? "/bin/sh" : hostShell;
		const args = containerId ? ["-c"] : hostArgs;
		const containerCwd = containerId ? "/workspace" : cwd;

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
			command: bg.command,
			pid: bg.pid,
			status: bg.status,
			exitCode: bg.exitCode,
			startTime: bg.startTime,
		};
	}
}
