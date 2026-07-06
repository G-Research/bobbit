import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/search-preview-search-page-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "search-preview-search-page-bundle.js");
const SEARCH_PAGE_SRC = path.resolve("src/app/search-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");

const NOW = 1_777_000_000_000;

type Result = {
	type: string;
	id: string;
	title: string;
	snippet: string;
	timestamp: number;
	archived: boolean;
	score: number;
	sessionId?: string;
	sessionTitle?: string;
	matchedOn?: "text" | "metadata";
};

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SEARCH_PAGE_SRC, API_SRC, GATEWAY_FETCH_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__searchPageFixtureReady === true, null, { timeout: 10_000 });
}

async function setupSearch(page: Page, results: Result[], query = "fixture-token"): Promise<void> {
	await page.evaluate(
		({ q, r }) => (window as any).__setSearchPageFixture({ query: q, results: r }),
		{ q: query, r: results },
	);
	await expect(page.locator("input[placeholder='Search everything...']")).toHaveValue(query);
}

function goal(id: string, title: string, score = 5): Result {
	return {
		type: "goal",
		id,
		title,
		snippet: `<b>${title}</b> goal snippet`,
		timestamp: NOW,
		archived: false,
		score,
	};
}

function session(id: string, title: string, score = 4): Result {
	return {
		type: "session",
		id,
		title,
		snippet: `<b>${title}</b> session snippet`,
		timestamp: NOW - 1000,
		archived: false,
		score,
	};
}

function message(id: string, sessionId: string, token: string, score = 3, sessionTitle = "Grouped Session"): Result {
	return {
		type: "message",
		id,
		title: `Message ${id}`,
		sessionId,
		sessionTitle,
		snippet: `<b>${token}</b> body ${id}`,
		timestamp: NOW - 2000,
		archived: false,
		score,
	};
}

test.describe("Search page grouped-results fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("multiple message matches group into a single session card", async ({ page }) => {
		const rows = Array.from({ length: 5 }, (_, i) => message(`msg-${i}`, "session-1", "Quacker"));
		await setupSearch(page, rows, "Quacker");

		const card = page.locator('[data-role="result-group"][data-kind="session"][data-key="session:session-1"]');
		await expect(card).toHaveCount(1, { timeout: 10_000 });
		await expect(card.locator("span").filter({ hasText: /in messages|matches/i }).first())
			.toHaveText(/5\s*(in messages|matches)/i);
		await expect(card).toHaveAttribute("data-expanded", "false");
	});

	test("expanding a grouped card reveals nested message rows", async ({ page }) => {
		const rows = Array.from({ length: 5 }, (_, i) => message(`expand-${i}`, "session-2", "ExpandTok"));
		await setupSearch(page, rows, "ExpandTok");

		const card = page.locator('[data-role="result-group"][data-key="session:session-2"]');
		await expect(card).toHaveAttribute("data-expanded", "false", { timeout: 10_000 });
		await card.locator('[data-role="group-chevron"]').click();
		await expect(card).toHaveAttribute("data-expanded", "true");
		await expect(card.locator('[data-role="result-child"]')).toHaveCount(5);
	});

	test("message-only groups and rows use the resolved parent session title", async ({ page }) => {
		const rows = [message("goal-message", "goal-session", "GoalTok", 3, "Fix Search Titles: Grouped Session")];
		await setupSearch(page, rows, "GoalTok");

		const card = page.locator('[data-role="result-group"][data-key="session:goal-session"]');
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card.locator("span").filter({ hasText: "Fix Search Titles: Grouped Session" }).first()).toBeVisible();
		await expect(card, "message-derived session card should not fall back to Untitled").not.toContainText(/Untitled(?: session)?/i);
		await expect(card.locator('[data-role="result-child"]').first()).toContainText("Fix Search Titles: Grouped Session");
	});

	test("nested message rows inherit the direct parent session title context", async ({ page }) => {
		const rawMessageTitle = "Raw Message Row Title";
		const rows: Result[] = [
			session("parent-session", "Grouped Session", 4),
			{
				...message("parent-message", "parent-session", "ParentTok", 3, undefined),
				title: rawMessageTitle,
				sessionTitle: undefined,
			},
		];
		await setupSearch(page, rows, "ParentTok");

		const card = page.locator('[data-role="result-group"][data-key="session:parent-session"]');
		await expect(card).toHaveAttribute("data-expanded", "false", { timeout: 10_000 });
		await card.locator('[data-role="group-chevron"]').click();
		const child = card.locator('[data-role="result-child"]').first();
		await expect(child, "expanded message rows should use parent session title context").toContainText("Grouped Session");
		await expect(child, "expanded message rows should not render the raw message row title").not.toContainText(rawMessageTitle);
	});

	test("a group with exactly one total match auto-expands", async ({ page }) => {
		await setupSearch(page, [session("single-session", "UniqueTitleMatchOnly")], "UniqueTitleMatchOnly");

		const card = page.locator('[data-role="result-group"][data-kind="session"]').filter({ hasText: "UniqueTitleMatchOnly" });
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card).toHaveAttribute("data-expanded", "true");
	});

	test("type filter pills hide, show, and recompute grouped cards", async ({ page }) => {
		const rows = [
			goal("goal-1", "Filter Goal", 10),
			session("session-3", "Grouped Session", 2),
			message("filter-1", "session-3", "FilterTok", 6),
			message("filter-2", "session-3", "FilterTok", 6),
			message("filter-3", "session-3", "FilterTok", 6),
		];
		await setupSearch(page, rows, "FilterTok");

		const goalCards = page.locator('[data-role="result-group"][data-kind="goal"]').filter({ hasText: "Filter Goal" });
		const sessionCards = page.locator('[data-role="result-group"][data-key="session:session-3"]');
		await expect(goalCards).toHaveCount(1, { timeout: 10_000 });
		await expect(sessionCards).toHaveCount(1, { timeout: 10_000 });

		for (const label of ["Goals", "Sessions", "Staff"]) {
			await page.getByRole("button", { name: label, exact: true }).click();
		}
		await expect(goalCards).toHaveCount(0);
		await expect(sessionCards).toHaveCount(1);
		await expect(sessionCards.first().locator("span").filter({ hasText: /in messages|matches/i }).first())
			.toHaveText(/3\s*(in messages|matches)/i);

		await page.getByRole("button", { name: "Goals", exact: true }).click();
		await page.getByRole("button", { name: "Messages", exact: true }).click();
		await expect(goalCards).toHaveCount(1);
		await expect(sessionCards).toHaveCount(0);

		await page.getByRole("button", { name: "Messages", exact: true }).click();
		await expect(goalCards).toHaveCount(1);
		await expect(sessionCards).toHaveCount(1);
	});

	test("stale-click shows an inline toast, not a modal", async ({ page }) => {
		await setupSearch(page, [], "");
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("search-result-stale", {
				detail: { kind: "session", id: "00000000-0000-0000-0000-000000000000" },
			}));
		});

		const toast = page.locator('[data-role="stale-toast"]');
		await expect(toast).toBeVisible({ timeout: 5_000 });
		await expect(toast).toContainText(/no longer available/i);
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await toast.locator("button", { hasText: /dismiss/i }).click();
		await expect(toast).toHaveCount(0);
	});
});
