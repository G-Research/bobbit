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
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(reason?: string): void;
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
				pty.write(frame.data);
				return;
			}
			const data = objectOf(frame.data);
			if (!data) return;
			if (data.op === "resize") {
				const resize = data as ResizeFrame;
				const cols = numberOf(resize.cols);
				const rows = numberOf(resize.rows);
				if (cols && rows) pty.resize(cols, rows);
				return;
			}
			if (data.op === "kill") {
				const kill = data as KillFrame;
				pty.kill(typeof kill.reason === "string" ? kill.reason : "killed");
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
				try { pty.kill(reason || "closed"); } catch { /* ignore */ }
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
