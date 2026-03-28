/**
 * Canonical pixel data for all bobbit sprites.
 *
 * This file contains ONLY data — no rendering logic. It is the single source
 * of truth for the bobbit body grid, eye positions, eye animation sequences,
 * accessory pixel art, and shadow animation data.
 *
 * All coordinate systems use the sidebar bobbit as canonical (CSS box-shadow
 * coords from session-colors.ts). The `blobYAdjust` field on accessories
 * indicates the Y-axis delta when rendering in the blob context.
 */

// ============================================================================
// TYPES
// ============================================================================

/** Palette color key for body pixels. '_' = transparent, K = outline, M = main, L = light, D = dark */
export type PaletteKey = '_' | 'K' | 'M' | 'L' | 'D';

/** A resolved pixel with absolute coordinates and hex color */
export type SpritePixel = [x: number, y: number, color: string];

/** Eye gaze direction */
export type EyeGaze = 'center' | 'right' | 'left' | 'up-right';

/** Single frame in an eye animation sequence */
export interface EyeFrame {
  pct: number;
  gaze: EyeGaze;
  blink: boolean;
}

/** Shadow pixel with alpha */
export type ShadowPixel = [x: number, y: number, alpha: number];

/** Single frame in the ground shadow animation */
export interface ShadowFrame {
  pct: number;
  pixels: ShadowPixel[];
}

/** Accessory metadata and pixel data */
export interface AccessorySpriteData {
  /** Unique identifier (matches session-colors.ts key) */
  id: string;
  /** Human-readable label */
  label: string;
  /** Pixel data in sidebar coordinates */
  pixels: SpritePixel[];
  /** Vertical offset in sidebar coordinate space */
  yOffset: number;
  /** Whether this accessory adds height above the sprite (e.g. crown, wizard hat) */
  addsHeight: boolean;
  /** Y-axis delta when rendering in blob context vs sidebar context */
  blobYAdjust: number;
}

// ============================================================================
// BODY GRID
// ============================================================================

/**
 * 10 wide × 9 tall body grid using palette keys.
 * Eyes are NOT in the grid — they are overlaid separately via EYE_POSITIONS.
 *
 * Key:  '_' = transparent (no pixel)
 *       'K' = outline (#000 black)
 *       'M' = main body color
 *       'L' = light highlight
 *       'D' = dark shadow
 */
export const BODY_GRID: PaletteKey[][] = [
  ['_','_','_','K','K','K','K','K','_','_'],       // row 0
  ['_','_','K','M','M','M','L','L','K','_'],       // row 1
  ['_','K','M','M','M','M','M','L','M','K'],       // row 2
  ['K','M','M','M','M','M','M','M','M','K'],       // row 3
  ['K','M','M','M','M','M','M','M','M','K'],       // row 4 (eye row 1)
  ['K','M','M','M','M','M','M','M','M','K'],       // row 5 (eye row 2)
  ['K','D','M','M','M','M','M','M','M','K'],       // row 6
  ['_','K','D','M','M','M','M','M','K','_'],       // row 7
  ['_','_','K','K','K','K','K','K','_','_'],       // row 8
];

export const BODY_WIDTH = 10;
export const BODY_HEIGHT = 9;

// ============================================================================
// EYE POSITIONS
// ============================================================================

/**
 * Eye positions for each gaze direction.
 * Each eye is 1px wide × 2px tall.
 * lx/ly = left eye top pixel, rx/ry = right eye top pixel.
 */
export const EYE_POSITIONS: Record<EyeGaze, { lx: number; ly: number; rx: number; ry: number }> = {
  'center':    { lx: 3, ly: 4, rx: 6, ry: 4 },
  'right':     { lx: 4, ly: 4, rx: 7, ry: 4 },
  'left':      { lx: 2, ly: 4, rx: 5, ry: 4 },
  'up-right':  { lx: 4, ly: 3, rx: 7, ry: 3 },
};

// ============================================================================
// EYE ANIMATION SEQUENCES
// ============================================================================

/**
 * Eye animation for the busy (streaming) state.
 * Driven by blob-busy-eyes keyframes. ~10s cycle.
 * Each frame specifies the percentage through the cycle, gaze direction,
 * and whether the eyes are closed (blink).
 */
