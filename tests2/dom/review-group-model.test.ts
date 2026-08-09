import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	openMarkdownReviewDocument,
	openMarkdownReviewGroup,
	upsertReviewGroup,
} from "../../src/app/review-sources.js";
import { setRenderApp, state, type ReviewGroupModel } from "../../src/app/state.js";
import type { SidePanelWorkspace, SidePanelWorkspaceTab } from "../../src/app/side-panel-workspace.js";

const SESSION_ID = "review-group-model-session";

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

afterEach(() => {
	setRenderApp(() => {});
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
