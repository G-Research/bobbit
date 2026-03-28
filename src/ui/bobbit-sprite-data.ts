/**
 * Bobbit sprite pixel data — extracted from CSS box-shadow definitions.
 * Pure data module with no side effects.
 */

// ============================================================================
// Types
// ============================================================================

/** Semantic color keys for body pixels — resolved at paint time via palette */
export type ColorKey = 'main' | 'light' | 'dark' | 'eye' | 'outline';

/** A body pixel with a semantic color key */
export interface BodyPixel {
  x: number;
  y: number;
  colorKey: ColorKey;
}

/** A pixel with an absolute hex color (used for accessories) */
export interface Pixel {
  x: number;
  y: number;
  color: string;
}

/** Eye animation state */
export type EyeState =
  | 'center' | 'right' | 'left' | 'up'
  | 'blink-center' | 'blink-right' | 'blink-left' | 'blink-up';

/** An entry in an eye animation schedule */
export interface EyeScheduleEntry {
  pct: number;
  state: EyeState;
}

// ============================================================================
// Palettes
// ============================================================================

/** Default bobbit palette (canonical green) */
export const DEFAULT_PALETTE: Record<ColorKey, string> = {
  main:    '#8ec63f',
  light:   '#b5d98a',
  dark:    '#6b9930',
  eye:     '#1a3010',
  outline: '#000000',
};

/** Starting status palette (yellow) */
export const STARTING_PALETTE: Record<ColorKey, string> = {
  main:    '#eab308',
  light:   '#fde047',
  dark:    '#ca8a04',
  eye:     '#2d2006',
  outline: '#000000',
};

/** Terminated status palette (red) */
export const TERMINATED_PALETTE: Record<ColorKey, string> = {
  main:    '#ef4444',
  light:   '#fca5a5',
  dark:    '#dc2626',
  eye:     '#2c0b0e',
  outline: '#000000',
};

// ============================================================================
// Body Pixel Grid — extracted from .bobbit-blob__sprite box-shadow
// ============================================================================
// The 10×9 body grid with semantic color keys.
// Pixels at eye positions (3,4), (3,5), (6,4), (6,5) are included as 'eye'
// but eyes are painted separately by drawBobbitSprite for animation.

/** Map from hex color to semantic ColorKey */
const COLOR_MAP: Record<string, ColorKey> = {
  '#000':    'outline',
  '#000000': 'outline',
  '#8ec63f': 'main',
  '#b5d98a': 'light',
  '#6b9930': 'dark',
  '#1a3010': 'eye',
};

function c(hex: string): ColorKey {
  return COLOR_MAP[hex] ?? 'outline';
}

/**
 * Body pixels for the 10×9 bobbit sprite.
 * Eye pixels (at center gaze) are included but will be painted over by
 * the eye rendering pass.
 */
export const BODY_PIXELS: BodyPixel[] = [
  // Row 0 (y=0): top edge outline
  { x: 3, y: 0, colorKey: c('#000') },
  { x: 4, y: 0, colorKey: c('#000') },
  { x: 5, y: 0, colorKey: c('#000') },
  { x: 6, y: 0, colorKey: c('#000') },
  { x: 7, y: 0, colorKey: c('#000') },

  // Row 1 (y=1)
  { x: 2, y: 1, colorKey: c('#000') },
  { x: 3, y: 1, colorKey: c('#8ec63f') },
  { x: 4, y: 1, colorKey: c('#8ec63f') },
  { x: 5, y: 1, colorKey: c('#8ec63f') },
  { x: 6, y: 1, colorKey: c('#b5d98a') },
  { x: 7, y: 1, colorKey: c('#b5d98a') },
  { x: 8, y: 1, colorKey: c('#000') },

  // Row 2 (y=2)
  { x: 1, y: 2, colorKey: c('#000') },
  { x: 2, y: 2, colorKey: c('#8ec63f') },
  { x: 3, y: 2, colorKey: c('#8ec63f') },
  { x: 4, y: 2, colorKey: c('#8ec63f') },
  { x: 5, y: 2, colorKey: c('#8ec63f') },
  { x: 6, y: 2, colorKey: c('#8ec63f') },
  { x: 7, y: 2, colorKey: c('#b5d98a') },
  { x: 8, y: 2, colorKey: c('#8ec63f') },
  { x: 9, y: 2, colorKey: c('#000') },

  // Row 3 (y=3)
  { x: 0, y: 3, colorKey: c('#000') },
  { x: 1, y: 3, colorKey: c('#8ec63f') },
  { x: 2, y: 3, colorKey: c('#8ec63f') },
  { x: 3, y: 3, colorKey: c('#8ec63f') },
  { x: 4, y: 3, colorKey: c('#8ec63f') },
  { x: 5, y: 3, colorKey: c('#8ec63f') },
  { x: 6, y: 3, colorKey: c('#8ec63f') },
  { x: 7, y: 3, colorKey: c('#8ec63f') },
  { x: 8, y: 3, colorKey: c('#8ec63f') },
  { x: 9, y: 3, colorKey: c('#000') },

  // Row 4 (y=4) — contains eye pixels
  { x: 0, y: 4, colorKey: c('#000') },
  { x: 1, y: 4, colorKey: c('#8ec63f') },
  { x: 2, y: 4, colorKey: c('#8ec63f') },
  // (3,4) = eye — painted separately
  { x: 4, y: 4, colorKey: c('#8ec63f') },
  { x: 5, y: 4, colorKey: c('#8ec63f') },
  // (6,4) = eye — painted separately
  { x: 7, y: 4, colorKey: c('#8ec63f') },
  { x: 8, y: 4, colorKey: c('#8ec63f') },
  { x: 9, y: 4, colorKey: c('#000') },

  // Row 5 (y=5) — contains eye pixels
  { x: 0, y: 5, colorKey: c('#000') },
  { x: 1, y: 5, colorKey: c('#8ec63f') },
  { x: 2, y: 5, colorKey: c('#8ec63f') },
  // (3,5) = eye — painted separately
  { x: 4, y: 5, colorKey: c('#8ec63f') },
  { x: 5, y: 5, colorKey: c('#8ec63f') },
  // (6,5) = eye — painted separately
  { x: 7, y: 5, colorKey: c('#8ec63f') },
  { x: 8, y: 5, colorKey: c('#8ec63f') },
  { x: 9, y: 5, colorKey: c('#000') },

  // Row 6 (y=6)
  { x: 0, y: 6, colorKey: c('#000') },
  { x: 1, y: 6, colorKey: c('#6b9930') },
  { x: 2, y: 6, colorKey: c('#8ec63f') },
  { x: 3, y: 6, colorKey: c('#8ec63f') },
  { x: 4, y: 6, colorKey: c('#8ec63f') },
  { x: 5, y: 6, colorKey: c('#8ec63f') },
  { x: 6, y: 6, colorKey: c('#8ec63f') },
  { x: 7, y: 6, colorKey: c('#8ec63f') },
  { x: 8, y: 6, colorKey: c('#8ec63f') },
  { x: 9, y: 6, colorKey: c('#000') },

  // Row 7 (y=7)
  { x: 1, y: 7, colorKey: c('#000') },
  { x: 2, y: 7, colorKey: c('#6b9930') },
  { x: 3, y: 7, colorKey: c('#8ec63f') },
  { x: 4, y: 7, colorKey: c('#8ec63f') },
  { x: 5, y: 7, colorKey: c('#8ec63f') },
  { x: 6, y: 7, colorKey: c('#8ec63f') },
  { x: 7, y: 7, colorKey: c('#8ec63f') },
  { x: 8, y: 7, colorKey: c('#000') },

  // Row 8 (y=8) — feet
  { x: 2, y: 8, colorKey: c('#000') },
  { x: 3, y: 8, colorKey: c('#000') },
  { x: 4, y: 8, colorKey: c('#000') },
  { x: 5, y: 8, colorKey: c('#000') },
  { x: 6, y: 8, colorKey: c('#000') },
  { x: 7, y: 8, colorKey: c('#000') },
];

