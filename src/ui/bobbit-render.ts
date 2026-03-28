/**
 * Pure bobbit rendering functions with zero app dependencies.
 * Used by both the real app (session-colors.ts) and the preview page.
 *
 * These functions take all inputs explicitly and return Lit TemplateResults.
 * No imports from state.ts, api.ts, or any other app module.
 *
 * All pixel data comes from bobbit-sprite-data.ts — the single source of truth.
 */
import { html, type TemplateResult } from "lit";
import { ref, createRef } from "lit/directives/ref.js";
import {
	BODY_GRID, BODY_WIDTH, BODY_HEIGHT,
	EYE_POSITIONS,
	BUSY_EYE_SEQUENCE, IDLE_EYE_SEQUENCE,
	type PaletteKey, type SpritePixel, type EyeGaze, type EyeFrame, type ShadowPixel,
	type AccessorySpriteData,
	ACCESSORIES as SPRITE_ACCESSORIES,
	ACCESSORY_IDS as SPRITE_ACCESSORY_IDS,
} from "./bobbit-sprite-data.js";

// Re-export sprite data types and constants for convenience
export type { SpritePixel, EyeGaze, ShadowPixel, AccessorySpriteData };
export { BODY_GRID, BODY_WIDTH, BODY_HEIGHT, EYE_POSITIONS };
export { SPRITE_ACCESSORIES, SPRITE_ACCESSORY_IDS };

// ============================================================================
// TYPES
// ============================================================================

export interface BobbitPalette {
	main: string;
	light: string;
	dark: string;
	eye: string;
}

/** Legacy accessory definition with pre-computed box-shadow string. */
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

/** Aurora borealis palette — 14 curated hue-rotate offsets from canonical green. */
export const BOBBIT_HUE_ROTATIONS = [-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125];

// ============================================================================
// PIXEL → BOX-SHADOW CONVERSION
// ============================================================================

/** Convert sprite pixels to a CSS box-shadow string. */
export function pixelsToBoxShadow(pixels: SpritePixel[]): string {
	return pixels.map(([x, y, c]) => `${x}px ${y}px 0 ${c}`).join(",");
}

/** Convert shadow pixels (with alpha) to a CSS box-shadow string. */
export function shadowPixelsToBoxShadow(pixels: ShadowPixel[]): string {
	return pixels.map(([x, y, a]) => `${x}px ${y}px 0 rgba(0,0,0,${a})`).join(",");
}

// ============================================================================
// BODY PIXEL RESOLUTION
// ============================================================================

const PALETTE_KEY_MAP: Record<PaletteKey, keyof BobbitPalette | null> = {
	'_': null,
	'K': null, // black — handled specially
	'M': 'main',
	'L': 'light',
	'D': 'dark',
};

/**
 * Resolve the body grid + eyes into concrete pixel colors for a given palette.
 * Returns an array of [x, y, hexColor] ready for box-shadow or canvas rendering.
 */
export function resolveBodyPixels(
	palette: BobbitPalette,
	gaze: EyeGaze = "center",
	blink = false,
	eyeColor?: string,
): SpritePixel[] {
	const pixels: SpritePixel[] = [];
	const ec = eyeColor ?? palette.eye;
	const pos = EYE_POSITIONS[gaze];

	// Build set of eye pixel positions to skip in body grid
	const eyeSet = new Set<string>();
	if (blink) {
		eyeSet.add(`${pos.lx},${pos.ly + 1}`);
		eyeSet.add(`${pos.rx},${pos.ry + 1}`);
	} else {
		eyeSet.add(`${pos.lx},${pos.ly}`);
		eyeSet.add(`${pos.lx},${pos.ly + 1}`);
		eyeSet.add(`${pos.rx},${pos.ry}`);
		eyeSet.add(`${pos.rx},${pos.ry + 1}`);
	}

	// Resolve body grid, replacing eye positions with eye color
	for (let y = 0; y < BODY_HEIGHT; y++) {
		const row = BODY_GRID[y];
		for (let x = 0; x < BODY_WIDTH; x++) {
			const key = row[x];
			if (key === '_') continue;
			if (eyeSet.has(`${x},${y}`)) {
				pixels.push([x, y, ec]);
			} else {
				const color = key === 'K' ? '#000' : palette[PALETTE_KEY_MAP[key]!];
				pixels.push([x, y, color]);
			}
		}
	}

	return pixels;
}

