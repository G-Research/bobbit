// src/server/extension-host/route-dispatcher.ts
//
// Slice B3 — `routes:` + `host.callRoute` (Extension Host Phase 2, design
// docs/design/extension-host-phase2.md §5).
//
// A pack tool ships `tools/<group>/routes.js` exporting
// `export const routes = { bundle: (ctx, req) => ... }`. A pack renderer/panel/
// entrypoint reaches its OWN pack's route via the client `host.callRoute(name,
// init)` → `POST /api/ext/route/:name`. The server authorizes the caller +
// derives the trusted `packId` (Slice A), then resolves the route MODULE through
// the PACK-LEVEL `RouteRegistry` (NOT the opener tool's location) so a route
// declared on tool Y is reachable from a surface opened by tool X in the SAME
// pack — pack-scoped, opener-independent (§5 B3.1).
//
// `RouteDispatcher` structurally MIRRORS `ActionDispatcher` (epoch-guarded module
// cache + bounded in-flight reload + per-call timeout + permit-held-until-settle
// + the SINGLE invocation seam). It is kept self-contained rather than forking
// `ActionDispatcher`'s private internals: C3 (server-module isolation) unifies the
// two dispatchers' single invocation seam behind one worker host — at which point
// the shared loader is extracted there. Until then this is a deliberate, low-risk
// parallel copy keyed off `routes` instead of `actions`.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError, type ActionHandlerCtx, type ActionDispatcherOptions } from "./action-dispatcher.js";
import { resolvePackIdentity } from "./pack-identity.js";

/** The verified context handed to a route handler. Reuses the action ctx shape
 *  (design §5 B3.1: `RouteHandlerCtx = ActionHandlerCtx`). */
export type RouteHandlerCtx = ActionHandlerCtx;

/** The single typed request a route handler receives (design §5 B3.1 / v1
 *  `HostRouteInit`): method + optional query/body. No raw path/URL. */
export interface RouteRequest {
	method: string;
	query?: Record<string, string>;
	body?: unknown;
}

export type RouteHandler = (ctx: RouteHandlerCtx, req: RouteRequest) => Promise<unknown> | unknown;
export type RoutesModule = { routes: Record<string, RouteHandler> };

/** The resolved on-disk location of a tool's routes module. Mirrors the action
 *  resolver's shape but carries `routesModule` (default "routes.js") + the
 *  declared `routeNames` the pack-level registry indexes by. */
export interface RouteToolLocation {
	baseDir: string;
	groupDir: string;
	/** Routes module path relative to the group dir (default "routes.js"). */
	routesModule?: string;
	/** Declared route-name allowlist from `routes.names` — the registry indexes by these. */
	routeNames?: string[];
}

/** Minimal structural resolver the DISPATCHER depends on: resolve a tool's
 *  winning on-disk location + its `routes.module` (independent of `provider:`). */
export interface RouteToolLocationResolver {
	resolveToolLocation(tool: string): RouteToolLocation | undefined;
}

/** The richer resolver the REGISTRY depends on: enumerate every scanned tool name
 *  (so the pack-level index can collect every routes-bearing tool in a pack) on
 *  top of the per-tool location resolution. `ToolManager` satisfies this. */
export interface RouteToolEnumerator extends RouteToolLocationResolver {
	getAllToolNames(): string[];
}

/** A simple per-session token-bucket rate limiter (mirrors ActionDispatcher's). */
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
		const elapsedSec = (t - b.last) / 1000;
		if (elapsedSec > 0) {
			b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
			b.last = t;
		}
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}
}

/**
 * Loads + runs pack ROUTE handlers under the SAME blast-radius controls as
 * `ActionDispatcher` (per-call timeout, global concurrency cap, per-session rate
 * limit, try/catch isolation, permit-held-until-settle). ONE instance lives for
 * the gateway process lifetime; `invalidate()` drops its module cache from
 * `invalidateResolverCaches()`.
 *
 * The `tool` passed to `dispatch` is the route's DECLARING tool (resolved by the
 * pack-level `RouteRegistry`), NOT the opener tool — so the loaded module is the
 * pack's route module regardless of which surface issued the call (§5 B3.1).
 */
export class RouteDispatcher {
	private readonly cache = new Map<string, { mtimeMs: number; epoch: number; module: RoutesModule }>();
	private readonly timeoutMs: number;
	private readonly maxConcurrent: number;
	private readonly limiter: TokenBucketLimiter | null;
	private inFlight = 0;
	/** Bumped on invalidate() so a post-invalidate import is always fresh even
	 *  under coarse (Windows) mtime resolution. */
	private epoch = 0;

