// Skills-page deep-link project derivation (Fix B).
//
// On a cold `#/skills` deep-link, refreshSessions()→setProjects() defaults
// state.activeProjectId to the FIRST project when unset, which need not be the
// project of the session the user was last in. Re-derive the active project
// from the last-connected session persisted in localStorage so the Skills page
// reflects the project the user was actually working in after a hard refresh.
//
// Must be called AFTER refreshSessions() (which populates gatewaySessions) and
// BEFORE loadSkillsPageData() (which seeds its scope from state.activeProjectId).
// Extracted from main.ts (whose top-level initApp() makes it un-importable in a
// unit test) so the derivation is exercisable in isolation.
import { state, GW_SESSION_KEY } from "./state.js";

export function restoreActiveProjectFromLastSession(): void {
	try {
		const lastSessionId = localStorage.getItem(GW_SESSION_KEY);
		if (lastSessionId) {
			const s = state.gatewaySessions.find((x) => x.id === lastSessionId);
			if (s?.projectId) state.activeProjectId = s.projectId;
		}
	} catch { /* non-fatal */ }
}
