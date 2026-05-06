/**
 * Sidebar font-size scale \u2014 pure helpers.
 *
 * Lives in its own module (no DOM imports) so unit tests can exercise the
 * stops/clamp/load logic under Node test runner without dragging in
 * `state.ts` and its DOM-dependent transitive imports.
 *
 * `state.ts` re-exports the names below for application call sites.
 */

export const SIDEBAR_FONT_SCALE_KEY = "bobbit:sidebar-font-scale";
export const SIDEBAR_FONT_SCALE_DEFAULT = 1.0;

export interface SidebarFontScaleStop {
	readonly id: string;
	readonly label: string;
	readonly value: number;
}

export const SIDEBAR_FONT_SCALE_STOPS: readonly SidebarFontScaleStop[] = [
	{ id: "smallest", label: "Smallest", value: 0.85 },
	{ id: "small",    label: "Small",    value: 0.92 },
	{ id: "default",  label: "Default",  value: 1.00 },
	{ id: "large",    label: "Large",    value: 1.10 },
	{ id: "largest",  label: "Largest",  value: 1.22 },
];

export function clampSidebarFontScale(n: number): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return SIDEBAR_FONT_SCALE_DEFAULT;
	const min = SIDEBAR_FONT_SCALE_STOPS[0].value;
	const max = SIDEBAR_FONT_SCALE_STOPS[SIDEBAR_FONT_SCALE_STOPS.length - 1].value;
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

export function nearestStop(scale: number): SidebarFontScaleStop {
	const clamped = clampSidebarFontScale(scale);
	let best = SIDEBAR_FONT_SCALE_STOPS[0];
	let bestDist = Math.abs(clamped - best.value);
	for (let i = 1; i < SIDEBAR_FONT_SCALE_STOPS.length; i++) {
		const s = SIDEBAR_FONT_SCALE_STOPS[i];
		const d = Math.abs(clamped - s.value);
		if (d < bestDist) { best = s; bestDist = d; }
	}
	return best;
}

export function loadSidebarFontScale(): number {
	if (typeof localStorage === "undefined") return SIDEBAR_FONT_SCALE_DEFAULT;
	const raw = localStorage.getItem(SIDEBAR_FONT_SCALE_KEY);
	if (!raw) return SIDEBAR_FONT_SCALE_DEFAULT;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return SIDEBAR_FONT_SCALE_DEFAULT;
	return clampSidebarFontScale(n);
}

export function applySidebarFontScaleVar(scale: number): void {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty("--sidebar-font-scale", String(scale));
}
