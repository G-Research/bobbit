// src/app/skills-page.ts
import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FolderOpen, Plus, X, Zap } from "lucide";
import { requestRender } from "./state.js";
import { gatewayFetch } from "./api.js";
import { setHashRoute } from "./routing.js";

// Module-level state
let slashSkills: Array<{ name: string; description: string; source: string; filePath: string; content: string }> = [];
let loading = true;
let error = "";
let expandedSkill: string | null = null;
let directories: Array<{ path: string; source: string; isCustom: boolean }> = [];
let customDirs: Array<{ path: string }> = [];
let newDirPath = "";
let directoriesExpanded = false;

export function clearSkillsPageState(): void {
	slashSkills = [];
	loading = true;
	error = "";
	expandedSkill = null;
	directories = [];
	customDirs = [];
	newDirPath = "";
	directoriesExpanded = false;
}

export async function loadSkillsPageData(showLoading = true): Promise<void> {
	if (showLoading) {
		loading = true;
		error = "";
		requestRender();
	}

	try {
		const slashRes = await gatewayFetch("/api/slash-skills/details");

		if (slashRes.ok) {
			const data = await slashRes.json();
			slashSkills = data.skills || [];
			directories = data.directories || [];
		} else {
			slashSkills = [];
			directories = [];
		}

		// Load custom directories from project config
		try {
			const configRes = await gatewayFetch("/api/project-config");
			if (configRes.ok) {
				const config = await configRes.json();
				if (config.skill_directories) {
					try { customDirs = JSON.parse(config.skill_directories); } catch { customDirs = []; }
				} else {
					customDirs = [];
				}
			}
		} catch {
			// ignore config fetch errors
		}
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
		requestRender();
	}
}

function toggleSkill(id: string): void {
	expandedSkill = expandedSkill === id ? null : id;
	requestRender();
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
	requestRender();
	try {
		await gatewayFetch("/api/project-config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ skill_directories: JSON.stringify(customDirs) }),
		});
		// Background refresh to pick up any newly discovered skills
		const slashRes = await gatewayFetch("/api/slash-skills/details");
		if (slashRes.ok) {
			const data = await slashRes.json();
			slashSkills = data.skills || [];
			directories = data.directories || [];
			requestRender();
		}
	} catch {
		// ignore save errors
	}
}

async function addCustomDir(): Promise<void> {
	const trimmed = newDirPath.trim();
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
				@click=${() => { directoriesExpanded = !directoriesExpanded; requestRender(); }}
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
							@input=${(e: Event) => { newDirPath = (e.target as HTMLInputElement).value; requestRender(); }}
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
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					<div class="text-sm text-muted-foreground">
						${total} skill${total !== 1 ? "s" : ""} available
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