// ============================================================================
// CANVAS RENDERING
// ============================================================================

/**
 * Draw sprite pixels to a canvas context at 1:1 scale (1 sprite pixel = 1 canvas pixel).
 * The canvas should be pre-sized. Call with appropriate transforms for scaling.
 */
export function drawPixels(ctx: CanvasRenderingContext2D, pixels: SpritePixel[]): void {
	for (const [x, y, color] of pixels) {
		ctx.fillStyle = color;
		ctx.fillRect(x, y, 1, 1);
	}
}

/**
 * Draw shadow pixels (with alpha) to a canvas context at 1:1 scale.
 */
export function drawShadowPixels(ctx: CanvasRenderingContext2D, pixels: ShadowPixel[]): void {
	for (const [x, y, alpha] of pixels) {
		ctx.fillStyle = `rgba(0,0,0,${alpha})`;
		ctx.fillRect(x, y, 1, 1);
	}
}

/**
 * Render a bobbit body to a data URL image at 1:1 pixel scale.
 * Use CSS image-rendering:pixelated and transform:scale() to display at desired size.
 */
export function renderBodyToDataURL(
	palette: BobbitPalette,
	gaze: EyeGaze = "center",
	blink = false,
	eyeColor?: string,
): string {
	const canvas = document.createElement("canvas");
	canvas.width = BODY_WIDTH;
	canvas.height = BODY_HEIGHT;
	const ctx = canvas.getContext("2d")!;
	drawPixels(ctx, resolveBodyPixels(palette, gaze, blink, eyeColor));
	return canvas.toDataURL();
}

/**
 * Render accessory pixels to a data URL image.
 * Returns the data URL and the bounding box of the accessory.
 */
export function renderAccessoryToDataURL(pixels: SpritePixel[]): { url: string; minX: number; minY: number; w: number; h: number } {
	if (pixels.length === 0) return { url: "", minX: 0, minY: 0, w: 0, h: 0 };
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of pixels) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d")!;
	for (const [x, y, color] of pixels) {
		ctx.fillStyle = color;
		ctx.fillRect(x - minX, y - minY, 1, 1);
	}
	return { url: canvas.toDataURL(), minX, minY, w, h };
}

// ============================================================================
// SPRITE DATA → LEGACY ACCESSORY DEF BRIDGE
// ============================================================================

/** Convert AccessorySpriteData → AccessoryDef (with pre-computed box-shadow string). */
export function spriteToAccessoryDef(data: AccessorySpriteData): AccessoryDef {
	return {
		id: data.id,
		label: data.label,
		shadow: pixelsToBoxShadow(data.pixels),
		yOffset: data.yOffset,
		addsHeight: data.addsHeight,
	};
}

/** Pre-computed AccessoryDef map from sprite data. */
export const ACCESSORY_DEFS: Record<string, AccessoryDef> = Object.fromEntries(
	Object.entries(SPRITE_ACCESSORIES).map(([k, v]) => [k, spriteToAccessoryDef(v)])
);

// ============================================================================
// IDLE BLOB (role manager / large display context)
// ============================================================================

export interface IdleBlobOptions {
	accId: string;
	accClass: string;
	size?: number;
	hueIndex?: number;
	phaseIndex?: number;
}

/**
 * Render an idle chat blob with accessory, sized to fit a container.
 * Uses the exact same DOM as StreamingMessageContainer.
 * Extracted from role-manager-page.ts idleBlob().
 */