export const BUSY_EYE_SEQUENCE: EyeFrame[] = [
  { pct: 0,  gaze: 'center',   blink: false },
  { pct: 16, gaze: 'center',   blink: true  },
  { pct: 18, gaze: 'center',   blink: false },
  { pct: 34, gaze: 'right',    blink: false },
  { pct: 36, gaze: 'right',    blink: true  },
  { pct: 37, gaze: 'right',    blink: false },
  { pct: 54, gaze: 'center',   blink: false },
  { pct: 60, gaze: 'up-right', blink: false },
  { pct: 64, gaze: 'up-right', blink: true  },
  { pct: 65, gaze: 'left',     blink: false },
  { pct: 68, gaze: 'center',   blink: false },
  { pct: 92, gaze: 'center',   blink: true  },
  { pct: 94, gaze: 'center',   blink: false },
  { pct: 96, gaze: 'right',    blink: false },
  { pct: 98, gaze: 'center',   blink: false },
];

/**
 * Eye animation for the idle state. 10s cycle.
 * Slower, more relaxed movement pattern.
 */
export const IDLE_EYE_SEQUENCE: EyeFrame[] = [
  { pct: 0,  gaze: 'center',   blink: false },
  { pct: 10, gaze: 'left',     blink: false },
  { pct: 22, gaze: 'left',     blink: true  },
  { pct: 25, gaze: 'up-right', blink: false },
  { pct: 45, gaze: 'center',   blink: false },
  { pct: 55, gaze: 'right',    blink: false },
  { pct: 67, gaze: 'right',    blink: true  },
  { pct: 70, gaze: 'up-right', blink: false },
  { pct: 80, gaze: 'center',   blink: false },
  { pct: 90, gaze: 'center',   blink: true  },
  { pct: 95, gaze: 'center',   blink: false },
];

// ============================================================================
// ACCESSORIES
// ============================================================================

/**
 * Crown accessory — gold crown with jewel, sits above the head.
 * Sidebar coordinates (yOffset=2, addsHeight=true).
 * In blob context, the crown is shifted up by 1px (blobYAdjust=-1).
 */
export const ACCESSORY_CROWN: AccessorySpriteData = {
  id: 'crown',
  label: 'Crown',
  yOffset: 2,
  addsHeight: true,
  blobYAdjust: -1,
  pixels: [
    // Row -1: crown tips (outline)
    [3, -1, '#000'], [5, -1, '#000'], [7, -1, '#000'],
    // Row 0: crown points (gold + outline)
    [2, 0, '#000'], [3, 0, '#fef08a'], [4, 0, '#000'], [5, 0, '#fef08a'], [6, 0, '#000'], [7, 0, '#fef08a'], [8, 0, '#000'],
    // Row 1: crown body (gold + red jewel)
    [1, 1, '#000'], [2, 1, '#fde047'], [3, 1, '#fef08a'], [4, 1, '#fde047'], [5, 1, '#ef4444'], [6, 1, '#fde047'], [7, 1, '#fef08a'], [8, 1, '#fde047'], [9, 1, '#000'],
    // Row 2: crown band (dark gold)
    [1, 2, '#000'], [2, 2, '#ca8a04'], [3, 2, '#eab308'], [4, 2, '#eab308'], [5, 2, '#eab308'], [6, 2, '#eab308'], [7, 2, '#eab308'], [8, 2, '#ca8a04'], [9, 2, '#000'],
    // Row 3: crown base (outline)
    [1, 3, '#000'], [2, 3, '#000'], [3, 3, '#000'], [4, 3, '#000'], [5, 3, '#000'], [6, 3, '#000'], [7, 3, '#000'], [8, 3, '#000'], [9, 3, '#000'],
  ],
};

