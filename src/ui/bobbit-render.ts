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
 * Render a bobbit body to a data URL image.
 *
 * When `pixelScale` is 1 (default), the canvas is 10×9 — one canvas pixel per
 * sprite pixel.  When `pixelScale` > 1, each sprite pixel is drawn as a
 * `pixelScale × pixelScale` rect, producing a larger canvas that can be
 * displayed at 1:1 device-pixel mapping to avoid fractional-DPR resampling
 * artifacts (e.g. double-width eye columns at non-integer zoom levels).
 */
export function renderBodyToDataURL(
	palette: BobbitPalette,
	gaze: EyeGaze = "center",
	blink = false,
	eyeColor?: string,
	pixelScale = 1,
): string {
	const canvas = document.createElement("canvas");
	canvas.width = BODY_WIDTH * pixelScale;
	canvas.height = BODY_HEIGHT * pixelScale;
	const ctx = canvas.getContext("2d")!;
	const pixels = resolveBodyPixels(palette, gaze, blink, eyeColor);
	if (pixelScale === 1) {
		drawPixels(ctx, pixels);
	} else {
		for (const [x, y, color] of pixels) {
			ctx.fillStyle = color;
			ctx.fillRect(x * pixelScale, y * pixelScale, pixelScale, pixelScale);
		}
	}
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

/** CSS scale factor used by .bobbit-blob__sprite */
const CSS_SCALE = 4;

/** Pre-render all unique eye frames for an eye sequence as SpritePixel arrays */
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
function drawPixelsBresenham(
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
	const cache = buildEyePixelCache(palette, sequence);

	// Size canvas backing to exact device pixel count
	const dpr = window.devicePixelRatio || 1;
	const cssW = BODY_WIDTH * CSS_SCALE;
	const cssH = BODY_HEIGHT * CSS_SCALE;
	const devW = Math.round(cssW * dpr);
	const devH = Math.round(cssH * dpr);
	canvas.width = devW;
	canvas.height = devH;
	// CSS dimensions are handled by the canvas.bobbit-blob__sprite rule (40×36px)

	const ctx = canvas.getContext("2d")!;
	let rafId = 0;
	let lastKey = "";
	let cssAnim: Animation | null = null;

	function findCssAnimation(): Animation | null {
		try {
			const anims = canvas.getAnimations();
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
			const pixels = cache.get(key);
			if (pixels) {
				ctx.clearRect(0, 0, devW, devH);
				drawPixelsBresenham(ctx, pixels, devW, devH);
			}
			lastKey = key;
		}
		rafId = requestAnimationFrame(tick);
	}

	// Draw initial frame synchronously to avoid a blank-canvas flash on mount
	const initPixels = cache.get("center-false") ?? cache.values().next().value;
	if (initPixels) drawPixelsBresenham(ctx, initPixels, devW, devH);
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
					const devW = Math.round(BODY_WIDTH * CSS_SCALE * dpr);
					const devH = Math.round(BODY_HEIGHT * CSS_SCALE * dpr);
					el.width = devW;
					el.height = devH;
					const ctx = el.getContext("2d")!;
					drawPixelsBresenham(ctx, pixels, devW, devH);
				}
			}
		};
		return html`<canvas ${ref(onRef)} class="bobbit-blob__sprite"></canvas>`;
	}
	const sequence = isIdle ? IDLE_EYE_SEQUENCE : BUSY_EYE_SEQUENCE;
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
	const eyeDelay = -(phaseIndex * 1.3 % 10).toFixed(2);
	const shimmerDelay = -(phaseIndex * 1.7 % 8).toFixed(2);

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
				<div class="${cls}" style="--bobbit-hue-rotate:${hue}deg;--bobbit-eye-delay:${eyeDelay}s;--bobbit-shimmer-delay:${shimmerDelay}s;">
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
	const shimmerDelay = -(Date.now() % 8000);
	const shimmer = isBusy && !isCompacting ? `animation:blob-shimmer 8s ease-in-out infinite;animation-delay:${shimmerDelay}ms;` : "";
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
	const bodyLayer = html`<img src="${bodyUrl}" width="${BODY_WIDTH * HI}" height="${BODY_HEIGHT * HI}" style="position:absolute;left:0;top:${innerTop};width:${cssW}px;height:${cssH}px;will-change:transform;${bodyTransform}${shimmer}">`;

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
