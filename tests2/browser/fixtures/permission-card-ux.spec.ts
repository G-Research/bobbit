import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/permission-card-ux.html");
const ENTRY = path.resolve("tests/fixtures/permission-card-ux-entry.ts");
const BUNDLE = path.resolve("tests/fixtures/permission-card-ux-bundle.js");
const PAGE = `file://${FIXTURE}`;
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");
const TOOL_PERMISSION_CARD_SRC = path.resolve("src/ui/components/ToolPermissionCard.ts");

const PINNED_SEL = "[data-permission-pinned], [data-pinned-permission-controls], .pinned-permission-controls";
const PINNED_CARD_SEL = "[data-permission-pinned] tool-permission-card, [data-pinned-permission-controls] tool-permission-card, .pinned-permission-controls tool-permission-card";

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC, TOOL_PERMISSION_CARD_SRC],
	});
});

async function loadFixture(page: Page) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__permissionCardUxReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__scrollPermissionFixtureToBottom());
}

async function expectPinnedVisible(page: Page) {
	const probe = await page.evaluate(() => (window as any).__permissionFixtureGeometry());
	if (!probe.ok) {
		expect(probe.error || JSON.stringify(probe), "pinned permission controls not visible").toBe("ok");
	}
	await expect(page.locator(PINNED_SEL).first(), "pinned permission controls not visible").toBeVisible();
	await expect(page.locator(PINNED_CARD_SEL).first(), "pinned permission controls not visible").toBeVisible();
}

test.describe("Permission Card UX pinned browser fixture", () => {
	test("keeps bottom-pinned permission controls visible with a scrolled transcript and clear of the editor", async ({ page }) => {
		await loadFixture(page);
		await expectPinnedVisible(page);

		const probe = await page.evaluate(() => (window as any).__permissionFixtureGeometry());
		expect(probe.visible, "pinned permission controls should remain inside the chat viewport").toBe(true);
		expect(probe.overlapsEditor, "pinned permission controls must not overlap the message editor/status/safe-area").toBe(false);
	});

	test("grant and deny from pinned controls use session payloads once, settle pinned stack, and keep inline history", async ({ page }) => {
		await loadFixture(page);
		await expectPinnedVisible(page);

		const pinnedCards = page.locator(PINNED_CARD_SEL);
		await pinnedCards.first().getByRole("button", { name: /Allow just/i }).click();
		await pinnedCards.first().getByRole("button", { name: /Allow just/i }).click({ force: true }).catch(() => undefined);

		let calls = await page.evaluate(() => (window as any).__permissionFixtureSession().grantCalls);
		expect(calls, "duplicate pinned grants should be suppressed").toHaveLength(1);
		expect(calls[0]).toMatchObject({ toolName: "Bash", scope: "tool", group: "Shell", mode: "session-only" });

		const denyCard = page.locator(PINNED_CARD_SEL).filter({ hasText: "Edit" }).first();
		await denyCard.getByRole("button", { name: /Deny/i }).click();
		const denyCalls = await page.evaluate(() => (window as any).__permissionFixtureSession().denyCalls);
		expect(denyCalls.at(-1)).toMatchObject({ id: "perm-edit", toolName: "Edit" });

		await expect(page.locator(PINNED_CARD_SEL).filter({ hasText: "Edit" }), "denied permission should leave pinned stack").toHaveCount(0);
		await expect(page.locator("tool-permission-card").filter({ hasText: /denied|Edit/i }).first(), "inline denied permission history should remain").toBeVisible();
	});

	test("reconnect replay and alive-socket remount derive pinned controls from current rows", async ({ page }) => {
		await loadFixture(page);
		await expectPinnedVisible(page);

		await page.evaluate(() => (window as any).__permissionFixtureRemountWithoutReplay());
		await page.evaluate(() => (window as any).__scrollPermissionFixtureToBottom());
		await expectPinnedVisible(page);
	});
});
