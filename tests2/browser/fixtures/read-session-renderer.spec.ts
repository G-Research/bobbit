import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./build-bundle.js";

const SHELL = path.resolve("tests2/browser/fixtures/read-session-renderer.html");
const ENTRY = path.resolve("tests2/browser/fixtures/read-session-renderer-entry.ts");
const RENDERER = path.resolve("src/ui/tools/renderers/ReadSessionRenderer.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "read-session-renderer-bundle.js");
const SESSION_ID_PREFIX = "read-session-control-prefix-".padEnd(64, "x");
const SESSION_ID = `${SESSION_ID_PREFIX}-exact-target`;
const COLLIDING_SESSION_ID = `${SESSION_ID_PREFIX}-different-target`;
const RAW_SENTINEL = "UNBOUNDED_RAW_PROVIDER_RESULT_MUST_STAY_HIDDEN";

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER] });
});

test("canonical read_session card, direct modal, and reload stay bounded", async ({ page }) => {
	expect(SESSION_ID.length).toBeGreaterThan(64);
	expect(SESSION_ID.slice(0, 64)).toBe(COLLIDING_SESSION_ID.slice(0, 64));
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.waitForFunction(() => (window as any).__readSessionFixtureReady === true);

	const card = page.getByTestId("read-session-card");
	await expect(card).toContainText("1 of 5");
	await expect(card).toContainText("partial");
	await expect(card.locator(`a[href="#/session/${SESSION_ID}"]`)).toHaveCount(1);
	await expect(card.locator(`a[href="#/session/${SESSION_ID_PREFIX}"]`)).toHaveCount(0);
	await expect(card.locator(`a[href="#/session/${COLLIDING_SESSION_ID}"]`)).toHaveCount(0);
	await expect(page.locator("body")).not.toContainText(RAW_SENTINEL);

	await card.locator(":scope > button").click();
	await expect(card.getByTestId("read-session-continuation")).toContainText("continue at offset 3");
	await expect(card.getByTestId("read-session-author")).toHaveText("Fixture Reviewer");
	await expect(card.getByTestId("read-session-tool-call")).toContainText('read_session({"limit":2})');
	await expect(card.getByTestId("read-session-tool-result")).toContainText("array · 9000 chars · 120 lines · 9400 bytes · 8 blocks");
	await expect(card.getByTestId("read-session-tool-result")).toContainText("output omitted");

	await card.getByTestId("read-session-open-full").click();
	const modal = page.getByTestId("read-session-transcript-modal");
	await expect(modal).toBeVisible();
	await expect(modal).toContainText("Direct REST Author");
	await expect(modal).toContainText("<direct-rest-row>escaped</direct-rest-row>");
	await expect(modal.locator("direct-rest-row")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).__readSessionFetchOffsets)).toEqual(["0"]);
	await expect.poll(() => page.evaluate(() => (window as any).__readSessionFetchSessionIds)).toEqual([SESSION_ID]);
	await expect(page.locator("body")).not.toContainText(RAW_SENTINEL);

	await page.reload();
	await page.waitForFunction(() => (window as any).__readSessionFixtureReady === true);
	const reloadedCard = page.getByTestId("read-session-card");
	await expect(reloadedCard).toContainText("1 of 5");
	await reloadedCard.locator(":scope > button").click();
	await expect(reloadedCard.getByTestId("read-session-tool-result")).toContainText("output omitted");
	await expect(page.locator("body")).not.toContainText(RAW_SENTINEL);
});
