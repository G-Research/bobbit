/**
 * Browser E2E — session git-status widget in a polyrepo session (Gaps 2 & 3).
 *
 * The widget's multi-repo rendering is driven by the `repos` envelope returned
 * by `GET /api/sessions/:id/git-status`. Here we route-mock that endpoint (and
 * the per-repo `git-diff` endpoint) so the test is deterministic — the server
 * envelope itself is covered by `tests/e2e/session-git-status-multi-repo.spec.ts`.
 *
 * Asserts:
 *   - pill shows aggregated dirty + ahead/insertion stats summed across repos,
 *   - popover shows one collapsible section per repo with correct counts,
 *   - a clean repo collapses to a "clean" indicator,
 *   - clicking a file inside a per-repo section opens that repo's diff
 *     (request carries `?repo=<name>`),
 *   - the aggregated pill survives a reload.
 */
import { test, expect, type Page, type Route } from "../gateway-harness.js";
import { createSession, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

function repoEntry(over: Record<string, unknown> = {}) {
	return {
		branch: "session/abcd1234",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: false,
		clean: true,
		status: [] as Array<{ file: string; status: string }>,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		mergedIntoPrimary: false,
		hasUpstream: false,
		unpushed: false,
		summary: "",
		...over,
	};
}

function multiRepoEnvelope() {
	const root = repoEntry({
		clean: false,
		status: [{ file: "src/a.ts", status: "M" }],
	});
	const repos = {
		api: repoEntry({
			clean: false,
			status: [
				{ file: "src/a.ts", status: "M" },
				{ file: "src/b.ts", status: "M" },
			],
			aheadOfPrimary: 2,
			insertionsVsPrimary: 10,
		}),
		web: repoEntry({
			clean: false,
			status: [{ file: "index.html", status: "M" }],
			aheadOfPrimary: 1,
			insertionsVsPrimary: 5,
		}),
		shared: repoEntry({ clean: true }),
	};
	return { ...root, aggregate: root, repos };
}

async function installGitStatusMock(page: Page, sessionId: string): Promise<{ diffRepos: string[] }> {
	const diffRepos: string[] = [];
	const statusRe = new RegExp(`/api/sessions/${sessionId}/git-status(?:\\?.*)?$`);
	const diffRe = new RegExp(`/api/sessions/${sessionId}/git-diff(?:\\?.*)?$`);

	await page.route(statusRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(multiRepoEnvelope()),
		});
	});

	await page.route(diffRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const u = new URL(route.request().url());
		const repo = u.searchParams.get("repo");
		if (repo) diffRepos.push(repo);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				diff: `diff --git a/${u.searchParams.get("file")} b/${u.searchParams.get("file")}\n@@ -1 +1 @@\n-old\n+new\n`,
			}),
		});
	});

	return { diffRepos };
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("session git-status widget — polyrepo", () => {
	test("aggregated pill, per-repo sections, clean collapse, per-repo diff, reload", async ({ page }) => {
		test.setTimeout(60_000);
		const sessionId = await createSession();
		try {
			const mock = await installGitStatusMock(page, sessionId);

			await openApp(page);
			await openSession(page, sessionId);

			// Pill aggregate label + summed segments.
			const pill = page.locator("git-status-widget button").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			const aggregate = page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]');
			await expect(aggregate).toBeVisible({ timeout: 10_000 });
			await expect(aggregate).toHaveText(/3 changed across 2 repos/);
			// Summed ahead = 3, summed insertions = 15.
			await expect.poll(async () => pill.innerText()).toContain("↑3");
			await expect(await pill.innerText()).toContain("+15");

			// Open popover — one section per repo.
			await pill.click();
			await expect(page.locator("#git-status-dropdown")).toBeVisible({ timeout: 5_000 });
			const sections = page.locator('#git-status-dropdown [data-testid="multi-repo-entry"]');
			await expect(sections).toHaveCount(3);
			const names = await sections.locator('[data-testid="repo-name"]').allTextContents();
			expect(names).toEqual(["api", "web", "shared"]);

			// api dirty count "~2"; shared collapses to "clean".
			const apiSection = page.locator('#git-status-dropdown [data-repo-name="api"]');
			const sharedSection = page.locator('#git-status-dropdown [data-repo-name="shared"]');
			await expect(apiSection.locator('[data-testid="repo-dirty-count"]')).toHaveText("~2");
			await expect(sharedSection.locator('[data-testid="repo-clean"]')).toHaveText("clean");
			expect(await sharedSection.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

			// Click a file in the api section → opens that repo's diff.
			await apiSection.getByText("src/a.ts").first().click();
			await expect(page.locator("#git-diff-modal diff-block")).toBeVisible({ timeout: 5_000 });
			expect(mock.diffRepos).toContain("api");

			// Close modal, reload — aggregated pill persists (re-fetch hits mock).
			await page.keyboard.press("Escape");
			await page.reload();
			await openSession(page, sessionId);
			await expect(page.locator('git-status-widget [data-testid="pill-multi-repo-aggregate"]'))
				.toHaveText(/3 changed across 2 repos/, { timeout: 15_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* ignore */ });
		}
	});
});
