import { html } from "lit";
import { patchSession } from "./api.js";
import { activeSessionId, renderApp } from "./state.js";

// ============================================================================
// ACCESSORY REGISTRY
// ============================================================================

/** Definition for a pixel-art accessory overlay rendered on the Bobbit sprite. */
export interface AccessoryDefinition {
	/** Unique identifier (e.g. "crown", "bandana") */
	id: string;
	/** Human-readable label */
	label: string;
	/** CSS box-shadow pixel string (at 1px scale, rendered at 1.6× via transform) */
	shadow: string;
	/** Vertical offset in px for positioning on the Bobbit head */
	yOffset: number;
	/** Whether this accessory adds height above the sprite (like crown) */
	addsHeight: boolean;
}

/**
 * All available pixel-art accessories for Bobbit sprites.
 * Each is a CSS box-shadow grid counter-hue-rotated to keep fixed colours
 * across session identity hues.
 */
export const ACCESSORIES: Record<string, AccessoryDefinition> = {
	none: {
		id: "none",
		label: "None",
		shadow: "",
		yOffset: 0,
		addsHeight: false,
	},
	crown: {
		id: "crown",
		label: "Crown",
		shadow: `
			3px -1px 0 #000,5px -1px 0 #000,7px -1px 0 #000,
			2px 0 0 #000,3px 0 0 #fef08a,4px 0 0 #000,5px 0 0 #fef08a,6px 0 0 #000,7px 0 0 #fef08a,8px 0 0 #000,
			1px 1px 0 #000,2px 1px 0 #fde047,3px 1px 0 #fef08a,4px 1px 0 #fde047,5px 1px 0 #ef4444,6px 1px 0 #fde047,7px 1px 0 #fef08a,8px 1px 0 #fde047,9px 1px 0 #000,
			1px 2px 0 #000,2px 2px 0 #ca8a04,3px 2px 0 #eab308,4px 2px 0 #eab308,5px 2px 0 #eab308,6px 2px 0 #eab308,7px 2px 0 #eab308,8px 2px 0 #ca8a04,9px 2px 0 #000,
			1px 3px 0 #000,2px 3px 0 #000,3px 3px 0 #000,4px 3px 0 #000,5px 3px 0 #000,6px 3px 0 #000,7px 3px 0 #000,8px 3px 0 #000,9px 3px 0 #000
		`,
		yOffset: 2,
		addsHeight: true,
	},
	bandana: {
		id: "bandana",
		label: "Bandana",
		shadow: `
			1px 2px 0 #000,2px 2px 0 #000,3px 2px 0 #000,4px 2px 0 #000,5px 2px 0 #000,6px 2px 0 #000,7px 2px 0 #000,8px 2px 0 #000,9px 2px 0 #000,
			0 3px 0 #000,1px 3px 0 #b91c1c,2px 3px 0 #dc2626,3px 3px 0 #ef4444,4px 3px 0 #ef4444,5px 3px 0 #ef4444,6px 3px 0 #ef4444,7px 3px 0 #ef4444,8px 3px 0 #f87171,9px 3px 0 #000,
			0 4px 0 #000,1px 4px 0 #000,2px 4px 0 #000,3px 4px 0 #000,4px 4px 0 #000,5px 4px 0 #000,6px 4px 0 #000,7px 4px 0 #000,8px 4px 0 #000,9px 4px 0 #000,
			10px 3px 0 #000,10px 4px 0 #b91c1c,11px 4px 0 #000,
			10px 5px 0 #991b1b,11px 5px 0 #000,10px 6px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	magnifier: {
		id: "magnifier",
		label: "Magnifying Glass",
		shadow: `
			8px 2px 0 #000,9px 2px 0 #000,10px 2px 0 #000,
			7px 3px 0 #000,8px 3px 0 #87ceeb,9px 3px 0 #b0e0f0,10px 3px 0 #87ceeb,11px 3px 0 #000,
			7px 4px 0 #000,8px 4px 0 #b0e0f0,9px 4px 0 #e0f4ff,10px 4px 0 #87ceeb,11px 4px 0 #000,
			7px 5px 0 #000,8px 5px 0 #87ceeb,9px 5px 0 #b0e0f0,10px 5px 0 #87ceeb,11px 5px 0 #000,
			7px 6px 0 #000,8px 6px 0 #000,9px 6px 0 #000,10px 6px 0 #000,
			6px 7px 0 #000,7px 7px 0 #8b4513,
			5px 8px 0 #000,6px 8px 0 #8b4513
		`,
		yOffset: 0,
		addsHeight: false,
	},
	palette: {
		id: "palette",
		label: "Paint Palette",
		shadow: `
			9px 5px 0 #000,10px 5px 0 #000,
			8px 6px 0 #000,9px 6px 0 #a16207,10px 6px 0 #ef4444,11px 6px 0 #000,
			7px 7px 0 #000,8px 7px 0 #4ade80,9px 7px 0 #a16207,10px 7px 0 #a16207,11px 7px 0 #000,
			7px 8px 0 #000,8px 8px 0 #a16207,9px 8px 0 #a16207,10px 8px 0 #60a5fa,11px 8px 0 #000,
			8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	pencil: {
		id: "pencil",
		label: "Pencil",
		shadow: `
			10px 3px 0 #000,11px 3px 0 #000,
			9px 4px 0 #000,10px 4px 0 #f9a8d4,11px 4px 0 #ec4899,12px 4px 0 #000,
			8px 5px 0 #000,9px 5px 0 #9ca3af,10px 5px 0 #d1d5db,11px 5px 0 #000,
			7px 6px 0 #000,8px 6px 0 #fde047,9px 6px 0 #fbbf24,10px 6px 0 #000,
			6px 7px 0 #000,7px 7px 0 #fde047,8px 7px 0 #fbbf24,9px 7px 0 #000,
			5px 8px 0 #000,6px 8px 0 #f4a460,7px 8px 0 #cd853f,8px 8px 0 #000,
			4px 9px 0 #000,5px 9px 0 #4b5563,6px 9px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	shield: {
		id: "shield",
		label: "Shield",
		shadow: `
			8px 3px 0 #000,9px 3px 0 #000,10px 3px 0 #000,11px 3px 0 #000,12px 3px 0 #000,
			7px 4px 0 #000,8px 4px 0 #9ca3af,9px 4px 0 #d1d5db,10px 4px 0 #d1d5db,11px 4px 0 #9ca3af,12px 4px 0 #000,
			7px 5px 0 #000,8px 5px 0 #d1d5db,9px 5px 0 #f3f4f6,10px 5px 0 #ef4444,11px 5px 0 #d1d5db,12px 5px 0 #000,
			7px 6px 0 #000,8px 6px 0 #9ca3af,9px 6px 0 #d1d5db,10px 6px 0 #d1d5db,11px 6px 0 #9ca3af,12px 6px 0 #000,
			8px 7px 0 #000,9px 7px 0 #9ca3af,10px 7px 0 #9ca3af,11px 7px 0 #000,
			9px 8px 0 #000,10px 8px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	"set-square": {
		id: "set-square",
		label: "Set Square",
		shadow: `
			10px 4px 0 #000,
			9px 5px 0 #000,10px 5px 0 #93c5fd,11px 5px 0 #000,
			8px 6px 0 #000,9px 6px 0 #bfdbfe,10px 6px 0 #93c5fd,11px 6px 0 #000,
			7px 7px 0 #000,8px 7px 0 #bfdbfe,9px 7px 0 #000,10px 7px 0 #bfdbfe,11px 7px 0 #000,
			6px 8px 0 #000,7px 8px 0 #bfdbfe,8px 8px 0 #bfdbfe,9px 8px 0 #bfdbfe,10px 8px 0 #93c5fd,11px 8px 0 #000,
			5px 9px 0 #000,6px 9px 0 #000,7px 9px 0 #000,8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000,11px 9px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	flask: {
		id: "flask",
		label: "Flask",
		shadow: `
			8px 4px 0 #000,9px 4px 0 #fff,10px 4px 0 #000,
			8px 5px 0 #000,9px 5px 0 #7dd3fc,10px 5px 0 #000,
			7px 6px 0 #000,8px 6px 0 #0369a1,9px 6px 0 #38bdf8,10px 6px 0 #0ea5e9,11px 6px 0 #000,
			6px 7px 0 #000,7px 7px 0 #1e3a5f,8px 7px 0 #0ea5e9,9px 7px 0 #0284c7,10px 7px 0 #0369a1,11px 7px 0 #1e3a5f,12px 7px 0 #000,
			6px 8px 0 #000,7px 8px 0 #1e3a5f,8px 8px 0 #0284c7,9px 8px 0 #0c4a6e,10px 8px 0 #082f49,11px 8px 0 #1e3a5f,12px 8px 0 #000,
			6px 9px 0 #000,7px 9px 0 #000,8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000,11px 9px 0 #000,12px 9px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
	"wizard-hat": {
		id: "wizard-hat",
		label: "Wizard Hat",
		shadow: `
			7px -2px 0 #2dd4bf,8px -2px 0 #fde047,
			5px -1px 0 #000,6px -1px 0 #6366f1,7px -1px 0 #818cf8,8px -1px 0 #000,
			2px 0px 0 #000,3px 0px 0 #6d28d9,4px 0px 0 #7c3aed,5px 0px 0 #8b5cf6,6px 0px 0 #6366f1,7px 0px 0 #a78bfa,8px 0px 0 #000,
			1px 1px 0 #000,2px 1px 0 #6d28d9,3px 1px 0 #7c3aed,4px 1px 0 #fbbf24,5px 1px 0 #fde047,6px 1px 0 #14b8a6,7px 1px 0 #a78bfa,8px 1px 0 #6d28d9,9px 1px 0 #000,
			0px 2px 0 #000,1px 2px 0 #000,2px 2px 0 #000,3px 2px 0 #000,4px 2px 0 #000,5px 2px 0 #000,6px 2px 0 #000,7px 2px 0 #000,8px 2px 0 #000,9px 2px 0 #000,10px 2px 0 #000
		`,
		yOffset: 2,
		addsHeight: true,
	},
	wand: {
		id: "wand",
		label: "Wand",
		shadow: `
			11px 2px 0 #000,
			10px 3px 0 #000,12px 3px 0 #000,
			9px 4px 0 #000,13px 4px 0 #000,
			10px 5px 0 #000,12px 5px 0 #000,
			11px 6px 0 #000,
			11px 3px 0 #fef9c4,
			10px 4px 0 #fde047,11px 4px 0 #fff,12px 4px 0 #fde047,
			11px 5px 0 #fef9c4,
			9px 5px 0 #000,10px 5px 0 #cd853f,11px 5px 0 #000,
			8px 6px 0 #000,9px 6px 0 #cd853f,10px 6px 0 #000,
			7px 7px 0 #000,8px 7px 0 #8b4513,9px 7px 0 #000,
			6px 8px 0 #000,7px 8px 0 #8b4513,8px 8px 0 #000,
			5px 9px 0 #000,6px 9px 0 #000
		`,
		yOffset: 0,
		addsHeight: false,
	},
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
	const hasAccessory = acc.id !== "none" && acc.shadow !== "";
	// Crown is the only accessory that adds height above the sprite
	const addsHeight = acc.addsHeight;

	const canonical = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#1a3010" };
	let p: typeof canonical;
	if (status === "starting" || status === "preparing") {
		p = { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#2d2006" };
	} else if (status === "terminated") {
		p = { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#2c0b0e" };
	} else {
		p = canonical;
	}

	const isBusy = status === "streaming" || isCompacting;

	const eyeColor = isSelected ? p.main : p.eye;
	const shadow = `
		3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,
		2px 1px 0 #000,3px 1px 0 ${p.main},4px 1px 0 ${p.main},5px 1px 0 ${p.main},6px 1px 0 ${p.light},7px 1px 0 ${p.light},8px 1px 0 #000,
		1px 2px 0 #000,2px 2px 0 ${p.main},3px 2px 0 ${p.main},4px 2px 0 ${p.main},5px 2px 0 ${p.main},6px 2px 0 ${p.main},7px 2px 0 ${p.light},8px 2px 0 ${p.main},9px 2px 0 #000,
		0px 3px 0 #000,1px 3px 0 ${p.main},2px 3px 0 ${p.main},3px 3px 0 ${p.main},4px 3px 0 ${p.main},5px 3px 0 ${p.main},6px 3px 0 ${p.main},7px 3px 0 ${p.main},8px 3px 0 ${p.main},9px 3px 0 #000,
		0px 4px 0 #000,1px 4px 0 ${p.main},2px 4px 0 ${p.main},3px 4px 0 ${eyeColor},4px 4px 0 ${p.main},5px 4px 0 ${p.main},6px 4px 0 ${eyeColor},7px 4px 0 ${p.main},8px 4px 0 ${p.main},9px 4px 0 #000,
		0px 5px 0 #000,1px 5px 0 ${p.main},2px 5px 0 ${p.main},3px 5px 0 ${eyeColor},4px 5px 0 ${p.main},5px 5px 0 ${p.main},6px 5px 0 ${eyeColor},7px 5px 0 ${p.main},8px 5px 0 ${p.main},9px 5px 0 #000,
		0px 6px 0 #000,1px 6px 0 ${p.dark},2px 6px 0 ${p.main},3px 6px 0 ${p.main},4px 6px 0 ${p.main},5px 6px 0 ${p.main},6px 6px 0 ${p.main},7px 6px 0 ${p.main},8px 6px 0 ${p.main},9px 6px 0 #000,
		1px 7px 0 #000,2px 7px 0 ${p.dark},3px 7px 0 ${p.main},4px 7px 0 ${p.main},5px 7px 0 ${p.main},6px 7px 0 ${p.main},7px 7px 0 ${p.main},8px 7px 0 #000,
		2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000
	`;

	const eyeShadow = `3px 4px 0 ${p.eye},6px 4px 0 ${p.eye},3px 5px 0 ${p.eye},6px 5px 0 ${p.eye}`;

	const shimmerDelay = -(Date.now() % 8000);
	const shimmer = isBusy && !isCompacting ? `animation:blob-shimmer 8s ease-in-out infinite;animation-delay:${shimmerDelay}ms;` : "";
	const isIdle = status === "idle" && !isCompacting && !isSelected && !noDesaturate;
	const isCancelling = isAborting && (status === "streaming" || isBusy);
	const filters: string[] = [];
	if (hueRotate && status !== "starting" && status !== "terminated") filters.push(`hue-rotate(${hueRotate}deg)`);
	if (isCancelling) filters.push("saturate(0.3)");
	else if (isIdle) filters.push("saturate(0.4)");
	const filterStyle = filters.length ? `filter:${filters.join(" ")};` : "";
	const idleAnim = isIdle ? "animation:bobbit-breathe 4s ease-in-out infinite;" : "";
	const bobAnim = isBusy && !isCancelling && !isCompacting ? "animation:bobbit-bob 1.8s cubic-bezier(0.34,1.2,0.64,1) infinite;" : "";
	const cancelAnim = isCancelling ? "animation:bobbit-cancel-fade 1.2s ease-in-out infinite;" : "";
	const compactSquish = isCompacting && !isCancelling;
	const baseTransform = isCompacting
		? (compactSquish
			? "transform-origin:0 9px;animation:bobbit-squish 3s ease-in-out infinite;"
			: "transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(4.5px);transform-origin:0 9px;")
		: "transform:scale(1.6);transform-origin:0 0;";
	const eyeAnim = isSelected
		? (compactSquish
			? "transform-origin:0 9px;animation:bobbit-squish 3s ease-in-out infinite;"
			: `animation:${isCompacting ? "bobbit-eyes-squash" : "bobbit-eyes"} 6s step-end infinite;transform-origin:0 ${isCompacting ? "9px" : "0"};`)
		: baseTransform;

	const compactTopOffset = compactSquish ? 5.4 : 0;
	const eyeTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const eyeLeft = "0";
	const eyeLayer = isSelected
		? html`<span style="position:absolute;left:${eyeLeft};top:${eyeTop};display:block;width:1px;height:1px;image-rendering:pixelated;will-change:transform;backface-visibility:hidden;box-shadow:${eyeShadow};${eyeAnim}"></span>`
		: "";

	// Accessory overlay layer — counter-hue-rotated to keep fixed colours
	// Flask intentionally rotates with the bobbit for contrast
	const accFilter = hueRotate && status !== "starting" && status !== "terminated" && acc.id !== "flask"
		? `filter:hue-rotate(${-hueRotate}deg);`
		: "";
	// Bandana needs a slight translateY adjustment; crown uses yOffset for top positioning
	const isBandanaStyle = acc.id === "bandana";
	const isCrown = acc.id === "crown";
	const accTransform = isCompacting
		? (compactSquish
			? `transform-origin:0 9px;animation:${isCrown ? "bobbit-squish-crown" : "bobbit-squish"} 3s ease-in-out infinite;`
			: `transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(${isBandanaStyle ? "4px" : "4.5px"})${isCrown ? " translateX(-0.5px)" : ""};transform-origin:0 9px;`)
		: `transform:scale(1.6)${isBandanaStyle ? " translateY(-0.5px)" : ""}${isCrown ? " translateX(-0.5px)" : ""};transform-origin:0 0;`;
	const accTop = addsHeight ? `${acc.yOffset + compactTopOffset}px` : `${compactTopOffset}px`;
	const accessoryLayer = hasAccessory
		? html`<span style="position:absolute;left:0;top:${accTop};display:block;width:1px;height:1px;image-rendering:pixelated;will-change:transform;backface-visibility:hidden;box-shadow:${acc.shadow};${accTransform}${accFilter}"></span>`
		: "";

	// Shift inner content down when accessory adds height so tips aren't clipped
	const innerTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const containerHeight = addsHeight ? "19px" : "15px";

	const containerWidth = "20px";

	const innerLeft = "0";
	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:${containerWidth};height:${containerHeight};flex-shrink:0;position:relative;overflow:hidden;margin-top:1px;${filterStyle}${bobAnim}${cancelAnim}${idleAnim}"><span style="position:absolute;left:${innerLeft};top:${innerTop};display:block;width:1px;height:1px;image-rendering:pixelated;will-change:transform;backface-visibility:hidden;${baseTransform}box-shadow:${shadow};${shimmer}"></span>${eyeLayer}${accessoryLayer}</span>`;
}
