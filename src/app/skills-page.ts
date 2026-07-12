// src/app/skills-page.ts
import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FolderOpen, Plus, X, Zap } from "lucide";
import { renderApp, state } from "./state.js";
import { gatewayFetch } from "./api.js";
import { setHashRoute } from "./routing.js";
import { getConfigScope, setConfigScope, getConfigApiProjectId, renderConfigScopeRow } from "./config-scope.js";
import { HEADQUARTERS_PROJECT_ID } from "./headquarters.js";

// Module-level state
let slashSkills: Array<{ name: string; description: string; source: string; filePath: string; content: string; originPackName?: string | null }> = [];
let loading = true;
let error = "";
let expandedSkill: string | null = null;
let directories: Array<{ path: string; source: string; isCustom: boolean }> = [];
let customDirs: Array<{ path: string }> = [];
let newDirPath = "";
let directoriesExpanded = false;
// True once the user explicitly picks a scope via the Skills-page scope selector.
// Until then, every load auto-follows state.activeProjectId so the page shows the
// skills the active session's composer actually resolves.
let userPickedScope = false;

export function clearSkillsPageState(): void {
	slashSkills = [];
	loading = true;
	error = "";
	expandedSkill = null;
	directories = [];
	customDirs = [];
	newDirPath = "";
	directoriesExpanded = false;
	userPickedScope = false;
}

interface ConfigDirEntry { path: string; types: string[]; }

/** config_directories may arrive as a structured array (project endpoint) or a JSON
 *  string (server-scope endpoint). Normalise to an array of {path, types}. */
