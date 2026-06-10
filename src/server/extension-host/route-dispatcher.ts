// src/server/extension-host/route-dispatcher.ts
//
// `routes:` + `host.callRoute` (Extension Host Phase 2, design
// docs/design/extension-host-phase2.md §5; rebuilt for pack-schema-v1 §5.3).
//
// Routes are now declared at the PACK LEVEL (`pack.yaml.routes`), not on a
// carrier tool. A pack renderer/panel/entrypoint reaches its OWN pack's route via
// the client `host.callRoute(name, init)` → `POST /api/ext/route/:name`. The
// server authorizes the caller + derives the trusted `packId` from the surface
// token, then resolves the route MODULE through the pack-level `RouteRegistry`
// (built off the `PackContributionRegistry`, opener-INDEPENDENT).
//
// `RouteDispatcher` structurally MIRRORS `ActionDispatcher` (epoch-guarded module
// cache + bounded in-flight reload + per-call timeout + permit-held-until-settle
// + the SINGLE invocation seam). It now dispatches by a RESOLVED `{ modulePath,
// packRoot }` instead of a tool, because routes have no carrier tool.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError, type ActionHandlerCtx, type ActionDispatcherOptions } from "./action-dispatcher.js";
import { ModuleHost } from "./module-host-worker.js";
import { isPackPathWithinRoot } from "./path-guard.js";
import type { PackContributionResolver } from "./pack-contribution-registry.js";

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
/** The export shape a pack routes module declares. Resolved + validated INSIDE
 *  the worker (module-host-bootstrap) — the parent never constructs/imports it. */
export type RoutesModule = { routes: Record<string, RouteHandler> };

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
 * Dispatch is keyed by a RESOLVED `{ modulePath, packRoot }` (the pack-level
 * `RouteRegistry` produced it from the pack's `routes` ref), NOT a tool — routes
 * are pack-scoped and opener-independent (§5.3).
 */
export class RouteDispatcher {
	/** Caches ONLY {path → {mtimeMs, epoch, url}} — NEVER a module object. */
	private readonly cache = new Map<string, { mtimeMs: number; epoch: number; url: string }>();
	private readonly timeoutMs: number;
	private readonly maxConcurrent: number;
	private readonly limiter: TokenBucketLimiter | null;
	private readonly moduleHost: ModuleHost;
	private inFlight = 0;
	private epoch = 0;

	constructor(opts: ActionDispatcherOptions = {}) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.maxConcurrent = opts.maxConcurrent ?? 8;
		const rate = opts.rate === undefined ? { capacity: 60, refillPerSec: 30 } : opts.rate;
		this.limiter = rate ? new TokenBucketLimiter(rate.capacity, rate.refillPerSec) : null;
		this.moduleHost = opts.moduleHost ?? new ModuleHost({ timeoutMs: this.timeoutMs });
	}

	/** Drop cached modules + force a fresh import on next load. */
	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	/** Re-validate a pre-resolved route module path stays within the pack root,
	 *  then build its epoch-cache-busted import URL WITHOUT importing it (the
	 *  parent does NO `import()`; the worker imports + validates the `routes`
	 *  export + member). */
	private resolveModuleUrl(modulePath: string, packRoot: string): { url: string; packRoot: string } | null {
		const abs = path.resolve(modulePath);
		if (!isPackPathWithinRoot(packRoot, abs)) {
			throw new ActionError(400, `unsafe routes module path "${modulePath}"`);
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			return null; // module file does not exist
		}
		const epoch = this.epoch;
		const hit = this.cache.get(abs);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.epoch === epoch) return { url: hit.url, packRoot };
		const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${epoch}`;
		this.cache.set(abs, { mtimeMs: stat.mtimeMs, epoch, url });
		return { url, packRoot };
	}

	/** Race `work` against the per-call timeout with try/catch isolation. */
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
	 * Resolve + run the route handler under blast-radius controls. `modulePath` +
	 * `packRoot` come from the pack-level `RouteRegistry`. Throws `ActionError`
	 * (carrying an HTTP status) on any failure; the endpoint maps it to a JSON
	 * error response.
	 */
	async dispatch(
		modulePath: string,
		packRoot: string,
		name: string,
		ctx: RouteHandlerCtx,
		req: RouteRequest,
	): Promise<unknown> {
		if (this.limiter && !this.limiter.allow(ctx.sessionId)) {
			throw new ActionError(429, "route rate limit exceeded for this session");
		}
		if (this.inFlight >= this.maxConcurrent) {
			throw new ActionError(429, "too many concurrent routes in flight");
		}
		this.inFlight++;

		const work = (async (): Promise<unknown> => {
			const resolved = this.resolveModuleUrl(modulePath, packRoot);
			if (!resolved) throw new ActionError(404, `no routes module found at "${modulePath}"`);
			return await this.moduleHost.invoke(
				{ url: resolved.url, packRoot: resolved.packRoot, epoch: this.epoch, exportKind: "routes", member: name, ctx, arg: req, workingDir: ctx.workingDir },
				this.timeoutMs,
			);
		})();

		void work.then(
			() => { this.inFlight--; },
			() => { this.inFlight--; },
		);

		return await this.runWithTimeout(work, this.timeoutMs);
	}
}

/** A resolved registry entry: the route module path + the pack root for confinement. */
export interface ResolvedRoute {
	modulePath: string;
	packRoot: string;
}

/**
 * Pack-LEVEL route index (pack-schema-v1 §5.3). Resolves `(projectId, packId,
 * routeName)` → `{ modulePath, packRoot }` from the pack's pack-level
 * `RouteContribution` (`pack.yaml.routes`), via the `PackContributionRegistry`.
 * A route is reachable only when `routeName ∈ routes.names` (the allowlist).
 *
 * Duplicate route names within a pack are rejected EARLIER, at pack-contribution
 * load time (`pack-contributions.ts`), so the resolution here is unambiguous.
 * Cross-pack names never collide (the index is keyed by `packId`).
 */
export class RouteRegistry {
	constructor(private readonly contributions: PackContributionResolver) {}

	/** No per-instance cache to drop — resolution reads through the
	 *  `PackContributionRegistry`, which owns the cache + its invalidation. */
	invalidate(): void {
		/* no-op: the PackContributionRegistry owns the cache */
	}

	/**
	 * Resolve `(packId, routeName) → { modulePath, packRoot }`, or undefined when
	 * the pack declares no such route (or is not installed/active). The route
	 * module resolves relative to the declaring `pack.yaml`'s dir (the pack root)
	 * and stays contained within it.
	 */
	resolve(
		packId: string,
		routeName: string,
		projectId: string | undefined,
	): ResolvedRoute | undefined {
		if (!packId) return undefined;
		const pack = this.contributions.getPack(projectId, packId);
		const routes = pack?.routes;
		if (!routes || !routes.names.includes(routeName)) return undefined;
		const modulePath = path.resolve(path.dirname(routes.sourceFile), routes.module);
		return { modulePath, packRoot: routes.packRoot };
	}
}
