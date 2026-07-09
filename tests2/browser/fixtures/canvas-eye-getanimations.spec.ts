/**
 * Regression: the rAF eye-animation loop must NOT call getAnimations() every
 * frame.
 *
 * readPhasePct() observes the CSS animation clock by finding the cycle-duration
 * Animation on the canvas. getAnimations() enumerates + allocates an array of
 * every Animation on the element, and was being called once per requestAnimation
 * Frame per sprite — a measurable renderer hotspot (~8.5% CPU under sidebar
 * churn). The target Animation is a persistent object, so it must be resolved
 * once and cached, then reused across frames (reading .currentTime live each
 * frame). This spec lets the loop run many frames and asserts getAnimations()
 * is called only a small constant number of times, NOT once per frame.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/canvas-eye-getanimations.html");
const BUNDLE = path.resolve("tests/fixtures/canvas-eye-getanimations-bundle.js");
const ENTRY = path.resolve("tests/fixtures/canvas-eye-getanimations-entry.ts");
const SOURCES = [
	ENTRY,
	path.resolve("src/ui/bobbit-render.ts"),
	path.resolve("src/ui/bobbit-sprite-data.ts"),
];

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	const sourceMtime = Math.max(...SOURCES.map(source => fs.statSync(source).mtimeMs));
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < sourceMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

test.describe("Canvas eye animation getAnimations() caching", () => {
	test("resolves the phase animation once, not once per rAF frame", async ({ page }) => {
		await page.addInitScript(() => {
			(window as any).__getAnimationsCalls = 0;
			const original = Element.prototype.getAnimations;
			Element.prototype.getAnimations = function (this: any, ...args: any[]) {
				(window as any).__getAnimationsCalls = ((window as any).__getAnimationsCalls ?? 0) + 1;
				return Reflect.apply(original, this, args);
			} as any;
		});

		await page.goto(fileUrl(FIXTURE));
		await page.waitForFunction(() => (window as any).__ready === true);

		const result = await page.evaluate(async () => {
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const cycleMs = 10000;
			// Give the canvas a live, infinitely-looping animation with the cycle
			// duration the loop looks for, so resolvePhaseAnimation() finds and
			// caches a real (never-finishing) Animation object on frame 1.
			canvas.animate(
				[{ transform: "translateY(0)" }, { transform: "translateY(0)" }],
				{ duration: cycleMs, iterations: Infinity },
			);

			const stop = (window as any).__canvasEyeAnim.start(canvas, cycleMs);

			// Run the rAF loop for a fixed number of frames.
			const FRAMES = 30;
			(window as any).__getAnimationsCalls = 0; // count only steady-state frames
			await new Promise<void>((resolve) => {
				let n = 0;
				const step = () => {
					if (++n >= FRAMES) { resolve(); return; }
					requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			});

			stop();
			return {
				calls: (window as any).__getAnimationsCalls as number,
				frames: FRAMES,
			};
		});

		// The cached reference is reused every frame: getAnimations() should fire
		// at most a small constant number of times (ideally 0–1 in steady state),
		// NEVER proportional to the ~30 frames that elapsed. Pre-fix this was ~30.
		expect(result.calls).toBeLessThanOrEqual(2);
		expect(result.calls).toBeLessThan(result.frames);
	});
});
