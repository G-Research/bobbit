// ============================================================================
// CONFIG SCOPE — shared project scope + origin badge helpers for config pages
// ============================================================================

import { html, type TemplateResult } from "lit";
import { state } from "./state.js";
import { gatewayFetch } from "./api.js";

export type ConfigOrigin = "builtin" | "server" | "project";

// ============================================================================
// SCOPE STATE
// ============================================================================

/** Current config scope — "system" or a project ID. Shared across all config pages. */
let _configScope = "system";

export function getConfigScope(): string {
	return _configScope;
}

export function setConfigScope(scope: string): void {
	_configScope = scope;
}

/** Get the projectId query param for API calls, or undefined for system scope. */
export function getConfigProjectId(): string | undefined {
	return _configScope === "system" ? undefined : _configScope;
}

// ============================================================================
// ORIGIN BADGE
// ============================================================================

const BADGE_CLASSES: Record<ConfigOrigin, string> = {
	builtin: "bg-muted text-muted-foreground",
	server: "config-origin-server",
	project: "config-origin-project",
};

/** Render origin badge for a config item. Returns empty string if origin is undefined (backward compat). */
export function renderOriginBadge(origin?: ConfigOrigin, overrides?: ConfigOrigin): TemplateResult | string {
	if (!origin) return "";
	return html`
		<span class="inline-flex items-center gap-1 shrink-0">
			<span class="config-origin-badge ${BADGE_CLASSES[origin]}">${origin}</span>
			${overrides ? html`<span class="config-origin-overrides">overrides ${overrides}</span>` : ""}
		</span>
	`;
}

/** Returns true if an item is inherited (not locally defined) in the current scope. */
export function isInherited(origin?: ConfigOrigin): boolean {
	if (!origin) return false;
	if (_configScope === "system") return origin === "builtin";
	return origin !== "project";
}

// ============================================================================
// SCOPE ROW
// ============================================================================

/** Render the project scope row for a config page. Call `onScopeChange` when scope changes. */
export function renderConfigScopeRow(currentScope: string, onScopeChange: (scope: string) => void): TemplateResult | string {
	const projects = state.projects || [];
	if (projects.length === 0) return "";

	return html`
		<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto" style="scrollbar-width:thin;">
			<button
				class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0
					${currentScope === "system"
					? "bg-background text-foreground shadow-sm border border-border"
					: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
				@click=${() => onScopeChange("system")}
			>System</button>
			${projects.map((project: any) => {
				const isActive = currentScope === project.id;
				const isDark = document.documentElement.classList.contains("dark");
				const color = isDark
					? (project.colorDark || project.color || "var(--muted-foreground)")
					: (project.colorLight || project.color || "var(--muted-foreground)");
				return html`
					<button
						class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5
							${isActive
							? "bg-background text-foreground shadow-sm border border-border"
							: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
						@click=${() => onScopeChange(project.id)}
					>
						<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color};"></span>
						${project.name}
					</button>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// CUSTOMIZE / REVERT API HELPERS
// ============================================================================

/** Copy a config item to a target scope for editing. */
export async function customizeItem(
	type: "roles" | "personalities" | "workflows",
	name: string,
	scope: "server" | "project",
	projectId?: string,
): Promise<boolean> {
	try {
		const params = new URLSearchParams({ scope });
		if (projectId) params.set("projectId", projectId);
		const res = await gatewayFetch(`/api/${type}/${encodeURIComponent(name)}/customize?${params}`, { method: "POST" });
		return res.ok;
	} catch {
		return false;
	}
}

/** Remove an override at a specific scope, reverting to inherited. */
export async function revertOverride(
	type: "roles" | "personalities" | "workflows",
	name: string,
	scope: "server" | "project",
	projectId?: string,
): Promise<boolean> {
	try {
		const params = new URLSearchParams({ scope });
		if (projectId) params.set("projectId", projectId);
		const res = await gatewayFetch(`/api/${type}/${encodeURIComponent(name)}/override?${params}`, { method: "DELETE" });
		return res.ok;
	} catch {
		return false;
	}
}

/** Get the display name for the current project scope (for button labels). */
export function getCurrentProjectName(): string {
	if (_configScope === "system") return "";
	const project = (state.projects || []).find((p: any) => p.id === _configScope);
	return project?.name || "Project";
}
