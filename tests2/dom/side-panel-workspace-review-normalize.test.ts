import { beforeEach, describe, expect, it } from "vitest";

import { applySidePanelWorkspaceFromServer } from "../../src/app/side-panel-workspace.js";
import { state } from "../../src/app/state.js";

const SESSION_ID = "review-normalize-session";

function workspace(tab: Record<string, unknown>, revision = 1): Record<string, unknown> {
	return {
		version: 1,
		sessionId: SESSION_ID,
		revision,
		tabs: [tab],
		activeTabId: tab.id,
		sizeMode: "split",
		updatedAt: revision,
	};
}

beforeEach(() => {
	state.sidePanelWorkspaceBySession = {};
	state.lastWorkspaceRevisionBySession = {};
	state.panelTabsBySession = {};
	state.panelWorkspaceActiveBySession = {};
	state.panelTabs = [];
	state.selectedSessionId = SESSION_ID;
	state.remoteAgent = null;
	delete (state as any).__lastSidePanelUserActiveSelection;
});

describe("client review workspace normalization", () => {
	it("retains the server canonical reviewId tab as one review primary", () => {
		const reviewId = "review/group 1";
		const normalized = applySidePanelWorkspaceFromServer(workspace({
			id: "review:review%2Fgroup%201",
			kind: "review",
			title: "Review: Architecture",
			label: "Review: Architecture",
			source: {
				type: "review",
				sessionId: SESSION_ID,
				reviewId,
				title: "Architecture",
			},
			state: {
				files: [
					{ fileId: "api", title: "api.md" },
					{ fileId: "ui", title: "ui.md" },
				],
			},
			updatedAt: 1,
		}), { skipRender: true, force: true });

		expect(normalized.tabs).toHaveLength(1);
		expect(normalized.tabs[0]).toMatchObject({
			id: "review:review%2Fgroup%201",
			kind: "review",
			source: {
				type: "review",
				sessionId: SESSION_ID,
				reviewId,
				title: "Architecture",
			},
		});
		expect((normalized.tabs[0].source as Record<string, unknown>).documentId).toBeUndefined();
		expect(normalized.activeTabId).toBe("review:review%2Fgroup%201");
		expect(state.panelTabsBySession[SESSION_ID]).toHaveLength(1);
	});

	it("migrates a legacy documentId source to canonical reviewId identity", () => {
		const normalized = applySidePanelWorkspaceFromServer(workspace({
			id: "review:old-title-route",
			kind: "review",
			title: "Review: Legacy notes",
			label: "Review: Legacy notes",
			source: {
				type: "review",
				sessionId: SESSION_ID,
				documentId: "review-doc:legacy-1",
				title: "Legacy notes",
			},
			updatedAt: 1,
		}), { skipRender: true, force: true });

		expect(normalized.tabs).toHaveLength(1);
		expect(normalized.tabs[0]).toMatchObject({
			id: "review:review-doc%3Alegacy-1",
			kind: "review",
			source: {
				type: "review",
				sessionId: SESSION_ID,
				reviewId: "review-doc:legacy-1",
				title: "Legacy notes",
			},
		});
		expect((normalized.tabs[0].source as Record<string, unknown>).documentId).toBeUndefined();
		expect(normalized.activeTabId).toBe("review:review-doc%3Alegacy-1");
	});

	it("drops a canonical review source whose route identity disagrees", () => {
		const normalized = applySidePanelWorkspaceFromServer(workspace({
			id: "review:route-review",
			kind: "review",
			title: "Review: Mismatch",
			label: "Review: Mismatch",
			source: {
				type: "review",
				sessionId: SESSION_ID,
				reviewId: "different-review",
				title: "Mismatch",
			},
			updatedAt: 1,
		}), { skipRender: true, force: true });

		expect(normalized.tabs).toEqual([]);
		expect(normalized.activeTabId).toBe("");
	});
});
