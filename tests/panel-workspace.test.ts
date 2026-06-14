import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	CHAT_PANEL_TAB_ID,
	DEFAULT_PACK_PANEL_INSTANCE_KEY,
	INBOX_PANEL_TAB_ID,
	LIVE_PREVIEW_PANEL_TAB_ID,
	activePanelTabIdForSession,
	activeSidePanelTabIdForSession,
	buildPanelWorkspaceTabs,
	findPanelTab,
	firstContentPanelTab,
	isLivePreviewTab,
	isPinnedPanelTab,
	nextActivePanelTabId,
	normalizeSidePanelTabs,
	packPanelRefFromTabId,
	packPanelTabId,
	previewContentHashFromTab,
	previewEntryLabel,
	previewEntryTabId,
	previewTabDisplayTitle,
	previewTabIdentityForContent,
	previewTabsHaveSameContent,
	previewVersionRecordFor,
	previewVersionedTabId,
	registerPreviewVersion,
	reorderSidePanelTab,
	legacyReviewDocumentIdFromTitle,
	rememberReviewDocumentIdentity,
	reviewDocumentIdForTitle,
	reviewDocumentIdFromPanelTab,
	reviewPanelTabId,
	setActivePanelTabIdForSession,
	type PanelWorkspaceTab,
} from "../src/app/panel-workspace.ts";

function previewTab(id: string, source: Record<string, unknown> = {}, state: Record<string, unknown> = {}): PanelWorkspaceTab {
	const entry = typeof source.entry === "string" ? source.entry : typeof state.entry === "string" ? state.entry : "inline.html";
	return {
		id,
		kind: "preview",
		title: previewEntryLabel(entry),
		label: previewEntryLabel(entry),
		legacyTab: "preview",
		source: { type: "html-preview", entry, ...source } as any,
		state: { entry, ...state },
	};
}

const PROPOSAL_TEST_LABELS = {
	goal: "Goal",
	project: "Project",
	role: "Role",
	tool: "Tool",
	staff: "Staff",
} as const;

type TestProposalType = keyof typeof PROPOSAL_TEST_LABELS;

function proposalTab(type: TestProposalType = "goal", rev?: number): PanelWorkspaceTab {
	const label = PROPOSAL_TEST_LABELS[type];
	return {
		id: rev ? `proposal:${type}:rev:${rev}` : `proposal:${type}`,
		kind: "proposal",
		title: `${label} Proposal${rev ? ` rev ${rev}` : ""}`,
		label: rev ? `${label} r${rev}` : label,
		legacyTab: type,
		source: { type: "proposal", proposalType: type, ...(rev ? { rev, historical: true } : {}) },
		state: rev ? { rev, historical: true } : undefined,
	};
}

function reviewTab(title = "Notes"): PanelWorkspaceTab {
	return {
		id: reviewPanelTabId(title),
		kind: "review",
		title: `Review: ${title}`,
		label: `Review: ${title}`,
		legacyTab: "review",
		source: { type: "review", title, reviewTitle: title },
	};
}

function inboxTab(): PanelWorkspaceTab {
	return {
		id: INBOX_PANEL_TAB_ID,
		kind: "inbox",
		title: "Inbox",
		label: "Inbox",
		legacyTab: "inbox",
		source: { type: "inbox" },
	};
}

function chatTab(): PanelWorkspaceTab {
	return {
		id: CHAT_PANEL_TAB_ID,
		kind: "chat",
		title: "Chat",
		label: "Chat",
		legacyTab: "chat",
		source: { type: "chat" },
	};
}

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

