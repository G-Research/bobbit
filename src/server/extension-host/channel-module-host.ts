// src/server/extension-host/channel-module-host.ts
//
// Module-backed channel handler seam. Production channel modules run in the same
// worker/proxy isolation tier as Extension Host routes/actions: the gateway
// resolves and path-guards pack modules, but never imports pack handler code into
// the gateway process.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ChannelDispatcher, ChannelHandlerContext, ChannelHandlerSession } from "./channel-dispatcher.js";
import type { ChannelHandlerHostSurface, ChannelPtyHandle } from "./channel-pty-helper.js";
import { ChannelError, type ChannelContributionRef, type HostChannelFrame } from "./channel-types.js";
import { isPackPathWithinRoot } from "./path-guard.js";

export interface ChannelModuleHostOpenRequest {
	contribution: ChannelContributionRef;
	dispatcher: ChannelDispatcher;
	channelId: string;
	ctx: ChannelHandlerContext;
}

export interface ChannelModuleHost {
	open(req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession>;
	invalidate?(): void;
	dispose?(): void;
}

export interface ChannelModuleHostOptions {
	buildHost?: (contribution: ChannelContributionRef, ctx: ChannelHandlerContext) => ChannelHandlerHostSurface;
	timeoutMs?: number;
	maxOldGenerationSizeMb?: number;
	stackSizeMb?: number;
}

interface WorkerChannelHandlerSession extends ChannelHandlerSession {
	dispose?(reason?: string): Promise<void> | void;
}

const WORKER_SAFE_EXEC_FLAGS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]);

function workerSafeExecArgv(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const name = eq >= 0 ? a.slice(0, eq) : a;
		if (!WORKER_SAFE_EXEC_FLAGS.has(name)) continue;
		out.push(a);
		if (eq < 0 && i + 1 < argv.length && !argv[i + 1].startsWith("-")) out.push(argv[++i]);
	}
	return out;
}

/** Worker-backed production host for long-lived pack channel handlers. */
export class WorkerChannelModuleHost implements ChannelModuleHost {
	private readonly cache = new Map<string, { mtimeMs: number; url: string }>();
	private readonly live = new Map<Worker, Set<number>>();
	private readonly buildHost?: (contribution: ChannelContributionRef, ctx: ChannelHandlerContext) => ChannelHandlerHostSurface;
	private readonly timeoutMs: number;
	private readonly maxOldGenerationSizeMb: number;
	private readonly stackSizeMb: number;
	private epoch = 0;
	private disposed = false;

	constructor(opts: ChannelModuleHostOptions = {}) {
		this.buildHost = opts.buildHost;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.maxOldGenerationSizeMb = opts.maxOldGenerationSizeMb ?? 256;
		this.stackSizeMb = opts.stackSizeMb ?? 4;
	}

