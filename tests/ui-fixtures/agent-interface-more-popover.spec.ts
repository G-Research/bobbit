import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

// UX-04 (Fable audit): the bg-process pill strip's "N more" popover has no
// Escape/keyboard dismissal (unlike SidebarActionsPopover, which closes on
// Escape), and its deferred click-outside listener can leak when the popover
// is toggled open+closed faster than an animation frame. This spec drives the
// real <agent-interface> component's production popover code
// (_toggleMore / _handleMoreClickOutside / _handleMoreKeyDown in
// src/ui/components/AgentInterface.ts) rather than a mock of it.

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/agent-interface-more-popover-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "agent-interface-more-popover-bundle.js");
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC],
	});
});

async function loadFixture(page: Page, options?: { isStreaming?: boolean; processCount?: number; visibleCount?: number }): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__agentInterfaceMorePopoverReady === true, null, { timeout: 10_000 });
	await page.evaluate((opts) => (window as any).__mountAgentInterfaceMorePopoverFixture(opts ?? {}), options ?? {});
	await page.waitForSelector("agent-interface [data-more-btn]", { timeout: 10_000 });
	return errors;
}

test.describe("UX-04: bg-process 'More' popover keyboard dismissal and listener hygiene", () => {
	test("clicking the toggle opens the popover", async ({ page }) => {
		await loadFixture(page);
		expect(await page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(false);

		await page.evaluate(() => (window as any).__clickMoreToggle());

		expect(await page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(true);
	});

	test("Escape closes the open popover", async ({ page }) => {
		const errors = await loadFixture(page);
		await page.evaluate(() => (window as any).__clickMoreToggle());
		await expect.poll(() => page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(true);
		// The click-outside/keydown listeners attach on a deferred rAF (see
		// _toggleMore) — wait for both to actually be attached before pressing
		// Escape, otherwise this races the rAF under parallel-worker load.
		await expect.poll(() => page.evaluate(() => (window as any).__getNetMoreListenerCount())).toBe(2);

		await page.keyboard.press("Escape");

		await expect.poll(() => page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(false);
		expect(errors.filter((line) => !/favicon|ResizeObserver loop/i.test(line))).toEqual([]);
	});

	test("Escape on the open popover during a streaming session closes it WITHOUT aborting the session", async ({ page }) => {
		await loadFixture(page, { isStreaming: true });
		await page.evaluate(() => (window as any).__clickMoreToggle());
		await expect.poll(() => page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(true);
		await expect.poll(() => page.evaluate(() => (window as any).__getNetMoreListenerCount())).toBe(2);

		await page.keyboard.press("Escape");

		await expect.poll(() => page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(false);
		// The popover being open must suppress AgentInterface's own
		// window-level Escape-aborts-the-agent handler (mirrors the UX-01
		// guard for confirm/error dialogs), same as SidebarActionsPopover does.
		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(0);
	});

	test("control: Escape with the popover closed and a streaming session DOES abort (guard is not overbroad)", async ({ page }) => {
		await loadFixture(page, { isStreaming: true });
		expect(await page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(false);

		await page.keyboard.press("Escape");

		expect(await page.evaluate(() => (window as any).__getAbortCallCount())).toBe(1);
	});

	test("no orphaned document listener after opening and closing within the same frame", async ({ page }) => {
		await loadFixture(page);
		expect(await page.evaluate(() => (window as any).__getNetMoreListenerCount())).toBe(0);

		// Synthetic double-click: open then close before the deferred rAF that
		// attaches the click-outside/keydown listeners has run. Per the
		// finding, this isn't reachable via real human input (a real click
		// pair is never sub-frame) but is exactly the timing the finding
		// describes, and is worth pinning defensively.
		await page.evaluate(() => (window as any).__dispatchSyntheticDoubleClickOnMoreToggle());
		// Let the queued rAF (and any follow-up microtasks) actually run.
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		expect(await page.evaluate(() => (window as any).__isMorePopoverOpen())).toBe(false);
		expect(await page.evaluate(() => (window as any).__getNetMoreListenerCount())).toBe(0);
	});
});