describe("panel workspace side-pane tab contract", () => {
	it("buildPanelWorkspaceTabs emits side-pane tabs only and pins Inbox first", () => {
		const tabs = buildPanelWorkspaceTabs({
			sessionId: "s1",
			isPreviewSession: true,
			previewEntry: "dir/report.html?mtime=1",
			previewContentHash: hashA,
			activeProposalTypes: ["goal"],
			assistantProposalType: null,
			reviewTitles: ["Findings"],
			reviewPanelOpen: true,
			inboxPanelOpen: true,
			inboxHasPending: true,
		});

		assert.deepEqual(tabs.map((tab) => tab.id), [
			INBOX_PANEL_TAB_ID,
			previewEntryTabId("report.html"),
			"proposal:goal",
			reviewPanelTabId("Findings"),
		]);
		assert.equal(tabs.some((tab) => tab.id === CHAT_PANEL_TAB_ID || tab.kind === "chat"), false);
		assert.equal(tabs[0].kind, "inbox");
		assert.equal(isPinnedPanelTab(tabs[0]), true);
		assert.equal(firstContentPanelTab(tabs)?.id, INBOX_PANEL_TAB_ID);
	});

	it("findPanelTab is exact-id keyed except legacy preview/review migration", () => {
		const tabs = buildPanelWorkspaceTabs({
			sessionId: "s1",
			isPreviewSession: true,
			previewEntry: "inline.html",
			activeProposalTypes: [],
			assistantProposalType: null,
			reviewTitles: ["Encoded Title"],
			reviewPanelOpen: true,
			inboxPanelOpen: false,
			inboxHasPending: false,
		});

		assert.equal(findPanelTab([...tabs, chatTab()], CHAT_PANEL_TAB_ID), undefined);
		assert.equal(findPanelTab(tabs, "preview")?.id, previewEntryTabId("inline.html"));
		assert.equal(findPanelTab(tabs, LIVE_PREVIEW_PANEL_TAB_ID)?.id, previewEntryTabId("inline.html"));
		assert.equal(findPanelTab(tabs, previewVersionedTabId("missing.html", 1)), undefined);
		assert.equal(findPanelTab(tabs, reviewPanelTabId("Encoded Title"))?.id, reviewPanelTabId("Encoded Title"));
	});

	it("uses durable pack instance keys while accepting legacy two-part pack ids", () => {
		assert.equal(packPanelTabId("demo_pack", "demo.panel"), `pack:demo_pack:demo.panel:${DEFAULT_PACK_PANEL_INSTANCE_KEY}`);
		assert.equal(packPanelTabId("demo_pack", "demo.panel", "artifact-1"), "pack:demo_pack:demo.panel:artifact-1");
		assert.deepEqual(packPanelRefFromTabId("pack:demo_pack:demo.panel"), {
			packId: "demo_pack",
			panelId: "demo.panel",
			instanceKey: DEFAULT_PACK_PANEL_INSTANCE_KEY,
			legacyTwoPart: true,
		});
		assert.deepEqual(packPanelRefFromTabId("pack:demo_pack:demo.panel:artifact-1"), {
			packId: "demo_pack",
			panelId: "demo.panel",
			instanceKey: "artifact-1",
			legacyTwoPart: undefined,
		});
	});

	it("maps review tabs by document id with deterministic legacy-title fallback", () => {
		const legacyId = legacyReviewDocumentIdFromTitle("Findings");
		assert.match(legacyId, /^legacy-title-[a-f0-9]{64}$/);
		assert.equal(reviewDocumentIdForTitle("Findings"), legacyId);
		assert.equal(reviewPanelTabId("Findings"), `review:${encodeURIComponent(legacyId)}`);

		rememberReviewDocumentIdentity("Findings", "review-doc:s1:abc");
		const tab = reviewTab("Findings");
		assert.equal(tab.id, "review:review-doc%3As1%3Aabc");
		assert.equal(reviewDocumentIdFromPanelTab(tab), "review-doc:s1:abc");
		assert.equal(findPanelTab([tab], "review:Findings")?.id, tab.id);
	});

	it("active helpers never return or store chat", () => {
		const state = {
			selectedSessionId: "s1",
			activePanelTabId: CHAT_PANEL_TAB_ID,
			panelWorkspaceActiveBySession: { s1: CHAT_PANEL_TAB_ID },
			panelTabsBySession: { s1: [chatTab(), previewTab(previewEntryTabId("a.html"), { entry: "a.html" })] },
		};

		assert.equal(activePanelTabIdForSession(state, "s1"), "");
		assert.equal(state.panelWorkspaceActiveBySession.s1, "");
		setActivePanelTabIdForSession(state, "s1", CHAT_PANEL_TAB_ID);
		assert.equal(state.panelWorkspaceActiveBySession.s1, "");
		assert.equal(state.activePanelTabId, "");
		setActivePanelTabIdForSession(state, "s1", "");
		assert.equal(activePanelTabIdForSession(state, "s1"), "");
		setActivePanelTabIdForSession(state, "s1", "preview");
		assert.equal(activePanelTabIdForSession(state, "s1"), previewEntryTabId("a.html"));
		setActivePanelTabIdForSession(state, "s1", "not-a-tab");
		assert.equal(activeSidePanelTabIdForSession(state, "s1"), "");
		setActivePanelTabIdForSession(state, "s1", previewEntryTabId("a.html"));
		assert.equal(activePanelTabIdForSession(state, "s1"), previewEntryTabId("a.html"));
	});

	it("migrates legacy active preview ids to the current filename tab", () => {
		const state = {
			selectedSessionId: "s1",
			panelWorkspaceActiveBySession: { s1: "preview" },
			panelTabsBySession: { s1: [previewTab(LIVE_PREVIEW_PANEL_TAB_ID, { entry: "legacy.html", live: true })] },
		};

		assert.equal(activePanelTabIdForSession(state, "s1"), previewEntryTabId("legacy.html"));
		assert.equal(state.panelWorkspaceActiveBySession.s1, previewEntryTabId("legacy.html"));
	});

	it("normalizeSidePanelTabs drops legacy chat/invalid rows, normalizes live preview, merges metadata, dedupes, and pins Inbox", () => {
		const state = {
			selectedSessionId: "s1",
			panelTabsBySession: {
				s1: [
					chatTab(),
					previewTab(LIVE_PREVIEW_PANEL_TAB_ID, { entry: "a.html", contentHash: hashA, live: true }),
					previewTab("preview:tool:old:1", { entry: "old.html" }),
					proposalTab(),
					inboxTab(),
					proposalTab(),
				],
			},
		};
		const derived = [
			inboxTab(),
			previewTab(previewEntryTabId("a.html"), { entry: "a.html", contentHash: hashB, live: true }),
			proposalTab(),
			reviewTab("Review A"),
		];

		const normalized = normalizeSidePanelTabs(state, "s1", derived);

		assert.deepEqual(normalized.map((tab) => tab.id), [
			INBOX_PANEL_TAB_ID,
			previewEntryTabId("a.html"),
			"proposal:goal",
			reviewPanelTabId("Review A"),
		]);
		assert.equal(previewContentHashFromTab(normalized[1]), hashB);
		assert.equal(normalized.some((tab) => tab.id === CHAT_PANEL_TAB_ID || tab.id.startsWith("preview:tool")), false);

		const staleInbox = normalizeSidePanelTabs(
			{ panelTabsBySession: { s1: [inboxTab(), previewTab(previewEntryTabId("solo.html"), { entry: "solo.html" })] } },
			"s1",
			[previewTab(previewEntryTabId("solo.html"), { entry: "solo.html" })],
		);
		assert.deepEqual(staleInbox.map((tab) => tab.id), [previewEntryTabId("solo.html")]);
	});

	it("drops stale current proposal and review tabs absent from derived tabs", () => {
		const historicalPreview = previewTab(previewVersionedTabId("snap.html", 1), { entry: "snap.html", historical: true }, { version: 1, historical: true });
		const currentPreview = previewTab(previewEntryTabId("current.html"), { entry: "current.html", live: true });
		const state = {
			panelTabsBySession: {
				s1: [
					currentPreview,
					historicalPreview,
					proposalTab("goal"),
					proposalTab("tool"),
					proposalTab("goal", 1),
					reviewTab("Gone"),
				],
			},
		};
		const normalized = normalizeSidePanelTabs(state, "s1", [proposalTab("goal")]);

		assert.deepEqual(normalized.map((tab) => tab.id), [
			previewEntryTabId("current.html"),
			previewVersionedTabId("snap.html", 1),
			"proposal:goal",
			"proposal:goal:rev:1",
		]);
	});

	it("assigns preview versions per filename in chronological distinct-content order", () => {
		const state = {};

		assert.equal(previewEntryLabel("nested/a.html#hash"), "a.html");
		assert.equal(previewEntryTabId("nested/a.html"), "preview:entry:a.html");
		assert.equal(previewVersionedTabId("nested/a.html", 2), "preview:entry:a.html:v:2");
		assert.equal(previewTabDisplayTitle("nested/a.html", 2, false), "a.html");
		assert.equal(previewTabDisplayTitle("nested/a.html", 2, true), "a.html (v2)");

		assert.equal(registerPreviewVersion(state, "s1", "a.html", hashA, { current: true }), 1);
		assert.equal(registerPreviewVersion(state, "s1", "a.html", hashA, { current: true }), 1);
		assert.equal(registerPreviewVersion(state, "s1", "a.html", hashB, { current: true }), 2);
		assert.equal(registerPreviewVersion(state, "s1", "b.html", hashC, { current: true }), 1);

		assert.deepEqual(previewVersionRecordFor(state, "s1", "a.html"), {
			latestVersion: 2,
			latestContentHash: hashB,
			hashToVersion: { [hashA]: 1, [hashB]: 2 },
		});
		assert.deepEqual(previewVersionRecordFor(state, "s1", "b.html"), {
			latestVersion: 1,
			latestContentHash: hashC,
			hashToVersion: { [hashC]: 1 },
		});
	});

	it("keeps latest preview on the filename tab and versions only older differing content", () => {
		const state = {};
		const v1 = previewTabIdentityForContent(state, "s1", "a.html", hashA, { current: true });
		const v2 = previewTabIdentityForContent(state, "s1", "a.html", hashB, { current: true });
		const reopenLatest = previewTabIdentityForContent(state, "s1", "a.html", hashB, { historical: true });
		const reopenOld = previewTabIdentityForContent(state, "s1", "a.html", hashA, { historical: true });

		assert.equal(v1.id, previewEntryTabId("a.html"));
		assert.equal(v1.title, "a.html");
		assert.equal(v2.id, previewEntryTabId("a.html"));
		assert.equal(v2.title, "a.html");
		assert.equal(reopenLatest.id, previewEntryTabId("a.html"));
		assert.equal(reopenLatest.historical, false);
		assert.equal(reopenOld.id, previewVersionedTabId("a.html", 1));
		assert.equal(reopenOld.title, "a.html (v1)");
		assert.equal(reopenOld.historical, true);
	});

	it("chooses next-right then left when closing active tabs", () => {
		const tabs = [
			previewTab(previewEntryTabId("a.html"), { entry: "a.html" }),
			previewTab(previewEntryTabId("b.html"), { entry: "b.html" }),
			reviewTab("Notes"),
		];

		assert.equal(nextActivePanelTabId(tabs, previewEntryTabId("b.html")), reviewPanelTabId("Notes"));
		assert.equal(nextActivePanelTabId(tabs, reviewPanelTabId("Notes")), previewEntryTabId("b.html"));
		assert.equal(nextActivePanelTabId([tabs[0]], tabs[0].id), "");
	});

	it("reorders only non-pinned side-pane tabs and never before pinned Inbox", () => {
		const tabs = [chatTab(), inboxTab(), previewTab(previewEntryTabId("a.html"), { entry: "a.html" }), proposalTab(), reviewTab("Notes")];

		assert.deepEqual(
			reorderSidePanelTab(tabs, previewEntryTabId("a.html"), reviewPanelTabId("Notes")).map((tab) => tab.id),
			[INBOX_PANEL_TAB_ID, "proposal:goal", previewEntryTabId("a.html"), reviewPanelTabId("Notes")],
		);
		assert.deepEqual(
			reorderSidePanelTab(tabs, reviewPanelTabId("Notes"), INBOX_PANEL_TAB_ID).map((tab) => tab.id),
			[INBOX_PANEL_TAB_ID, reviewPanelTabId("Notes"), previewEntryTabId("a.html"), "proposal:goal"],
		);
		assert.deepEqual(
			reorderSidePanelTab(tabs, INBOX_PANEL_TAB_ID, 3).map((tab) => tab.id),
			[INBOX_PANEL_TAB_ID, previewEntryTabId("a.html"), "proposal:goal", reviewPanelTabId("Notes")],
		);
	});
});

