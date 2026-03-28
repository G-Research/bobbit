#!/usr/bin/env node
/**
 * Extract pixel data from Bobbit CSS box-shadow strings.
 *
 * Parses sidebar accessory shadows (from session-colors.ts ACCESSORIES),
 * blob accessory shadows (from app.css), the sidebar body shadow
 * (from bobbit-render.ts), and the static blob shadow.
 *
 * Outputs TypeScript-formatted pixel data arrays and offset comparisons.
 */

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a CSS box-shadow string into [x, y, color] tuples.
 * Handles formats like "3px -1px 0 #000" and "3px -1px 0 rgba(0,0,0,0.08)".
 */
function parseBoxShadow(str) {
  if (!str || !str.trim()) return [];
  const results = [];
  // Match individual shadow entries: Xpx Ypx 0 <color>
  // Color can be #hex, named, or rgba(...)
  const regex = /(-?\d+)px\s+(-?\d+)px\s+\d+(?:px)?\s+(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-zA-Z]+(?![a-zA-Z]*px))/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    const x = parseInt(m[1], 10);
    const y = parseInt(m[2], 10);
    const color = m[3];
    results.push([x, y, color]);
  }
  return results;
}

// ─── Sidebar accessory shadows (from session-colors.ts ACCESSORIES) ─────────

