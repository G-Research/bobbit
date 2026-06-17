// Test entry point — bundles startCanvasEyeAnimation for file:// use so a spec
// can drive the real rAF eye-animation loop and observe how often
// Element.prototype.getAnimations() is called per frame. Pins the per-frame
// getAnimations() caching in readPhasePct (src/ui/bobbit-render.ts).
import { startCanvasEyeAnimation } from "../../src/ui/bobbit-render.js";
import { BUSY_EYE_SEQUENCE } from "../../src/ui/bobbit-sprite-data.js";

(window as any).__canvasEyeAnim = {
	start(canvas: HTMLCanvasElement, cycleMs: number): () => void {
		return startCanvasEyeAnimation(canvas, BUSY_EYE_SEQUENCE, cycleMs);
	},
};
(window as any).__ready = true;
