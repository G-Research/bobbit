type HostChannelFrame = { kind: "text"; data: string } | { kind: "json"; data: unknown };

type ChannelContext = {
	host?: {
		pty?: {
			openTerminal(opts?: { cols?: number; rows?: number }): Promise<PtyHandle>;
		};
	};
	init?: unknown;
	send(frame: HostChannelFrame): Promise<void>;
	close(reason?: string): Promise<void>;
	audit?(event: { type: string; reason?: string; error?: string }): void;
};

type PtyHandle = {
	pid: number;
	write(data: string): void | Promise<void>;
	resize(cols: number, rows: number): void | Promise<void>;
	kill(reason?: string): void | Promise<void>;
	onData(cb: (data: string) => void): () => void;
	onExit(cb: (event: { code: number | null; signal?: string | number; reason?: string }) => void): () => void;
};

type TerminalInit = { cols?: number; rows?: number };
type ResizeFrame = { op: "resize"; cols: number; rows: number };
type KillFrame = { op: "kill"; reason?: string };

export async function terminal(ctx: ChannelContext) {
	let pty: PtyHandle | undefined;
	let closed = false;
	const disposers: Array<() => void> = [];
	const sendJson = async (data: Record<string, unknown>) => {
		await ctx.send({ kind: "json", data });
	};
	const failPtyOperation = async (operation: string, error: unknown, closeChannel: boolean) => {
		const message = error instanceof Error ? error.message : String(error);
		ctx.audit?.({ type: "channel.cleanup", reason: `terminal_${operation}_failed`, error: message });
		await sendJson({ op: "error", operation, message }).catch(() => undefined);
		if (closeChannel && !closed) {
			closed = true;
			await ctx.close(message).catch(() => undefined);
		}
	};
	try {
		if (!ctx.host?.pty) {
			throw new Error("Terminal PTY helper is unavailable for this channel.");
		}
		const init = objectOf(ctx.init) as TerminalInit | undefined;
		pty = await ctx.host.pty.openTerminal({ cols: numberOf(init?.cols), rows: numberOf(init?.rows) });
		disposers.push(pty.onData((data) => { void ctx.send({ kind: "text", data }).catch(() => undefined); }));
		disposers.push(pty.onExit((event) => {
			if (closed) return;
			closed = true;
			void sendJson({ op: "exit", code: event.code, signal: event.signal, reason: event.reason || "exited" })
				.finally(() => ctx.close(event.reason || "pty exited"))
				.catch(() => undefined);
		}));
		await sendJson({ op: "status", state: "attached", pid: pty.pid });
	} catch (error) {
		closed = true;
		const message = error instanceof Error ? error.message : String(error);
		await sendJson({ op: "error", message });
		await ctx.close(message);
		return {};
	}

	return {
		async onClientFrame(frame: HostChannelFrame) {
			if (closed || !pty) return;
			if (frame.kind === "text") {
				try {
					await pty.write(frame.data);
				} catch (error) {
					await failPtyOperation("write", error, true);
				}
				return;
			}
			const data = objectOf(frame.data);
			if (!data) return;
			if (data.op === "resize") {
				const resize = data as ResizeFrame;
				const cols = numberOf(resize.cols);
				const rows = numberOf(resize.rows);
				if (cols && rows) {
					try {
						await pty.resize(cols, rows);
					} catch (error) {
						await failPtyOperation("resize", error, false);
					}
				}
				return;
			}
			if (data.op === "kill") {
				const kill = data as KillFrame;
				try {
					await pty.kill(typeof kill.reason === "string" ? kill.reason : "killed");
				} catch (error) {
					await failPtyOperation("kill", error, true);
				}
			}
		},
		async onAttach() {
			if (!closed && pty) await sendJson({ op: "status", state: "attached", pid: pty.pid });
		},
		async onDetach() {
			if (!closed) ctx.audit?.({ type: "channel.detach", reason: "terminal panel detached" });
		},
		async close(reason?: string) {
			if (closed) return;
			closed = true;
			for (const dispose of disposers.splice(0)) {
				try { dispose(); } catch { /* ignore */ }
			}
			if (pty) {
				try {
					await pty.kill(reason || "closed");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.audit?.({ type: "channel.cleanup", reason: "terminal_close_kill_failed", error: message });
					await sendJson({ op: "error", operation: "close", message }).catch(() => undefined);
				}
			}
		},
	};
}

export const channels = { terminal };

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}
