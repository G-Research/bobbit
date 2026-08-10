import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanupReviewGroup,
	openMarkdownReviewDocument,
	openMarkdownReviewGroup,
	persistReviewGroup,
	upsertReviewGroup,
} from "../../src/app/review-sources.js";
import { setRenderApp, state, type ReviewGroupModel } from "../../src/app/state.js";
import type { SidePanelWorkspace, SidePanelWorkspaceTab } from "../../src/app/side-panel-workspace.js";
import {
	addAnnotation,
	clearReviewTombstone,
	getAnnotations,
	getReviewTombstone,
} from "../../src/ui/components/review/AnnotationStore.js";

const SESSION_ID = "review-group-model-session";
const CLEANUP_SESSION_ID = "review-group-cleanup-session";

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
): { deleteAttempts: Array<{ tabId: string; ifMatch: string | null }>; workspace: () => SidePanelWorkspace } {
	let workspace = initial;
	const deleteAttempts: Array<{ tabId: string; ifMatch: string | null }> = [];
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
		if (url.pathname.includes("/review/")) return new Response(null, { status: 204 });
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	}));
	return { deleteAttempts, workspace: () => workspace };
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
	localStorage.clear();
});

afterEach(async () => {
	setRenderApp(() => {});
	if (getReviewTombstone(CLEANUP_SESSION_ID, "cleanup-target")) {
		await clearReviewTombstone(CLEANUP_SESSION_ID, "cleanup-target");
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
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
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

	it("retries an authoritative revision conflict and removes only the target primary tab", async () => {
		const { target, sibling, fixture } = seedCleanup(["conflict", "success"]);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, { id: "target-comment", quote: "target", comment: "remove" });
		await addAnnotation(CLEANUP_SESSION_ID, sibling.files[0].fileId, { id: "sibling-comment", quote: "sibling", comment: "keep" });

		await expect(cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId)).resolves.toMatchObject({ reviewId: target.reviewId });

		expect(fixture.deleteAttempts).toEqual([
			{ tabId: reviewTab(target).id, ifMatch: null },
			{ tabId: reviewTab(target).id, ifMatch: '"5"' },
		]);
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(sibling).id]);
		expect(state.sidePanelWorkspaceBySession[CLEANUP_SESSION_ID]?.tabs.map((tab) => tab.id)).toEqual([reviewTab(sibling).id]);
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([sibling.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBe("closed");
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toEqual([]);
		expect(getAnnotations(CLEANUP_SESSION_ID, sibling.files[0].fileId)).toHaveLength(1);
	});

	it("rejects after a terminal retry conflict while retaining content cleanup and exact tombstone authority", async () => {
		const { target, sibling, fixture } = seedCleanup(["conflict", "conflict"]);
		await addAnnotation(CLEANUP_SESSION_ID, target.files[0].fileId, { id: "terminal-comment", quote: "target", comment: "remove" });

		await expect(cleanupReviewGroup(CLEANUP_SESSION_ID, target.reviewId)).rejects.toThrow(
			"Review content was removed, but its workspace tab could not be closed",
		);

		expect(fixture.deleteAttempts).toEqual([
			{ tabId: reviewTab(target).id, ifMatch: null },
			{ tabId: reviewTab(target).id, ifMatch: '"5"' },
		]);
		expect(fixture.workspace().tabs.map((tab) => tab.id)).toEqual([reviewTab(target).id, reviewTab(sibling).id]);
		expect(state.reviewGroupsBySession[CLEANUP_SESSION_ID]?.map((group) => group.reviewId)).toEqual([sibling.reviewId]);
		expect(getReviewTombstone(CLEANUP_SESSION_ID, target.reviewId)).toBe("closed");
		expect(getAnnotations(CLEANUP_SESSION_ID, target.files[0].fileId)).toEqual([]);
	});
});
