import { closeSidePanelTab, openSidePanelTab, type SidePanelWorkspaceTab } from "./side-panel-workspace.js";

export function closeProposalWorkspaceTab(id: string, sessionId: string) {
	return closeSidePanelTab(id, { sessionId });
}

export function openProposalWorkspaceTab(tab: SidePanelWorkspaceTab) {
	return openSidePanelTab(tab, { focus: true });
}