/**
 * Bandana accessory — red headband with tail on the right.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_BANDANA: AccessorySpriteData = {
  id: 'bandana',
  label: 'Bandana',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 2: top outline
    [1, 2, '#000'], [2, 2, '#000'], [3, 2, '#000'], [4, 2, '#000'], [5, 2, '#000'], [6, 2, '#000'], [7, 2, '#000'], [8, 2, '#000'], [9, 2, '#000'],
    // Row 3: bandana band (red gradient)
    [0, 3, '#000'], [1, 3, '#b91c1c'], [2, 3, '#dc2626'], [3, 3, '#ef4444'], [4, 3, '#ef4444'], [5, 3, '#ef4444'], [6, 3, '#ef4444'], [7, 3, '#ef4444'], [8, 3, '#f87171'], [9, 3, '#000'],
    // Row 4: bottom outline
    [0, 4, '#000'], [1, 4, '#000'], [2, 4, '#000'], [3, 4, '#000'], [4, 4, '#000'], [5, 4, '#000'], [6, 4, '#000'], [7, 4, '#000'], [8, 4, '#000'], [9, 4, '#000'],
    // Tail (dangling right side)
    [10, 3, '#000'],
    [10, 4, '#b91c1c'], [11, 4, '#000'],
    [10, 5, '#991b1b'], [11, 5, '#000'],
    [10, 6, '#000'],
  ],
};

/**
 * Magnifying glass accessory — held on the right side.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_MAGNIFIER: AccessorySpriteData = {
  id: 'magnifier',
  label: 'Magnifying Glass',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 2: lens top outline
    [8, 2, '#000'], [9, 2, '#000'], [10, 2, '#000'],
    // Row 3: lens top
    [7, 3, '#000'], [8, 3, '#87ceeb'], [9, 3, '#b0e0f0'], [10, 3, '#87ceeb'], [11, 3, '#000'],
    // Row 4: lens middle (highlight)
    [7, 4, '#000'], [8, 4, '#b0e0f0'], [9, 4, '#e0f4ff'], [10, 4, '#87ceeb'], [11, 4, '#000'],
    // Row 5: lens bottom
    [7, 5, '#000'], [8, 5, '#87ceeb'], [9, 5, '#b0e0f0'], [10, 5, '#87ceeb'], [11, 5, '#000'],
    // Row 6: lens bottom outline
    [7, 6, '#000'], [8, 6, '#000'], [9, 6, '#000'], [10, 6, '#000'],
    // Row 7: handle upper
    [6, 7, '#000'], [7, 7, '#8b4513'],
    // Row 8: handle lower
    [5, 8, '#000'], [6, 8, '#8b4513'],
  ],
};

/**
 * Paint palette accessory — held on the lower right.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_PALETTE: AccessorySpriteData = {
  id: 'palette',
  label: 'Paint Palette',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 5: top outline
    [9, 5, '#000'], [10, 5, '#000'],
    // Row 6: top row (brown + red blob)
    [8, 6, '#000'], [9, 6, '#a16207'], [10, 6, '#ef4444'], [11, 6, '#000'],
    // Row 7: middle row (green blob + brown)
    [7, 7, '#000'], [8, 7, '#4ade80'], [9, 7, '#a16207'], [10, 7, '#a16207'], [11, 7, '#000'],
    // Row 8: bottom row (brown + blue blob)
    [7, 8, '#000'], [8, 8, '#a16207'], [9, 8, '#a16207'], [10, 8, '#60a5fa'], [11, 8, '#000'],
    // Row 9: bottom outline
    [8, 9, '#000'], [9, 9, '#000'], [10, 9, '#000'],
  ],
};

/**
 * Pencil accessory — diagonal pencil held upper right.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 * In blob context, the pencil is shifted up by 1px (blobYAdjust=-1).
 */
export const ACCESSORY_PENCIL: AccessorySpriteData = {
  id: 'pencil',
  label: 'Pencil',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: -1,
  pixels: [
    // Row 3: eraser top (outline)
    [10, 3, '#000'], [11, 3, '#000'],
    // Row 4: eraser body (pink)
    [9, 4, '#000'], [10, 4, '#f9a8d4'], [11, 4, '#ec4899'], [12, 4, '#000'],
    // Row 5: ferrule (silver band)
    [8, 5, '#000'], [9, 5, '#9ca3af'], [10, 5, '#d1d5db'], [11, 5, '#000'],
    // Row 6: yellow body upper
    [7, 6, '#000'], [8, 6, '#fde047'], [9, 6, '#fbbf24'], [10, 6, '#000'],
    // Row 7: yellow body lower
    [6, 7, '#000'], [7, 7, '#fde047'], [8, 7, '#fbbf24'], [9, 7, '#000'],
    // Row 8: wood (exposed)
    [5, 8, '#000'], [6, 8, '#f4a460'], [7, 8, '#cd853f'], [8, 8, '#000'],
    // Row 9: graphite tip
    [4, 9, '#000'], [5, 9, '#4b5563'], [6, 9, '#000'],
  ],
};

