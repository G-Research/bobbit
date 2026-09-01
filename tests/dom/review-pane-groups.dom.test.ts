import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addAnnotation,
	clearAllAnnotations,
	clearReviewTombstone,
	getDocumentAnnotationCount,
} from "../../src/ui/components/review/AnnotationStore.js";
import {
	clearPersistedReviewDocuments,
	hydrateVisibleReviewGroups,
	persistReviewGroup,
	readPersistedReviewGroups,
} from "../../src/app/review-sources.js";
import * as reviewSourcesModule from "../../src/app/review-sources.js";
import * as reviewSourcesLazy from "../../src/app/review-sources-lazy.js";
import { applySidePanelWorkspaceFromServer } from "../../src/app/side-panel-workspace.js";
import { doRenderApp } from "../../src/app/render.js";
import { setRenderApp, state } from "../../src/app/state.js";
import {
	discardReviewFinalComment,
	reviewFinalComment,
} from "../../src/ui/components/review/ReviewPane.js";

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
const finalDraftsToClear = new Set<string>();

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

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

async function waitFor(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw lastError;
}

function setViewportWidth(width: number): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	window.dispatchEvent(new Event("resize"));
}

function mountedPaneForReview(reviewId: string): DesiredReviewPane | undefined {
	return Array.from(document.querySelectorAll("review-pane"))
		.map((pane) => pane as unknown as DesiredReviewPane)
		.find((pane) => pane.review?.reviewId === reviewId);
}

function reviewWorkspaceTab(review: DesiredReviewGroup) {
	return {
		id: `review:${encodeURIComponent(review.reviewId)}`,
		kind: "review" as const,
		title: `Review: ${review.title}`,
		label: `Review: ${review.title}`,
		source: {
			type: "review" as const,
			sessionId: review.source.sessionId,
			reviewId: review.reviewId,
			documentId: review.reviewId,
			title: review.title,
		},
		updatedAt: 1,
	};
}

async function mountAppReviewForDecision(
	review: DesiredReviewGroup,
	submitReviewGroupDecision: ReturnType<typeof vi.fn>,
): Promise<DesiredReviewPane> {
	const sessionId = review.source.sessionId;
	sessionsToClear.add(sessionId);
	finalDraftsToClear.add(`${sessionId}\u0000${review.reviewId}`);
	(window as any).happyDOM?.setURL?.(`http://localhost/#/session/${sessionId}`);
	document.body.innerHTML = '<div id="app"></div>';
	state.appView = "authenticated";
	state.connectionStatus = "connected";
	state.gatewaySessions = [{
		id: sessionId,
		title: "Review decision fixture",
		cwd: "/fixture",
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 1,
	} as any];
	state.projects = [];
	state.goals = [];
	state.selectedSessionId = null;
	state.remoteAgent = { gatewaySessionId: sessionId, state: {}, prompt: vi.fn() } as any;
	state.chatPanel = document.createElement("div") as any;
	state.reviewGroupsBySession = {};
	persistReviewGroup(sessionId, review as any);
	state.selectedSessionId = sessionId;
	hydrateVisibleReviewGroups(sessionId, [review] as any, review.reviewId);
	applySidePanelWorkspaceFromServer({
		version: 1,
		sessionId,
		revision: 1,
		tabs: [reviewWorkspaceTab(review)],
		activeTabId: `review:${encodeURIComponent(review.reviewId)}`,
		sizeMode: "split",
		updatedAt: 1,
	}, { source: "hydrate", skipRender: true, force: true });
	vi.spyOn(reviewSourcesLazy, "loadReviewSources").mockResolvedValue({
		...reviewSourcesModule,
		submitReviewGroupDecision,
	} as typeof reviewSourcesModule);
	setViewportWidth(360);
	setRenderApp(doRenderApp);
	doRenderApp();
	const pane = mountedPaneForReview(review.reviewId);
	expect(pane, `${REGRESSION}: the decision fixture must render its review pane`).toBeDefined();
	await pane!.updateComplete;
	return pane!;
}

async function enterFinalDraft(pane: DesiredReviewPane, value: string): Promise<void> {
	const textarea = pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")!;
	textarea.value = value;
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	await settle(pane);
}