const SIDEBAR_ACCESSORIES = {
  crown: `
    3px -1px 0 #000,5px -1px 0 #000,7px -1px 0 #000,
    2px 0 0 #000,3px 0 0 #fef08a,4px 0 0 #000,5px 0 0 #fef08a,6px 0 0 #000,7px 0 0 #fef08a,8px 0 0 #000,
    1px 1px 0 #000,2px 1px 0 #fde047,3px 1px 0 #fef08a,4px 1px 0 #fde047,5px 1px 0 #ef4444,6px 1px 0 #fde047,7px 1px 0 #fef08a,8px 1px 0 #fde047,9px 1px 0 #000,
    1px 2px 0 #000,2px 2px 0 #ca8a04,3px 2px 0 #eab308,4px 2px 0 #eab308,5px 2px 0 #eab308,6px 2px 0 #eab308,7px 2px 0 #eab308,8px 2px 0 #ca8a04,9px 2px 0 #000,
    1px 3px 0 #000,2px 3px 0 #000,3px 3px 0 #000,4px 3px 0 #000,5px 3px 0 #000,6px 3px 0 #000,7px 3px 0 #000,8px 3px 0 #000,9px 3px 0 #000
  `,
  bandana: `
    1px 2px 0 #000,2px 2px 0 #000,3px 2px 0 #000,4px 2px 0 #000,5px 2px 0 #000,6px 2px 0 #000,7px 2px 0 #000,8px 2px 0 #000,9px 2px 0 #000,
    0 3px 0 #000,1px 3px 0 #b91c1c,2px 3px 0 #dc2626,3px 3px 0 #ef4444,4px 3px 0 #ef4444,5px 3px 0 #ef4444,6px 3px 0 #ef4444,7px 3px 0 #ef4444,8px 3px 0 #f87171,9px 3px 0 #000,
    0 4px 0 #000,1px 4px 0 #000,2px 4px 0 #000,3px 4px 0 #000,4px 4px 0 #000,5px 4px 0 #000,6px 4px 0 #000,7px 4px 0 #000,8px 4px 0 #000,9px 4px 0 #000,
    10px 3px 0 #000,10px 4px 0 #b91c1c,11px 4px 0 #000,
    10px 5px 0 #991b1b,11px 5px 0 #000,10px 6px 0 #000
  `,
  magnifier: `
    8px 2px 0 #000,9px 2px 0 #000,10px 2px 0 #000,
    7px 3px 0 #000,8px 3px 0 #87ceeb,9px 3px 0 #b0e0f0,10px 3px 0 #87ceeb,11px 3px 0 #000,
    7px 4px 0 #000,8px 4px 0 #b0e0f0,9px 4px 0 #e0f4ff,10px 4px 0 #87ceeb,11px 4px 0 #000,
    7px 5px 0 #000,8px 5px 0 #87ceeb,9px 5px 0 #b0e0f0,10px 5px 0 #87ceeb,11px 5px 0 #000,
    7px 6px 0 #000,8px 6px 0 #000,9px 6px 0 #000,10px 6px 0 #000,
    6px 7px 0 #000,7px 7px 0 #8b4513,
    5px 8px 0 #000,6px 8px 0 #8b4513
  `,
  palette: `
    9px 5px 0 #000,10px 5px 0 #000,
    8px 6px 0 #000,9px 6px 0 #a16207,10px 6px 0 #ef4444,11px 6px 0 #000,
    7px 7px 0 #000,8px 7px 0 #4ade80,9px 7px 0 #a16207,10px 7px 0 #a16207,11px 7px 0 #000,
    7px 8px 0 #000,8px 8px 0 #a16207,9px 8px 0 #a16207,10px 8px 0 #60a5fa,11px 8px 0 #000,
    8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000
  `,
  pencil: `
    10px 3px 0 #000,11px 3px 0 #000,
    9px 4px 0 #000,10px 4px 0 #f9a8d4,11px 4px 0 #ec4899,12px 4px 0 #000,
    8px 5px 0 #000,9px 5px 0 #9ca3af,10px 5px 0 #d1d5db,11px 5px 0 #000,
    7px 6px 0 #000,8px 6px 0 #fde047,9px 6px 0 #fbbf24,10px 6px 0 #000,
    6px 7px 0 #000,7px 7px 0 #fde047,8px 7px 0 #fbbf24,9px 7px 0 #000,
    5px 8px 0 #000,6px 8px 0 #f4a460,7px 8px 0 #cd853f,8px 8px 0 #000,
    4px 9px 0 #000,5px 9px 0 #4b5563,6px 9px 0 #000
  `,
  shield: `
    8px 3px 0 #000,9px 3px 0 #000,10px 3px 0 #000,11px 3px 0 #000,12px 3px 0 #000,
    7px 4px 0 #000,8px 4px 0 #9ca3af,9px 4px 0 #d1d5db,10px 4px 0 #d1d5db,11px 4px 0 #9ca3af,12px 4px 0 #000,
    7px 5px 0 #000,8px 5px 0 #d1d5db,9px 5px 0 #f3f4f6,10px 5px 0 #ef4444,11px 5px 0 #d1d5db,12px 5px 0 #000,
    7px 6px 0 #000,8px 6px 0 #9ca3af,9px 6px 0 #d1d5db,10px 6px 0 #d1d5db,11px 6px 0 #9ca3af,12px 6px 0 #000,
    8px 7px 0 #000,9px 7px 0 #9ca3af,10px 7px 0 #9ca3af,11px 7px 0 #000,
    9px 8px 0 #000,10px 8px 0 #000
  `,
  "set-square": `
    10px 4px 0 #000,
    9px 5px 0 #000,10px 5px 0 #93c5fd,11px 5px 0 #000,
    8px 6px 0 #000,9px 6px 0 #bfdbfe,10px 6px 0 #93c5fd,11px 6px 0 #000,
    7px 7px 0 #000,8px 7px 0 #bfdbfe,9px 7px 0 #000,10px 7px 0 #bfdbfe,11px 7px 0 #000,
    6px 8px 0 #000,7px 8px 0 #bfdbfe,8px 8px 0 #bfdbfe,9px 8px 0 #bfdbfe,10px 8px 0 #93c5fd,11px 8px 0 #000,
    5px 9px 0 #000,6px 9px 0 #000,7px 9px 0 #000,8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000,11px 9px 0 #000
  `,
  flask: `
    8px 4px 0 #000,9px 4px 0 #fff,10px 4px 0 #000,
    8px 5px 0 #000,9px 5px 0 #7dd3fc,10px 5px 0 #000,
    7px 6px 0 #000,8px 6px 0 #0369a1,9px 6px 0 #38bdf8,10px 6px 0 #0ea5e9,11px 6px 0 #000,
    6px 7px 0 #000,7px 7px 0 #1e3a5f,8px 7px 0 #0ea5e9,9px 7px 0 #0284c7,10px 7px 0 #0369a1,11px 7px 0 #1e3a5f,12px 7px 0 #000,
    6px 8px 0 #000,7px 8px 0 #1e3a5f,8px 8px 0 #0284c7,9px 8px 0 #0c4a6e,10px 8px 0 #082f49,11px 8px 0 #1e3a5f,12px 8px 0 #000,
    6px 9px 0 #000,7px 9px 0 #000,8px 9px 0 #000,9px 9px 0 #000,10px 9px 0 #000,11px 9px 0 #000,12px 9px 0 #000
  `,
  "wizard-hat": `
    7px -2px 0 #2dd4bf,8px -2px 0 #fde047,
    5px -1px 0 #000,6px -1px 0 #6366f1,7px -1px 0 #818cf8,8px -1px 0 #000,
    2px 0px 0 #000,3px 0px 0 #6d28d9,4px 0px 0 #7c3aed,5px 0px 0 #8b5cf6,6px 0px 0 #6366f1,7px 0px 0 #a78bfa,8px 0px 0 #000,
    1px 1px 0 #000,2px 1px 0 #6d28d9,3px 1px 0 #7c3aed,4px 1px 0 #fbbf24,5px 1px 0 #fde047,6px 1px 0 #14b8a6,7px 1px 0 #a78bfa,8px 1px 0 #6d28d9,9px 1px 0 #000,
    0px 2px 0 #000,1px 2px 0 #000,2px 2px 0 #000,3px 2px 0 #000,4px 2px 0 #000,5px 2px 0 #000,6px 2px 0 #000,7px 2px 0 #000,8px 2px 0 #000,9px 2px 0 #000,10px 2px 0 #000
  `,
  wand: `
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
};

// ─── Blob accessory shadows (from app.css) ──────────────────────────────────
// Note: blob crown has a y-offset of -1 compared to sidebar crown

const BLOB_ACCESSORIES = {
  crown: `
    3px -2px 0 #000, 5px -2px 0 #000, 7px -2px 0 #000,
    2px -1px 0 #000, 3px -1px 0 #fef08a, 4px -1px 0 #000, 5px -1px 0 #fef08a, 6px -1px 0 #000, 7px -1px 0 #fef08a, 8px -1px 0 #000,
    1px 0px 0 #000, 2px 0px 0 #fde047, 3px 0px 0 #fef08a, 4px 0px 0 #fde047, 5px 0px 0 #ef4444, 6px 0px 0 #fde047, 7px 0px 0 #fef08a, 8px 0px 0 #fde047, 9px 0px 0 #000,
    1px 1px 0 #000, 2px 1px 0 #ca8a04, 3px 1px 0 #eab308, 4px 1px 0 #eab308, 5px 1px 0 #eab308, 6px 1px 0 #eab308, 7px 1px 0 #eab308, 8px 1px 0 #ca8a04, 9px 1px 0 #000,
    1px 2px 0 #000, 2px 2px 0 #000, 3px 2px 0 #000, 4px 2px 0 #000, 5px 2px 0 #000, 6px 2px 0 #000, 7px 2px 0 #000, 8px 2px 0 #000, 9px 2px 0 #000
  `,
  bandana: `
    1px 2px 0 #000, 2px 2px 0 #000, 3px 2px 0 #000, 4px 2px 0 #000, 5px 2px 0 #000, 6px 2px 0 #000, 7px 2px 0 #000, 8px 2px 0 #000, 9px 2px 0 #000,
    0 3px 0 #000, 1px 3px 0 #b91c1c, 2px 3px 0 #dc2626, 3px 3px 0 #ef4444, 4px 3px 0 #ef4444, 5px 3px 0 #ef4444, 6px 3px 0 #ef4444, 7px 3px 0 #ef4444, 8px 3px 0 #f87171, 9px 3px 0 #000,
    0 4px 0 #000, 1px 4px 0 #000, 2px 4px 0 #000, 3px 4px 0 #000, 4px 4px 0 #000, 5px 4px 0 #000, 6px 4px 0 #000, 7px 4px 0 #000, 8px 4px 0 #000, 9px 4px 0 #000,
    10px 3px 0 #000, 10px 4px 0 #b91c1c, 11px 4px 0 #000,
    10px 5px 0 #991b1b, 11px 5px 0 #000, 10px 6px 0 #000
  `,
  magnifier: `
    8px 2px 0 #000, 9px 2px 0 #000, 10px 2px 0 #000,
    7px 3px 0 #000, 8px 3px 0 #87ceeb, 9px 3px 0 #b0e0f0, 10px 3px 0 #87ceeb, 11px 3px 0 #000,
    7px 4px 0 #000, 8px 4px 0 #b0e0f0, 9px 4px 0 #e0f4ff, 10px 4px 0 #87ceeb, 11px 4px 0 #000,
    7px 5px 0 #000, 8px 5px 0 #87ceeb, 9px 5px 0 #b0e0f0, 10px 5px 0 #87ceeb, 11px 5px 0 #000,
    7px 6px 0 #000, 8px 6px 0 #000, 9px 6px 0 #000, 10px 6px 0 #000,
    6px 7px 0 #000, 7px 7px 0 #8b4513,
    5px 8px 0 #000, 6px 8px 0 #8b4513
  `,
  palette: `
    9px 5px 0 #000, 10px 5px 0 #000,
    8px 6px 0 #000, 9px 6px 0 #a16207, 10px 6px 0 #ef4444, 11px 6px 0 #000,
    7px 7px 0 #000, 8px 7px 0 #4ade80, 9px 7px 0 #a16207, 10px 7px 0 #a16207, 11px 7px 0 #000,
    7px 8px 0 #000, 8px 8px 0 #a16207, 9px 8px 0 #a16207, 10px 8px 0 #60a5fa, 11px 8px 0 #000,
    8px 9px 0 #000, 9px 9px 0 #000, 10px 9px 0 #000
  `,
  pencil: `
    11px 2px 0 #000, 12px 2px 0 #000,
    10px 3px 0 #000, 11px 3px 0 #f9a8d4, 12px 3px 0 #ec4899, 13px 3px 0 #000,
    9px 4px 0 #000, 10px 4px 0 #9ca3af, 11px 4px 0 #d1d5db, 12px 4px 0 #000,
    8px 5px 0 #000, 9px 5px 0 #fde047, 10px 5px 0 #fbbf24, 11px 5px 0 #000,
    7px 6px 0 #000, 8px 6px 0 #fde047, 9px 6px 0 #fbbf24, 10px 6px 0 #000,
    6px 7px 0 #000, 7px 7px 0 #f4a460, 8px 7px 0 #cd853f, 9px 7px 0 #000,
    5px 8px 0 #000, 6px 8px 0 #4b5563, 7px 8px 0 #000
  `,
  shield: `
    8px 3px 0 #000, 9px 3px 0 #000, 10px 3px 0 #000, 11px 3px 0 #000, 12px 3px 0 #000,
    7px 4px 0 #000, 8px 4px 0 #9ca3af, 9px 4px 0 #d1d5db, 10px 4px 0 #d1d5db, 11px 4px 0 #9ca3af, 12px 4px 0 #000,
    7px 5px 0 #000, 8px 5px 0 #d1d5db, 9px 5px 0 #f3f4f6, 10px 5px 0 #ef4444, 11px 5px 0 #d1d5db, 12px 5px 0 #000,
    7px 6px 0 #000, 8px 6px 0 #9ca3af, 9px 6px 0 #d1d5db, 10px 6px 0 #d1d5db, 11px 6px 0 #9ca3af, 12px 6px 0 #000,
    8px 7px 0 #000, 9px 7px 0 #9ca3af, 10px 7px 0 #9ca3af, 11px 7px 0 #000,
    9px 8px 0 #000, 10px 8px 0 #000
  `,
  "set-square": `
    10px 4px 0 #000,
    9px 5px 0 #000, 10px 5px 0 #93c5fd, 11px 5px 0 #000,
    8px 6px 0 #000, 9px 6px 0 #bfdbfe, 10px 6px 0 #93c5fd, 11px 6px 0 #000,
    7px 7px 0 #000, 8px 7px 0 #bfdbfe, 9px 7px 0 #000, 10px 7px 0 #bfdbfe, 11px 7px 0 #000,
    6px 8px 0 #000, 7px 8px 0 #bfdbfe, 8px 8px 0 #bfdbfe, 9px 8px 0 #bfdbfe, 10px 8px 0 #93c5fd, 11px 8px 0 #000,
    5px 9px 0 #000, 6px 9px 0 #000, 7px 9px 0 #000, 8px 9px 0 #000, 9px 9px 0 #000, 10px 9px 0 #000, 11px 9px 0 #000
  `,
  flask: `
    8px 4px 0 #000, 9px 4px 0 #fff, 10px 4px 0 #000,
    8px 5px 0 #000, 9px 5px 0 #7dd3fc, 10px 5px 0 #000,
    7px 6px 0 #000, 8px 6px 0 #0369a1, 9px 6px 0 #38bdf8, 10px 6px 0 #0ea5e9, 11px 6px 0 #000,
    6px 7px 0 #000, 7px 7px 0 #1e3a5f, 8px 7px 0 #0ea5e9, 9px 7px 0 #0284c7, 10px 7px 0 #0369a1, 11px 7px 0 #1e3a5f, 12px 7px 0 #000,
    6px 8px 0 #000, 7px 8px 0 #1e3a5f, 8px 8px 0 #0284c7, 9px 8px 0 #0c4a6e, 10px 8px 0 #082f49, 11px 8px 0 #1e3a5f, 12px 8px 0 #000,
    6px 9px 0 #000, 7px 9px 0 #000, 8px 9px 0 #000, 9px 9px 0 #000, 10px 9px 0 #000, 11px 9px 0 #000, 12px 9px 0 #000
  `,
  "wizard-hat": `
    7px -2px 0 #2dd4bf, 8px -2px 0 #fde047,
    5px -1px 0 #000, 6px -1px 0 #6366f1, 7px -1px 0 #818cf8, 8px -1px 0 #000,
    2px 0px 0 #000, 3px 0px 0 #6d28d9, 4px 0px 0 #7c3aed, 5px 0px 0 #8b5cf6, 6px 0px 0 #6366f1, 7px 0px 0 #a78bfa, 8px 0px 0 #000,
    1px 1px 0 #000, 2px 1px 0 #6d28d9, 3px 1px 0 #7c3aed, 4px 1px 0 #fbbf24, 5px 1px 0 #fde047, 6px 1px 0 #14b8a6, 7px 1px 0 #a78bfa, 8px 1px 0 #6d28d9, 9px 1px 0 #000,
    0px 2px 0 #000, 1px 2px 0 #000, 2px 2px 0 #000, 3px 2px 0 #000, 4px 2px 0 #000, 5px 2px 0 #000, 6px 2px 0 #000, 7px 2px 0 #000, 8px 2px 0 #000, 9px 2px 0 #000, 10px 2px 0 #000
  `,
  wand: `
    11px 2px 0 #000,
    10px 3px 0 #000, 12px 3px 0 #000,
    9px 4px 0 #000, 13px 4px 0 #000,
    10px 5px 0 #000, 12px 5px 0 #000,
    11px 6px 0 #000,
    11px 3px 0 #fef9c4,
    10px 4px 0 #fde047, 11px 4px 0 #fff, 12px 4px 0 #fde047,
    11px 5px 0 #fef9c4,
    9px 5px 0 #000, 10px 5px 0 #cd853f, 11px 5px 0 #000,
    8px 6px 0 #000, 9px 6px 0 #cd853f, 10px 6px 0 #000,
    7px 7px 0 #000, 8px 7px 0 #8b4513, 9px 7px 0 #000,
    6px 8px 0 #000, 7px 8px 0 #8b4513, 8px 8px 0 #000,
    5px 9px 0 #000, 6px 9px 0 #000
  `,
};

// ─── Sidebar body shadow (from bobbit-render.ts) ────────────────────────────
// Using the canonical palette: main=#8ec63f, light=#b5d98a, dark=#6b9930, eye=#1a3010

const SIDEBAR_BODY = `
  3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,
  2px 1px 0 #000,3px 1px 0 #8ec63f,4px 1px 0 #8ec63f,5px 1px 0 #8ec63f,6px 1px 0 #b5d98a,7px 1px 0 #b5d98a,8px 1px 0 #000,
  1px 2px 0 #000,2px 2px 0 #8ec63f,3px 2px 0 #8ec63f,4px 2px 0 #8ec63f,5px 2px 0 #8ec63f,6px 2px 0 #8ec63f,7px 2px 0 #b5d98a,8px 2px 0 #8ec63f,9px 2px 0 #000,
  0px 3px 0 #000,1px 3px 0 #8ec63f,2px 3px 0 #8ec63f,3px 3px 0 #8ec63f,4px 3px 0 #8ec63f,5px 3px 0 #8ec63f,6px 3px 0 #8ec63f,7px 3px 0 #8ec63f,8px 3px 0 #8ec63f,9px 3px 0 #000,
  0px 4px 0 #000,1px 4px 0 #8ec63f,2px 4px 0 #8ec63f,3px 4px 0 #1a3010,4px 4px 0 #8ec63f,5px 4px 0 #8ec63f,6px 4px 0 #1a3010,7px 4px 0 #8ec63f,8px 4px 0 #8ec63f,9px 4px 0 #000,
  0px 5px 0 #000,1px 5px 0 #8ec63f,2px 5px 0 #8ec63f,3px 5px 0 #1a3010,4px 5px 0 #8ec63f,5px 5px 0 #8ec63f,6px 5px 0 #1a3010,7px 5px 0 #8ec63f,8px 5px 0 #8ec63f,9px 5px 0 #000,
  0px 6px 0 #000,1px 6px 0 #6b9930,2px 6px 0 #8ec63f,3px 6px 0 #8ec63f,4px 6px 0 #8ec63f,5px 6px 0 #8ec63f,6px 6px 0 #8ec63f,7px 6px 0 #8ec63f,8px 6px 0 #8ec63f,9px 6px 0 #000,
  1px 7px 0 #000,2px 7px 0 #6b9930,3px 7px 0 #8ec63f,4px 7px 0 #8ec63f,5px 7px 0 #8ec63f,6px 7px 0 #8ec63f,7px 7px 0 #8ec63f,8px 7px 0 #000,
  2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000
`;

// ─── Static blob shadow (from app.css .bobbit-blob__shadow) ─────────────────

const BLOB_SHADOW = `
  2px 9px 0 rgba(0,0,0,0.08),
  3px 9px 0 rgba(0,0,0,0.15),
  4px 9px 0 rgba(0,0,0,0.22),
  5px 9px 0 rgba(0,0,0,0.25),
  6px 9px 0 rgba(0,0,0,0.22),
  7px 9px 0 rgba(0,0,0,0.15),
  8px 9px 0 rgba(0,0,0,0.08)
`;

// ─── Output ─────────────────────────────────────────────────────────────────

function formatPixels(pixels) {
  if (pixels.length === 0) return "[]";
  const lines = pixels.map(([x, y, c]) => `  [${x}, ${y}, '${c}']`);
  return `[\n${lines.join(",\n")}\n]`;
}

function yRange(pixels) {
  if (pixels.length === 0) return { min: 0, max: 0 };
  const ys = pixels.map(p => p[1]);
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

let output = "";

output += "// ============================================================================\n";
output += "// SIDEBAR BODY PIXELS (from bobbit-render.ts renderSidebarBobbit)\n";
output += "// ============================================================================\n\n";
const sidebarBodyPixels = parseBoxShadow(SIDEBAR_BODY);
output += `export const SIDEBAR_BODY_PIXELS: [number, number, string][] = ${formatPixels(sidebarBodyPixels)};\n\n`;

output += "// ============================================================================\n";
output += "// SIDEBAR ACCESSORY PIXELS (from session-colors.ts ACCESSORIES)\n";
output += "// ============================================================================\n\n";
for (const [name, shadow] of Object.entries(SIDEBAR_ACCESSORIES)) {
  const pixels = parseBoxShadow(shadow);
  const range = yRange(pixels);
  output += `// ${name}: y range [${range.min}, ${range.max}], ${pixels.length} pixels\n`;
  output += `export const SIDEBAR_${name.replace(/-/g, "_").toUpperCase()}_PIXELS: [number, number, string][] = ${formatPixels(pixels)};\n\n`;
}

