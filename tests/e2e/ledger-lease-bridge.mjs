/**
 * ledger-lease-bridge.mjs — Playwright-safe lease-pool client for Test Suite v2.
 *
 * WHY THIS EXISTS (not a re-export of scripts/testing-v2/ledger.mjs):
 * Playwright's test-file transform mishandles a .mjs located OUTSIDE its test
 * root (scripts/…): it rewrites the module toward CJS, so ANY import of
 * ledger.mjs from a Playwright-transformed file throws "exports is not defined in
 * ES module scope" (static, dynamic, file:// URL, namespace, re-export — all
 * fail). A .mjs co-located INSIDE tests/e2e is transformed as native ESM and
 * works. So this module lives here and re-implements ONLY the lease-pool client
 * against the EXACT SAME on-disk protocol as ledger.mjs, so the two interoperate
 * cross-process: the vitest tier + the ledger CLI use ledger.mjs; the Playwright
 * browser tier uses this bridge; both acquire/release from the SAME leases.json
 * under the SAME ledger.lock, so the global caps hold across ALL runs and tiers.
 *
 * INVARIANT: this file MUST stay protocol-compatible with the lease-pool section
 * of scripts/testing-v2/ledger.mjs (ledger dir, lock file + steal rule, leases
 * file name + entry shape {id,pool,pid,at,forced}, per-pool max-hold, cap
 * resolution). tests2/ledger-lease-bridge-interop.test.ts pins that agreement.
 */
import { openSync, closeSync, writeSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, cpus } from "node:os";
import { fileURLToPath } from "node:url";

// ─── protocol constants (MUST match scripts/testing-v2/ledger.mjs) ───
const LEDGER_DIRNAME = "bobbit-test-v2-ledger";
const LEASES_FILENAME = "leases.json";
const LOCK_STALE_MS = 30_000;
const DEFAULT_LEASE_TIMEOUT_MS = 120_000;
const LEASE_MAX_HOLD_MS = 180_000; // gateway-boot backstop
const BROWSER_LEASE_MAX_HOLD_MS = 1_800_000; // browser: held for a worker's whole life
const DEFAULT_BROWSER_LEASE_TIMEOUT_MS = 1_200_000;
const LEASE_POLL_MS = 150;

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET_CAPS_PATH = join(HERE, "..", "..", "tests2", "budget-caps.json");

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function ledgerDir() {
	return join(tmpdir(), LEDGER_DIRNAME);
}
function leasesPath() {
	return join(ledgerDir(), LEASES_FILENAME);
}
function lockPath() {
	return join(ledgerDir(), "ledger.lock");
}

function totalCores(opts = {}) {
	const fromOpt = Number(opts.totalCores);
	if (Number.isFinite(fromOpt) && fromOpt > 0) return Math.floor(fromOpt);
	const fromEnv = Number(process.env.BOBBIT_V2_TOTAL_CORES);
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
	return Math.max(1, cpus().length);
}

function jitter(baseMs) {
	return Math.floor(baseMs * (0.5 + Math.random()));
}
const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

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

function leaseMaxHoldMs(pool) {
	return pool === "browser" ? BROWSER_LEASE_MAX_HOLD_MS : LEASE_MAX_HOLD_MS;
}

function budgetCapFromFile(pool) {
	try {
		const parsed = JSON.parse(readFileSync(BUDGET_CAPS_PATH, "utf8"));
		const v = Number(parsed?.[pool]);
		return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
	} catch {
		return null;
	}
}

export function leaseCap(pool, opts = {}) {
	const fromOpt = Number(opts.cap);
	if (Number.isFinite(fromOpt) && fromOpt > 0) return Math.floor(fromOpt);
	const envKey = pool === "gateway-boot" ? "BOBBIT_V2_MAX_GATEWAY_BOOTS" : `BOBBIT_V2_MAX_${pool.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
	const env = Number(process.env[envKey]);
	if (Number.isFinite(env) && env > 0) return Math.floor(env);
	const fromFile = budgetCapFromFile(pool);
	if (fromFile != null) return fromFile;
	if (pool === "gateway-boot" || pool === "browser") return clamp(Math.floor(totalCores(opts) / 6), 2, 8);
	return clamp(Math.floor(totalCores(opts) / 4), 2, 12);
}

// ─── lock (atomic wx mutex; steal only if owner PID dead AND stale) ───
function sleepSync(ms) {
	if (ms <= 0) return;
	const sab = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
function tryStealStaleLock() {
	try {
		const st = statSync(lockPath());
		let ownerPid = 0;
		try {
			ownerPid = JSON.parse(readFileSync(lockPath(), "utf8")).pid || 0;
		} catch {
			ownerPid = 0;
		}
		if (!pidAlive(ownerPid) && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
			unlinkSync(lockPath());
			return true;
		}
	} catch {
		/* lock vanished — fine */
	}
	return false;
}
function acquireLock(timeoutMs) {
	mkdirSync(ledgerDir(), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const fd = openSync(lockPath(), "wx");
			writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			return fd;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			tryStealStaleLock();
			if (Date.now() > deadline) throw new Error(`lease-bridge: could not acquire lock within ${timeoutMs}ms`);
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
	const fd = acquireLock(opts.lockTimeoutMs ?? 30_000);
	try {
		return fn();
	} finally {
		releaseLock(fd);
	}
}

// ─── leases ───
function readLeasesRaw() {
	try {
		const parsed = JSON.parse(readFileSync(leasesPath(), "utf8"));
		if (parsed && Array.isArray(parsed.leases)) return { leases: parsed.leases, generation: parsed.generation || 0 };
	} catch {
		/* missing/corrupt — start fresh */
	}
	return { leases: [], generation: 0 };
}
function sweepLeases(state) {
	const now = Date.now();
	state.leases = state.leases.filter((l) => pidAlive(l.pid) && now - Date.parse(l.at || 0) < leaseMaxHoldMs(l.pool));
}
function writeLeases(state) {
	state.generation = (state.generation || 0) + 1;
	writeFileSync(leasesPath(), `${JSON.stringify(state, null, 2)}\n`);
}
function newId(pool) {
	return `lease-${pool}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Acquire a lease from a cross-process pool, WAITING (async) while saturated.
 * Fail-open: after opts.timeoutMs the lease is granted anyway (`forced:true`).
 */
export async function acquireLease(pool, opts = {}) {
	const id = newId(pool);
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
			writeLeases(state); // persist the sweep so a dead holder's slot frees for peers
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
		try {
			withLock(() => {
				const state = readLeasesRaw();
				state.leases = state.leases.filter((l) => l.id !== id);
				writeLeases(state);
			}, { lockTimeoutMs: opts.lockTimeoutMs ?? 5000 });
		} catch {
			/* best-effort — the sweeper reclaims on PID liveness / max-hold age */
		}
	};
	process.once("exit", release);
	return { release, id, forced, pool, cap };
}

export function acquireGatewayBootLease(opts = {}) {
	return acquireLease("gateway-boot", opts);
}
export function acquireBrowserRenderLease(opts = {}) {
	return acquireLease("browser", { timeoutMs: DEFAULT_BROWSER_LEASE_TIMEOUT_MS, ...opts });
}