	constructor(
		private readonly toolManager: RouteToolLocationResolver,
		opts: ActionDispatcherOptions = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.maxConcurrent = opts.maxConcurrent ?? 8;
		const rate = opts.rate === undefined ? { capacity: 60, refillPerSec: 30 } : opts.rate;
		this.limiter = rate ? new TokenBucketLimiter(rate.capacity, rate.refillPerSec) : null;
	}

	/** Drop cached modules + force a fresh import on next load. */
	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	/** Resolve the absolute on-disk path of a tool's routes module (default
	 *  "routes.js"), re-validating it stays within the group dir. */
	private resolveModulePath(tool: string, resolver: RouteToolLocationResolver): string | null {
		const loc = resolver.resolveToolLocation(tool);
		if (!loc || !loc.baseDir) return null;
		const dir = path.join(loc.baseDir, loc.groupDir || "");
		const moduleRel = loc.routesModule ?? "routes.js";

		const abs = path.resolve(dir, moduleRel);
		const rel = path.relative(dir, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new ActionError(400, `unsafe routes module path for tool "${tool}"`);
		}
		return abs;
	}

	private static readonly MAX_INFLIGHT_RELOADS = 5;

	/** Load (or return cached) the routes module for a tool. Mirrors
	 *  ActionDispatcher.loadModule's epoch-snapshot in-flight-race guard. */
	private async loadModule(tool: string, resolver: RouteToolLocationResolver): Promise<RoutesModule | null> {
		for (let attempt = 0; ; attempt++) {
			const abs = this.resolveModulePath(tool, resolver);
			if (!abs) return null;

			let stat: fs.Stats;
			try {
				stat = fs.statSync(abs);
			} catch {
				return null; // module file does not exist
			}

			const hit = this.cache.get(abs);
			if (hit && hit.mtimeMs === stat.mtimeMs && hit.epoch === this.epoch) return hit.module;

			const epochAtStart = this.epoch;
			const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${epochAtStart}`;
			const imported = (await import(url)) as Partial<RoutesModule> & Record<string, unknown>;
			const routes = imported.routes ?? (imported.default as RoutesModule | undefined)?.routes;
			if (!routes || typeof routes !== "object") {
				throw new ActionError(500, `routes module for tool "${tool}" has no 'routes' export`);
			}
			const module: RoutesModule = { routes: routes as Record<string, RouteHandler> };

			if (this.epoch === epochAtStart) {
				this.cache.set(abs, { mtimeMs: stat.mtimeMs, epoch: epochAtStart, module });
				return module;
			}

			if (attempt >= RouteDispatcher.MAX_INFLIGHT_RELOADS) {
				return module;
			}
			// loop: re-resolve + reload against the advanced epoch.
		}
	}

	/** Race `work` (combined module load+eval AND handler execution) against the
	 *  per-call timeout with try/catch isolation. Identical strategy to
	 *  ActionDispatcher.runWithTimeout. */
	private runWithTimeout(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ActionError(504, "route handler timed out"));
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
	 * Resolve + run the route handler under blast-radius controls. Throws
	 * `ActionError` (carrying an HTTP status) on any failure; the endpoint maps it
	 * to a JSON error response.
	 */
	async dispatch(
		tool: string,
		name: string,
		ctx: RouteHandlerCtx,
		req: RouteRequest,
		resolver: RouteToolLocationResolver = this.toolManager,
	): Promise<unknown> {
		if (this.limiter && !this.limiter.allow(ctx.sessionId)) {
			throw new ActionError(429, "route rate limit exceeded for this session");
		}
		if (this.inFlight >= this.maxConcurrent) {
			throw new ActionError(429, "too many concurrent routes in flight");
		}
		this.inFlight++;

		// ONE combined per-call timeout spans BOTH the module load+eval AND the
		// handler execution (closes the hung-top-level-await gap — see ActionDispatcher).
		const work = (async (): Promise<unknown> => {
			const module = await this.loadModule(tool, resolver);
			if (!module) throw new ActionError(404, `no routes module found for tool "${tool}"`);
			// Own-property check: never resolve inherited members (constructor/toString).
			if (!Object.prototype.hasOwnProperty.call(module.routes, name)) {
				throw new ActionError(404, `unknown route "${name}" for tool "${tool}"`);
			}
			const handler = module.routes[name];
			if (typeof handler !== "function") throw new ActionError(404, `unknown route "${name}" for tool "${tool}"`);

			// SINGLE invocation seam (the ONLY place a route handler runs) — C3 swaps
			// the execution strategy (worker/vm) here without touching callers.
			return await handler(ctx, req);
		})();

		// Release the permit EXACTLY ONCE when `work` ACTUALLY settles (not when the
		// timeout race settles) — a hung import/handler keeps its slot until it does.
		void work.then(
			() => { this.inFlight--; },
			() => { this.inFlight--; },
		);

		return await this.runWithTimeout(work, this.timeoutMs);
	}
}

/** A resolved registry entry: which tool declares the route + its module path. */
export interface ResolvedRoute {
	declaringTool: string;
	modulePath: string;
}

/**
 * Pack-LEVEL route index (design §5 B3.1). For a `packId`, enumerates every
 * scanned tool, keeps those whose winning location resolves to that `packId`,
 * and collects their declared `routes.names` into one
 * `routeName → { declaringTool, modulePath }` map (built once per
 * resolver+packId, cached). Resolution is OPENER-INDEPENDENT: any surface in the
 * pack reaches the same routes.
 *
 * **Duplicate-route rejection (the one hard registry-build conflict):** if two
 * tools in the SAME pack declare the SAME route name, that is a hard rejection
 * (ActionError 409) naming the conflicting tools + route — guaranteeing at most
 * one declaring tool per `(packId, routeName)` so `resolve` is unambiguous.
 * Cross-pack names never collide (the index is keyed by `packId`).
 *
 * The cache is keyed by the per-call enumerator (a session's project-scoped tool
 * manager, else the server-level one) so project/server scopes never contaminate
 * each other; `invalidate()` drops it on pack install/update/uninstall.
 */
export class RouteRegistry {
	private cache = new WeakMap<RouteToolEnumerator, Map<string, Map<string, ResolvedRoute>>>();

	constructor(private readonly enumerator: RouteToolEnumerator) {}

	/** Drop the cached pack indexes — rebuilt lazily on next resolve. */
	invalidate(): void {
		this.cache = new WeakMap();
	}

	/**
	 * Resolve `(packId, routeName) → { declaringTool, modulePath }`, or undefined
	 * when the pack declares no such route. `enumerator` defaults to the
	 * constructor one; the endpoint passes the session's project-scoped tool
	 * manager so resolution honors the SAME winning precedence the dispatcher loads from.
	 */
	resolve(
		packId: string,
		routeName: string,
		enumerator: RouteToolEnumerator = this.enumerator,
	): ResolvedRoute | undefined {
		if (!packId) return undefined;
		return this.packMap(enumerator, packId).get(routeName);
	}

	private packMap(enumerator: RouteToolEnumerator, packId: string): Map<string, ResolvedRoute> {
		let byPack = this.cache.get(enumerator);
		if (!byPack) {
			byPack = new Map();
			this.cache.set(enumerator, byPack);
		}
		const cached = byPack.get(packId);
		if (cached) return cached;
		const built = this.buildPackMap(enumerator, packId);
		byPack.set(packId, built);
		return built;
	}

	private buildPackMap(enumerator: RouteToolEnumerator, packId: string): Map<string, ResolvedRoute> {
		const map = new Map<string, ResolvedRoute>();
		// Track the declaring tool per route name to detect intra-pack duplicates.
		const declaredBy = new Map<string, string>();
		for (const tool of enumerator.getAllToolNames()) {
			const loc = enumerator.resolveToolLocation(tool);
			if (!loc || !loc.baseDir) continue;
			const ident = resolvePackIdentity({ baseDir: loc.baseDir, groupDir: loc.groupDir }, tool);
			if (!ident.isPack || ident.packId !== packId) continue;
			const names = loc.routeNames;
			if (!names || names.length === 0) continue; // a routes-bearing tool MUST declare names to be reachable

			const dir = path.join(loc.baseDir, loc.groupDir || "");
			const moduleRel = loc.routesModule ?? "routes.js";
			const modulePath = path.resolve(dir, moduleRel);

			for (const name of names) {
				const prior = declaredBy.get(name);
				if (prior !== undefined && prior !== tool) {
					throw new ActionError(
						409,
						`pack "${packId}" declares route "${name}" on two tools ("${prior}" and "${tool}"); route names must be unique within a pack`,
					);
				}
				declaredBy.set(name, tool);
				map.set(name, { declaringTool: tool, modulePath });
			}
		}
		return map;
	}
}
