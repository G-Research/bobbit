// src/app/boot-timing.ts
//
// Opt-in boot/reload performance instrumentation. Records `performance.now()`
// (ms since navigation start / `performance.timeOrigin`) at named boot
// milestones so a full page reload's cost can be measured with hard numbers:
// the module waterfall, first paint, the WebSocket reconnect, and the
// `get_state` snapshot replay + re-render.
//
// Gated at runtime by a localStorage flag (`bobbit-perf-instrumentation`),
// flipped from Settings → "Perf instrumentation" (shown only under the dev
// harness, next to Restart Server). When armed, the terminal report is logged
// to the console AND POSTed to `/api/dev/boot-timing`, which appends it to
// `<stateDir>/boot-timing.jsonl` for agents/tooling to inspect.
//
// When disarmed every entry point is a cheap boolean check + early return, so
// shipping this in production carries negligible overhead.
//
// Inspect the latest sample from devtools at any time:
//   copy(window.__bobbitBootTimings)
//   console.table(window.__bobbitBootTimings.rows)

/** localStorage key mirroring the `devPerfInstrumentation` server preference. */
export const PERF_INSTRUMENTATION_KEY = "bobbit-perf-instrumentation";

interface Mark { name: string; t: number; }

interface BootMeta {
	sessionId?: string;
	transcriptMessages?: number;
	/** Size (chars ≈ bytes for ASCII JSON) of the raw get_state snapshot frame. */
	snapshotChars?: number;
	/** Per-phase server-side snapshot build timing (dev harness only). */
	serverTiming?: Record<string, number>;
}

const marks: Mark[] = [];
let meta: BootMeta = {};
// Captured synchronously at module load so the very first reload milestones are
// recorded when the user enabled the toggle on a prior page (the reload case).
let armed = readArmed();
// One terminal report per page load. Guards against the dual triggers
// (post-snapshot terminal + idle-debounce fallback) double-posting.
let reported = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

// Idle window after the last mark before we assume boot has settled and report
// (covers no-session views, where no snapshot milestone ever fires).
const IDLE_REPORT_MS = 3000;

function readArmed(): boolean {
	try { return localStorage.getItem(PERF_INSTRUMENTATION_KEY) === "1"; } catch { return false; }
}

/** True when boot instrumentation is currently armed (localStorage mirror). */
export function isPerfInstrumentationEnabled(): boolean {
	return readArmed();
}

/**
 * Set the localStorage mirror that arms instrumentation on the NEXT reload.
 * Called by the Settings toggle (alongside the `devPerfInstrumentation` PUT)
 * and by preference hydration so a fresh browser reflects the server value.
 */
export function setPerfInstrumentationEnabled(on: boolean): void {
	try {
		if (on) localStorage.setItem(PERF_INSTRUMENTATION_KEY, "1");
		else localStorage.removeItem(PERF_INSTRUMENTATION_KEY);
	} catch { /* private mode — ignore */ }
	armed = on;
}

/** Attach metadata to the eventual report (session id, transcript size, …). */
export function bootTimingMeta(partial: BootMeta): void {
	if (!armed) return;
	meta = { ...meta, ...partial };
}

function buildRows(): Array<Record<string, unknown>> {
	return marks.map((m, i) => ({
		phase: m.name,
		"t (ms)": Math.round(m.t * 10) / 10,
		"Δ prev (ms)": i === 0 ? Math.round(m.t * 10) / 10 : Math.round((m.t - marks[i - 1].t) * 10) / 10,
	}));
}

function buildSample(reason: string): Record<string, unknown> {
	let isReload = false;
	try { isReload = sessionStorage.getItem("bobbit-hot-reload") === "1"; } catch { /* ignore */ }
	const total = marks.length ? Math.round(marks[marks.length - 1].t * 10) / 10 : 0;
	return {
		reason,
		isReload,
		total_ms: total,
		route: typeof location !== "undefined" ? location.hash || location.pathname : undefined,
		sessionId: meta.sessionId,
		transcriptMessages: meta.transcriptMessages,
		snapshotChars: meta.snapshotChars,
		serverTiming: meta.serverTiming,
		buildId: (globalThis as { __BOBBIT_BUILD_ID__?: string }).__BOBBIT_BUILD_ID__,
		userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
		viewport: typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : undefined,
		clientTs: Date.now(),
		marks: marks.map((m) => ({ ...m })),
		rows: buildRows(),
	};
}

function publish(reason: string): Record<string, unknown> {
	const sample = buildSample(reason);
	(window as unknown as { __bobbitBootTimings?: unknown }).__bobbitBootTimings = sample;
	return sample;
}

function scheduleIdleReport(): void {
	if (reportTimer) clearTimeout(reportTimer);
	reportTimer = setTimeout(() => bootTimingReport("idle"), IDLE_REPORT_MS);
}

/** Record a named boot milestone. No-op when disarmed or already reported. */
export function bootMark(name: string): void {
	if (!armed || reported || typeof performance === "undefined") return;
	marks.push({ name, t: performance.now() });
	publish("live");
	scheduleIdleReport();
}

/**
 * Emit the terminal report exactly once: log the table and POST the sample to
 * the server sink. Idempotent and no-op when disarmed. Called both immediately
 * after the session snapshot paints (fast path) and via the idle-debounce
 * fallback (no-session views).
 */
export function bootTimingReport(reason: string): void {
	if (!armed || reported || marks.length === 0) return;
	reported = true;
	if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }

	const sample = publish(reason);
	const isReload = (sample as { isReload?: boolean }).isReload;
	const total = (sample as { total_ms?: number }).total_ms;
	console.log(`[boot-timing] ${reason} — reload=${isReload} total=${total}ms (navigation→last mark). Sample: window.__bobbitBootTimings`);
	(console as { table?: (data: unknown) => void }).table?.(buildRows());

	// Fire-and-forget POST to the harness-gated sink. Dynamic import avoids a
	// static dependency cycle (api.ts → state.ts → …) and keeps boot-timing
	// importable from very early modules.
	import("./api.js")
		.then((m) => m.postBootTiming(sample))
		.catch(() => { /* diagnostics must never break the app */ });
}