describe("panel workspace preview tab compatibility", () => {
	it("distinguishes current preview tabs from historical preview tool-card tabs", () => {
		assert.equal(isLivePreviewTab(previewTab("preview")), true);
		assert.equal(isLivePreviewTab(previewTab("preview:live")), true);
		assert.equal(isLivePreviewTab(previewTab(previewEntryTabId("inline.html"))), true);
		assert.equal(isLivePreviewTab(previewTab("preview:legacy-live", { live: true })), true);
		assert.equal(isLivePreviewTab(previewTab("preview:bootstrap", { origin: "preview-events" })), true);
		assert.equal(isLivePreviewTab(previewTab(previewVersionedTabId("inline.html", 1), { type: "preview_open", toolUseId: "abc", historical: true })), false);
	});

	it("matches preview tabs by content hash, not title", () => {
		const live = previewTab(previewEntryTabId("inline.html"), { contentHash: hashA.toUpperCase() });
		const historical = previewTab(previewVersionedTabId("inline.html", 1), { type: "preview_open", toolUseId: "abc", contentHash: hashA, historical: true });
		const sameTitleDifferentContent = previewTab(previewVersionedTabId("inline.html", 2), { type: "preview_open", toolUseId: "def" });

		assert.equal(previewContentHashFromTab(live), hashA);
		assert.equal(previewTabsHaveSameContent(live, historical), true);
		assert.equal(previewTabsHaveSameContent(live, sameTitleDifferentContent), false);
	});
});
