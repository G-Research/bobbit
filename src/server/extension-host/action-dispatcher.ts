// src/server/extension-host/action-dispatcher.ts
//
// The SERVER extension host's action dispatcher (design
// docs/design/extension-host.md §4b / §5). A pack tool ships
// `tools/<group>/actions.js` exporting `export const actions = { retry: ... }`.
// The dispatcher resolves the WINNING module through the SAME precedence
// `ToolManager` already uses (`resolveToolLocation()` → `{baseDir, groupDir,
// actionsModule}`, independent of `provider:` — design §4b), loads + caches it
// keyed by absolute-path + mtime (mirroring
// `scanToolsDirCached`), and runs the handler under the blast-radius controls
// from §5 control iv: a per-call TIMEOUT, a global CONCURRENCY cap, a per-session
// token-bucket RATE limit, and try/catch ISOLATION so a crashing handler becomes
// an HTTP error and never takes down the long-lived gateway process.
//
// The single call site of `module.actions[action](ctx, args)` is the confined
// worker (`ModuleHost.invoke`) — the documented seam (§5 iv / §9). The PARENT
// gateway process NEVER imports pack code: it only resolves + validates the
// module PATH and builds the epoch-cache-busted URL the worker re-imports. Module
// import, export-map lookup, and member validation all run INSIDE the worker, so
// pack top-level code can never execute in this privileged process.

import fs from "node:fs";
import path from "node:path";
import { isPackPathWithinGroup } from "./path-guard.js";
import { pathToFileURL } from "node:url";
import type { ServerHostApi } from "./server-host-api.js";
import { ModuleHost } from "./module-host-worker.js";

/** The verified context handed to an action handler (design §4b). */
export interface ActionHandlerCtx {
	/** Phase-1 server Host API surface (bound identity + frozen Phase-2 stubs;
	 *  no raw gateway passthrough). */
	host: ServerHostApi;
	/** The verified calling session id. */
	sessionId: string;
	/** The verified tool_use id this action is acting on. */
	toolUseId: string;
	/** The tool name (== :tool). */
	tool: string;
	/** Slice C3 (declared-permission model) — the session working directory,
	 *  populated by the endpoint from the persisted session. When the winning
	 *  contribution declares `git`/`fs`, the confined worker's process gets a REAL
	 *  cwd() pointing here. Absent for sessions with no resolvable cwd (the worker
	 *  then falls back to the inert cwd()). */
	workingDir?: string;
}

export type ActionHandler = (ctx: ActionHandlerCtx, args: unknown) => Promise<unknown> | unknown;
/** The export shape a pack actions module declares. Resolved + validated INSIDE
 *  the worker (module-host-bootstrap) — the parent never constructs/imports it. */
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

/** Minimal structural view of `ToolManager` the dispatcher depends on. Resolves
 *  the winning tool's on-disk location + its `actions.module` independent of
 *  `provider:` (design §4b). */
export interface ActionToolLocationResolver {
	resolveToolLocation(tool: string): { baseDir: string; groupDir: string; actionsModule?: string; permissions?: string[] } | undefined;
}

/**
 * Pick the tool-location resolver whose precedence a session's action/renderer
 * resolution MUST honor: the session's PROJECT-scoped tool manager when one is
 * available, else the server-level fallback (design §4b). A project pack that
 * shadows a same-named global tool must serve/dispatch the PROJECT winner — never
 * a split-brain global one. The renderer GET, the action POST metadata lookup,
 * and the dispatcher's location resolution all run through this so they always
 * agree on the winning provider. With no project (server/global scope) it returns
 * the server-level resolver, keeping the zero-/server-scope path byte-identical.
 */
