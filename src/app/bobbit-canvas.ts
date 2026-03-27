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
	/** Pixel multiplier for canvas drawing (1 = grid-pixel, 2 = picker, 4 = blob). */
	scale: number;
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
		palette,
		eyeColor,
		accessoryPixels,
		bodyYOffset = 0,
		hueRotate,
		accessoryHueRotate,
	} = options;

	const bodyPixels = resolveBody(palette, eyeColor);
	const bounds = computeBounds(bodyYOffset, accessoryPixels);
	const { minX, minY, gridW, gridH } = bounds;

	// Coordinate shift so all canvas positions are ≥ 0
	const offX = -minX;
	const offY = -minY;

	// Canvas dimensions
	const cssW = gridW * scale;
	const cssH = gridH * scale;
	const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
	const bufW = Math.round(cssW * dpr);
	const bufH = Math.round(cssH * dpr);

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
	ctx.scale(dpr * scale, dpr * scale);
	ctx.imageSmoothingEnabled = false;

	// ---- Draw body pixels ----
	// CSS box-shadow z-order: first-listed = on top.  We draw in reverse
	// so the first-listed pixel is painted last (on top) on the canvas.
	const needCounter = !!(hueRotate && hueRotate !== 0);

	for (let i = bodyPixels.length - 1; i >= 0; i--) {
		const p = bodyPixels[i];
		ctx.fillStyle = p.color;
		ctx.fillRect(p.x + offX, p.y + bodyYOffset + offY, 1, 1);
	}

	// ---- Draw accessory pixels (on top of body) ----
	if (accessoryPixels && accessoryPixels.length > 0) {
		if (needCounter && !accessoryHueRotate) {
			ctx.filter = `hue-rotate(${-hueRotate!}deg)`;
		}

		for (let i = accessoryPixels.length - 1; i >= 0; i--) {
			const p = accessoryPixels[i];
			ctx.fillStyle = p.color;
			ctx.fillRect(p.x + offX, p.y + offY, 1, 1);
		}

		if (needCounter && !accessoryHueRotate) {
			ctx.filter = "none";
		}
	}

	ctx.restore();
}
