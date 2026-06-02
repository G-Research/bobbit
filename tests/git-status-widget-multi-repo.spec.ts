/**
 * GitStatusWidget — multi-repo per-repo collapsible rendering (Phase 4b
 * Follow-up B). Reuses the `git-status-widget-states` fixture/bundle so
 * we mount the real Lit element with the `repos` envelope and assert
 * the per-repo sections + aggregate header text behave as the design
 * (`docs/design/multi-repo-components.md` §8.4) prescribes.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/git-status-widget-states.html");
const BUNDLE = path.resolve("tests/fixtures/git-status-widget-states-bundle.js");
const ENTRY = path.resolve("tests/fixtures/git-status-widget-states-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GitStatusWidget.ts");

test.beforeAll(() => {
	// Atomic mtime-gated rebuild via shared helper. Bundle path is shared with
	// `git-status-widget-states.spec.ts` so parallel workers must not observe
	// half-written output — `buildBundle` writes to a tmp file then renames.
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, WIDGET_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.waitForFunction(() => !!customElements.get("git-status-widget"), null, { timeout: 10_000 });
}

async function mount(page: any, props: Record<string, unknown>): Promise<void> {
	await page.evaluate((p: Record<string, unknown>) => {
		const el = document.getElementById("container")!;
		el.innerHTML = "";
		const w = document.createElement("git-status-widget") as any;
		for (const [k, v] of Object.entries(p)) w[k] = v;
		el.appendChild(w);
	}, props);
	await page.waitForTimeout(50);
}

async function openDropdown(page: any) {
	await page.locator("git-status-widget button").click();
	await page.waitForSelector("#git-status-dropdown", { timeout: 2_000 });
}

const baseProps = {
	loading: false,
	branch: "goal/multi-repo-foo",
	primaryBranch: "master",
	isOnPrimary: false,
	clean: false,
	statusFiles: [], // suppressed in multi-repo mode
};

test.describe("GitStatusWidget — multi-repo collapsibles", () => {
	test("multi-repo pill shows aggregate '<N> changed across <M> repos' label", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			repos: {
				api: { statusFiles: [
					{ file: "src/a.ts", status: "M" },
					{ file: "src/b.ts", status: "M" },
					{ file: "src/c.ts", status: "A" },
				] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
				shared: { statusFiles: [], clean: true },
			},
		});

		const pillAggregate = page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]');
		await expect(pillAggregate).toBeVisible();
		// 3+1+0 = 4 changed across 2 dirty repos
		await expect(pillAggregate).toHaveText(/4 changed across 2 repos/);
	});

	test("multi-repo pill shows summed ahead/behind/+/- segments across repos", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			repos: {
				api: {
					statusFiles: [
						{ file: "src/a.ts", status: "M" },
						{ file: "src/b.ts", status: "M" },
					],
					aheadOfPrimary: 2,
					behindPrimary: 1,
					insertionsVsPrimary: 10,
					deletionsVsPrimary: 3,
				},
				web: {
					statusFiles: [{ file: "index.html", status: "M" }],
					aheadOfPrimary: 1,
					behindPrimary: 0,
					insertionsVsPrimary: 5,
					deletionsVsPrimary: 2,
				},
			},
		});

		const pill = page.locator("git-status-widget button");
		// Dirty label: 3 changed across 2 repos.
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]'))
			.toHaveText(/3 changed across 2 repos/);
		// Summed segments: ↓1 ↑3 +15 -5.
		const pillText = await pill.innerText();
		expect(pillText).toContain("↓1");
		expect(pillText).toContain("↑3");
		expect(pillText).toContain("+15");
		expect(pillText).toContain("-5");
		// 'clean' must NOT appear when stats are non-zero.
		expect(pillText).not.toMatch(/\bclean\b/);
	});

	test("clean multi-repo with non-zero summed ahead/behind still shows segments, not 'clean'", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			clean: true,
			statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 2, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 1, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		const pillText = await page.locator("git-status-widget button").innerText();
		// No dirty label (all clean) but summed ahead = 3 segment present.
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]')).toHaveCount(0);
		expect(pillText).toContain("↑3");
		expect(pillText).not.toMatch(/\bclean\b/);
	});

	test("fully clean multi-repo (no dirty, no stats) collapses to single 'clean' indicator", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			clean: true,
			isOnPrimary: true,
			statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		// No aggregate label, no segments — collapses to a single 'clean'.
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]')).toHaveCount(0);
		const pillText = await page.locator("git-status-widget button").innerText();
		expect(pillText).toMatch(/\bclean\b/);
		expect(pillText).not.toContain("↑");
		expect(pillText).not.toContain("↓");
	});

	test("clean multi-repo on a feature branch (isOnPrimary false) still collapses to single 'clean'", async ({ page }) => {
		// Regression: a clean `session/...` branch (isOnPrimary false, all repos
		// clean, zero summed stats) must collapse to the single green 'clean',
		// not just render the branch name. Clean-collapse derives from the
		// aggregate, INDEPENDENT of isOnPrimary.
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			branch: "session/abcd1234",
			clean: true,
			isOnPrimary: false,
			mergedIntoPrimary: false,
			aheadOfPrimary: 0,
			statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]')).toHaveCount(0);
		const pillText = await page.locator("git-status-widget button").innerText();
		expect(pillText).toMatch(/\bclean\b/);
		expect(pillText).not.toContain("↑");
		expect(pillText).not.toContain("↓");
	});

	test("single-repo (one entry) does NOT trigger multi-repo rendering", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			clean: true,
			statusFiles: [],
			repos: { ".": { statusFiles: [], clean: true } },
		});

		// Pill aggregate label must NOT appear in single-repo mode.
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]')).toHaveCount(0);

		// Open dropdown — no per-repo sections.
		await openDropdown(page);
		await expect(page.locator('#git-status-dropdown [data-testid="multi-repo-sections"]')).toHaveCount(0);
	});

	test("dropdown shows one per-repo section per entry, with names and counts", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			repos: {
				api: { statusFiles: [
					{ file: "src/a.ts", status: "M" },
					{ file: "src/b.ts", status: "M" },
					{ file: "src/c.ts", status: "A" },
				] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
				shared: { statusFiles: [], clean: true },
			},
		});
		await openDropdown(page);

		const sections = page.locator('#git-status-dropdown [data-testid="multi-repo-entry"]');
		await expect(sections).toHaveCount(3);

		const names = await sections.locator('[data-testid="repo-name"]').allTextContents();
		expect(names).toEqual(["api", "web", "shared"]);

		// Aggregate header in dropdown
		await expect(page.locator('#git-status-dropdown [data-testid="multi-repo-aggregate"]'))
			.toHaveText(/4 changed across 2 repos/);

		// Dirty repos auto-expand; clean stays collapsed.
		const apiSection = page.locator('#git-status-dropdown [data-repo-name="api"]');
		const sharedSection = page.locator('#git-status-dropdown [data-repo-name="shared"]');
		await expect(apiSection).toHaveAttribute("open", "");
		expect(await sharedSection.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

		// api shows "~3" dirty count; shared shows "clean".
		await expect(apiSection.locator('[data-testid="repo-dirty-count"]')).toHaveText("~3");
		await expect(sharedSection.locator('[data-testid="repo-clean"]')).toHaveText("clean");
	});

	test("per-repo section lists the repo's files with correct status labels", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			repos: {
				api: { statusFiles: [
					{ file: "src/added.ts", status: "A" },
					{ file: "src/deleted.ts", status: "D" },
					{ file: "src/modified.ts", status: "M" },
				] },
			},
		});

		// One entry alone is single-repo, force multi via two entries.
		await mount(page, {
			...baseProps,
			repos: {
				api: { statusFiles: [
					{ file: "src/added.ts", status: "A" },
					{ file: "src/deleted.ts", status: "D" },
					{ file: "src/modified.ts", status: "M" },
				] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
			},
		});
		await openDropdown(page);
		const apiSection = page.locator('#git-status-dropdown [data-repo-name="api"]');
		await expect(apiSection).toBeVisible();
		await expect(apiSection).toContainText("src/added.ts");
		await expect(apiSection).toContainText("added");
		await expect(apiSection).toContainText("src/deleted.ts");
		await expect(apiSection).toContainText("deleted");
		await expect(apiSection).toContainText("src/modified.ts");
		await expect(apiSection).toContainText("modified");
	});

	test("legacy `status` field on per-repo entry also works (back-compat)", async ({ page }) => {
		await gotoAndWait(page);
		// Server may serialise as `status` (the GitStatusResult shape) rather
		// than `statusFiles`. The widget tolerates both.
		await mount(page, {
			...baseProps,
			repos: {
				api: { status: [{ file: "src/x.ts", status: "M" }] },
				web: { status: [{ file: "y.html", status: "M" }] },
			},
		});

		const pillAggregate = page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]');
		await expect(pillAggregate).toHaveText(/2 changed across 2 repos/);

		await openDropdown(page);
		await expect(page.locator('#git-status-dropdown [data-testid="multi-repo-entry"]')).toHaveCount(2);
	});

	test("clean multi-repo: aggregate header reads 'N repos clean', no pill aggregate", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...baseProps,
			clean: true,
			repos: {
				api: { statusFiles: [], clean: true },
				web: { statusFiles: [], clean: true },
			},
		});

		// Pill aggregate not shown when no dirty files.
		await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]')).toHaveCount(0);

		await openDropdown(page);
		await expect(page.locator('#git-status-dropdown [data-testid="multi-repo-aggregate"]'))
			.toHaveText(/2 repos clean/);

		// Both repos show clean indicator
		await expect(page.locator('#git-status-dropdown [data-testid="repo-clean"]')).toHaveCount(2);
	});

	test("multi-repo dropdown does NOT render the duplicate flat 'uncommitted changes' list", async ({ page }) => {
		await gotoAndWait(page);
		// Even if the parent passes a flat statusFiles for the goal worktree,
		// the multi-repo per-repo sections are the source of truth — the
		// widget must suppress the flat list to avoid double-counting.
		await mount(page, {
			...baseProps,
			statusFiles: [
				{ file: "src/a.ts", status: "M" },
				{ file: "src/b.ts", status: "M" },
			],
			repos: {
				api: { statusFiles: [
					{ file: "src/a.ts", status: "M" },
					{ file: "src/b.ts", status: "M" },
				] },
				web: { statusFiles: [] },
			},
		});

		await openDropdown(page);
		// Per-repo sections present.
		await expect(page.locator('#git-status-dropdown [data-testid="multi-repo-sections"]')).toBeVisible();
		// Flat "uncommitted changes" header (only present in single-repo flow) absent.
		const dropdownText = await page.locator('#git-status-dropdown').innerText();
		expect(dropdownText).not.toMatch(/uncommitted change/i);
	});
});
