import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file:///${path.resolve("tests/fixtures/notification-renderer.html").replace(/\\/g, "/")}`;

test.describe("notification renderer", () => {
  test("renders correct DOM structure per category", async ({ page }) => {
    await page.goto(FIXTURE);
    const notifications = page.locator(".notification-inline");
    await expect(notifications).toHaveCount(5);

    // Check each category has the right class
    await expect(notifications.nth(0)).toHaveClass(/notification-system/);
    await expect(notifications.nth(1)).toHaveClass(/notification-task/);
    await expect(notifications.nth(2)).toHaveClass(/notification-team/);
    await expect(notifications.nth(3)).toHaveClass(/notification-error/);

    // Default (no category) should fall back to system
    await expect(notifications.nth(4)).toHaveClass(/notification-system/);
  });

  test("each notification has icon, text, and time spans", async ({ page }) => {
    await page.goto(FIXTURE);
    const first = page.locator(".notification-inline").first();
    await expect(first.locator(".notification-icon")).toHaveCount(1);
    await expect(first.locator(".notification-text")).toHaveCount(1);
    await expect(first.locator(".notification-time")).toHaveCount(1);
  });

  test("category icons are correct", async ({ page }) => {
    await page.goto(FIXTURE);
    const icons = page.locator(".notification-icon");
    await expect(icons.nth(0)).toHaveText("\u27F3"); // system
    await expect(icons.nth(1)).toHaveText("\u2713"); // task
    await expect(icons.nth(2)).toHaveText("\u25CF"); // team
    await expect(icons.nth(3)).toHaveText("\u2715"); // error
  });

  test("notification text content is rendered", async ({ page }) => {
    await page.goto(FIXTURE);
    const texts = page.locator(".notification-text");
    await expect(texts.nth(0)).toHaveText("Test system notification");
    await expect(texts.nth(1)).toHaveText("Test task notification");
    await expect(texts.nth(2)).toHaveText("Test team notification");
    await expect(texts.nth(3)).toHaveText("Test error notification");
  });
});
