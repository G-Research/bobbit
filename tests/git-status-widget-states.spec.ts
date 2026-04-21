import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/git-status-widget-states.html");
const BUNDLE = path.resolve("tests/fixtures/git-status-widget-states-bundle.js");
const ENTRY = path.resolve("tests/fixtures/git-status-widget-states-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GitStatusWidget.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(WIDGET_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.waitForFunction(
		() => !!customElements.get("git-status-widget"),
		null,
		{ timeout: 10_000 },
	);
}

async function mount(
	page: any,
	props: Record<string, unknown>,
): Promise<void> {
	await page.evaluate((p: Record<string, unknown>) => {
		const el = document.getElementById("container")!;
		el.innerHTML = "";
		const w = document.createElement("git-status-widget") as any;
		for (const [k, v] of Object.entries(p)) {
			w[k] = v;
		}
		el.appendChild(w);
	}, props);
	// Let Lit finish its first render
	await page.waitForTimeout(50);
}

test.describe("GitStatusWidget render states", () => {
	test("skeleton renders when loading && !branch", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { loading: true, branch: "" });

		const pill = page.locator('git-status-widget button[data-state="skeleton"]');
		await expect(pill).toBeVisible();
		await expect(pill).toHaveAttribute("aria-busy", "true");
		await expect(pill).toBeDisabled();
		await expect(pill).toContainText(/Checking git/);
		await expect(page.locator("git-status-widget .git-skeleton-shimmer")).toHaveCount(1);
	});

	test("pulsing refresh dot when loading && branch", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: true,
			branch: "feature/x",
			primaryBranch: "master",
			isOnPrimary: false,
			clean: true,
		});

		const pill = page.locator('git-status-widget button[data-state="refreshing"]');
		await expect(pill).toBeVisible();
		await expect(pill).toContainText("feature/x");
		await expect(pill).toBeEnabled();

		const dot = page.locator("git-status-widget .git-refresh-dot");
		await expect(dot).toHaveCount(1);

		// Pulse animation wired up
		const anim = await dot.evaluate(
			(el) => getComputedStyle(el).animationName,
		);
		expect(anim).toBe("git-status-pulse");

		// No partial dot in refreshing state
		await expect(page.locator("git-status-widget .git-partial-dot")).toHaveCount(0);
	});

	test("warning dot when partial && branch", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			partial: true,
			branch: "feature/y",
			primaryBranch: "master",
			isOnPrimary: false,
			clean: false,
		});

		const pill = page.locator('git-status-widget button[data-state="partial"]');
		await expect(pill).toBeVisible();
		await expect(pill).toContainText("feature/y");

		await expect(page.locator("git-status-widget .git-partial-dot")).toHaveCount(1);
		await expect(page.locator("git-status-widget .git-refresh-dot")).toHaveCount(0);
		await expect(page.locator("git-status-widget .git-skeleton-shimmer")).toHaveCount(0);
	});

	test("normal render when clean and not loading", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			partial: false,
			branch: "master",
			primaryBranch: "master",
			isOnPrimary: true,
			clean: true,
		});

		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toBeVisible();
		await expect(pill).toContainText("master");
		await expect(pill).toContainText("clean");
		await expect(page.locator("git-status-widget .git-refresh-dot")).toHaveCount(0);
		await expect(page.locator("git-status-widget .git-partial-dot")).toHaveCount(0);
		await expect(page.locator("git-status-widget .git-skeleton-shimmer")).toHaveCount(0);
	});

	test("hidden when !loading && !branch", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { loading: false, branch: "" });

		const btnCount = await page.locator("git-status-widget button").count();
		expect(btnCount).toBe(0);
	});

	test("dropdown open fires git-status-dropdown-open event", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			branch: "master",
			primaryBranch: "master",
			isOnPrimary: true,
			clean: true,
		});

		// Attach a listener that records event hits on window.
		await page.evaluate(() => {
			(window as any).__dropdownOpenEvents = 0;
			(window as any).__gitFetchEvents = 0;
			window.addEventListener("git-status-dropdown-open", () => {
				(window as any).__dropdownOpenEvents++;
			});
			window.addEventListener("git-fetch", () => {
				(window as any).__gitFetchEvents++;
			});
		});

		await page.locator('git-status-widget button[data-state="ready"]').click();

		const counts = await page.evaluate(() => ({
			open: (window as any).__dropdownOpenEvents,
			fetch: (window as any).__gitFetchEvents,
		}));
		expect(counts.open).toBe(1);
		expect(counts.fetch).toBe(1);
	});

	test("skeleton is non-interactive (no dropdown-open event)", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { loading: true, branch: "" });

		await page.evaluate(() => {
			(window as any).__dropdownOpenEvents = 0;
			window.addEventListener("git-status-dropdown-open", () => {
				(window as any).__dropdownOpenEvents++;
			});
		});

		// Click is a no-op because the button is disabled, but force-click to
		// also verify the internal toggle is guarded.
		await page
			.locator('git-status-widget button[data-state="skeleton"]')
			.click({ force: true })
			.catch(() => {
				/* disabled buttons reject click \u2014 that's acceptable */
			});

		const count = await page.evaluate(
			() => (window as any).__dropdownOpenEvents,
		);
		expect(count).toBe(0);
	});
});