/**
 * Shield accessory — held on the right side.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_SHIELD: AccessorySpriteData = {
  id: 'shield',
  label: 'Shield',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 3: top outline
    [8, 3, '#000'], [9, 3, '#000'], [10, 3, '#000'], [11, 3, '#000'], [12, 3, '#000'],
    // Row 4: upper body
    [7, 4, '#000'], [8, 4, '#9ca3af'], [9, 4, '#d1d5db'], [10, 4, '#d1d5db'], [11, 4, '#9ca3af'], [12, 4, '#000'],
    // Row 5: middle body (with red emblem)
    [7, 5, '#000'], [8, 5, '#d1d5db'], [9, 5, '#f3f4f6'], [10, 5, '#ef4444'], [11, 5, '#d1d5db'], [12, 5, '#000'],
    // Row 6: lower body
    [7, 6, '#000'], [8, 6, '#9ca3af'], [9, 6, '#d1d5db'], [10, 6, '#d1d5db'], [11, 6, '#9ca3af'], [12, 6, '#000'],
    // Row 7: bottom taper
    [8, 7, '#000'], [9, 7, '#9ca3af'], [10, 7, '#9ca3af'], [11, 7, '#000'],
    // Row 8: bottom point
    [9, 8, '#000'], [10, 8, '#000'],
  ],
};

/**
 * Set square (triangle ruler) accessory — held on the lower right.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_SET_SQUARE: AccessorySpriteData = {
  id: 'set-square',
  label: 'Set Square',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 4: top point
    [10, 4, '#000'],
    // Row 5
    [9, 5, '#000'], [10, 5, '#93c5fd'], [11, 5, '#000'],
    // Row 6
    [8, 6, '#000'], [9, 6, '#bfdbfe'], [10, 6, '#93c5fd'], [11, 6, '#000'],
    // Row 7 (with cutout)
    [7, 7, '#000'], [8, 7, '#bfdbfe'], [9, 7, '#000'], [10, 7, '#bfdbfe'], [11, 7, '#000'],
    // Row 8
    [6, 8, '#000'], [7, 8, '#bfdbfe'], [8, 8, '#bfdbfe'], [9, 8, '#bfdbfe'], [10, 8, '#93c5fd'], [11, 8, '#000'],
    // Row 9: base outline
    [5, 9, '#000'], [6, 9, '#000'], [7, 9, '#000'], [8, 9, '#000'], [9, 9, '#000'], [10, 9, '#000'], [11, 9, '#000'],
  ],
};

/**
 * Flask (Erlenmeyer) accessory — held on the right side.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 */
export const ACCESSORY_FLASK: AccessorySpriteData = {
  id: 'flask',
  label: 'Flask',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Row 4: flask mouth
    [8, 4, '#000'], [9, 4, '#fff'], [10, 4, '#000'],
    // Row 5: flask neck
    [8, 5, '#000'], [9, 5, '#7dd3fc'], [10, 5, '#000'],
    // Row 6: flask body upper
    [7, 6, '#000'], [8, 6, '#0369a1'], [9, 6, '#38bdf8'], [10, 6, '#0ea5e9'], [11, 6, '#000'],
    // Row 7: flask body middle
    [6, 7, '#000'], [7, 7, '#1e3a5f'], [8, 7, '#0ea5e9'], [9, 7, '#0284c7'], [10, 7, '#0369a1'], [11, 7, '#1e3a5f'], [12, 7, '#000'],
    // Row 8: flask body lower (darker liquid)
    [6, 8, '#000'], [7, 8, '#1e3a5f'], [8, 8, '#0284c7'], [9, 8, '#0c4a6e'], [10, 8, '#082f49'], [11, 8, '#1e3a5f'], [12, 8, '#000'],
    // Row 9: flask base outline
    [6, 9, '#000'], [7, 9, '#000'], [8, 9, '#000'], [9, 9, '#000'], [10, 9, '#000'], [11, 9, '#000'], [12, 9, '#000'],
  ],
};

