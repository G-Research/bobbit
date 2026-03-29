import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/render-debounce.html",
);

test.describe("renderApp debounce", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${fixturePath}`);
  });

  test("multiple renderApp() calls in one frame produce a single render", async ({ page }) => {
    const count = await page.evaluate(async () => {
      window.resetCount();
      window.renderApp();
      window.renderApp();
      window.renderApp();
      window.renderApp();
      window.renderApp();
      // Wait for rAF to fire
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.renderCount;
    });
    expect(count).toBe(1);
  });

  test("renderAppSync() executes immediately", async ({ page }) => {
    const count = await page.evaluate(() => {
      window.resetCount();
      window.renderAppSync();
      return window.renderCount;
    });
    expect(count).toBe(1);
  });

  test("renderAppSync() cancels pending rAF render flag but rAF callback still fires", async ({ page }) => {
    const count = await page.evaluate(async () => {
      window.resetCount();
      window.renderApp(); // schedules rAF, sets _renderScheduled=true
      window.renderAppSync(); // sets _renderScheduled=false, calls doRender() => count=1
      // The rAF callback still fires: sets _renderScheduled=false (already false), calls doRender() => count=2
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.renderCount;
    });
    expect(count).toBe(2);
  });

  test("renderApp() after rAF fires triggers a new render", async ({ page }) => {
    const count = await page.evaluate(async () => {
      window.resetCount();
      window.renderApp();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // First rAF cycle done, count should be 1
      window.renderApp();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.renderCount;
    });
    expect(count).toBe(2);
  });
});
