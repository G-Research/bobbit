import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupReviewGroup,
	normalizeReviewDecisionPayload,
	openMarkdownReviewDocument,
	openMarkdownReviewGroup,
	openReviewDocument,
	persistReviewGroup,
	readPersistedReviewGroups,
	restorePersistedReviewDocuments,
	submitReviewGroupDecision,
	upsertReviewGroup,
} from "../../src/app/review-sources.js";
import { GATE_STATUS_CLIENT_EVENT, HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE } from "../../src/app/gate-status-events.js";
import { setRenderApp, state, type ReviewGroupModel } from "../../src/app/state.js";
import type { SidePanelWorkspace, SidePanelWorkspaceTab } from "../../src/app/side-panel-workspace.js";
import {
	addAnnotation,
	clearAnnotations,
	clearReviewTombstone,
	getAnnotations,
	getAnnotationsForDocument,
	getReviewTombstone,
	initAnnotationStore,
	isReviewSubmitted,
	setReviewTombstone,
} from "../../src/ui/components/review/AnnotationStore.js";

const SESSION_ID = "review-group-model-session";
const CLEANUP_SESSION_ID = "review-group-cleanup-session";
const FOREGROUND_SESSION_ID = "review-group-foreground-session";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

function review(
	reviewId: string,
	title: string,
	files: Array<{ fileId: string; title: string; markdown?: string }>,
	activeFileId = files[0]?.fileId || "",
): ReviewGroupModel {
	return {
		reviewId,
		title,
		files: files.map((file) => ({ ...file, markdown: file.markdown ?? file.fileId })),
		activeFileId,
		source: { kind: "markdown-review", sessionId: SESSION_ID },
	};
}

function installWorkspacePersistenceFixture(): ReturnType<typeof vi.fn> {
	let workspace: SidePanelWorkspace = {
		version: 1,
		sessionId: SESSION_ID,
		revision: 0,
		tabs: [],
		activeTabId: "",
		sizeMode: "split",
		updatedAt: 1,
	};
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = typeof init?.body === "string"
			? JSON.parse(init.body) as { tab?: SidePanelWorkspaceTab; focus?: boolean }
			: {};
		if (body.tab) {
			const tabs = workspace.tabs.slice();
			const index = tabs.findIndex((tab) => tab.id === body.tab!.id);
			if (index >= 0) tabs[index] = body.tab;
			else tabs.push(body.tab);
			workspace = {
				...workspace,
				revision: workspace.revision + 1,
				tabs,
				activeTabId: body.focus === false ? workspace.activeTabId : body.tab.id,
				updatedAt: workspace.updatedAt + 1,
			};
		}
		return new Response(JSON.stringify({ workspace }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function reviewTab(group: ReviewGroupModel): SidePanelWorkspaceTab {
	return {
		id: `review:${group.reviewId}`,
		kind: "review",
		title: `Review: ${group.title}`,
		label: `Review: ${group.title}`,
		source: {
			type: "review",
			sessionId: CLEANUP_SESSION_ID,
			reviewId: group.reviewId,
			documentId: group.reviewId,
			title: group.title,
		},
		updatedAt: 1,
	};
}

function installWorkspaceCleanupFixture(
	initial: SidePanelWorkspace,
	outcomes: Array<"conflict" | "success">,
): { deleteAttempts: Array<{ tabId: string; ifMatch: string | null }>; events: string[]; workspace: () => SidePanelWorkspace } {
	let workspace = initial;
	const deleteAttempts: Array<{ tabId: string; ifMatch: string | null }> = [];
	const events: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
		const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
		const match = url.pathname.match(/\/side-panel-workspace\/tabs\/([^/]+)$/);
		if (method === "DELETE" && match) {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
			const tabId = decodeURIComponent(match[1]);
			deleteAttempts.push({ tabId, ifMatch: headers.get("if-match") });
			const outcome = outcomes.shift() || "success";
			events.push(`workspace:${outcome}:${tabId}`);
			if (outcome === "conflict") {
				workspace = { ...workspace, revision: workspace.revision + 1, updatedAt: workspace.updatedAt + 1 };
				return Response.json({
					error: "Stale side-panel workspace revision",
					code: "STALE_REVISION",
					workspace,
				}, { status: 409 });
			}
			const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
			workspace = {
				...workspace,
				revision: workspace.revision + 1,
				tabs,
				activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId) ? workspace.activeTabId : tabs[0]?.id || "",
				updatedAt: workspace.updatedAt + 1,
			};
			return Response.json({ workspace });
		}
		if (url.pathname.includes("/review/")) {
			events.push(`review:${method}`);
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	}));
	return { deleteAttempts, events, workspace: () => workspace };
}

function installHeldPostDeleteLifecycleFixture(initial: SidePanelWorkspace, heldTabId: string) {
	let workspace = initial;
	const deleteCommitted = deferred();
	const releaseDeleteResponse = deferred();
	const requests: Array<{ method: string; pathname: string; tabId?: string }> = [];
	let held = true;
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
		const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
		const tabMatch = url.pathname.match(/\/side-panel-workspace\/tabs\/([^/]+)$/);
		const tabId = tabMatch ? decodeURIComponent(tabMatch[1]) : undefined;
		requests.push({ method, pathname: url.pathname, tabId });
		if (url.pathname.includes("/review/") && !url.pathname.includes("/side-panel-workspace")) {
			return new Response(null, { status: 204 });
		}
		if (method === "DELETE" && tabId) {
			const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
			workspace = {
				...workspace,
				revision: workspace.revision + 1,
				tabs,
				activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId) ? workspace.activeTabId : tabs[0]?.id || "",
				updatedAt: workspace.updatedAt + 1,
			};
			if (tabId === heldTabId && held) {
				held = false;
				deleteCommitted.resolve();
				await releaseDeleteResponse.promise;
			}
			return Response.json({ workspace });
		}
		if (method === "POST" && url.pathname.endsWith("/side-panel-workspace/open")) {
			const body = JSON.parse(String(init?.body || "{}")) as { tab?: SidePanelWorkspaceTab; focus?: boolean };
			if (body.tab) {
				const tabs = workspace.tabs.filter((tab) => tab.id !== body.tab!.id);
				tabs.push(body.tab);
				workspace = {
					...workspace,
					revision: workspace.revision + 1,
					tabs,
					activeTabId: body.focus === false ? workspace.activeTabId : body.tab.id,
					updatedAt: workspace.updatedAt + 1,
				};
			}
			return Response.json({ workspace });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	}));
	return {
		deleteCommitted: deleteCommitted.promise,
		releaseDeleteResponse: () => releaseDeleteResponse.resolve(),
		requests,
		workspace: () => workspace,
	};
}