/**
 * Wizard hat accessory — purple wizard/witch hat with stars.
 * Sidebar coordinates (yOffset=2, addsHeight=true).
 */
export const ACCESSORY_WIZARD_HAT: AccessorySpriteData = {
  id: 'wizard-hat',
  label: 'Wizard Hat',
  yOffset: 2,
  addsHeight: true,
  blobYAdjust: 0,
  pixels: [
    // Row -2: hat tip decorations (teal + yellow stars)
    [7, -2, '#2dd4bf'], [8, -2, '#fde047'],
    // Row -1: hat tip body
    [5, -1, '#000'], [6, -1, '#6366f1'], [7, -1, '#818cf8'], [8, -1, '#000'],
    // Row 0: hat mid-section
    [2, 0, '#000'], [3, 0, '#6d28d9'], [4, 0, '#7c3aed'], [5, 0, '#8b5cf6'], [6, 0, '#6366f1'], [7, 0, '#a78bfa'], [8, 0, '#000'],
    // Row 1: hat body (with star + moon decorations)
    [1, 1, '#000'], [2, 1, '#6d28d9'], [3, 1, '#7c3aed'], [4, 1, '#fbbf24'], [5, 1, '#fde047'], [6, 1, '#14b8a6'], [7, 1, '#a78bfa'], [8, 1, '#6d28d9'], [9, 1, '#000'],
    // Row 2: hat brim (outline)
    [0, 2, '#000'], [1, 2, '#000'], [2, 2, '#000'], [3, 2, '#000'], [4, 2, '#000'], [5, 2, '#000'], [6, 2, '#000'], [7, 2, '#000'], [8, 2, '#000'], [9, 2, '#000'], [10, 2, '#000'],
  ],
};

/**
 * Wand accessory — magic wand with star sparkle.
 * Sidebar coordinates (yOffset=0, addsHeight=false).
 *
 * Note: In the CSS box-shadow source, some pixels are defined twice (sparkle
 * outline then handle). Later entries override earlier ones. The pixel array
 * below reflects the final rendered result.
 */
export const ACCESSORY_WAND: AccessorySpriteData = {
  id: 'wand',
  label: 'Wand',
  yOffset: 0,
  addsHeight: false,
  blobYAdjust: 0,
  pixels: [
    // Sparkle outline
    [11, 2, '#000'],
    [10, 3, '#000'], [12, 3, '#000'],
    [9, 4, '#000'], [13, 4, '#000'],
    [12, 5, '#000'],
    [11, 6, '#000'],
    // Star body
    [11, 3, '#fef9c4'],
    [10, 4, '#fde047'], [11, 4, '#fff'], [12, 4, '#fde047'],
    [11, 5, '#fef9c4'],
    // Handle (overrides sparkle outline at (10,5))
    [9, 5, '#000'], [10, 5, '#cd853f'],
    [8, 6, '#000'], [9, 6, '#cd853f'], [10, 6, '#000'],
    [7, 7, '#000'], [8, 7, '#8b4513'], [9, 7, '#000'],
    [6, 8, '#000'], [7, 8, '#8b4513'], [8, 8, '#000'],
    [5, 9, '#000'], [6, 9, '#000'],
  ],
};

/** Registry of all accessories by ID */
export const ACCESSORIES: Record<string, AccessorySpriteData> = {
  'crown':       ACCESSORY_CROWN,
  'bandana':     ACCESSORY_BANDANA,
  'magnifier':   ACCESSORY_MAGNIFIER,
  'palette':     ACCESSORY_PALETTE,
  'pencil':      ACCESSORY_PENCIL,
  'shield':      ACCESSORY_SHIELD,
  'set-square':  ACCESSORY_SET_SQUARE,
  'flask':       ACCESSORY_FLASK,
  'wizard-hat':  ACCESSORY_WIZARD_HAT,
  'wand':        ACCESSORY_WAND,
};

