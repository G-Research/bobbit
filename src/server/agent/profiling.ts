/**
 * Lightweight, env-gated timing profiler for E2E flake diagnosis.
 *
 * Activated by `BOBBIT_E2E_PROFILE=1`. When inactive every wrapper is a
 * direct passthrough — zero overhead in production / normal CI runs.
 *
 * Two surfaces:
 *
 *   profile(label, fn)         — sync timing
 *   profileAsync(label, fn)    — async timing (returns the awaited value)
 *
 * Optional `count` increment lets a caller record an inner work-unit count
 * (e.g. number of `existsSync` invocations inside `getAllConfigDirectories`)
 * separately from the outer call count. Use `bumpCount(label, n)`.
 *
 * Aggregated results are flushed periodically (every 5s by default) and on
 * process exit. Each row prints:
 *
 *   [profile] <label> calls=N p50=Xms p95=Yms p99=Zms max=Wms total=Tms [extra=K]
 *
 * Output goes to stderr so it doesn't interfere with structured stdout.
 *
 * NOTE: This module is intentionally process-local. Each Playwright worker
 * runs in its own Node process, so each worker prints its own table — that
 * is exactly what we want when measuring cross-worker contention.
 */

const PROFILE = process.env.BOBBIT_E2E_PROFILE === "1";
const FLUSH_INTERVAL_MS = Number(process.env.BOBBIT_E2E_PROFILE_FLUSH_MS) || 5000;

interface Bucket {
	samples: number[];
	extraCount: number;
}

const buckets: Map<string, Bucket> = new Map();

function getBucket(label: string): Bucket {
	let b = buckets.get(label);
	if (!b) {
		b = { samples: [], extraCount: 0 };
		buckets.set(label, b);
	}
	return b;
}

function record(label: string, ms: number): void {
	getBucket(label).samples.push(ms);
}

/** Public recorder for callers that already measured elapsed time. */
export function recordElapsed(label: string, ms: number): void {
	if (!PROFILE) return;
	record(label, ms);
}

export function bumpCount(label: string, n = 1): void {
	if (!PROFILE) return;
	getBucket(label).extraCount += n;
}

export function profile<T>(label: string, fn: () => T): T {
	if (!PROFILE) return fn();
	const t0 = performance.now();
	try {
		return fn();
	} finally {
		record(label, performance.now() - t0);
	}
}

export async function profileAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
	if (!PROFILE) return fn();
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		record(label, performance.now() - t0);
	}
}

function pct(sortedMs: number[], q: number): number {
	if (sortedMs.length === 0) return 0;
	const idx = Math.min(sortedMs.length - 1, Math.floor((sortedMs.length - 1) * q));
	return sortedMs[idx];
}

export interface ProfileRow {
	label: string;
	calls: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	total: number;
	extra: number;
}

export function snapshot(): ProfileRow[] {
	const rows: ProfileRow[] = [];
	for (const [label, b] of buckets) {
		if (b.samples.length === 0 && b.extraCount === 0) continue;
		const sorted = [...b.samples].sort((a, b) => a - b);
		const total = sorted.reduce((s, v) => s + v, 0);
		rows.push({
			label,
			calls: sorted.length,
			p50: pct(sorted, 0.5),
			p95: pct(sorted, 0.95),
			p99: pct(sorted, 0.99),
			max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
			total,
			extra: b.extraCount,
		});
	}
	rows.sort((a, b) => b.total - a.total);
	return rows;
}

function fmt(ms: number): string {
	return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

let _printedHeader = false;
export function flush(reason = "tick"): void {
	const rows = snapshot();
	if (rows.length === 0) return;
	if (!_printedHeader) {
		process.stderr.write(`\n[profile] flush(${reason}) pid=${process.pid}\n`);
		_printedHeader = true;
	} else {
		process.stderr.write(`\n[profile] flush(${reason}) pid=${process.pid}\n`);
	}
	for (const r of rows) {
		const extraStr = r.extra > 0 ? ` extra=${r.extra}` : "";
		process.stderr.write(
			`[profile] ${r.label.padEnd(40)} calls=${String(r.calls).padStart(5)} ` +
			`p50=${fmt(r.p50).padStart(7)}ms p95=${fmt(r.p95).padStart(7)}ms ` +
			`p99=${fmt(r.p99).padStart(7)}ms max=${fmt(r.max).padStart(7)}ms ` +
			`total=${fmt(r.total).padStart(8)}ms${extraStr}\n`,
		);
	}
}

export function reset(): void {
	buckets.clear();
}

if (PROFILE) {
	const timer = setInterval(() => flush("tick"), FLUSH_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();
	const onExit = () => { try { flush("exit"); } catch { /* best-effort */ } };
	process.on("beforeExit", onExit);
	process.on("exit", onExit);
}

export const PROFILE_ENABLED = PROFILE;