function installHeldLifecycleFixture(
	initial: SidePanelWorkspace,
	heldTabId: string,
	deleteOutcomes: Array<"success" | "conflict"> = ["success"],
) {
	let workspace = initial;
	const deleteStarted = deferred();
	const releaseDelete = deferred();
	const openStarted = deferred();
	const requests: Array<{ method: string; pathname: string; tabId?: string }> = [];
	let held = true;
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
		const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
		const tabMatch = url.pathname.match(/\/side-panel-workspace\/tabs\/([^/]+)$/);
		const tabId = tabMatch ? decodeURIComponent(tabMatch[1]) : undefined;
		requests.push({ method, pathname: url.pathname, tabId });
		if (url.pathname.includes("/review/") && !url.pathname.includes("/side-panel-workspace")) {
			return new Response(null, { status: 204 });
		}
		if (method === "DELETE" && tabId) {
			if (tabId === heldTabId && held) {
				held = false;
				deleteStarted.resolve();
				await releaseDelete.promise;
			}
			const outcome = deleteOutcomes.shift() || "success";
			if (outcome === "conflict") {
				workspace = { ...workspace, revision: workspace.revision + 1, updatedAt: workspace.updatedAt + 1 };
				return Response.json({ error: "Stale side-panel workspace revision", code: "STALE_REVISION", workspace }, { status: 409 });
			}
			const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
			workspace = {
				...workspace,
				revision: workspace.revision + 1,
				tabs,
				activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId) ? workspace.activeTabId : tabs[0]?.id || "",
				updatedAt: workspace.updatedAt + 1,
			};
			return Response.json({ workspace });
		}
		if (method === "POST" && url.pathname.endsWith("/side-panel-workspace/open")) {
			openStarted.resolve();
			const body = JSON.parse(String(init?.body || "{}")) as { tab?: SidePanelWorkspaceTab; focus?: boolean };
			if (body.tab) {
				const tabs = workspace.tabs.filter((tab) => tab.id !== body.tab!.id);
				tabs.push(body.tab);
				workspace = {
					...workspace,
					revision: workspace.revision + 1,
					tabs,
					activeTabId: body.focus === false ? workspace.activeTabId : body.tab.id,
					updatedAt: workspace.updatedAt + 1,
				};
			}
			return Response.json({ workspace });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	}));
	return {
		deleteStarted: deleteStarted.promise,
		releaseDelete: () => releaseDelete.resolve(),
		openStarted: openStarted.promise,
		requests,
		workspace: () => workspace,
	};
}

beforeEach(() => {
	setRenderApp(() => {});
	state.selectedSessionId = null;
	state.remoteAgent = null;
	state.chatPanel = null;
	state.reviewGroupsBySession = {};
	state.reviewGroups = new Map();
	state.reviewActiveReviewId = "";
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	state.sidePanelWorkspaceBySession = {};
	state.lastWorkspaceRevisionBySession = {};
	state.panelTabsBySession = {};
	state.panelTabs = [];
	state.panelWorkspaceActiveBySession = {};
	state.activePanelTabId = "chat";
	state.goals = [];
	localStorage.clear();
});

