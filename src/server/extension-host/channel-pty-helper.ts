// src/server/extension-host/channel-pty-helper.ts
//
// Narrow first-party PTY helper for channel handlers that explicitly declare
// `capabilities: [sessionPty]`. Generic channel modules receive no PTY surface.

import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { ChannelError, type ChannelContributionRef } from "./channel-types.js";

export interface ChannelPtyOpenOptions {
	cols?: number;
	rows?: number;
}

export interface ChannelPtyExitEvent {
	code: number | null;
	signal?: string | number;
	reason?: string;
}

export interface ChannelPtyHandle {
	readonly pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(reason?: string): void;
	onData(cb: (data: string) => void): () => void;
	onExit(cb: (event: ChannelPtyExitEvent) => void): () => void;
}

export interface ChannelPtyHost {
	openTerminal(opts?: ChannelPtyOpenOptions): Promise<ChannelPtyHandle>;
}

export interface ChannelHandlerHostSurface {
	pty?: ChannelPtyHost;
}

type SessionLike = {
	id?: string;
	cwd?: string;
	worktreePath?: string;
	readOnly?: boolean;
	sandboxed?: boolean;
	containerId?: string;
};

type SessionResolver = {
	getSession?: (sessionId: string) => SessionLike | undefined;
	getPersistedSession?: (sessionId: string) => SessionLike | undefined;
};

export interface ChannelPtyServiceOptions {
	sessionManager?: SessionResolver;
	ptyModule?: PtyModule;
}

type PtyProcess = {
	readonly pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData?: (cb: (data: string) => void) => { dispose(): void };
	onExit?: (cb: (event: { exitCode: number; signal?: number }) => void) => { dispose(): void };
	on?: ((event: "data", cb: (data: string) => void) => void) & ((event: "exit", cb: (code: number, signal?: number) => void) => void);
};

type PtyModule = {
	spawn(file: string, args: string[] | string, opts: Record<string, unknown>): PtyProcess;
};

export class ChannelPtyService {
	private readonly sessionManager?: SessionResolver;
	private readonly injectedPtyModule?: PtyModule;

	constructor(opts: ChannelPtyServiceOptions = {}) {
		this.sessionManager = opts.sessionManager;
		this.injectedPtyModule = opts.ptyModule;
	}

	buildHost(contribution: ChannelContributionRef, sessionId: string): ChannelHandlerHostSurface {
		if (!contribution.capabilities?.includes("sessionPty")) return {};
		return {
			pty: {
				openTerminal: (opts?: ChannelPtyOpenOptions) => this.openTerminal(sessionId, opts),
			},
		};
	}

	async openTerminal(sessionId: string, opts: ChannelPtyOpenOptions = {}): Promise<ChannelPtyHandle> {
		const ctx = this.resolveSession(sessionId);
		if (!ctx) {
			throw new ChannelError(404, "pty_session_not_found", "Terminal session context is unavailable.");
		}
		if (ctx.readOnly) {
			throw new ChannelError(403, "pty_read_only", "Terminal is unavailable for read-only sessions.");
		}
		if (ctx.sandboxed) {
			throw new ChannelError(501, "pty_sandbox_unavailable", "Terminal is unavailable for sandboxed sessions until sandbox PTY support is configured.");
		}
		const cwd = ctx.worktreePath || ctx.cwd;
		if (!cwd || !fs.existsSync(cwd)) {
			throw new ChannelError(404, "pty_cwd_unavailable", "Terminal working directory is unavailable.");
		}
		const pty = await this.loadPtyModule();
		const { shell, args } = defaultShell();
		const cols = clampInt(opts.cols, 2, 500, 80);
		const rows = clampInt(opts.rows, 2, 300, 24);
		let proc: PtyProcess;
		try {
			proc = pty.spawn(shell, args, {
				name: "xterm-256color",
				cols,
				rows,
				cwd,
				env: terminalEnv(),
			});
		} catch (err) {
			throw new ChannelError(500, "pty_spawn_failed", `Terminal failed to start: ${err instanceof Error ? err.message : String(err)}`);
		}
		return wrapPty(proc);
	}

	private resolveSession(sessionId: string): SessionLike | undefined {
		const live = this.sessionManager?.getSession?.(sessionId);
		const persisted = this.sessionManager?.getPersistedSession?.(sessionId);
		if (!live && !persisted) return undefined;
		return {
			id: sessionId,
			cwd: live?.cwd ?? persisted?.cwd,
			worktreePath: live?.worktreePath ?? persisted?.worktreePath,
			readOnly: live?.readOnly ?? persisted?.readOnly,
			sandboxed: live?.sandboxed ?? persisted?.sandboxed,
			containerId: live?.containerId ?? persisted?.containerId,
		};
	}

	private async loadPtyModule(): Promise<PtyModule> {
		if (this.injectedPtyModule) return this.injectedPtyModule;
		return await import("@homebridge/node-pty-prebuilt-multiarch") as PtyModule;
	}
}

function wrapPty(proc: PtyProcess): ChannelPtyHandle {
	const dataListeners = new Set<(data: string) => void>();
	const exitListeners = new Set<(event: ChannelPtyExitEvent) => void>();
	let exited = false;
	let killReason: string | undefined;
	const emitExit = (code: number | null, signal?: string | number) => {
		if (exited) return;
		exited = true;
		const event = { code, signal, reason: killReason };
		for (const cb of [...exitListeners]) cb(event);
	};
	if (proc.onData) {
		proc.onData((data) => {
			for (const cb of [...dataListeners]) cb(data);
		});
	} else if (proc.on) {
		proc.on("data", (data) => {
			for (const cb of [...dataListeners]) cb(data);
		});
	}
	if (proc.onExit) {
		proc.onExit((event) => emitExit(typeof event.exitCode === "number" ? event.exitCode : null, event.signal));
	} else if (proc.on) {
		(proc.on as (event: "exit", cb: (code: number, signal?: number) => void) => void)("exit", (code, signal) => emitExit(typeof code === "number" ? code : null, signal));
	}
	return {
		pid: proc.pid,
		write: (data) => { if (!exited) proc.write(data); },
		resize: (cols, rows) => { if (!exited) proc.resize(clampInt(cols, 2, 500, 80), clampInt(rows, 2, 300, 24)); },
		kill: (reason) => {
			if (exited) return;
			killReason = reason || "killed";
			try { proc.kill(); } catch { /* process may already be gone */ }
		},
		onData: (cb) => { dataListeners.add(cb); return () => { dataListeners.delete(cb); }; },
		onExit: (cb) => { exitListeners.add(cb); return () => { exitListeners.delete(cb); }; },
	};
}

function defaultShell(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: process.env.ComSpec || "cmd.exe", args: [] };
	}
	return { shell: process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash"), args: [] };
}

function terminalEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/TOKEN|SECRET|PASSWORD|KEY/i.test(key) && key.startsWith("BOBBIT_")) continue;
		out[key] = value;
	}
	out.TERM = "xterm-256color";
	out.COLORTERM = out.COLORTERM || "truecolor";
	return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(max, Math.max(min, n));
}
