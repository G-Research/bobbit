import { patchSession } from "./api.js";
import { activeSessionId, renderApp } from "./state.js";
import { renderSidebarBobbitCanvas, ACCESSORY_DEFS, NO_ACCESSORY, type AccessoryDef } from "../ui/bobbit-render.js";

// ============================================================================
// ACCESSORY REGISTRY (derived from canonical sprite data)
// ============================================================================

/** Definition for a pixel-art accessory overlay rendered on the Bobbit sprite. */
export type AccessoryDefinition = AccessoryDef;

/**
 * All available pixel-art accessories for Bobbit sprites.
 * Derived from canonical pixel data in bobbit-sprite-data.ts via pixelsToBoxShadow().
 * Each shadow string is counter-hue-rotated at render time to keep fixed colours
 * across session identity hues.
 */
export const ACCESSORIES: Record<string, AccessoryDefinition> = {
	none: NO_ACCESSORY,
	...ACCESSORY_DEFS,
};

/** List of all accessory IDs (for iteration/UI selectors) */
export const ACCESSORY_IDS = Object.keys(ACCESSORIES) as string[];

/** Resolve an accessory ID, falling back to "none" */
export function getAccessory(id: string | undefined): AccessoryDefinition {
	return (id && ACCESSORIES[id]) || ACCESSORIES.none;
}

// ============================================================================
// AURORA BOREALIS PALETTE
// ============================================================================

/**
 * 14 curated hue-rotate offsets from canonical green (90°).
 * Selected for beautiful bobbit colours with non-muddy flask tones.
 */
export const BOBBIT_HUE_ROTATIONS = [
	-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125,
];

/** Map of session ID → assigned palette index, loaded from server */
export const sessionColorMap = new Map<string, number>();

function nextAvailableColorIndex(): number {
	const used = new Set(sessionColorMap.values());
	for (let i = 0; i < BOBBIT_HUE_ROTATIONS.length; i++) {
		if (!used.has(i)) return i;
	}
	return sessionColorMap.size % BOBBIT_HUE_ROTATIONS.length;
}

/**
 * Get the hue-rotate offset for a session. Assigns colors from the Aurora
 * Borealis palette, persisted on the server for cross-device coherency.
 */
export function sessionHueRotation(sessionId: string): number {
	let idx = sessionColorMap.get(sessionId);
	if (idx === undefined) {
		idx = nextAvailableColorIndex();
		sessionColorMap.set(sessionId, idx);
		patchSession(sessionId, { colorIndex: idx });
	}
	return BOBBIT_HUE_ROTATIONS[idx];
}

/** Change a session's color to a specific palette index */
export function setSessionColor(sessionId: string, paletteIndex: number): void {
	sessionColorMap.set(sessionId, paletteIndex);
	patchSession(sessionId, { colorIndex: paletteIndex });
	if (activeSessionId() === sessionId) {
		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${BOBBIT_HUE_ROTATIONS[paletteIndex]}deg`);
	}
	renderApp();
}

/**
 * Generate a 3-letter uppercase acronym from a session title.
 * Takes first letters of the first 3 significant words.
 */
export function sessionAcronym(title: string): string {
	const stopWords = new Set(["the", "a", "an", "and", "or", "in", "on", "to", "of", "for", "with", "is", "it"]);
	const words = title.split(/[\s\-_/]+/).filter((w) => w.length > 0 && !stopWords.has(w.toLowerCase()));
	if (words.length >= 3) return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
	if (words.length === 2) return (words[0][0] + words[1][0] + (words[1][1] || "")).toUpperCase();
	if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
	return title.slice(0, 3).toUpperCase();
}

/**
 * Tiny static Bobbit pixel-art icon used as a session status indicator.
 * Same 10×9 pixel grid as the streaming blob, but scaled down and colored
 * per session status. No animation, no blinking — just a little Bobbit.
 *
 * @param accessory - Accessory ID from the registry (e.g. "crown", "bandana").
 *   When provided, overrides isTeamLead/isCoder. When absent, falls back to
 *   the legacy booleans for backward compatibility.
 */
export function statusBobbit(status: string, isCompacting = false, sessionId?: string, isSelected = false, isAborting = false, isTeamLead = false, isCoder = false, accessory?: string, noDesaturate = false) {
	const hueRotate = sessionId ? sessionHueRotation(sessionId) : 0;

	// Resolve which accessory to render: explicit param > legacy booleans > none
	const resolvedAccessoryId = accessory
		?? (isTeamLead ? "crown" : isCoder ? "bandana" : "none");
	const acc = getAccessory(resolvedAccessoryId);

	return renderSidebarBobbitCanvas({
		status,
		isCompacting,
		hueRotate,
		isSelected,
		isAborting,
		accessory: acc,
		noDesaturate,
	});
}
