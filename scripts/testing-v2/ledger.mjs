#!/usr/bin/env node
/**
 * ledger.mjs — atomic lockfile reservation ledger for Test Suite v2 (design §6.2).
 *
 * The ledger is a *reservation* system (not an activeRuns estimator). It keeps
 * the invariant `sum(child.workerSlots) <= totalCores` across any number of
 * concurrently starting `test:v2` runs, even when runs start milliseconds or
 * minutes apart, by granting from a single persisted remaining-core budget
 * while holding an atomic lockfile.
 *
 * State lives under the OS temp root: <tmp>/bobbit-test-v2-ledger/
 *   - ledger.lock        atomic fs.open(..,"wx") mutex; stale only if owner PID
 *                        dead AND mtime older than 30s.
 *   - reservations.json  { totalCores, generation, reservations: [ ... ] }
 *   - <id>.heartbeat     touched every 2s by a live runner; used with PID
 *                        liveness to sweep abandoned reservations.
 *
 * ─── PUBLIC API (import from vitest.config.ts / playwright-v2.config.ts / run-v2.mjs) ───
 *
 *   reserveWorkerSlots(kind, opts?) -> { workerSlots: number, release: () => void,
 *                                        reservationId: string, parentRunId: string,
 *                                        managedByParent: boolean }
 *       kind: "vitest" | "playwright"
 *       Call this synchronously-ish at config startup to obtain an integer worker
 *       count for that runner. Behaviour:
 *         • If a parent orchestrator (run-v2.mjs) already reserved+split a bundle
 *           and exported BOBBIT_V2_LEDGER_PARENT + BOBBIT_V2_SLOTS_<KIND>, this
 *           returns that count with a no-op release (the parent owns the entry —
 *           no double registration).
 *         • Otherwise it performs a full standalone reservation for this kind,
 *           registers ONE child reservation, starts a 2s heartbeat, and returns
 *           the granted count + a release() that removes the entry.
 *
 *   reserveParentBundle(opts?) -> { vitest: number, playwright: number, total: number,
 *                                   parentRunId: string, release: () => void,
 *                                   childEnv: Record<string,string> }
 *       Used by run-v2.mjs. Reserves a parent bundle after a coalescing window,
 *       splits it into vitest + playwright child reservations (4→1v+3p, 12→8v+3p,
 *       cap vitest 8 / playwright 3), registers both, and returns the split plus
 *       `childEnv` to pass to spawned tier children so their config's
 *       reserveWorkerSlots() re-uses the grant instead of re-reserving.
 *
 *   readLedger() -> reservations snapshot (swept).  ledgerDir() -> state dir path.
 *
 * opts (both): { coalesceMs?, totalCores?, lockTimeoutMs?, grantTimeoutMs? }
 *
 * ─── GLOBAL CONCURRENCY BUDGET — gateway-boot lease pool ───
 *
 * The reservation API above bounds the *steady-state* worker count
 * (ΣworkerSlots ≤ cores). It does NOT bound the *transient* CPU bursts that
 * happen when many in-process gateways boot at the same instant — the diagnosed
 * root cause of the N-way flakes (docs/testing-v2/concurrency-proof.md): every
 * v2-integration test file boots a gateway once per vitest fork, every Playwright
 * worker boots one at worker startup, so N concurrent `test:v2` runs fire a
 * cluster of simultaneous boots that spike CPU and starve timing-sensitive
 * integration tests past their timeouts.
 *
 * The lease pool is a SEPARATE cross-process semaphore that gates those heavy
 * ops regardless of the active-run count. A heavy op acquires a lease → WAITS if
 * the pool is saturated → releases when the burst is over. This makes the box
 * un-oversubscribable at ANY N (higher wall via queuing is the accepted tradeoff
 * — reliability > speed).
 *
 *   acquireLease(pool, opts?) -> Promise<{ release, id, forced, pool, cap }>
 *   acquireGatewayBootLease(opts?) -> Promise<{ release, ... }>  // pool="gateway-boot"
 *   acquireBrowserRenderLease(opts?) -> Promise<{ release, ... }> // pool="browser"
 *   readLeases(opts?) -> { leases, generation }   leaseCap(pool, opts?) -> int
 *
 * TWO pools, TWO contention sources, TWO hold patterns:
 *   gateway-boot: caps simultaneous in-process gateway BOOTS (transient CPU
 *     burst). Held ONLY for the boot (release right after gw.start()). Cap:
 *     opts.cap ?? BOBBIT_V2_MAX_GATEWAY_BOOTS ?? budget-caps.json ?? floor(cores/6).
 *   browser: caps simultaneous Chromium browser WORKERS actively rendering the
 *     app (the sustained tier-2 toBeVisible render contention). Held for a
 *     Playwright worker's WHOLE life (30-min max-hold backstop vs 3-min for
 *     gateway-boot). Cap: opts.cap ?? BOBBIT_V2_MAX_BROWSER ?? budget-caps.json
 *     ?? floor(cores/6).
 * acquire is fail-open: after timeoutMs it proceeds anyway (a `forced` lease) so
 * a boot/worker can never deadlock; dead holders are swept immediately on PID
 * liveness so a crashed run never wedges a slot.
 *
 * All exported reservations MUST be released on process exit; the ledger also
 * self-heals: every read sweeps entries whose owner PID is no longer alive.
 */
import {
	openSync,
	closeSync,
	writeSync,
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	unlinkSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, cpus } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const LEDGER_DIRNAME = "bobbit-test-v2-ledger";
const LOCK_STALE_MS = 30_000;
const PENDING_STALE_MS = 60_000;
const HEARTBEAT_MS = 2_000;
const DEFAULT_COALESCE_MS = 1_500;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_GRANT_TIMEOUT_MS = 180_000;
const MIN_BUNDLE = 4;
const MAX_BUNDLE = 12;
const VITEST_CAP = 8;
// Cap on chromium workers per run. Earlier tuning claimed "2 ≈ 4 workers
// throughput" (IO-bound), but a fresh isolated measurement on the 24-core box
// disproved that for a SOLO run: the tier-2 browser suite (~620 specs) took
// ~525 s at 2 workers vs ~140 s at 6 — a ~3.8x speedup, and the box was only
// reserving 10/24 cores at 2 workers. Raised 2 → 3 as a conservative step
// toward that headroom. The ledger's Σworkers≤cores reservation invariant AND
// the global browser-render lease (cap 4, bounds TOTAL concurrent Chromium
// across all runs) still gate N-way contention, so concurrent browser tiers
// remain bounded even though each run now reserves 3. This cap + those two
// bounds are the "gate total Chromium" half of the global concurrency budget
// (the gateway-boot lease is the other half). History: 4 (single-run fast
// path) → 2 (N-way flake analysis) → 3 (solo-speed measurement).
const PLAYWRIGHT_CAP = 3;

// ─── lease pools (global concurrency budget) ───
const LEASES_FILENAME = "leases.json";
const DEFAULT_LEASE_TIMEOUT_MS = 120_000; // fail-open after this (never deadlock a boot)
const LEASE_MAX_HOLD_MS = 180_000; // gateway-boot: held only for a boot (seconds) → 3-min backstop
// The browser-render lease is held for a Playwright WORKER's whole life (many
// tests, minutes) — legitimately far longer than a gateway boot. Its max-hold
// backstop must exceed any realistic worker lifetime so a LIVE browser lease is
// never swept out from under an active worker (which would break the cap and let
// an extra Chromium in). Dead holders are still reclaimed immediately by the
// PID-liveness sweep; this backstop only guards a leaked release on a hung PID.
const BROWSER_LEASE_MAX_HOLD_MS = 1_800_000; // 30 min
// Browser-render acquires WAIT for a free slot (respecting the cap) rather than
// force-proceeding early — the cap integrity is the whole point. This large
// timeout is only the ultimate anti-deadlock guard (beyond any realistic queue).
const DEFAULT_BROWSER_LEASE_TIMEOUT_MS = 1_200_000; // 20 min
const LEASE_POLL_MS = 150; // base backoff between saturated-pool retries (jittered)

