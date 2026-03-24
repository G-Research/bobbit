// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected, #/goal/{id} = dashboard)
// ============================================================================

export type RouteView = "landing" | "session" | "goal" | "goal-dashboard" | "roles" | "role-edit" | "tools" | "tool-edit" | "workflows" | "workflow-edit" | "personalities" | "personality-edit" | "staff" | "staff-edit";

export function getRouteFromHash(): { view: RouteView; sessionId?: string; goalId?: string; roleName?: string; toolName?: string; workflowId?: string; personalityName?: string; staffId?: string } {
	const hash = window.location.hash || "";
	const sessionMatch = hash.match(/^#\/session\/([a-f0-9-]+)$/i);
	if (sessionMatch) {
		return { view: "session", sessionId: sessionMatch[1] };
	}
	const goalMatch = hash.match(/^#\/goal\/([a-f0-9-]+)$/i);
	if (goalMatch) {
		return { view: "goal-dashboard", goalId: goalMatch[1] };
	}
	const roleEditMatch = hash.match(/^#\/roles\/([a-zA-Z0-9_-]+)$/);
	if (roleEditMatch) {
		return { view: "role-edit", roleName: roleEditMatch[1] };
	}
	if (hash === "#/roles") {
		return { view: "roles" };
	}
	const toolEditMatch = hash.match(/^#\/tools\/([a-zA-Z0-9_-]+)$/);
	if (toolEditMatch) {
		return { view: "tool-edit", toolName: toolEditMatch[1] };
	}
	if (hash === "#/tools") {
		return { view: "tools" };
	}
	const workflowEditMatch = hash.match(/^#\/workflows\/([a-zA-Z0-9_-]+)$/);
	if (workflowEditMatch) {
		return { view: "workflow-edit", workflowId: workflowEditMatch[1] };
	}
	if (hash === "#/workflows") {
		return { view: "workflows" };
	}
	const staffEditMatch = hash.match(/^#\/staff\/([a-f0-9-]+)$/i);
	if (staffEditMatch) {
		return { view: "staff-edit", staffId: staffEditMatch[1] };
	}
	if (hash === "#/staff") {
		return { view: "staff" };
	}
	const personalityEditMatch = hash.match(/^#\/personalities\/([a-zA-Z0-9_-]+)$/);
	if (personalityEditMatch) {
		return { view: "personality-edit", personalityName: personalityEditMatch[1] };
	}
	if (hash === "#/personalities") {
		return { view: "personalities" };
	}
	return { view: "landing" };
}

export function setHashRoute(view: RouteView, id?: string, replace?: boolean): void {
	let newHash: string;
	if (view === "session" && id) {
		newHash = `#/session/${id}`;
	} else if (view === "goal-dashboard" && id) {
		newHash = `#/goal/${id}`;
	} else if (view === "role-edit" && id) {
		newHash = `#/roles/${id}`;
	} else if (view === "roles") {
		newHash = "#/roles";
	} else if (view === "tool-edit" && id) {
		newHash = `#/tools/${id}`;
	} else if (view === "tools") {
		newHash = "#/tools";
	} else if (view === "workflow-edit" && id) {
		newHash = `#/workflows/${id}`;
	} else if (view === "workflows") {
		newHash = "#/workflows";
	} else if (view === "staff-edit" && id) {
		newHash = `#/staff/${id}`;
	} else if (view === "staff") {
		newHash = "#/staff";
	} else if (view === "personality-edit" && id) {
		newHash = `#/personalities/${id}`;
	} else if (view === "personalities") {
		newHash = "#/personalities";
	} else {
		newHash = "#/";
	}
	if (window.location.hash !== newHash) {
		if (replace) {
			history.replaceState({}, "", newHash);
			// Manually dispatch hashchange since replaceState doesn't trigger it
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		} else {
			window.location.hash = newHash;
		}
	}
}

// ============================================================================
// PER-SESSION MODEL PERSISTENCE
// ============================================================================

export function saveSessionModel(sessionId: string, provider: string, modelId: string): void {
	localStorage.setItem(`session.${sessionId}.model`, JSON.stringify({ provider, modelId }));
}

export function loadSessionModel(sessionId: string): { provider: string; modelId: string } | null {
	const raw = localStorage.getItem(`session.${sessionId}.model`);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.provider && parsed.modelId) return parsed;
	} catch {}
	return null;
}

export function clearSessionModel(sessionId: string): void {
	localStorage.removeItem(`session.${sessionId}.model`);
}
