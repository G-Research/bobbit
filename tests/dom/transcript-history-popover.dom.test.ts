import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptHistoryEntry } from "../../src/ui/transcript-history.js";
import type { TranscriptHistoryPopover, TranscriptHistorySelectDetail } from "../../src/ui/components/TranscriptHistoryPopover.js";

const ENTRIES: TranscriptHistoryEntry[] = [
	{
		id: "entry-user",
		targetId: "target-user",
		ordinal: 0,
		kind: "user",
		author: { kind: "user", id: "user:local", label: "User" },
		authorLabel: "You",
		typeLabel: "Prompt",
		excerpt: "Set up the release checklist",
		unresolved: false,
	},
	{
		id: "entry-agent",
		targetId: "target-agent",
		ordinal: 1,
		kind: "agent",
		author: { kind: "agent", id: "session:primary", label: "Primary assistant" },
		authorLabel: "Primary assistant",
		typeLabel: "Response",
		excerpt: "The checklist is ready for review",
		unresolved: false,
	},
	{
		id: "entry-question",
		targetId: "target-question",
		ordinal: 2,
		kind: "question",
		author: { kind: "agent", id: "session:primary", label: "Primary assistant" },
		authorLabel: "Primary assistant",
		typeLabel: "Question",
		excerpt: "Which release channel should be used?",
		unresolved: true,
	},
	{
		id: "entry-system",
		targetId: "target-system",
		ordinal: 3,
		kind: "system",
		author: { kind: "system", id: "system:bobbit", label: "System" },
		authorLabel: "System",
		typeLabel: "Event",
		excerpt: "Verification completed",
		unresolved: false,
	},
];

beforeAll(async () => {
	await import("../../src/ui/components/TranscriptHistoryPopover.js");
	__syncCE();
});

