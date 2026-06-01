/**
 * Renderer-level test for <user-message> (WP1 / RC2 / S6).
 *
 * Pins that UserMessage renders image tiles from a user message's
 * server-authoritative {type:"image"} content blocks — the branch that was
 * missing on master (S6), where a bare role:"user" echo with image content
 * rendered text-only and the image only "healed" on reload.
 *
 * Pattern mirrors tests/ask-user-choices-renderer.spec.ts (file:// fixture +
 * esbuild-on-demand bundle). The bundle is large (Messages.ts pulls the app
 * graph) so it is gitignored and built on demand here.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/user-message-image-render.html");
const BUNDLE = path.resolve("tests/fixtures/user-message-image-render-bundle.js");
const ENTRY = path.resolve("tests/fixtures/user-message-image-render-entry.ts");
const MESSAGES_SRC = path.resolve("src/ui/components/Messages.ts");
const TILE_SRC = path.resolve("src/ui/components/AttachmentTile.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(MESSAGES_SRC).mtimeMs,
		fs.statSync(TILE_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;
// Tiny valid-ish base64 payload — the render only inspects the src prefix + tile presence.
const DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("UserMessage renders image tiles from authoritative content (WP1/RC2/S6)", () => {
	test("role:user + one image block + no attachments → exactly one tile, data:image/png src", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((data) => {
			(window as any).__renderUserMessage(document.getElementById("container"), {
				role: "user",
				content: [{ type: "text", text: "hi" }, { type: "image", data, mimeType: "image/png" }],
				timestamp: 0,
			});
		}, DATA);
		await expect(page.locator("#container attachment-tile")).toHaveCount(1);
		const src = await page.locator("#container attachment-tile img").first().getAttribute("src");
		expect(src?.startsWith("data:image/png;base64,")).toBeTruthy();
	});

	test("role:user with NO image block → zero tiles (default path unchanged)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderUserMessage(document.getElementById("container"), {
				role: "user",
				content: [{ type: "text", text: "no image here" }],
				timestamp: 0,
			});
		});
		await expect(page.locator("#container attachment-tile")).toHaveCount(0);
	});

	test("JPEG content block → data:image/jpeg src (block's own mimeType, not hardcoded png)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((data) => {
			(window as any).__renderUserMessage(document.getElementById("container"), {
				role: "user",
				content: [{ type: "image", data, mimeType: "image/jpeg" }],
				timestamp: 0,
			});
		}, DATA);
		const src = await page.locator("#container attachment-tile img").first().getAttribute("src");
		expect(src?.startsWith("data:image/jpeg;base64,")).toBeTruthy();
	});

	test("user-with-attachments with BOTH attachments AND image content → tiles from attachments (rich wins, no double)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((data) => {
			(window as any).__renderUserMessage(document.getElementById("container"), {
				role: "user-with-attachments",
				content: [{ type: "text", text: "hi" }, { type: "image", data, mimeType: "image/png" }],
				attachments: [
					{ id: "a", type: "image", fileName: "rich.png", mimeType: "image/png", size: 1, content: data, preview: data },
				],
				timestamp: 0,
			});
		}, DATA);
		// Rich attachments win → exactly ONE tile, not two (content + attachments).
		await expect(page.locator("#container attachment-tile")).toHaveCount(1);
	});
});
