import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/search-box.spec.ts (v2-dom tier).
// The legacy fixture was a plain-JS REPLICA; this port renders the REAL
// <search-box> lit component (light DOM) under happy-dom and asserts the same
// user-visible behaviors (debounced search-input, Escape clear+blur, clear
// button, Full Search event, controls-row disclosure, no Content toggle).
//
// Two legacy behaviors are intentionally NOT ported because they are NOT the
// component's responsibility in production (the replica invented them):
//  - "Ctrl+K focuses the input": the focus shortcut is registered globally in
//    main.ts via the shortcut-registry (`focus-search`), not by <search-box>.
//  - "controls row visibility tied to query": the real component exposes a
//    `showControls` property that the parent sidebar drives; the row's
//    max-height/opacity reflect that property (asserted below), not the query.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/ui/components/SearchBox.js";

afterEach(() => { document.body.innerHTML = ""; });

async function mount(props: { query?: string; showControls?: boolean } = {}) {
	const el = document.createElement("search-box") as any;
	if (props.query !== undefined) el.query = props.query;
	if (props.showControls !== undefined) el.showControls = props.showControls;
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement;
}

const input = (el: HTMLElement) => el.querySelector("input[data-search]") as HTMLInputElement;
const clearBtn = (el: HTMLElement) => el.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement | null;
const fullSearchBtn = (el: HTMLElement) =>
	Array.from(el.querySelectorAll("button")).find(b => (b.textContent || "").includes("Full Search")) as HTMLButtonElement | undefined;
const controlsRow = (el: HTMLElement) => el.querySelector(".overflow-hidden") as HTMLElement;

function typeInto(inp: HTMLInputElement, value: string) {
	inp.value = value;
	inp.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SearchBox: debounced input", () => {
	it("typing fires search-input event after ~200ms debounce", async () => {
		vi.useFakeTimers();
		try {
			const el = await mount();
			const events: any[] = [];
			el.addEventListener("search-input", (e) => events.push((e as CustomEvent).detail));

			typeInto(input(el), "hello");
			// Immediately after typing, no event yet.
			expect(events).toHaveLength(0);

			vi.advanceTimersByTime(200);
			expect(events).toHaveLength(1);
			expect(events[0].query).toBe("hello");
		} finally {
			vi.useRealTimers();
		}
	});

	it("rapid typing only fires one debounced event", async () => {
		vi.useFakeTimers();
		try {
			const el = await mount();
			const events: any[] = [];
			el.addEventListener("search-input", (e) => events.push((e as CustomEvent).detail));

			const inp = input(el);
			typeInto(inp, "a");
			typeInto(inp, "ab");
			typeInto(inp, "abc");
			// Still within the debounce window — no event yet.
			expect(events).toHaveLength(0);

			vi.advanceTimersByTime(200);
			expect(events).toHaveLength(1);
			expect(events[0].query).toBe("abc");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("SearchBox: Escape key", () => {
	it("Escape clears query and blurs input", async () => {
		const el = await mount();
		const inp = input(el);
		inp.focus();
		typeInto(inp, "test query");
		await (el as any).updateComplete;
		expect((el as any).query).toBe("test query");

		const events: any[] = [];
		el.addEventListener("search-clear", () => events.push(true));
		inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await (el as any).updateComplete;

		// Query cleared, input emptied, input blurred, search-clear fired.
		expect((el as any).query).toBe("");
		expect(inp.value).toBe("");
		expect(document.activeElement).not.toBe(inp);
		expect(events).toHaveLength(1);
	});
});

describe("SearchBox: clear button", () => {
	it("clear button absent when query is empty", async () => {
		const el = await mount();
		expect(clearBtn(el)).toBeNull();
	});

	it("clear button present when query is non-empty", async () => {
		const el = await mount({ query: "foo" });
		expect(clearBtn(el)).not.toBeNull();
	});

	it("clicking clear button fires search-clear and resets query", async () => {
		const el = await mount({ query: "something" });
		const events: any[] = [];
		el.addEventListener("search-clear", () => events.push(true));

		clearBtn(el)!.click();
		await (el as any).updateComplete;

		expect((el as any).query).toBe("");
		expect(input(el).value).toBe("");
		expect(events).toHaveLength(1);
	});
});

describe("SearchBox: Full Search link", () => {
	it("Full Search click fires full-search-click event with query", async () => {
		const el = await mount({ query: "my search", showControls: true });
		const events: any[] = [];
		el.addEventListener("full-search-click", (e) => events.push((e as CustomEvent).detail));

		fullSearchBtn(el)!.click();

		expect(events).toHaveLength(1);
		expect(events[0].query).toBe("my search");
	});
});

describe("SearchBox: controls row visibility (showControls-driven)", () => {
	it("controls row collapsed when showControls is false", async () => {
		const el = await mount({ showControls: false });
		expect(controlsRow(el).style.opacity).toBe("0");
		expect(controlsRow(el).style.maxHeight).toBe("0");
	});

	it("controls row expanded when showControls is true", async () => {
		const el = await mount({ showControls: true });
		expect(controlsRow(el).style.opacity).toBe("1");
		expect(controlsRow(el).style.maxHeight).toBe("28px");
	});

	it("controls row collapses again when showControls is cleared", async () => {
		const el = await mount({ showControls: true });
		expect(controlsRow(el).style.opacity).toBe("1");
		(el as any).showControls = false;
		await (el as any).updateComplete;
		expect(controlsRow(el).style.opacity).toBe("0");
	});
});

describe("SearchBox: Content toggle removed", () => {
	it("no Content toggle exists in the component", async () => {
		const el = await mount({ query: "x", showControls: true });
		expect(el.querySelectorAll('[data-testid="content-toggle"]').length).toBe(0);
		const toggles = Array.from(el.querySelectorAll("button, input[type=checkbox]"))
			.filter(b => b.textContent?.includes("Content"));
		expect(toggles.length).toBe(0);
	});
});
