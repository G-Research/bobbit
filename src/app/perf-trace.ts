// ============================================================================
// PERF TRACE — tiny client-side span/mark primitive
//
// Purpose: measure perceived loading time of sidebar navigation (and any
// other UI interaction) without adding a generic tracing framework.
//
// Cost-when-disabled invariant: every public function early-returns without
// allocating when `isEnabled()` is false. `startSpan` returns a shared no-op
// singleton — calling it 1M times must not allocate per-call closures.
// Pinned by `tests/perf-trace.spec.ts`.
//
// See `docs/design/profile-sidebar-nav-perf.md` (or the design-doc gate of
// the goal that introduced this file) for the broader Phase 1 plan.
// ============================================================================

export interface PerfEntry {
	name: string;
	t0: number;
	dur: number;
	detail?: Record<string, unknown>;
}

export interface SpanHandle {
	end(extra?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

const RING_DEFAULT = 512;
let ringSize = RING_DEFAULT;
let buf: Array<PerfEntry | undefined> = new Array(RING_DEFAULT);
let head = 0; // index of oldest entry
let count = 0; // number of entries currently in buffer

function pushEntry(name: string, t0: number, dur: number, detail?: Record<string, unknown>): void {
	const entry: PerfEntry = detail ? { name, t0, dur, detail } : { name, t0, dur };
	if (count < ringSize) {
		buf[(head + count) % ringSize] = entry;
		count++;
	} else {
		buf[head] = entry;
		head = (head + 1) % ringSize;
	}
	if (logEnabledCached) {
		try {
			// eslint-disable-next-line no-console
			console.debug("[perf]", name, dur.toFixed(1) + "ms", detail ?? "");
		} catch { /* swallow */ }
	}
}

// ---------------------------------------------------------------------------
// Enable/disable
// ---------------------------------------------------------------------------

let enabled: boolean | null = null;
let logEnabledCached = false;

function detectEnabled(): boolean {
	// Vite dev mode → on by default.
	try {
		// `import.meta.env.DEV` is replaced at build time by Vite. In Node/test
		// environments it's undefined → falls through.
		// @ts-ignore — import.meta typed loosely for cross-env compat
		if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) return true;
	} catch { /* not in vite */ }
	// Explicit localStorage opt-in.
	try {
		if (typeof localStorage !== "undefined" && localStorage.getItem("bobbitPerf") === "1") return true;
	} catch { /* no localStorage */ }
	// Query-string opt-in (`?perf=1`).
	try {
		if (typeof location !== "undefined" && /[?&]perf=1(?:&|$)/.test(location.search || "")) return true;
	} catch { /* no location */ }
	return false;
}

function detectLogEnabled(): boolean {
	try {
		return typeof localStorage !== "undefined" && localStorage.getItem("BOBBIT_PERF_LOG") === "1";
	} catch {
		return false;
	}
}

export function isEnabled(): boolean {
	if (enabled === null) {
		enabled = detectEnabled();
		logEnabledCached = enabled && detectLogEnabled();
		if (enabled) exposeWindow();
	}
	return enabled;
}

export function setEnabled(v: boolean): void {
	enabled = v;
	logEnabledCached = v && detectLogEnabled();
	if (v) exposeWindow();
}

// ---------------------------------------------------------------------------
// Shared no-op singleton (must be the same object across calls when disabled)
// ---------------------------------------------------------------------------

const NOOP_END = (): void => { /* no-op */ };
const NOOP_HANDLE: SpanHandle = { end: NOOP_END };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mark(name: string): void {
	if (!isEnabled()) return;
	try { performance.mark(`bobbit:${name}`); } catch { /* swallow */ }
}

export function startSpan(name: string, detail?: Record<string, unknown>): SpanHandle {
	if (!isEnabled()) return NOOP_HANDLE;
	const t0 = performance.now();
	const startMark = `bobbit:${name}:start:${t0}`;
	try { performance.mark(startMark); } catch { /* swallow */ }
	return {
		end(extra?: Record<string, unknown>): void {
			const dur = performance.now() - t0;
			const endMark = `bobbit:${name}:end:${t0}`;
			try {
				performance.mark(endMark);
				performance.measure(`bobbit:${name}`, startMark, endMark);
			} catch { /* swallow */ }
			const merged = extra
				? (detail ? { ...detail, ...extra } : extra)
				: detail;
			pushEntry(name, t0, dur, merged);
		},
	};
}

export function measure<T>(name: string, fn: () => T, detail?: Record<string, unknown>): T {
	if (!isEnabled()) return fn();
	const h = startSpan(name, detail);
	try {
		return fn();
	} finally {
		h.end();
	}
}

export async function measureAsync<T>(name: string, fn: () => Promise<T>, detail?: Record<string, unknown>): Promise<T> {
	if (!isEnabled()) return fn();
	const h = startSpan(name, detail);
	try {
		return await fn();
	} finally {
		h.end();
	}
}

export function record(name: string, ms: number, detail?: Record<string, unknown>): void {
	if (!isEnabled()) return;
	const t0 = (typeof performance !== "undefined" ? performance.now() : 0) - ms;
	pushEntry(name, t0, ms, detail);
}

export function entries(): PerfEntry[] {
	if (count === 0) return [];
	const out: PerfEntry[] = new Array(count);
	for (let i = 0; i < count; i++) {
		out[i] = buf[(head + i) % ringSize] as PerfEntry;
	}
	return out;
}

export function clear(): void {
	buf = new Array(ringSize);
	head = 0;
	count = 0;
}

export function setRingSize(n: number): void {
	const sz = Math.max(1, n | 0);
	ringSize = sz;
	buf = new Array(sz);
	head = 0;
	count = 0;
}

// ---------------------------------------------------------------------------
// window.__bobbitPerf surface
// ---------------------------------------------------------------------------

function exposeWindow(): void {
	if (typeof window === "undefined") return;
	(window as any).__bobbitPerf = {
		entries,
		clear,
		mark,
		startSpan,
		measure,
		setEnabled,
		setRingSize,
		isEnabled,
	};
}

// Trigger detection eagerly so `window.__bobbitPerf` is present before any
// other module starts running (cold-load harness reads it via the page).
isEnabled();
