import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/git-status-widget-states.html");
const BUNDLE = path.resolve("tests/fixtures/git-status-widget-states-bundle.js");
const ENTRY = path.resolve("tests/fixtures/git-status-widget-states-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GitStatusWidget.ts");

test.beforeAll(() => {
	// Atomic mtime-gated rebuild via shared helper. Bundle path is shared with
	// `git-status-widget-multi-repo.spec.ts` so parallel workers must not observe
	// half-written output — `buildBundle` writes to a tmp file then renames.
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, WIDGET_SRC] });
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

async function openDropdown(page: any): Promise<void> {
	await page.locator('git-status-widget button[data-state="ready"]').click();
	await page.waitForSelector("#git-status-dropdown", { timeout: 2_000 });
}

const OPEN_PR_PROPS = {
	loading: false,
	branch: "feature/pr",
	primaryBranch: "master",
	isOnPrimary: false,
	clean: true,
	statusFiles: [],
	prState: "OPEN",
	prNumber: 905,
	prTitle: "Needs review",
	prUrl: "https://github.com/example/repo/pull/905",
	prMergeable: "MERGEABLE",
	reviewDecision: "REVIEW_REQUIRED",
};

test.describe("GitStatusWidget bypass merge action", () => {
	test("renders Bypass merge when viewerCanMergeAsAdmin is true", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...OPEN_PR_PROPS,
			viewerCanMergeAsAdmin: true,
		});
		await openDropdown(page);

		await expect(page.locator("#git-status-dropdown").getByRole("button", { name: "Bypass merge" })).toBeVisible();
		await expect(page.locator("#git-status-dropdown")).not.toContainText("Force Merge");
	});

	test("Bypass merge emits pr-merge with admin true", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...OPEN_PR_PROPS,
			viewerCanMergeAsAdmin: true,
		});
		await page.evaluate(() => {
			(window as any).__prMergeEvents = [];
			window.addEventListener("pr-merge", (event) => {
				(window as any).__prMergeEvents.push((event as CustomEvent).detail);
			});
		});
		await openDropdown(page);

		await page.locator("#git-status-dropdown").getByRole("button", { name: "Bypass merge" }).click();

		const events = await page.evaluate(() => (window as any).__prMergeEvents);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ method: "squash", admin: true });
	});

	test("hides Bypass merge when capability is false even for admins", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...OPEN_PR_PROPS,
			viewerIsAdmin: true,
			viewerCanMergeAsAdmin: false,
		});
		await openDropdown(page);

		await expect(page.locator("#git-status-dropdown").getByRole("button", { name: "Bypass merge" })).toHaveCount(0);
		await expect(page.locator("#git-status-dropdown")).not.toContainText("Force Merge");
	});

	test("conflicting PR hides Bypass merge even with bypass capability", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...OPEN_PR_PROPS,
			prMergeable: "CONFLICTING",
			viewerCanMergeAsAdmin: true,
		});
		await openDropdown(page);

		await expect(page.locator("#git-status-dropdown").getByRole("button", { name: "Bypass merge" })).toHaveCount(0);
		await expect(page.locator("#git-status-dropdown")).toContainText("Has conflicts");
	});

	test("non-mergeable PR shows status text when bypass is unavailable", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			...OPEN_PR_PROPS,
			prMergeable: "UNKNOWN",
			viewerCanMergeAsAdmin: false,
		});
		await openDropdown(page);

		await expect(page.locator("#git-status-dropdown").getByRole("button", { name: "Bypass merge" })).toHaveCount(0);
		await expect(page.locator("#git-status-dropdown")).toContainText("Not mergeable");
	});
});

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

	test("+/- line-count segments render on feature branch", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			branch: "feature/x",
			primaryBranch: "master",
			isOnPrimary: false,
			clean: true,
			aheadOfPrimary: 1,
			insertionsVsPrimary: 12,
			deletionsVsPrimary: 4,
		});
		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toBeVisible();
		await expect(pill).toContainText("+12");
		await expect(pill).toContainText("-4");
		const plus = pill.locator("span.text-green-600", { hasText: "+12" });
		const minus = pill.locator("span.text-red-600", { hasText: "-4" });
		await expect(plus).toHaveCount(1);
		await expect(minus).toHaveCount(1);
	});

	test("+/- segments hidden when both counts are 0", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			branch: "feature/x",
			primaryBranch: "master",
			isOnPrimary: false,
			clean: true,
			aheadOfPrimary: 0,
			insertionsVsPrimary: 0,
			deletionsVsPrimary: 0,
		});
		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toBeVisible();
		await expect(pill).not.toContainText(/\+\d/);
		await expect(pill).not.toContainText(/-\d/);
	});

	test("+/- segments suppressed on primary branch even when non-zero", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			branch: "master",
			primaryBranch: "master",
			isOnPrimary: true,
			clean: true,
			insertionsVsPrimary: 12,
			deletionsVsPrimary: 4,
		});
		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toBeVisible();
		await expect(pill).not.toContainText("+12");
		await expect(pill).not.toContainText("-4");
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

	test("commits modal expands files and opens commit-scoped diff", async ({
		page,
	}) => {
		await gotoAndWait(page);
		await mount(page, {
			loading: false,
			branch: "feature/commit-files",
			primaryBranch: "master",
			primaryRef: "origin/master",
			isOnPrimary: false,
			clean: true,
			aheadOfPrimary: 1,
			sessionId: "sess-commit-files",
		});

		await page.evaluate(() => {
			(window as any).__fetchCalls = [];
			window.fetch = async (input: RequestInfo | URL) => {
				const url = String(input);
				(window as any).__fetchCalls.push(url);
				if (url.includes("/commits")) {
					return new Response(
						JSON.stringify({
							commits: [
								{
									sha: "abcdef1234567890",
									shortSha: "abcdef1",
									message: "Add commit file diff UI",
									author: "Tester",
									timestamp: new Date().toISOString(),
									filesChanged: 4,
									insertions: 12,
									deletions: 3,
									files: [
										{
											path: "src/modified.ts",
											status: "M",
											statusLabel: "modified",
										},
										{
											path: "src/added.ts",
											status: "A",
											statusLabel: "added",
										},
										{
											path: "src/deleted.ts",
											status: "D",
											statusLabel: "deleted",
										},
										{
											oldPath: "src/old-name.ts",
											path: "src/new-name.ts",
											status: "R",
											statusLabel: "renamed",
										},
									],
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.includes("/git-diff")) {
					return new Response(
						JSON.stringify({
							diff: "diff --git a/src/new-name.ts b/src/new-name.ts\n+commit diff marker",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			};
		});

		await page.locator('git-status-widget button[data-state="ready"]').click();
		await page.getByText("1 ahead").click();

		const modal = page.locator("#git-commits-modal");
		await expect(page.locator("#git-commits-modal > div").first()).toBeVisible();
		await expect(modal).toContainText("1 Ahead of origin/master Commit");

		const commitRow = modal.locator('[data-testid="commit-row"]').first();
		await expect(commitRow).toContainText("abcdef1");
		await expect(commitRow).toContainText("Add commit file diff UI");

		const disclosure = commitRow.locator('button[aria-expanded="false"]');
		await expect(disclosure).toHaveCount(1);
		await disclosure.click();
		await expect(commitRow.locator('button[aria-expanded="true"]')).toHaveCount(1);

		await expect(commitRow).toContainText("modified");
		await expect(commitRow).toContainText("added");
		await expect(commitRow).toContainText("deleted");
		await expect(commitRow).toContainText("renamed");
		await expect(commitRow).toContainText("src/old-name.ts → src/new-name.ts");

		await commitRow.getByText("src/old-name.ts → src/new-name.ts").click();
		await expect(page.locator('#git-diff-modal rich-git-diff-viewer')).toHaveCount(1);
		await expect(page.locator('#git-diff-modal [role="dialog"]')).toHaveAttribute("aria-modal", "true");
		await expect(page.locator('#git-diff-modal [aria-label="Close diff modal"]')).toHaveCount(1);

		const diffCall = await page.waitForFunction(() =>
			((window as any).__fetchCalls as string[]).find((url) =>
				url.includes("/git-diff"),
			),
		);
		const diffUrl = String(await diffCall.jsonValue());
		expect(diffUrl).toContain("/api/sessions/sess-commit-files/git-diff");
		expect(diffUrl).toContain("file=src%2Fnew-name.ts");
		expect(diffUrl).toContain("commit=abcdef1234567890");
	});
});

test.describe("GitStatusWidget a11y — PR review-status accessible name (judgment item 10)", () => {
	// Source: PR #246 judgment inventory, "Color-only signaling" item 10 —
	// the PR pill's review-status color (approved=green / changes-requested=red)
	// was only exposed via a `title` on the non-focusable `_prPillIcon` span.
	// Fix: the focusable `.git-status-pill` button now carries an aria-label
	// with the review word when one applies. Zero visible-pixel change — the
	// icon's own `title` is untouched.
	test("approved review decision: pill aria-label includes 'approved'", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { ...OPEN_PR_PROPS, reviewDecision: "APPROVED" });

		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toHaveAttribute("aria-label", `${OPEN_PR_PROPS.branch}, PR #${OPEN_PR_PROPS.prNumber} review approved`);
	});

	test("changes-requested review decision: pill aria-label includes 'changes requested'", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { ...OPEN_PR_PROPS, reviewDecision: "CHANGES_REQUESTED" });

		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).toHaveAttribute("aria-label", `${OPEN_PR_PROPS.branch}, PR #${OPEN_PR_PROPS.prNumber} review changes requested`);
	});

	test("awaiting-review decision and no-PR branches: pill has no aria-label override", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { ...OPEN_PR_PROPS, reviewDecision: "REVIEW_REQUIRED" });
		const pill = page.locator('git-status-widget button[data-state="ready"]');
		await expect(pill).not.toHaveAttribute("aria-label");

		await mount(page, {
			loading: false,
			branch: "main",
			primaryBranch: "master",
			isOnPrimary: true,
			clean: true,
			statusFiles: [],
		});
		await expect(pill).not.toHaveAttribute("aria-label");
	});
});