	async open(req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession> {
		if (this.disposed) throw new ChannelError(500, "channel_handler_unavailable", "channel module host is disposed");
		const resolved = this.resolveModule(req.contribution);
		const workingDir = (req.ctx as { workingDir?: string }).workingDir;
		const worker = new Worker(this.bootstrapUrl(), {
			workerData: { packRoot: resolved.packRoot, workingDir, wallCapMs: this.timeoutMs },
			resourceLimits: {
				maxOldGenerationSizeMb: this.maxOldGenerationSizeMb,
				stackSizeMb: this.stackSizeMb,
			},
			execArgv: workerSafeExecArgv(process.execArgv),
		});
		const children = new Set<number>();
		this.live.set(worker, children);
		const host = this.buildHost?.(req.contribution, req.ctx) ?? req.ctx.host;
		const ptys = new Map<string, ChannelPtyHandle>();
		let ptySeq = 0;
		let controlSeq = 0;
		let openSettled = false;
		let closed = false;
		const pendingControls = new Map<number, { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

		const cleanup = (reason?: string, rejectPending = true): void => {
			if (closed) return;
			closed = true;
			this.live.delete(worker);
			for (const pending of pendingControls.values()) {
				clearTimeout(pending.timer);
				if (rejectPending) pending.reject(new Error(reason ?? "channel handler worker closed"));
				else pending.resolve();
			}
			pendingControls.clear();
			for (const pty of ptys.values()) {
				try { pty.kill(reason ?? "channel handler worker closed"); } catch { /* best effort */ }
			}
			ptys.clear();
			killChildren(children);
			void worker.terminate();
		};

		const invokePty = async (pathParts: unknown, args: unknown[]): Promise<unknown> => {
			if (!Array.isArray(pathParts) || pathParts[0] !== "pty" || typeof pathParts[1] !== "string") {
				throw new Error("invalid channel host-call path");
			}
			const method = pathParts[1];
			if (method === "openTerminal") {
				if (!host.pty?.openTerminal) throw new Error("host.pty.openTerminal is unavailable");
				const handle = await host.pty.openTerminal(args[0] as any);
				const id = `pty-${++ptySeq}`;
				ptys.set(id, handle);
				handle.onData((data) => { if (!closed) worker.postMessage({ kind: "channel-pty-data", ptyId: id, data }); });
				handle.onExit((event) => {
					ptys.delete(id);
					if (!closed) worker.postMessage({ kind: "channel-pty-exit", ptyId: id, event });
				});
				return { __channelPtyHandleId: id, pid: handle.pid };
			}
			const ptyId = typeof args[0] === "string" ? args[0] : "";
			const handle = ptys.get(ptyId);
			if (!handle) throw new Error("unknown PTY handle");
			if (method === "write") { handle.write(String(args[1] ?? "")); return undefined; }
			if (method === "resize") { handle.resize(Number(args[1]), Number(args[2])); return undefined; }
			if (method === "kill") { handle.kill(typeof args[1] === "string" ? args[1] : undefined); return undefined; }
			throw new Error(`host.pty.${method} is not permitted`);
		};

		const invokeControl = (op: "channel-client-frame" | "channel-attach" | "channel-detach" | "channel-close", payload: Record<string, unknown> = {}): Promise<void> => {
			if (closed) return Promise.reject(new Error("channel handler worker closed"));
			const id = ++controlSeq;
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					if (!pendingControls.delete(id)) return;
					reject(new ChannelError(504, "channel_timeout", "channel handler operation timed out"));
				}, this.timeoutMs);
				pendingControls.set(id, { resolve, reject, timer });
				worker.postMessage({ kind: op, id, ...payload });
			});
		};

		const openPromise = new Promise<ChannelHandlerSession>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (openSettled) return;
				openSettled = true;
				cleanup("channel handler open timed out");
				reject(new ChannelError(504, "channel_timeout", "channel handler open timed out"));
			}, this.timeoutMs);

			worker.on("message", (msg: any) => {
				if (!msg || typeof msg !== "object") return;
				if (msg.kind === "channel-open-result") {
					if (openSettled) return;
					openSettled = true;
					clearTimeout(timer);
					if (!msg.ok) {
						cleanup(msg.error);
						reject(new ChannelError(typeof msg.status === "number" ? msg.status : 500, msg.code || "channel_handler_failed", msg.error || "channel handler failed"));
						return;
					}
					const session: WorkerChannelHandlerSession = {
						onClientFrame: (frame) => invokeControl("channel-client-frame", { frame }),
						onAttach: (clientId) => invokeControl("channel-attach", { clientId }),
						onDetach: (clientId) => invokeControl("channel-detach", { clientId }),
						close: async (reason) => {
							try { await invokeControl("channel-close", { reason }); }
							finally { cleanup(reason ?? "channel closed"); }
						},
						dispose: async (reason) => { cleanup(reason ?? "channel disposed", false); },
					};
					resolve(session);
					return;
				}
				if (msg.kind === "child-spawn") {
					if (typeof msg.pid === "number") children.add(msg.pid);
					return;
				}
				if (msg.kind === "child-exit") {
					if (typeof msg.pid === "number") children.delete(msg.pid);
					return;
				}
				if (msg.kind === "channel-control-result") {
					const id = typeof msg.id === "number" ? msg.id : -1;
					const pending = pendingControls.get(id);
					if (!pending) return;
					pendingControls.delete(id);
					clearTimeout(pending.timer);
					if (msg.ok) pending.resolve();
					else pending.reject(new Error(msg.error || "channel handler operation failed"));
					return;
				}
				if (msg.kind === "channel-send") { void req.ctx.send(msg.frame as HostChannelFrame).catch(() => undefined); return; }
				if (msg.kind === "channel-close") { void req.ctx.close(typeof msg.reason === "string" ? msg.reason : undefined).catch(() => undefined); return; }
				if (msg.kind === "channel-audit") { req.ctx.audit(isRecord(msg.event) ? msg.event as any : { type: "channel.cleanup", reason: "invalid_worker_audit" }); return; }
				if (msg.kind === "host-call") {
					void invokePty(msg.path, Array.isArray(msg.args) ? msg.args : []).then(
						(value) => { if (!closed) worker.postMessage({ kind: "host-reply", id: msg.id, ok: true, value }); },
						(err) => { if (!closed) worker.postMessage({ kind: "host-reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }); },
					);
				}
			});
			worker.on("error", (err) => {
				if (closed) return;
				const message = err instanceof Error ? err.message : String(err);
				if (!openSettled) {
					openSettled = true;
					clearTimeout(timer);
					reject(new ChannelError(500, "channel_handler_failed", message));
				}
				cleanup(message);
				void req.ctx.close(message).catch(() => undefined);
			});
			worker.on("exit", (code) => {
				if (closed) return;
				const message = `channel handler worker exited (code ${code})`;
				if (!openSettled) {
					openSettled = true;
					clearTimeout(timer);
					reject(new ChannelError(500, "channel_handler_failed", message));
				}
				cleanup(message);
				void req.ctx.close(message).catch(() => undefined);
			});
		});

		worker.postMessage({
			kind: "channel-open",
			url: resolved.url,
			epoch: this.epoch,
			handler: req.contribution.handler ?? req.contribution.name,
			ctx: {
				sessionId: req.ctx.sessionId,
				packId: req.ctx.packId,
				contributionId: req.ctx.contributionId,
				channelId: req.ctx.channelId,
				name: req.ctx.name,
				protocol: req.ctx.protocol,
				init: req.ctx.init,
				workingDir,
				capabilities: { pty: !!host.pty },
			},
		});
		return await openPromise;
	}

	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	dispose(): void {
		this.disposed = true;
		this.cache.clear();
		for (const [worker, children] of this.live) {
			killChildren(children);
			void worker.terminate();
		}
		this.live.clear();
	}

	private bootstrapUrl(): URL {
		const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		return new URL(`./module-host-bootstrap${ext}`, import.meta.url);
	}

	private resolveModule(contribution: ChannelContributionRef): { url: string; packRoot: string } {
		const modulePath = contribution.modulePath;
		const packRoot = contribution.packRoot;
		if (!modulePath || !contribution.handler) {
			throw new ChannelError(500, "channel_handler_unavailable", "channel declaration is missing module or handler");
		}
		if (!packRoot) {
			throw new ChannelError(500, "channel_handler_unavailable", "channel declaration is missing pack root");
		}
		const base = contribution.sourceFile ? path.dirname(contribution.sourceFile) : packRoot;
		const abs = path.resolve(base, modulePath);
		if (!isPackPathWithinRoot(packRoot, abs)) {
			throw new ChannelError(400, "invalid_channel_handler", "channel handler module resolves outside the pack root");
		}
		let stat: fs.Stats;
		try { stat = fs.statSync(abs); }
		catch { throw new ChannelError(404, "channel_handler_not_found", "channel handler module not found"); }
		const key = `${abs}\u0000${this.epoch}`;
		const hit = this.cache.get(key);
		if (hit && hit.mtimeMs === stat.mtimeMs) return { url: hit.url, packRoot };
		const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${this.epoch}`;
		this.cache.set(key, { mtimeMs: stat.mtimeMs, url });
		return { url, packRoot };
	}
}

/** Backwards-compatible export name; production wiring now points at WorkerChannelModuleHost. */
export class LocalChannelModuleHost extends WorkerChannelModuleHost {}
export type LocalChannelModuleHostOptions = ChannelModuleHostOptions;

export class NoopChannelModuleHost implements ChannelModuleHost {
	async open(_req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession> {
		throw new ChannelError(500, "channel_handler_unavailable", "channel handler module host is not configured");
	}
}

export function isChannelModuleHost(value: unknown): value is ChannelModuleHost {
	return !!value && typeof (value as ChannelModuleHost).open === "function";
}

function killChildren(children: Set<number>): void {
	for (const pid of children) {
		try { process.kill(pid, "SIGKILL"); }
		catch { /* already exited / not permitted */ }
	}
	children.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