beforeEach(() => {
	const canvasContext = new Proxy({}, { get: () => () => {}, set: () => true });
	vi.spyOn(HTMLCanvasElement.prototype, "getContext")
		.mockReturnValue(canvasContext as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
		.mockReturnValue("data:image/png;base64,c3RhdGlj");
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

async function settle(element?: TranscriptHistoryPopover): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
		if (element) await element.updateComplete;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function mount(options: {
	entries?: TranscriptHistoryEntry[];
	anchor?: HTMLElement;
	availableHeight?: number;
	resolvePromptAuthorAppearance?: TranscriptHistoryPopover["resolvePromptAuthorAppearance"];
} = {}): Promise<TranscriptHistoryPopover> {
	const popover = document.createElement("transcript-history-popover") as TranscriptHistoryPopover;
	popover.entries = options.entries ?? ENTRIES;
	popover.anchorEl = options.anchor ?? null;
	popover.availableHeight = options.availableHeight ?? 535;
	popover.resolvePromptAuthorAppearance = options.resolvePromptAuthorAppearance;
	popover.open = true;
	document.body.appendChild(popover);
	await settle(popover);
	return popover;
}

function rows(popover: ParentNode): HTMLButtonElement[] {
	return Array.from(popover.querySelectorAll<HTMLButtonElement>(".transcript-history-row"));
}

function clickFilter(popover: ParentNode, label: string): void {
	const button = Array.from(popover.querySelectorAll<HTMLButtonElement>(".transcript-history-filter"))
		.find((candidate) => candidate.textContent?.trim() === label);
	if (!button) throw new Error(`Missing ${label} filter`);
	button.click();
}

describe("TranscriptHistoryPopover", () => {
	it("renders an accessible light-DOM dialog in transcript order without groups or shortcuts", async () => {
		const resolveAppearance = vi.fn(() => ({ hueRotate: 45, accessoryId: "none" }));
		const popover = await mount({ availableHeight: 240, resolvePromptAuthorAppearance: resolveAppearance });
		const dialog = popover.querySelector<HTMLElement>("[role='dialog']");
		const search = popover.querySelector<HTMLInputElement>(".transcript-history-search");

		expect(popover.shadowRoot).toBeNull();
		expect(dialog?.getAttribute("aria-modal")).toBe("false");
		expect(dialog?.getAttribute("aria-labelledby")).toBe("transcript-history-title");
		expect(dialog?.style.getPropertyValue("--transcript-history-available-height")).toBe("240px");
		expect(popover.querySelector("style")?.textContent).not.toContain("100dvh");
		expect(popover.querySelector("label[for='transcript-history-search']")?.textContent).toBe("Search transcript");
		expect(document.activeElement).toBe(search);
		expect(rows(popover).map((row) => row.dataset.entryId)).toEqual([
			"entry-user",
			"entry-agent",
			"entry-question",
			"entry-system",
		]);
		expect(rows(popover)[2].getAttribute("aria-label")).toContain("Primary assistant, Question, unanswered");
		expect(Array.from(popover.querySelectorAll<HTMLElement>(".transcript-history-row-icon"))
			.map((rowIcon) => rowIcon.dataset.kind)).toEqual(["user", "agent", "question", "system"]);
		expect(popover.querySelectorAll(".transcript-history-row-icon .prompt-author-avatar")).toHaveLength(2);
		expect(Array.from(popover.querySelectorAll<HTMLElement>(".transcript-history-row-icon .prompt-author-initial"))
			.map((initial) => initial.dataset.initial)).toEqual(["U"]);
		expect(popover.querySelectorAll(".transcript-history-row-icon .prompt-author-system-icon svg")).toHaveLength(1);
		expect(resolveAppearance).toHaveBeenCalledTimes(2);
		expect(popover.textContent).not.toContain("Oldest → newest");
		expect(popover.textContent).not.toContain("Recent");
		expect(popover.textContent).not.toContain("Earlier today");
		expect(popover.querySelector(".transcript-history-footer")).toBeNull();
		const styles = popover.querySelector("style")?.textContent;
		expect(styles).toContain("flex-wrap: wrap");
		expect(styles).toContain("background: var(--card)");
		expect(styles).toContain("width: min(420px");
		expect(popover.querySelector("kbd")).toBeNull();
	});

	it("shows unanswered, answered, and dismissed question status", async () => {
		const question = ENTRIES[2];
		const popover = await mount({
			entries: [
				{ ...question, id: "question-unanswered", questionStatus: "unanswered", unresolved: true },
				{ ...question, id: "question-answered", questionStatus: "answered", unresolved: false },
				{ ...question, id: "question-dismissed", questionStatus: "dismissed", unresolved: false },
			],
		});
		expect(Array.from(popover.querySelectorAll<HTMLElement>(".transcript-history-question-status"))
			.map((status) => [status.dataset.status, status.textContent])).toEqual([
			["unanswered", "Unanswered"],
			["answered", "Answered"],
			["dismissed", "Dismissed"],
		]);
		expect(rows(popover).map((row) => row.getAttribute("aria-label"))).toEqual([
			expect.stringContaining(", unanswered:"),
			expect.stringContaining(", answered:"),
			expect.stringContaining(", dismissed:"),
		]);
	});

	it("opens with the chronological list scrolled to its newest match", async () => {
		const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
		const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
		const positions = new WeakMap<HTMLElement, number>();
		const writes: number[] = [];
		Object.defineProperties(HTMLElement.prototype, {
			scrollTop: {
				configurable: true,
				get(this: HTMLElement) { return positions.get(this) ?? 0; },
				set(this: HTMLElement, value: number) {
					positions.set(this, value);
					if (this.classList.contains("transcript-history-list")) writes.push(value);
				},
			},
			scrollHeight: {
				configurable: true,
				get(this: HTMLElement) {
					return this.classList.contains("transcript-history-list") ? 640 : 0;
				},
			},
		});
		try {
			const popover = await mount();
			expect(popover.querySelector(".transcript-history-list")?.scrollTop).toBe(640);
			expect(writes).toContain(640);
		} finally {
			if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
			else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
			if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
			else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
		}
	});

	it("composes author/type filters with search and renders the empty state", async () => {
		const popover = await mount();
		clickFilter(popover, "Agents");
		await settle(popover);
		expect(rows(popover).map((row) => row.dataset.entryId)).toEqual(["entry-agent"]);
		expect(popover.querySelector(".transcript-history-filter[aria-pressed='true']")?.textContent?.trim()).toBe("Agents");

		const search = popover.querySelector<HTMLInputElement>(".transcript-history-search")!;
		search.value = "not in the agent response";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await settle(popover);
		expect(rows(popover)).toHaveLength(0);
		expect(popover.querySelector("[role='status']")?.textContent).toBe("No matching prompts");

		search.value = "ready for review";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await settle(popover);
		expect(rows(popover).map((row) => row.dataset.entryId)).toEqual(["entry-agent"]);

		clickFilter(popover, "Questions");
		await settle(popover);
		expect(rows(popover)).toHaveLength(0);
	});

	it("dismisses on outside pointer and Escape, restores trigger focus, and ignores trigger pointers", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "Jump to…";
		document.body.appendChild(trigger);
		trigger.focus();
		const popover = await mount({ anchor: trigger });
		const close = vi.fn();
		popover.addEventListener("close", close);

		trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await settle(popover);
		expect(popover.open).toBe(true);
		expect(close).not.toHaveBeenCalled();

		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await settle(popover);
		expect(popover.open).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(trigger);

		popover.open = true;
		await settle(popover);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle(popover);
		expect(popover.open).toBe(false);
		expect(close).toHaveBeenCalledTimes(2);
		expect(document.activeElement).toBe(trigger);
	});

	it("closes and emits the selected entry while preserving or following the live list tail", async () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		const popover = await mount({ entries: ENTRIES.slice(0, 3), anchor: trigger });
		const list = popover.querySelector<HTMLElement>(".transcript-history-list")!;
		Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(list, "scrollHeight", {
			configurable: true,
			get: () => rows(popover).length * 100,
		});

		list.scrollTop = 50;
		popover.entries = ENTRIES;
		await settle(popover);
		expect(list.scrollTop).toBe(50);

		list.scrollTop = 300;
		popover.entries = [...ENTRIES, {
			...ENTRIES[1],
			id: "entry-new",
			targetId: "target-new",
			ordinal: 4,
			excerpt: "Newest agent response",
		}];
		await settle(popover);
		expect(list.scrollTop).toBe(500);

		list.scrollTop = 25;
		clickFilter(popover, "Questions");
		await settle(popover);
		expect(list.scrollTop).toBe(100);
		clickFilter(popover, "All");
		await settle(popover);

		const selected = vi.fn((event: Event) =>
			(event as CustomEvent<TranscriptHistorySelectDetail>).detail);
		popover.addEventListener("transcript-entry-select", selected);
		rows(popover)[0].click();
		await settle(popover);
		expect(popover.open).toBe(false);
		expect(selected).toHaveBeenCalledTimes(1);
		expect(selected.mock.results[0].value).toEqual({
			entry: popover.entries[0],
			targetId: "target-user",
		});
		expect(document.activeElement).toBe(trigger);
	});
});
