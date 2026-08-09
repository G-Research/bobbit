import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAnnotation,
	clearAllAnnotations,
} from "../../src/ui/components/review/AnnotationStore.js";
import "../../src/ui/components/review/ReviewPane.js";

const REGRESSION = "REVIEW_GROUP_PRIMARY_TAB";

type DesiredReviewFile = {
	fileId: string;
	title: string;
	markdown: string;
};

type DesiredReviewGroup = {
	reviewId: string;
	title: string;
	files: DesiredReviewFile[];
	activeFileId: string;
	source: { kind: "markdown-review"; sessionId: string };
};

type DesiredReviewPane = HTMLElement & {
	review: DesiredReviewGroup;
	sessionId: string;
	updateComplete: Promise<unknown>;
};

const sessionsToClear = new Set<string>();

function group(
	reviewId = "review-1",
	fileCount = 2,
	sessionId = `session-${reviewId}`,
): DesiredReviewGroup {
	const files = Array.from({ length: fileCount }, (_, index) => ({
		fileId: `${reviewId}-file-${index + 1}`,
		title: `${String.fromCharCode(65 + index)}.md`,
		markdown: `# File ${index + 1}\n\nBody ${index + 1}`,
	}));
	return {
		reviewId,
		title: `Review ${reviewId}`,
		files,
		activeFileId: files[0]?.fileId || "",
		source: { kind: "markdown-review", sessionId },
	};
}

async function mountReview(review: DesiredReviewGroup): Promise<DesiredReviewPane> {
	const pane = document.createElement("review-pane") as unknown as DesiredReviewPane;
	pane.review = review;
	pane.sessionId = review.source.sessionId;
	document.body.appendChild(pane);
	await pane.updateComplete;
	return pane;
}

function buttonsByText(root: ParentNode, label: string): HTMLButtonElement[] {
	return Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
		.filter((button) => button.textContent?.trim() === label);
}

function secondaryBar(pane: DesiredReviewPane): HTMLElement | null {
	return pane.querySelector<HTMLElement>(".review-tab-bar");
}

function overflowTrigger(pane: DesiredReviewPane): HTMLButtonElement | null {
	return pane.querySelector<HTMLButtonElement>(
		'button[aria-haspopup="menu"], button[title="More tabs"], button[aria-label="More tabs"]',
	);
}

function controlledMenu(trigger: HTMLButtonElement): HTMLElement | null {
	const id = trigger.getAttribute("aria-controls");
	if (id) return document.getElementById(id);
	return document.querySelector<HTMLElement>('[role="menu"]');
}

