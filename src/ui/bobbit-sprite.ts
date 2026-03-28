/**
 * Canvas-based bobbit sprite renderer.
 *
 * Replaces CSS box-shadow rasterization with <canvas> + fillRect for
 * crisp rendering at any DPR. CSS animations continue to work on the
 * canvas element for movement, squash/stretch, enter/exit, etc.
 */

import { AsyncDirective, directive } from 'lit/async-directive.js';
import { noChange } from 'lit';
import type { ElementPart } from 'lit/directive.js';

import { ACCESSORIES, getAccessory } from '../app/session-colors.js';
import {
  type BodyPixel,
  type ColorKey,
  type EyeScheduleEntry,
  type EyeState,
  type Pixel,
  BODY_PIXELS,
  DEFAULT_PALETTE,
  EYE_STATES,
  SIDEBAR_EYE_SCHEDULE,
} from './bobbit-sprite-data.js';

// Re-export types for downstream consumers
export type { BodyPixel, ColorKey, EyeScheduleEntry, EyeState, Pixel };
export {
  BODY_PIXELS,
  DEFAULT_PALETTE,
  EYE_STATES,
  BUSY_EYE_SCHEDULE,
  IDLE_EYE_SCHEDULE,
  SIDEBAR_EYE_SCHEDULE,
  STARTING_PALETTE,
  TERMINATED_PALETTE,
} from './bobbit-sprite-data.js';

// ============================================================================
// parseBoxShadow — convert CSS box-shadow strings to Pixel arrays
// ============================================================================

/**
 * Parse a CSS box-shadow string into an array of {x, y, color} pixels.
 * Handles the format used by bobbit accessories: "Xpx Ypx 0 #color, ..."
 * Coordinates can be negative. Colors can be #rgb, #rrggbb, or named.
 */
export function parseBoxShadow(shadow: string): Pixel[] {
  if (!shadow || !shadow.trim()) return [];
  const pixels: Pixel[] = [];
  // Split on commas, handling potential whitespace
  const parts = shadow.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Match: Xpx Ypx 0 color  OR  Xpx Ypx 0px color
    // Also handle: X Ypx 0 color (0 without px)
    const match = trimmed.match(
      /^(-?\d+)(?:px)?\s+(-?\d+)(?:px)?\s+\d+(?:px)?\s+(#[0-9a-fA-F]{3,8}|\w+)$/
    );
    if (match) {
      pixels.push({
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        color: match[3],
      });
    }
  }
  return pixels;
}

// ============================================================================
// ACCESSORY_PIXELS — parsed once at module load
// ============================================================================

/** Pre-parsed accessory pixel data, keyed by accessory ID */
export const ACCESSORY_PIXELS: Record<string, Pixel[]> = {};

// Parse all accessory shadows into pixel arrays at module load time
for (const [id, def] of Object.entries(ACCESSORIES)) {
  if (def.shadow) {
    ACCESSORY_PIXELS[id] = parseBoxShadow(def.shadow);
  }
}

// ============================================================================
// Color utilities
// ============================================================================

/** Convert a hex color (#rgb or #rrggbb) to {h, s, l} (h in degrees, s/l in 0-1) */
function hexToHSL(hex: string): { h: number; s: number; l: number } {
  // Expand shorthand #rgb → #rrggbb
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let hue: number;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / d + 2) / 6;
  else hue = ((r - g) / d + 4) / 6;

  return { h: hue * 360, s, l };
}

