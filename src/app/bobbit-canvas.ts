/**
 * Canvas rendering utility for Bobbit pixel-art sprites.
 * Replaces CSS box-shadow rendering with crisp Canvas2D fillRect.
 *
 * Body pixels are drawn at 1:1 grid coordinates; the caller applies CSS
 * `transform: scale(N)` and `image-rendering: pixelated` for display scaling.
 * HiDPI is handled via the standard devicePixelRatio buffer pattern.
 */

// ============================================================================
// Public types
// ============================================================================

export interface Pixel {
	x: number;
	y: number;
	color: string;
}

export interface BobbitPalette {
	main: string;
	light: string;
	dark: string;
	eye: string;
}

export interface BobbitCanvasOptions {
	/** Pixel multiplier for CSS display size (1 = grid-pixel, 2 = picker). */
	scale: number;
	/**
	 * Buffer resolution multiplier — oversamples the canvas buffer to match the
	 * final display size when CSS `transform: scale(N)` is applied.  Prevents
	 * bilinear filtering blur from GPU compositor layers.
	 *
	 * Example: scale=1, renderScale=4 → CSS size is 10×9, buffer has 40×36
	 * logical pixels.  CSS scale(4) then maps 1:1 to the buffer — no resampling.
	 *
	 * Defaults to `scale` when omitted.
	 */
	renderScale?: number;
	/** Colour palette for body pixels. */
	palette: BobbitPalette;
	/** Override eye pixel colour (e.g. palette.main for selected state). */
	eyeColor?: string;
	/** Pre-parsed accessory pixels to overlay on body. */
	accessoryPixels?: Pixel[];
	/** Grid rows to shift body down for accessories that extend above (e.g. crown yOffset=2). */
	bodyYOffset?: number;
	/**
	 * External hue-rotation in degrees (CSS filter on container/canvas element).
	 * When set, accessory pixels are counter-rotated by −hueRotate so they keep
	 * their original colours.  Set `accessoryHueRotate = true` for flask (which
	 * should rotate with the body).
	 */
	hueRotate?: number;
	/** If true, accessory also gets hue-rotate (flask). Default false. */
	accessoryHueRotate?: boolean;
}

// ============================================================================
// Palettes
// ============================================================================

export const CANONICAL_PALETTE: BobbitPalette = {
	main: "#8ec63f",
	light: "#b5d98a",
	dark: "#6b9930",
	eye: "#1a3010",
};

export const STARTING_PALETTE: BobbitPalette = {
	main: "#eab308",
	light: "#fde047",
	dark: "#ca8a04",
	eye: "#2d2006",
};

export const TERMINATED_PALETTE: BobbitPalette = {
	main: "#ef4444",
	light: "#fca5a5",
	dark: "#dc2626",
	eye: "#2c0b0e",
};

// ============================================================================
// Body pixel template (10 × 9 grid, palette-token based)
// ============================================================================

/** Token key: O = outline (#000), M = main, L = light, D = dark, E = eye. */
type Token = "O" | "M" | "L" | "D" | "E";

interface TemplatePixel {
	x: number;
	y: number;
	t: Token;
}

/**
 * 10-wide × 9-tall bobbit body.  Pixel positions match the legacy
 * box-shadow grid exactly.
 */
