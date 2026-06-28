type HostChannelFrame = { kind: "text"; data: string } | { kind: "json"; data: unknown };

type ChannelContext = {
	host?: {
		pty?: {
			openTerminal(opts?: { cols?: number; rows?: number }): Promise<PtyHandle>;
		};
	};
	init?: unknown;
	send(frame: HostChannelFrame): Promise<void>;
	sendTo?(clientId: string, frame: HostChannelFrame): Promise<void>;
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

const REPLAY_MAX_BYTES = 128 * 1024;
const REPLAY_CHUNK_BYTES = 16 * 1024;

export async function terminal(ctx: ChannelContext) {
	let pty: PtyHandle | undefined;
	let closed = false;
	const disposers: Array<() => void> = [];
	const replay = new TextReplayBuffer(REPLAY_MAX_BYTES);
	const sendJson = async (data: Record<string, unknown>) => {
		await ctx.send({ kind: "json", data });
	};
	const sendJsonTo = async (clientId: string, data: Record<string, unknown>) => {
		await sendToClient(ctx, clientId, { kind: "json", data });
	};
	const sendText = async (data: string) => {
		for (const chunk of splitUtf8(data, REPLAY_CHUNK_BYTES)) {
			replay.append(chunk);
			await ctx.send({ kind: "text", data: chunk });
		}
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
		disposers.push(pty.onData((data) => { void sendText(data).catch(() => undefined); }));
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
		async onAttach(clientId: string) {
			if (!closed && pty) {
				for (const data of replay.chunks()) await sendToClient(ctx, clientId, { kind: "text", data });
				await sendJsonTo(clientId, { op: "status", state: "attached", pid: pty.pid });
			}
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

class TextReplayBuffer {
	private parts: string[] = [];
	private bytes = 0;

	constructor(private readonly maxBytes: number) {}

	append(data: string): void {
		let chunk = data;
		let chunkBytes = byteLength(chunk);
		if (chunkBytes > this.maxBytes) {
			chunk = takeUtf8Tail(chunk, this.maxBytes);
			chunkBytes = byteLength(chunk);
			this.parts = [];
			this.bytes = 0;
		}
		this.parts.push(chunk);
		this.bytes += chunkBytes;
		while (this.bytes > this.maxBytes && this.parts.length > 0) {
			const removed = this.parts.shift()!;
			this.bytes -= byteLength(removed);
		}
	}

	chunks(): readonly string[] {
		return [...this.parts];
	}
}

async function sendToClient(ctx: ChannelContext, clientId: string, frame: HostChannelFrame): Promise<void> {
	if (ctx.sendTo) await ctx.sendTo(clientId, frame);
	else await ctx.send(frame);
}

function splitUtf8(data: string, maxBytes: number): string[] {
	if (byteLength(data) <= maxBytes) return [data];
	const chunks: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const char of data) {
		const charBytes = byteLength(char);
		if (current && currentBytes + charBytes > maxBytes) {
			chunks.push(current);
			current = "";
			currentBytes = 0;
		}
		current += char;
		currentBytes += charBytes;
	}
	if (current) chunks.push(current);
	return chunks;
}

function takeUtf8Tail(data: string, maxBytes: number): string {
	let out = "";
	let bytes = 0;
	for (const char of Array.from(data).reverse()) {
		const charBytes = byteLength(char);
		if (bytes + charBytes > maxBytes) break;
		out = char + out;
		bytes += charBytes;
	}
	return out;
}

function byteLength(data: string): number {
	return Buffer.byteLength(data, "utf8");
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}