/** Convert HSL (h in degrees, s/l in 0-1) to hex string #rrggbb */
function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hNorm = h / 360;
    r = hue2rgb(p, q, hNorm + 1 / 3);
    g = hue2rgb(p, q, hNorm);
    b = hue2rgb(p, q, hNorm - 1 / 3);
  }

  const toHex = (v: number) => {
    const hex = Math.round(v * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Rotate a hex color's hue by -degrees to cancel a CSS hue-rotate(degrees).
 * Converts hex → HSL, subtracts hue, converts back to hex.
 */
export function counterHueRotate(hexColor: string, degrees: number): string {
  const { h, s, l } = hexToHSL(hexColor);
  const newH = ((h - degrees) % 360 + 360) % 360;
  return hslToHex(newH, s, l);
}

// ============================================================================
// DPR change listener
// ============================================================================

/** Current DPR — updated on monitor changes */
let currentDpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

/** Listeners notified when DPR changes (e.g. window moved between monitors) */
export const dprListeners = new Set<() => void>();

/** Register a callback for DPR changes. Returns an unregister function. */
export function onDprChange(listener: () => void): () => void {
  dprListeners.add(listener);
  return () => dprListeners.delete(listener);
}

function watchDpr() {
  if (typeof window === 'undefined') return;
  const mq = window.matchMedia(`(resolution: ${currentDpr}dppx)`);
  mq.addEventListener('change', () => {
    currentDpr = window.devicePixelRatio;
    for (const listener of dprListeners) listener();
    watchDpr();
  }, { once: true });
}
watchDpr();

// ============================================================================
// drawBobbitSprite
// ============================================================================

/** Options for drawBobbitSprite */
export interface SpriteOptions {
  /** Current eye animation state */
  eyeState: EyeState;
  /** CSS pixel size per sprite pixel (default: 4 for chat, 1.6 for sidebar) */
  scale?: number;
  /** devicePixelRatio override (default: window.devicePixelRatio) */
  dpr?: number;
  /** Override palette colors (for starting/terminated status) */
  colors?: Partial<Record<ColorKey, string>>;
  /** Accessory ID from registry (e.g. "crown", "bandana") */
  accessory?: string;
  /** Hue rotation in degrees — used to counter-rotate accessory colors */
  hueRotate?: number;
  /** Whether eyes should use main color instead of eye color (selected state) */
  selected?: boolean;
  /** Whether this is an animated sprite (eyes tick automatically) */
  animated?: boolean;
  /** Eye schedule for animated sprites */
  schedule?: EyeScheduleEntry[];
  /** Cycle duration in ms for animated sprites */
  cycleDuration?: number;
  /** Eye animation offset in ms — staggers multiple blobs so they don't blink in sync */
  eyeDelay?: number;
  /**
   * When set, use this value (instead of DPR-derived size) for the canvas CSS
   * display dimensions. Each sprite pixel maps to `cssScale` CSS pixels.
   * Use cssScale=1 for chat blobs where CSS `transform: scale(4)` handles
   * the visual scaling — the canvas must be exactly gridW×gridH CSS pixels
   * regardless of DPR, so the CSS transform produces deterministic results.
   */
  cssScale?: number;
}

/**
 * Paint the bobbit sprite onto a canvas: body, eyes, and optional accessory.
 * The canvas is sized to fit the sprite at the given scale × DPR, with
 * integer device pixels per sprite pixel for crisp rendering.
 */
export function drawBobbitSprite(canvas: HTMLCanvasElement, opts: SpriteOptions): void {
  const scale = opts.scale ?? 4;
  const dpr = opts.dpr ?? currentDpr;
  const pxSize = Math.max(1, Math.round(scale * dpr));

  // Compute canvas bounds including accessory overflow
  const acc = opts.accessory ? ACCESSORY_PIXELS[opts.accessory] : null;
  const accDef = opts.accessory ? getAccessory(opts.accessory) : null;

  // Body grid is 10×9 at (0,0)-(9,8). Accessories can extend beyond.
  let minX = 0, minY = 0, maxX = 9, maxY = 8;
  if (acc) {
    for (const p of acc) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const gridW = maxX - minX + 1;
  const gridH = maxY - minY + 1;
  const width = gridW * pxSize;
  const height = gridH * pxSize;
  const offsetX = -minX;
  const offsetY = -minY;

  // Only resize if dimensions changed (avoid expensive canvas reset)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    // When cssScale is provided (e.g. chat blob with CSS transform: scale(4)),
    // use deterministic CSS sizing independent of DPR. Otherwise use DPR-derived sizing.
    const cssScale = opts.cssScale;
    if (cssScale != null) {
      canvas.style.width = `${gridW * cssScale}px`;
      canvas.style.height = `${gridH * cssScale}px`;
    } else {
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    }
  }

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);

  // Resolve palette
  const palette: Record<ColorKey, string> = { ...DEFAULT_PALETTE, ...opts.colors };

  // Paint body pixels
  for (const pixel of BODY_PIXELS) {
    ctx.fillStyle = palette[pixel.colorKey];
    ctx.fillRect(
      (pixel.x + offsetX) * pxSize,
      (pixel.y + offsetY) * pxSize,
      pxSize,
      pxSize,
    );
  }

  // Paint eyes based on current state
  const eyePixels = EYE_STATES[opts.eyeState];
  const eyeColor = opts.selected ? palette.main : palette.eye;
  ctx.fillStyle = eyeColor;
  for (const pos of eyePixels) {
    ctx.fillRect(
      (pos.x + offsetX) * pxSize,
      (pos.y + offsetY) * pxSize,
      pxSize,
      pxSize,
    );
  }

  // Paint accessory pixels (if any)
  if (acc && acc.length > 0) {
    const hueRotate = opts.hueRotate ?? 0;
    for (const pixel of acc) {
      // Counter-rotate accessory colors to cancel the parent's CSS hue-rotate
      // (except flask, which intentionally rotates with the bobbit)
      const color = (hueRotate !== 0 && accDef?.id !== 'flask')
        ? counterHueRotate(pixel.color, hueRotate)
        : pixel.color;
      ctx.fillStyle = color;
      ctx.fillRect(
        (pixel.x + offsetX) * pxSize,
        (pixel.y + offsetY) * pxSize,
        pxSize,
        pxSize,
      );
    }
  }
}

// ============================================================================
// BobbitEyeTimer — JS-driven eye animation replacing CSS keyframes
// ============================================================================

/**
 * Drives eye animation state changes via requestAnimationFrame.
 * Replaces CSS step-keyframe animations for eyes.
 */
export class BobbitEyeTimer {
  private _raf = 0;
  private _startTime = 0;
  private _schedule: EyeScheduleEntry[] = [];
  private _cycleDuration = 10000;
  private _currentState: EyeState = 'center';
  private _onStateChange: (state: EyeState) => void;
  private _offset = 0;

  constructor(onStateChange: (state: EyeState) => void) {
    this._onStateChange = onStateChange;
  }

  /**
   * Start (or restart) the animation loop.
   * Cancels any previously-running loop before beginning a new one.
   */
  start(schedule: EyeScheduleEntry[], cycleDurationMs: number, offset = 0): void {
    this.stop();
    this._schedule = schedule;
    this._cycleDuration = cycleDurationMs;
    this._startTime = performance.now();
    this._offset = offset;
    this._currentState = 'center';
    this._tick();
  }

  private _tick = (): void => {
    const elapsed = (performance.now() - this._startTime + this._offset) % this._cycleDuration;
    const pct = (elapsed / this._cycleDuration) * 100;

    // Find current state from schedule (last entry where pct >= entry.pct)
    let state = this._schedule[0]?.state ?? 'center';
    for (const entry of this._schedule) {
      if (pct >= entry.pct) state = entry.state;
      else break;
    }

    if (state !== this._currentState) {
      this._currentState = state;
      this._onStateChange(state);
    }

    this._raf = requestAnimationFrame(this._tick);
  };

  /** Stop the animation loop. Safe to call multiple times. */
  stop(): void {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  /** Get current eye state without waiting for next tick */
  get currentState(): EyeState {
    return this._currentState;
  }

}

// ============================================================================
// bobbitSprite — Lit AsyncDirective for declarative canvas rendering
// ============================================================================

/**
 * Lit directive for rendering a bobbit sprite on a <canvas> element.
 * Manages eye animation timer and DPR change listener.
 *
 * Usage:
 * ```ts
 * html`<canvas ${bobbitSprite({ eyeState: 'center', scale: 1.6, animated: true })}></canvas>`
 * ```
 */
class BobbitSpriteDirective extends AsyncDirective {
  private _timer: BobbitEyeTimer | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _opts: SpriteOptions = { eyeState: 'center' };
  private _unsubDpr: (() => void) | null = null;

  override update(part: ElementPart, [opts]: [SpriteOptions]) {
    this._opts = opts;
    this._canvas = part.element as HTMLCanvasElement;
    this._draw();

    // Manage eye timer based on animated flag
    if (opts.animated && !this._timer) {
      this._timer = new BobbitEyeTimer((state) => {
        this._opts = { ...this._opts, eyeState: state };
        this._draw();
      });
      this._timer.start(
        opts.schedule ?? SIDEBAR_EYE_SCHEDULE,
        opts.cycleDuration ?? 6000,
        opts.eyeDelay ?? 0,
      );
      // Subscribe to DPR changes (unsubscribe previous first to avoid leak)
      this._unsubDpr?.();
      this._unsubDpr = onDprChange(() => this._draw());
    } else if (!opts.animated && this._timer) {
      this._timer.stop();
      this._timer = null;
      this._unsubDpr?.();
      this._unsubDpr = null;
    } else if (opts.animated && this._timer) {
      // Update schedule if changed (e.g. switching between busy/idle)
      // Timer is already running, just update opts
    }

    // If not animated, still handle DPR changes
    if (!opts.animated) {
      if (!this._unsubDpr) {
        this._unsubDpr = onDprChange(() => this._draw());
      }
    }

    return noChange;
  }

  render(_opts: SpriteOptions) {
    return noChange;
  }

  private _draw() {
    if (this._canvas) {
      drawBobbitSprite(this._canvas, this._opts);
    }
  }

  override disconnected() {
    this._timer?.stop();
    this._timer = null;
    this._unsubDpr?.();
    this._unsubDpr = null;
  }

  override reconnected() {
    if (this._opts.animated) {
      this._timer = new BobbitEyeTimer((state) => {
        this._opts = { ...this._opts, eyeState: state };
        this._draw();
      });
      this._timer.start(
        this._opts.schedule ?? SIDEBAR_EYE_SCHEDULE,
        this._opts.cycleDuration ?? 6000,
        this._opts.eyeDelay ?? 0,
      );
    }
    this._unsubDpr = onDprChange(() => this._draw());
    this._draw();
  }
}

export const bobbitSprite = directive(BobbitSpriteDirective);
