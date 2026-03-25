import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file:///${path.resolve("tests/fixtures/palette-css.html").replace(/\\/g, "/")}`;

test.describe("palette CSS custom properties", () => {
  test("default (forest) palette values are applied", async ({ page }) => {
    await page.goto(FIXTURE);
    const val = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--notif-system-bg").trim()
    );
    expect(val).toContain("100");
    expect(val).toContain("120");
    expect(val).toContain("160");
  });

  test("ocean palette overrides custom properties", async ({ page }) => {
    await page.goto(FIXTURE);
    await page.evaluate(() => {
      document.documentElement.dataset.palette = "ocean";
    });
    const val = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--notif-system-bg").trim()
    );
    expect(val).toContain("60");
    expect(val).toContain("120");
    expect(val).toContain("190");
  });

  test("mono palette overrides custom properties", async ({ page }) => {
    await page.goto(FIXTURE);
    await page.evaluate(() => {
      document.documentElement.dataset.palette = "mono";
    });
    const val = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--user-msg-accent").trim()
    );
    expect(val).toContain("156");
    expect(val).toContain("163");
    expect(val).toContain("175");
  });

  test("removing palette resets to forest defaults", async ({ page }) => {
    await page.goto(FIXTURE);
    // Set ocean
    await page.evaluate(() => { document.documentElement.dataset.palette = "ocean"; });
    // Verify it changed
    let val = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--user-msg-accent").trim()
    );
    expect(val).toContain("50");
    expect(val).toContain("150");
    expect(val).toContain("140");
    // Remove palette
    await page.evaluate(() => { delete document.documentElement.dataset.palette; });
    val = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--user-msg-accent").trim()
    );
    expect(val).toContain("80");
    expect(val).toContain("140");
    expect(val).toContain("80");
  });

  test("computed styles on elements change with palette", async ({ page }) => {
    await page.goto(FIXTURE);
    // Forest default
    let bg = await page.evaluate(() =>
      getComputedStyle(document.getElementById("system-box")!).backgroundColor
    );
    expect(bg).toContain("100");

    // Switch to ocean
    await page.evaluate(() => { document.documentElement.dataset.palette = "ocean"; });
    bg = await page.evaluate(() =>
      getComputedStyle(document.getElementById("system-box")!).backgroundColor
    );
    expect(bg).toContain("60");
  });
});
