// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected, #/goal/{id} = dashboard)
// ============================================================================

export type RouteView = "landing" | "session" | "goal" | "goal-dashboard" | "roles" | "role-edit" | "tools" | "tool-edit" | "workflows" | "workflow-edit" | "staff" | "staff-edit" | "skills" | "market" | "settings" | "search" | "walkthrough";

export type DashboardTabId = "spec" | "tasks" | "agents" | "commits" | "gates" | "plan" | "children";
export type SettingsTabId = "shortcuts" | "general" | "project" | "components" | "workflows" | "models" | "palette" | "directories" | "account" | "appearance" | "maintenance";

export interface AppRoute {
	view: RouteView;
	sessionId?: string;
	goalId?: string;
	roleName?: string;
	toolName?: string;
	workflowId?: string;
	staffId?: string;
	settingsScope?: string;
	settingsTab?: SettingsTabId;
	searchQuery?: string;
	walkthroughSessionId?: string;
	walkthroughTabId?: string;
	dashboardTab?: DashboardTabId;
	focusGateId?: string;
	focusSignalId?: string;
}

const DASHBOARD_TABS = new Set<DashboardTabId>(["spec", "tasks", "agents", "commits", "gates", "plan", "children"]);
const SETTINGS_TABS = new Set<SettingsTabId>(["shortcuts", "general", "project", "components", "workflows", "models", "palette", "directories", "account", "appearance", "maintenance"]);

export function getRouteFromHash(): AppRoute {
	const path = window.location.pathname || "";
	if (path === "/walkthrough" || path.endsWith("/walkthrough")) {
		const params = new URLSearchParams(window.location.search || "");
		return {
			view: "walkthrough",
			walkthroughSessionId: params.get("session") || undefined,
			walkthroughTabId: params.get("tab") || undefined,
		};
	}
	const hash = window.location.hash || "";
	if (hash === "#/search" || hash.startsWith("#/search?")) {
		const qIdx = hash.indexOf("?");
		const params = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx + 1)) : null;
		return { view: "search", searchQuery: params?.get("q") || undefined };
	}
	if (hash === "#/walkthrough" || hash.startsWith("#/walkthrough?")) {
		const qIdx = hash.indexOf("?");
		const params = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx + 1)) : null;
		return {
			view: "walkthrough",
			walkthroughSessionId: params?.get("session") || undefined,
			walkthroughTabId: params?.get("tab") || undefined,
		};
	}
	const sessionMatch = hash.match(/^#\/session\/([a-zA-Z0-9_-]+)$/i);
	if (sessionMatch) {
		return { view: "session", sessionId: sessionMatch[1] };
	}
	const goalMatch = hash.match(/^#\/goal\/([a-f0-9-]+)(?:\?(.*))?$/i);
	if (goalMatch) {
		const params = goalMatch[2] ? new URLSearchParams(goalMatch[2]) : null;
		const tab = params?.get("tab") || undefined;
		return {
			view: "goal-dashboard",
			goalId: goalMatch[1],
			dashboardTab: tab && DASHBOARD_TABS.has(tab as DashboardTabId) ? tab as DashboardTabId : undefined,
			focusGateId: params?.get("gate") || undefined,
			focusSignalId: params?.get("signal") || undefined,
		};
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
	if (hash === "#/market") {
		return { view: "market" };
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
	if (hash) {
		return { view: "landing" };
	}
	const pathSessionMatch = path.match(/^\/session\/([a-zA-Z0-9_-]+)$/i);
	if (pathSessionMatch) {
		return { view: "session", sessionId: pathSessionMatch[1] };
	}
	return { view: "landing" };
}

export function setGoalDashboardRoute(
	goalId: string,
	params?: { tab?: DashboardTabId; gate?: string; signal?: string },
	replace?: boolean,
	silent?: boolean,
): void {
	const query = new URLSearchParams();
	if (params?.tab) query.set("tab", params.tab);
	if (params?.gate) query.set("gate", params.gate);
	if (params?.signal) query.set("signal", params.signal);
	const suffix = query.toString();
	const newHash = `#/goal/${goalId}${suffix ? `?${suffix}` : ""}`;
	if (window.location.hash !== newHash) {
		if (replace) {
			history.replaceState({}, "", newHash);
			if (!silent) window.dispatchEvent(new HashChangeEvent("hashchange"));
		} else {
			window.location.hash = newHash;
		}
	}
}

export function canonicalizePathSessionRoute(sessionId: string): void {
	const expectedPath = `/session/${sessionId}`;
	const expectedHash = `#/session/${sessionId}`;
	if (window.location.pathname !== expectedPath || window.location.hash !== expectedHash) return;
	// replaceState avoids a hashchange while cleaning up path-style deep links.
	history.replaceState(history.state ?? {}, "", `/#/session/${sessionId}`);
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
	} else if (view === "market") {
		newHash = "#/market";
	} else if (view === "search") {
		newHash = id ? `#/search?q=${encodeURIComponent(id)}` : "#/search";
	} else if (view === "walkthrough") {
		newHash = id ? `#/walkthrough?${id}` : "#/walkthrough";
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
	"skills", "market", "settings", "staff", "staff-edit",
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

/** Returns true if the marketplace surface is the active route. */
export function isMarketActive(): boolean {
	return isRouteActive("market");
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
