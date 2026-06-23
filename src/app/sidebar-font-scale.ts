/**
 * Sidebar font-size scale — pure helpers.
 *
 * Lives in its own module (no DOM imports) so unit tests can exercise the
 * clamp/load/conversion logic under Node test runner without dragging in
 * `state.ts` and its DOM-dependent transitive imports.
 *
 * `state.ts` re-exports the names below for application call sites.
 */

export const SIDEBAR_FONT_SCALE_KEY = "bobbit:sidebar-font-scale";

export const SIDEBAR_FONT_SIZE_BASE_PX = 12;
export const SIDEBAR_FONT_SIZE_MIN_PX = 10;
export const SIDEBAR_FONT_SIZE_MAX_PX = 32;
export const SIDEBAR_FONT_SIZE_STEP_PX = 1;

export const SIDEBAR_FONT_SCALE_DEFAULT = 14 / SIDEBAR_FONT_SIZE_BASE_PX;
export const SIDEBAR_FONT_SCALE_MIN = SIDEBAR_FONT_SIZE_MIN_PX / SIDEBAR_FONT_SIZE_BASE_PX;
export const SIDEBAR_FONT_SCALE_MAX = SIDEBAR_FONT_SIZE_MAX_PX / SIDEBAR_FONT_SIZE_BASE_PX;

function roundToSidebarFontSizeStep(px: number): number {
	return Math.round(px / SIDEBAR_FONT_SIZE_STEP_PX) * SIDEBAR_FONT_SIZE_STEP_PX;
}

export function clampSidebarFontSizePx(px: number): number {
	if (typeof px !== "number" || !Number.isFinite(px)) {
		return roundToSidebarFontSizeStep(sidebarFontScaleToPx(SIDEBAR_FONT_SCALE_DEFAULT));
	}
	const rounded = roundToSidebarFontSizeStep(px);
	if (rounded < SIDEBAR_FONT_SIZE_MIN_PX) return SIDEBAR_FONT_SIZE_MIN_PX;
	if (rounded > SIDEBAR_FONT_SIZE_MAX_PX) return SIDEBAR_FONT_SIZE_MAX_PX;
	return rounded;
}

export function sidebarFontSizePxToScale(px: number): number {
	return clampSidebarFontSizePx(px) / SIDEBAR_FONT_SIZE_BASE_PX;
}

export function sidebarFontPxToScale(px: number): number {
	return sidebarFontSizePxToScale(px);
}

export function clampSidebarFontScale(scale: number): number {
	if (typeof scale !== "number" || !Number.isFinite(scale)) return SIDEBAR_FONT_SCALE_DEFAULT;
	if (scale < SIDEBAR_FONT_SCALE_MIN) return SIDEBAR_FONT_SCALE_MIN;
	if (scale > SIDEBAR_FONT_SCALE_MAX) return SIDEBAR_FONT_SCALE_MAX;
	return scale;
}

export function sidebarFontScaleToPx(scale: number): number {
	return clampSidebarFontScale(scale) * SIDEBAR_FONT_SIZE_BASE_PX;
}

export function sidebarFontScaleToFontSizePx(scale: number): number {
	return sidebarFontScaleToPx(scale);
}

export function sidebarFontScaleToDisplayPx(scale: number): number {
	return clampSidebarFontSizePx(sidebarFontScaleToPx(scale));
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
	document.documentElement.style.setProperty("--sidebar-font-scale", String(clampSidebarFontScale(scale)));
}
