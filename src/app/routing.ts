// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected, #/goal/{id} = dashboard)
// ============================================================================

export type RouteView = "landing" | "session" | "goal" | "goal-dashboard" | "roles" | "role-edit" | "tools" | "tool-edit" | "workflows" | "workflow-edit" | "personalities" | "personality-edit" | "staff" | "staff-edit" | "skills" | "settings" | "search";

export type SettingsTabId = "shortcuts" | "general" | "project" | "models" | "palette" | "directories" | "account" | "appearance";

const SETTINGS_TABS = new Set<SettingsTabId>(["shortcuts", "general", "project", "models", "palette", "directories", "account", "appearance"]);

export function getRouteFromHash(): { view: RouteView; sessionId?: string; goalId?: string; roleName?: string; toolName?: string; workflowId?: string; personalityName?: string; staffId?: string; settingsScope?: string; settingsTab?: SettingsTabId; searchQuery?: string } {
	const hash = window.location.hash || "";
	if (hash === "#/search" || hash.startsWith("#/search?")) {
		const qIdx = hash.indexOf("?");
		const params = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx + 1)) : null;
		return { view: "search", searchQuery: params?.get("q") || undefined };
	}
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
	if (hash === "#/skills") {
		return { view: "skills" };
	}
	const personalityEditMatch = hash.match(/^#\/personalities\/([a-zA-Z0-9_-]+)$/);
	if (personalityEditMatch) {
		return { view: "personality-edit", personalityName: personalityEditMatch[1] };
	}
	if (hash === "#/personalities") {
		return { view: "personalities" };
	}
	const settingsMatch = hash.match(/^#\/settings(?:\/([a-z0-9-]+))?(?:\/([a-z]+))?$/);
	if (settingsMatch) {
		const first = settingsMatch[1] as string | undefined;
		const second = settingsMatch[2] as string | undefined;
		if (!first) {
			// #/settings — no scope, no tab
			return { view: "settings" };
		}
		if (!second && SETTINGS_TABS.has(first as SettingsTabId)) {
			// #/settings/shortcuts — backwards compat: known tab, treat as system scope
			return { view: "settings", settingsScope: "system", settingsTab: first as SettingsTabId };
		}
		// #/settings/<scope>/<tab> or #/settings/<scope>
		const tab = second as SettingsTabId | undefined;
		return { view: "settings", settingsScope: first, settingsTab: tab && SETTINGS_TABS.has(tab) ? tab : undefined };
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
	} else if (view === "skills") {
		newHash = "#/skills";
	} else if (view === "personality-edit" && id) {
		newHash = `#/personalities/${id}`;
	} else if (view === "personalities") {
		newHash = "#/personalities";
	} else if (view === "search") {
		newHash = id ? `#/search?q=${encodeURIComponent(id)}` : "#/search";
	} else if (view === "settings") {
		if (id) {
			// Compound id like "system/models" or "<uuid>/project" → emit as-is
			// Single segment like "shortcuts" → emit as #/settings/<tab> (backwards compat)
			newHash = `#/settings/${id}`;
		} else {
			newHash = "#/settings";
		}
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
// CONFIG PAGE HELPERS
// ============================================================================

/** Config page route views (not landing, session, or goal-dashboard). */
const CONFIG_VIEWS: Set<RouteView> = new Set([
	"roles", "role-edit", "tools", "tool-edit", "workflows", "workflow-edit",
	"personalities", "personality-edit", "skills", "settings", "staff", "staff-edit",
	"search",
]);

/** Returns true if the current hash route is a config page (not a session or landing). */
export function isConfigPageRoute(): boolean {
	return CONFIG_VIEWS.has(getRouteFromHash().view);
}

/** Check if the current route view matches any of the given view names. */
export function isRouteActive(...views: RouteView[]): boolean {
	const current = getRouteFromHash().view;
	return views.some(v => v === current);
}

/** Shared previous-hash for all config page toggle buttons. */
let _configPreviousHash: string | null = null;

/**
 * Toggle a config page. If already on a matching route, navigate back.
 * Otherwise save current hash and call navigateFn.
 */
export function toggleConfigPage(activeViews: RouteView[], navigateFn: () => void): void {
	const current = getRouteFromHash().view;
	if (activeViews.some(v => v === current)) {
		const hash = _configPreviousHash || "#/";
		_configPreviousHash = null;
		if (window.location.hash !== hash) {
			history.replaceState({}, "", hash);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		}
	} else {
		_configPreviousHash = window.location.hash || "#/";
		navigateFn();
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
