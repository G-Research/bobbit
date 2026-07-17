// ============================================================================
// CONFIG SCOPE — shared project scope + origin badge helpers for config pages
// ============================================================================

import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { state } from "./state.js";
import { gatewayFetch } from "./api.js";
import { HEADQUARTERS_ACCENT_COLOR, HEADQUARTERS_HELPER_TEXT, HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, isHeadquartersProject, projectIconComponent, projectIconKind, projectIconTestId } from "./headquarters.js";

export type ConfigOrigin = "builtin" | "server" | "user" | "project";

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
export function getConfigProjectId(options?: { preserveHeadquarters?: boolean }): string | undefined {
	if (_configScope === "system") return undefined;
	if (isHeadquartersProject(_configScope) && !options?.preserveHeadquarters) return undefined;
	return _configScope;
}

/** Get an explicit projectId for APIs that require a project scope.
 *  The presentation "system" scope is backed by the Headquarters project. */
export function getConfigApiProjectId(scope = _configScope): string {
	if (!scope || scope === "system" || isHeadquartersProject(scope)) return HEADQUARTERS_PROJECT_ID;
	return scope;
}

// ============================================================================
// ORIGIN BADGE
// ============================================================================

const BADGE_CLASSES: Record<ConfigOrigin, string> = {
	builtin: "bg-muted text-muted-foreground",
	server: "config-origin-server",
	user: "config-origin-user",
	project: "config-origin-project",
};

/** Render origin badge for a config item. Returns empty string if origin is undefined (backward compat).
 *  When `originPackName` is provided (market-pack-originated entity, §5.2), an additional pack chip
 *  is rendered next to the scope badge so the entity is visibly tied to the pack it came from. */
export function renderOriginBadge(origin?: ConfigOrigin, overrides?: ConfigOrigin, originPackName?: string | null): TemplateResult | string {
	if (!origin) return "";
	const label = origin === "server" ? HEADQUARTERS_PROJECT_NAME : origin;
	const overridesLabel = overrides === "server" ? HEADQUARTERS_PROJECT_NAME : overrides;
	return html`
		<span class="inline-flex items-center gap-1 shrink-0">
			<span class="config-origin-badge ${BADGE_CLASSES[origin]}">${label}</span>
			${originPackName ? html`<span class="config-origin-pack" data-testid="origin-pack-chip" title="From pack: ${originPackName}">${originPackName}</span>` : ""}
			${overrides ? html`<span class="config-origin-overrides">overrides ${overridesLabel}</span>` : ""}
		</span>
	`;
}

/** Returns true if an item is inherited (not locally defined) in the current scope. */
export function isInherited(origin?: ConfigOrigin): boolean {
	if (!origin) return false;
	if (_configScope === "system" || isHeadquartersProject(_configScope)) return origin === "builtin";
	return origin !== "project";
}

// ============================================================================
// SCOPE ROW
// ============================================================================

/** Render the project scope row for a config page. Call `onScopeChange` when scope changes.
 *  When `excludeSystem` is true, the System tab is omitted (used by Workflows page). */
export function renderConfigScopeRow(currentScope: string, onScopeChange: (scope: string) => void, excludeSystem?: boolean): TemplateResult | string {
	const projects = (state.projects || []).filter((project: any) => excludeSystem || !isHeadquartersProject(project));
	if (excludeSystem && projects.length === 0) return "";

	return html`
		<div class="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-border overflow-x-auto" style="scrollbar-width:thin;">
			${excludeSystem ? "" : html`<button
				data-testid="config-headquarters-scope"
				class="px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5
					${currentScope === "system" || isHeadquartersProject(currentScope)
					? "bg-background text-foreground shadow-sm border border-border"
					: "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
				@click=${() => onScopeChange("system")}
			>
				<span data-testid="headquarters-icon" data-project-icon="headquarters" class="inline-flex items-center" style="color:${HEADQUARTERS_ACCENT_COLOR};">${icon(projectIconComponent("headquarters"), "xs")}</span>
				<span class="inline-flex flex-col items-start leading-tight">
					<span>${HEADQUARTERS_PROJECT_NAME}</span>
					<span class="text-[11px] text-muted-foreground">${HEADQUARTERS_HELPER_TEXT}</span>
				</span>
			</button>`}
			${projects.map((project: any) => {
				const isActive = currentScope === project.id;
				const isDark = document.documentElement.classList.contains("dark");
				const headquarters = isHeadquartersProject(project);
				const color = headquarters
					? HEADQUARTERS_ACCENT_COLOR
					: isDark
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
						${headquarters
							? html`<span data-testid=${projectIconTestId(project)} data-project-icon=${projectIconKind(project)} class="inline-flex items-center" style="color:${color};">${icon(projectIconComponent(project), "xs")}</span>`
							: html`<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color};"></span>`}
						<span class="inline-flex flex-col items-start leading-tight">
							<span>${headquarters ? HEADQUARTERS_PROJECT_NAME : project.name}</span>
							${headquarters ? html`<span class="text-[11px] text-muted-foreground">${HEADQUARTERS_HELPER_TEXT}</span>` : ""}
						</span>
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
	type: "roles" | "workflows" | "tools",
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
	type: "roles" | "workflows" | "tools",
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
	if (_configScope === "system" || isHeadquartersProject(_configScope)) return HEADQUARTERS_PROJECT_NAME;
	const project = (state.projects || []).find((p: any) => p.id === _configScope);
	return project?.name || "Project";
}