// ============================================================================
// Eye State Positions
// ============================================================================
// Each eye state maps to an array of {x,y} positions for the eye pixels.
// Non-blink states have 4 pixels (2 per eye, 2 rows).
// Blink states have 2 pixels (1 per eye, single row).

export const EYE_STATES: Record<EyeState, { x: number; y: number }[]> = {
  'center':       [{ x: 3, y: 4 }, { x: 3, y: 5 }, { x: 6, y: 4 }, { x: 6, y: 5 }],
  'right':        [{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 5 }],
  'left':         [{ x: 2, y: 4 }, { x: 2, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 5 }],
  'up':           [{ x: 4, y: 3 }, { x: 4, y: 4 }, { x: 7, y: 3 }, { x: 7, y: 4 }],
  'blink-center': [{ x: 3, y: 5 }, { x: 6, y: 5 }],
  'blink-right':  [{ x: 4, y: 5 }, { x: 7, y: 5 }],
  'blink-left':   [{ x: 2, y: 5 }, { x: 5, y: 5 }],
  'blink-up':     [{ x: 4, y: 4 }, { x: 7, y: 4 }],
};

// ============================================================================
// Eye Timing Schedules — extracted from CSS @keyframes
// ============================================================================

/** Busy eye cycle: 10s total (from blob-busy-eyes) */
export const BUSY_EYE_SCHEDULE: EyeScheduleEntry[] = [
  { pct: 0,  state: 'center' },
  { pct: 16, state: 'blink-center' },
  { pct: 18, state: 'center' },
  { pct: 34, state: 'right' },
  { pct: 36, state: 'blink-right' },
  { pct: 37, state: 'right' },
  { pct: 54, state: 'center' },
  { pct: 60, state: 'up' },
  { pct: 64, state: 'blink-up' },
  { pct: 65, state: 'left' },
  { pct: 68, state: 'center' },
  { pct: 92, state: 'blink-center' },
  { pct: 94, state: 'center' },
  { pct: 96, state: 'right' },
  { pct: 98, state: 'center' },
];

/** Idle eye cycle: 10s total (from blob-idle-eyes) */
export const IDLE_EYE_SCHEDULE: EyeScheduleEntry[] = [
  { pct: 0,  state: 'center' },
  { pct: 10, state: 'left' },
  { pct: 22, state: 'blink-left' },
  { pct: 25, state: 'up' },
  { pct: 45, state: 'center' },
  { pct: 55, state: 'right' },
  { pct: 67, state: 'blink-right' },
  { pct: 70, state: 'up' },
  { pct: 85, state: 'center' },
  { pct: 93, state: 'blink-center' },
  { pct: 96, state: 'center' },
];

/** Sidebar selected eye cycle: 6s (from bobbit-eyes in app.css) */
export const SIDEBAR_EYE_SCHEDULE: EyeScheduleEntry[] = [
  { pct: 0,  state: 'center' },
  { pct: 56, state: 'blink-center' },
  { pct: 59, state: 'center' },
  { pct: 74, state: 'right' },
  { pct: 87, state: 'blink-center' },
  { pct: 90, state: 'center' },
];