/** All accessory IDs (excluding "none") */
export const ACCESSORY_IDS = Object.keys(ACCESSORIES);

// ============================================================================
// SHADOW DATA
// ============================================================================

/** Static shadow at rest position (below the body, row 9) */
export const SHADOW_REST: ShadowPixel[] = [
  [2, 9, 0.08], [3, 9, 0.15], [4, 9, 0.22], [5, 9, 0.25], [6, 9, 0.22], [7, 9, 0.15], [8, 9, 0.08],
];

/**
 * Shadow animation frames for the busy (streaming/bouncing) state.
 * Shadow expands/contracts as the blob bounces up and down.
 */
export const SHADOW_BUSY_FRAMES: ShadowFrame[] = [
  { pct: 0,   pixels: [[2,9,0.08],[3,9,0.15],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.15],[8,9,0.08]] },
  { pct: 8,   pixels: [[1,9,0.06],[2,9,0.12],[3,9,0.18],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.18],[8,9,0.12],[9,9,0.06]] },
  { pct: 18,  pixels: [[3,9,0.06],[4,9,0.10],[5,9,0.12],[6,9,0.10],[7,9,0.06],[4,10,0.04],[5,10,0.06],[6,10,0.04]] },
  { pct: 30,  pixels: [[4,9,0.05],[5,9,0.08],[6,9,0.05],[4,10,0.03],[5,10,0.05],[6,10,0.03]] },
  { pct: 38,  pixels: [[4,9,0.05],[5,9,0.08],[6,9,0.05],[4,10,0.03],[5,10,0.05],[6,10,0.03]] },
  { pct: 48,  pixels: [[3,9,0.06],[4,9,0.10],[5,9,0.12],[6,9,0.10],[7,9,0.06],[4,10,0.04],[5,10,0.06],[6,10,0.04]] },
  { pct: 55,  pixels: [[1,9,0.06],[2,9,0.12],[3,9,0.18],[4,9,0.22],[5,9,0.28],[6,9,0.22],[7,9,0.18],[8,9,0.12],[9,9,0.06]] },
  { pct: 65,  pixels: [[3,9,0.08],[4,9,0.15],[5,9,0.18],[6,9,0.15],[7,9,0.08]] },
  { pct: 73,  pixels: [[2,9,0.08],[3,9,0.15],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.15],[8,9,0.08]] },
  { pct: 100, pixels: [[2,9,0.08],[3,9,0.15],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.15],[8,9,0.08]] },
];

/**
 * Shadow animation frames for the compact (squashing) state.
 * Shadow widens as the blob squashes down, then returns to rest.
 * Derived from @keyframes blob-compact-shadow in app.css.
 */
export const SHADOW_COMPACT_FRAMES: ShadowFrame[] = [
  // 0%: rest shadow
  { pct: 0, pixels: [
    [2,9,0.08],[3,9,0.15],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.15],[8,9,0.08],
  ]},
  // 42%: widening as blob flattens
  { pct: 42, pixels: [
    [0,9,0.04],[1,9,0.08],[2,9,0.12],[3,9,0.18],[4,9,0.22],[5,9,0.25],
    [6,9,0.22],[7,9,0.18],[8,9,0.12],[9,9,0.08],[10,9,0.04],
  ]},
  // 65%: wider shadow at maximum squash
  { pct: 65, pixels: [
    [0,9,0.05],[1,9,0.10],[2,9,0.15],[3,9,0.20],[4,9,0.23],[5,9,0.25],
    [6,9,0.23],[7,9,0.20],[8,9,0.15],[9,9,0.10],[10,9,0.05],
  ]},
  // 82%: same as 65% (held)
  { pct: 82, pixels: [
    [0,9,0.05],[1,9,0.10],[2,9,0.15],[3,9,0.20],[4,9,0.23],[5,9,0.25],
    [6,9,0.23],[7,9,0.20],[8,9,0.15],[9,9,0.10],[10,9,0.05],
  ]},
  // 100%: return to rest
  { pct: 100, pixels: [
    [2,9,0.08],[3,9,0.15],[4,9,0.22],[5,9,0.25],[6,9,0.22],[7,9,0.15],[8,9,0.08],
  ]},
];