const LEDGER_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const BUDGET_CAPS_PATH = join(LEDGER_FILE_DIR, "..", "..", "tests2", "budget-caps.json");

/** Per-pool max-hold backstop for the sweep (dead holders are always reclaimed). */
function leaseMaxHoldMs(pool) {
	return pool === "browser" ? BROWSER_LEASE_MAX_HOLD_MS : LEASE_MAX_HOLD_MS;
}

/** Read a committed per-pool cap from tests2/budget-caps.json (missing → null). */
function budgetCapFromFile(pool) {
	try {
		const parsed = JSON.parse(readFileSync(BUDGET_CAPS_PATH, "utf8"));
		const v = Number(parsed?.[pool]);
		return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
	} catch {
		return null;
	}
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function ledgerDir() {
	return join(tmpdir(), LEDGER_DIRNAME);
}

function reservationsPath() {
	return join(ledgerDir(), "reservations.json");
}

function lockPath() {
	return join(ledgerDir(), "ledger.lock");
}

function heartbeatPath(id) {
	return join(ledgerDir(), `${id}.heartbeat`);
}

function ensureDir() {
	mkdirSync(ledgerDir(), { recursive: true });
}

function totalCores(opts = {}) {
	const fromOpt = Number(opts.totalCores);
	if (Number.isFinite(fromOpt) && fromOpt > 0) return Math.floor(fromOpt);
	const fromEnv = Number(process.env.BOBBIT_V2_TOTAL_CORES);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
	return Math.max(1, cpus().length);
}

/** Sync sleep with jitter — configs need a blocking reserve at startup. */
function sleepSync(ms) {
	if (ms <= 0) return;
	const sab = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function jitter(baseMs) {
	return Math.floor(baseMs * (0.5 + Math.random()));
}

/** Robust PID liveness — Windows + POSIX. EPERM means the process exists. */
function pidAlive(pid) {
	if (!pid) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e && e.code === "EPERM";
	}
}

// ─────────────────────────────── lock ───────────────────────────────

function tryStealStaleLock() {
	try {
		const st = statSync(lockPath());
		let ownerPid = 0;
		try {
			ownerPid = JSON.parse(readFileSync(lockPath(), "utf8")).pid || 0;
		} catch {
			ownerPid = 0;
		}
		const ageMs = Date.now() - st.mtimeMs;
		if (!pidAlive(ownerPid) && ageMs > LOCK_STALE_MS) {
			unlinkSync(lockPath());
			return true;
		}
	} catch {
		/* lock vanished — fine */
	}
	return false;
}

function acquireLock(timeoutMs) {
	ensureDir();
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const fd = openSync(lockPath(), "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			return fd;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			tryStealStaleLock();
			if (Date.now() > deadline) {
				throw new Error(`ledger: could not acquire lock within ${timeoutMs}ms`);
			}
			sleepSync(jitter(50));
		}
	}
}

function releaseLock(fd) {
	try {
		closeSync(fd);
	} catch {
		/* ignore */
	}
	try {
		unlinkSync(lockPath());
	} catch {
		/* ignore */
	}
}

