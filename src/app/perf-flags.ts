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
 * type by adding their flag here, e.g. `"lazy-tool-content"`, `"reducer-lru"`.
 * Keeping the list centralised lets the harness enumerate flags without
 * duplication.
 */
export type PerfFlag = string;

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
	return cached.has(flag);
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
