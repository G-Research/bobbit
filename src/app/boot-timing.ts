// src/app/boot-timing.ts
//
// Dev-only boot/reload timing instrumentation. Records `performance.now()`
// (ms since navigation start / `performance.timeOrigin`) at named boot
// milestones so we can see, with hard numbers, where a full page reload spends
// its time: the Vite dev module waterfall, first paint, the WebSocket
// reconnect, and the `get_state` snapshot replay + re-render.
//
// Zero cost in production: every entry point short-circuits unless
// `globalThis.__BOBBIT_DEV__` is true (stamped by vite.config.ts `define`).
// Marks are cheap (`performance.now()` + array push); the only console output
// happens in dev via `bootTimingFlush()`.
//
// Read the latest numbers from devtools at any time:
//   copy(window.__bobbitBootTimings)        // structured
//   console.table(window.__bobbitBootTimings.rows)

const DEV = (globalThis as { __BOBBIT_DEV__?: boolean }).__BOBBIT_DEV__ === true;

interface Mark { name: string; t: number; }

const marks: Mark[] = [];
// Once the initial load/reload sequence is captured we stop recording, so
// later mid-session reconnects / compaction snapshots don't append to (and
// distort) the boot table. `window.__bobbitBootTimings` keeps the first run.
let sealed = false;

function buildRows(): Array<Record<string, unknown>> {
	return marks.map((m, i) => ({
		phase: m.name,
		"t (ms)": Math.round(m.t * 10) / 10,
		"Δ prev (ms)": i === 0 ? Math.round(m.t * 10) / 10 : Math.round((m.t - marks[i - 1].t) * 10) / 10,
	}));
}

function publish(reason: string): void {
	const isReload = (() => {
		try { return sessionStorage.getItem("bobbit-hot-reload") === "1"; } catch { return false; }
	})();
	(window as unknown as { __bobbitBootTimings?: unknown }).__bobbitBootTimings = {
		reason,
		isReload,
		total_ms: marks.length ? Math.round(marks[marks.length - 1].t * 10) / 10 : 0,
		marks: marks.map((m) => ({ ...m })),
		rows: buildRows(),
	};
}

/** Record a named boot milestone. No-op outside dev or after the run is sealed. */
export function bootMark(name: string): void {
	if (!DEV || sealed || typeof performance === "undefined") return;
	marks.push({ name, t: performance.now() });
	// Keep the window snapshot live so devtools always sees the latest, even
	// before an explicit flush (the session snapshot lands after first paint).
	try { publish("live"); } catch { /* window may be unavailable in some contexts */ }
}

/**
 * Log the current timing table to the console. Safe to call multiple times
 * (e.g. once at first paint for the structural floor, once after the session
 * snapshot replay). No-op outside dev.
 */
export function bootTimingFlush(reason: string): void {
	if (!DEV || typeof performance === "undefined" || marks.length === 0) return;
	publish(reason);
	const isReload = (window as unknown as { __bobbitBootTimings?: { isReload?: boolean } }).__bobbitBootTimings?.isReload;
	const total = Math.round(marks[marks.length - 1].t * 10) / 10;
	console.log(`[boot-timing] ${reason} — reload=${isReload} total=${total}ms (navigation→last mark)`);
	(console as { table?: (data: unknown) => void }).table?.(buildRows());
}

/**
 * Seal the run: stop recording further marks. Called once the initial
 * load/reload sequence is fully captured (after the first session snapshot
 * paints) so mid-session reconnects don't distort the table. No-op outside dev.
 */
export function bootTimingSeal(): void {
	if (!DEV) return;
	sealed = true;
}