const BODY: TemplatePixel[] = [
	// Row 0 — head outline
	{ x: 3, y: 0, t: "O" }, { x: 4, y: 0, t: "O" }, { x: 5, y: 0, t: "O" }, { x: 6, y: 0, t: "O" }, { x: 7, y: 0, t: "O" },
	// Row 1
	{ x: 2, y: 1, t: "O" }, { x: 3, y: 1, t: "M" }, { x: 4, y: 1, t: "M" }, { x: 5, y: 1, t: "M" }, { x: 6, y: 1, t: "L" }, { x: 7, y: 1, t: "L" }, { x: 8, y: 1, t: "O" },
	// Row 2
	{ x: 1, y: 2, t: "O" }, { x: 2, y: 2, t: "M" }, { x: 3, y: 2, t: "M" }, { x: 4, y: 2, t: "M" }, { x: 5, y: 2, t: "M" }, { x: 6, y: 2, t: "M" }, { x: 7, y: 2, t: "L" }, { x: 8, y: 2, t: "M" }, { x: 9, y: 2, t: "O" },
	// Row 3
	{ x: 0, y: 3, t: "O" }, { x: 1, y: 3, t: "M" }, { x: 2, y: 3, t: "M" }, { x: 3, y: 3, t: "M" }, { x: 4, y: 3, t: "M" }, { x: 5, y: 3, t: "M" }, { x: 6, y: 3, t: "M" }, { x: 7, y: 3, t: "M" }, { x: 8, y: 3, t: "M" }, { x: 9, y: 3, t: "O" },
	// Row 4 — eyes
	{ x: 0, y: 4, t: "O" }, { x: 1, y: 4, t: "M" }, { x: 2, y: 4, t: "M" }, { x: 3, y: 4, t: "E" }, { x: 4, y: 4, t: "M" }, { x: 5, y: 4, t: "M" }, { x: 6, y: 4, t: "E" }, { x: 7, y: 4, t: "M" }, { x: 8, y: 4, t: "M" }, { x: 9, y: 4, t: "O" },
	// Row 5 — eyes
	{ x: 0, y: 5, t: "O" }, { x: 1, y: 5, t: "M" }, { x: 2, y: 5, t: "M" }, { x: 3, y: 5, t: "E" }, { x: 4, y: 5, t: "M" }, { x: 5, y: 5, t: "M" }, { x: 6, y: 5, t: "E" }, { x: 7, y: 5, t: "M" }, { x: 8, y: 5, t: "M" }, { x: 9, y: 5, t: "O" },
	// Row 6 — dark edge
	{ x: 0, y: 6, t: "O" }, { x: 1, y: 6, t: "D" }, { x: 2, y: 6, t: "M" }, { x: 3, y: 6, t: "M" }, { x: 4, y: 6, t: "M" }, { x: 5, y: 6, t: "M" }, { x: 6, y: 6, t: "M" }, { x: 7, y: 6, t: "M" }, { x: 8, y: 6, t: "M" }, { x: 9, y: 6, t: "O" },
	// Row 7
	{ x: 1, y: 7, t: "O" }, { x: 2, y: 7, t: "D" }, { x: 3, y: 7, t: "M" }, { x: 4, y: 7, t: "M" }, { x: 5, y: 7, t: "M" }, { x: 6, y: 7, t: "M" }, { x: 7, y: 7, t: "M" }, { x: 8, y: 7, t: "O" },
	// Row 8 — feet outline
	{ x: 2, y: 8, t: "O" }, { x: 3, y: 8, t: "O" }, { x: 4, y: 8, t: "O" }, { x: 5, y: 8, t: "O" }, { x: 6, y: 8, t: "O" }, { x: 7, y: 8, t: "O" },
];

// ============================================================================
// Shadow string → pixel array parsing (cached)
// ============================================================================

const _shadowCache = new Map<string, Pixel[]>();

/**
 * Parse a CSS `box-shadow` value into an array of `{x, y, color}` pixels.
 * Understands the `Xpx Ypx 0 <color>` format used in the Bobbit sprites.
 * Results are cached by the raw shadow string.
 */
export function parseShadowToPixels(shadow: string): Pixel[] {
	if (!shadow || !shadow.trim()) return [];
	const cached = _shadowCache.get(shadow);
	if (cached) return cached;

	const pixels: Pixel[] = [];
	for (const part of shadow.split(",")) {
		const m = part.trim().match(/^(-?\d+)px\s+(-?\d+)(?:px)?\s+0(?:px)?\s+(.+)$/);
		if (m) pixels.push({ x: +m[1], y: +m[2], color: m[3].trim() });
	}
	_shadowCache.set(shadow, pixels);
	return pixels;
}

// ============================================================================
// Internal helpers
// ============================================================================

function resolveBody(palette: BobbitPalette, eyeColor?: string): Pixel[] {
	const eye = eyeColor ?? palette.eye;
	const map: Record<Token, string> = { O: "#000000", M: palette.main, L: palette.light, D: palette.dark, E: eye };
	return BODY.map((p) => ({ x: p.x, y: p.y, color: map[p.t] }));
}

// ============================================================================
// JavaScript hue rotation (replaces unreliable ctx.filter)
// ============================================================================

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r: number, g: number, b: number): string {
	return "#" + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
}

/**
 * Rotate the hue of a hex colour by `deg` degrees.
 * Uses the same matrix as CSS hue-rotate().
 */
export function rotateHue(hex: string, deg: number): string {
	if (!deg) return hex;
	const [r, g, b] = parseHex(hex);
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	// CSS hue-rotate matrix (from the Filter Effects spec)
	const m00 = 0.213 + 0.787 * cos - 0.213 * sin;
	const m01 = 0.715 - 0.715 * cos - 0.715 * sin;
	const m02 = 0.072 - 0.072 * cos + 0.928 * sin;
	const m10 = 0.213 - 0.213 * cos + 0.143 * sin;
	const m11 = 0.715 + 0.285 * cos + 0.140 * sin;
	const m12 = 0.072 - 0.072 * cos - 0.283 * sin;
	const m20 = 0.213 - 0.213 * cos - 0.787 * sin;
	const m21 = 0.715 - 0.715 * cos + 0.715 * sin;
	const m22 = 0.072 + 0.928 * cos + 0.072 * sin;
	const nr = Math.min(255, Math.max(0, m00 * r + m01 * g + m02 * b));
	const ng = Math.min(255, Math.max(0, m10 * r + m11 * g + m12 * b));
	const nb = Math.min(255, Math.max(0, m20 * r + m21 * g + m22 * b));
	return toHex(nr, ng, nb);
}

