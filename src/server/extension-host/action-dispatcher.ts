// src/server/extension-host/action-dispatcher.ts
//
// The SERVER extension host's action dispatcher (design
// docs/design/extension-host.md §4b / §5). A pack tool ships
// `tools/<group>/actions.js` exporting `export const actions = { retry: ... }`.
// The dispatcher resolves the WINNING module through the SAME precedence
// `ToolManager` already uses (`getToolProviders()` → `{baseDir, groupDir}`),
// loads + caches it keyed by absolute-path + mtime (mirroring
// `scanToolsDirCached`), and runs the handler under the blast-radius controls
// from §5 control iv: a per-call TIMEOUT, a global CONCURRENCY cap, a per-session
// token-bucket RATE limit, and try/catch ISOLATION so a crashing handler becomes
// an HTTP error and never takes down the long-lived gateway process.
//
// The single call site of `module.actions[action](ctx, args)` is
// `runWithTimeout` — the documented seam (§5 iv) for later running pack server
// modules in a worker/vm without touching any caller.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { parseContributions } from "../agent/tool-contributions.js";
import type { ServerHostApi } from "./server-host-api.js";

/** The verified context handed to an action handler (design §4b). */
export interface ActionHandlerCtx {
	/** Phase-1 server Host API surface (audited gateway fetch, scoped). */
	host: ServerHostApi;
	/** The verified calling session id. */
	sessionId: string;
	/** The verified tool_use id this action is acting on. */
	toolUseId: string;
	/** The tool name (== :tool). */
	tool: string;
}

export type ActionHandler = (ctx: ActionHandlerCtx, args: unknown) => Promise<unknown> | unknown;
export type ActionsModule = { actions: Record<string, ActionHandler> };

/** An error carrying the HTTP status the endpoint should surface. */
export class ActionError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ActionError";
		this.status = status;
	}
}

/** Minimal structural view of `ToolManager` the dispatcher depends on. */
export interface ActionToolProviderResolver {
	getToolProviders(): Map<string, { baseDir: string; groupDir: string }>;
}

export interface ActionDispatcherOptions {
	/** Per-call timeout in ms (default 30_000). */
	timeoutMs?: number;
	/** Max concurrent in-flight handlers, process-wide (default 8). */
	maxConcurrent?: number;
	/**
	 * Per-session token-bucket rate limit. `null` disables rate limiting.
	 * Default { capacity: 60, refillPerSec: 30 }.
	 */
	rate?: { capacity: number; refillPerSec: number } | null;
}

/** A simple per-session token-bucket rate limiter (design §5 iv). */
class TokenBucketLimiter {
	private buckets = new Map<string, { tokens: number; last: number }>();
	constructor(
		private readonly capacity: number,
		private readonly refillPerSec: number,
		private readonly now: () => number = Date.now,
	) {}

	allow(key: string): boolean {
		const t = this.now();
		let b = this.buckets.get(key);
		if (!b) {
			b = { tokens: this.capacity, last: t };
			this.buckets.set(key, b);
		}
		// Refill based on elapsed time.
		const elapsedSec = (t - b.last) / 1000;
		if (elapsedSec > 0) {
			b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
			b.last = t;
		}
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	clear(): void {
		this.buckets.clear();
	}
}

/**
 * Loads + runs pack action handlers. ONE instance lives for the gateway process
 * lifetime (constructed near `toolManager` in server.ts); its module cache is
 * dropped synchronously by `invalidate()` inside `invalidateResolverCaches()`.
 */
export class ActionDispatcher {
	private readonly cache = new Map<string, { mtimeMs: number; epoch: number; module: ActionsModule }>();
	private readonly timeoutMs: number;
	private readonly maxConcurrent: number;
	private readonly limiter: TokenBucketLimiter | null;
	private inFlight = 0;
	/** Bumped on invalidate() so a post-invalidate import is always fresh even
	 *  when coarse (Windows) mtime resolution would otherwise serve a stale module. */
	private epoch = 0;

	constructor(
		private readonly toolManager: ActionToolProviderResolver,
		opts: ActionDispatcherOptions = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.maxConcurrent = opts.maxConcurrent ?? 8;
		const rate = opts.rate === undefined ? { capacity: 60, refillPerSec: 30 } : opts.rate;
		this.limiter = rate ? new TokenBucketLimiter(rate.capacity, rate.refillPerSec) : null;
	}

