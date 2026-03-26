// src/app/skills-page.ts
import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import { ArrowLeft, BookOpen, FolderOpen, Sparkles, Zap } from "lucide";
import { renderApp } from "./state.js";
import { gatewayFetch } from "./api.js";
import { setHashRoute } from "./routing.js";

// Module-level state
let registeredSkills: Array<{ id: string; name: string; description: string }> = [];
let slashSkills: Array<{ name: string; description: string; source: string; filePath: string; content: string }> = [];
let loading = true;
let error = "";
let expandedSkill: string | null = null;

export function clearSkillsPageState(): void {
	registeredSkills = [];
	slashSkills = [];
	loading = true;
	error = "";
	expandedSkill = null;
}

export async function loadSkillsPageData(): Promise<void> {
	loading = true;
	error = "";
	renderApp();

	try {
		const [regRes, slashRes] = await Promise.all([
			gatewayFetch("/api/skills"),
			gatewayFetch("/api/slash-skills/details"),
		]);

		if (regRes.ok) {
			const data = await regRes.json();
			registeredSkills = data.skills || [];
		} else {
			registeredSkills = [];
		}

		if (slashRes.ok) {
			const data = await slashRes.json();
			slashSkills = data.skills || [];
		} else {
			slashSkills = [];
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
	};
	const cls = colors[source] || "bg-muted text-muted-foreground";
	return html`<span class="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full ${cls}">${source}</span>`;
}

function renderRegisteredSkills(): TemplateResult {
	if (registeredSkills.length === 0) {
		return html`<p class="text-sm text-muted-foreground italic">No registered skills found.</p>`;
	}

	return html`
		<div class="flex flex-col gap-2">
			${registeredSkills.map((skill) => {
				const key = `reg-${skill.id}`;
				const isExpanded = expandedSkill === key;
				return html`
					<div class="rounded-lg border border-border overflow-hidden">
						<button
							class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors cursor-pointer"
							@click=${() => toggleSkill(key)}
						>
							<span class="text-muted-foreground shrink-0">${icon(Sparkles, "sm")}</span>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium">${skill.name}</span>
									${sourceLabel("built-in")}
								</div>
								<div class="text-xs text-muted-foreground mt-0.5 truncate">${skill.description}</div>
							</div>
							<span class="text-muted-foreground text-xs shrink-0">${isExpanded ? "▾" : "▸"}</span>
						</button>
						${isExpanded ? html`
							<div class="border-t border-border px-4 py-3 bg-secondary/10">
								<div class="text-xs text-muted-foreground mb-2">
									<span class="font-medium">ID:</span> <code class="text-[11px]">${skill.id}</code>
								</div>
								<div class="text-xs text-muted-foreground">
									<span class="font-medium">Source:</span> Server skill registry (code-defined)
								</div>
							</div>
						` : ""}
					</div>
				`;
			})}
		</div>
	`;
}

function renderSlashSkills(): TemplateResult {
	if (slashSkills.length === 0) {
		return html`<p class="text-sm text-muted-foreground italic">No slash skills found. Add SKILL.md files to <code class="text-[11px]">.claude/skills/</code> to define skills.</p>`;
	}

	return html`
		<div class="flex flex-col gap-2">
			${slashSkills.map((skill) => {
				const key = `slash-${skill.name}`;
				const isExpanded = expandedSkill === key;
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
							<span class="text-muted-foreground text-xs shrink-0">${isExpanded ? "▾" : "▸"}</span>
						</button>
						${isExpanded ? html`
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
			})}
		</div>
	`;
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

	const total = registeredSkills.length + slashSkills.length;

	return html`
		<div class="flex-1 flex flex-col h-full">
			${renderNavBar()}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					<div class="text-sm text-muted-foreground">
						${total} skill${total !== 1 ? "s" : ""} available
					</div>

					${registeredSkills.length > 0 ? html`
						<div>
							<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
								${icon(Sparkles, "sm")}
								Registered Skills
								<span class="text-xs font-normal text-muted-foreground">(built-in verification &amp; review skills)</span>
							</h2>
							${renderRegisteredSkills()}
						</div>
					` : ""}

					<div>
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(BookOpen, "sm")}
							Slash Skills
							<span class="text-xs font-normal text-muted-foreground">(from .claude/skills/ and .claude/commands/)</span>
						</h2>
						${renderSlashSkills()}
					</div>
				</div>
			</div>
		</div>
	`;
}