export function renderIdleBlob(opts: IdleBlobOptions): TemplateResult {
	const { accId, accClass, size = 40, hueIndex = 0, phaseIndex = 0 } = opts;
	const cls = `bobbit-blob bobbit-blob--idle bobbit-blob--inline ${accClass}`.trim();
	const naturalSize = 76;
	const s = size / naturalSize;
	const hue = BOBBIT_HUE_ROTATIONS[hueIndex % BOBBIT_HUE_ROTATIONS.length];
	const eyeDelay = -(phaseIndex * 1.3 % 10).toFixed(2);
	const shimmerDelay = -(phaseIndex * 1.7 % 8).toFixed(2);
	return html`
		<div style="width:${size}px;height:${size}px;flex-shrink:0;">
			<div style="width:${naturalSize}px;height:${naturalSize}px;position:relative;overflow:hidden;transform:scale(${s.toFixed(3)});transform-origin:top left;">
				<div class="${cls}" style="--bobbit-hue-rotate:${hue}deg;--bobbit-eye-delay:${eyeDelay}s;--bobbit-shimmer-delay:${shimmerDelay}s;">
					<div class="bobbit-blob__sprite"></div>
					<div class="bobbit-blob__crown"></div>
					<div class="bobbit-blob__bandana"></div>
					<div class="bobbit-blob__magnifier"></div>
					<div class="bobbit-blob__palette"></div>
					<div class="bobbit-blob__pencil"></div>
					<div class="bobbit-blob__shield"></div>
					<div class="bobbit-blob__set-square"></div>
					<div class="bobbit-blob__flask"></div>
					<div class="bobbit-blob__wand"></div>
					<div class="bobbit-blob__wizard-hat"></div>
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// CHAT BLOB RENDERER
// ============================================================================

export interface ChatBlobOptions {
	blobClass: string;
	accClass?: string;
	hueRotate?: number;
}

/** Render a chat blob with the exact DOM structure from StreamingMessageContainer. */
export function renderChatBlob(opts: ChatBlobOptions): TemplateResult {
	const { blobClass, accClass = "", hueRotate = 0 } = opts;
	return html`<div class="${accClass}" style="--bobbit-hue-rotate:${hueRotate}deg;display:inline-block;padding:8px 20px 40px 20px;">
		<div class="${blobClass}">
			<div class="bobbit-blob__sprite"></div>
			<div class="bobbit-blob__crown"></div>
			<div class="bobbit-blob__bandana"></div>
			<div class="bobbit-blob__magnifier"></div>
			<div class="bobbit-blob__palette"></div>
			<div class="bobbit-blob__pencil"></div>
			<div class="bobbit-blob__shield"></div>
			<div class="bobbit-blob__set-square"></div>
			<div class="bobbit-blob__flask"></div>
			<div class="bobbit-blob__wand"></div>
			<div class="bobbit-blob__wizard-hat"></div>
			<div class="bobbit-blob__shadow"></div>
		</div>
	</div>`;
}

// ============================================================================
// CANVAS EYE ANIMATION
// ============================================================================

/** Pre-render all unique eye frames for an eye sequence, return map of frameKey → dataURL */
function buildEyeFrameCache(palette: BobbitPalette, sequence: EyeFrame[]): Map<string, string> {
	const cache = new Map<string, string>();
	for (const frame of sequence) {
		const key = `${frame.gaze}-${frame.blink}`;
		if (!cache.has(key)) {
			cache.set(key, renderBodyToDataURL(palette, frame.gaze, frame.blink));
		}
	}
	return cache;
}

/** Start a JS eye animation loop on a canvas sprite <img> element.
 *  Returns a cleanup function to stop the loop. */
export function startCanvasEyeAnimation(
	img: HTMLImageElement,
	sequence: EyeFrame[],
	cycleDurationMs: number,
	palette: BobbitPalette = CANONICAL_PALETTE,
): () => void {
	const cache = buildEyeFrameCache(palette, sequence);
	let rafId = 0;
	let lastKey = "";
	let cssAnim: Animation | null = null;

	function findCssAnimation(): Animation | null {
		try {
			const anims = img.getAnimations();
			for (const a of anims) {
				const kfs = (a.effect as KeyframeEffect)?.getKeyframes?.() ?? [];
				if (kfs.some((k: Keyframe) => "boxShadow" in k)) return a;
			}
			for (const a of anims) {
				const dur = (a.effect as KeyframeEffect)?.getTiming?.()?.duration;
				if (dur === cycleDurationMs) return a;
			}
		} catch { /* getAnimations not supported */ }
		return null;
	}

	function tick() {
		if (!cssAnim) cssAnim = findCssAnimation();

		let pct: number;
		if (cssAnim && cssAnim.currentTime != null) {
			const ct = typeof cssAnim.currentTime === "number"
				? cssAnim.currentTime
				: (cssAnim.currentTime as CSSNumericValue).to("ms").value;
			const delay = Number((cssAnim.effect as KeyframeEffect)?.getTiming?.()?.delay ?? 0);
			const active = ct - delay;
			pct = active >= 0
				? ((active % cycleDurationMs) / cycleDurationMs * 100)
				: 0;
		} else {
			pct = (performance.now() % cycleDurationMs) / cycleDurationMs * 100;
		}

		let frame = sequence[0];
		for (let i = sequence.length - 1; i >= 0; i--) {
			if (pct >= sequence[i].pct) { frame = sequence[i]; break; }
		}
		const key = `${frame.gaze}-${frame.blink}`;
		if (key !== lastKey) {
			const url = cache.get(key);
			if (url) img.src = url;
			lastKey = key;
		}
		rafId = requestAnimationFrame(tick);
	}
	rafId = requestAnimationFrame(tick);
	return () => cancelAnimationFrame(rafId);
}

// ============================================================================
// CANVAS CHAT BLOB RENDERER (for preview / comparison)
// ============================================================================

/**
 * Render a chat blob using canvas <img> with the same CSS classes as the
 * box-shadow version. Eye animation runs via JS (startCanvasEyeAnimation)
 * instead of CSS box-shadow keyframes. All other animations (bob, shimmer,
 * enter/exit, squish, idle translate) work via CSS.
 */
export function renderChatBlobCanvas(opts: ChatBlobOptions): TemplateResult {
	const { blobClass, accClass = "", hueRotate = 0 } = opts;
	const isIdle = blobClass.includes("idle");

	// Body — start with center gaze, JS animation will swap frames
	const bodyUrl = renderBodyToDataURL(CANONICAL_PALETTE, "center", false);

	// Use img elements WITH the CSS class names so all layout/transform/animation
	// CSS applies identically. Override width (CSS sets 1px for box-shadow technique)
	// to actual pixel dimensions, and compensate margins to keep the same layout box.
	const spriteStyle = `width:${BODY_WIDTH}px !important;height:${BODY_HEIGHT}px !important;margin:9px ${18 - (BODY_WIDTH - 1)}px ${28 - (BODY_HEIGHT - 1)}px 18px !important;box-shadow:none !important;image-rendering:pixelated;`;

	// Start eye animation when the img mounts
	const sequence = isIdle ? IDLE_EYE_SEQUENCE : BUSY_EYE_SEQUENCE;
	const cycleDuration = 10000; // both busy and idle use 10s cycles
	const spriteRef = createRef<HTMLImageElement>();
	let cleanup: (() => void) | null = null;
	const onRef = (el: Element | undefined) => {
		if (el && el instanceof HTMLImageElement) {
			cleanup?.();
			cleanup = startCanvasEyeAnimation(el, sequence, cycleDuration);
		}
	};

	return html`<div class="${accClass}" style="--bobbit-hue-rotate:${hueRotate}deg;display:inline-block;padding:8px 20px 40px 20px;">
		<div class="${blobClass}">
			<img ${ref(onRef)} class="bobbit-blob__sprite" src="${bodyUrl}" style="${spriteStyle}">
			<div class="bobbit-blob__crown"></div>
			<div class="bobbit-blob__bandana"></div>
			<div class="bobbit-blob__magnifier"></div>
			<div class="bobbit-blob__palette"></div>
			<div class="bobbit-blob__pencil"></div>
			<div class="bobbit-blob__shield"></div>
			<div class="bobbit-blob__set-square"></div>
			<div class="bobbit-blob__flask"></div>
			<div class="bobbit-blob__wand"></div>
			<div class="bobbit-blob__wizard-hat"></div>
			<div class="bobbit-blob__shadow"></div>
		</div>
	</div>`;
}

// ============================================================================
// CANVAS IDLE BLOB (role manager / comparison)
// ============================================================================

/**
 * Render an idle blob using canvas inside the same DOM structure as renderIdleBlob.
 * Only the sprite body is canvas-rendered; accessories use CSS box-shadow.
 */
export function renderIdleBlobCanvas(opts: IdleBlobOptions): TemplateResult {
	const { accId, accClass, size = 40, hueIndex = 0, phaseIndex = 0 } = opts;
	const cls = `bobbit-blob bobbit-blob--idle bobbit-blob--inline ${accClass}`.trim();
	const naturalSize = 76;
	const s = size / naturalSize;
	const hue = BOBBIT_HUE_ROTATIONS[hueIndex % BOBBIT_HUE_ROTATIONS.length];
	const eyeDelay = -(phaseIndex * 1.3 % 10).toFixed(2);
	const shimmerDelay = -(phaseIndex * 1.7 % 8).toFixed(2);

	const bodyUrl = renderBodyToDataURL(CANONICAL_PALETTE, "center", false);
	const spriteStyle = `width:${BODY_WIDTH}px !important;height:${BODY_HEIGHT}px !important;margin:9px ${18 - (BODY_WIDTH - 1)}px ${28 - (BODY_HEIGHT - 1)}px 18px !important;box-shadow:none !important;image-rendering:pixelated;`;

	// Eye animation for idle blob
	let cleanup: (() => void) | null = null;
	const onRef = (el: Element | undefined) => {
		if (el && el instanceof HTMLImageElement) {
			cleanup?.();
			cleanup = startCanvasEyeAnimation(el, IDLE_EYE_SEQUENCE, 10000);
		}
	};

	return html`
		<div style="width:${size}px;height:${size}px;flex-shrink:0;">
			<div style="width:${naturalSize}px;height:${naturalSize}px;position:relative;overflow:hidden;transform:scale(${s.toFixed(3)});transform-origin:top left;">
				<div class="${cls}" style="--bobbit-hue-rotate:${hue}deg;--bobbit-eye-delay:${eyeDelay}s;--bobbit-shimmer-delay:${shimmerDelay}s;">
					<img ${ref(onRef)} class="bobbit-blob__sprite" src="${bodyUrl}" style="${spriteStyle}">
					<div class="bobbit-blob__crown"></div>
					<div class="bobbit-blob__bandana"></div>
					<div class="bobbit-blob__magnifier"></div>
					<div class="bobbit-blob__palette"></div>
					<div class="bobbit-blob__pencil"></div>
					<div class="bobbit-blob__shield"></div>
					<div class="bobbit-blob__set-square"></div>
					<div class="bobbit-blob__flask"></div>
					<div class="bobbit-blob__wand"></div>
					<div class="bobbit-blob__wizard-hat"></div>
				</div>
			</div>
		</div>
	`;
}

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

	// Resolve body pixels from sprite data
	const eyeColor = isSelected ? p.main : p.eye;
	const bodyPixels = resolveBodyPixels(p, "center", false, eyeColor);
	const shadow = pixelsToBoxShadow(bodyPixels);

	// Eye overlay (separate span, only when selected for independent animation)
	const eyePos = EYE_POSITIONS["center"];
	const eyeShadow = pixelsToBoxShadow([
		[eyePos.lx, eyePos.ly, p.eye], [eyePos.rx, eyePos.ry, p.eye],
		[eyePos.lx, eyePos.ly + 1, p.eye], [eyePos.rx, eyePos.ry + 1, p.eye],
	]);

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

// ============================================================================
// CANVAS SIDEBAR RENDERER (for preview / comparison)
// ============================================================================

/**
 * Render a sidebar bobbit to a canvas-based <img> element.
 * Uses the same data as renderSidebarBobbit but draws to canvas
 * instead of box-shadow. For side-by-side comparison in the preview page.
 *
 * Note: animations (bob, shimmer, eye blink) still use CSS on the container.
 * Only the pixel rendering technique differs (canvas vs box-shadow).
 */
export function renderSidebarBobbitCanvas(opts: SidebarBobbitOptions): TemplateResult {
	const { status, isCompacting = false, hueRotate = 0, isSelected = false, isAborting = false, noDesaturate = false } = opts;
	const acc = opts.accessory ?? NO_ACCESSORY;
	const hasAccessory = acc.id !== "none";
	const addsHeight = acc.addsHeight;

	let p: BobbitPalette;
	if (status === "starting") p = STARTING_PALETTE;
	else if (status === "terminated") p = TERMINATED_PALETTE;
	else p = CANONICAL_PALETTE;

	const isBusy = status === "streaming" || isCompacting;

	// Draw body to canvas data URL
	const eyeColor = isSelected ? p.main : p.eye;
	const bodyUrl = renderBodyToDataURL(p, "center", false, eyeColor);

	// Eye overlay data URL (only when selected)
	let eyeUrl = "";
	if (isSelected) {
		const eyePos = EYE_POSITIONS["center"];
		const eyePixels: SpritePixel[] = [
			[eyePos.lx, eyePos.ly, p.eye], [eyePos.rx, eyePos.ry, p.eye],
			[eyePos.lx, eyePos.ly + 1, p.eye], [eyePos.rx, eyePos.ry + 1, p.eye],
		];
		const canvas = document.createElement("canvas");
		canvas.width = BODY_WIDTH;
		canvas.height = BODY_HEIGHT;
		drawPixels(canvas.getContext("2d")!, eyePixels);
		eyeUrl = canvas.toDataURL();
	}

	// Accessory data URL — render at same coordinate origin as box-shadow (0,0)
	// so CSS transforms (translateX, scale, transform-origin) behave identically
	let accUrl = "";
	let accCanvasW = 0;
	let accCanvasH = 0;
	if (hasAccessory) {
		const spriteData = SPRITE_ACCESSORIES[acc.id];
		if (spriteData && spriteData.pixels.length > 0) {
			// Find bounds to size the canvas, but keep pixel coordinates absolute
			let minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const [x, y] of spriteData.pixels) {
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
			// Canvas origin at (0, minY) — shift negative y values to canvas y=0
			const yShift = Math.min(0, minY);
			accCanvasW = maxX + 1;
			accCanvasH = maxY - yShift + 1;
			const canvas = document.createElement("canvas");
			canvas.width = accCanvasW;
			canvas.height = accCanvasH;
			const ctx = canvas.getContext("2d")!;
			for (const [x, y, color] of spriteData.pixels) {
				ctx.fillStyle = color;
				ctx.fillRect(x, y - yShift, 1, 1);
			}
			accUrl = canvas.toDataURL();
		}
	}

	// Reuse all the CSS animation logic from box-shadow version
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

	const compactTopOffset = compactSquish ? 5.4 : 0;

	// Body transform: scale(1.6) via CSS on the img
	const bodyTransform = isCompacting
		? (compactSquish
			? "transform-origin:0 9px;animation:bobbit-squish 3s ease-in-out infinite;"
			: "transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(4.5px);transform-origin:0 9px;")
		: "transform:scale(1.6);transform-origin:0 0;";

	// Eye animation
	const eyeAnim = isSelected
		? (compactSquish
			? "transform-origin:0 9px;animation:bobbit-squish 3s ease-in-out infinite;"
			: `animation:${isCompacting ? "bobbit-eyes-squash" : "bobbit-eyes"} 6s step-end infinite;transform-origin:0 ${isCompacting ? "9px" : "0"};`)
		: bodyTransform;

	// Accessory transform
	const isBandanaStyle = acc.id === "bandana";
	const isCrown = acc.id === "crown";
	const accFilter = hueRotate && status !== "starting" && status !== "terminated" && acc.id !== "flask"
		? `filter:hue-rotate(${-hueRotate}deg);`
		: "";
	const accTransform = isCompacting
		? (compactSquish
			? `transform-origin:0 9px;animation:${isCrown ? "bobbit-squish-crown" : "bobbit-squish"} 3s ease-in-out infinite;`
			: `transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(${isBandanaStyle ? "4px" : "4.5px"})${isCrown ? " translateX(-0.5px)" : ""};transform-origin:0 9px;`)
		: `transform:scale(1.6)${isBandanaStyle ? " translateY(-0.5px)" : ""}${isCrown ? " translateX(-0.5px)" : ""};transform-origin:0 0;`;

	const innerTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const eyeTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const accTop = addsHeight ? `${acc.yOffset + compactTopOffset}px` : `${compactTopOffset}px`;
	const containerHeight = addsHeight ? "19px" : "15px";
	const containerWidth = "20px";

	// Body layer: canvas-rendered img with pixelated scaling
	const bodyLayer = html`<img src="${bodyUrl}" width="${BODY_WIDTH}" height="${BODY_HEIGHT}" style="position:absolute;left:0;top:${innerTop};image-rendering:pixelated;will-change:transform;${bodyTransform}${shimmer}">`;

	// Eye layer (only when selected)
	const eyeLayer = isSelected && eyeUrl
		? html`<img src="${eyeUrl}" width="${BODY_WIDTH}" height="${BODY_HEIGHT}" style="position:absolute;left:0;top:${eyeTop};image-rendering:pixelated;will-change:transform;${eyeAnim}">`
		: "";

	// Accessory layer — positioned at left:0;top:accTop just like the box-shadow span
	const accessoryLayer = accUrl
		? html`<img src="${accUrl}" width="${accCanvasW}" height="${accCanvasH}" style="position:absolute;left:0;top:${accTop};image-rendering:pixelated;will-change:transform;${accTransform}${accFilter}">`
		: "";

	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:${containerWidth};height:${containerHeight};flex-shrink:0;position:relative;overflow:hidden;margin-top:1px;${filterStyle}${bobAnim}${cancelAnim}${idleAnim}">${bodyLayer}${eyeLayer}${accessoryLayer}</span>`;
}