async function flushDecisionHandler(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})));
	vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(async () => {
	setRenderApp(() => {});
	setViewportWidth(1024);
	document.body.innerHTML = "";
	await Promise.all(Array.from(sessionsToClear, (sessionId) => clearAllAnnotations(sessionId)));
	sessionsToClear.clear();
	for (const key of finalDraftsToClear) {
		const separator = key.indexOf("\u0000");
		discardReviewFinalComment(key.slice(0, separator), key.slice(separator + 1));
	}
	finalDraftsToClear.clear();
	state.reviewGroupsBySession = {};
	state.reviewGroups = new Map();
	state.reviewActiveReviewId = "";
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	state.panelTabsBySession = {};
	state.panelTabs = [];
	state.sidePanelWorkspaceBySession = {};
	state.panelWorkspaceActiveBySession = {};
	state.activePanelTabId = "chat";
	state.selectedSessionId = null;
	state.remoteAgent = null;
	state.chatPanel = null;
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

	it("keeps a confirmed dismiss draft until authoritative cleanup succeeds", async () => {
		const review = group("dismiss-draft", 1);
		finalDraftsToClear.add(`${review.source.sessionId}\u0000${review.reviewId}`);
		const pane = await mountReview(review);
		const textarea = pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")!;
		textarea.value = "retry after close failure";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		vi.spyOn(window, "confirm").mockReturnValue(true);

		pane.querySelector<HTMLButtonElement>(".review-dismiss-btn")!.click();
		await settle(pane);

		expect(reviewFinalComment(review.source.sessionId, review.reviewId)).toBe("retry after close failure");
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

	it("keeps a newer same-ID shared final draft when a stale decision completes as a no-op", async () => {
		const review = group("draft-stale-completion", 1, "session-draft-stale-completion");
		const submission = deferred<reviewSourcesModule.ReviewDecisionSubmissionOutcome>();
		const submit = vi.fn((..._args: Parameters<typeof reviewSourcesModule.submitReviewGroupDecision>) => submission.promise);
		const pane = await mountAppReviewForDecision(review, submit);
		await enterFinalDraft(pane, "captured draft");

		pane.querySelector<HTMLButtonElement>(".review-approve-btn")!.click();
		await flushDecisionHandler();
		expect(submit).toHaveBeenCalledOnce();
		expect(submit.mock.calls[0][1]).toMatchObject({ finalComment: "captured draft" });

		const replacement = {
			...review,
			files: review.files.map((file) => ({ ...file, markdown: "replacement content" })),
		};
		state.reviewGroupsBySession[review.source.sessionId] = [replacement as any];
		state.reviewGroups.set(review.reviewId, replacement as any);
		await enterFinalDraft(pane, "new replacement draft");
		submission.resolve({
			submitted: false,
			sessionId: review.source.sessionId,
			reviewId: review.reviewId,
			finalComment: "captured draft",
		});
		await flushDecisionHandler();

		expect(reviewFinalComment(review.source.sessionId, review.reviewId)).toBe("new replacement draft");
		expect(state.reviewGroups.get(review.reviewId)).toBe(replacement);
	});

	it("discards the captured final draft only after exact successful completion", async () => {
		const review = group("draft-exact-success", 1, "session-draft-exact-success");
		const submission = deferred<reviewSourcesModule.ReviewDecisionSubmissionOutcome>();
		const submit = vi.fn((..._args: Parameters<typeof reviewSourcesModule.submitReviewGroupDecision>) => submission.promise);
		const pane = await mountAppReviewForDecision(review, submit);
		await enterFinalDraft(pane, "submitted exact draft");

		pane.querySelector<HTMLButtonElement>(".review-approve-btn")!.click();
		await flushDecisionHandler();
		expect(submit).toHaveBeenCalledOnce();
		state.reviewGroupsBySession[review.source.sessionId] = [];
		state.reviewGroups.delete(review.reviewId);
		submission.resolve({
			submitted: true,
			sessionId: review.source.sessionId,
			reviewId: review.reviewId,
			finalComment: "submitted exact draft",
		});
		await flushDecisionHandler();

		expect(reviewFinalComment(review.source.sessionId, review.reviewId)).toBe("");
	});

	it("retains the captured final draft when decision submission fails", async () => {
		const review = group("draft-failed", 1, "session-draft-failed");
		const submission = deferred<reviewSourcesModule.ReviewDecisionSubmissionOutcome>();
		const submit = vi.fn((..._args: Parameters<typeof reviewSourcesModule.submitReviewGroupDecision>) => submission.promise);
		const pane = await mountAppReviewForDecision(review, submit);
		await enterFinalDraft(pane, "retry this draft");

		pane.querySelector<HTMLButtonElement>(".review-approve-btn")!.click();
		await flushDecisionHandler();
		expect(submit).toHaveBeenCalledOnce();
		submission.reject(new Error("submission failed"));
		await flushDecisionHandler();

		expect(reviewFinalComment(review.source.sessionId, review.reviewId)).toBe("retry this draft");
	});

	it.each([2, 3, 4, 5])("uses measured constrained width to overflow %i long file titles", async (fileCount) => {
		const review = group(`measured-${fileCount}`, fileCount);
		review.files.forEach((file, index) => {
			file.title = `Long descriptive file title ${index + 1}.markdown`;
		});
		const pane = await mountReview(review);
		const bar = secondaryBar(pane)!;
		bar.getBoundingClientRect = () => ({
			x: 0,
			y: 0,
			width: 310,
			height: 36,
			top: 0,
			right: 310,
			bottom: 36,
			left: 0,
			toJSON: () => ({}),
		});
		pane.review = { ...review };
		await settle(pane);
		await Promise.resolve();
		await settle(pane);

		const trigger = overflowTrigger(pane);
		expect(trigger, `${REGRESSION}: ${fileCount} long files must use measured width rather than the five-file fallback`).not.toBeNull();
		expect(buttonsByText(bar, review.files[0]!.title)).toHaveLength(1);
		expect(buttonsByText(bar, review.files[fileCount - 1]!.title)).toHaveLength(0);

		let change: CustomEvent | undefined;
		pane.addEventListener("review-file-change", (event) => { change = event as CustomEvent; });
		trigger!.click();
		await settle(pane);
		const hiddenItem = controlledMenu(trigger!)?.querySelector<HTMLButtonElement>(
			`[role="menuitem"][data-file-id="${review.files[fileCount - 1]!.fileId}"]`,
		) ?? Array.from(controlledMenu(trigger!)?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])
			.find((item) => item.textContent?.trim() === review.files[fileCount - 1]!.title);
		expect(hiddenItem, `${REGRESSION}: a measured-overflow file must remain selectable`).toBeDefined();
		hiddenItem!.click();
		await settle(pane);
		expect(change?.detail).toEqual({
			reviewId: review.reviewId,
			fileId: review.files[fileCount - 1]!.fileId,
		});
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

	it("keeps eager mobile review panes pure and closes an inactive review with its exact draft", async () => {
		const sessionId = "session-primary-close";
		const reviewA = group("primary-close-a", 2, sessionId);
		const reviewB = group("primary-close-b", 2, sessionId);
		sessionsToClear.add(sessionId);
		(window as any).happyDOM?.setURL?.(`http://localhost/#/session/${sessionId}`);
		document.body.innerHTML = '<div id="app"></div>';

		state.appView = "authenticated";
		state.connectionStatus = "connected";
		state.gatewaySessions = [{
			id: sessionId,
			title: "Review close fixture",
			cwd: "/fixture",
			status: "idle",
			createdAt: 1,
			lastActivity: 1,
			clientCount: 1,
		} as any];
		state.projects = [];
		state.goals = [];
		state.selectedSessionId = null;
		state.remoteAgent = { gatewaySessionId: sessionId, state: {}, prompt: vi.fn() } as any;
		state.chatPanel = document.createElement("div") as any;
		state.reviewGroupsBySession = {};
		persistReviewGroup(sessionId, reviewA as any);
		persistReviewGroup(sessionId, reviewB as any);
		state.selectedSessionId = sessionId;
		hydrateVisibleReviewGroups(sessionId, [reviewA, reviewB] as any, reviewB.reviewId);
		applySidePanelWorkspaceFromServer({
			version: 1,
			sessionId,
			revision: 1,
			tabs: [reviewWorkspaceTab(reviewA), reviewWorkspaceTab(reviewB)],
			activeTabId: `review:${encodeURIComponent(reviewB.reviewId)}`,
			sizeMode: "split",
			updatedAt: 1,
		}, { source: "hydrate", skipRender: true, force: true });

		const authoritativeTabs = new Set([
			`review:${encodeURIComponent(reviewA.reviewId)}`,
			`review:${encodeURIComponent(reviewB.reviewId)}`,
		]);
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
			const match = url.pathname.match(/\/side-panel-workspace\/tabs\/([^/]+)$/);
			if (method === "DELETE" && match) {
				authoritativeTabs.delete(decodeURIComponent(match[1]!));
				return new Response(null, { status: 204 });
			}
			if (method === "GET" && url.pathname.endsWith("/side-panel-workspace")) {
				return Response.json({
					version: 1,
					sessionId,
					revision: 2,
					tabs: [reviewWorkspaceTab(reviewA), reviewWorkspaceTab(reviewB)].filter((tab) => authoritativeTabs.has(tab.id)),
					activeTabId: `review:${encodeURIComponent(reviewA.reviewId)}`,
					sizeMode: "split",
					updatedAt: 2,
				});
			}
			return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({});
		}));
		const confirmMock = vi.fn()
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		vi.stubGlobal("confirm", confirmMock);
		await addAnnotation(sessionId, reviewB.files[1]!.fileId, {
			id: "inactive-b-comment",
			quote: "Body 2",
			comment: "Keep B note",
		});

		setViewportWidth(360);
		setRenderApp(doRenderApp);
		doRenderApp();
		await waitFor(() => {
			expect(document.querySelectorAll('[data-panel-tab-kind="review"]')).toHaveLength(2);
			expect(document.querySelectorAll("review-pane")).toHaveLength(2);
		});
		expect(state.reviewActiveReviewId, `${REGRESSION}: eager mobile pane rendering must not change primary selection`).toBe(reviewB.reviewId);
		let pane = mountedPaneForReview(reviewB.reviewId)!;
		expect(pane, `${REGRESSION}: each mobile slider panel must render its own review`).toBeDefined();
		await pane.updateComplete;
		const draft = pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")!;
		draft.value = "Keep B final draft";
		draft.dispatchEvent(new Event("input", { bubbles: true }));
		await settle(pane);

		const tab = (reviewId: string) => document.querySelector<HTMLElement>(
			`[data-panel-tab-id="review:${encodeURIComponent(reviewId)}"]`,
		)!;
		tab(reviewA.reviewId).querySelector<HTMLButtonElement>(".goal-tab-select")!.click();
		await waitFor(() => expect(state.reviewActiveReviewId).toBe(reviewA.reviewId));
		tab(reviewB.reviewId).querySelector<HTMLButtonElement>("[data-testid='side-panel-close']")!.click();

		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(confirmMock.mock.calls[0]![0]).toContain('Close "Review primary-close-b"? 2 unsent comments');
		expect(state.reviewActiveReviewId).toBe(reviewA.reviewId);
		expect(state.reviewGroups.has(reviewA.reviewId)).toBe(true);
		expect(state.reviewGroups.has(reviewB.reviewId)).toBe(true);
		expect(readPersistedReviewGroups(sessionId).find((review) => review.reviewId === reviewB.reviewId)?.files).toHaveLength(2);
		expect(getDocumentAnnotationCount(sessionId, reviewB.files[1]!.fileId)).toBe(1);

		tab(reviewB.reviewId).querySelector<HTMLButtonElement>(".goal-tab-select")!.click();
		await waitFor(() => expect(state.reviewActiveReviewId).toBe(reviewB.reviewId));
		pane = mountedPaneForReview(reviewB.reviewId)!;
		await pane.updateComplete;
		expect(pane.querySelector<HTMLTextAreaElement>(".review-final-comment-input")?.value).toBe("Keep B final draft");
		tab(reviewA.reviewId).querySelector<HTMLButtonElement>(".goal-tab-select")!.click();
		await waitFor(() => expect(state.reviewActiveReviewId).toBe(reviewA.reviewId));

		tab(reviewB.reviewId).querySelector<HTMLButtonElement>("[data-testid='side-panel-close']")!.click();
		await waitFor(() => {
			expect(state.reviewGroups.has(reviewB.reviewId)).toBe(false);
			expect(document.querySelector(`[data-panel-tab-id="review:${encodeURIComponent(reviewB.reviewId)}"]`)).toBeNull();
		});
		expect(confirmMock).toHaveBeenCalledTimes(2);
		expect(state.reviewGroups.has(reviewA.reviewId)).toBe(true);
		expect(state.reviewActiveReviewId).toBe(reviewA.reviewId);
		expect(getDocumentAnnotationCount(sessionId, reviewB.files[1]!.fileId)).toBe(0);
		expect(readPersistedReviewGroups(sessionId).map((review) => review.reviewId)).toEqual([reviewA.reviewId]);

		expect(reviewFinalComment(sessionId, reviewB.reviewId), `${REGRESSION}: confirmed close must discard only B's final draft`).toBe("");
		expect(state.reviewGroups.has(reviewA.reviewId)).toBe(true);

		setRenderApp(() => {});
		clearPersistedReviewDocuments(sessionId);
		await clearReviewTombstone(sessionId, reviewB.reviewId);
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