function withLock(fn, opts = {}) {
	const fd = acquireLock(opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	try {
		return fn();
	} finally {
		releaseLock(fd);
	}
}

// ──────────────────────────── reservations ────────────────────────────

function readRaw(cores) {
	try {
		const parsed = JSON.parse(readFileSync(reservationsPath(), "utf8"));
		if (parsed && Array.isArray(parsed.reservations)) {
			return {
				totalCores: parsed.totalCores || cores,
				generation: parsed.generation || 0,
				reservations: parsed.reservations,
				pending: Array.isArray(parsed.pending) ? parsed.pending : [],
			};
		}
	} catch {
		/* missing/corrupt — start fresh */
	}
	return { totalCores: cores, generation: 0, reservations: [], pending: [] };
}

function heartbeatFresh(id) {
	try {
		return Date.now() - statSync(heartbeatPath(id)).mtimeMs <= LOCK_STALE_MS;
	} catch {
		return false;
	}
}

/** Drop reservations whose owner PID is dead (or dead + stale heartbeat). */
function sweep(state, ownIds = new Set()) {
	const kept = [];
	const dropped = [];
	for (const r of state.reservations) {
		if (ownIds.has(r.id)) {
			kept.push(r);
			continue;
		}
		const alive = pidAlive(r.pid);
		if (alive && (heartbeatFresh(r.id) || Date.now() - Date.parse(r.startedAt || 0) < LOCK_STALE_MS)) {
			kept.push(r);
		} else if (alive) {
			// PID alive but heartbeat gone stale — keep (design sweeps on PID liveness).
			kept.push(r);
		} else {
			dropped.push(r);
			try {
				unlinkSync(heartbeatPath(r.id));
			} catch {
				/* ignore */
			}
		}
	}
	state.reservations = kept;
	return dropped;
}

/**
 * Drop pending markers whose owner PID is dead or that have out-lived the
 * coalescing+grant window. Pending markers exist ONLY so simultaneously-starting
 * runs count each other while deciding a fair per-run share; they carry no
 * worker slots and must never linger to deflate a later run's grant.
 */
function sweepPending(state) {
	if (!Array.isArray(state.pending)) {
		state.pending = [];
		return;
	}
	const now = Date.now();
	state.pending = state.pending.filter((p) => pidAlive(p.pid) && now - Date.parse(p.at || 0) < PENDING_STALE_MS);
}

function writeState(state) {
	state.generation = (state.generation || 0) + 1;
	writeFileSync(reservationsPath(), `${JSON.stringify(state, null, 2)}\n`);
}

function touchHeartbeat(id) {
	try {
		writeFileSync(heartbeatPath(id), String(Date.now()));
	} catch {
		try {
			const now = new Date();
			utimesSync(heartbeatPath(id), now, now);
		} catch {
			/* ignore */
		}
	}
}

function startHeartbeat(ids) {
	for (const id of ids) touchHeartbeat(id);
	const timer = setInterval(() => {
		for (const id of ids) touchHeartbeat(id);
	}, HEARTBEAT_MS);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
}

function newId(kind) {
	return `${kind}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────── grant + split ───────────────────────────

/**
 * Compute a fair, non-oversubscribing grant for `myParentRunId`.
 *
 * `activeParents` counts every distinct run currently competing for the machine:
 * both committed reservations AND pending markers (peers still inside their
 * coalescing window). This is the fix that keeps Σworkers ≤ cores under N-way
 * load: without counting pending peers, the first run to grab the lock sees
 * itself alone and takes the full MAX_BUNDLE (12), starving the rest and forcing
 * an overshoot. With pending counted, five simultaneous runs each see
 * activeParents=5 → target=floor(24/5)=4 → 5×4=20 ≤ 24.
 *
 * `grant` is additionally clamped to the cores that are actually free
 * (`remaining`), so a commit can never push the committed total over the cap.
 */
function computeGrant(state, myParentRunId, cores) {
	const parentSet = new Set();
	for (const r of state.reservations) parentSet.add(r.parentRunId);
	for (const p of state.pending || []) parentSet.add(p.parentRunId);
	parentSet.add(myParentRunId);
	const activeParents = Math.max(1, parentSet.size);
	const used = state.reservations.filter((r) => r.parentRunId !== myParentRunId).reduce((s, r) => s + (r.workerSlots || 0), 0);
	const remaining = cores - used;
	const target = clamp(Math.floor(cores / activeParents), MIN_BUNDLE, MAX_BUNDLE);
	const grant = Math.max(0, Math.min(target, remaining));
	return { grant, remaining, target, activeParents, used };
}

/**
 * Split a committed parent bundle into vitest + playwright worker counts.
 * Anchors (verified by selftest, single run / activeParents=1): 12→8v+3p,
 * 8→3v+3p, 6→2v+3p, 4→1v+3p. CONTENDED (activeParents≥2): 12→5v+3p (never the
 * full 8-vitest split — that would oversubscribe at N=2, where each run's
 * grant=floor(24/2)=12).
 *
 * GLOBAL BUDGET MODEL — two distinct contention sources, two distinct levers:
 *
 *   1. Transient gateway-BOOT CPU bursts → the cross-process gateway-boot lease
 *      (acquireGatewayBootLease, wired into both gateway fixtures) serialises them.
 *   2. SUSTAINED CPU contention on tier-2 browser RENDER work → CPU HEADROOM. The
 *      tier-2 flakes are `toBeVisible` timeouts: the app must render within the
 *      test timeout, which it can't when N full suites saturate all cores. So
 *      under contention we DELIBERATELY under-allocate vitest, leaving idle cores
 *      for the concurrent browser tiers to render into. (A prior iteration that
 *      filled all cores — Σ=24/24 at 3-way — starved browser render and regressed
 *      the green rate; restoring headroom, Σ≈15/24 at 3-way, is the fix.)
 *
 * Playwright targets PLAYWRIGHT_CAP (=3) chromium workers. A solo isolated run
 * measured ~3.8x faster raising browser workers (525 s → 140 s); 3 is a
 * conservative step into that headroom while the global browser-render lease
 * keeps concurrent Chromium bounded across runs.
 *
 * FULL-VITEST SPLIT IS GATED ON `activeParents === 1`, NOT on `grant ≥ MAX_BUNDLE`
 * alone. The bug this fixes: at N=2 each run's fair share is floor(24/2)=12 =
 * MAX_BUNDLE, so keying the uncontended split off `grant ≥ 12` gave BOTH runs the
 * full 8-vitest split → 16 vitest workers → CPU oversubscription (measured N=2
 * WORSE than N=3). The uncontended split is only safe when this run is genuinely
 * alone (activeParents===1); any concurrent peer forces the contended split even
 * at grant=12.
 *
 * Invariant: `vitest + playwright ≤ grant`, both ≥ 1 for a two-kind bundle, never
 * an overshoot. Under-allocation (idle cores) is intended headroom, not waste.
 */
export function splitBundle(grant, activeParents = 1) {
	const total = clamp(Math.floor(grant) || 0, 1, MAX_BUNDLE);
	if (total < 2) return { vitest: 1, playwright: 0, total: 1 };
	const playwright = clamp(Math.min(PLAYWRIGHT_CAP, total - 1), 1, PLAYWRIGHT_CAP);
	// Uncontended (a SINGLE run, activeParents===1, with a full grant): use the
	// box — full vitest parallelism for speed; the lone browser tier has ample
	// render headroom anyway. Keyed on activeParents, NOT grant≥12 — see docstring.
	if (total >= MAX_BUNDLE && activeParents <= 1) {
		return { vitest: VITEST_CAP, playwright, total: VITEST_CAP + playwright };
	}
	// Contended (2+ runs) OR a sub-max grant: under-allocate vitest (~half the
	// free-after-playwright budget) so Σworkers leaves cores idle for browser render.
	const vitest = clamp(Math.ceil(total / 2) - 1, 1, Math.min(VITEST_CAP, total - playwright));
	return { vitest, playwright, total: vitest + playwright };
}

// ─────────────────────────── reservation core ───────────────────────────

/**
 * Reserve a bundle of `kinds` under the atomic lock, retrying with jitter until
 * at least MIN_BUNDLE slots are available or the grant timeout elapses. Returns
 * the created reservation records + total granted.
 */
function removePending(state, parentRunId) {
	if (Array.isArray(state.pending)) {
		state.pending = state.pending.filter((p) => !(p.parentRunId === parentRunId && p.pid === process.pid));
	}
}

function registerPending(parentRunId, opts) {
	withLock(() => {
		const cores = totalCores(opts);
		const state = readRaw(cores);
		state.totalCores = cores;
		sweep(state);
		sweepPending(state);
		if (!state.pending.some((p) => p.parentRunId === parentRunId && p.pid === process.pid)) {
			state.pending.push({ parentRunId, pid: process.pid, at: new Date().toISOString() });
		}
		writeState(state);
	}, opts);
}

function reserveBundle(kinds, opts = {}) {
	const cores = totalCores(opts);
	const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
	const grantDeadline = Date.now() + (opts.grantTimeoutMs ?? DEFAULT_GRANT_TIMEOUT_MS);
	const parentRunId = opts.parentRunId || newId("parent");
	const twoKind = kinds.length === 2;
	// Two-kind (full run) wants at least MIN_BUNDLE so vitest+playwright each get a
	// useful share; single-kind (standalone core/browser) only needs ≥2.
	const preferredMin = twoKind ? MIN_BUNDLE : 2;
	const floorCommit = twoKind ? 2 : 1;

	// Best-effort cleanup: if we exit before committing, drop our pending marker so
	// we never deflate peers' fair share.
	const cleanupPending = () => {
		try {
			withLock(
				() => {
					const s = readRaw(totalCores(opts));
					removePending(s, parentRunId);
					writeState(s);
				},
				{ lockTimeoutMs: 2000 },
			);
		} catch {
			/* sweeper reclaims on PID liveness */
		}
	};

	// 1) Register a pending marker so simultaneously-starting peers count us while
	//    computing their own fair share.
	registerPending(parentRunId, opts);
	process.once("exit", cleanupPending);

	// 2) Coalescing window: let peers register their pending markers before anyone
	//    computes the shared budget, so no early runner over-allocates.
	sleepSync(coalesceMs);

	for (;;) {
		const outcome = withLock(() => {
			const state = readRaw(cores);
			state.totalCores = cores;
			sweep(state);
			sweepPending(state);
			const { grant, remaining, target, activeParents } = computeGrant(state, parentRunId, cores);

			let usableGrant = grant;
			if (grant < preferredMin) {
				// Not enough free cores for a fair share yet. Only take a reduced grant
				// once the deadline passes (never deadlock); otherwise wait for a peer to
				// finish. This is backpressure, not oversubscription.
				if (remaining >= floorCommit && Date.now() > grantDeadline) {
					usableGrant = Math.min(remaining, target || remaining, MAX_BUNDLE);
				} else {
					return { retry: true };
				}
			}

			// Hard invariant: never allocate more than the free cores.
			usableGrant = Math.min(usableGrant, remaining, MAX_BUNDLE);
			if (usableGrant < floorCommit) return { retry: true };

			const records = allocateKinds(kinds, usableGrant, activeParents);
			removePending(state, parentRunId);
			const startedAt = new Date().toISOString();
			for (const rec of records) {
				state.reservations.push({
					id: rec.id,
					parentRunId,
					pid: process.pid,
					kind: rec.kind,
					workerSlots: rec.workerSlots,
					startedAt,
					heartbeatAt: startedAt,
				});
			}
			writeState(state);
			return { retry: false, records, granted: usableGrant, generation: state.generation };
		}, opts);

		if (outcome.retry) {
			sleepSync(jitter(120));
			continue;
		}
		const heartbeat = startHeartbeat(outcome.records.map((r) => r.id));
		return { parentRunId, records: outcome.records, granted: outcome.granted, generation: outcome.generation, heartbeat };
	}
}

function allocateKinds(kinds, grant, activeParents = 1) {
	if (kinds.length === 2) {
		const { vitest, playwright } = splitBundle(grant, activeParents);
		return [
			{ id: newId("vitest"), kind: "vitest", workerSlots: vitest },
			{ id: newId("playwright"), kind: "playwright", workerSlots: playwright },
		];
	}
	const kind = kinds[0];
	const cap = kind === "playwright" ? PLAYWRIGHT_CAP : VITEST_CAP;
	return [{ id: newId(kind), kind, workerSlots: clamp(Math.min(grant, cap), 1, cap) }];
}

function releaseRecords(recordIds, heartbeat, opts = {}) {
	if (heartbeat) clearInterval(heartbeat);
	const idSet = new Set(recordIds);
	try {
		withLock(() => {
			const state = readRaw(totalCores(opts));
			state.reservations = state.reservations.filter((r) => !idSet.has(r.id));
			writeState(state);
		}, opts);
	} catch {
		/* best-effort — the sweeper will reclaim on next read */
	}
	for (const id of recordIds) {
		try {
			unlinkSync(heartbeatPath(id));
		} catch {
			/* ignore */
		}
	}
}

// ──────────────────── gateway-boot lease pool (global budget) ────────────────────

function leasesPath() {
	return join(ledgerDir(), LEASES_FILENAME);
}

function readLeasesRaw() {
	try {
		const parsed = JSON.parse(readFileSync(leasesPath(), "utf8"));
		if (parsed && Array.isArray(parsed.leases)) {
			return { leases: parsed.leases, generation: parsed.generation || 0 };
		}
	} catch {
		/* missing/corrupt — start fresh */
	}
	return { leases: [], generation: 0 };
}

/**
 * Drop leases whose owner PID is dead OR that have out-lived their pool's
 * max-hold backstop. gateway-boot wraps a boot (seconds) → 3-min backstop;
 * browser wraps a worker's whole life (minutes) → 30-min backstop. Dead holders
 * are reclaimed immediately regardless of age (PID liveness), so a crashed run
 * never wedges a slot; the age backstop only guards a leaked release on a hung
 * but still-alive PID.
 */
function sweepLeases(state) {
	const now = Date.now();
	state.leases = state.leases.filter((l) => pidAlive(l.pid) && now - Date.parse(l.at || 0) < leaseMaxHoldMs(l.pool));
}

function writeLeases(state) {
	state.generation = (state.generation || 0) + 1;
	writeFileSync(leasesPath(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Resolve the concurrent-holder cap for a lease pool.
 *
 * Priority: opts.cap (tests) > env override (tuning) > tests2/budget-caps.json
 * (committed static value) > built-in default. The env override lets the
 * authoritative measurement ramp a cap without editing the committed file each
 * run; the file is the source of truth between calibrations.
 *   gateway-boot env: BOBBIT_V2_MAX_GATEWAY_BOOTS
 *   browser     env: BOBBIT_V2_MAX_BROWSER  (generic BOBBIT_V2_MAX_<POOL>)
 */
export function leaseCap(pool, opts = {}) {
	const fromOpt = Number(opts.cap);
	if (Number.isFinite(fromOpt) && fromOpt > 0) return Math.floor(fromOpt);

	const envKey = pool === "gateway-boot" ? "BOBBIT_V2_MAX_GATEWAY_BOOTS" : `BOBBIT_V2_MAX_${pool.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
	const env = Number(process.env[envKey]);
	if (Number.isFinite(env) && env > 0) return Math.floor(env);

	const fromFile = budgetCapFromFile(pool);
	if (fromFile != null) return fromFile;

	if (pool === "gateway-boot") {
		// ~1 boot per 6 cores: 24-core box → 4 simultaneous boots. Small enough to
		// keep the transient boot CPU burst well under the core count at ANY N,
		// large enough that a single isolated run barely queues.
		return clamp(Math.floor(totalCores(opts) / 6), 2, 8);
	}
	if (pool === "browser") {
		// Sustained Chromium render contention (tier-2 toBeVisible flakes). Default
		// mirrors gateway-boot (~1 per 6 cores) until the committed budget-caps.json
		// value / measurement refines it.
		return clamp(Math.floor(totalCores(opts) / 6), 2, 8);
	}
	return clamp(Math.floor(totalCores(opts) / 4), 2, MAX_BUNDLE);
}

const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire a lease from a cross-process pool, WAITING (async) while the pool is
 * saturated. Returns once granted; the returned release() removes the lease.
 * Fail-open: after opts.timeoutMs the lease is granted anyway (`forced:true`)
 * so a heavy op can never deadlock behind a mis-counted or slow peer.
 */
export async function acquireLease(pool, opts = {}) {
	const id = newId(`lease-${pool}`);
	const cap = leaseCap(pool, opts);
	const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS);
	let forced = false;
	for (;;) {
		const outcome = withLock(() => {
			const state = readLeasesRaw();
			sweepLeases(state);
			const held = state.leases.filter((l) => l.pool === pool).length;
			const timedOut = Date.now() > deadline;
			if (held < cap || timedOut) {
				const wasForced = timedOut && held >= cap;
				state.leases.push({ id, pool, pid: process.pid, at: new Date().toISOString(), forced: wasForced });
				writeLeases(state);
				return { granted: true, forced: wasForced };
			}
			// Persist the sweep so a dead holder's slot is freed for peers even when
			// we ourselves don't get in this round.
			writeLeases(state);
			return { granted: false };
		}, opts);
		if (outcome.granted) {
			forced = outcome.forced;
			break;
		}
		await sleepAsync(jitter(LEASE_POLL_MS));
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseLeaseById(id, opts);
	};
	process.once("exit", release);
	return { release, id, forced, pool, cap };
}

function releaseLeaseById(id, opts = {}) {
	try {
		withLock(() => {
			const state = readLeasesRaw();
			state.leases = state.leases.filter((l) => l.id !== id);
			writeLeases(state);
		}, { lockTimeoutMs: opts.lockTimeoutMs ?? 5000 });
	} catch {
		/* best-effort — the sweeper reclaims on PID liveness / max-hold age */
	}
}

/** Convenience wrapper: the primary contention source is gateway boots. */
export function acquireGatewayBootLease(opts = {}) {
	return acquireLease("gateway-boot", opts);
}

/**
 * Convenience wrapper for the browser-render pool: caps TOTAL concurrent
 * Chromium browser workers across ALL runs (the sustained tier-2 render
 * contention that drives toBeVisible flakes at N-way). Held for a Playwright
 * worker's whole life (acquire at worker startup, release at teardown), so it
 * WAITS for a free slot rather than force-proceeding — the cap integrity is the
 * point. Pass a custom timeoutMs only to relax the anti-deadlock guard.
 */
export function acquireBrowserRenderLease(opts = {}) {
	return acquireLease("browser", { timeoutMs: DEFAULT_BROWSER_LEASE_TIMEOUT_MS, ...opts });
}

export function readLeases(opts = {}) {
	if (!existsSync(leasesPath())) return { leases: [], generation: 0 };
	return withLock(() => {
		const state = readLeasesRaw();
		const before = state.leases.length;
		sweepLeases(state);
		if (state.leases.length !== before) writeLeases(state);
		return state;
	}, opts);
}

// ─────────────────────────────── public ───────────────────────────────

export function reserveParentBundle(opts = {}) {
	const { parentRunId, records, granted, generation, heartbeat } = reserveBundle(["vitest", "playwright"], opts);
	const vitest = records.find((r) => r.kind === "vitest").workerSlots;
	const playwright = records.find((r) => r.kind === "playwright").workerSlots;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseRecords(records.map((r) => r.id), heartbeat, opts);
	};
	process.once("exit", release);
	return {
		parentRunId,
		vitest,
		playwright,
		total: granted,
		generation,
		release,
		childEnv: {
			BOBBIT_V2_LEDGER_PARENT: parentRunId,
			BOBBIT_V2_SLOTS_VITEST: String(vitest),
			BOBBIT_V2_SLOTS_PLAYWRIGHT: String(playwright),
		},
	};
}

