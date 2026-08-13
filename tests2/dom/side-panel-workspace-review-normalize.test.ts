import { beforeEach, describe, expect, it } from "vitest";

import {
	applySidePanelWorkspaceFromServer,
	openSidePanelTab,
	type SidePanelWorkspaceTab,
} from "../../src/app/side-panel-workspace.js";
import { state } from "../../src/app/state.js";

const SESSION_ID = "review-normalize-session";

function workspace(tab: Record<string, unknown>, revision = 1): Record<string, unknown> {
	return workspaceWithTabs(SESSION_ID, [tab], String(tab.id), revision);
}

function workspaceWithTabs(
	sessionId: string,
	tabs: unknown[],
	activeTabId: string,
	revision = 1,
): Record<string, unknown> {
	return {
		version: 1,
		sessionId,
		revision,
		tabs,
		activeTabId,
		sizeMode: "split",
		updatedAt: revision,
	};
}

function reviewTab(sessionId: string, reviewId: string, title: string): SidePanelWorkspaceTab {
	return {
		id: `review:${encodeURIComponent(reviewId)}`,
		kind: "review",
		title: `Review: ${title}`,
		label: `Review: ${title}`,
		source: { type: "review", sessionId, reviewId, title },
		updatedAt: 1,
	};
}

beforeEach(() => {
	(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("file:///side-panel-workspace-review-normalize");
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

	it("keeps the foreground selection guard across a focused background open", async () => {
		const foregroundSession = "session-a";
		const backgroundSession = "session-b";
		const userTab = reviewTab(foregroundSession, "user-selection", "User selection");
		const olderTab = reviewTab(foregroundSession, "older-selection", "Older selection");
		state.selectedSessionId = foregroundSession;
		applySidePanelWorkspaceFromServer(
			workspaceWithTabs(foregroundSession, [userTab, olderTab], userTab.id),
			{ skipRender: true, force: true },
		);
		(state as any).__lastSidePanelUserActiveSelection = {
			sessionId: foregroundSession,
			tabId: userTab.id,
			at: Date.now(),
		};

		const backgroundTab = reviewTab(backgroundSession, "background-review", "Background review");
		await openSidePanelTab(backgroundTab, { focus: true, skipRender: true });

		expect((state as any).__lastSidePanelUserActiveSelection).toMatchObject({
			sessionId: foregroundSession,
			tabId: userTab.id,
		});
		expect(state.sidePanelWorkspaceBySession[backgroundSession]?.activeTabId).toBe(backgroundTab.id);
		expect(state.selectedSessionId).toBe(foregroundSession);

		const delayed = applySidePanelWorkspaceFromServer(
			workspaceWithTabs(foregroundSession, [userTab, olderTab], olderTab.id, 2),
			{ skipRender: true, force: true },
		);
		expect(delayed.activeTabId).toBe(userTab.id);
		expect(state.activePanelTabId).toBe(userTab.id);
	});

	it("clears the selection guard for a focused open in the same session", async () => {
		const userTab = reviewTab(SESSION_ID, "user-selection", "User selection");
		applySidePanelWorkspaceFromServer(
			workspaceWithTabs(SESSION_ID, [userTab], userTab.id),
			{ skipRender: true, force: true },
		);
		(state as any).__lastSidePanelUserActiveSelection = {
			sessionId: SESSION_ID,
			tabId: userTab.id,
			at: Date.now(),
		};

		const authoritativeTab = reviewTab(SESSION_ID, "authoritative-open", "Authoritative open");
		const opened = await openSidePanelTab(authoritativeTab, { focus: true, skipRender: true });

		expect((state as any).__lastSidePanelUserActiveSelection).toBeUndefined();
		expect(opened.activeTabId).toBe(authoritativeTab.id);
		expect(state.activePanelTabId).toBe(authoritativeTab.id);
	});
});