export function resolveActionToolManager<T>(serverTm: T, projectTm: T | undefined | null): T {
	return projectTm ?? serverTm;
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
	/**
	 * Slice C3 — the SHARED confined worker host the SINGLE invocation seam runs
	 * the handler through (server-module isolation, design §9). server.ts threads
	 * ONE instance into both the action + route dispatchers. When omitted, the
	 * dispatcher constructs its OWN `ModuleHost` so isolation is UNCONDITIONAL —
	 * there is no in-process execution path to gate (no shippable bypass).
	 */
	moduleHost?: ModuleHost;
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
	/** Caches ONLY {path → {mtimeMs, epoch, url}} — NEVER a module object. The
	 *  parent does no `import()`, so pack top-level code never runs here. */
	private readonly cache = new Map<string, { mtimeMs: number; epoch: number; url: string }>();
	private readonly timeoutMs: number;
	private readonly maxConcurrent: number;
	private readonly limiter: TokenBucketLimiter | null;
	/** Slice C3 — the SINGLE invocation seam runs every handler through this confined
	 *  worker host (server-module isolation, design §9). Always present (injected by
	 *  server.ts, else self-constructed) so there is NO in-process path. */
	private readonly moduleHost: ModuleHost;
	private inFlight = 0;
	/** Bumped on invalidate() so a post-invalidate import is always fresh even
	 *  when coarse (Windows) mtime resolution would otherwise serve a stale module. */
	private epoch = 0;

	constructor(
		private readonly toolManager: ActionToolLocationResolver,
		opts: ActionDispatcherOptions = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.maxConcurrent = opts.maxConcurrent ?? 8;
		const rate = opts.rate === undefined ? { capacity: 60, refillPerSec: 30 } : opts.rate;
		this.limiter = rate ? new TokenBucketLimiter(rate.capacity, rate.refillPerSec) : null;
		// Slice C3: isolation is UNCONDITIONAL — fall back to a self-constructed
		// ModuleHost (no in-process path exists) when one is not threaded in.
		this.moduleHost = opts.moduleHost ?? new ModuleHost({ timeoutMs: this.timeoutMs });
	}

	/** Drop cached URLs + bump the epoch so the next dispatch builds a fresh
	 *  cache-busted URL (the worker then re-imports updated source). Called from
	 *  invalidateResolverCaches() on install/update/uninstall/pack-order. */
	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	/**
	 * Resolve the absolute on-disk path of a tool's actions module, honoring
	 * `ToolManager` precedence (the winning tool's baseDir/groupDir via
	 * `resolveToolLocation`, independent of `provider:`) and the tool YAML's
	 * `actions.module` (default "actions.js"). Re-validates the path stays within
	 * the group dir (design §5 ii). Returns null when the tool has no resolvable
	 * on-disk location.
	 */
	private resolveModulePath(tool: string, resolver: ActionToolLocationResolver = this.toolManager): { abs: string; packRoot: string; permissions?: string[] } | null {
		const loc = resolver.resolveToolLocation(tool);
		if (!loc || !loc.baseDir) return null;
		const dir = path.join(loc.baseDir, loc.groupDir || "");
		const moduleRel = loc.actionsModule ?? "actions.js";

		const abs = path.resolve(dir, moduleRel);
		// Path-traversal + symlink re-validation: abs must stay within `dir` both
		// lexically and after realpath resolution (rejects symlink escapes).
		if (!isPackPathWithinGroup(dir, abs)) {
			throw new ActionError(400, `unsafe actions module path for tool "${tool}"`);
		}
		// `dir` is the validated pack root; forwarded into the confined worker so the
		// pack module graph cannot import any `file:` OUTSIDE it (design §9). The
		// declared-permission grants (Slice C3) come from the SAME winning
		// contribution — server-resolved, never caller-supplied.
		return { abs, packRoot: dir, permissions: loc.permissions };
	}

	/**
	 * Resolve the epoch-cache-busted import URL for a tool's actions module WITHOUT
	 * importing it. The parent NEVER imports pack code (design §9): it only resolves
	 * the abs path (honoring ToolManager precedence + path-traversal re-validation),
	 * `stat`s its mtime, tracks the epoch, and builds the `file://…?v=&e=` URL the
	 * confined worker re-imports. Returns null when the tool has no resolvable
	 * on-disk module file.
	 *
	 * Because the parent holds NO module object — only `{path → {mtimeMs, epoch,
	 * url}}` — pack top-level code can never run in this privileged process. The
	 * import, the `actions` export lookup, and the member (own-function) validation
	 * ALL happen inside the worker (module-host-bootstrap `handleInvoke`), bounded by
	 * the per-call timeout; the worker returns a structured `{error, status}` that
	 * the seam maps to the SAME `ActionError` statuses the endpoint + tests expect.
	 * This is purely a path-resolution step, so it is synchronous + race-free: there
	 * is no in-flight import for an `invalidate()` to race (the epoch bump simply
	 * changes the URL the next dispatch builds).
	 */
	private resolveModuleUrl(tool: string, resolver: ActionToolLocationResolver = this.toolManager): { url: string; packRoot: string; permissions?: string[] } | null {
		const resolved = this.resolveModulePath(tool, resolver);
		if (!resolved) return null;
		const { abs, packRoot, permissions } = resolved;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			return null; // module file does not exist
		}

		const epoch = this.epoch;
		const hit = this.cache.get(abs);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.epoch === epoch) return { url: hit.url, packRoot, permissions };

		// Cache-bust by mtime + epoch so a changed (or post-invalidate) file yields a
		// fresh URL the worker re-imports even under coarse mtime resolution.
		const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${epoch}`;
		this.cache.set(abs, { mtimeMs: stat.mtimeMs, epoch, url });
		return { url, packRoot, permissions };
	}

	/**
	 * Race an already-running `work` promise (the COMBINED module load+eval AND
	 * handler execution — see `dispatch`) against the per-call timeout, with
	 * try/catch isolation (a reject/throw becomes an ActionError, never a
	 * process-level crash). Returns/rejects PROMPTLY to the caller: on timeout the
	 * caller gets a 504 immediately even though `work` keeps executing in the
	 * background (caller-facing latency is bounded by `timeoutMs`).
	 *
	 * NOTE on cancellation: module LOAD+EVAL AND handler execution BOTH run in the
	 * confined worker as of Slice C3 — the parent does no `import()`. So a runaway
	 * top-level `while(1)` (or a hung top-level `await`) in pack code, as well as a
	 * runaway handler, are ALL truly terminated by `ModuleHost.invoke`'s
	 * `worker.terminate()` on timeout (design §9). `work` therefore always SETTLES
	 * (it can no longer hang forever) and its permit is released. The blast-radius
	 * invariant is unchanged — the permit is released exactly once when `work`
	 * settles (see `dispatch`).
	 */
	private runWithTimeout(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ActionError(504, "action handler timed out"));
			}, timeoutMs);
			work.then(
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
	async dispatch(
		tool: string,
		action: string,
		ctx: ActionHandlerCtx,
		args: unknown,
		/** Optional per-call location resolver (the SESSION's project-scoped tool
		 *  manager). Defaults to the server-level resolver passed to the constructor.
		 *  The endpoint passes the session-project resolver so the module loaded
		 *  matches the winner the session's tool resolution sees (design §4b, no
		 *  split-brain). */
		resolver: ActionToolLocationResolver = this.toolManager,
	): Promise<unknown> {
		// Per-session rate limit (cheap, before any fs/import work).
		if (this.limiter && !this.limiter.allow(ctx.sessionId)) {
			throw new ActionError(429, "action rate limit exceeded for this session");
		}
		// Global concurrency cap.
		if (this.inFlight >= this.maxConcurrent) {
			throw new ActionError(429, "too many concurrent actions in flight");
		}
		this.inFlight++;

		// TIMEOUT SCOPE (design §5 iv / §9): ONE combined per-call timeout spans BOTH
		// the module load+evaluation AND the handler execution — and since the PARENT
		// no longer imports pack code (the worker does), the timeout now genuinely
		// bounds module eval too. A pack actions module with a top-level `while(1)`,
		// hanging top-level `await`, or a stalled handler all yield a prompt 504 after
		// `worker.terminate()` — none can hang the privileged gateway process.
		const work = (async (): Promise<unknown> => {
			const resolved = this.resolveModuleUrl(tool, resolver);
			if (!resolved) throw new ActionError(404, `no actions module found for tool "${tool}"`);

			// SINGLE invocation seam (design §5 iv / §9): the ONLY place pack code runs.
			// The PARENT does NO `import()` — the confined worker imports the
			// epoch-cache-busted URL, resolves `actions[member]` (own-function check,
			// mirroring the former parent-side guard as defense-in-depth), and either
			// invokes it or returns a structured `{error, status}` mapped to the SAME
			// ActionError statuses (500 "no 'actions' export" / 404 "unknown action").
			// Isolation is unconditional (no in-process path).
			return await this.moduleHost.invoke(
				{ url: resolved.url, packRoot: resolved.packRoot, epoch: this.epoch, exportKind: "actions", member: action, ctx, arg: args, permissions: resolved.permissions, workingDir: ctx.workingDir },
				this.timeoutMs,
			);
		})();

		// BLAST-RADIUS CORRECTNESS: the permit must bound the actual underlying
		// WORK (load+eval+execute), not request lifetime. As of Slice C3 a timed-out
		// `work` is TRULY cancelled — `ModuleHost.invoke` calls `worker.terminate()`,
		// so `work` settles (it no longer runs forever). We still release the permit
		// EXACTLY ONCE when `work` ACTUALLY settles, NOT when `runWithTimeout`'s race
		// settles. Consequence: a hung import OR a hung handler keeps its permit until
		// it settles (terminate makes that prompt); once
		// `maxConcurrent` of them accumulate, further dispatches are correctly
		// rejected over-capacity — a buggy/malicious pack saturates its OWN cap
		// instead of spawning unbounded zombie executions, and the permit is never
		// leaked (no-handler-started failures like 404/500 settle `work` promptly,
		// releasing it immediately). The detached tracker also consumes a late
		// rejection (after the caller already got a 504), preventing an
		// unhandled-rejection warning.
		void work.then(
			() => { this.inFlight--; },
			() => { this.inFlight--; },
		);

		return await this.runWithTimeout(work, this.timeoutMs);
	}
}