afterEach(async () => {
	setRenderApp(() => {});
	if (getReviewTombstone(CLEANUP_SESSION_ID, "cleanup-target")) {
		await clearReviewTombstone(CLEANUP_SESSION_ID, "cleanup-target");
	}
	if (vi.isMockFunction(globalThis.fetch)) {
		await Promise.all([
			clearAnnotations(CLEANUP_SESSION_ID, "target-file"),
			clearAnnotations(CLEANUP_SESSION_ID, "target.md"),
			clearAnnotations(CLEANUP_SESSION_ID, "cleanup-target"),
		]);
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("review group replacement identity", () => {
	it("replaces the first duplicate-title group in place without changing review order or identity", () => {
		const first = review("review-first", "Duplicate", [{ fileId: "first-file", title: "first.md" }]);
		const second = review("review-second", "Duplicate", [{ fileId: "second-file", title: "second.md" }]);
		const third = review("review-third", "Other", [{ fileId: "third-file", title: "third.md" }]);
		const incoming = review("incoming-review", "Duplicate", [{ fileId: "incoming-file", title: "replacement.md" }]);

		const result = upsertReviewGroup([first, second, third], incoming);

		expect(result.map((group) => group.reviewId)).toEqual(["review-first", "review-second", "review-third"]);
		expect(result[0]).toMatchObject({
			reviewId: "review-first",
			title: "Duplicate",
			files: [{ fileId: "incoming-file", title: "replacement.md" }],
		});
		expect(result[1]).toBe(second);
		expect(result[2]).toBe(third);
	});

	it("reconciles file IDs by title occurrence across reorder and removes identities that no longer match", () => {
		const existing = review("canonical-review", "Files", [
			{ fileId: "same-first-old", title: "same.md" },
			{ fileId: "solo-old", title: "solo.md" },
			{ fileId: "same-second-old", title: "same.md" },
			{ fileId: "removed-old", title: "removed.md" },
		], "removed-old");
		const incoming = review("incoming-review", "Files", [
			{ fileId: "same-first-incoming", title: "same.md", markdown: "new first" },
			{ fileId: "same-second-incoming", title: "same.md", markdown: "new second" },
			{ fileId: "solo-incoming", title: "solo.md", markdown: "new solo" },
			{ fileId: "new-incoming", title: "new.md", markdown: "brand new" },
		], "same-second-incoming");

		const [replaced] = upsertReviewGroup([existing], incoming);

		expect(replaced.reviewId).toBe("canonical-review");
		expect(replaced.files.map(({ title, fileId, markdown }) => ({ title, fileId, markdown }))).toEqual([
			{ title: "same.md", fileId: "same-first-old", markdown: "new first" },
			{ title: "same.md", fileId: "same-second-old", markdown: "new second" },
			{ title: "solo.md", fileId: "solo-old", markdown: "new solo" },
			{ title: "new.md", fileId: "new-incoming", markdown: "brand new" },
		]);
		expect(replaced.files.some((file) => file.fileId === "removed-old")).toBe(false);
		expect(replaced.activeFileId).toBe("same-second-old");
	});

	it("appends distinct replace:false reviews with the same title but treats an exact reviewId replay as idempotent", () => {
		const original = review("review-one", "Duplicate", [{ fileId: "one-file", title: "same.md" }]);
		const distinct = review("review-two", "Duplicate", [{ fileId: "two-file", title: "same.md" }]);
		const replay = review("review-two", "Duplicate", [{ fileId: "replay-file", title: "same.md", markdown: "replayed" }]);

		const appended = upsertReviewGroup([original], distinct, false);
		const replayed = upsertReviewGroup(appended, replay, false);

		expect(appended.map((group) => group.reviewId)).toEqual(["review-one", "review-two"]);
		expect(replayed.map((group) => group.reviewId)).toEqual(["review-one", "review-two"]);
		expect(replayed[1].files).toEqual([{ fileId: "two-file", title: "same.md", markdown: "replayed" }]);
	});

	it("keeps the legacy one-file open API compatible", () => {
		installWorkspacePersistenceFixture();

		const document = openMarkdownReviewDocument({
			sessionId: SESSION_ID,
			documentId: "legacy-document",
			title: "Legacy notes",
			markdown: "# Legacy",
		});
		const [stored] = state.reviewGroupsBySession[SESSION_ID];

		expect(document).toMatchObject({
			documentId: "legacy-document",
			fileId: "legacy-document",
			reviewId: "legacy-document",
			title: "Legacy notes",
			markdown: "# Legacy",
		});
		expect(stored).toMatchObject({
			reviewId: "legacy-document",
			title: "Legacy notes",
			activeFileId: "legacy-document",
			files: [{ fileId: "legacy-document", title: "Legacy notes", markdown: "# Legacy" }],
		});
	});

	it("opens exactly one primary workspace tab under the surviving canonical review ID", async () => {
		const fetchMock = installWorkspacePersistenceFixture();
		openMarkdownReviewGroup({
			sessionId: SESSION_ID,
			reviewId: "canonical-review",
			title: "Shared title",
			files: [{ fileId: "old-file", title: "notes.md", markdown: "old" }],
		});

		const replaced = openMarkdownReviewGroup({
			sessionId: SESSION_ID,
			reviewId: "discarded-incoming-review-id",
			title: "Shared title",
			files: [{ fileId: "new-file", title: "notes.md", markdown: "new" }],
		});

		expect(replaced.reviewId).toBe("canonical-review");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await vi.waitFor(() => {
			const reviewTabs = state.sidePanelWorkspaceBySession[SESSION_ID]?.tabs
				.filter((tab) => tab.kind === "review") || [];
			expect(reviewTabs).toHaveLength(1);
			expect(reviewTabs[0].id).toBe("review:canonical-review");
			expect(reviewTabs[0].source).toMatchObject({
				type: "review",
				sessionId: SESSION_ID,
				reviewId: "canonical-review",
			});
		});
		expect(state.reviewGroupsBySession[SESSION_ID].map((group) => group.reviewId)).toEqual(["canonical-review"]);
	});
});

describe("review group decision identity migration", () => {
	function decisionGroup(sessionId: string, files: Array<{ fileId: string; title: string }>): ReviewGroupModel {
		return {
			...review(`review-${sessionId}`, "Migration review", files),
			source: { kind: "markdown-review", sessionId },
		};
	}

	function installReviewPersistenceNoop(): void {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
	}

	it("does not duplicate or assign an ambiguous legacy title bucket, including in submitted feedback", async () => {
		const sessionId = "decision-duplicate-legacy";
		const group = decisionGroup(sessionId, [
			{ fileId: "same-first", title: "same.md" },
			{ fileId: "same-second", title: "same.md" },
		]);
		installReviewPersistenceNoop();
		await addAnnotation(sessionId, "same.md", { id: "hidden-legacy", quote: "hidden", comment: "must not submit" });

		const input = { decision: "approve" as const, finalComment: "Looks good", inlineComments: [], feedback: "" };
		const normalized = normalizeReviewDecisionPayload(input, sessionId, group);
		expect(normalized.inlineComments).toEqual([]);

		const prompt = vi.fn();
		await submitReviewGroupDecision(group, input, { sessionId, prompt });
		expect(prompt).toHaveBeenCalledOnce();
		expect(prompt.mock.calls[0][0]).toBe("## Review Approved\n\n## Final comment\n\nLooks good");
	});

	it("migrates a unique legacy title bucket exactly once to its stable file ID", async () => {
		const sessionId = "decision-unique-legacy";
		const group = decisionGroup(sessionId, [
			{ fileId: "unique-file", title: "unique.md" },
			{ fileId: "other-file", title: "other.md" },
		]);
		installReviewPersistenceNoop();
		await addAnnotation(sessionId, "unique.md", { id: "legacy-unique", quote: "unique quote", comment: "unique note" });

		const input = { decision: "approve" as const, finalComment: "", inlineComments: [], feedback: "" };
		const normalized = normalizeReviewDecisionPayload(input, sessionId, group);
		expect(normalized.inlineComments).toEqual([expect.objectContaining({
			fileId: "unique-file",
			documentTitle: "unique.md",
			comment: "unique note",
		})]);

		const prompt = vi.fn();
		await submitReviewGroupDecision(group, input, { sessionId, prompt });
		const feedback = String(prompt.mock.calls[0][0]);
		expect(feedback.match(/unique note/g)).toHaveLength(1);
		expect(feedback).toContain('### "unique.md"');
	});

	it("drops an ambiguous title-only payload instead of binding it to the first duplicate", () => {
		const sessionId = "decision-ambiguous-title";
		const group = decisionGroup(sessionId, [
			{ fileId: "same-first", title: "same.md" },
			{ fileId: "same-second", title: "same.md" },
		]);
		const normalized = normalizeReviewDecisionPayload({
			decision: "approve",
			finalComment: "",
			feedback: "",
			inlineComments: [{ documentTitle: "same.md", quote: "ambiguous", comment: "wrong first match" }],
		}, sessionId, group);

		expect(normalized.inlineComments).toEqual([]);
	});

	it("keeps exact file-ID comments deterministic in review file order despite duplicate titles", async () => {
		const sessionId = "decision-exact-order";
		const group = decisionGroup(sessionId, [
			{ fileId: "same-first", title: "same.md" },
			{ fileId: "same-second", title: "same.md" },
		]);
		const normalized = normalizeReviewDecisionPayload({
			decision: "approve",
			finalComment: "",
			feedback: "",
			inlineComments: [
				{ fileId: "same-second", documentTitle: "same.md", quote: "second", comment: "second note" },
				{ fileId: "same-first", documentTitle: "same.md", quote: "first", comment: "first note" },
			],
		}, sessionId, group);

		expect(normalized.inlineComments.map((comment) => [comment.fileId, comment.comment])).toEqual([
			["same-first", "first note"],
			["same-second", "second note"],
		]);

		installReviewPersistenceNoop();
		const prompt = vi.fn();
		await submitReviewGroupDecision(group, normalized, { sessionId, prompt });
		const feedback = String(prompt.mock.calls[0][0]);
		expect(feedback.indexOf("first note")).toBeLessThan(feedback.indexOf("second note"));
	});
});

describe("review group decision lifecycle", () => {
	function lifecycleGroup(sessionId: string, reviewId: string, markdown = "captured"): ReviewGroupModel {
		return {
			...review(reviewId, `Decision ${reviewId}`, [{ fileId: `${reviewId}-file`, title: `${reviewId}.md`, markdown }]),
			source: { kind: "markdown-review", sessionId },
		};
	}

	function lifecycleWorkspace(sessionId: string, groups: ReviewGroupModel[]): SidePanelWorkspace {
		const tabs = groups.map((group) => ({
			...reviewTab(group),
			source: { ...reviewTab(group).source, sessionId },
		}));
		return {
			version: 1,
			sessionId,
			revision: 3,
			tabs,
			activeTabId: tabs[0]?.id || "",
			sizeMode: "split",
			updatedAt: 3,
		};
	}

	function fetchCalls(): Array<{ method: string; pathname: string; body: string }> {
		return vi.mocked(fetch).mock.calls.map(([input, init]) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			return {
				method: (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase(),
				pathname: url.pathname,
				body: typeof init?.body === "string" ? init.body : "",
			};
		});
	}

	it("coalesces simultaneous exact-key decisions into one prompt, tombstone, removal, and cleanup", async () => {
		const sessionId = "decision-coalesced";
		const target = lifecycleGroup(sessionId, "coalesced-review");
		persistReviewGroup(sessionId, target);
		const initial = lifecycleWorkspace(sessionId, [target]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		installHeldLifecycleFixture(initial, "never-held");
		const promptGate = deferred();
		const prompt = vi.fn(() => promptGate.promise);
		const approve = { decision: "approve" as const, finalComment: "accepted", inlineComments: [], feedback: "" };

		const first = submitReviewGroupDecision(target, approve, { sessionId, prompt });
		const second = submitReviewGroupDecision(target, {
			decision: "reject",
			finalComment: "ignored duplicate click",
			inlineComments: [],
			feedback: "",
		}, { sessionId, prompt });

		expect(second).toBe(first);
		expect(prompt).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(prompt).toHaveBeenCalledOnce();
		promptGate.resolve();
		const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

		expect(secondOutcome).toBe(firstOutcome);
		expect(firstOutcome).toEqual({ submitted: true, sessionId, reviewId: target.reviewId, finalComment: "accepted" });
		expect(readPersistedReviewGroups(sessionId)).toEqual([]);
		expect(getReviewTombstone(sessionId, target.reviewId)).toBe("submitted");
		const calls = fetchCalls();
		expect(calls.filter((call) => call.method === "PUT" && call.pathname.includes("/review/tombstones/"))).toHaveLength(1);
		expect(calls.filter((call) => call.method === "DELETE" && call.pathname.endsWith(`/side-panel-workspace/tabs/${encodeURIComponent(reviewTab(target).id)}`))).toHaveLength(1);
		const clearedBuckets = calls
			.filter((call) => call.method === "DELETE" && call.pathname.endsWith("/review/annotations"))
			.map((call) => JSON.parse(call.body).docTitle)
			.sort();
		expect(clearedBuckets).toEqual([target.files[0].fileId, target.files[0].title, target.reviewId].sort());
		await clearReviewTombstone(sessionId, target.reviewId);
	});

	it("coalesces a decision whose terminal workspace conflict preserves its draft source, annotations, and replay eligibility", async () => {
		const sessionId = "decision-terminal-conflict";
		const target = lifecycleGroup(sessionId, "terminal-decision");
		persistReviewGroup(sessionId, target);
		const initial = lifecycleWorkspace(sessionId, [target]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		state.lastWorkspaceRevisionBySession[sessionId] = initial.revision;
		const fixture = installWorkspaceCleanupFixture(initial, ["conflict", "conflict"]);
		await addAnnotation(sessionId, target.files[0].fileId, { id: "decision-file", quote: "file", comment: "keep file" });
		await addAnnotation(sessionId, target.files[0].title, { id: "decision-title", quote: "title", comment: "keep title" });
		await addAnnotation(sessionId, target.reviewId, { id: "decision-review", quote: "review", comment: "keep review" });
		const prompt = vi.fn();
		const payload = { decision: "reject" as const, finalComment: "retain this draft", inlineComments: [], feedback: "" };

		const first = submitReviewGroupDecision(target, payload, { sessionId, prompt });
		const second = submitReviewGroupDecision(target, payload, { sessionId, prompt });
		expect(second).toBe(first);
		await expect(first).rejects.toThrow("Review content was preserved");
		await expect(second).rejects.toThrow("Review content was preserved");

		expect(prompt).toHaveBeenCalledOnce();
		expect(prompt.mock.calls[0][0]).toContain("retain this draft");
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(target).id]);
		expect(readPersistedReviewGroups(sessionId)).toEqual([target]);
		expect(getReviewTombstone(sessionId, target.reviewId)).toBeUndefined();
		expect(getAnnotations(sessionId, target.files[0].fileId)).toHaveLength(1);
		expect(getAnnotations(sessionId, target.files[0].title)).toHaveLength(1);
		expect(getAnnotations(sessionId, target.reviewId)).toHaveLength(1);
	});

	it("runs different exact review keys independently", async () => {
		const sessionId = "decision-independent";
		const firstGroup = lifecycleGroup(sessionId, "independent-first");
		const secondGroup = lifecycleGroup(sessionId, "independent-second");
		persistReviewGroup(sessionId, firstGroup);
		persistReviewGroup(sessionId, secondGroup);
		const initial = lifecycleWorkspace(sessionId, [firstGroup, secondGroup]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		installHeldLifecycleFixture(initial, "never-held");
		const firstGate = deferred();
		const secondGate = deferred();
		const firstPrompt = vi.fn(() => firstGate.promise);
		const secondPrompt = vi.fn(() => secondGate.promise);
		const payload = { decision: "approve" as const, finalComment: "", inlineComments: [], feedback: "" };

		let firstSettled = false;
		const firstDecision = submitReviewGroupDecision(firstGroup, payload, { sessionId, prompt: firstPrompt });
		void firstDecision.then(() => { firstSettled = true; });
		const secondDecision = submitReviewGroupDecision(secondGroup, payload, { sessionId, prompt: secondPrompt });
		await Promise.resolve();

		expect(firstDecision).not.toBe(secondDecision);
		expect(firstPrompt).toHaveBeenCalledOnce();
		expect(secondPrompt).toHaveBeenCalledOnce();
		secondGate.resolve();
		await expect(secondDecision).resolves.toMatchObject({ submitted: true, reviewId: secondGroup.reviewId });
		expect(firstSettled).toBe(false);
		firstGate.resolve();
		await expect(firstDecision).resolves.toMatchObject({ submitted: true, reviewId: firstGroup.reviewId });
		expect(readPersistedReviewGroups(sessionId)).toEqual([]);
		expect(getReviewTombstone(sessionId, firstGroup.reviewId)).toBe("submitted");
		expect(getReviewTombstone(sessionId, secondGroup.reviewId)).toBe("submitted");
		await Promise.all([
			clearReviewTombstone(sessionId, firstGroup.reviewId),
			clearReviewTombstone(sessionId, secondGroup.reviewId),
		]);
	});

	it("cancels a queued decision when synchronous cleanup claims the exact key first", async () => {
		const sessionId = "decision-cleanup-wins";
		const target = lifecycleGroup(sessionId, "cleanup-wins");
		persistReviewGroup(sessionId, target);
		const initial = lifecycleWorkspace(sessionId, [target]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		installHeldLifecycleFixture(initial, "never-held");
		const prompt = vi.fn();

		const decision = submitReviewGroupDecision(target, {
			decision: "approve",
			finalComment: "must not send",
			inlineComments: [],
			feedback: "",
		}, { sessionId, prompt });
		const cleanup = cleanupReviewGroup(sessionId, target.reviewId);
		const [outcome, removed] = await Promise.all([decision, cleanup]);

		expect(outcome).toMatchObject({ submitted: false, reviewId: target.reviewId });
		expect(removed).toMatchObject({ reviewId: target.reviewId });
		expect(prompt).not.toHaveBeenCalled();
		expect(getReviewTombstone(sessionId, target.reviewId)).toBe("closed");
		const tombstoneBodies = fetchCalls()
			.filter((call) => call.method === "PUT" && call.pathname.includes("/review/tombstones/"))
			.map((call) => JSON.parse(call.body));
		expect(tombstoneBodies).toEqual([{ state: "closed", activeFileId: target.activeFileId }]);
		await clearReviewTombstone(sessionId, target.reviewId);
	});

	it("lets an immediate exact live replacement suppress the old decision without touching replacement state", async () => {
		const sessionId = "decision-live-replacement";
		const captured = lifecycleGroup(sessionId, "replacement-review", "old markdown");
		persistReviewGroup(sessionId, captured);
		const initial = lifecycleWorkspace(sessionId, [captured]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		const fixture = installHeldLifecycleFixture(initial, "never-held");
		const prompt = vi.fn();

		const decision = submitReviewGroupDecision(captured, {
			decision: "approve",
			finalComment: "stale decision",
			inlineComments: [],
			feedback: "",
		}, { sessionId, prompt });
		const replacement = openMarkdownReviewGroup({
			sessionId,
			reviewId: captured.reviewId,
			title: captured.title,
			files: [{ fileId: captured.files[0].fileId, title: captured.files[0].title, markdown: "replacement markdown" }],
			live: true,
		});

		await expect(decision).resolves.toMatchObject({ submitted: false, reviewId: captured.reviewId });
		await fixture.openStarted;
		expect(prompt).not.toHaveBeenCalled();
		expect(readPersistedReviewGroups(sessionId)).toEqual([replacement]);
		expect(readPersistedReviewGroups(sessionId)[0].files[0].markdown).toBe("replacement markdown");
		expect(getReviewTombstone(sessionId, captured.reviewId)).toBeUndefined();
		expect(fixture.requests.some((request) => request.method === "DELETE" && request.tabId === reviewTab(captured).id)).toBe(false);
		expect(fetchCalls().filter((call) => call.method === "DELETE" && call.pathname.endsWith("/review/annotations"))).toEqual([]);
	});

	it("coalesces workflow verification sign-off routing and never falls through to an agent prompt", async () => {
		const sessionId = "decision-signoff";
		const target: ReviewGroupModel = {
			...lifecycleGroup(sessionId, "signoff-review"),
			source: {
				kind: "verification-signoff-markdown",
				goalId: "goal-signoff",
				gateId: "gate-signoff",
				signalId: "signal-signoff",
				stepName: "human-review",
			},
		};
		persistReviewGroup(sessionId, target);
		const initial = lifecycleWorkspace(sessionId, [target]);
		state.sidePanelWorkspaceBySession[sessionId] = initial;
		const signoffStarted = deferred();
		const releaseSignoff = deferred<Response>();
		const requests: Array<{ method: string; pathname: string; body: string }> = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
			requests.push({ method, pathname: url.pathname, body: typeof init?.body === "string" ? init.body : "" });
			if (method === "POST" && url.pathname.endsWith("/signoff")) {
				signoffStarted.resolve();
				return releaseSignoff.promise;
			}
			return new Response(null, { status: 204 });
		}));
		const prompt = vi.fn();
		const resolved = vi.fn();
		window.addEventListener(GATE_STATUS_CLIENT_EVENT, resolved);
		const payload = { decision: "approve" as const, finalComment: "Ship it", inlineComments: [], feedback: "" };

		const first = submitReviewGroupDecision(target, payload, { sessionId, prompt });
		const second = submitReviewGroupDecision(target, payload, { sessionId, prompt });
		expect(second).toBe(first);
		await signoffStarted.promise;
		expect(requests.filter((request) => request.method === "POST" && request.pathname.endsWith("/signoff"))).toHaveLength(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(resolved).not.toHaveBeenCalled();
		releaseSignoff.resolve(Response.json({ ok: true }));
		await expect(first).resolves.toMatchObject({ submitted: true, reviewId: target.reviewId });

		expect(resolved).toHaveBeenCalledOnce();
		expect((resolved.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
			type: HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE,
			goalId: "goal-signoff",
			gateId: "gate-signoff",
			signalId: "signal-signoff",
			decision: "pass",
		});
		expect(getReviewTombstone(sessionId, target.reviewId)).toBeUndefined();
		window.removeEventListener(GATE_STATUS_CLIENT_EVENT, resolved);
	});
});

describe("passive replay suppression authority", () => {
	it("suppresses an exact tombstoned review only after authoritative workspace absence is known", async () => {
		const sessionId = "exact-tombstone-absent";
		const group: ReviewGroupModel = {
			...review("absent-review", "Absent review", [{ fileId: "absent-file", title: "absent.md" }]),
			source: { kind: "markdown-review", sessionId },
		};
		persistReviewGroup(sessionId, group);
		state.sidePanelWorkspaceBySession[sessionId] = {
			version: 1,
			sessionId,
			revision: 3,
			tabs: [],
			activeTabId: "",
			sizeMode: "split",
			updatedAt: 3,
		};
		state.lastWorkspaceRevisionBySession[sessionId] = 3;
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
		await setReviewTombstone(sessionId, group.reviewId, "closed", group.activeFileId);

		restorePersistedReviewDocuments(sessionId);

		expect(readPersistedReviewGroups(sessionId)).toEqual([]);
		expect(state.reviewGroupsBySession[sessionId]).toEqual([]);
		expect(getReviewTombstone(sessionId, group.reviewId)).toBe("closed");
		await clearReviewTombstone(sessionId, group.reviewId);
	});
});

describe("legacy submitted authoritative reopen", () => {
	it("keeps an explicit primary through fresh annotation hydration without clearing legacy suppression", async () => {
		const sessionId = "legacy-submitted-live-open";
		let legacySubmitted = true;
		let workspace: SidePanelWorkspace = {
			version: 1,
			sessionId,
			revision: 0,
			tabs: [],
			activeTabId: "",
			sizeMode: "split",
			updatedAt: 1,
		};
		const requests: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
			const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
			requests.push(`${method} ${url.pathname}${url.search}`);
			if (method === "GET" && url.pathname.endsWith("/review/annotations")) {
				return Response.json({ annotations: {}, submitted: legacySubmitted, submittedReviewIds: [], closedReviewIds: [] });
			}
			if (method === "DELETE" && url.pathname.includes("/review/tombstones/")) {
				if (url.searchParams.get("clearLegacySubmitted") === "true") legacySubmitted = false;
				return Response.json({ ok: true });
			}
			if (method === "POST" && url.pathname.endsWith("/side-panel-workspace/open")) {
				const body = JSON.parse(String(init?.body || "{}")) as { tab?: SidePanelWorkspaceTab };
				if (body.tab) {
					workspace = {
						...workspace,
						revision: workspace.revision + 1,
						tabs: [...workspace.tabs.filter((tab) => tab.id !== body.tab!.id), body.tab],
						activeTabId: body.tab.id,
						updatedAt: workspace.updatedAt + 1,
					};
				}
				return Response.json({ workspace });
			}
			throw new Error(`Unexpected request: ${method} ${url.pathname}`);
		}));
		state.selectedSessionId = sessionId;
		state.sidePanelWorkspaceBySession[sessionId] = workspace;

		await initAnnotationStore(sessionId);
		expect(isReviewSubmitted(sessionId)).toBe(true);
		const group = openMarkdownReviewGroup({
			sessionId,
			reviewId: "fresh-review",
			title: "Fresh review",
			files: [{ fileId: "fresh-file", title: "fresh.md", markdown: "# Fresh" }],
			live: true,
		});
		await vi.waitFor(() => expect(state.sidePanelWorkspaceBySession[sessionId]?.tabs.some((tab) =>
			tab.id === "review:fresh-review")).toBe(true));
		expect(requests.some((request) => request.includes("/review/tombstones/"))).toBe(false);
		expect(legacySubmitted).toBe(true);

		state.reviewGroupsBySession = {};
		state.reviewGroups = new Map();
		state.reviewActiveReviewId = "";
		await initAnnotationStore(sessionId);
		restorePersistedReviewDocuments(sessionId);

		expect(isReviewSubmitted(sessionId)).toBe(true);
		expect(readPersistedReviewGroups(sessionId).map((candidate) => candidate.reviewId)).toEqual([group.reviewId]);
		expect(state.reviewGroupsBySession[sessionId]?.map((candidate) => candidate.reviewId)).toEqual([group.reviewId]);
		expect(state.sidePanelWorkspaceBySession[sessionId]?.tabs.map((tab) => tab.id)).toContain("review:fresh-review");
	});
});

describe("review group workspace cleanup", () => {
	function seedCleanup(outcomes: Array<"conflict" | "success">) {
		const target: ReviewGroupModel = {
			...review("cleanup-target", "Target review", [{ fileId: "target-file", title: "target.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		const sibling: ReviewGroupModel = {
			...review("cleanup-sibling", "Sibling review", [{ fileId: "sibling-file", title: "sibling.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		persistReviewGroup(CLEANUP_SESSION_ID, sibling);
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 4,
			tabs: [reviewTab(target), reviewTab(sibling)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 4,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		return { target, sibling, fixture: installWorkspaceCleanupFixture(initial, outcomes) };
	}

	it("clears a legacy title bucket once when the closing review repeats the file title", async () => {
		const target: ReviewGroupModel = {
			...review("cleanup-target", "Duplicate files", [
				{ fileId: "duplicate-first", title: "same.md" },
				{ fileId: "duplicate-second", title: "same.md" },
			]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 4,
			tabs: [reviewTab(target)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 4,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		installWorkspaceCleanupFixture(initial, ["success"]);
		await addAnnotation(CLEANUP_SESSION_ID, "same.md", { id: "legacy-comment", quote: "legacy", comment: "remove" });
		await addAnnotation(CLEANUP_SESSION_ID, "duplicate-first", { id: "first-comment", quote: "first", comment: "remove" });
		await addAnnotation(CLEANUP_SESSION_ID, "duplicate-second", { id: "second-comment", quote: "second", comment: "remove" });

		await cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);

		expect(getAnnotations(CLEANUP_SESSION_ID, "same.md")).toEqual([]);
		expect(getAnnotations(CLEANUP_SESSION_ID, "duplicate-first")).toEqual([]);
		expect(getAnnotations(CLEANUP_SESSION_ID, "duplicate-second")).toEqual([]);
		expect(getAnnotationsForDocument(CLEANUP_SESSION_ID, "future-file", {
			documentId: "future-file",
			title: "same.md",
			markdown: "fresh",
		})).toEqual([]);
	});

	it("keeps a legacy title bucket while a sibling review still owns that title", async () => {
		const target: ReviewGroupModel = {
			...review("cleanup-target", "Duplicate files", [
				{ fileId: "duplicate-first", title: "same.md" },
				{ fileId: "duplicate-second", title: "same.md" },
			]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		const sibling: ReviewGroupModel = {
			...review("cleanup-sibling-same-title", "Sibling", [{ fileId: "sibling-same-file", title: "same.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		persistReviewGroup(CLEANUP_SESSION_ID, sibling);
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 4,
			tabs: [reviewTab(target), reviewTab(sibling)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 4,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		installWorkspaceCleanupFixture(initial, ["success", "success"]);
		await addAnnotation(CLEANUP_SESSION_ID, "same.md", { id: "legacy-comment", quote: "legacy", comment: "keep" });

		await cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);

		expect(getAnnotations(CLEANUP_SESSION_ID, "same.md")).toHaveLength(1);
		expect(getAnnotationsForDocument(CLEANUP_SESSION_ID, sibling.files[0].fileId, {
			documentId: sibling.files[0].fileId,
			title: sibling.files[0].title,
			markdown: sibling.files[0].markdown,
		})).toMatchObject([{ id: "legacy-comment", comment: "keep" }]);

		await cleanupReviewGroup(CLEANUP_SESSION_ID, sibling.reviewId);
		await clearReviewTombstone(CLEANUP_SESSION_ID, sibling.reviewId);
	});

	it("retries an authoritative revision conflict and removes only the target primary tab", async () => {
		const { target, sibling, fixture } = seedCleanup(["conflict", "success"]);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, { id: "target-comment", quote: "target", comment: "remove" });
		await addAnnotation(CLEANUP_SESSION_ID, sibling.files[0].fileId, { id: "sibling-comment", quote: "sibling", comment: "keep" });

		await expect(cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId)).resolves.toMatchObject({ reviewId: target.reviewId });

		expect(fixture.deleteAttempts).toEqual([
			{ tabId: reviewTab(target).id, ifMatch: null },
			{ tabId: reviewTab(target).id, ifMatch: '"5"' },
		]);
		expect(fixture.events.filter((event) => event.startsWith("workspace:") || event === "review:PUT")).toEqual([
			`workspace:conflict:${reviewTab(target).id}`,
			`workspace:success:${reviewTab(target).id}`,
			"review:PUT",
		]);
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(sibling).id]);
		expect(state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID]?.tabs.map((tab) => tab.id)).toEqual([reviewTab(sibling).id]);
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([sibling.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBe("closed");
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toEqual([]);
		expect(getAnnotations(CLEANUP_SESSION_ID, sibling.files[0].fileId)).toHaveLength(1);
	});

	it("rejects after a terminal retry conflict while preserving the group, every annotation bucket, and tombstone eligibility", async () => {
		const { target, sibling, fixture } = seedCleanup(["conflict", "conflict"]);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, { id: "terminal-file", quote: "target", comment: "keep file" });
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].title, { id: "terminal-title", quote: "legacy", comment: "keep title" });
		await addAnnotation(CLEANUP_SESSION_ID, target.reviewId, { id: "terminal-review", quote: "review", comment: "keep review" });

		await expect(cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId)).rejects.toThrow(
			"Review workspace tab could not be closed. Review content was preserved",
		);

		expect(fixture.deleteAttempts).toEqual([
			{ tabId: reviewTab(target).id, ifMatch: null },
			{ tabId: reviewTab(target).id, ifMatch: '"5"' },
		]);
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(target).id, reviewTab(sibling).id]);
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([target.reviewId, sibling.reviewId]);
		expect(readPersistedReviewGroups(CLEANUP_SESSION_ID).map((group) => group.reviewId)).toEqual([target.reviewId, sibling.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBeUndefined();
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toHaveLength(1);
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].title)).toHaveLength(1);
		expect(getAnnotations(CLEANUP_SESSION_ID, target.reviewId)).toHaveLength(1);
	});

	it("retains target content when one of multiple canonical and legacy primaries fails to close", async () => {
		const target: ReviewGroupModel = {
			...review("partial-target", "Partial target", [{ fileId: "partial-file", title: "partial.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		const sibling: ReviewGroupModel = {
			...review("partial-sibling", "Partial sibling", [{ fileId: "sibling-file", title: "sibling.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		persistReviewGroup(CLEANUP_SESSION_ID, sibling);
		const legacyTab: SidePanelWorkspaceTab = {
			...reviewTab(target),
			id: `review:${target.files[0].fileId}`,
			source: {
				type: "review",
				sessionId: CLEANUP_SESSION_ID,
				documentId: target.files[0].fileId,
				title: target.files[0].title,
			},
		};
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 4,
			tabs: [reviewTab(target), legacyTab, reviewTab(sibling)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 4,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		const fixture = installWorkspaceCleanupFixture(initial, ["success", "conflict", "conflict"]);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, { id: "partial-comment", quote: "partial", comment: "keep" });

		await expect(cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId)).rejects.toThrow("Review content was preserved");

		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([legacyTab.id, reviewTab(sibling).id]);
		expect(readPersistedReviewGroups(CLEANUP_SESSION_ID)).toEqual([target, sibling]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBeUndefined();
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toHaveLength(1);
	});

	it("serializes a non-live sign-off open after authoritative absence without clearing its tombstone or content", async () => {
		const { target, sibling } = seedCleanup(["success"]);
		const initial = state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID]!;
		const fixture = installHeldPostDeleteLifecycleFixture(initial, reviewTab(target).id);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, {
			id: "preserved-comment",
			quote: "target",
			comment: "keep through sign-off reopen",
		});

		const cleanup = cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);
		await fixture.deleteCommitted;
		openReviewDocument({
			sessionId: CLEANUP_SESSION_ID,
			reviewId: target.reviewId,
			documentId: target.files[0].fileId,
			title: target.title,
			markdown: "# Pending human sign-off",
			source: {
				kind: "verification-signoff-markdown",
				goalId: "signoff-goal",
				gateId: "signoff-gate",
				signalId: "signoff-signal",
				stepName: "human-review",
			},
		});
		fixture.releaseDeleteResponse();

		await expect(cleanup).resolves.toBeUndefined();
		await vi.waitFor(() => expect(fixture.workspace().tabs.map((tab) => tab.id).sort()).toEqual([
			reviewTab(sibling).id,
			reviewTab(target).id,
		].sort()));
		const persisted = readPersistedReviewGroups(CLEANUP_SESSION_ID);
		expect(persisted.map((group) => group.reviewId)).toEqual([target.reviewId, sibling.reviewId]);
		expect(persisted[1]).toEqual(sibling);
		expect(persisted[0]).toMatchObject({
			reviewId: target.reviewId,
			files: [{ fileId: target.files[0].fileId, markdown: "# Pending human sign-off" }],
			source: { kind: "verification-signoff-markdown", signalId: "signoff-signal" },
		});
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toHaveLength(1);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBeUndefined();
		expect(fixture.requests.some((request) =>
			request.method === "DELETE" && request.pathname.includes("/review/tombstones/"))).toBe(false);
		expect(fixture.requests.filter((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toHaveLength(1);
	});

	it("lets a newer cleanup supersede a queued non-live sign-off open", async () => {
		const { target, sibling } = seedCleanup(["success"]);
		const initial = state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID]!;
		const fixture = installHeldPostDeleteLifecycleFixture(initial, reviewTab(target).id);

		const staleCleanup = cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);
		await fixture.deleteCommitted;
		openReviewDocument({
			sessionId: CLEANUP_SESSION_ID,
			reviewId: target.reviewId,
			documentId: target.files[0].fileId,
			title: target.title,
			markdown: "# Superseded sign-off",
			source: {
				kind: "verification-signoff-markdown",
				goalId: "signoff-goal",
				gateId: "signoff-gate",
				signalId: "signoff-signal-newer-close",
				stepName: "human-review",
			},
		});
		const currentCleanup = cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);
		fixture.releaseDeleteResponse();

		await expect(staleCleanup).resolves.toBeUndefined();
		await expect(currentCleanup).resolves.toMatchObject({ reviewId: target.reviewId });
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(sibling).id]);
		expect(readPersistedReviewGroups(CLEANUP_SESSION_ID).map((group) => group.reviewId)).toEqual([sibling.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBe("closed");
		expect(fixture.requests.filter((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toEqual([]);
	});

	it("serializes a fresh exact live open after a pending close while unrelated review keys remain independent", async () => {
		const target: ReviewGroupModel = {
			...review("cleanup-target", "Target review", [{ fileId: "target-file", title: "target.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		const sibling: ReviewGroupModel = {
			...review("cleanup-sibling", "Sibling review", [{ fileId: "sibling-file", title: "sibling.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		persistReviewGroup(CLEANUP_SESSION_ID, sibling);
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 8,
			tabs: [reviewTab(target), reviewTab(sibling)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 8,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		state.selectedSessionId = FOREGROUND_SESSION_ID;
		const foreground = review("foreground-review", "Foreground", [{ fileId: "foreground-file", title: "foreground.md" }]);
		state.reviewGroups = new Map([[foreground.reviewId, foreground]]);
		state.reviewActiveReviewId = foreground.reviewId;
		const fixture = installHeldLifecycleFixture(initial, reviewTab(target).id);

		const cleanup = cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);
		await fixture.deleteStarted;
		const reopened = openMarkdownReviewGroup({
			sessionId: CLEANUP_SESSION_ID,
			reviewId: target.reviewId,
			title: target.title,
			files: [{ fileId: "reopened-file", title: "target.md", markdown: "fresh" }],
			live: true,
		});
		openMarkdownReviewGroup({
			sessionId: CLEANUP_SESSION_ID,
			reviewId: sibling.reviewId,
			title: sibling.title,
			files: [{ fileId: sibling.files[0].fileId, title: "sibling.md", markdown: "updated sibling" }],
			live: true,
		});

		await vi.waitFor(() => expect(fixture.requests.some((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toBe(true));
		expect(fixture.requests.filter((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toHaveLength(1);
		expect(state.reviewGroups.get(foreground.reviewId)).toBe(foreground);
		expect(state.reviewActiveReviewId).toBe(foreground.reviewId);

		fixture.releaseDelete();
		await expect(cleanup).resolves.toBeUndefined();
		await vi.waitFor(() => expect(fixture.requests.filter((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toHaveLength(2));

		expect(fixture.workspace().tabs.map((tab) => tab.id).sort()).toEqual([
			reviewTab(sibling).id,
			reviewTab(target).id,
		].sort());
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([
			reopened.reviewId,
			sibling.reviewId,
		]);
		expect(readPersistedReviewGroups(CLEANUP_SESSION_ID).map((group) => group.reviewId)).toEqual([
			reopened.reviewId,
			sibling.reviewId,
		]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBeUndefined();

		restorePersistedReviewDocuments(CLEANUP_SESSION_ID);
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([
			reopened.reviewId,
			sibling.reviewId,
		]);
		expect(state.reviewGroups.get(foreground.reviewId)).toBe(foreground);
	});

	it("suppresses a stale terminal close conflict when an exact live reopen is already queued", async () => {
		const target: ReviewGroupModel = {
			...review("cleanup-target", "Target review", [{ fileId: "target-file", title: "target.md" }]),
			source: { kind: "markdown-review", sessionId: CLEANUP_SESSION_ID },
		};
		persistReviewGroup(CLEANUP_SESSION_ID, target);
		const initial: SidePanelWorkspace = {
			version: 1,
			sessionId: CLEANUP_SESSION_ID,
			revision: 12,
			tabs: [reviewTab(target)],
			activeTabId: reviewTab(target).id,
			sizeMode: "split",
			updatedAt: 12,
		};
		state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID] = initial;
		state.lastWorkspaceRevisionBySession[CLEANUP_SESSION_ID] = initial.revision;
		const fixture = installHeldLifecycleFixture(initial, reviewTab(target).id, ["conflict", "conflict"]);

		const cleanup = cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId);
		await fixture.deleteStarted;
		openMarkdownReviewGroup({
			sessionId: CLEANUP_SESSION_ID,
			reviewId: target.reviewId,
			title: target.title,
			files: [{ fileId: "fresh-file", title: "fresh.md", markdown: "fresh" }],
			live: true,
		});
		fixture.releaseDelete();

		await expect(cleanup).resolves.toBeUndefined();
		await vi.waitFor(() => expect(fixture.requests.filter((request) =>
			request.method === "DELETE" && request.tabId === reviewTab(target).id)).toHaveLength(2));
		await vi.waitFor(() => expect(fixture.requests.some((request) =>
			request.method === "POST" && request.pathname.endsWith("/side-panel-workspace/open"))).toBe(true));
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(target).id]);
		expect(readPersistedReviewGroups(CLEANUP_SESSION_ID).map((group) => group.reviewId)).toEqual([target.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBeUndefined();
	});
});
