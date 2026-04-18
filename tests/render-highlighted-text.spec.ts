/**
 * Unit tests for renderHighlightedText / splitByQuery and the archived filter
 * predicates in src/app/render-helpers.ts.
 *
 * These run as Playwright file:// fixture tests to match the rest of the unit
 * suite. The fixture HTML mirrors the pure-function source; integration at
 * the lit-html level is covered by the browser E2E in
 * tests/e2e/ui/sidebar-mobile-archived-search.spec.ts.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/render-highlighted-text.html").replace(/\\/g, "/")}`;

test.describe("splitByQuery", () => {
	test.beforeEach(async ({ page }) => { await page.goto(TEST_PAGE); });

	test("empty query returns the text as a single unmatched segment", async ({ page }) => {
		const r = await page.evaluate(() => (window as any).__highlight.splitByQuery("hello world", ""));
		expect(r).toEqual([{ text: "hello world", matched: false }]);
	});

	test("null/undefined query returns text unchanged", async ({ page }) => {
		const r1 = await page.evaluate(() => (window as any).__highlight.splitByQuery("foo", null));
		const r2 = await page.evaluate(() => (window as any).__highlight.splitByQuery("foo", undefined));
		expect(r1).toEqual([{ text: "foo", matched: false }]);
		expect(r2).toEqual([{ text: "foo", matched: false }]);
	});

	test("single case-insensitive match preserves original casing", async ({ page }) => {
		const r = await page.evaluate(() => (window as any).__highlight.splitByQuery("My Story Title", "story"));
		expect(r).toEqual([
			{ text: "My ", matched: false },
			{ text: "Story", matched: true },
			{ text: " Title", matched: false },
		]);
	});

	test("bolds every occurrence", async ({ page }) => {
		const r = await page.evaluate(() => (window as any).__highlight.splitByQuery("foo FOO Foo", "foo"));
		const matched = r.filter((s: any) => s.matched).map((s: any) => s.text);
		expect(matched).toEqual(["foo", "FOO", "Foo"]);
	});

	test("regex special characters in query are escaped", async ({ page }) => {
		for (const q of [".*", "(", "[", "+", "$", "\\"]) {
			const r = await page.evaluate((qq) => (window as any).__highlight.splitByQuery(`literal${qq}match${qq}here`, qq), q);
			const matched = r.filter((s: any) => s.matched).map((s: any) => s.text);
			expect(matched).toEqual([q, q]);
		}
	});

	test("query not found → single unmatched segment (no bolding)", async ({ page }) => {
		const r = await page.evaluate(() => (window as any).__highlight.splitByQuery("hello world", "zzz"));
		expect(r).toEqual([{ text: "hello world", matched: false }]);
	});

	test("empty text returns empty result", async ({ page }) => {
		const r = await page.evaluate(() => (window as any).__highlight.splitByQuery("", "foo"));
		expect(r).toEqual([]);
	});
});

test.describe("filterArchivedGoalsByQuery", () => {
	test.beforeEach(async ({ page }) => { await page.goto(TEST_PAGE); });

	const live = [
		{ id: "s1", title: "Implementation session", role: "coder", goalId: "g1" },
		{ id: "s2", title: "Widget", role: "reviewer", teamGoalId: "g2" },
		{ id: "s3", title: "Delegate", role: "coder", delegateOf: "s1", goalId: "g1" },
	];
	const archivedSess = [
		{ id: "as1", title: "arc-sess", role: "tester", teamGoalId: "g2" },
	];
	const goals = [
		{ id: "g1", title: "Alpha story goal" },
		{ id: "g2", title: "Unrelated" },
		{ id: "g3", title: "Orphan" },
	];

	test("empty query returns all goals", async ({ page }) => {
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, ""),
			{ goals, live, archivedSess });
		expect(r.map((g: any) => g.id)).toEqual(["g1", "g2", "g3"]);
	});

	test("matches goal title case-insensitively", async ({ page }) => {
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, "STORY"),
			{ goals, live, archivedSess });
		expect(r.map((g: any) => g.id)).toEqual(["g1"]);
	});

	test("matches affiliated live session by title", async ({ page }) => {
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, "widget"),
			{ goals, live, archivedSess });
		expect(r.map((g: any) => g.id)).toEqual(["g2"]);
	});

	test("matches affiliated archived session by title", async ({ page }) => {
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, "arc-sess"),
			{ goals, live, archivedSess });
		expect(r.map((g: any) => g.id)).toEqual(["g2"]);
	});

	test("matches affiliated session by role", async ({ page }) => {
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, "reviewer"),
			{ goals, live, archivedSess });
		expect(r.map((g: any) => g.id)).toEqual(["g2"]);
	});

	test("ignores delegate sessions when matching affiliated titles", async ({ page }) => {
		// "Delegate" is the title of a delegate session under s1; it should NOT
		// surface goal g1 because affiliated-match is limited to non-delegates.
		const r = await page.evaluate(({ goals: g, live, archivedSess }) =>
			(window as any).__highlight.filterArchivedGoalsByQuery(g, live, archivedSess, "delegate"),
			{ goals, live, archivedSess });
		expect(r).toEqual([]);
	});
});

test.describe("filterArchivedSessionsByQuery", () => {
	test.beforeEach(async ({ page }) => { await page.goto(TEST_PAGE); });

	test("filters by title and role, empty query passes through", async ({ page }) => {
		const sessions = [
			{ id: "a", title: "story session", role: "coder" },
			{ id: "b", title: "unrelated", role: "reviewer" },
			{ id: "c", title: null, role: "story-hunter" },
		];
		const none = await page.evaluate((s) => (window as any).__highlight.filterArchivedSessionsByQuery(s, ""), sessions);
		expect(none.map((s: any) => s.id)).toEqual(["a", "b", "c"]);
		const byTitle = await page.evaluate((s) => (window as any).__highlight.filterArchivedSessionsByQuery(s, "STORY"), sessions);
		expect(byTitle.map((s: any) => s.id).sort()).toEqual(["a", "c"]);
		const byRole = await page.evaluate((s) => (window as any).__highlight.filterArchivedSessionsByQuery(s, "reviewer"), sessions);
		expect(byRole.map((s: any) => s.id)).toEqual(["b"]);
	});
});