output += "// ============================================================================\n";
output += "// BLOB ACCESSORY PIXELS (from app.css)\n";
output += "// ============================================================================\n\n";
for (const [name, shadow] of Object.entries(BLOB_ACCESSORIES)) {
  const pixels = parseBoxShadow(shadow);
  const range = yRange(pixels);
  output += `// ${name}: y range [${range.min}, ${range.max}], ${pixels.length} pixels\n`;
  output += `export const BLOB_${name.replace(/-/g, "_").toUpperCase()}_PIXELS: [number, number, string][] = ${formatPixels(pixels)};\n\n`;
}

output += "// ============================================================================\n";
output += "// BLOB SHADOW PIXELS (from app.css .bobbit-blob__shadow)\n";
output += "// ============================================================================\n\n";
const blobShadowPixels = parseBoxShadow(BLOB_SHADOW);
output += `export const BLOB_SHADOW_PIXELS: [number, number, string][] = ${formatPixels(blobShadowPixels)};\n\n`;

output += "// ============================================================================\n";
output += "// SIDEBAR vs BLOB Y-OFFSET COMPARISON\n";
output += "// ============================================================================\n";
output += "//\n";
output += "// Sidebar accessories use the coordinate system from ACCESSORIES.shadow in\n";
output += "// session-colors.ts. Blob accessories use the coordinate system from app.css.\n";
output += "//\n";
output += "// The sidebar renderer (renderSidebarBobbit) applies accessories at 1.6x scale.\n";
output += "// The blob renderer (app.css) applies accessories at 4x scale.\n";
output += "//\n";
output += "// Comparing y-offset of each pixel between sidebar and blob versions:\n";
output += "//\n";