async function settle(pane: DesiredReviewPane): Promise<void> {
	await Promise.resolve();
	await pane.updateComplete;
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})));
	vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(async () => {
	document.body.innerHTML = "";
	await Promise.all(Array.from(sessionsToClear, (sessionId) => clearAllAnnotations(sessionId)));
	sessionsToClear.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ReviewPane review groups", () => {
	it("renders only the selected review's files as navigation-only secondary tabs", async () => {
		const selected = group("selected", 3);
		const pane = await mountReview(selected);
		const bar = secondaryBar(pane);

		expect(bar, `${REGRESSION}: a multi-file review must render its secondary file row`).not.toBeNull();
		expect(buttonsByText(bar!, "A.md"), `${REGRESSION}: first file is missing from secondary navigation`).toHaveLength(1);
		expect(buttonsByText(bar!, "B.md"), `${REGRESSION}: second file is missing from secondary navigation`).toHaveLength(1);
		expect(buttonsByText(bar!, "C.md"), `${REGRESSION}: third file is missing from secondary navigation`).toHaveLength(1);
		expect(
			bar!.querySelector('[class*="close"], [aria-label*="close" i], [title*="close" i]'),
			`${REGRESSION}: secondary file navigation must not expose an individual-file close action`,
		).toBeNull();

		let change: CustomEvent | undefined;
		pane.addEventListener("review-file-change", (event) => { change = event as CustomEvent; });
		buttonsByText(bar!, "B.md")[0]!.click();
		await settle(pane);

		expect(change?.detail, `${REGRESSION}: selecting a secondary tab must identify the review and file`).toEqual({
			reviewId: selected.reviewId,
			fileId: selected.files[1]!.fileId,
		});
	});

	it("hides the secondary row for a one-file review", async () => {
		const pane = await mountReview(group("single", 1));
		const bar = secondaryBar(pane);
		const isHidden = bar === null
			|| bar.hidden
			|| bar.getAttribute("aria-hidden") === "true"
			|| bar.querySelectorAll("button").length === 0;

		expect(
			isHidden,
			`${REGRESSION}: a one-file review must not duplicate its file as a visible secondary tab row`,
		).toBe(true);
		expect(
			pane.querySelector("review-document")?.getAttribute("markdown")
				?? (pane.querySelector("review-document") as any)?.markdown,
			`${REGRESSION}: hiding the one-file row must still render that review's only file`,
		).toBe("# File 1\n\nBody 1");
	});

	it("allows rejection from a comment on an inactive file and aggregates every file in deterministic order", async () => {
		const review = group("decision", 2);
		const sessionId = review.source.sessionId;
		sessionsToClear.add(sessionId);
		await addAnnotation(sessionId, review.files[1]!.fileId, {
			id: "beta-comment",
			quote: "Body 2",
			comment: "Fix beta",
			start: 12,
			end: 18,
		});
		await addAnnotation(sessionId, review.files[0]!.fileId, {
			id: "alpha-comment",
			quote: "Body 1",
			comment: "Fix alpha",
			start: 12,
			end: 18,
		});

		const pane = await mountReview(review);
		let decision: CustomEvent | undefined;
		pane.addEventListener("review-decision", (event) => {
			decision = event as CustomEvent;
			event.preventDefault();
		});
		pane.querySelector<HTMLButtonElement>(".review-reject-btn")!.click();
		await settle(pane);

		expect(decision, `${REGRESSION}: a comment on any file must permit rejecting the whole review`).toBeDefined();
		const payload = decision!.detail.payload;
		expect(
			payload.inlineComments.map((comment: { fileId: string; documentTitle: string; comment: string }) => [comment.fileId, comment.documentTitle, comment.comment]),
			`${REGRESSION}: the review decision must include comments from every file in file order`,
		).toEqual([
			[review.files[0]!.fileId, "A.md", "Fix alpha"],
			[review.files[1]!.fileId, "B.md", "Fix beta"],
		]);
		expect(payload.feedback.indexOf('"A.md"'), `${REGRESSION}: alpha feedback section is missing`).toBeGreaterThan(-1);
		expect(payload.feedback.indexOf('"B.md"'), `${REGRESSION}: beta feedback section is missing`).toBeGreaterThan(payload.feedback.indexOf('"A.md"'));
		expect(payload.feedback.match(/Fix alpha/g), `${REGRESSION}: alpha feedback must be submitted exactly once`).toHaveLength(1);
		expect(payload.feedback.match(/Fix beta/g), `${REGRESSION}: beta feedback must be submitted exactly once`).toHaveLength(1);
	});

	it("keeps duplicate file titles separate by stable identity", async () => {
		const review = group("duplicates", 2);
		review.files[0]!.title = "same.md";
		review.files[1]!.title = "same.md";
		const sessionId = review.source.sessionId;
		sessionsToClear.add(sessionId);
		await addAnnotation(sessionId, review.files[0]!.fileId, {
			id: "first-duplicate",
			quote: "Body 1",
			comment: "First file note",
		});
		await addAnnotation(sessionId, review.files[1]!.fileId, {
			id: "second-duplicate",
			quote: "Body 2",
			comment: "Second file note",
		});

		const pane = await mountReview(review);
		let decision: CustomEvent | undefined;
		pane.addEventListener("review-decision", (event) => {
			decision = event as CustomEvent;
			event.preventDefault();
		});
		pane.querySelector<HTMLButtonElement>(".review-reject-btn")!.click();
		await settle(pane);

		expect(decision?.detail.payload.inlineComments.map((comment: { fileId: string }) => comment.fileId)).toEqual(
			review.files.map((file) => file.fileId),
		);
		expect(decision?.detail.payload.feedback.match(/### "same\.md"/g)).toHaveLength(2);
	});

	it("requires review-wide feedback before rejecting and exposes exact dismiss identity", async () => {
		const review = group("event-detail", 2);
		const pane = await mountReview(review);
		const decisions: CustomEvent[] = [];
		pane.addEventListener("review-decision", (event) => decisions.push(event as CustomEvent));
		pane.querySelector<HTMLButtonElement>(".review-reject-btn")!.click();
		await settle(pane);

		expect(decisions).toHaveLength(0);
		expect(pane.querySelector("[role=alert]")?.textContent).toContain("inline comment");

		let dismiss: CustomEvent | undefined;
		pane.addEventListener("review-dismiss", (event) => { dismiss = event as CustomEvent; });
		pane.querySelector<HTMLButtonElement>(".review-dismiss-btn")!.click();
		await settle(pane);
		expect(dismiss?.detail).toMatchObject({
			reviewId: review.reviewId,
			sessionId: review.source.sessionId,
			review,
			unsentCommentCount: 0,
		});
	});

	it("keeps one review-level final draft while switching files and submits it once", async () => {
		let review = group("draft", 2);
		const pane = await mountReview(review);
		pane.addEventListener("review-file-change", (event) => {
			const { fileId } = (event as CustomEvent).detail;
			review = { ...review, activeFileId: fileId };
			pane.review = review;
		});

		const textarea = pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")!;
		textarea.value = "One final review note";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await settle(pane);
		const betaTab = buttonsByText(secondaryBar(pane)!, "B.md")[0];
		expect(betaTab, `${REGRESSION}: switching files requires the second secondary navigation tab`).toBeDefined();
		betaTab!.click();
		await settle(pane);

		expect(
			pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")?.value,
			`${REGRESSION}: final comment draft must belong to the review, not its active file`,
		).toBe("One final review note");

		let decision: CustomEvent | undefined;
		pane.addEventListener("review-decision", (event) => {
			decision = event as CustomEvent;
			event.preventDefault();
		});
		pane.querySelector<HTMLButtonElement>(".review-reject-btn")!.click();
		await settle(pane);

		expect(decision?.detail.payload.finalComment, `${REGRESSION}: reject must submit the review-level final draft`).toBe("One final review note");
		expect(
			decision?.detail.payload.feedback.match(/One final review note/g),
			`${REGRESSION}: review-level final feedback must be emitted exactly once`,
		).toHaveLength(1);
	});

	it("exposes an ARIA menu in the top layer and closes it after overflow navigation", async () => {
		const review = group("overflow-nav", 7);
		const pane = await mountReview(review);
		const trigger = overflowTrigger(pane);

		expect(trigger, `${REGRESSION}: more than five files must expose a More tabs control`).not.toBeNull();
		expect(trigger!.getAttribute("aria-haspopup"), `${REGRESSION}: overflow trigger must announce a menu`).toBe("menu");
		expect(trigger!.getAttribute("aria-expanded"), `${REGRESSION}: closed overflow must expose aria-expanded=false`).toBe("false");

		trigger!.click();
		await settle(pane);
		const menu = controlledMenu(trigger!);
		expect(trigger!.getAttribute("aria-expanded"), `${REGRESSION}: open overflow must expose aria-expanded=true`).toBe("true");
		expect(menu, `${REGRESSION}: overflow menu must be visible after activation`).not.toBeNull();
		expect(menu!.getAttribute("role"), `${REGRESSION}: overflow popup must use menu semantics`).toBe("menu");
		expect(menu!.hasAttribute("popover"), `${REGRESSION}: overflow popup must escape clipping in the native top layer`).toBe(true);
		expect(menu!.closest(".review-tab-bar"), `${REGRESSION}: overflow popup must not be trapped in the clipped tab strip`).toBeNull();
		const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
		expect(items, `${REGRESSION}: overflow files must be navigation menu items`).toHaveLength(2);
		expect(
			menu!.querySelector('[class*="close"], [aria-label*="close" i], [title*="close" i]'),
			`${REGRESSION}: overflow navigation must not expose individual-file close controls`,
		).toBeNull();
		expect(document.activeElement, `${REGRESSION}: opening overflow must move keyboard focus into the menu`).toBe(items[0]);

		let change: CustomEvent | undefined;
		pane.addEventListener("review-file-change", (event) => { change = event as CustomEvent; });
		items[1]!.click();
		await settle(pane);
		expect(change?.detail, `${REGRESSION}: overflow navigation must activate the selected stable file identity`).toEqual({
			reviewId: review.reviewId,
			fileId: review.files[6]!.fileId,
		});
		expect(trigger!.getAttribute("aria-expanded"), `${REGRESSION}: selecting a file must close overflow`).toBe("false");
		expect(controlledMenu(trigger!), `${REGRESSION}: selected overflow menu must no longer be visible`).toBeNull();
	});

	it("dismisses overflow on outside click and Escape, restoring trigger focus", async () => {
		const pane = await mountReview(group("overflow-dismiss", 7));
		const trigger = overflowTrigger(pane);
		expect(trigger, `${REGRESSION}: overflow dismissal requires a More tabs control`).not.toBeNull();

		trigger!.click();
		await settle(pane);
		document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await settle(pane);
		expect(trigger!.getAttribute("aria-expanded"), `${REGRESSION}: outside click must dismiss overflow`).toBe("false");
		expect(controlledMenu(trigger!), `${REGRESSION}: outside-click-dismissed menu must be absent`).toBeNull();

		trigger!.click();
		await settle(pane);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle(pane);
		expect(trigger!.getAttribute("aria-expanded"), `${REGRESSION}: Escape must dismiss overflow`).toBe("false");
		expect(controlledMenu(trigger!), `${REGRESSION}: Escape-dismissed menu must be absent`).toBeNull();
		expect(document.activeElement, `${REGRESSION}: Escape dismissal must restore focus to More tabs`).toBe(trigger);
	});
});