export function reserveWorkerSlots(kind, opts = {}) {
	if (kind !== "vitest" && kind !== "playwright") {
		throw new Error(`reserveWorkerSlots: kind must be "vitest" | "playwright", got ${JSON.stringify(kind)}`);
	}
	const envKey = kind === "vitest" ? "BOBBIT_V2_SLOTS_VITEST" : "BOBBIT_V2_SLOTS_PLAYWRIGHT";
	const parentRunId = process.env.BOBBIT_V2_LEDGER_PARENT;

	// Under a parent orchestrator: reuse the pre-committed grant, no re-register.
	if (parentRunId && process.env[envKey] != null && process.env[envKey] !== "") {
		const workerSlots = Math.max(1, Number(process.env[envKey]) || 1);
		return { workerSlots, release: () => {}, reservationId: `${parentRunId}:${kind}`, parentRunId, managedByParent: true };
	}

	// Standalone: reserve a single-kind bundle and own the reservation.
	const { parentRunId: runId, records, heartbeat } = reserveBundle([kind], opts);
	const record = records[0];
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseRecords([record.id], heartbeat, opts);
	};
	process.once("exit", release);
	return { workerSlots: record.workerSlots, release, reservationId: record.id, parentRunId: runId, managedByParent: false };
}

export function readLedger(opts = {}) {
	const cores = totalCores(opts);
	if (!existsSync(reservationsPath())) return { totalCores: cores, generation: 0, reservations: [] };
	return withLock(() => {
		const state = readRaw(cores);
		const before = (state.pending || []).length;
		const dropped = sweep(state);
		sweepPending(state);
		if (dropped.length || (state.pending || []).length !== before) writeState(state);
		return state;
	}, opts);
}

