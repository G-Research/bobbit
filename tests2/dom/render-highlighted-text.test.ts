import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/render-highlighted-text.spec.ts (v2-dom tier).
// The legacy fixture mirrored the pure helpers in plain JS; this port imports
// the REAL splitByQuery / filterArchivedGoalsByQuery / filterArchivedSessionsByQuery
// from src/app/render-helpers.ts (higher fidelity). Integration at the lit-html
// level is covered by tests/e2e/ui/sidebar-mobile-archived-search.spec.ts.
import { describe, expect, it } from "vitest";
import {
	splitByQuery,
	filterArchivedGoalsByQuery,
	filterArchivedSessionsByQuery,
	getProjectAccentColor,
} from "../../src/app/render-helpers.js";
import { HEADQUARTERS_ACCENT_COLOR } from "../../src/app/headquarters.js";

describe("getProjectAccentColor", () => {
	it("keeps the Headquarters accent neutral and foreground-weighted in light and dark modes", () => {
		const headquarters = { id: "headquarters", kind: "headquarters", color: "#ff00ff", colorLight: "#ff0000", colorDark: "#00ff00" } as any;
		document.documentElement.classList.remove("dark");
		expect(getProjectAccentColor(headquarters)).toBe(HEADQUARTERS_ACCENT_COLOR);
		document.documentElement.classList.add("dark");
		expect(getProjectAccentColor(headquarters)).toBe(HEADQUARTERS_ACCENT_COLOR);
		document.documentElement.classList.remove("dark");
	});
});

describe("splitByQuery", () => {
	it("empty query returns the text as a single unmatched segment", () => {
		expect(splitByQuery("hello world", "")).toEqual([{ text: "hello world", matched: false }]);
	});

	it("null/undefined query returns text unchanged", () => {
		expect(splitByQuery("foo", null)).toEqual([{ text: "foo", matched: false }]);
		expect(splitByQuery("foo", undefined)).toEqual([{ text: "foo", matched: false }]);
	});

	it("single case-insensitive match preserves original casing", () => {
		expect(splitByQuery("My Story Title", "story")).toEqual([
			{ text: "My ", matched: false },
			{ text: "Story", matched: true },
			{ text: " Title", matched: false },
		]);
	});

	it("bolds every occurrence", () => {
		const r = splitByQuery("foo FOO Foo", "foo");
		const matched = r.filter((s) => s.matched).map((s) => s.text);
		expect(matched).toEqual(["foo", "FOO", "Foo"]);
	});

	it("regex special characters in query are escaped", () => {
		for (const q of [".*", "(", "[", "+", "$", "\\"]) {
			const r = splitByQuery(`literal${q}match${q}here`, q);
			const matched = r.filter((s) => s.matched).map((s) => s.text);
			expect(matched).toEqual([q, q]);
		}
	});

	it("query not found → single unmatched segment (no bolding)", () => {
		expect(splitByQuery("hello world", "zzz")).toEqual([{ text: "hello world", matched: false }]);
	});

	it("empty text returns empty result", () => {
		expect(splitByQuery("", "foo")).toEqual([]);
	});
});

describe("filterArchivedGoalsByQuery", () => {
	const live = [
		{ id: "s1", title: "Implementation session", role: "coder", goalId: "g1" },
		{ id: "s2", title: "Widget", role: "reviewer", teamGoalId: "g2" },
		{ id: "s3", title: "Delegate", role: "coder", delegateOf: "s1", goalId: "g1" },
	] as any;
	const archivedSess = [
		{ id: "as1", title: "arc-sess", role: "tester", teamGoalId: "g2" },
	] as any;
	const goals = [
		{ id: "g1", title: "Alpha story goal" },
		{ id: "g2", title: "Unrelated" },
		{ id: "g3", title: "Orphan" },
	] as any;

	it("empty query returns all goals", () => {
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "");
		expect(r.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
	});

	it("matches goal title case-insensitively", () => {
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "STORY");
		expect(r.map((g) => g.id)).toEqual(["g1"]);
	});

	it("matches affiliated live session by title", () => {
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "widget");
		expect(r.map((g) => g.id)).toEqual(["g2"]);
	});

	it("matches affiliated archived session by title", () => {
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "arc-sess");
		expect(r.map((g) => g.id)).toEqual(["g2"]);
	});

	it("matches affiliated session by role", () => {
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "reviewer");
		expect(r.map((g) => g.id)).toEqual(["g2"]);
	});

	it("ignores delegate sessions when matching affiliated titles", () => {
		// "Delegate" is the title of a delegate session under s1; it should NOT
		// surface goal g1 because affiliated-match is limited to non-delegates.
		const r = filterArchivedGoalsByQuery(goals, live, archivedSess, "delegate");
		expect(r).toEqual([]);
	});
});

describe("filterArchivedSessionsByQuery", () => {
	it("filters by title and role, empty query passes through", () => {
		const sessions = [
			{ id: "a", title: "story session", role: "coder" },
			{ id: "b", title: "unrelated", role: "reviewer" },
			{ id: "c", title: null, role: "story-hunter" },
		] as any;
		const none = filterArchivedSessionsByQuery(sessions, "");
		expect(none.map((s) => s.id)).toEqual(["a", "b", "c"]);
		const byTitle = filterArchivedSessionsByQuery(sessions, "STORY");
		expect(byTitle.map((s) => s.id).sort()).toEqual(["a", "c"]);
		const byRole = filterArchivedSessionsByQuery(sessions, "reviewer");
		expect(byRole.map((s) => s.id)).toEqual(["b"]);
	});
});
