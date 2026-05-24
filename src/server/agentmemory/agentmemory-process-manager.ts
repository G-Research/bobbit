/**
 * Small subprocess supervisor for Bobbit-managed AgentMemory daemons.
 *
 * Design constraints (see docs/design/agentmemory-integration.md):
 *
 * - Process is only started after an explicit user action (REST POST
 *   /api/agentmemory/start). We never auto-start at boot.
 * - We must NOT silently run Docker or invoke installers. The default
 *   command is `npx -y <package>` which fetches its own deps — but the
 *   caller is responsible for surfacing that to the user via UI confirm.
 * - All output is captured to a rotating log file so the UI can tail it.
 * - Crash backoff resets on every successful explicit start.
 *
 * The supervisor is intentionally small — anything more elaborate
 * (auto-restart-forever, health pings, port allocation) belongs in
 * AgentMemoryManager.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessSpawnOpts {
	/** Executable to run (default: "npx"). */
	command?: string;
	/** Args passed to the executable. */
	args: string[];
	/** Working directory for the child. */
	cwd?: string;
	/** Extra env overlay; merged onto process.env. */
	env?: Record<string, string>;
	/** Where to write rotating logs. Created if missing. */
	logFile: string;
	/** Capped retained log size in bytes (default: 256 KiB). */
	logMaxBytes?: number;
}

export type ProcState = "stopped" | "starting" | "running" | "exited" | "errored";

export interface ProcStatus {
	state: ProcState;
	pid: number | null;
	startedAt: number | null;
	exitedAt: number | null;
	exitCode: number | null;
	exitSignal: string | null;
	lastError: string | null;
	command: string | null;
	args: string[];
}

export interface ProcessManagerHooks {
	onStateChange?: (s: ProcStatus) => void;
}

export class AgentMemoryProcessManager {
	private child: ChildProcess | null = null;
	private state: ProcState = "stopped";
	private startedAt: number | null = null;
	private exitedAt: number | null = null;
	private exitCode: number | null = null;
	private exitSignal: string | null = null;
	private lastError: string | null = null;
	private command: string | null = null;
	private args: string[] = [];
	private logFile: string | null = null;
	private logMaxBytes = 256 * 1024;
	private hooks: ProcessManagerHooks;

	constructor(hooks: ProcessManagerHooks = {}) {
		this.hooks = hooks;
	}

	getStatus(): ProcStatus {
		return {
			state: this.state,
			pid: this.child?.pid ?? null,
			startedAt: this.startedAt,
			exitedAt: this.exitedAt,
			exitCode: this.exitCode,
			exitSignal: this.exitSignal,
			lastError: this.lastError,
			command: this.command,
			args: [...this.args],
		};
	}

	isRunning(): boolean {
		return this.state === "running" || this.state === "starting";
	}

	/** Start the child process. Throws if already running. */
	start(opts: ProcessSpawnOpts): ProcStatus {
		if (this.isRunning()) {
			throw new Error(`AgentMemory process is already ${this.state} (pid=${this.child?.pid ?? "?"})`);
		}
		const cmd = opts.command ?? "npx";
		const args = [...opts.args];
		this.lastError = null;
		this.command = cmd;
		this.args = args;
		this.startedAt = Date.now();
		this.exitedAt = null;
		this.exitCode = null;
		this.exitSignal = null;
		this.logFile = opts.logFile;
		this.logMaxBytes = opts.logMaxBytes ?? this.logMaxBytes;
		this.state = "starting";
		this.emit();

		try {
			fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
			// Truncate or rotate the log file.
			fs.writeFileSync(opts.logFile, `[${new Date().toISOString()}] starting ${cmd} ${args.join(" ")}\n`, "utf-8");
		} catch (err) {
			this.state = "errored";
			this.lastError = `Failed to prepare log file: ${(err as Error).message}`;
			this.emit();
			throw err;
		}

		let child: ChildProcess;
		try {
			child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: { ...process.env, ...(opts.env ?? {}) },
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
		} catch (err) {
			this.state = "errored";
			this.lastError = `spawn failed: ${(err as Error).message}`;
			this.emit();
			throw err;
		}
		this.child = child;

		const append = (chunk: Buffer | string): void => {
			try {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
				if (this.logFile) {
					// Cheap rotation: if file exceeds cap, keep tail half.
					try {
						const st = fs.statSync(this.logFile);
						if (st.size + text.length > this.logMaxBytes) {
							const keep = Math.floor(this.logMaxBytes / 2);
							const buf = Buffer.alloc(keep);
							const fd = fs.openSync(this.logFile, "r");
							try { fs.readSync(fd, buf, 0, keep, Math.max(0, st.size - keep)); } finally { fs.closeSync(fd); }
							fs.writeFileSync(this.logFile, buf.toString("utf-8"), "utf-8");
						}
					} catch { /* ignore */ }
					fs.appendFileSync(this.logFile, text, "utf-8");
				}
			} catch { /* ignore log errors */ }
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		child.on("error", (err: Error) => {
			this.lastError = err.message;
			if (this.state === "starting") this.state = "errored";
			this.emit();
		});
		child.on("spawn", () => {
			if (this.state === "starting") {
				this.state = "running";
				this.emit();
			}
		});
		child.on("exit", (code, signal) => {
			this.exitedAt = Date.now();
			this.exitCode = code;
			this.exitSignal = signal;
			this.state = (code === 0 || signal === "SIGTERM") ? "exited" : "errored";
			this.child = null;
			this.emit();
		});

		return this.getStatus();
	}

	/** Stop the child process. Sends SIGTERM and waits up to timeoutMs. */
	async stop(timeoutMs = 5000): Promise<ProcStatus> {
		const child = this.child;
		if (!child || !this.isRunning()) {
			this.state = this.state === "starting" ? "stopped" : this.state;
			return this.getStatus();
		}
		try { child.kill("SIGTERM"); } catch { /* ignore */ }
		const start = Date.now();
		while (this.child && Date.now() - start < timeoutMs) {
			await new Promise((r) => setTimeout(r, 50));
		}
		if (this.child) {
			try { child.kill("SIGKILL"); } catch { /* ignore */ }
		}
		return this.getStatus();
	}

	/** Read the tail of the log file (UI helper). */
	tailLog(maxBytes = 16 * 1024): string {
		if (!this.logFile) return "";
		try {
			const st = fs.statSync(this.logFile);
			const start = Math.max(0, st.size - maxBytes);
			const buf = Buffer.alloc(st.size - start);
			const fd = fs.openSync(this.logFile, "r");
			try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
			return buf.toString("utf-8");
		} catch {
			return "";
		}
	}

	private emit(): void {
		try { this.hooks.onStateChange?.(this.getStatus()); } catch { /* ignore */ }
	}
}
