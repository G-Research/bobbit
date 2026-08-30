/**
 * Full-stack SMOKE coverage for the user-attached-image round-trip (WP1 / RC2).
 *
 * Closes the P0 fidelity gap from docs/design/comms-stack/02-analysis.md §4:
 * the entire e2e tier had ZERO coverage of an image flowing composer → WS →
 * agent echo → transcript render → reload. This drives the real app over a
 * spawned gateway with the WP0 `ECHO_IMAGE_BLOCK` mock echo (so the agent
 * persists user image content blocks, exactly like the real pi-agent).
 *
 * Scope note: this is SMOKE, not the fix's red→green pin. A single idle image
 * send renders the tile on master too (optimistic row + snapshot
 * enrichUserMessage both predate the fix); the fix only changes the
 * concurrent-prompt RACE. The faithful red→green pins live in
 * tests/user-message-image-render.spec.ts and tests/message-reducer-image.test.ts.
 * The deterministic-race e2e is a tracked follow-up (needs the USER_ECHO_DELAY
 * gate to clobber the slot mid-flight without flaking).
 */
import { test, expect } from "./fixtures.js";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// 1x1 transparent PNG.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function createSessionViaApi(page: import("@playwright/test").Page): Promise<string> {
	const resp = await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify({ cwd: nonGitCwd() }) });
	const bodyText = await resp.text();
	expect(resp.status, `create session: ${bodyText}`).toBe(201);
	const sessionId = JSON.parse(bodyText).id as string;
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""), { timeout: 10_000 })
		.toBe(sessionId);
	return sessionId;
}

const TILE = "user-message attachment-tile";

test.describe("Image attach round-trip (WP1/RC2 full-stack smoke)", () => {
	test("attached image renders a transcript tile live AND survives reload", async ({ page }) => {
		await openApp(page);
		const sessionId = await createSessionViaApi(page);
		await page.waitForFunction(() => !!(window as any).__bobbitState?.remoteAgent?.connected, undefined, {
			timeout: 15_000,
		});

		// Attach an image in the composer.
		await page
			.locator('message-editor input[type="file"]')
			.first()
			.setInputFiles({ name: "pic.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") });
		await expect(page.locator("message-editor attachment-tile").first()).toBeVisible({ timeout: 10_000 });

		// ECHO_IMAGE_BLOCK → the mock echoes the user message WITH image content
		// blocks and persists them (so get_messages returns them on reload).
		const textarea = page.locator("textarea").first();
		await textarea.fill("ECHO_IMAGE_BLOCK here is a picture");
		await textarea.press("Enter");

		// Live: the transcript user-message shows an image tile.
		await expect(page.locator(TILE).first()).toBeVisible({ timeout: 15_000 });

		// Reload → snapshot path re-derives the tile from persisted image content.
		await page.reload();
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator(TILE).first()).toBeVisible({ timeout: 20_000 });
	});
});
