// src/server/extension-host/channel-pty-helper.ts
//
// Narrow first-party PTY helper for channel handlers that explicitly declare
// `capabilities: [sessionPty]`. Generic channel modules receive no PTY surface.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { ChannelError, type ChannelAuditEvent, type ChannelContributionRef } from "./channel-types.js";

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
	audit?: (event: ChannelAuditEvent) => void;
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
	private readonly audit?: (event: ChannelAuditEvent) => void;

	constructor(opts: ChannelPtyServiceOptions = {}) {
		this.sessionManager = opts.sessionManager;
		this.injectedPtyModule = opts.ptyModule;
		this.audit = opts.audit;
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
			this.audit?.({ type: "pty.spawn", at: Date.now(), sessionId, reason: "spawned" });
		} catch (err) {
			this.audit?.({ type: "pty.spawn", at: Date.now(), sessionId, error: err instanceof Error ? err.message : String(err) });
			throw new ChannelError(500, "pty_spawn_failed", `Terminal failed to start: ${err instanceof Error ? err.message : String(err)}`);
		}
		return wrapPty(proc, (event) => this.audit?.({ type: "pty.exit", at: Date.now(), sessionId, reason: event.reason, error: event.signal !== undefined ? String(event.signal) : undefined }));
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

function wrapPty(proc: PtyProcess, auditExit?: (event: ChannelPtyExitEvent) => void): ChannelPtyHandle {
	const dataListeners = new Set<(data: string) => void>();
	const exitListeners = new Set<(event: ChannelPtyExitEvent) => void>();
	let exited = false;
	let killReason: string | undefined;
	let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	const emitExit = (code: number | null, signal?: string | number) => {
		if (exited) return;
		exited = true;
		if (killFallbackTimer) clearTimeout(killFallbackTimer);
		const event = { code, signal, reason: killReason };
		auditExit?.(event);
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
			if (process.platform === "win32") {
				// node-pty's Windows process-tree kill can fail in headless hosts when
				// its ConPTY console-list helper cannot attach. The terminal helper always
				// starts an interactive shell, so ask the shell to exit first and leave the
				// native kill as a delayed fallback. This keeps Kill deterministic without
				// exposing process internals to the pack.
				try { proc.write("\x03"); } catch { /* process may already be gone */ }
				try { proc.write("exit\r\n"); } catch { /* process may already be gone */ }
				killFallbackTimer = setTimeout(() => {
					if (!exited) taskkillWindowsProcessTree(proc.pid);
				}, 1_000);
				killFallbackTimer.unref?.();
				return;
			}
			try { proc.kill(); } catch { /* process may already be gone */ }
		},
		onData: (cb) => { dataListeners.add(cb); return () => { dataListeners.delete(cb); }; },
		onExit: (cb) => { exitListeners.add(cb); return () => { exitListeners.delete(cb); }; },
	};
}

function taskkillWindowsProcessTree(pid: number): void {
	if (!Number.isFinite(pid) || pid <= 0) return;
	execFile("taskkill.exe", ["/PID", String(Math.floor(pid)), "/T", "/F"], {
		windowsHide: true,
		env: windowsProcessControlEnv(),
	}, () => undefined);
}

function windowsProcessControlEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["SystemRoot", "windir", "PATH", "Path", "PATHEXT", "TEMP", "TMP"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function defaultShell(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: process.env.ComSpec || "cmd.exe", args: [] };
	}
	return { shell: process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash"), args: [] };
}

const COMMON_ENV_ALLOWLIST = new Set([
	"PATH",
	"Path",
	"TERM",
	"COLORTERM",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_COLLATE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"NO_COLOR",
	"FORCE_COLOR",
]);

const POSIX_ENV_ALLOWLIST = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	// Shell-config-location variable in the same family as SHELL/HOME: zsh
	// resolves its rc files from $ZDOTDIR. Stripping it silently loads the
	// wrong (HOME-based) config for users whose environment relocates it, and
	// the E2E harness relies on it to point spawned shells at a hermetic,
	// rc-free directory so terminal specs never execute developer dotfiles.
	"ZDOTDIR",
]);

const WINDOWS_ENV_ALLOWLIST = new Set([
	"SystemRoot",
	"windir",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"USERNAME",
	"HOMEDRIVE",
	"HOMEPATH",
	"ComSpec",
	"PATHEXT",
]);

function terminalEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	const platformAllowlist = process.platform === "win32" ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (!COMMON_ENV_ALLOWLIST.has(key) && !platformAllowlist.has(key)) continue;
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
