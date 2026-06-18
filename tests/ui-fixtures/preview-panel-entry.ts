import "./dynamic-panel-workspace-fixture-entry.js";
import { selectHtmlPreviewTab } from "../../src/app/preview-panel.js";
import { renderApp, state } from "../../src/app/state.js";

(window as any).__previewPanelSimulatePreviewChanged = (entry: string, contentHash: string, sessionId = "dynamic-workspace-session-a") => {
	state.selectedSessionId = sessionId;
	state.isPreviewSession = true;
	state.previewPanelEntry = entry;
	state.previewPanelMtime = Date.now();
	(state as any).previewPanelContentHash = contentHash;
	selectHtmlPreviewTab({
		sessionId,
		entry,
		mtime: state.previewPanelMtime,
		contentHash,
		source: { live: true, origin: "preview-events" },
		select: true,
	});
	renderApp();
};
