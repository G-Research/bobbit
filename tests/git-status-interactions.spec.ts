/**
 * PI-19: Git status widget UI interaction tests.
 *
 * Tests expand/collapse, file list rendering, branch display, PR actions,
 * ahead/behind badges, loading state, and event dispatching.
 * Complements git-status-widget.spec.ts which covers parsing only.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/git-status-interactions.html").replace(/\\/g, "/")}`;

/** Helper: set widget props and wait for Lit update cycle */
async function setProps(
	page: import("@playwright/test").Page,
	props: Record<string, unknown>,
) {
	await page.evaluate((p) => (window as any).setProps(p), props);
	// Extra frame for dropdown portal render
	await page.evaluate(
		() =>
			new Promise((r) =>
				requestAnimationFrame(() => requestAnimationFrame(r)),
			),
	);
}

/** Helper: get tracked events */
async function getEvents(page: import("@playwright/test").Page) {
	return page.evaluate(() => (window as any).getEvents());
}

/** Helper: clear tracked events */
async function clearEvents(page: import("@playwright/test").Page) {
	await page.evaluate(() => (window as any).clearEvents());
}

test.describe("GitStatusWidget interactions", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	// =================================================================
	// Pill display
	// =================================================================

	test("pill shows branch name", async ({ page }) => {
		await setProps(page, { branch: "feature/abc", clean: true });
		const pillBranch = page.locator("[data-pill-branch]");
		await expect(pillBranch).toHaveText("feature/abc");
	});

	test("pill shows 'clean' badge when working tree is clean on primary", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			isOnPrimary: true,
			statusFiles: [],
		});
		const badge = page.locator("[data-clean-badge]");
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText("clean");
	});

	test("pill hides 'clean' badge when there are dirty files", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			isOnPrimary: true,
			statusFiles: [{ file: "a.ts", status: "M" }],
		});
		const badge = page.locator("[data-clean-badge]");
		await expect(badge).toHaveCount(0);
	});

	test("pill shows dirty file count segment", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [
				{ file: "a.ts", status: "M" },
				{ file: "b.ts", status: "A" },
			],
		});
		const dirty = page.locator('[data-segment="dirty"]');
		await expect(dirty).toHaveText("~2");
	});

	test("pill shows ahead/behind primary badges for feature branch", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/xyz",
			clean: true,
			isOnPrimary: false,
			aheadOfPrimary: 3,
			behindPrimary: 1,
			statusFiles: [],
		});
		const ahead = page.locator('[data-segment="ahead"]');
		const behind = page.locator('[data-segment="behind"]');
		await expect(ahead).toHaveText("↑3");
		await expect(behind).toHaveText("↓1");
	});

	test("pill shows PR icon when prState is set", async ({ page }) => {
		await setProps(page, {
			branch: "feature/pr",
			isOnPrimary: false,
			prState: "OPEN",
			prNumber: 42,
			statusFiles: [],
		});
		const prIcon = page.locator("[data-pr-icon]");
		await expect(prIcon).toBeVisible();
		await expect(prIcon).toContainText("#42");
	});

	test("loading state shows pulsing icon", async ({ page }) => {
		await setProps(page, { branch: "master", loading: true });
		const loadingIcon = page.locator("[data-loading-icon]");
		await expect(loadingIcon).toBeVisible();
		// Should have animate-pulse class
		await expect(loadingIcon).toHaveClass(/animate-pulse/);
	});

	test("widget renders nothing when no branch and not loading", async ({
		page,
	}) => {
		await setProps(page, { branch: "", loading: false });
		const btn = page.locator("[data-pill-button]");
		await expect(btn).toHaveCount(0);
	});

	// =================================================================
	// Expand / Collapse
	// =================================================================

	test("clicking pill opens dropdown", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			statusFiles: [],
		});
		await clearEvents(page);

		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const isOpen = await page.evaluate(() =>
			(window as any).isDropdownOpen(),
		);
		expect(isOpen).toBe(true);
	});

	test("clicking pill fires git-fetch event on open", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			statusFiles: [],
		});
		await clearEvents(page);

		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const events = await getEvents(page);
		expect(events.some((e: any) => e.type === "git-fetch")).toBe(true);
	});

	test("clicking pill again closes dropdown", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			statusFiles: [],
		});

		// Open
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		// Close
		await page.click("[data-pill-button]");
		await page.evaluate(
			() =>
				new Promise((r) =>
					requestAnimationFrame(() => requestAnimationFrame(r)),
				),
		);

		const isOpen = await page.evaluate(() =>
			(window as any).isDropdownOpen(),
		);
		expect(isOpen).toBe(false);
	});

	// =================================================================
	// Dropdown content: branch name
	// =================================================================

	test("dropdown shows branch name", async ({ page }) => {
		await setProps(page, {
			branch: "feature/my-branch",
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const name = page.locator(
			"#git-status-dropdown [data-branch-name]",
		);
		await expect(name).toHaveText("feature/my-branch");
	});

	// =================================================================
	// Dropdown content: file list
	// =================================================================

	test("dropdown shows file list with correct status labels", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [
				{ file: "src/a.ts", status: "M" },
				{ file: "src/b.ts", status: "A" },
				{ file: "src/c.ts", status: "D" },
				{ file: "src/d.ts", status: "?" },
				{ file: "src/e.ts", status: "R" },
			],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const statuses = page.locator(
			"#git-status-dropdown [data-file-status]",
		);
		const names = page.locator(
			"#git-status-dropdown [data-file-name]",
		);

		await expect(statuses).toHaveCount(5);

		const statusTexts = await statuses.allTextContents();
		expect(statusTexts.map((t) => t.trim())).toEqual([
			"modified",
			"added",
			"deleted",
			"untracked",
			"renamed",
		]);

		const nameTexts = await names.allTextContents();
		expect(nameTexts.map((t) => t.trim())).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
		]);
	});

	test("dropdown shows file count", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [
				{ file: "a.ts", status: "M" },
				{ file: "b.ts", status: "M" },
				{ file: "c.ts", status: "A" },
			],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const count = page.locator(
			"#git-status-dropdown [data-file-count]",
		);
		await expect(count).toContainText("3 uncommitted changes");
	});

	test("dropdown shows 'Working tree clean' when no files", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const clean = page.locator(
			"#git-status-dropdown [data-clean-message]",
		);
		await expect(clean).toContainText("Working tree clean");
	});

	// =================================================================
	// PR section
	// =================================================================

	test("no PR section when prState is undefined", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const prSection = page.locator(
			"#git-status-dropdown [data-pr-section]",
		);
		await expect(prSection).toHaveCount(0);
	});

	test("open PR shows link, badge, and merge controls", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/pr",
			isOnPrimary: false,
			prState: "OPEN",
			prNumber: 99,
			prTitle: "Add feature",
			prUrl: "https://github.com/repo/pull/99",
			prMergeable: "MERGEABLE",
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		// PR link
		const link = page.locator(
			"#git-status-dropdown [data-pr-link]",
		);
		await expect(link).toContainText("#99 Add feature");
		await expect(link).toHaveAttribute(
			"href",
			"https://github.com/repo/pull/99",
		);

		// Badge
		const badge = page.locator(
			"#git-status-dropdown [data-pr-badge]",
		);
		await expect(badge).toHaveText("OPEN");

		// Merge button
		const mergeBtn = page.locator(
			'#git-status-dropdown [data-action="merge-pr"]',
		);
		await expect(mergeBtn).toBeVisible();
		await expect(mergeBtn).toBeEnabled();

		// Merge method selector
		const select = page.locator(
			"#git-status-dropdown [data-merge-method]",
		);
		await expect(select).toBeVisible();
	});

	test("merged PR shows badge without merge controls", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/done",
			isOnPrimary: false,
			prState: "MERGED",
			prNumber: 50,
			prTitle: "Done feature",
			prUrl: "https://github.com/repo/pull/50",
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const badge = page.locator(
			"#git-status-dropdown [data-pr-badge]",
		);
		await expect(badge).toHaveText("MERGED");

		// No merge controls for merged PR
		const mergeBtn = page.locator(
			'#git-status-dropdown [data-action="merge-pr"]',
		);
		await expect(mergeBtn).toHaveCount(0);
	});

	test("merge button disabled when PR not mergeable", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/conflicts",
			isOnPrimary: false,
			prState: "OPEN",
			prNumber: 77,
			prTitle: "Conflicts",
			prMergeable: "CONFLICTING",
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const mergeBtn = page.locator(
			'#git-status-dropdown [data-action="merge-pr"]',
		);
		await expect(mergeBtn).toBeDisabled();
	});

	// =================================================================
	// Event dispatching
	// =================================================================

	test("pr-merge event fires with merge method", async ({ page }) => {
		await setProps(page, {
			branch: "feature/pr",
			isOnPrimary: false,
			prState: "OPEN",
			prNumber: 10,
			prTitle: "Test",
			prMergeable: "MERGEABLE",
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click('#git-status-dropdown [data-action="merge-pr"]');

		const events = await getEvents(page);
		const mergeEvt = events.find((e: any) => e.type === "pr-merge");
		expect(mergeEvt).toBeTruthy();
		expect(mergeEvt.detail.method).toBe("squash"); // default
	});

	test("ask-agent-commit event fires", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [{ file: "a.ts", status: "M" }],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click(
			'#git-status-dropdown [data-action="ask-commit"]',
		);

		const events = await getEvents(page);
		expect(
			events.some((e: any) => e.type === "ask-agent-commit"),
		).toBe(true);
	});

	test("ask-agent-pr event fires for feature branch ahead of primary", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/new",
			isOnPrimary: false,
			clean: true,
			aheadOfPrimary: 2,
			behindPrimary: 0,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click(
			'#git-status-dropdown [data-action="ask-pr"]',
		);

		const events = await getEvents(page);
		expect(
			events.some((e: any) => e.type === "ask-agent-pr"),
		).toBe(true);
	});

	test("git-pull event fires for behind remote on primary", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			isOnPrimary: true,
			clean: true,
			behind: 3,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click('#git-status-dropdown [data-action="pull"]');

		const events = await getEvents(page);
		expect(events.some((e: any) => e.type === "git-pull")).toBe(
			true,
		);
	});

	test("git-push event fires for ahead remote on primary", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			isOnPrimary: true,
			clean: true,
			ahead: 2,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click('#git-status-dropdown [data-action="push"]');

		const events = await getEvents(page);
		expect(events.some((e: any) => e.type === "git-push")).toBe(
			true,
		);
	});

	test("git-merge-primary event fires for behind primary on feature branch", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/behind",
			isOnPrimary: false,
			clean: true,
			behindPrimary: 5,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");
		await clearEvents(page);

		await page.click(
			'#git-status-dropdown [data-action="merge-primary"]',
		);

		const events = await getEvents(page);
		expect(
			events.some((e: any) => e.type === "git-merge-primary"),
		).toBe(true);
	});

	// =================================================================
	// Primary status messages
	// =================================================================

	test("on primary: shows 'Up to date' message", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			isOnPrimary: true,
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const status = page.locator(
			"#git-status-dropdown [data-primary-status]",
		);
		await expect(status).toContainText("Up to date with origin/master");
	});

	test("feature branch ahead and behind shows both counts", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/mixed",
			isOnPrimary: false,
			aheadOfPrimary: 4,
			behindPrimary: 2,
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const status = page.locator(
			"#git-status-dropdown [data-primary-status]",
		);
		await expect(status).toContainText("4 ahead");
		await expect(status).toContainText("2 behind");
		await expect(status).toContainText("origin/master");
	});

	test("merged into primary shows merged message", async ({ page }) => {
		await setProps(page, {
			branch: "feature/merged",
			isOnPrimary: false,
			mergedIntoPrimary: true,
			behindPrimary: 0,
			clean: true,
			statusFiles: [],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const status = page.locator(
			"#git-status-dropdown [data-primary-status]",
		);
		await expect(status).toContainText("Merged into origin/master");
	});

	// =================================================================
	// Dynamic prop updates while dropdown is open
	// =================================================================

	test("dropdown re-renders when files change while open", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [{ file: "a.ts", status: "M" }],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		// Initially 1 file
		let rows = page.locator(
			"#git-status-dropdown [data-file-row]",
		);
		await expect(rows).toHaveCount(1);

		// Update to 3 files while dropdown is open
		await setProps(page, {
			statusFiles: [
				{ file: "a.ts", status: "M" },
				{ file: "b.ts", status: "A" },
				{ file: "c.ts", status: "D" },
			],
		});

		rows = page.locator("#git-status-dropdown [data-file-row]");
		await expect(rows).toHaveCount(3);
	});

	// =================================================================
	// Singular/plural file count
	// =================================================================

	test("file count uses singular for 1 file", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: false,
			statusFiles: [{ file: "a.ts", status: "M" }],
		});
		await page.click("[data-pill-button]");
		await page.waitForSelector("#git-status-dropdown");

		const count = page.locator(
			"#git-status-dropdown [data-file-count]",
		);
		const text = await count.textContent();
		expect(text).toContain("1 uncommitted change");
		expect(text).not.toContain("changes");
	});

	// =================================================================
	// Clean badge suppression on feature branch
	// =================================================================

	test("clean badge hidden on feature branch ahead of primary", async ({
		page,
	}) => {
		await setProps(page, {
			branch: "feature/ahead",
			clean: true,
			isOnPrimary: false,
			aheadOfPrimary: 1,
			statusFiles: [],
		});
		const badge = page.locator("[data-clean-badge]");
		await expect(badge).toHaveCount(0);
	});

	test("clean badge hidden when PR exists", async ({ page }) => {
		await setProps(page, {
			branch: "master",
			clean: true,
			isOnPrimary: true,
			prState: "OPEN",
			prNumber: 1,
			statusFiles: [],
		});
		const badge = page.locator("[data-clean-badge]");
		await expect(badge).toHaveCount(0);
	});
});