/** Rotate an entire palette's hue. */
function rotatePalette(palette: BobbitPalette, deg: number): BobbitPalette {
	return {
		main: rotateHue(palette.main, deg),
		light: rotateHue(palette.light, deg),
		dark: rotateHue(palette.dark, deg),
		eye: rotateHue(palette.eye, deg),
	};
}

/** Compute the unified bounding box for body (shifted) + optional accessory pixels. */
export function computeBounds(
	bodyYOffset: number,
	accessoryPixels?: Pixel[],
): { minX: number; minY: number; gridW: number; gridH: number } {
	let minX = 0;
	let minY = Math.min(0, bodyYOffset);
	let maxX = 9;
	let maxY = 8 + bodyYOffset;

	if (accessoryPixels) {
		for (const p of accessoryPixels) {
			if (p.x < minX) minX = p.x;
			if (p.x > maxX) maxX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.y > maxY) maxY = p.y;
		}
	}

	return { minX, minY, gridW: maxX - minX + 1, gridH: maxY - minY + 1 };
}

// ============================================================================
// Canvas rendering
// ============================================================================

/**
 * Create a new `<canvas>` and render a Bobbit sprite onto it.
 *
 * The returned canvas has:
 * - CSS `width`/`height` = grid dimensions × `scale`
 * - Buffer dimensions scaled by `devicePixelRatio` for HiDPI
 * - `image-rendering: pixelated` for crisp upscaling
 *
 * The caller typically adds `transform: scale(1.6)` via CSS for sidebar icons.
 */
export function renderBobbitCanvas(options: BobbitCanvasOptions): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	drawToCanvas(canvas, options);
	return canvas;
}

/**
 * Re-render a Bobbit sprite onto an existing canvas (clears + redraws).
 * Used for animation-driven redraws (eye blink, bandana tail) without
 * creating new DOM elements.
 */
export function renderBobbitToCanvas(canvas: HTMLCanvasElement, options: BobbitCanvasOptions): void {
	drawToCanvas(canvas, options);
}

function drawToCanvas(canvas: HTMLCanvasElement, options: BobbitCanvasOptions): void {
	const {
		scale,
		renderScale: renderScaleOpt,
		palette,
		eyeColor,
		accessoryPixels,
		bodyYOffset = 0,
		hueRotate,
		accessoryHueRotate,
	} = options;

	// renderScale controls buffer density; scale controls CSS layout size.
	// When renderScale > scale, the buffer is oversampled so a subsequent CSS
	// transform: scale(renderScale/scale) maps 1:1 to the buffer pixels.
	const rs = renderScaleOpt ?? scale;

	const bodyPixels = resolveBody(palette, eyeColor);
	const bounds = computeBounds(bodyYOffset, accessoryPixels);
	const { minX, minY, gridW, gridH } = bounds;

	// Coordinate shift so all canvas positions are ≥ 0
	const offX = -minX;
	const offY = -minY;

	// CSS layout dimensions use `scale`; buffer uses `renderScale` for density
	const cssW = gridW * scale;
	const cssH = gridH * scale;
	const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
	const bufW = Math.round(gridW * rs * dpr);
	const bufH = Math.round(gridH * rs * dpr);

	if (canvas.width !== bufW || canvas.height !== bufH) {
		canvas.width = bufW;
		canvas.height = bufH;
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
	}
	canvas.style.imageRendering = "pixelated";

	const ctx = canvas.getContext("2d")!;
	ctx.clearRect(0, 0, bufW, bufH);
	ctx.save();
	ctx.scale(dpr * rs, dpr * rs);
	ctx.imageSmoothingEnabled = false;

	// ---- Draw body pixels ----
	// Hue rotation is applied to body colours in JS (not CSS filter) so that
	// accessories can be drawn in their original colours on the same canvas.
	// CSS box-shadow z-order: first-listed = on top.  We draw in reverse
	// so the first-listed pixel is painted last (on top) on the canvas.

	for (let i = bodyPixels.length - 1; i >= 0; i--) {
		const p = bodyPixels[i];
		ctx.fillStyle = hueRotate ? rotateHue(p.color, hueRotate) : p.color;
		ctx.fillRect(p.x + offX, p.y + bodyYOffset + offY, 1, 1);
	}

	// ---- Draw accessory pixels (on top of body) ----
	// Accessories keep their original colours unless accessoryHueRotate is set
	// (e.g. flask rotates with the body).
	if (accessoryPixels && accessoryPixels.length > 0) {
		for (let i = accessoryPixels.length - 1; i >= 0; i--) {
			const p = accessoryPixels[i];
			ctx.fillStyle = (hueRotate && accessoryHueRotate) ? rotateHue(p.color, hueRotate) : p.color;
			ctx.fillRect(p.x + offX, p.y + offY, 1, 1);
		}
	}

	ctx.restore();
}
