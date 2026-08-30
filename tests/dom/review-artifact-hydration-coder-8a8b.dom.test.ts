import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitArtifactReviewGroup,
	getArtifactReviewWorkspaceReferences,
	persistReviewGroup,
	setReviewActiveFile,
	type ArtifactReviewReference,
} from "../../src/app/review-sources.js";
import { applySidePanelWorkspaceFromServer } from "../../src/app/side-panel-workspace.js";
import { setRenderApp, state, type ReviewGroupModel } from "../../src/app/state.js";

const SESSION_ID = "artifact-review-session";
const reference: ArtifactReviewReference = {
	sessionId: SESSION_ID,
	reviewId: "review-large",
	title: "Large review",
	toolCallId: "tool-call-large",
	payloadId: "payload-large",
	contentHash: "a".repeat(64),
	activeFileId: "file-b",
};

function artifactTabFor(value: ArtifactReviewReference, activeFileId = value.activeFileId) {
	return {
		id: `review:${encodeURIComponent(value.reviewId)}`,
		kind: "review" as const,
		title: `Review: ${value.title}`,
		label: `Review: ${value.title}`,
		source: {
			type: "review" as const,
			sessionId: value.sessionId,
			reviewId: value.reviewId,
			title: value.title,
			toolCallId: value.toolCallId,
			payloadId: value.payloadId,
			contentHash: value.contentHash,
		},
		state: { activeFileId },
		updatedAt: 1,
	};
}

function artifactTab(activeFileId = reference.activeFileId) {
	return artifactTabFor(reference, activeFileId);
}

function payloadFor(value: ArtifactReviewReference, titles = ["A.md", "B.md"]): ReviewGroupModel {
	return {
		reviewId: value.reviewId,
		title: value.title,
		files: [
			{ fileId: "file-a", title: titles[0]!, markdown: "# A\n\nlarge body" },
			{ fileId: "file-b", title: titles[1]!, markdown: "# B\n\nlarge body" },
		],
		activeFileId: value.activeFileId,
		source: { kind: "markdown-review", sessionId: value.sessionId },
	};
}

function payload(): ReviewGroupModel {
	return payloadFor(reference);
}

function applyWorkspace(tabs: any[] = [artifactTab()], activeTabId = artifactTab().id): void {
	applySidePanelWorkspaceFromServer({
		version: 1,
		sessionId: SESSION_ID,
		revision: 1,
		tabs,
		activeTabId,
		sizeMode: "split",
		updatedAt: 1,
	}, { source: "hydrate", skipRender: true, force: true });
}

