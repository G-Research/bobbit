/**
 * Browser fixture test for <bell-toggle> — the header button that toggles the
 * agent-finish beep, mirroring the Settings preference.
 *
 * Asserts: default-on icon (Bell, no slash), click mutes (BellOff = bell with a
 * line through it) + persists the preference, title reflects state, and the
 * button syncs when the shared `bobbit-play-finish-sound-changed` event fires
 * from another surface (e.g. the Settings checkbox).
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/bell-toggle.html");
const BUNDLE = path.resolve("tests/fixtures/bell-toggle-bundle.js");
const ENTRY = path.resolve("tests/fixtures/bell-toggle-entry.ts");
const SRC = path.resolve("src/ui/components/BellToggle.ts");
const HELPER = path.resolve("src/app/play-finish-sound.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(SRC).mtimeMs, fs.statSync(HELPER).mtimeMs);
	const stale = fs.existsSync(BUNDLE) && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!fs.existsSync(BUNDLE) || stale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.waitForFunction(() => !!customElements.get("bell-toggle"), null, { timeout: 10_000 });
}

async function mount(page: any, initialDataset?: string) {
	await page.evaluate((ds: string | undefined) => {
		if (ds === undefined) delete document.documentElement.dataset.playAgentFinishSound;
		else document.documentElement.dataset.playAgentFinishSound = ds;
		const el = document.createElement("bell-toggle");
		document.getElementById("container")!.appendChild(el);
	}, initialDataset);
}

test.describe("<bell-toggle>", () => {
	test("defaults to enabled (Bell, no slash) and exposes a Mute action", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page); // unset dataset ⇒ default ON

		const btn = page.locator("bell-toggle button");
		await expect(btn).toHaveAttribute("title", /Mute agent finish beeps/);
		// Bell (on) draws 2 paths; BellOff (off) adds the slash path `m2 2 20 20`.
		await expect(page.locator("bell-toggle svg path")).toHaveCount(2);
		await expect(page.locator("bell-toggle svg path[d='m2 2 20 20']")).toHaveCount(0);
	});

	test("click mutes: swaps to BellOff, flips the dataset, and persists the preference", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page);

		await page.locator("bell-toggle button").click();

		const btn = page.locator("bell-toggle button");
		await expect(btn).toHaveAttribute("title", /Unmute agent finish beeps/);
		// BellOff renders the diagonal slash path (the "line through" the bell).
		await expect(page.locator("bell-toggle svg path[d='m2 2 20 20']")).toHaveCount(1);

		expect(await page.evaluate(() => document.documentElement.dataset.playAgentFinishSound)).toBe("false");

		const put = await page.evaluate(() => (window as any).__putCalls.find((c: any) => /\/api\/preferences$/.test(c.url) && c.method === "PUT"));
		expect(put, "should PUT the preference").toBeTruthy();
		expect(JSON.parse(put.body)).toMatchObject({ playAgentFinishSound: false });
	});

	test("syncs when another surface dispatches the change event", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page); // ON

		await expect(page.locator("bell-toggle button")).toHaveAttribute("title", /Mute/);

		// Simulate the Settings checkbox muting via the shared helper's event.
		await page.evaluate(() => {
			document.documentElement.dataset.playAgentFinishSound = "false";
			window.dispatchEvent(new CustomEvent("bobbit-play-finish-sound-changed", { detail: { enabled: false } }));
		});

		await expect(page.locator("bell-toggle button")).toHaveAttribute("title", /Unmute/);
		await expect(page.locator("bell-toggle svg path[d='m2 2 20 20']")).toHaveCount(1);
	});
});
