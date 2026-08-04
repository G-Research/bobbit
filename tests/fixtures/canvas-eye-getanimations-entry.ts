// Test entry point — bundles the real canvas eye scheduler for gateway-free
// browser tests with either real CSS Animations or controlled phase clocks.
import { startCanvasEyeAnimation } from "../../src/ui/bobbit-render.js";
import {
	BUSY_EYE_SEQUENCE,
	IDLE_EYE_SEQUENCE,
	SLEEP_EYE_SEQUENCE,
	type EyeFrame,
} from "../../src/ui/bobbit-sprite-data.js";

const sequences = {
	busy: BUSY_EYE_SEQUENCE,
	idle: IDLE_EYE_SEQUENCE,
	sleep: SLEEP_EYE_SEQUENCE,
};

(window as any).__canvasEyeAnim = {
	sequences,
	start(canvas: HTMLCanvasElement, cycleMs: number, kind: keyof typeof sequences = "busy"): () => void {
		return startCanvasEyeAnimation(canvas, sequences[kind], cycleMs);
	},
	startSequence(canvas: HTMLCanvasElement, cycleMs: number, sequence: EyeFrame[]): () => void {
		return startCanvasEyeAnimation(canvas, sequence, cycleMs);
	},
};
(window as any).__ready = true;