// ─────────────────────────────── CLI ───────────────────────────────

function cliStatus() {
	const state = readLedger();
	const used = state.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
	console.log(`ledger @ ${ledgerDir()}`);
	console.log(`  totalCores=${state.totalCores}  generation=${state.generation}  reserved=${used}/${state.totalCores}`);
	for (const r of state.reservations) {
		console.log(`  - ${r.kind.padEnd(11)} slots=${r.workerSlots} pid=${r.pid} parent=${r.parentRunId} id=${r.id}`);
	}
	if (!state.reservations.length) console.log("  (no active reservations)");

	const leaseState = readLeases();
	const gbCap = leaseCap("gateway-boot");
	const gbHeld = leaseState.leases.filter((l) => l.pool === "gateway-boot").length;
	const brCap = leaseCap("browser");
	const brHeld = leaseState.leases.filter((l) => l.pool === "browser").length;
	console.log(`  leases: gateway-boot ${gbHeld}/${gbCap}  browser ${brHeld}/${brCap}`);
	for (const l of leaseState.leases) {
		console.log(`    - ${l.pool} pid=${l.pid} at=${l.at}${l.forced ? " (forced)" : ""} id=${l.id}`);
	}
}

function assert(cond, msg) {
	if (!cond) {
		console.error(`ledger selftest: FAIL — ${msg}`);
		process.exit(1);
	}
}

