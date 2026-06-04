/**
 * Browser E2E tests for the `@`-mention file reference UI.
 *
 * Covers (per AGENTS.md E2E coverage requirement + design §8.4):
 *   1. autocomplete  — typing `@` shows a file menu; filter narrows; ↑/↓ + Enter
 *                      selects and inserts `@<path> `.
 *   2. happy path    — sending a message with an `@text-file` renders a
 *                      `<file-mention-chip>`; clicking it expands the snapshot.
 *   3. image routing — an `@image` reference renders an attachment tile (image
 *                      frame), not inlined text.
 *   4. persistence   — chip + literal `@path` survive a page reload (sidecar).
 *   5. degradation   — an unresolvable `@nope.txt` is sent as literal text with
 *                      no chip and no crash.
 *
 * NOTE: This test depends on the server-side producer (`/api/file-mentions`
 * endpoint + `resolveFileMentions` in the WS handler) that snapshots
 * `fileMentions` into the broadcast user message. It is intended to run only
 * after the server-side branch for this goal has merged into the goal branch.
 * Against an older server it will fail at the menu/chip steps — that is the
 * intended signal that the server change has not landed yet.
 */
import { test, expect } from "../gateway-harness.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const TEXT_FILE = "notes.txt";
const TEXT_MARKER = "AT_MENTION_E2E_TEXT_MARKER_BODY";
const IMAGE_FILE = "pic.png";
// 1x1 transparent PNG.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Create the file fixtures the server enumerates / resolves under `cwd`. */
function writeFixtures(cwd: string) {
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, TEXT_FILE), `${TEXT_MARKER}\nsecond line\n`);
	writeFileSync(join(cwd, IMAGE_FILE), Buffer.from(PNG_BASE64, "base64"));
}

/** Locator: the user-message bubble in the chat. */
function userBubble(page: import("@playwright/test").Page) {
	return page.locator("user-message").first();
}

/** Locator: a FileMentionChip pill. The `<file-mention-chip>` host uses
 *  `display: contents` inline, so target the inner `.file-mention-chip-pill`. */
function fileChip(page: import("@playwright/test").Page) {
	return page.locator(".file-mention-chip-pill").first();
}

/** Create a session bound to `cwd` and navigate the app to it. */
async function openSession(page: import("@playwright/test").Page, cwd: string): Promise<string> {
	const created = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd }),
	});
	const { id: sessionId } = await created.json();
	expect(sessionId).toBeTruthy();
	await openApp(page);
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	return sessionId;
}

test.describe("@-mention file references UI", () => {
	test("typing @ shows menu, filters, ↑/↓ + Enter inserts @<path>", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtures(cwd);
		await openSession(page, cwd);

		const textarea = page.locator("textarea").first();
		await textarea.click();

		// Type "@" — a file menu should appear (populated by the server fetch).
		await textarea.pressSequentially("@");
		await expect(page.locator(".at-menu")).toBeVisible({ timeout: 15_000 });

		// Filter to the text fixture.
		await textarea.pressSequentially("notes");
		const item = page.locator(`[data-testid="file-mention-${TEXT_FILE}"]`);
		await expect(item).toBeVisible({ timeout: 10_000 });

		// ↓ then Enter selects the highlighted item and inserts "@notes.txt ".
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowUp"); // back to first
		await page.keyboard.press("Enter");

		await expect(textarea).toHaveValue(`@${TEXT_FILE} `, { timeout: 10_000 });
		await expect(page.locator(".at-menu")).toHaveCount(0);
	});

	test("sending @text-file renders a chip; click expands the snapshot", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtures(cwd);
		await openSession(page, cwd);

		await sendMessage(page, `please read @${TEXT_FILE} carefully`);

		// (1) bubble shows the literal user text.
		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		await expect(userBubble(page)).toContainText(`@${TEXT_FILE}`, { timeout: 15_000 });

		// (2) chip rendered; snapshot collapsed by default.
		const chip = fileChip(page);
		await expect(chip).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(TEXT_MARKER).first()).toHaveCount(0);

		// (3) click expands the snapshot body.
		await chip.click();
		await expect(page.getByText(TEXT_MARKER).first()).toBeVisible({ timeout: 5_000 });

		// (4) reload — chip + literal text persist (replay from sidecar).
		await page.reload();
		await expect(userBubble(page)).toBeVisible({ timeout: 20_000 });
		await expect(userBubble(page)).toContainText(`@${TEXT_FILE}`);
		await expect(fileChip(page)).toBeVisible({ timeout: 10_000 });
	});

	test("sending @image renders an attachment tile, not inlined text", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtures(cwd);
		await openSession(page, cwd);

		await sendMessage(page, `look at @${IMAGE_FILE}`);

		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		// Image references route through the attachment/image frame — an image tile
		// (or rendered <img>) appears in the bubble rather than inlined bytes.
		await expect(
			page.locator("attachment-tile img, user-message img").first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("unresolvable @nope.txt sends as literal text with no chip or crash", async ({ page }) => {
		const cwd = nonGitCwd();
		writeFixtures(cwd);
		await openSession(page, cwd);

		await sendMessage(page, "this references @nope.txt which does not exist");

		await expect(userBubble(page)).toBeVisible({ timeout: 15_000 });
		await expect(userBubble(page)).toContainText("@nope.txt");
		// No chip for an unresolved reference rendered as plain text.
		await expect(page.locator(".file-mention-chip-pill")).toHaveCount(0);
	});
});