function parseConfigDirectories(raw: unknown): ConfigDirEntry[] {
	let value: unknown = raw;
	if (typeof value === "string") {
		try { value = JSON.parse(value); } catch { return []; }
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((e): e is { path?: unknown; types?: unknown } => !!e && typeof e === "object")
		.map((e) => ({
			path: typeof e.path === "string" ? e.path : "",
			types: Array.isArray(e.types) ? e.types.filter((t): t is string => typeof t === "string") : [],
		}))
		.filter((e) => e.path);
}

/** Legacy `skill_directories` is a JSON-encoded string array of {path}. */
function parseLegacySkillDirs(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((e) => (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string" ? (e as { path: string }).path : ""))
			.filter((p) => p);
	} catch { return []; }
}

/** True for a config_directories entry that is exactly ["skills"] — page-managed. */
function isSkillsOnlyEntry(entry: ConfigDirEntry): boolean {
	return entry.types.length === 1 && entry.types[0] === "skills";
}

function slashSkillsDetailsUrl(): string {
	return `/api/slash-skills/details?projectId=${encodeURIComponent(getConfigApiProjectId())}`;
}

/** Config endpoint for the currently-selected scope's store — mirrors settings-page.ts::saveConfigDirs.
 *  Headquarters resolves against the server-scope store (/api/project-config); a real project uses its
 *  own project-scope store, matching where skill resolution reads `skill_directories`. */
function configEndpoint(): string {
	const pid = getConfigApiProjectId();
	return pid === HEADQUARTERS_PROJECT_ID ? "/api/project-config" : `/api/projects/${encodeURIComponent(pid)}/config`;
}

export async function loadSkillsPageData(showLoading = true): Promise<void> {
	// Follow the active project on EVERY load, so the listed skills match what that
	// project's sessions actually resolve — UNLESS the user has explicitly picked a scope
	// on this page (handleScopeChange sets userPickedScope). Re-seeding unconditionally
	// (not only when scope==="system") lets the page move from project P to a newly-active
	// project Q when the user switches sessions and reopens Skills.
	//
	// When there is no active project yet (pre-hydration on hard refresh / deep-link to
	// #/skills, before refreshSessions() populates state.activeProjectId) leave the scope
	// as-is; a later load reseeds once hydration completes.
	if (!userPickedScope) {
		const active = state.activeProjectId;
		if (active) setConfigScope(active);
	}

	if (showLoading) {
		loading = true;
		error = "";
		renderApp();
	}

	try {
		const slashRes = await gatewayFetch(slashSkillsDetailsUrl());

		if (slashRes.ok) {
			const data = await slashRes.json();
			slashSkills = data.skills || [];
			directories = data.directories || [];
		} else {
			slashSkills = [];
			directories = [];
		}

		// Load the page-managed custom skill directories from the scope-appropriate
		// config store. The Skills page manages ONLY skills-only directories — a
		// skills-only structured entry (`types` EXACTLY ["skills"]) or a legacy
		// `skill_directories` entry (inherently skills-only). Multi-type entries
		// (e.g. {path, types:["skills","mcp"]}) are EXCLUDED here so we never rewrite
		// them on save — they remain visible only in the read-only "directories"
		// list (via getSkillDirectories) and are edited via Settings.
		try {
			const configRes = await gatewayFetch(configEndpoint());
			if (configRes.ok) {
				const config = await configRes.json();
				const fromStructured = parseConfigDirectories(config.config_directories)
					.filter((e) => isSkillsOnlyEntry(e))
					.map((e) => e.path);
				const fromLegacy = parseLegacySkillDirs(config.skill_directories);
				const seen = new Set<string>();
				customDirs = [];
				for (const path of [...fromStructured, ...fromLegacy]) {
					if (seen.has(path)) continue;
					seen.add(path);
					customDirs.push({ path });
				}
			}
		} catch {
			// ignore config fetch errors
		}
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
		renderApp();
	}
}

function toggleSkill(id: string): void {
	expandedSkill = expandedSkill === id ? null : id;
	renderApp();
}

// Exported for tests: the explicit-scope-selection path (Finding 1 follow-behaviour).
export async function handleScopeChange(scope: string): Promise<void> {
	// The user explicitly chose a scope — stop auto-following the active project.
	userPickedScope = true;
	setConfigScope(scope);
	await loadSkillsPageData();
}

function renderNavBar(): TemplateResult {
	return html`
		<div class="flex items-center gap-2 px-4 py-3 border-b border-border">
			<button
				class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
				@click=${() => setHashRoute("landing")}
				title="Back"
			>${icon(ArrowLeft, "sm")}</button>
			<h1 class="text-lg font-semibold flex items-center gap-2">
				${icon(Zap, "sm")}
				Skills
			</h1>
		</div>
	`;
}

function sourceLabel(source: string): TemplateResult {
	const colors: Record<string, string> = {
		"project": "bg-blue-500/15 text-blue-700 dark:text-blue-400",
		"personal": "bg-purple-500/15 text-purple-700 dark:text-purple-400",
		"legacy": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
		"built-in": "bg-green-500/15 text-green-700 dark:text-green-400",
		"custom": "bg-teal-500/15 text-teal-700 dark:text-teal-400",
	};
	const cls = colors[source] || "bg-muted text-muted-foreground";
	return html`<span class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full ${cls}">${source}</span>`;
}

function renderSkillCard(skill: typeof slashSkills[0]): TemplateResult {
	const key = `slash-${skill.name}`;
	const isExpanded = expandedSkill === key;
	const isBuiltIn = skill.source === "built-in";
	return html`
		<div class="rounded-lg border border-border overflow-hidden">
			<button
				class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors cursor-pointer"
				@click=${() => toggleSkill(key)}
			>
				<span class="text-muted-foreground shrink-0">${icon(BookOpen, "sm")}</span>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium">/${skill.name}</span>
						${sourceLabel(skill.source)}
						${skill.originPackName ? html`<span class="config-origin-pack" data-testid="origin-pack-chip" title="From pack: ${skill.originPackName}">${skill.originPackName}</span>` : ""}
					</div>
					<div class="text-xs text-muted-foreground mt-0.5 truncate">${skill.description}</div>
				</div>
				${isBuiltIn ? "" : html`<span class="text-muted-foreground text-xs shrink-0">${isExpanded ? "▾" : "▸"}</span>`}
			</button>
			${isExpanded && !isBuiltIn ? html`
				<div class="border-t border-border px-4 py-3 bg-secondary/10">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
						${icon(FolderOpen, "xs")}
						<code class="text-[11px] break-all">${skill.filePath}</code>
					</div>
					<div class="rounded-md border border-border bg-background p-3 overflow-x-auto">
						<pre class="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">${skill.content}</pre>
					</div>
				</div>
			` : ""}
		</div>
	`;
}

async function saveCustomDirs(): Promise<void> {
	renderApp();
	try {
		// Persist page-managed skills dirs into the migrated `config_directories` (mirroring
		// settings-page.ts::saveConfigDirs), PRESERVING every existing entry that is not a
		// pure skills-only entry (mcp/tools/agents and multi-type dirs stay managed via
		// Settings). Fetch the current config first so we don't clobber those.
		let preserved: ConfigDirEntry[] = [];
		try {
			const configRes = await gatewayFetch(configEndpoint());
			if (configRes.ok) {
				const config = await configRes.json();
				preserved = parseConfigDirectories(config.config_directories).filter((e) => !isSkillsOnlyEntry(e));
			}
		} catch {
			// ignore — fall back to writing only the page-managed skills dirs
		}
		// GUARD: never emit a path both as a preserved (multi-type / non-skills)
		// entry AND as a page-managed skills-only entry — the server resolver dedups
		// by expanded path with LATER entries winning, so an appended skills-only
		// duplicate would silently downgrade a shared multi-type dir. Skip any
		// customDirs path already present in `preserved`.
		const preservedPaths = new Set(preserved.map((e) => e.path));
		const skillsEntries: ConfigDirEntry[] = customDirs
			.filter((d) => !preservedPaths.has(d.path))
			.map((d) => ({ path: d.path, types: ["skills"] }));
		const nextDirs = [...preserved, ...skillsEntries];
		await gatewayFetch(configEndpoint(), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			// Send structured array (server rejects a JSON string for the migrated field) and
			// clear the legacy key so resolution reads a single source of truth.
			body: JSON.stringify({ config_directories: nextDirs, skill_directories: null }),
		});
		// Background refresh to pick up any newly discovered skills
		const slashRes = await gatewayFetch(slashSkillsDetailsUrl());
		if (slashRes.ok) {
			const data = await slashRes.json();
			slashSkills = data.skills || [];
			directories = data.directories || [];
			renderApp();
		}
	} catch {
		// ignore save errors
	}
}

// Exported for tests (Fix A): accepts an optional explicit path; defaults to the
// pending `newDirPath` bound to the Add-row input.
export async function addCustomDir(path?: string): Promise<void> {
	const trimmed = (path ?? newDirPath).trim();
	if (!trimmed) return;
	customDirs = [...customDirs, { path: trimmed }];
	newDirPath = "";
	await saveCustomDirs();
}

async function removeCustomDir(index: number): Promise<void> {
	customDirs = customDirs.filter((_, i) => i !== index);
	await saveCustomDirs();
}

function renderDirectoriesSection(): TemplateResult {
	const defaultDirs = directories.filter((d) => !d.isCustom);

	return html`
		<div class="rounded-lg border border-border overflow-hidden">
			<button
				class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-secondary/30 transition-colors cursor-pointer"
				@click=${() => { directoriesExpanded = !directoriesExpanded; renderApp(); }}
			>
				<span class="text-muted-foreground shrink-0">${icon(directoriesExpanded ? ChevronDown : ChevronRight, "sm")}</span>
				<span class="text-muted-foreground shrink-0">${icon(FolderOpen, "sm")}</span>
				<span class="text-sm font-semibold">Skill Directories</span>
			</button>
			${directoriesExpanded ? html`
				<div class="border-t border-border px-4 py-3 flex flex-col gap-3">
					<!-- Default directories -->
					${defaultDirs.length > 0 ? html`
						<div class="flex flex-col gap-1.5">
							<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Default</div>
							${defaultDirs.map((d) => html`
								<div class="flex items-center gap-2 text-xs text-muted-foreground py-1 px-2 rounded bg-secondary/20">
									<code class="flex-1 text-[11px] break-all">${d.path}</code>
									${sourceLabel(d.source)}
								</div>
							`)}
						</div>
					` : ""}

					<!-- Custom directories -->
					<div class="flex flex-col gap-1.5">
						<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Custom</div>
						${customDirs.length > 0 ? customDirs.map((d, i) => html`
							<div class="flex items-center gap-2 text-xs py-1 px-2 rounded bg-secondary/20">
								<code class="flex-1 text-[11px] break-all">${d.path}</code>
								${sourceLabel("custom")}
								<button
									class="p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors shrink-0"
									title="Remove directory"
									@click=${() => removeCustomDir(i)}
								>${icon(X, "xs")}</button>
							</div>
						`) : html`<div class="text-xs text-muted-foreground italic">No custom directories configured.</div>`}
					</div>

					<!-- Add row -->
					<div class="flex items-center gap-2">
						<input
							type="text"
							class="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
							placeholder="~/my-skills or /absolute/path"
							.value=${newDirPath}
							@input=${(e: Event) => { newDirPath = (e.target as HTMLInputElement).value; renderApp(); }}
							@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newDirPath.trim()) addCustomDir(); }}
						/>
						<button
							class="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-border hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							?disabled=${!newDirPath.trim()}
							@click=${addCustomDir}
						>${icon(Plus, "xs")} Add</button>
					</div>

					<div class="text-[11px] text-muted-foreground">
						Default directories are always scanned. Custom directories are additive.
					</div>
				</div>
			` : ""}
		</div>
	`;
}

