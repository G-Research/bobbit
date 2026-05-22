/**
 * Regression: streaming re-renders must not restart the bobbit canvas eye loop.
 * A fresh Lit function ref on every render used to detach/reattach the same
 * <canvas>, resetting it to the center-eye frame on each streamed token.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/streaming-bobbit-canvas-ref.html");
const BUNDLE = path.resolve("tests/fixtures/streaming-bobbit-canvas-ref-bundle.js");
const ENTRY = path.resolve("tests/fixtures/streaming-message-container-entry.ts");
const SOURCES = [
	ENTRY,
	path.resolve("src/ui/components/StreamingMessageContainer.ts"),
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

test.describe("Streaming bobbit canvas eye animation", () => {
	test("keeps the existing canvas animation across streaming re-renders", async ({ page }) => {
		await page.addInitScript(() => {
			(window as any).__drawImageCount = 0;
			const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
			CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
				(window as any).__drawImageCount = ((window as any).__drawImageCount ?? 0) + 1;
				return Reflect.apply(originalDrawImage, this, args);
			} as any;
			// Freeze the JS animation loop so drawImage() only counts animation starts.
			window.requestAnimationFrame = (() => 1) as any;
			window.cancelAnimationFrame = (() => undefined) as any;
		});

		await page.goto(fileUrl(FIXTURE));
		await page.waitForFunction(() => (window as any).__ready === true);

		await page.evaluate(async () => {
			const host = document.getElementById("host")!;
			const el: any = document.createElement("streaming-message-container");
			el.isStreaming = true;
			host.appendChild(el);
			(window as any).__el = el;
			await el.updateComplete;

			// Skip entry animation; this test targets steady-state streaming rerenders.
			el._blobState = "active";
			await el.updateComplete;
			(window as any).__drawImageCount = 0;
		});

		for (let i = 0; i < 5; i++) {
			await page.evaluate(async () => {
				const el: any = (window as any).__el;
				el.requestUpdate();
				await el.updateComplete;
			});
		}

		const result = await page.evaluate(() => ({
			drawImageCount: (window as any).__drawImageCount,
			canvasCount: document.querySelectorAll("canvas.bobbit-blob__sprite").length,
		}));

		expect(result.canvasCount).toBe(1);
		expect(result.drawImageCount).toBe(0);
	});
});
