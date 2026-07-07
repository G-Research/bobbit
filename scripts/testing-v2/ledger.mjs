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
 *       splits it into vitest + playwright child reservations (4→2+2, 12→8+4,
 *       cap vitest 8 / playwright 4), registers both, and returns the split plus
 *       `childEnv` to pass to spawned tier children so their config's
 *       reserveWorkerSlots() re-uses the grant instead of re-reserving.
 *
 *   readLedger() -> reservations snapshot (swept).  ledgerDir() -> state dir path.
 *
 * opts (both): { coalesceMs?, totalCores?, lockTimeoutMs?, grantTimeoutMs? }
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
import { join } from "node:path";
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
const PLAYWRIGHT_CAP = 4;

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
 * Anchors (verified by selftest): 12→8v+4p, 8→7v+1p, 6→5v+1p, 4→3v+1p.
 *
 * PLAYWRIGHT IS THE HEAVY TIER. Measured: 3 concurrent `test:v2:core` (tier-1
 * only) pass cleanly, but adding the browser tier (2 playwright workers/run × 3
 * = 6 chromium + per-test gateways) starves tier-1's gateway-booting integration
 * tests into timeouts. So under contention we allocate exactly ONE playwright
 * worker per run and give the rest of the bundle to vitest: this minimises the
 * count of simultaneous browsers (the tier-1 starvation driver) while keeping
 * tier-1 fast. A single, uncontended run (bundle ≥ 12) still gets the full
 * 8v+4p so isolated `test:v2` stays < 300 s.
 *
 * Invariant: `vitest + playwright ≤ grant` for every input, and both ≥ 1 for a
 * two-kind bundle. NEVER returns a total larger than its grant (that was the old
 * "+3 overshoot" bug), so the caller can clamp grant ≤ remaining and stay within
 * the free-core budget. Under-allocating (leaving a core idle) is allowed and
 * safe; it only happens at bundle sizes floor(cores/n) never actually produces.
 */
export function splitBundle(grant) {
	const total = clamp(Math.floor(grant) || 0, 1, MAX_BUNDLE);
	if (total < 2) return { vitest: 1, playwright: 0, total: 1 };
	// Uncontended (single/near-single run): full playwright parallelism for speed.
	if (total >= 12) {
		const vitest = VITEST_CAP;
		const playwright = PLAYWRIGHT_CAP;
		return { vitest, playwright, total: vitest + playwright };
	}
	// Contended (bundle 4..11, i.e. 2+ concurrent runs): exactly 1 playwright worker
	// AND deliberately UNDER-allocate vitest (~half the bundle) to leave idle cores.
	// Measured: v2-integration tests boot a real gateway each; at full utilization
	// (Σ=cores) the transient gateway-boot CPU bursts across many concurrent
	// integration test files starve each other past the 60 s test timeout. Leaving
	// headroom (e.g. 3-way → 4v+1p, Σ=15/24) absorbs those bursts. Fork count is the
	// dominant driver of integration starvation (6 forks/run failed fewer than 7).
	const playwright = 1;
	const vitest = clamp(Math.ceil(total / 2), 1, Math.min(VITEST_CAP, total - playwright));
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
			const { grant, remaining, target } = computeGrant(state, parentRunId, cores);

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

			const records = allocateKinds(kinds, usableGrant);
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

function allocateKinds(kinds, grant) {
	if (kinds.length === 2) {
		const { vitest, playwright } = splitBundle(grant);
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
	const s4 = splitBundle(4);
	const s8 = splitBundle(8);
	const s12 = splitBundle(12);
	// Under contention (bundle 4/8 = 5-way/3-way) exactly ONE playwright worker so
	// concurrent browsers stay minimal; a single run (bundle 12) keeps 8v+4p.
	assert(s4.vitest === 2 && s4.playwright === 1, `split(4)=2v+1p got ${s4.vitest}+${s4.playwright}`);
	assert(s8.vitest === 4 && s8.playwright === 1, `split(8)=4v+1p got ${s8.vitest}+${s8.playwright}`);
	assert(s12.vitest === 8 && s12.playwright === 4, `split(12)=8v+4p got ${s12.vitest}+${s12.playwright}`);
	for (let g = 2; g <= MAX_BUNDLE; g++) {
		const s = splitBundle(g);
		// Never overshoot the grant; under-allocation (idle core) is allowed + safe.
		assert(s.total <= g, `splitBundle(${g}) must not exceed grant, got ${s.vitest}+${s.playwright}=${s.total}`);
		assert(s.vitest <= VITEST_CAP && s.playwright <= PLAYWRIGHT_CAP, `splitBundle(${g}) within caps, got v=${s.vitest} pw=${s.playwright}`);
		assert(s.vitest >= 1 && s.playwright >= 1, `splitBundle(${g}) both kinds ≥1, got v=${s.vitest} pw=${s.playwright}`);
	}
	console.log("  splitBundle(4)=2v+1p ✓  splitBundle(8)=4v+1p ✓  splitBundle(12)=8v+4p ✓  no-overshoot 2..12 ✓");

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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const arg = process.argv[2] || "--status";
	if (arg === "--selftest") cliSelftest();
	else if (arg === "--status") cliStatus();
	else if (arg === "--stress") cliStress().catch((e) => {
		console.error("ledger stress: fatal:", e);
		process.exit(1);
	});
	else if (arg === "--reserve-hold") {
		const kind = process.argv[3] || "parent";
		const holdMs = Number(process.argv[4]) || 6000;
		const coalesceMs = Number(process.env.BOBBIT_V2_STRESS_COALESCE_MS) || 1500;
		cliReserveHold(kind, holdMs, coalesceMs);
	} else {
		console.log("usage: node scripts/testing-v2/ledger.mjs [--status | --selftest | --stress [N] [staggerMs] [holdMs]]");
		process.exit(2);
	}
}
