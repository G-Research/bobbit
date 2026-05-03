// Bobbit PWA-resume v2 — bootstrap & resume instrumentation.
//
// Single source of truth for performance marks tied to PWA resume
// diagnostics. Behaviour-neutral: every export is a thin wrapper around
// the User Timing API (`performance.mark` / `performance.measure`) with
// no side effects beyond the platform-native timeline entry, so leaving
// these calls in production code costs essentially nothing.
//
// Reporting is opt-in via either `?perf=1` in the URL or
// `localStorage.setItem('bobbit-perf','1')`. When enabled, a digest is
// logged to the console at well-defined moments (first paint after
// init, every `pageshow` / `visibilitychange→visible`) and the raw data
// is exposed at `window.__bobbitPerf` for ad-hoc inspection / Safari
// Web Inspector remote debugging.
//
// The contract for every mark name is documented in
// `docs/design/pwa-resume-v2-diagnostics.md` — keep that file in sync
// when adding or renaming marks.

const PREFIX = "bobbit:";

export const enabled: boolean = (() => {
	try {
		const params = new URLSearchParams(globalThis.location?.search ?? "");
		if (params.get("perf") === "1") return true;
		return globalThis.localStorage?.getItem("bobbit-perf") === "1";
	} catch {
		return false;
	}
})();

/** Stamp a User Timing mark. Safe in any environment (SSR, tests). */
export function mark(name: string): void {
	try {
		performance.mark(PREFIX + name);
	} catch { /* mark API unavailable */ }
}

/** Measure between two named marks. Returns ms or null if either mark is missing. */
export function measure(name: string, start: string, end: string): number | null {
	try {
		const m = performance.measure(PREFIX + name, PREFIX + start, PREFIX + end);
		return m.duration;
	} catch {
		return null;
	}
}

interface ResumeRecord {
	at: number;
	kind: "pageshow" | "visible";
	persisted?: boolean;
	/** Time since the last paint mark, in ms. Null when no prior paint. */
	sinceLastPaintMs: number | null;
}

const resumeRecords: ResumeRecord[] = [];

/** Public read-only view for console / Web Inspector use. */
function snapshot() {
	const all = (typeof performance !== "undefined" && performance.getEntriesByType)
		? performance.getEntriesByType("mark").filter(e => e.name.startsWith(PREFIX))
		: [];
	return {
		enabled,
		marks: all.map(e => ({ name: e.name.slice(PREFIX.length), t: Math.round(e.startTime) })),
		resumes: resumeRecords.slice(),
	};
}

/** Format the mark timeline as a console table-friendly object list. */
function formatTimeline(): Array<{ name: string; t_ms: number; delta_ms: number }> {
	const snap = snapshot();
	const out: Array<{ name: string; t_ms: number; delta_ms: number }> = [];
	let prev = 0;
	for (const m of snap.marks.sort((a, b) => a.t - b.t)) {
		out.push({ name: m.name, t_ms: m.t, delta_ms: Math.round(m.t - prev) });
		prev = m.t;
	}
	return out;
}

function dump(label: string): void {
	if (!enabled) return;
	try {
		// eslint-disable-next-line no-console
		console.groupCollapsed(`[bobbit-perf] ${label}`);
		// eslint-disable-next-line no-console
		console.table(formatTimeline());
		if (resumeRecords.length > 0) {
			// eslint-disable-next-line no-console
			console.table(resumeRecords);
		}
		// eslint-disable-next-line no-console
		console.groupEnd();
	} catch { /* console unavailable */ }
}

let lastPaintMark = 0;

/** Mark a meaningful paint moment. Drives the `sinceLastPaintMs` field
 * for subsequent resume records — call right after the UI is visibly
 * usable on each navigation/render cycle. */
export function markPaint(name: string): void {
	mark(name);
	lastPaintMark = performance.now();
}

function recordResume(kind: ResumeRecord["kind"], persisted?: boolean): void {
	const now = performance.now();
	resumeRecords.push({
		at: Math.round(now),
		kind,
		persisted,
		sinceLastPaintMs: lastPaintMark > 0 ? Math.round(now - lastPaintMark) : null,
	});
	if (kind === "pageshow") {
		mark(persisted ? "pageshow:persisted" : "pageshow:fresh");
	} else {
		mark("visible");
	}
	dump(`${kind}${persisted ? ":persisted" : ""}`);
}

let installed = false;
/** Wire up pageshow / visibilitychange capture. Call once during boot. */
export function installResumeHooks(): void {
	if (installed) return;
	installed = true;
	try {
		window.addEventListener("pageshow", (e) => {
			recordResume("pageshow", (e as PageTransitionEvent).persisted);
		});
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") recordResume("visible");
		});
	} catch { /* non-browser env */ }
}

// Expose for Web Inspector / console use. Keys are intentionally short.
try {
	(globalThis as any).__bobbitPerf = {
		mark,
		measure,
		markPaint,
		snapshot,
		timeline: formatTimeline,
		dump: () => dump("manual"),
	};
} catch { /* read-only globalThis */ }
