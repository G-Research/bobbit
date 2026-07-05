/**
 * Warm pool of pre-spawned, non-sandboxed `exec`-class pi processes.
 *
 * See docs/design/warm-pi-process-pool.md — this is wave 1 of that staged
 * plan (§8 step 3): "pool the exec class only (host-level, non-sandboxed
 * code-exec agents), skipping the sandbox-container question entirely...
 * with a small fixed targetSize (start at 1-2 per key, no adaptive sizing
 * yet), a fixed idle TTL..., and claim() returning null on any miss...to
 * fall back to the existing cold path byte-identically."
 *
 * Modeled directly on `WorktreePool` (worktree-pool.ts) — same shape:
 * bounded background fill to a target size, a single synchronous `claim()`
 * entry point that pops a ready entry (or returns null on any miss), and a
 * background replenish kicked off after every claim. The two differences
 * from `WorktreePool`:
 *
 *   1. `WorktreePool` holds one pool PER PROJECT (a small, known, static set
 *      of pools). This pool's key space is (project, cwd, resolved-args
 *      fingerprint) — the resolved `--extension` list depends on role/tool
 *      policy, and `cwd` is different for every worktree-mode session — so
 *      the key space is effectively unbounded and NOT known ahead of time.
 *      There is therefore no "fill every pool at boot" step; a key is only
 *      ever filled reactively, the first time a request for it misses (see
 *      `claim()`).
 *   2. A pool entry is not a bare resource (a directory, in WorktreePool's
 *      case) — it is a fully-started `IRpcBridge` (an actual child process)
 *      sitting idle. This module deliberately knows NOTHING about Bobbit's
 *      session/plan/identity model (`SessionSetupPlan`, `SessionInfo`,
 *      goal ids, etc.) — the caller (session-setup.ts) supplies a fully-
 *      resolved `RpcBridgeOptions` factory keyed only by an opaque pool-
 *      owned id, and gets back `{ id, rpcClient }` on a hit. Keeping this
 *      module generic avoids a circular import (session-setup.ts is the
 *      only consumer) and keeps identity-substitution logic — a genuinely
 *      security-sensitive concern (see session-setup.ts's
 *      `isWarmPoolEligible`/`buildWarmPoolEntryOptions`) — in exactly one
 *      place.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createSessionBridge } from "./session-runtime.js";
import { resolveAgentCliVersion, type IRpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";

/** `BOBBIT_WARM_POOL=1` (or "true") opts in. Default is OFF — see PR body /
 *  docs/design/warm-pi-process-pool.md for why this ships dark by default. */