function cliSelftest() {
	// Isolate: use a generous core count and a clean state.
	process.env.BOBBIT_V2_TOTAL_CORES = process.env.BOBBIT_V2_TOTAL_CORES || "24";
	ensureDir();
	try {
		rmSync(reservationsPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}

	console.log("ledger selftest: totalCores=" + totalCores());

	// 1) Seed a reservation owned by a guaranteed-DEAD pid.
	const dead = spawnSync(process.execPath, ["-e", "0"]);
	const deadPid = dead.pid;
	assert(!pidAlive(deadPid), `spawned helper pid ${deadPid} should be dead after spawnSync`);
	writeFileSync(
		reservationsPath(),
		JSON.stringify(
			{
				totalCores: totalCores(),
				generation: 1,
				reservations: [
					{ id: "ghost-1", parentRunId: "ghost", pid: deadPid, kind: "vitest", workerSlots: 8, startedAt: new Date(0).toISOString(), heartbeatAt: new Date(0).toISOString() },
				],
			},
			null,
			2,
		),
	);
	console.log(`  seeded dead-pid reservation (pid=${deadPid}, slots=8)`);

	// 2) Reserve a parent bundle — this must sweep the ghost first.
	const parent = reserveParentBundle({ coalesceMs: 0 });
	console.log(`  reserveParentBundle -> vitest=${parent.vitest} playwright=${parent.playwright} total=${parent.total} parent=${parent.parentRunId}`);
	const afterReserve = readLedger();
	assert(!afterReserve.reservations.some((r) => r.id === "ghost-1"), "dead-pid reservation should be swept");
	assert(parent.vitest >= 2 && parent.vitest <= VITEST_CAP, `vitest slots in range: ${parent.vitest}`);
	assert(parent.playwright >= 1 && parent.playwright <= PLAYWRIGHT_CAP, `playwright slots in range: ${parent.playwright}`);
	const sum1 = afterReserve.reservations.reduce((s, r) => s + r.workerSlots, 0);
	assert(sum1 <= totalCores(), `sum(workerSlots)=${sum1} <= cores=${totalCores()}`);
	console.log("  dead-pid reservation swept ✓; invariant sum<=cores ✓");

	// 3) Standalone reserveWorkerSlots re-uses shared budget without oversubscribing.
	const solo = reserveWorkerSlots("vitest", { coalesceMs: 0 });
	console.log(`  reserveWorkerSlots("vitest") -> ${solo.workerSlots} slots (id=${solo.reservationId})`);
	const afterSolo = readLedger();
	const sum2 = afterSolo.reservations.reduce((s, r) => s + r.workerSlots, 0);
	assert(sum2 <= totalCores(), `sum(workerSlots)=${sum2} <= cores=${totalCores()} after standalone reserve`);

	// 4) Release everything; ledger returns to empty.
	solo.release();
	parent.release();
	const afterRelease = readLedger();
	assert(afterRelease.reservations.length === 0, `all reservations released, found ${afterRelease.reservations.length}`);
	console.log("  release() clears reservations ✓");

	// 5) splitBundle spot-checks + sum-preservation across the whole range.
	// Default (activeParents=1, a single uncontended run): 2 chromium workers +
	// UNDER-ALLOCATED vitest under contention (headroom for browser render).
	// 8→3v+3p, 4→1v+3p. A lone run at a full grant uses the full vitest cap:
	// 12→8v+3p.
	const s4 = splitBundle(4);
	const s8 = splitBundle(8);
	const s12 = splitBundle(12);
	assert(s4.vitest === 1 && s4.playwright === 3, `split(4)=1v+3p got ${s4.vitest}+${s4.playwright}`);
	assert(s8.vitest === 3 && s8.playwright === 3, `split(8)=3v+3p got ${s8.vitest}+${s8.playwright}`);
	assert(s12.vitest === 8 && s12.playwright === 3, `split(12,solo)=8v+3p got ${s12.vitest}+${s12.playwright}`);
	// CONTENDED FULL GRANT (the N=2 oversubscription bug): activeParents≥2 at
	// grant=12 must NOT take the full 8-vitest split — it takes the contended
	// 5v+3p, so two N=2 runs total 10v+6p=16 ≤ 24 (not 16v+6p=22 that starved the
	// box and made N=2 measure WORSE than N=3).
	const s12c = splitBundle(12, 2);
	assert(s12c.vitest === 5 && s12c.playwright === 3, `split(12,contended)=5v+3p got ${s12c.vitest}+${s12c.playwright}`);
	assert(2 * s12c.total <= totalCores(), `two N=2 contended grants (${s12c.total} each) must fit cores=${totalCores()}`);
	// The uncontended full-vitest split fires ONLY at activeParents≤1.
	assert(splitBundle(12, 1).vitest === VITEST_CAP, "activeParents=1 keeps the full-vitest split");
	for (let g = 2; g <= MAX_BUNDLE; g++) {
		for (const ap of [1, 2, 5]) {
			const s = splitBundle(g, ap);
			// Never overshoot the grant; under-allocation (idle core) is allowed + safe.
			assert(s.total <= g, `splitBundle(${g},${ap}) must not exceed grant, got ${s.vitest}+${s.playwright}=${s.total}`);
			assert(s.vitest <= VITEST_CAP && s.playwright <= PLAYWRIGHT_CAP, `splitBundle(${g},${ap}) within caps, got v=${s.vitest} pw=${s.playwright}`);
			assert(s.vitest >= 1 && s.playwright >= 1, `splitBundle(${g},${ap}) both kinds ≥1, got v=${s.vitest} pw=${s.playwright}`);
			// Contended must never exceed the solo split's vitest at the same grant.
			if (ap >= 2) assert(s.vitest <= splitBundle(g, 1).vitest, `splitBundle(${g},${ap}) vitest must not exceed solo`);
		}
	}
	console.log("  splitBundle(4)=1v+3p ✓  split(8)=3v+3p ✓  split(12,solo)=8v+3p ✓  split(12,contended)=5v+3p ✓  no-overshoot 2..12×ap ✓");

	// 6) Pending-contention: seed 4 live pending markers (distinct runs) so a fresh
	//    reserve sees activeParents=5 → target=floor(24/5)=4. This is the core
	//    Σworkers≤cores fix — the reserve must NOT grab the full MAX_BUNDLE.
	try {
		rmSync(reservationsPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}
	const nowIso = new Date().toISOString();
	writeFileSync(
		reservationsPath(),
		JSON.stringify(
			{
				totalCores: totalCores(),
				generation: 1,
				reservations: [],
				pending: [1, 2, 3, 4].map((n) => ({ parentRunId: `peer-${n}`, pid: process.pid, at: nowIso })),
			},
			null,
			2,
		),
	);
	const contended = reserveParentBundle({ coalesceMs: 0 });
	console.log(`  under 4 pending peers -> vitest=${contended.vitest} playwright=${contended.playwright} total=${contended.total}`);
	assert(contended.total <= Math.floor(totalCores() / 5), `contended grant ${contended.total} must be ≤ floor(cores/5)=${Math.floor(totalCores() / 5)}`);
	const afterContended = readLedger();
	const sum3 = afterContended.reservations.reduce((s, r) => s + r.workerSlots, 0);
	assert(sum3 <= totalCores(), `sum(workerSlots)=${sum3} ≤ cores=${totalCores()} under contention`);
	contended.release();
	console.log("  pending-contention caps per-run grant ✓");

	// 7) N=2 reserve path (the fixed oversubscription bug): with exactly ONE live
	//    pending peer, a fresh reserve sees activeParents=2 and a full grant
	//    (floor(24/2)=12=MAX_BUNDLE) — but must take the CONTENDED split (5v+3p), NOT
	//    the uncontended 8v+3p that made two N=2 runs oversubscribe (16v total).
	try {
		rmSync(reservationsPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}
	writeFileSync(
		reservationsPath(),
		JSON.stringify(
			{ totalCores: totalCores(), generation: 1, reservations: [], pending: [{ parentRunId: "n2-peer", pid: process.pid, at: new Date().toISOString() }] },
			null,
			2,
		),
	);
	const n2 = reserveParentBundle({ coalesceMs: 0 });
	console.log(`  N=2 (1 pending peer, grant=12) -> vitest=${n2.vitest} playwright=${n2.playwright} total=${n2.total}`);
	assert(n2.vitest === 5 && n2.playwright === 3, `N=2 reserve must take contended 5v+3p, got ${n2.vitest}v+${n2.playwright}p`);
	assert(2 * n2.total <= totalCores(), `two N=2 grants (${n2.total} each) must fit cores=${totalCores()}`);
	n2.release();
	console.log("  N=2 reserve path uses contended split (no oversubscription) ✓");

	try {
		rmSync(reservationsPath(), { force: true });
	} catch {
		/* ignore */
	}
	console.log("ledger selftest: PASS");
}

// ─────────────────────── reserve-hold (stress child) ───────────────────────

/**
 * A single stress child: reserve (parent bundle or one kind), print the grant
 * and the current committed Σworkers, hold for `holdMs`, then release. Used by
 * cliStress to model real `test:v2` runs without spawning the whole suite.
 */
function cliReserveHold(kind, holdMs, coalesceMs) {
	const reservation = kind === "parent" ? reserveParentBundle({ coalesceMs }) : reserveWorkerSlots(kind, { coalesceMs });
	const snap = readLedger();
	const sigma = snap.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
	const grant = kind === "parent" ? reservation.total : reservation.workerSlots;
	const detail = kind === "parent" ? `vitest=${reservation.vitest} playwright=${reservation.playwright}` : `${kind}=${reservation.workerSlots}`;
	console.log(`RESERVED pid=${process.pid} ${detail} total=${grant} sigma=${sigma}/${snap.totalCores}`);
	if (sigma > snap.totalCores) {
		console.error(`INVARIANT VIOLATION at reserve: sigma=${sigma} > cores=${snap.totalCores}`);
		process.exit(3);
	}
	setTimeout(() => {
		reservation.release();
		process.exit(0);
	}, holdMs);
}

// ─────────────────────────── stress harness ───────────────────────────

/**
 * cliStress — spawn N reservation-only children with staggered starts, poll the
 * ledger throughout, and assert peak Σworkers ≤ cores. This validates the
 * Σworkers≤cores invariant under realistic concurrency (near-simultaneous AND
 * staggered starts, plus a mid-run straggler and a killed child) WITHOUT running
 * the test suite — so it is valid even on a shared/busy machine.
 *
 * usage: node scripts/testing-v2/ledger.mjs --stress [N=5] [staggerMs=0] [holdMs=6000]
 */
async function cliStress() {
	process.env.BOBBIT_V2_TOTAL_CORES = process.env.BOBBIT_V2_TOTAL_CORES || "24";
	const cores = totalCores();
	const N = Number(process.argv[3]) || 5;
	const staggerMs = Number(process.argv[4]) || 0;
	const holdMs = Number(process.argv[5]) || 6000;
	const coalesceMs = Number(process.env.BOBBIT_V2_STRESS_COALESCE_MS) || 1500;
	const killIdx = process.env.BOBBIT_V2_STRESS_KILL ? Number(process.env.BOBBIT_V2_STRESS_KILL) : -1;

	ensureDir();
	try {
		rmSync(reservationsPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}

	console.log(`ledger stress: cores=${cores} children=${N} stagger=${staggerMs}ms hold=${holdMs}ms coalesce=${coalesceMs}ms${killIdx >= 0 ? ` kill=#${killIdx}` : ""}`);
	const selfPath = fileURLToPath(import.meta.url);
	let peakSigma = 0;
	let peakCount = 0;
	let violated = false;

	// Poll the ledger every 200ms; record peak Σ and flag any overshoot.
	const poll = setInterval(() => {
		try {
			const state = readLedger({ lockTimeoutMs: 2000 });
			const sigma = state.reservations.reduce((s, r) => s + (r.workerSlots || 0), 0);
			if (sigma > peakSigma) peakSigma = sigma;
			if (state.reservations.length > peakCount) peakCount = state.reservations.length;
			if (sigma > cores) {
				violated = true;
				console.error(`  POLL VIOLATION: sigma=${sigma} > cores=${cores} (reservations=${state.reservations.length})`);
			}
		} catch {
			/* locked — skip */
		}
	}, 200);

	// Spawn N children with staggered starts; each reserves a parent bundle and
	// holds. Optionally hard-kill one mid-hold to prove the sweep frees its slots
	// (dead-PID reservation + pending are reclaimed on the next read).
	const waits = [];
	for (let i = 0; i < N; i++) {
		if (i > 0 && staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
		const child = spawn(process.execPath, [selfPath, "--reserve-hold", "parent", String(holdMs)], {
			stdio: "inherit",
			env: { ...process.env, BOBBIT_V2_STRESS_COALESCE_MS: String(coalesceMs) },
		});
		const label = `run-${i + 1}`;
		const idx = i;
		waits.push(
			new Promise((resolveChild) => {
				child.on("close", (code, signal) => resolveChild({ label, code: code ?? (signal ? 137 : 0), killed: idx === killIdx }));
				child.on("error", () => resolveChild({ label, code: 1, killed: false }));
			}),
		);
		if (idx === killIdx) {
			// Let it reserve, then kill it hard (no release) to exercise the sweep.
			setTimeout(() => child.kill("SIGKILL"), coalesceMs + 1500);
		}
	}

	const results = await Promise.all(waits);
	clearInterval(poll);

	// A killed child is EXPECTED to exit non-zero; that is not a failure.
	const unexpectedBad = results.filter((r) => r.code !== 0 && !r.killed);
	for (const r of unexpectedBad) console.error(`  child ${r.label} exited ${r.code} (unexpected)`);

	// Give the sweeper a beat, then confirm the ledger drained.
	await new Promise((r) => setTimeout(r, 500));
	const finalState = readLedger();
	const leftover = finalState.reservations.length;
	console.log(`ledger stress: peak Σ=${peakSigma}/${cores}  peak reservations=${peakCount}  leftover=${leftover}  unexpectedBadExits=${unexpectedBad.length}`);

	let ok = true;
	if (violated || peakSigma > cores) {
		console.error("ledger stress: FAIL — Σworkers exceeded cores at some point");
		ok = false;
	}
	if (unexpectedBad.length > 0) {
		console.error("ledger stress: FAIL — a non-killed child hit the reserve-time invariant guard");
		ok = false;
	}
	if (leftover > 0) {
		console.error(`ledger stress: FAIL — ${leftover} reservation(s) not released/swept`);
		ok = false;
	}
	console.log(ok ? "ledger stress: PASS" : "ledger stress: FAILED");
	process.exit(ok ? 0 : 1);
}

// ─────────────────────── lease-pool selftest + stress ───────────────────────

/** Reserve a gateway-boot lease, print the live holder count, hold, release. */
async function cliLeaseHold(holdMs, cap) {
	const opts = cap ? { cap } : {};
	const lease = await acquireLease("gateway-boot", opts);
	const snap = readLeases();
	const held = snap.leases.filter((l) => l.pool === "gateway-boot").length;
	const effectiveCap = leaseCap("gateway-boot", opts);
	console.log(`LEASED pid=${process.pid} held=${held}/${effectiveCap}${lease.forced ? " (forced)" : ""}`);
	if (held > effectiveCap && !lease.forced) {
		console.error(`LEASE INVARIANT VIOLATION at acquire: held=${held} > cap=${effectiveCap}`);
		process.exit(3);
	}
	await sleepAsync(holdMs);
	lease.release();
	process.exit(0);
}

/**
 * cliLeaseStress — spawn N lease-hold children with staggered starts, poll the
 * lease pool throughout, and assert peak concurrent holders ≤ cap. Proves the
 * cross-process gateway-boot budget without running the suite (valid on a busy
 * box). usage: node ledger.mjs --lease-stress [N=8] [staggerMs=50] [holdMs=1500] [cap=3]
 */
async function cliLeaseStress() {
	process.env.BOBBIT_V2_TOTAL_CORES = process.env.BOBBIT_V2_TOTAL_CORES || "24";
	const N = Number(process.argv[3]) || 8;
	const staggerMs = Number(process.argv[4]) || 50;
	const holdMs = Number(process.argv[5]) || 1500;
	const cap = Number(process.argv[6]) || 3;

	ensureDir();
	try {
		rmSync(leasesPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}

	console.log(`lease stress: cap=${cap} children=${N} stagger=${staggerMs}ms hold=${holdMs}ms`);
	const selfPath = fileURLToPath(import.meta.url);
	let peakHeld = 0;
	let violated = false;

	const poll = setInterval(() => {
		try {
			const state = readLeases({ lockTimeoutMs: 2000 });
			const held = state.leases.filter((l) => l.pool === "gateway-boot").length;
			if (held > peakHeld) peakHeld = held;
			if (held > cap) {
				violated = true;
				console.error(`  POLL VIOLATION: held=${held} > cap=${cap}`);
			}
		} catch {
			/* locked — skip */
		}
	}, 100);

	const waits = [];
	for (let i = 0; i < N; i++) {
		if (i > 0 && staggerMs > 0) await sleepAsync(staggerMs);
		const child = spawn(process.execPath, [selfPath, "--lease-hold", String(holdMs), String(cap)], {
			stdio: "inherit",
			env: { ...process.env, BOBBIT_V2_MAX_GATEWAY_BOOTS: String(cap) },
		});
		waits.push(
			new Promise((resolveChild) => {
				child.on("close", (code, signal) => resolveChild(code ?? (signal ? 137 : 0)));
				child.on("error", () => resolveChild(1));
			}),
		);
	}

	const codes = await Promise.all(waits);
	clearInterval(poll);
	await sleepAsync(300);
	const leftover = readLeases().leases.length;
	const badCodes = codes.filter((c) => c !== 0);
	console.log(`lease stress: peak held=${peakHeld}/${cap}  leftover=${leftover}  badExits=${badCodes.length}${badCodes.length ? ` (codes=${badCodes.join(",")})` : ""}`);

	let ok = true;
	if (violated || peakHeld > cap) {
		console.error("lease stress: FAIL — concurrent holders exceeded cap");
		ok = false;
	}
	if (badCodes.length > 0) {
		console.error(`lease stress: FAIL — ${badCodes.length} child(ren) exited non-zero (codes=${badCodes.join(",")})`);
		ok = false;
	}
	if (leftover > 0) {
		console.error(`lease stress: FAIL — ${leftover} lease(s) not released/swept`);
		ok = false;
	}
	console.log(ok ? "lease stress: PASS" : "lease stress: FAILED");
	process.exit(ok ? 0 : 1);
}

/** In-process lease selftest: cap enforcement, fail-open, dead-PID sweep. */
async function cliLeaseSelftest() {
	process.env.BOBBIT_V2_TOTAL_CORES = process.env.BOBBIT_V2_TOTAL_CORES || "24";
	ensureDir();
	try {
		rmSync(leasesPath(), { force: true });
		rmSync(lockPath(), { force: true });
	} catch {
		/* ignore */
	}
	console.log("lease selftest: begin");

	// 1) cap resolution: budget-caps.json (gateway-boot=browser=4) and opts.cap override.
	assert(leaseCap("gateway-boot") === 4, `gateway-boot cap should be 4 (budget-caps.json/default), got ${leaseCap("gateway-boot")}`);
	assert(leaseCap("browser") === 4, `browser cap should be 4 (budget-caps.json), got ${leaseCap("browser")}`);
	assert(leaseCap("gateway-boot", { cap: 2 }) === 2, `opts.cap overrides, got ${leaseCap("gateway-boot", { cap: 2 })}`);
	assert(leaseCap("browser", { cap: 6 }) === 6, `browser opts.cap overrides, got ${leaseCap("browser", { cap: 6 })}`);

	// 2) Acquire up to cap; the (cap+1)th must WAIT (not grant immediately),
	//    then be granted after a holder releases.
	const cap = 2;
	const l1 = await acquireLease("gateway-boot", { cap });
	const l2 = await acquireLease("gateway-boot", { cap });
	assert(readLeases().leases.length === 2, `two leases held, got ${readLeases().leases.length}`);
	let l3Granted = false;
	const l3Promise = acquireLease("gateway-boot", { cap, timeoutMs: 5000 }).then((l) => {
		l3Granted = true;
		return l;
	});
	await sleepAsync(400);
	assert(!l3Granted, "3rd lease must WAIT while pool is at cap (backpressure)");
	l1.release();
	const l3 = await l3Promise;
	assert(l3Granted && !l3.forced, "3rd lease granted (not forced) after a holder released");
	l2.release();
	l3.release();
	assert(readLeases().leases.length === 0, `all leases released, found ${readLeases().leases.length}`);
	console.log("  cap enforcement + wait-then-grant ✓");

	// 3) Fail-open: at cap with a short timeout, acquire proceeds as `forced`.
	const h1 = await acquireLease("gateway-boot", { cap: 1 });
	const forcedLease = await acquireLease("gateway-boot", { cap: 1, timeoutMs: 300 });
	assert(forcedLease.forced, "acquire past deadline must fail-open with forced:true (never deadlock)");
	h1.release();
	forcedLease.release();
	console.log("  fail-open forced lease after timeout ✓");

	// 4) Dead-PID sweep: seed a lease owned by a dead pid; a fresh acquire at cap=1
	//    must reclaim it rather than block forever.
	const dead = spawnSync(process.execPath, ["-e", "0"]);
	writeFileSync(
		leasesPath(),
		JSON.stringify({ generation: 1, leases: [{ id: "ghost-lease", pool: "gateway-boot", pid: dead.pid, at: new Date().toISOString() }] }, null, 2),
	);
	const reclaimed = await acquireLease("gateway-boot", { cap: 1, timeoutMs: 3000 });
	assert(!reclaimed.forced, "dead-pid lease should be swept so a fresh acquire is granted normally (not forced)");
	assert(readLeases().leases.length === 1, `only the live lease remains, got ${readLeases().leases.length}`);
	reclaimed.release();
	console.log("  dead-pid lease swept ✓");

	// 5) Per-pool max-hold: a LIVE lease aged past the gateway-boot backstop (3
	//    min) is swept, but a LIVE browser lease of the same age is NOT (30-min
	//    backstop) — a worker legitimately holds its browser lease for minutes and
	//    must never have its slot swept out from under it. Seed both owned by THIS
	//    (live) pid, aged 5 min.
	const agedIso = new Date(Date.now() - 300_000).toISOString();
	writeFileSync(
		leasesPath(),
		JSON.stringify(
			{
				generation: 1,
				leases: [
					{ id: "aged-gw", pool: "gateway-boot", pid: process.pid, at: agedIso },
					{ id: "aged-browser", pool: "browser", pid: process.pid, at: agedIso },
				],
			},
			null,
			2,
		),
	);
	const afterAgeSweep = readLeases().leases;
	assert(!afterAgeSweep.some((l) => l.id === "aged-gw"), "live gateway-boot lease aged past 3-min backstop should be swept");
	assert(afterAgeSweep.some((l) => l.id === "aged-browser"), "live browser lease aged 5 min must NOT be swept (30-min backstop)");
	console.log("  per-pool max-hold: gateway-boot swept @5min, browser retained ✓");

	try {
		rmSync(leasesPath(), { force: true });
	} catch {
		/* ignore */
	}
	console.log("lease selftest: PASS");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const arg = process.argv[2] || "--status";
	if (arg === "--selftest") {
		cliSelftest();
		cliLeaseSelftest().catch((e) => {
			console.error("lease selftest: fatal:", e);
			process.exit(1);
		});
	} else if (arg === "--lease-selftest") cliLeaseSelftest().catch((e) => {
		console.error("lease selftest: fatal:", e);
		process.exit(1);
	});
	else if (arg === "--status") cliStatus();
	else if (arg === "--stress") cliStress().catch((e) => {
		console.error("ledger stress: fatal:", e);
		process.exit(1);
	});
	else if (arg === "--lease-stress") cliLeaseStress().catch((e) => {
		console.error("lease stress: fatal:", e);
		process.exit(1);
	});
	else if (arg === "--reserve-hold") {
		const kind = process.argv[3] || "parent";
		const holdMs = Number(process.argv[4]) || 6000;
		const coalesceMs = Number(process.env.BOBBIT_V2_STRESS_COALESCE_MS) || 1500;
		cliReserveHold(kind, holdMs, coalesceMs);
	} else if (arg === "--lease-hold") {
		const holdMs = Number(process.argv[3]) || 1500;
		const cap = Number(process.argv[4]) || 0;
		cliLeaseHold(holdMs, cap).catch((e) => {
			console.error("lease hold: fatal:", e);
			process.exit(1);
		});
	} else {
		console.log("usage: node scripts/testing-v2/ledger.mjs [--status | --selftest | --lease-selftest | --stress [N] [staggerMs] [holdMs] | --lease-stress [N] [staggerMs] [holdMs] [cap]]");
		process.exit(2);
	}
}
