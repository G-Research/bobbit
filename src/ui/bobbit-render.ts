/**
 * Pure bobbit rendering functions with zero app dependencies.
 * Used by both the real app (session-colors.ts) and the preview page.
 *
 * These functions take all inputs explicitly and return Lit TemplateResults.
 * No imports from state.ts, api.ts, or any other app module.
 */
import { html, type TemplateResult } from "lit";

// ============================================================================
// TYPES
// ============================================================================

export interface BobbitPalette {
	main: string;
	light: string;
	dark: string;
	eye: string;
}

export interface AccessoryDef {
	id: string;
	label: string;
	shadow: string;
	yOffset: number;
	addsHeight: boolean;
}

export interface SidebarBobbitOptions {
	status: string;
	isCompacting?: boolean;
	hueRotate?: number;
	isSelected?: boolean;
	isAborting?: boolean;
	accessory?: AccessoryDef;
	noDesaturate?: boolean;
}

// ============================================================================
// PALETTES
// ============================================================================

export const CANONICAL_PALETTE: BobbitPalette = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#1a3010" };
export const STARTING_PALETTE: BobbitPalette = { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#2d2006" };
export const TERMINATED_PALETTE: BobbitPalette = { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#2c0b0e" };

export const NO_ACCESSORY: AccessoryDef = { id: "none", label: "None", shadow: "", yOffset: 0, addsHeight: false };

// ============================================================================
// SIDEBAR BOBBIT RENDERER
// ============================================================================

/** Pure renderer for sidebar bobbit — same output as statusBobbit() but takes all inputs explicitly. */
export function renderSidebarBobbit(opts: SidebarBobbitOptions): TemplateResult {
	const { status, isCompacting = false, hueRotate = 0, isSelected = false, isAborting = false, noDesaturate = false } = opts;
	const acc = opts.accessory ?? NO_ACCESSORY;
	const hasAccessory = acc.id !== "none" && acc.shadow !== "";
	const addsHeight = acc.addsHeight;

	let p: BobbitPalette;
	if (status === "starting") p = STARTING_PALETTE;
	else if (status === "terminated") p = TERMINATED_PALETTE;
	else p = CANONICAL_PALETTE;

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
	const eyeLayer = isSelected
		? html`<span style="position:absolute;left:0;top:${eyeTop};display:block;width:1px;height:1px;image-rendering:pixelated;will-change:transform;backface-visibility:hidden;box-shadow:${eyeShadow};${eyeAnim}"></span>`
		: "";

	const accFilter = hueRotate && status !== "starting" && status !== "terminated" && acc.id !== "flask"
		? `filter:hue-rotate(${-hueRotate}deg);`
		: "";
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

	const innerTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const containerHeight = addsHeight ? "19px" : "15px";
	const containerWidth = "20px";

	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:${containerWidth};height:${containerHeight};flex-shrink:0;position:relative;overflow:hidden;margin-top:1px;${filterStyle}${bobAnim}${cancelAnim}${idleAnim}"><span style="position:absolute;left:0;top:${innerTop};display:block;width:1px;height:1px;image-rendering:pixelated;will-change:transform;backface-visibility:hidden;${baseTransform}box-shadow:${shadow};${shimmer}"></span>${eyeLayer}${accessoryLayer}</span>`;
}
