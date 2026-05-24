import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	LIVE_PREVIEW_PANEL_TAB_ID,
	activePanelTabIdForSession,
	buildPanelWorkspaceTabs,
	findPanelTab,
	isLivePreviewTab,
	previewContentHashFromTab,
	previewEntryTabId,
	previewTabsHaveSameContent,
	type PanelWorkspaceTab,
} from "../src/app/panel-workspace.ts";

function previewTab(id: string, source: Record<string, unknown> = {}): PanelWorkspaceTab {
	return {
		id,
		kind: "preview",
		title: "inline.html",
		label: "inline.html",
		legacyTab: "preview",
		source: { type: "html-preview", entry: "inline.html", ...source } as any,
	};
}

describe("panel workspace preview tab compatibility", () => {
	it("treats the legacy preview tab id as the live preview tab", () => {
		const tabs = buildPanelWorkspaceTabs({
			sessionId: "s1",
			isPreviewSession: true,
			previewEntry: "inline.html",
			activeProposalTypes: [],
			assistantProposalType: null,
			reviewTitles: [],
			reviewPanelOpen: false,
			inboxPanelOpen: false,
			inboxHasPending: false,
		});

		assert.equal(findPanelTab(tabs, "preview")?.id, previewEntryTabId("inline.html"));
	});

	it("normalizes persisted active legacy preview selections", () => {
		const state = {
			selectedSessionId: "s1",
			panelTabsBySession: { s1: [previewTab(LIVE_PREVIEW_PANEL_TAB_ID)] },
			panelWorkspaceActiveBySession: { s1: "preview" },
		};

		assert.equal(activePanelTabIdForSession(state, "s1"), LIVE_PREVIEW_PANEL_TAB_ID);
	});

	it("distinguishes live preview tabs from historical preview tool-card tabs", () => {
		assert.equal(isLivePreviewTab(previewTab("preview")), true);
		assert.equal(isLivePreviewTab(previewTab("preview:live")), true);
		assert.equal(isLivePreviewTab(previewTab("preview:legacy-live", { live: true })), true);
		assert.equal(isLivePreviewTab(previewTab("preview:bootstrap", { origin: "preview-events" })), true);
		assert.equal(isLivePreviewTab(previewTab("preview:tool:abc:1", { type: "preview_open", toolUseId: "abc" })), false);
	});

	it("matches preview tabs by content hash, not title", () => {
		const hash = "a".repeat(64);
		const live = previewTab(LIVE_PREVIEW_PANEL_TAB_ID, { contentHash: hash.toUpperCase() });
		const historical = previewTab("preview:tool:abc:1", { type: "preview_open", toolUseId: "abc", contentHash: hash });
		const sameTitleDifferentContent = previewTab("preview:tool:def:1", { type: "preview_open", toolUseId: "def" });

		assert.equal(previewContentHashFromTab(live), hash);
		assert.equal(previewTabsHaveSameContent(live, historical), true);
		assert.equal(previewTabsHaveSameContent(live, sameTitleDifferentContent), false);
	});
});