for (const name of Object.keys(SIDEBAR_ACCESSORIES)) {
  const sidebarPixels = parseBoxShadow(SIDEBAR_ACCESSORIES[name]);
  const blobPixels = parseBoxShadow(BLOB_ACCESSORIES[name]);
  const sRange = yRange(sidebarPixels);
  const bRange = yRange(blobPixels);
  const yDiff = bRange.min - sRange.min;
  
  // Build coordinate maps for comparison
  const sidebarMap = new Map();
  for (const [x, y, c] of sidebarPixels) sidebarMap.set(`${x},${y}`, c);
  const blobMap = new Map();
  for (const [x, y, c] of blobPixels) blobMap.set(`${x},${y}`, c);
  
  // Check if pixels are identical when blob is shifted by yDiff
  let identical = true;
  let colorDiffs = 0;
  const shiftedBlobMap = new Map();
  for (const [x, y, c] of blobPixels) shiftedBlobMap.set(`${x},${y - yDiff}`, c);
  
  for (const [key, sColor] of sidebarMap) {
    const bColor = shiftedBlobMap.get(key);
    if (!bColor) { identical = false; break; }
    if (bColor !== sColor) { colorDiffs++; }
  }
  if (sidebarMap.size !== shiftedBlobMap.size) identical = false;
  
  const note = identical && colorDiffs === 0
    ? "IDENTICAL (same pixels, same colors)"
    : identical
    ? `Same positions, ${colorDiffs} color differences`
    : "DIFFERENT pixel positions";
  
  output += `// ${name.padEnd(14)} sidebar y:[${sRange.min},${sRange.max}]  blob y:[${bRange.min},${bRange.max}]  `;
  output += `blob_yOffset=${yDiff >= 0 ? "+" : ""}${yDiff}  ${note}\n`;
}

output += "\n";

console.log(output);