beforeEach(() => {
	(window as any).happyDOM?.setURL?.(`http://localhost/#/session/${SESSION_ID}`);
	setRenderApp(() => {});
	state.selectedSessionId = SESSION_ID;
	state.remoteAgent = null;
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
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("artifact-backed review hydration", () => {
	it("commits exact content only for an authoritative artifact tab without storing Markdown locally", () => {
		const sibling: ReviewGroupModel = {
			reviewId: "review-sibling",
			title: "Sibling",
			files: [{ fileId: "sibling-file", title: "Sibling.md", markdown: "keep sibling" }],
			activeFileId: "sibling-file",
			source: { kind: "markdown-review", sessionId: SESSION_ID },
		};
		persistReviewGroup(SESSION_ID, sibling);
		const siblingTab = {
			id: "review:review-sibling",
			kind: "review" as const,
			title: "Review: Sibling",
			label: "Review: Sibling",
			source: { type: "review" as const, sessionId: SESSION_ID, reviewId: "review-sibling", title: "Sibling" },
			state: { activeFileId: "sibling-file" },
			updatedAt: 1,
		};
		applyWorkspace([siblingTab, artifactTab()], artifactTab().id);

		const committed = commitArtifactReviewGroup(reference, payload());

		expect(committed.files.map((file) => file.fileId)).toEqual(["file-a", "file-b"]);
		expect(state.reviewGroupsBySession[SESSION_ID].map((group) => group.reviewId)).toEqual([
			"review-sibling",
			"review-large",
		]);
		expect(state.reviewActiveReviewId).toBe("review-large");
		expect(state.reviewActiveTab).toBe("file-b");
		const stored = localStorage.getItem(`bobbit-review-contexts-v1:${SESSION_ID}`) || "";
		expect(stored).toContain("keep sibling");
		expect(stored).not.toContain("large body");
	});

	it("preserves accepted whitespace and >160-character artifact titles through open and reload", () => {
		const exactTitle = `  ${"é".repeat(150)}${"x".repeat(12)}  `;
		const exactFileTitle = ` ${"界".repeat(90)}${"y".repeat(30)} `;
		const exactReference = { ...reference, title: exactTitle };
		const exactPayload = payloadFor(exactReference, [exactFileTitle, "  "]);
		applyWorkspace([artifactTabFor(exactReference)], artifactTabFor(exactReference).id);

		const [openedReference] = getArtifactReviewWorkspaceReferences(SESSION_ID);
		expect(openedReference.title).toBe(exactTitle);
		const opened = commitArtifactReviewGroup(openedReference, exactPayload);
		expect(opened.title).toBe(exactTitle);
		expect(opened.files.map((file) => file.title)).toEqual([exactFileTitle, "  "]);

		state.reviewGroupsBySession[SESSION_ID] = [];
		const [reloadReference] = getArtifactReviewWorkspaceReferences(SESSION_ID);
		const reloaded = commitArtifactReviewGroup(reloadReference, exactPayload);
		expect(reloaded.title).toBe(exactTitle);
		expect(reloaded.files.map((file) => file.title)).toEqual([exactFileTitle, "  "]);
	});

	it("hydrates exact multibyte identity maxima and drops +1 without lossy normalization", () => {
		const reviewId = "界".repeat(100); // 300 UTF-8 bytes
		const toolCallId = `${"界".repeat(66)}é`; // 200 UTF-8 bytes
		const fileId = `${"🙂".repeat(49)}界x`; // 200 UTF-8 bytes
		const exactReference: ArtifactReviewReference = {
			...reference,
			reviewId,
			toolCallId,
			activeFileId: fileId,
		};
		const exactPayload: ReviewGroupModel = {
			reviewId,
			title: exactReference.title,
			files: [{ fileId, title: "Exact.md", markdown: "exact" }],
			activeFileId: fileId,
			source: { kind: "markdown-review", sessionId: SESSION_ID },
		};
		const exactTab = artifactTabFor(exactReference, fileId);
		applyWorkspace([exactTab], exactTab.id);

		const [hydrationReference] = getArtifactReviewWorkspaceReferences(SESSION_ID);
		expect(hydrationReference).toMatchObject({ reviewId, toolCallId, activeFileId: fileId });
		const hydrated = commitArtifactReviewGroup(hydrationReference, exactPayload);
		expect(hydrated.reviewId).toBe(reviewId);
		expect(hydrated.files[0].fileId).toBe(fileId);
		expect(state.sidePanelWorkspaceBySession[SESSION_ID].tabs[0].id)
			.toBe(`review:${encodeURIComponent(reviewId)}`);

		for (const invalid of [
			{ ...exactReference, reviewId: `${reviewId}x` },
			{ ...exactReference, toolCallId: `${toolCallId}x` },
			{ ...exactReference, activeFileId: `${fileId}x` },
		]) {
			const invalidTab = artifactTabFor(invalid, invalid.activeFileId);
			applyWorkspace([invalidTab], invalidTab.id);
			expect(getArtifactReviewWorkspaceReferences(SESSION_ID)).toEqual([]);
		}
	});

	it("rejects stale or mismatched references before changing review state", () => {
		applyWorkspace();
		const before = structuredClone(state.reviewGroupsBySession);

		expect(() => commitArtifactReviewGroup({ ...reference, payloadId: "forged" }, payload()))
			.toThrow("workspace reference");
		expect(() => commitArtifactReviewGroup(reference, { ...payload(), reviewId: "other-review" }))
			.toThrow("identity");
		expect(state.reviewGroupsBySession).toEqual(before);
	});

	it("ignores partial artifact sources and never hydrates them as references", () => {
		const partial = artifactTab() as any;
		delete partial.source.contentHash;
		applyWorkspace([partial], partial.id);

		expect(getArtifactReviewWorkspaceReferences(SESSION_ID)).toEqual([]);
		expect(() => commitArtifactReviewGroup(reference, payload())).toThrow("workspace reference");
	});

	it("persists file navigation in exact workspace tab state before updating the group", async () => {
		applyWorkspace();
		commitArtifactReviewGroup(reference, payload());
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const patch = JSON.parse(String(init?.body || "{}")) as { patch?: { state?: { activeFileId?: string } } };
			const nextTab = artifactTab(patch.patch?.state?.activeFileId || reference.activeFileId);
			return Response.json({
				workspace: {
					version: 1,
					sessionId: SESSION_ID,
					revision: 2,
					tabs: [nextTab],
					activeTabId: nextTab.id,
					sizeMode: "split",
					updatedAt: 2,
				},
			});
		}));

		await expect(setReviewActiveFile(SESSION_ID, reference.reviewId, "file-a")).resolves.toBe(true);
		expect(state.sidePanelWorkspaceBySession[SESSION_ID].tabs[0].state?.activeFileId).toBe("file-a");
		expect(state.reviewGroupsBySession[SESSION_ID][0].activeFileId).toBe("file-a");
		expect(localStorage.getItem(`bobbit-review-contexts-v1:${SESSION_ID}`)).toBeNull();

		// A reload fetches the immutable payload with its original active file;
		// the durable workspace state remains the selection authority.
		state.reviewGroupsBySession[SESSION_ID] = [];
		const [reloadReference] = getArtifactReviewWorkspaceReferences(SESSION_ID);
		commitArtifactReviewGroup(reloadReference, payload());
		expect(state.reviewGroupsBySession[SESSION_ID][0].activeFileId).toBe("file-a");
	});

	it("hydrates a background owner without changing the foreground review mirrors", () => {
		state.selectedSessionId = "foreground-session";
		state.reviewActiveReviewId = "foreground-review";
		state.reviewActiveTab = "foreground-file";
		applyWorkspace();

		commitArtifactReviewGroup(reference, payload());

		expect(state.reviewGroupsBySession[SESSION_ID][0].reviewId).toBe(reference.reviewId);
		expect(state.reviewActiveReviewId).toBe("foreground-review");
		expect(state.reviewActiveTab).toBe("foreground-file");
	});
});
