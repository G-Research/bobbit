// ============================================================================
// PERF FLAGS — feature-flag helper for Phase 2 perf experiments
//
// Each Phase 2 hypothesis lives behind a flag here. The flag is comma-separated
// in `localStorage.bobbitPerfFlags`. The harness toggles flags on/off to
// measure before/after.
//
// IMPORTANT: flags are a measurement tool, not a permanent kill switch. When a
// Phase 2 win ships in Phase 3, its flag MUST be removed and the optimisation
// made unconditional. Long-lived flags create configuration sprawl.
//
// See `docs/perf/sidebar-nav-baseline.md` for the live experiment log.
// ============================================================================

/**
 * Canonical list of perf flag names. Phase 2 coders extend this enum-style
 * type by adding their flag here, e.g. `"prefetchOnHover"`, `"reducer-lru"`.
 * Keeping the list centralised lets the harness enumerate flags without
 * duplication.
 */
export type PerfFlag = string;

/**
 * Registry of known Phase 2 perf flags. Used by the harness to enumerate
 * flags without duplication and by docs / debug surfaces to surface a
 * human-readable description. Adding a flag here does NOT enable it —
 * flags are still gated by `localStorage.bobbitPerfFlags`.
 */
export const KNOWN_PERF_FLAGS: { name: string; description: string }[] = [
	{
		name: "deferSyntaxHighlight",
		description:
			"Phase 2 Opt-G (experiment) — defer syntax-highlighting of " +
			"`<code-block>` elements in the transcript path. With the flag on, " +
			"each `<code-block>` callsite emits a `<deferred-code-block>` that " +
			"renders plain `<pre><code>{source}</code></pre>` synchronously and " +
			"upgrades to a real `<code-block>` (running `hljs.highlight()`) on " +
			"`requestIdleCallback` with a 200ms timeout fallback. The eager-tail " +
			"messages from Opt-A render their visible code blocks immediately as " +
			"plain monospace text, freeing the click → first-paint critical path " +
			"of hljs work. Default OFF until A/B replicates ship.",
	},
	{
		name: "deferOffscreenRender",
		description:
			"Phase 2 Opt-A (SHIPPED, default-ON) — defer markdown / tool-call " +
			"rendering of off-screen transcript messages. The bottom tail renders " +
			"eagerly; older messages render a cheap height-preserving placeholder " +
			"until an `IntersectionObserver` (rootMargin: 500px) sees them " +
			"approach the viewport, at which point they swap in via " +
			"`requestIdleCallback`. A/B (n=5) on the realistic-large fixture cut " +
			"paint.first p95 -37ms (-33%), nav.session.ready p95 -95ms (-29%), " +
			"rapidnav.keystroke p95 -102ms (-32%), rapidnav.gap p50 -67ms. Set " +
			"`bobbitPerfFlags=-deferOffscreenRender` to disable.",
	},
];

/** Convenience canonical flag name for Phase 2 Opt-A. SHIPPED default-ON. */
export const PERF_FLAG_DEFER_OFFSCREEN_RENDER = "deferOffscreenRender";

/** Convenience canonical flag name for Phase 2 Opt-G (experiment). */
export const PERF_FLAG_DEFER_SYNTAX_HIGHLIGHT = "deferSyntaxHighlight";

/** Flags that default to ON. Listed here so the runtime check (
 *  `isPerfFlagEnabled`) treats absence-of-explicit-localStorage-entry as
 *  ON, and an explicit negative `-<flag>` entry as the opt-out. */
export const DEFAULT_ON_FLAGS: ReadonlySet<string> = new Set([
	"deferOffscreenRender",
]);

const LS_KEY = "bobbitPerfFlags";

let cached: Set<string> | null = null;

function load(): Set<string> {
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
		if (!raw) return new Set();
		return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
	} catch {
		return new Set();
	}
}

export function isPerfFlagEnabled(flag: PerfFlag): boolean {
	if (cached === null) cached = load();
	if (cached.has(`-${flag}`)) return false; // explicit opt-out
	if (cached.has(flag)) return true;
	return DEFAULT_ON_FLAGS.has(flag);
}

export function setPerfFlag(flag: PerfFlag, enabled: boolean): void {
	if (cached === null) cached = load();
	if (enabled) cached.add(flag);
	else cached.delete(flag);
	try {
		localStorage.setItem(LS_KEY, Array.from(cached).join(","));
	} catch { /* swallow */ }
}

export function listPerfFlags(): string[] {
	if (cached === null) cached = load();
	return Array.from(cached);
}

/** Re-read the flag set from localStorage. Useful for tests / the harness. */
export function reloadPerfFlags(): void {
	cached = load();
}
