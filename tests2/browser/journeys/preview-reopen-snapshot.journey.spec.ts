import { test, expect, openApp, navigateToHash, createSession, deleteSession, sendMessage, waitForSessionStatus } from "../_helpers/journey-fixture.js";

const SNAPSHOT_SIZE = 32 * 1024 + 1;
const PREVIEW_TEXT = "x".repeat(64);
const FILE_MODE_ENTRY = `compact-${"x".repeat(210)}.HTML`;
const FILE_MODE_TAB_ID = `preview:entry:${encodeURIComponent(FILE_MODE_ENTRY)}`;

test.describe("Journey: Preview snapshot reopen", () => {
	test("reopens a truncated transcript preview snapshot after reload", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();

		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// The mock agent emits an inline v1 snapshot. This size forces the
			// transcript representation to be truncated, so Open must retrieve the
			// full historical block after the reload rather than using inline text.
			await sendMessage(page, `PREVIEW_OPEN_SNAPSHOT SIZE=${SNAPSHOT_SIZE}`);
			await waitForSessionStatus(sessionId, "idle");
			const openButton = page.getByTestId("preview-open-button").last();
			await expect(openButton, "the completed preview_open result should render a reopen card").toBeVisible({ timeout: 20_000 });
			await expect(openButton, "the captured snapshot should be reopenable").toBeEnabled();

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const restoredOpenButton = page.getByTestId("preview-open-button").last();
			await expect(restoredOpenButton, "the historical preview card should survive transcript reload").toBeVisible({ timeout: 20_000 });
			await expect(restoredOpenButton).toBeEnabled();

			await restoredOpenButton.click();
			const preview = page.frameLocator(".goal-preview-panel iframe").first();
			await expect(preview.locator("body"), "Open should restore the historical snapshot into the side-panel iframe").toContainText(PREVIEW_TEXT, { timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("reopens an artifact-backed compact v3 snapshot after reload", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();

		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// The mock runs the real preview-mount endpoint, which persists an
			// immutable artifact. Its full v3 metadata marker is intentionally over
			// 250 bytes, so the writer-equivalent fixture records the compact
			// `/preview/<sessionId>/` URL alongside the explicit entry instead.
			await sendMessage(page, "PREVIEW_OPEN_ARTIFACT_COMPACT_SNAPSHOT");
			await waitForSessionStatus(sessionId, "idle");
			const openButton = page.getByTestId("preview-open-button").last();
			await expect(openButton, "the compact v3 artifact snapshot should render a reopen card").toBeVisible({ timeout: 20_000 });
			await expect(openButton, "the compact v3 artifact snapshot should be reopenable").toBeEnabled();

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const restoredOpenButton = page.getByTestId("preview-open-button").last();
			await expect(restoredOpenButton, "the compact v3 artifact card should survive transcript reload").toBeVisible({ timeout: 20_000 });
			await expect(restoredOpenButton).toBeEnabled();

			await restoredOpenButton.click();
			const preview = page.frameLocator(".goal-preview-panel iframe").first();
			await expect(preview.locator("body"), "Open should restore the historical artifact into the side-panel iframe").toContainText("Artifact Compact Snapshot Restored Content", { timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("reopens a file-mode artifact with nested assets from an entry-omitted compact marker", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();

		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// The mock creates a real source file below a source subdirectory, declares
			// its nested asset, posts file mode to the real mount/artifact endpoint, and
			// deletes the source. The production builder must therefore use its compact
			// entry-omitted variant while retaining both restore identities.
			await sendMessage(page, "PREVIEW_OPEN_ARTIFACT_FILE_COMPACT_SNAPSHOT");
			await waitForSessionStatus(sessionId, "idle");
			const openButton = page.getByTestId("preview-open-button").last();
			await expect(openButton, "the entry-omitted artifact snapshot should render a reopen card").toBeVisible({ timeout: 20_000 });
			await expect(openButton, "the entry-omitted artifact snapshot should be reopenable").toBeEnabled();

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const restoredOpenButton = page.getByTestId("preview-open-button").last();
			await expect(restoredOpenButton, "the file-mode artifact card should survive transcript reload").toBeVisible({ timeout: 20_000 });
			await expect(restoredOpenButton).toBeEnabled();

			// Rehydration must register the snapshot automatically, before the user
			// clicks Open. It must preserve the complete long filename, not a compact
			// marker placeholder or a truncated source-path label.
			await expect(page.locator(`[data-panel-tab-id="${FILE_MODE_TAB_ID}"]`), "the rehydrated compact marker should register its original entry tab").toHaveCount(1, { timeout: 20_000 });
			const preview = page.frameLocator(".goal-preview-panel iframe").first();
			await expect(preview.locator("body"), "automatic rehydration should display the original file entry").toContainText("Artifact File Compact Snapshot Restored Content", { timeout: 20_000 });
			await expect(preview.locator("#nested-proof"), "automatic rehydration should retain the declared nested asset").toHaveCSS("color", "rgb(12, 34, 56)", { timeout: 20_000 });

			await restoredOpenButton.click();
			await expect(preview.locator("body"), "manual Open should restore the exact artifact after its source was removed").toContainText("Artifact File Compact Snapshot Restored Content", { timeout: 20_000 });
			await expect(preview.locator("#nested-proof"), "manual Open should restore nested assets with the artifact").toHaveCSS("color", "rgb(12, 34, 56)", { timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