function renderSkillList(skills: typeof slashSkills): TemplateResult {
	if (skills.length === 0) {
		return html`<p class="text-sm text-muted-foreground italic">No skills found.</p>`;
	}
	return html`<div class="flex flex-col gap-2">${skills.map(renderSkillCard)}</div>`;
}

export function renderSkillsPage(): TemplateResult {
	if (loading) {
		return html`
			<div class="flex-1 flex flex-col h-full">
				${renderNavBar()}
				<div class="flex-1 flex items-center justify-center">
					<div class="text-sm text-muted-foreground">Loading skills…</div>
				</div>
			</div>
		`;
	}

	if (error) {
		return html`
			<div class="flex-1 flex flex-col h-full">
				${renderNavBar()}
				<div class="flex-1 flex items-center justify-center">
					<div class="text-center">
						<p class="text-sm text-red-500 mb-2">${error}</p>
						<button class="text-xs text-muted-foreground hover:text-foreground underline" @click=${loadSkillsPageData}>Retry</button>
					</div>
				</div>
			</div>
		`;
	}

	const userSkills = slashSkills.filter((s) => s.source !== "built-in");
	const builtInSkills = slashSkills.filter((s) => s.source === "built-in");
	const total = slashSkills.length;

	return html`
		<div class="flex-1 flex flex-col h-full">
			${renderNavBar()}
			${renderConfigScopeRow(getConfigScope(), handleScopeChange)}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					<div class="flex items-center justify-between">
						<div class="text-sm text-muted-foreground">
							${total} skill${total !== 1 ? "s" : ""} available
						</div>
						<button
							class="text-xs text-muted-foreground hover:text-foreground transition-colors"
							@click=${() => { setHashRoute("settings", "directories"); }}
						>Manage scan directories &rarr;</button>
					</div>

					${renderDirectoriesSection()}

					<div>
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(BookOpen, "sm")}
							Slash Skills
							<span class="text-xs font-normal text-muted-foreground">(from .claude/skills/, .bobbit/skills/, and custom directories)</span>
						</h2>
						${userSkills.length > 0
							? renderSkillList(userSkills)
							: html`<p class="text-sm text-muted-foreground italic">No custom skills found. Add SKILL.md files to <code class="text-[11px]">.claude/skills/</code> or <code class="text-[11px]">.bobbit/skills/</code> to define skills.</p>`
						}
					</div>

					${builtInSkills.length > 0 ? html`
						<div>
							<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
								${icon(Zap, "sm")}
								Built-in
							</h2>
							${renderSkillList(builtInSkills)}
						</div>
					` : ""}
				</div>
			</div>
		</div>
	`;
}