	/** Drop cached modules + force a fresh import on next load. Called from
	 *  invalidateResolverCaches() on install/update/uninstall/pack-order. */
	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	/**
	 * Resolve the absolute on-disk path of a tool's actions module, honoring
	 * `ToolManager` precedence (the winning provider's baseDir/groupDir) and the
	 * tool YAML's `actions.module` (default "actions.js"). Re-validates the path
	 * stays within the group dir (design §5 ii). Returns null when the tool has
	 * no resolvable provider directory.
	 */
	private resolveModulePath(tool: string): string | null {
		const provider = this.toolManager.getToolProviders().get(tool);
		if (!provider || !provider.baseDir) return null;
		const dir = path.join(provider.baseDir, provider.groupDir || "");

		// Find the tool's YAML to read its `actions.module` (default actions.js).
		let moduleRel = "actions.js";
		try {
			for (const file of fs.readdirSync(dir)) {
				if (!/\.ya?ml$/i.test(file)) continue;
				try {
					const yamlPath = path.join(dir, file);
					const data = parse(fs.readFileSync(yamlPath, "utf-8"));
					if (data && typeof data === "object" && typeof (data as { name?: unknown }).name === "string" &&
						(data as { name: string }).name.toLowerCase() === tool.toLowerCase()) {
						const c = parseContributions(data, yamlPath);
						if (c.actions?.module) moduleRel = c.actions.module;
						break;
					}
				} catch { /* skip malformed YAML — fall through to default */ }
			}
		} catch {
			// Group dir unreadable/missing — nothing to load.
			return null;
		}

		const abs = path.resolve(dir, moduleRel);
		// Path-traversal re-validation: abs must stay within `dir`.
		const rel = path.relative(dir, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new ActionError(400, `unsafe actions module path for tool "${tool}"`);
		}
		return abs;
	}

	/** Load (or return cached) the winning actions module for a tool. */
	private async loadModule(tool: string): Promise<ActionsModule | null> {
		const abs = this.resolveModulePath(tool);
		if (!abs) return null;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			return null; // module file does not exist
		}

		const hit = this.cache.get(abs);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.epoch === this.epoch) return hit.module;

		// Cache-bust by mtime + epoch so a changed (or post-invalidate) file is
		// always re-imported even under coarse mtime resolution.
		const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${this.epoch}`;
		const imported = (await import(url)) as Partial<ActionsModule> & Record<string, unknown>;
		const actions = imported.actions ?? (imported.default as ActionsModule | undefined)?.actions;
		if (!actions || typeof actions !== "object") {
			throw new ActionError(500, `actions module for tool "${tool}" has no 'actions' export`);
		}
		const module: ActionsModule = { actions: actions as Record<string, ActionHandler> };
		this.cache.set(abs, { mtimeMs: stat.mtimeMs, epoch: this.epoch, module });
		return module;
	}

	/**
	 * Run a handler under the per-call timeout + try/catch isolation seam. This
	 * is the ONLY place `module.actions[action](ctx, args)` is invoked, so the
	 * execution strategy (worker/vm) can be swapped here without touching callers.
	 */
	private runWithTimeout(handler: ActionHandler, ctx: ActionHandlerCtx, args: unknown): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ActionError(504, "action handler timed out"));
			}, this.timeoutMs);
			// Wrap in Promise.resolve so a synchronous throw is captured too.
			Promise.resolve()
				.then(() => handler(ctx, args))
				.then(
					(result) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(result);
					},
					(err) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						reject(err instanceof ActionError ? err : new ActionError(500, err instanceof Error ? err.message : String(err)));
					},
				);
		});
	}

	/**
	 * Phase-1 entry point. Resolves + runs the handler under blast-radius
	 * controls. Throws `ActionError` (carrying an HTTP status) on any failure;
	 * the endpoint maps it to a JSON error response.
	 */
	async dispatch(tool: string, action: string, ctx: ActionHandlerCtx, args: unknown): Promise<unknown> {
		// Per-session rate limit (cheap, before any fs/import work).
		if (this.limiter && !this.limiter.allow(ctx.sessionId)) {
			throw new ActionError(429, "action rate limit exceeded for this session");
		}
		// Global concurrency cap.
		if (this.inFlight >= this.maxConcurrent) {
			throw new ActionError(429, "too many concurrent actions in flight");
		}
		this.inFlight++;
		try {
			const module = await this.loadModule(tool);
			if (!module) throw new ActionError(404, `no actions module found for tool "${tool}"`);
			const handler = module.actions[action];
			if (typeof handler !== "function") throw new ActionError(404, `unknown action "${action}" for tool "${tool}"`);
			return await this.runWithTimeout(handler, ctx, args);
		} finally {
			this.inFlight--;
		}
	}
}
