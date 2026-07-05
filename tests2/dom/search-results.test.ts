import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/search-results.spec.ts (v2-dom tier).
// The legacy fixture was a plain-JS REPLICA; this port renders the REAL
// <search-results> lit component (light DOM) under happy-dom and asserts the
// same user-visible facts (grouping, per-group counts, result-click detail,
// empty/loading/updating/no-query states, snippet sanitization). Selectors are
// adapted to the real component's markup since the replica's `.group-header` /
// `[data-group]` / `[data-testid]` hooks do not exist in production.
import { afterEach, describe, expect, it } from "vitest";
import "../../src/ui/components/SearchResults.js";

const SAMPLE_RESULTS = [
	{ type: "goal", id: "g1", title: "My Goal", snippet: "goal <b>match</b>", timestamp: Date.now(), archived: false },
	{ type: "goal", id: "g2", title: "Another Goal", snippet: "second <b>goal</b>", timestamp: Date.now(), archived: true },
	{ type: "session", id: "s1", title: "Chat Session", snippet: "session <b>result</b>", timestamp: Date.now(), archived: false, goalId: "g1" },
	{ type: "message", id: "m1", title: "Message Hit", snippet: "message <b>text</b>", timestamp: Date.now(), archived: false, sessionId: "s1", goalId: "g1" },
] as any[];

afterEach(() => { document.body.innerHTML = ""; });

async function mount(state: { results?: any[]; loading?: boolean; query?: string }) {
	const el = document.createElement("search-results") as any;
	el.results = state.results ?? [];
	el.loading = state.loading ?? false;
	el.query = state.query ?? "";
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement;
}

/** Result rows are the clickable <button> elements. */
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll("button"));

describe("SearchResults: grouping", () => {
	it("groups results by type with correct headers", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, query: "match" });
		const text = el.textContent || "";
		expect(text).toContain("Goals");
		expect(text).toContain("Sessions");
		expect(text).toContain("Messages");
	});

	it("groups contain correct number of items in Goals/Sessions/Messages order", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, query: "match" });
		const titles = rows(el).map(b => b.querySelector(".truncate")?.textContent?.trim());
		// Render order: goals (2), sessions (1), messages (1).
		expect(titles).toEqual(["My Goal", "Another Goal", "Chat Session", "Message Hit"]);
	});
});

describe("SearchResults: result-click event", () => {
	it("clicking a goal fires result-click with correct detail", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, query: "match" });
		const events: any[] = [];
		el.addEventListener("result-click", (e) => events.push((e as CustomEvent).detail));
		rows(el)[0].click(); // first goal g1
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(expect.objectContaining({ type: "goal", id: "g1" }));
	});

	it("clicking a message result includes sessionId and goalId", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, query: "match" });
		const events: any[] = [];
		el.addEventListener("result-click", (e) => events.push((e as CustomEvent).detail));
		rows(el)[3].click(); // message m1
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(expect.objectContaining({ type: "message", id: "m1", sessionId: "s1", goalId: "g1" }));
	});

	it("clicking a session result includes goalId", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, query: "match" });
		const events: any[] = [];
		el.addEventListener("result-click", (e) => events.push((e as CustomEvent).detail));
		rows(el)[2].click(); // session s1
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(expect.objectContaining({ type: "session", id: "s1", goalId: "g1" }));
	});
});

describe("SearchResults: empty state", () => {
	it("shows 'No matches for ...' when query set but no results", async () => {
		const el = await mount({ results: [], query: "nonexistent" });
		expect(el.textContent).toContain('No matches for "nonexistent"');
	});

	it("no group headers / rows present in empty state", async () => {
		const el = await mount({ results: [], query: "nothing" });
		expect(rows(el)).toHaveLength(0);
		expect(el.textContent).not.toContain("Goals");
	});
});

describe("SearchResults: loading state", () => {
	it("shows 'Searching...' when loading with no results", async () => {
		const el = await mount({ results: [], loading: true, query: "test" });
		expect(el.textContent).toContain("Searching");
	});

	it("shows 'Updating...' when loading with existing results", async () => {
		const el = await mount({ results: SAMPLE_RESULTS, loading: true, query: "match" });
		expect(el.textContent).toContain("Updating");
		// Results should still be visible alongside the updating indicator.
		expect(rows(el).length).toBeGreaterThan(0);
	});
});

describe("SearchResults: no query state", () => {
	it("renders nothing when query is empty", async () => {
		const el = await mount({ results: [], query: "" });
		expect((el.textContent || "").trim()).toBe("");
		expect(rows(el)).toHaveLength(0);
	});
});

describe("SearchResults: snippet sanitization", () => {
	it("allows <b> tags for highlighting but escapes other HTML", async () => {
		const maliciousResults = [
			{
				type: "goal",
				id: "xss1",
				title: "XSS Test",
				snippet: '<b>safe</b> <script>alert("xss")</script> <img onerror=alert(1)>',
				timestamp: Date.now(),
				archived: false,
			},
		];
		const el = await mount({ results: maliciousResults, query: "test" });
		const snippetHTML = el.querySelector(".search-snippet")!.innerHTML;
		// <b> tags should be preserved.
		expect(snippetHTML).toContain("<b>safe</b>");
		// <script> and <img> should be escaped.
		expect(snippetHTML).not.toContain("<script>");
		expect(snippetHTML).not.toContain("<img");
		expect(snippetHTML).toContain("&lt;script&gt;");
	});
});
