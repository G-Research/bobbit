/**
 * Journey: Review artifacts: review commenting, attachments, preview, and compaction.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../../../tests2/browser/_helpers/journey-fixture.js";
import { sendMessage, apiFetch } from "../../../tests2/browser/_helpers/journey-fixture.js";
import fs from "node:fs";
import path from "node:path";

test.describe("Journey: Review Commenting", () => {
	test("REVIEW_OPEN trigger shows a Review tab in the side panel", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
			const beforeCount = await doneMessages.count().catch(() => 0);
			await sendMessage(page, "REVIEW_OPEN");
			await expect.poll(() => doneMessages.count(), { timeout: 20_000 }).toBeGreaterThan(beforeCount);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" }).first();
			await expect(reviewTab).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("Review tab click shows review-document with mock content", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
			const beforeCount = await doneMessages.count().catch(() => 0);
			await sendMessage(page, "REVIEW_OPEN");
			await expect.poll(() => doneMessages.count(), { timeout: 20_000 }).toBeGreaterThan(beforeCount);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" }).first();
			await expect(reviewTab).toBeVisible({ timeout: 20_000 });
			await reviewTab.click();
			const reviewDoc = page.locator("review-document").first();
			await expect(reviewDoc).toBeVisible({ timeout: 15_000 });
			await expect(reviewDoc.getByText("Some important text").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	// Ported from review-pane.spec.ts (audit: misc PARTIAL / BR59): clicking
	// Approve in the review pane posts review feedback to the agent chat and
	// closes the Review tab.
	test("Approve in the review pane posts feedback to chat and closes the Review tab", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
			const beforeCount = await doneMessages.count().catch(() => 0);
			await sendMessage(page, "REVIEW_OPEN");
			await expect.poll(() => doneMessages.count(), { timeout: 20_000 }).toBeGreaterThan(beforeCount);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" }).first();
			await expect(reviewTab).toBeVisible({ timeout: 20_000 });
			await reviewTab.click();
			await expect(page.locator("review-document").first()).toBeVisible({ timeout: 15_000 });
			// Approve → feedback posted to chat, Review tab closes.
			await page.getByRole("button", { name: "Approve", exact: true }).click();
			await expect(page.locator("user-message").filter({ hasText: /approv/i }).last()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(".goal-tab-pill", { hasText: "Review" })).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

// Ported from image-attach-roundtrip.spec.ts (audit: misc GAP / BR60): an
// attached image renders a tile in the composer and, after ECHO_IMAGE_BLOCK,
// in the sent user message.
test.describe("Journey: Image Attachment", () => {
	const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	test("attached image renders a tile in the composer and in the sent message", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.locator('message-editor input[type="file"]').setInputFiles({
				name: "pic.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64"),
			});
			await expect(page.locator("message-editor attachment-tile").first()).toBeVisible({ timeout: 10_000 });
			const textarea = page.locator("message-editor textarea").first();
			await textarea.fill("ECHO_IMAGE_BLOCK here is a picture");
			await textarea.press("Enter");
			// The sent user message must render the image attachment tile.
			await expect(page.locator("user-message attachment-tile").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

test.describe("Journey: Preview Artifacts", () => {
	test("preview mount via API reaches client state and iframe renders", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(patchResp.status).toBe(200);
			await expect.poll(
				() => page.evaluate(() => {
					const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
					return s?.isPreviewSession === true;
				}),
				{ timeout: 20_000 },
			).toBe(true);
			await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
				s.previewPanelActiveTab = "preview";
			});
			const mountResp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!DOCTYPE html><body>journey-preview</body>", entry: "journey.html" }),
			});
			expect(mountResp.status).toBe(200);
			const mountBody = await mountResp.json() as { entry: string; mtime: number; artifactId: string };
			expect(mountBody.entry).toBe("journey.html");
			expect(mountBody.mtime).toBeGreaterThan(0);
			expect(mountBody.artifactId).toBeTruthy();
			await expect.poll(
				() => page.evaluate(() => {
					const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
					return s?.previewPanelEntry || "";
				}),
				{ timeout: 20_000 },
			).toBe("journey.html");
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible({ timeout: 20_000 });
			await expect(iframe, "preview iframe should expose an absolute gateway URL").toHaveAttribute("src", /^https?:\/\//);
			const src = await iframe.getAttribute("src");
			const srcUrl = new URL(src!);
			const gatewayOrigin = new URL(page.url()).origin;
			expect(srcUrl.origin, "preview iframe should stay on the active gateway origin").toBe(gatewayOrigin);
			expect(srcUrl.pathname).toBe(`/preview/${encodeURIComponent(sessionId)}/_artifact/${encodeURIComponent(mountBody.artifactId)}/journey.html`);
			expect([...srcUrl.searchParams.keys()], "preview iframe should carry only the cache buster").toEqual(["mtime"]);
			expect(srcUrl.searchParams.get("mtime")).toMatch(/^\d+$/);
			expect(srcUrl.hash).toBe("");
			// Ported from preview-happy-path.spec.ts (BR52): the open-in-new-tab
			// anchor href must NOT carry a cache-buster; Refresh must bump the mtime.
			const link = page.locator('a[title="Open preview in new tab"]').first();
			await expect(link).toBeVisible({ timeout: 10_000 });
			await expect(link, "preview popout should expose an absolute gateway URL").toHaveAttribute("href", /^https?:\/\//);
			const href = await link.getAttribute("href");
			const hrefUrl = new URL(href!);
			expect(hrefUrl.origin, "preview popout should stay on the active gateway origin").toBe(gatewayOrigin);
			expect(hrefUrl.pathname).toBe(`/preview/${encodeURIComponent(sessionId)}/_artifact/${encodeURIComponent(mountBody.artifactId)}/journey.html`);
			expect(hrefUrl.search, "preview popout must not carry the iframe cache buster").toBe("");
			expect(hrefUrl.hash).toBe("");
			const refresh = page.locator('button[title="Refresh preview"]').first();
			await expect(refresh).toBeVisible({ timeout: 10_000 });
			await refresh.click();
			await expect.poll(async () => await iframe.getAttribute("src"), { timeout: 5_000 }).not.toEqual(src);
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Compaction", () => {
	// Ported from compaction-persistence.spec.ts (audit: misc GAP / BR53): a
	// seeded compaction sidecar splices a rich summary row into the snapshot; the
	// renderer must show the card (data-state complete) and it must survive reload.
	test("seeded compaction sidecar renders the summary card and survives reload", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			// Seed one success sidecar entry (→ complete card). Mirrors the legacy setup.
			const dir = path.join(gateway.bobbitDir, "state", "compaction-sidecar");
			fs.mkdirSync(dir, { recursive: true });
			const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
			const line = JSON.stringify({
				schemaVersion: 1, id: "c_journey_1", trigger: "manual",
				tokensBefore: 50_000, tokensAfter: null, durationMs: 1000,
				startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
				success: true, firstKeptEntryId: null,
			}) + "\n";
			fs.appendFileSync(path.join(dir, `${safe}.jsonl`), line, "utf-8");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const card = page.locator("[data-testid='compaction-summary-card']");
			await expect(card).toHaveCount(1, { timeout: 15_000 });
			await expect(card).toHaveAttribute("data-state", "complete");
			// Sidecar must still anchor the card after a full reload.
			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(card).toHaveCount(1, { timeout: 20_000 });
			await expect(card).toHaveAttribute("data-state", "complete");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
