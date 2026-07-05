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
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const LEDGER_DIRNAME = "bobbit-test-v2-ledger";
const LOCK_STALE_MS = 30_000;
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
			return { totalCores: parsed.totalCores || cores, generation: parsed.generation || 0, reservations: parsed.reservations };
		}
	} catch {
		/* missing/corrupt — start fresh */
	}
	return { totalCores: cores, generation: 0, reservations: [] };
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

function computeGrant(reservations, myParentRunId, cores) {
	const others = reservations.filter((r) => r.parentRunId !== myParentRunId);
	const parents = new Set(others.map((r) => r.parentRunId));
	parents.add(myParentRunId);
	const activeParents = parents.size;
	const used = others.reduce((s, r) => s + (r.workerSlots || 0), 0);
	const remaining = cores - used;
	const target = clamp(Math.floor(cores / activeParents), MIN_BUNDLE, MAX_BUNDLE);
	const grant = Math.min(target, remaining);
	return { grant, remaining, target, activeParents, used };
}

/** Split a committed parent bundle: 4→2+2, 12→8+4; cap vitest 8 / playwright 4. */
export function splitBundle(grant) {
	let playwright = clamp(Math.floor(grant / 3), 2, PLAYWRIGHT_CAP);
	let vitest = grant - playwright;
	if (vitest > VITEST_CAP) vitest = VITEST_CAP;
	if (vitest < 2) {
		vitest = Math.min(2, grant);
		playwright = Math.max(1, grant - vitest);
	}
	playwright = Math.min(playwright, PLAYWRIGHT_CAP);
	return { vitest, playwright, total: vitest + playwright };
}

// ─────────────────────────── reservation core ───────────────────────────

/**
 * Reserve a bundle of `kinds` under the atomic lock, retrying with jitter until
 * at least MIN_BUNDLE slots are available or the grant timeout elapses. Returns
 * the created reservation records + total granted.
 */
function reserveBundle(kinds, opts = {}) {
	const cores = totalCores(opts);
	const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
	const grantDeadline = Date.now() + (opts.grantTimeoutMs ?? DEFAULT_GRANT_TIMEOUT_MS);
	const parentRunId = opts.parentRunId || newId("parent");

	// Coalescing window: let simultaneously-starting suites register before we
	// compute the shared budget, so no early runner over-allocates.
	sleepSync(coalesceMs);

	for (;;) {
		const outcome = withLock(() => {
			const state = readRaw(cores);
			state.totalCores = cores;
			sweep(state);
			const { grant, remaining } = computeGrant(state.reservations, parentRunId, cores);

			let usableGrant = grant;
			if (usableGrant < MIN_BUNDLE) {
				// Cannot receive the minimum. If time is up, take a floor grant from
				// whatever remains (never deadlock a suite); otherwise wait/retry.
				if (Date.now() > grantDeadline) {
					usableGrant = Math.max(2, Math.min(remaining, MIN_BUNDLE));
					if (usableGrant < 1) usableGrant = 1;
				} else {
					return { retry: true };
				}
			}

			const records = allocateKinds(kinds, usableGrant);
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
		const dropped = sweep(state);
		if (dropped.length) writeState(state);
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

	// 5) splitBundle spot-checks.
	const s4 = splitBundle(4);
	const s12 = splitBundle(12);
	assert(s4.vitest === 2 && s4.playwright === 2, `split(4)=2+2 got ${s4.vitest}+${s4.playwright}`);
	assert(s12.vitest === 8 && s12.playwright === 4, `split(12)=8+4 got ${s12.vitest}+${s12.playwright}`);
	console.log("  splitBundle(4)=2+2 ✓  splitBundle(12)=8+4 ✓");

	try {
		rmSync(reservationsPath(), { force: true });
	} catch {
		/* ignore */
	}
	console.log("ledger selftest: PASS");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const arg = process.argv[2] || "--status";
	if (arg === "--selftest") cliSelftest();
	else if (arg === "--status") cliStatus();
	else {
		console.log("usage: node scripts/testing-v2/ledger.mjs [--status | --selftest]");
		process.exit(2);
	}
}
