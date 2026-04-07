#!/usr/bin/env node
/**
 * Generate "-canvas" variants of all blob keyframes that use scale(4).
 *
 * For the canvas sprite path, the element is rendered at 40×36 CSS px
 * (4× the 10×9 sprite) with no CSS scale(4). All transform keyframes
 * need adjustment:
 *   - Remove the leading `scale(4)`
 *   - Multiply translateX/translateY values by 4
 *   - Keep scaleX, scaleY, rotate as-is
 *   - Adjust transform-origin references (5px 8px → 20px 32px)
 *
 * Also handles blob-idle-eyes (which bundles transform + box-shadow):
 *   - Produces a transform-only variant with box-shadow stripped
 *
 * Usage: node scripts/gen-canvas-keyframes.mjs < src/ui/app.css
 * Outputs only the new @keyframes blocks to stdout.
 */

import { readFileSync } from "fs";

const css = readFileSync(process.argv[2] || "src/ui/app.css", "utf8");

// Keyframes that are applied to .bobbit-blob__sprite and contain scale(4) transforms.
// We need canvas variants for all of these.
const TARGET_KEYFRAMES = new Set([
   "blob-busy-move",
   "blob-busy-move-rigid",
   "blob-enter",
   "blob-enter-rigid",
   "blob-enter-roll",
   "blob-enter-roll-rigid",
   "blob-exit",
   "blob-exit-rigid",
   "blob-exit-roll",
   "blob-exit-roll-rigid",
   "blob-compact-shake",
   "blob-compact-shake-rigid",
   "blob-compact-squash",
   "blob-compact-squash-rigid",
   "blob-compact-pop",
   "blob-compact-pop-rigid",
   "blob-idle-eyes",
]);

// Shadow keyframes that reference scale(4) — need canvas variants too
const SHADOW_KEYFRAMES = new Set([
   "blob-busy-shadow",
   "blob-shadow",
   "blob-shadow-enter",
   "blob-shadow-enter-roll",
   "blob-shadow-exit",
   "blob-shadow-exit-roll",
]);

/**
 * Transform a CSS transform value string from scale(4) coordinate space
 * to 1:1 (canvas) coordinate space.
 *
 * Input:  "scale(4) translateX(-5px) translateY(2px) scaleX(1.22) scaleY(0.72) rotate(2deg)"
 * Output: "translateX(-20px) translateY(8px) scaleX(1.22) scaleY(0.72) rotate(2deg)"
 */
function transformValue(val) {
   // Remove leading scale(4) — may or may not have translateZ(0) after
   let v = val.trim();
   v = v.replace(/scale\(4\)\s*/g, "");
   v = v.replace(/translateZ\(0\)\s*/g, "");

   // Multiply translateX and translateY values by 4
   v = v.replace(/translateX\(([^)]+)\)/g, (_, inner) => {
       const num = parseFloat(inner);
       if (isNaN(num)) return `translateX(${inner})`;
       const unit = inner.replace(/[-\d.]+/, "") || "px";
       return `translateX(${num * 4}${unit})`;
   });
   v = v.replace(/translateY\(([^)]+)\)/g, (_, inner) => {
       const num = parseFloat(inner);
       if (isNaN(num)) return `translateY(${inner})`;
       const unit = inner.replace(/[-\d.]+/, "") || "px";
       return `translateY(${num * 4}${unit})`;
   });

   // If nothing left (was just "scale(4)"), return "none"
   v = v.trim();
   return v || "none";
}

/**
 * Extract @keyframes blocks from CSS text.
 * Returns array of { name, body, startIdx, endIdx }
 */
function extractKeyframes(cssText) {
   const results = [];
   const re = /@keyframes\s+([\w-]+)\s*\{/g;
   let match;
   while ((match = re.exec(cssText)) !== null) {
       const name = match[1];
       const startIdx = match.index;
       // Find matching closing brace (handle nested braces)
       let depth = 0;
       let i = match.index + match[0].length;
       // We're inside the opening brace
       depth = 1;
       while (i < cssText.length && depth > 0) {
           if (cssText[i] === "{") depth++;
           else if (cssText[i] === "}") depth--;
           i++;
       }
       const body = cssText.slice(match.index + match[0].length, i - 1);
       results.push({ name, body, startIdx, endIdx: i });
   }
   return results;
}

/**
 * Transform a keyframe body from scale(4) to canvas coordinate space.
 * Handles both transform-only keyframes and mixed transform+box-shadow keyframes.
 */
function transformKeyframeBody(body, stripBoxShadow = false) {
   let result = body;

   // First, strip box-shadow declarations if requested (before line-by-line transform processing).
   // box-shadow can span multiple lines:  "box-shadow:\n\t\tval, val, ...;"
   if (stripBoxShadow) {
       result = result.replace(/;?\s*box-shadow\s*:\s*[\s\S]*?;/g, ";");
   }

   // Process line by line, transforming `transform:` values
   const lines = result.split("\n");
   const output = [];

   for (let i = 0; i < lines.length; i++) {
       let line = lines[i];

       // Transform `transform:` declarations
       if (/transform\s*:/.test(line)) {
           const transformMatch = line.match(/transform\s*:\s*(.+?)(?:;|\}|$)/);
           if (transformMatch) {
               const oldVal = transformMatch[1].trim().replace(/;$/, "");
               const newVal = transformValue(oldVal);
               line = line.replace(transformMatch[1].replace(/;$/, ""), newVal);
           }
       }

       output.push(line);
   }

   return output.join("\n");
}