export function isWarmPoolEnabled(): boolean {
	const v = process.env.BOBBIT_WARM_POOL;
	return v === "1" || v === "true";
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per-key target size. Doc §8 step 3: "start at 1-2 per key, no adaptive sizing yet." */
const DEFAULT_TARGET_SIZE = envInt("BOBBIT_WARM_POOL_TARGET_SIZE", 1);
/** Idle TTL (doc §4 point 3: "order of minutes, tunable"). */
const DEFAULT_TTL_MS = envInt("BOBBIT_WARM_POOL_TTL_MS", 5 * 60_000);
/** How often the background sweep checks for TTL/version staleness. */
const SWEEP_INTERVAL_MS = envInt("BOBBIT_WARM_POOL_SWEEP_INTERVAL_MS", 30_000);

export interface PiPoolMetrics {
	hits: number;
	misses: number;
	spawns: number;
	spawnFailures: number;
	evictedTtl: number;
	evictedVersion: number;
	evictedExited: number;
}

interface PoolEntry {
	id: string;
	rpcClient: IRpcBridge;
	piVersion: string;
	createdAt: number;
	unsubHealth: () => void;
}

interface KeyState {
	entries: PoolEntry[];
	filling: boolean;
}

/**
 * What the caller must supply to (re)fill a given key. Called once per
 * spawned entry with a freshly minted, pool-owned id; must return options
 * whose baked identity is scoped to THAT id, never to any specific future
 * claimant — see session-setup.ts's `buildWarmPoolEntryOptions`. Async
 * because doing this correctly means re-running the SAME plan-resolution
 * pipeline that builds a real session's options (env vars are only one of
 * several places a session id gets baked in — some tool/provider-bridge
 * extensions embed it as a string literal in generated FILE content, not
 * just env — see that function's doc comment), which includes at least one
 * genuinely async step.
 */
export type PoolOptionsFactory = (poolOwnedId: string) => RpcBridgeOptions | Promise<RpcBridgeOptions>;

export interface PiPoolClaim {
	id: string;
	rpcClient: IRpcBridge;
}

export class PiProcessPool {
	private pools = new Map<string, KeyState>();
	private targetSize: number;
	private ttlMs: number;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private metrics: PiPoolMetrics = { hits: 0, misses: 0, spawns: 0, spawnFailures: 0, evictedTtl: 0, evictedVersion: 0, evictedExited: 0 };
	/** Injectable for tests (default: the real installed-package resolution).
	 *  See pi-process-pool.test.ts's version-staleness case. */
	private resolveVersion: () => string;

	constructor(opts?: { targetSize?: number; ttlMs?: number; resolveVersion?: () => string }) {
		this.targetSize = opts?.targetSize ?? DEFAULT_TARGET_SIZE;
		this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
		this.resolveVersion = opts?.resolveVersion ?? resolveAgentCliVersion;
	}

	/** Start the periodic TTL/version staleness sweep. Idempotent. Call once at boot. */
	startSweeping(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => this.sweepOnce().catch(() => {}), SWEEP_INTERVAL_MS);
		this.sweepTimer.unref?.();
	}

	getMetrics(): PiPoolMetrics {
		return { ...this.metrics };
	}

	/** Status snapshot per key — diagnostics-friendly, mirrors `WorktreePool.getStatus()`. */
	getStatus(): Array<{ key: string; ready: number; target: number; filling: boolean }> {
		return Array.from(this.pools.entries()).map(([key, state]) => ({
			key,
			ready: state.entries.length,
			target: this.targetSize,
			filling: state.filling,
		}));
	}

	/**
	 * Claim a warm entry for `key`, or return null on any miss (empty pool,
	 * every candidate stale). Never blocks on a fill — a miss always falls
	 * through to the caller's cold path. Either way, kicks off a background
	 * fill for `key` so a LATER request at the same key has a chance to hit
	 * (this pool's key space is dynamic — see the module doc comment — so
	 * fills are always reactive, never pre-warmed at boot).
	 */
	async claim(key: string, optionsFactory: PoolOptionsFactory): Promise<PiPoolClaim | null> {
		const t0 = performance.now();
		const state = this.pools.get(key);
		const currentVersion = this.resolveVersion();

		while (state && state.entries.length > 0) {
			const entry = state.entries.shift()!;
			if (entry.piVersion !== currentVersion) {
				this.metrics.evictedVersion++;
				console.log(`[pi-process-pool] discarding stale entry (piVersion ${entry.piVersion} != ${currentVersion}) key=${key}`);
				entry.unsubHealth();
				entry.rpcClient.stop().catch(() => {});
				continue;
			}
			entry.unsubHealth();
			this.metrics.hits++;
			console.log(`[pi-process-pool] HIT key=${key} id=${entry.id} waitedMs=${(performance.now() - t0).toFixed(1)} ready=${state.entries.length}/${this.targetSize}`);
			this.replenish(key, optionsFactory);
			return { id: entry.id, rpcClient: entry.rpcClient };
		}

		this.metrics.misses++;
		console.log(`[pi-process-pool] MISS key=${key} (${state ? "stale/empty" : "unseen key"})`);
		this.replenish(key, optionsFactory);
		return null;
	}

	/** Kick off a background fill for `key` if not already filling and below target. Never throws. */
	private replenish(key: string, optionsFactory: PoolOptionsFactory): void {
		let state = this.pools.get(key);
		if (!state) {
			state = { entries: [], filling: false };
			this.pools.set(key, state);
		}
		if (state.filling || state.entries.length >= this.targetSize) return;
		state.filling = true;
		this._fill(key, state, optionsFactory)
			.catch(err => console.error(`[pi-process-pool] fill error for key=${key}:`, err))
			.finally(() => { state!.filling = false; });
	}

	private async _fill(key: string, state: KeyState, optionsFactory: PoolOptionsFactory): Promise<void> {
		const piVersion = this.resolveVersion();
		while (state.entries.length < this.targetSize) {
			const poolOwnedId = randomUUID();
			let options: RpcBridgeOptions;
			try {
				options = await optionsFactory(poolOwnedId);
			} catch (err) {
				console.error(`[pi-process-pool] optionsFactory failed for key=${key}:`, err);
				break;
			}
			const rpcClient = createSessionBridge(options);
			try {
				await rpcClient.start();
				// `start()` resolving only means the child process didn't
				// immediately crash — it does NOT mean the tool/extension graph
				// has finished loading inside it. That graph-load is exactly
				// the dominant cost this pool exists to amortize (PR #157's
				// finding, doc §1), and it continues ASYNCHRONOUSLY after
				// start() resolves. A pool entry must actually PAY that cost
				// during the background fill — not leave it to land on
				// whichever claim happens to grab the entry first — so wait
				// for one real `getState()` round trip (same call
				// `persistSessionMetadata` makes on the cold path) before
				// considering the entry warm. This matches the doc's own
				// description of a pool entry (§3): "a RpcBridge instance
				// that has completed start() and is sitting idle at
				// get_state-ready." Discovered live: without this, a claim
				// landing shortly after a fill still paid most of the cold
				// latency, because the awaited work here just moved from
				// "on claim" to "during background fill" without it actually
				// being awaited anywhere.
				await rpcClient.getState();
			} catch (err) {
				this.metrics.spawnFailures++;
				console.warn(`[pi-process-pool] warm spawn failed for key=${key}: ${err instanceof Error ? err.message : err}`);
				rpcClient.stop().catch(() => {});
				break;
			}
			const unsubHealth = rpcClient.onEvent((event: any) => {
				if (event?.type === "process_exit") {
					this.metrics.evictedExited++;
					const idx = state.entries.findIndex(e => e.id === poolOwnedId);
					if (idx >= 0) state.entries.splice(idx, 1);
					console.warn(`[pi-process-pool] pooled entry ${poolOwnedId} exited while idle (key=${key}) — evicted`);
				}
			});
			state.entries.push({ id: poolOwnedId, rpcClient, piVersion, createdAt: Date.now(), unsubHealth });
			this.metrics.spawns++;
			console.log(`[pi-process-pool] warmed entry ${poolOwnedId} for key=${key} (${state.entries.length}/${this.targetSize})`);
		}
	}

	/** TTL + version sweep across every key. Runs on a timer; safe to call directly in tests. */
	async sweepOnce(): Promise<void> {
		const now = Date.now();
		const currentVersion = this.resolveVersion();
		for (const [key, state] of this.pools) {
			const stale = state.entries.filter(e => (now - e.createdAt) > this.ttlMs || e.piVersion !== currentVersion);
			if (stale.length === 0) continue;
			state.entries = state.entries.filter(e => !stale.includes(e));
			for (const e of stale) {
				this.metrics.evictedTtl++;
				e.unsubHealth();
				e.rpcClient.stop().catch(() => {});
			}
			console.log(`[pi-process-pool] swept ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} for key=${key}`);
		}
	}

	/** Stop everything — call on gateway shutdown. */
	async drain(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		const all: PoolEntry[] = [];
		for (const state of this.pools.values()) all.push(...state.entries.splice(0));
		if (all.length === 0) return;
		await Promise.allSettled(all.map(e => {
			e.unsubHealth();
			return e.rpcClient.stop();
		}));
		console.log(`[pi-process-pool] drained ${all.length} warm entr${all.length === 1 ? "y" : "ies"}`);
	}
}
