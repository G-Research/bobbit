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
import { ref } from "lit/directives/ref.js";
import {
	BODY_GRID, BODY_WIDTH, BODY_HEIGHT,
	EYE_POSITIONS,
	BUSY_EYE_SEQUENCE, IDLE_EYE_SEQUENCE, SLEEP_EYE_SEQUENCE,
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

/** Accessory definition derived from canonical sprite data. */
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

export const CANONICAL_PALETTE: BobbitPalette = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#000000" };
export const STARTING_PALETTE: BobbitPalette = { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#000000" };
export const TERMINATED_PALETTE: BobbitPalette = { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#000000" };

export const NO_ACCESSORY: AccessoryDef = { id: "none", label: "None", shadow: "", yOffset: 0, addsHeight: false };

/** Convert sprite pixels to a CSS box-shadow string. */
function pixelsToBoxShadow(pixels: SpritePixel[]): string {
	return pixels.map(([x, y, c]) => `${x}px ${y}px 0 ${c}`).join(",");
}

/** Aurora borealis palette — 14 curated hue-rotate offsets from canonical green. */
export const BOBBIT_HUE_ROTATIONS = [-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125];

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

// ============================================================================
// SPRITE DATA → LEGACY ACCESSORY DEF BRIDGE
// ============================================================================

/** Convert AccessorySpriteData → AccessoryDef. */
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

// ============================================================================
// CHAT BLOB RENDERER
// ============================================================================

export interface ChatBlobOptions {
	blobClass: string;
	accClass?: string;
	hueRotate?: number;
}

// ============================================================================
// CANVAS EYE ANIMATION
// ============================================================================

/**
 * Oversample factor for the canvas backing buffer (per sprite pixel, before DPR).
 * The canvas displays at CSS 40×36 (BODY_WIDTH/HEIGHT × 4) but draws into a
 * BODY × HI × dpr buffer. The browser then bilinearly downsamples to screen.
 * Each sprite pixel becomes a uniformly-coloured HI×HI block, so at rest the
 * downsample reproduces the source colour exactly — but during rotation /
 * non-uniform scale the bilinear filter smooths jagged 1–2 device-pixel jitter
 * that nearest-neighbor (image-rendering: pixelated) would otherwise produce.
 * This is the same technique renderSidebarBobbitCanvas uses. */
const CANVAS_HI = 8;

/** Pre-render all unique eye frames for an eye sequence as offscreen canvases.
 *  Storing complete bitmaps (rather than pixel arrays) lets the live frame swap
 *  use a single drawImage() blit instead of clearRect + ~80 fillRects, so the
 *  canvas update is atomic from the compositor's perspective — no visible
 *  partial-redraw flicker when the gaze changes mid-hop. */
function buildEyeFrameCache(
	palette: BobbitPalette,
	sequence: EyeFrame[],
	devW: number,
	devH: number,
): Map<string, HTMLCanvasElement> {
	const cache = new Map<string, HTMLCanvasElement>();
	for (const frame of sequence) {
		const key = `${frame.gaze}-${frame.blink}`;
		if (cache.has(key)) continue;
		const off = document.createElement("canvas");
		off.width = devW;
		off.height = devH;
		const offCtx = off.getContext("2d")!;
		const pixels = resolveBodyPixels(palette, frame.gaze, frame.blink);
		drawPixelsBresenham(offCtx, pixels, devW, devH);
		cache.set(key, off);
	}
	return cache;
}

/** @deprecated Kept for callers (sidebar) that still want raw pixel arrays. */
function buildEyePixelCache(palette: BobbitPalette, sequence: EyeFrame[]): Map<string, SpritePixel[]> {
	const cache = new Map<string, SpritePixel[]>();
	for (const frame of sequence) {
		const key = `${frame.gaze}-${frame.blink}`;
		if (!cache.has(key)) {
			cache.set(key, resolveBodyPixels(palette, frame.gaze, frame.blink));
		}
	}
	return cache;
}

/**
 * Draw sprite pixels to a canvas at exact device-pixel resolution using
 * Bresenham-style distribution. Each sprite pixel gets either
 * floor(devicePx / spritePx) or ceil(devicePx / spritePx) device pixels,
 * distributed uniformly so adjacent columns never differ by more than 1px.
 * This guarantees pixel-perfect eyes at every DPR.
 */
export function drawPixelsBresenham(
	ctx: CanvasRenderingContext2D,
	pixels: SpritePixel[],
	devW: number,
	devH: number,
): void {
	// Precompute column and row boundaries
	const colEdges = new Int32Array(BODY_WIDTH + 1);
	const rowEdges = new Int32Array(BODY_HEIGHT + 1);
	for (let x = 0; x <= BODY_WIDTH; x++) colEdges[x] = Math.round(x * devW / BODY_WIDTH);
	for (let y = 0; y <= BODY_HEIGHT; y++) rowEdges[y] = Math.round(y * devH / BODY_HEIGHT);

	for (const [x, y, color] of pixels) {
		const px = colEdges[x];
		const py = rowEdges[y];
		const pw = colEdges[x + 1] - px;
		const ph = rowEdges[y + 1] - py;
		ctx.fillStyle = color;
		ctx.fillRect(px, py, pw, ph);
	}
}

/**
 * Start a JS eye animation loop on a <canvas> sprite element.
 * Draws directly to the canvas at device-pixel resolution — no image scaling,
 * no nearest-neighbor resampling. Returns a cleanup function to stop the loop.
 */
export function startCanvasEyeAnimation(
	canvas: HTMLCanvasElement,
	sequence: EyeFrame[],
	cycleDurationMs: number,
	palette: BobbitPalette = CANONICAL_PALETTE,
): () => void {
	// Oversample: each sprite pixel → (HI × dpr) device pixels in the buffer.
	// CSS displays at 40×36 (BODY × CSS_SCALE); browser bilinearly downsamples
	// from buffer → screen, smoothing rotations without softening at-rest pixels.
	const dpr = window.devicePixelRatio || 1;
	const devW = Math.round(BODY_WIDTH * CANVAS_HI * dpr);
	const devH = Math.round(BODY_HEIGHT * CANVAS_HI * dpr);
	canvas.width = devW;
	canvas.height = devH;

	const cache = buildEyeFrameCache(palette, sequence, devW, devH);
	// CSS dimensions are handled by the canvas.bobbit-blob__sprite rule (40×36px)

	const ctx = canvas.getContext("2d")!;
	let rafId = 0;
	let lastKey = "";

	// Single source of truth: the canvas already has its own CSS animation
	// (blob-busy-move-canvas / blob-idle-eyes-canvas) with the right
	// animation-delay (--bobbit-idle-phase) applied. Reading that animation's
	// currentTime gives us the *exact same* clock value CSS uses to evaluate
	// every other animation on the same element — including sibling
	// accessories (magnifier-depth-idle) that share the same delay.
	//
	// This bypasses every clock-arithmetic edge case (mount time, document
	// timeline epoch, negative-delay semantics): we don't compute the phase,
	// we observe the same one CSS observes.
	function readPhasePct(): number {
		const anims = canvas.getAnimations();
		// Pick the 10s-cycle animation; its currentTime already accounts for
		// animation-delay (negative delays make it start positive).
		let anim: Animation | undefined;
		for (const a of anims) {
			const dur = (a.effect as KeyframeEffect | null)?.getTiming?.()?.duration;
			if (dur === cycleDurationMs) { anim = a; break; }
		}
		if (!anim || anim.currentTime == null) return 0;
		const raw = typeof anim.currentTime === "number"
			? anim.currentTime
			: Number((anim.currentTime as CSSNumericValue).to("ms").value);
		const wrapped = ((raw % cycleDurationMs) + cycleDurationMs) % cycleDurationMs;
		return (wrapped / cycleDurationMs) * 100;
	}

	function tick() {
		const pct = readPhasePct();
		let frame = sequence[0];
		for (let i = sequence.length - 1; i >= 0; i--) {
			if (pct >= sequence[i].pct) { frame = sequence[i]; break; }
		}
		const key = `${frame.gaze}-${frame.blink}`;
		if (key !== lastKey) {
			const src = cache.get(key);
			if (src) {
				// Atomic blit: clearRect + drawImage execute in one canvas paint,
				// so the user never sees a partially-redrawn frame.
				ctx.clearRect(0, 0, devW, devH);
				ctx.drawImage(src, 0, 0);
			}
			lastKey = key;
		}
		rafId = requestAnimationFrame(tick);
	}

	// Draw initial frame synchronously to avoid a blank-canvas flash on mount
	const initSrc = cache.get("center-false") ?? cache.values().next().value;
	if (initSrc) ctx.drawImage(initSrc, 0, 0);
	lastKey = "center-false";

	rafId = requestAnimationFrame(tick);
	return () => cancelAnimationFrame(rafId);
}

// ============================================================================
// CANVAS BLOB SPRITE — <canvas> element for use inside existing blob templates
// ============================================================================

/**
 * Render just the canvas sprite element with eye animation.
 * Drop-in replacement for `<div class="bobbit-blob__sprite"></div>`.
 * Uses a <canvas> rendered at exact device-pixel resolution for pixel-perfect
 * eyes at any DPR/zoom level. CSS animations use -canvas keyframe variants
 * (no scale(4), translates ×4).
 */
export function renderBlobSpriteCanvas(isIdle: boolean, archived = false): TemplateResult {
	if (archived) {
		// Static frame: center gaze, no blink, no animation loop
		const onRef = (el: Element | undefined) => {
			if (el && el instanceof HTMLCanvasElement) {
				const cache = buildEyePixelCache(CANONICAL_PALETTE, [{ pct: 0, gaze: "center", blink: false }]);
				const pixels = cache.get("center-false");
				if (pixels) {
					const dpr = window.devicePixelRatio || 1;
					const devW = Math.round(BODY_WIDTH * CANVAS_HI * dpr);
					const devH = Math.round(BODY_HEIGHT * CANVAS_HI * dpr);
					el.width = devW;
					el.height = devH;
					const ctx = el.getContext("2d")!;
					drawPixelsBresenham(ctx, pixels, devW, devH);
				}
			}
		};
		return html`<canvas ${ref(onRef)} class="bobbit-blob__sprite"></canvas>`;
	}
	// Chat blob: when idle, switch to the SLEEP eye sequence so the eyes stay
	// shut. This pairs with the breathing-squish CSS animation to make idle
	// bobbits read as "asleep" rather than "awake but bored".
	const sequence = isIdle ? SLEEP_EYE_SEQUENCE : BUSY_EYE_SEQUENCE;
	let cleanup: (() => void) | null = null;
	const onRef = (el: Element | undefined) => {
		if (el && el instanceof HTMLCanvasElement) {
			cleanup?.();
			cleanup = startCanvasEyeAnimation(el, sequence, 10000);
		} else {
			cleanup?.();
			cleanup = null;
		}
	};
	return html`<canvas ${ref(onRef)} class="bobbit-blob__sprite"></canvas>`;
}

/** @deprecated Use renderBlobSpriteCanvas instead. Kept for backward compat. */
export function renderBlobSpriteImg(isIdle: boolean, archived = false): TemplateResult {
	return renderBlobSpriteCanvas(isIdle, archived);
}

// ============================================================================
// CANVAS CHAT BLOB RENDERER (for preview / comparison)
// ============================================================================

/**
 * Render a chat blob using canvas-based sprite with the same CSS classes as the
 * box-shadow version. Eye animation runs via JS (startCanvasEyeAnimation)
 * drawing directly to a <canvas> at device-pixel resolution. All other
 * animations (bob, shimmer, enter/exit, squish, idle translate) work via
 * the -canvas CSS keyframe variants.
 */
export function renderChatBlobCanvas(opts: ChatBlobOptions): TemplateResult {
	const { blobClass, accClass = "", hueRotate = 0 } = opts;
	const isIdle = blobClass.includes("idle");

	const sequence = isIdle ? IDLE_EYE_SEQUENCE : BUSY_EYE_SEQUENCE;
	const cycleDuration = 10000;
	let cleanup: (() => void) | null = null;
	const onRef = (el: Element | undefined) => {
		if (el && el instanceof HTMLCanvasElement) {
			cleanup?.();
			cleanup = startCanvasEyeAnimation(el, sequence, cycleDuration);
		} else {
			cleanup?.();
			cleanup = null;
		}
	};

	return html`<div class="${accClass}" style="--bobbit-hue-rotate:${hueRotate}deg;display:inline-block;padding:8px 20px 40px 20px;">
		<div class="${blobClass}">
			<canvas ${ref(onRef)} class="bobbit-blob__sprite"></canvas>
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
			<div class="bobbit-blob__stamp"></div>
			<div class="bobbit-blob__clipboard"></div>
			<div class="bobbit-blob__shadow"></div>
		</div>
	</div>`;
}

// ============================================================================
// CANVAS IDLE BLOB (role manager / comparison)
// ============================================================================

/**
 * Render an idle blob using canvas-based <canvas> for the sprite body.
 * Only the sprite body is canvas-rendered; accessories use CSS box-shadow.
 */
export function renderIdleBlobCanvas(opts: IdleBlobOptions): TemplateResult {
	const { accId: _accId, accClass, size = 40, hueIndex = 0, phaseIndex = 0 } = opts;
	const cls = `bobbit-blob bobbit-blob--idle bobbit-blob--inline ${accClass}`.trim();
	const naturalSize = 76;
	const s = size / naturalSize;
	const hue = BOBBIT_HUE_ROTATIONS[hueIndex % BOBBIT_HUE_ROTATIONS.length];
	// Negative animation-delay: each blob starts at a different point in the
	// 10s cycle, so eyes and accessories are phase-offset across rows.
	// 1.3s prime-ish step keeps neighbours visibly out of sync.
	const idlePhaseSec = -(phaseIndex * 1.3 % 10);

	// Eye animation for idle blob
	let cleanup: (() => void) | null = null;
	const onRef = (el: Element | undefined) => {
		if (el && el instanceof HTMLCanvasElement) {
			cleanup?.();
			cleanup = startCanvasEyeAnimation(el, IDLE_EYE_SEQUENCE, 10000);
		} else {
			cleanup?.();
			cleanup = null;
		}
	};

	return html`
		<div style="width:${size}px;height:${size}px;flex-shrink:0;">
			<div style="width:${naturalSize}px;height:${naturalSize}px;position:relative;overflow:hidden;transform:scale(${s.toFixed(3)});transform-origin:top left;">
				<div class="${cls}" style="--bobbit-hue-rotate:${hue}deg;--bobbit-idle-phase:${idlePhaseSec.toFixed(2)}s;">
					<canvas ${ref(onRef)} class="bobbit-blob__sprite"></canvas>
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
					<div class="bobbit-blob__stamp"></div>
					<div class="bobbit-blob__clipboard"></div>
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// CANVAS SIDEBAR RENDERER
// ============================================================================

/**
 * Render a sidebar bobbit to a canvas-based <img> element.
 * Draws body, eyes, and accessories to off-screen canvases displayed via <img>.
 * Animations (bob, shimmer, eye blink) still use CSS on the container.
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

	// Smooth rendering: draw at HI× into the canvas, display at CSS target size
	// with image-rendering:auto (bilinear downsampling). No CSS scale() needed.
	const HI = 8;
	const S = 1.6; // sidebar display scale factor
	const cssW = BODY_WIDTH * S;  // 16
	const cssH = BODY_HEIGHT * S; // 14.4

	// Draw body to canvas at HI× scale
	const eyeColor = isSelected ? p.main : p.eye;
	const bodyPixels = resolveBodyPixels(p, "center", false, eyeColor);
	const bodyCanvas = document.createElement("canvas");
	bodyCanvas.width = BODY_WIDTH * HI;
	bodyCanvas.height = BODY_HEIGHT * HI;
	const bodyCtx = bodyCanvas.getContext("2d")!;
	bodyCtx.imageSmoothingEnabled = false;
	for (const [x, y, color] of bodyPixels) {
		bodyCtx.fillStyle = color;
		bodyCtx.fillRect(x * HI, y * HI, HI, HI);
	}
	const bodyUrl = bodyCanvas.toDataURL();

	// Eye overlay at HI× (only when selected)
	let eyeUrl = "";
	if (isSelected) {
		const eyePos = EYE_POSITIONS["center"];
		const eyePixels: SpritePixel[] = [
			[eyePos.lx, eyePos.ly, p.eye], [eyePos.rx, eyePos.ry, p.eye],
			[eyePos.lx, eyePos.ly + 1, p.eye], [eyePos.rx, eyePos.ry + 1, p.eye],
		];
		const eyeCanvas = document.createElement("canvas");
		eyeCanvas.width = BODY_WIDTH * HI;
		eyeCanvas.height = BODY_HEIGHT * HI;
		const eyeCtx = eyeCanvas.getContext("2d")!;
		eyeCtx.imageSmoothingEnabled = false;
		for (const [x, y, color] of eyePixels) {
			eyeCtx.fillStyle = color;
			eyeCtx.fillRect(x * HI, y * HI, HI, HI);
		}
		eyeUrl = eyeCanvas.toDataURL();
	}

	// Accessory at HI× scale
	let accUrl = "";
	let accCssW = 0;
	let accCssH = 0;
	if (hasAccessory) {
		const spriteData = SPRITE_ACCESSORIES[acc.id];
		if (spriteData && spriteData.pixels.length > 0) {
			let minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const [x, y] of spriteData.pixels) {
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
			const yShift = Math.min(0, minY);
			const srcW = maxX + 1;
			const srcH = maxY - yShift + 1;
			accCssW = srcW * S;
			accCssH = srcH * S;
			const accCanvas = document.createElement("canvas");
			accCanvas.width = srcW * HI;
			accCanvas.height = srcH * HI;
			const accCtx = accCanvas.getContext("2d")!;
			accCtx.imageSmoothingEnabled = false;
			for (const [x, y, color] of spriteData.pixels) {
				accCtx.fillStyle = color;
				accCtx.fillRect(x * HI, (y - yShift) * HI, HI, HI);
			}
			accUrl = accCanvas.toDataURL();
		}
	}

	// Animation styles (same logic as before)
	const isIdle = status === "idle" && !isCompacting && !isSelected && !noDesaturate;
	const isCancelling = isAborting && (status === "streaming" || isBusy);
	const filters: string[] = [];
	if (hueRotate && status !== "starting" && status !== "terminated") filters.push(`hue-rotate(${hueRotate}deg)`);
	if (isCancelling) filters.push("saturate(0.3)");
	else if (status === "terminated") filters.push("saturate(0)");
	else if (isIdle) filters.push("saturate(0.4)");
	const filterStyle = filters.length ? `filter:${filters.join(" ")};` : "";
	const idleAnim = isIdle ? "animation:bobbit-breathe 4s ease-in-out infinite;" : "";
	const bobAnim = isBusy && !isCancelling && !isCompacting ? "animation:bobbit-bob 1.8s cubic-bezier(0.34,1.2,0.64,1) infinite;" : "";
	const cancelAnim = isCancelling ? "animation:bobbit-cancel-fade 1.2s ease-in-out infinite;" : "";
	const compactSquish = isCompacting && !isCancelling;

	const compactTopOffset = compactSquish ? 5.4 : 0;

	// Body transform: image already at CSS target size, no base scale needed.
	// Compaction uses -s (smooth) keyframes that omit scale(1.6).
	// transform-origin adjusted from 9px (sprite coords) to 14.4px (CSS coords).
	const bodyTransform = isCompacting
		? (compactSquish
			? `transform-origin:0 ${BODY_HEIGHT * S}px;animation:bobbit-squish-s 3s ease-in-out infinite;`
			: `transform:scaleY(0.75) translateY(${4.5 * S}px);transform-origin:0 ${BODY_HEIGHT * S}px;`)
		: "";

	// Eye animation — smooth variants
	const eyeAnim = isSelected
		? (compactSquish
			? `transform-origin:0 ${BODY_HEIGHT * S}px;animation:bobbit-squish-s 3s ease-in-out infinite;`
			: `animation:${isCompacting ? "bobbit-eyes-squash-s" : "bobbit-eyes-s"} 6s step-end infinite;transform-origin:0 ${isCompacting ? `${BODY_HEIGHT * S}px` : "0"};`)
		: bodyTransform;

	// Accessory transform — smooth variants
	const isBandanaStyle = acc.id === "bandana";
	const isCrown = acc.id === "crown";
	const accFilter = hueRotate && status !== "starting" && status !== "terminated" && acc.id !== "flask"
		? `filter:hue-rotate(${-hueRotate}deg);`
		: "";
	const accTransform = isCompacting
		? (compactSquish
			? `transform-origin:0 ${BODY_HEIGHT * S}px;animation:${isCrown ? "bobbit-squish-crown-s" : "bobbit-squish-s"} 3s ease-in-out infinite;`
			: `transform:scaleY(0.75) translateY(${(isBandanaStyle ? 4 : 4.5) * S}px)${isCrown ? ` translateX(${-0.5 * S}px)` : ""};transform-origin:0 ${BODY_HEIGHT * S}px;`)
		: `${isBandanaStyle ? `transform:translateY(${-0.5 * S}px);` : ""}${isCrown ? `transform:translateX(${-0.5 * S}px);` : ""}`;

	const innerTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const eyeTop = addsHeight ? `${4 + compactTopOffset}px` : `${compactTopOffset}px`;
	const accTop = addsHeight ? `${acc.yOffset + compactTopOffset}px` : `${compactTopOffset}px`;
	const containerHeight = addsHeight ? "19px" : "15px";
	const containerWidth = "20px";

	// Body layer: high-res canvas img displayed at CSS target size, smooth downsampling
	const bodyLayer = html`<img src="${bodyUrl}" width="${BODY_WIDTH * HI}" height="${BODY_HEIGHT * HI}" style="position:absolute;left:0;top:${innerTop};width:${cssW}px;height:${cssH}px;will-change:transform;${bodyTransform}">`;

	// Eye layer (only when selected)
	const eyeLayer = isSelected && eyeUrl
		? html`<img src="${eyeUrl}" width="${BODY_WIDTH * HI}" height="${BODY_HEIGHT * HI}" style="position:absolute;left:0;top:${eyeTop};width:${cssW}px;height:${cssH}px;will-change:transform;${eyeAnim}">`
		: "";

	// Accessory layer
	const accessoryLayer = accUrl
		? html`<img src="${accUrl}" style="position:absolute;left:0;top:${accTop};width:${accCssW}px;height:${accCssH}px;will-change:transform;${accTransform}${accFilter}">`
		: "";

	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:${containerWidth};height:${containerHeight};flex-shrink:0;position:relative;overflow:hidden;margin-top:1px;${filterStyle}${bobAnim}${cancelAnim}${idleAnim}">${bodyLayer}${eyeLayer}${accessoryLayer}</span>`;
}
