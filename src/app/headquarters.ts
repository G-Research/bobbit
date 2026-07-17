import { FolderOpen, TowerControl } from "lucide";

export const HEADQUARTERS_PROJECT_ID = "headquarters";
export const HEADQUARTERS_PROJECT_NAME = "Headquarters";
export const HEADQUARTERS_PROJECT_KIND = "headquarters";
export const HEADQUARTERS_HELPER_TEXT = "Server workspace";
/** Theme-aware Headquarters accent: primarily foreground, softened slightly to avoid excessive contrast. */
export const HEADQUARTERS_ACCENT_COLOR = "color-mix(in oklch, var(--foreground) 75%, var(--muted-foreground))";
export const SHOW_HEADQUARTERS_IN_PROJECT_LISTS_PREF = "showHeadquartersInProjectLists";

export type ProjectKind = "normal" | "headquarters" | "system";

export interface ProjectIdentity {
	id?: string;
	kind?: string;
	name?: string;
	rootPath?: string;
}

export function isHeadquartersProject(projectOrId?: ProjectIdentity | string | null): boolean {
	if (!projectOrId) return false;
	if (typeof projectOrId === "string") return projectOrId === HEADQUARTERS_PROJECT_ID;
	return projectOrId.id === HEADQUARTERS_PROJECT_ID || projectOrId.kind === HEADQUARTERS_PROJECT_KIND;
}

export function projectDisplayName(project?: ProjectIdentity | null): string {
	return isHeadquartersProject(project) ? HEADQUARTERS_PROJECT_NAME : (project?.name || "Project");
}

export function projectIconComponent(project?: ProjectIdentity | string | null): typeof FolderOpen {
	return isHeadquartersProject(project) ? TowerControl : FolderOpen;
}

export function projectIconKind(project?: ProjectIdentity | string | null): "headquarters" | "normal" {
	return isHeadquartersProject(project) ? "headquarters" : "normal";
}

export function projectIconTestId(project?: ProjectIdentity | string | null): "headquarters-icon" | "project-folder-icon" {
	return isHeadquartersProject(project) ? "headquarters-icon" : "project-folder-icon";
}

export function defaultCwdForProjectSession(project?: ProjectIdentity | null): string | undefined {
	if (!project || isHeadquartersProject(project)) return undefined;
	return project.rootPath || undefined;
}

export function projectSearchText(project: ProjectIdentity): string {
	const base = `${project.name || ""} ${project.id || ""}`;
	return isHeadquartersProject(project) ? `${base} server workspace headquarters` : base;
}