// Parse all keyframes
const allKeyframes = extractKeyframes(css);
const outputBlocks = [];

for (const kf of allKeyframes) {
   if (TARGET_KEYFRAMES.has(kf.name)) {
       const isIdleEyes = kf.name === "blob-idle-eyes";
       const newBody = transformKeyframeBody(kf.body, isIdleEyes);
       const newName = kf.name + "-canvas";
       outputBlocks.push({ name: newName, body: newBody, origName: kf.name });
   }
   if (SHADOW_KEYFRAMES.has(kf.name)) {
       // Shadow keyframes also reference scale(4) in transforms
       const newBody = transformKeyframeBody(kf.body, false);
       const newName = kf.name + "-canvas";
       outputBlocks.push({ name: newName, body: newBody, origName: kf.name });
   }
}

// Output
console.log("/* ══════════════════════════════════════════════════════════════════════════════");
console.log(" * Canvas sprite keyframe variants — auto-generated by gen-canvas-keyframes.mjs");
console.log(" *");
console.log(" * These are copies of the scale(4) blob keyframes with:");
console.log(" *   - scale(4) removed (canvas element is already at full 40×36 CSS size)");
console.log(" *   - translateX/Y values multiplied by 4");
console.log(" *   - box-shadow stripped from blob-idle-eyes (eyes rendered by JS on canvas)");
console.log(" * ══════════════════════════════════════════════════════════════════════════ */");
console.log("");

for (const block of outputBlocks) {
   console.log(`@keyframes ${block.name} {${block.body}}`);
   console.log("");
}

// Also output the CSS rules that apply these to canvas.bobbit-blob__sprite
console.log("/* ── Canvas sprite base overrides ──");
console.log("   Applied when .bobbit-blob__sprite is a <canvas> element (device-pixel rendering).");
console.log("   The element is 40×36 CSS px (no scale(4)), with transform-origin adjusted. */");
console.log("");

// Base rule: override dimensions, transform-origin, transform, and default animation
console.log(`canvas.bobbit-blob__sprite {`);
console.log(`\twidth: ${10 * 4}px !important;`);
console.log(`\theight: ${9 * 4}px !important;`);
console.log(`\tmargin: 0 !important; /* layout handled by wrapper */`);
console.log(`\ttransform-origin: ${5 * 4}px ${8 * 4}px;`);
console.log(`\ttransform: none;`);
console.log(`\tbox-shadow: none !important;`);
console.log(`\timage-rendering: pixelated;`);
console.log(`\t/* Default (busy) animation — swap to canvas variants */`);
console.log(`\tanimation:`);
console.log(`\t\tblob-busy-move-canvas 10s cubic-bezier(0.34, 1, 0.64, 1) infinite,`);
console.log(`\t\tnone 10s steps(1) infinite,`);
console.log(`\t\tblob-shimmer 8s ease-in-out infinite;`);
console.log(`}`);
console.log("");

// State overrides
const stateOverrides = [
   { sel: ".bobbit-blob--exit", orig: "blob-exit", canvas: "blob-exit-canvas", timing: "0.7s cubic-bezier(0.34, 1.56, 0.64, 1) forwards" },
   { sel: ".bobbit-blob--exit-roll", orig: "blob-exit-roll", canvas: "blob-exit-roll-canvas", timing: "0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards" },
   { sel: ".bobbit-blob--enter", orig: "blob-enter", canvas: "blob-enter-canvas", timing: "0.7s cubic-bezier(0.34, 1.56, 0.64, 1) forwards" },
   { sel: ".bobbit-blob--enter-roll", orig: "blob-enter-roll", canvas: "blob-enter-roll-canvas", timing: "0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards" },
   { sel: ".bobbit-blob--compact-shake", orig: "blob-compact-shake", canvas: "blob-compact-shake-canvas", timing: "0.8s ease-in-out forwards" },
   { sel: ".bobbit-blob--compacting", orig: "blob-compact-squash", canvas: "blob-compact-squash-canvas", timing: "3s ease-in-out infinite" },
   { sel: ".bobbit-blob--compact-pop", orig: "blob-compact-pop", canvas: "blob-compact-pop-canvas", timing: "0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards" },
   { sel: ".bobbit-blob--idle", orig: "blob-idle-eyes", canvas: "blob-idle-eyes-canvas", timing: "10s steps(1) infinite" },
];

for (const o of stateOverrides) {
   console.log(`${o.sel} canvas.bobbit-blob__sprite {`);
   console.log(`\tanimation: ${o.canvas} ${o.timing} !important;`);
   console.log(`}`);
}
console.log("");

// Summary stats
console.error(`Generated ${outputBlocks.length} canvas keyframe variants:`);
for (const b of outputBlocks) {
   console.error(`  ${b.origName} → ${b.name}`);
}
