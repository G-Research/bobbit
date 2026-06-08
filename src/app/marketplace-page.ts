// src/app/marketplace-page.ts
// ============================================================================
// MARKETPLACE PAGE — register sources, browse + install packs, manage installs
// See docs/design/pack-based-marketplace.md §10. Built against the documented
// REST contracts in §9/§9.1/§9.2; degrades gracefully (shows errors) so it is
// testable before the backend lands.
// ============================================================================

import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import {
	AlertTriangle,
	ArrowLeft,
	ChevronDown,
	Database,
	Download,
	GripVertical,
	Package,
	Plus,
	RotateCw,
	ShoppingCart,
	Store,
	Trash2,
} from "lucide";
import type { IconNode } from "lucide";
import { renderApp, state } from "./state.js";
import { setHashRoute } from "./routing.js";
import {
	addMarketplaceSource,
	browseMarketplacePacks,
	getPackConflicts,
	installMarketplacePack,
	listInstalledPacks,
	listMarketplaceSources,
	removeMarketplaceSource,
	setPackOrder,
	syncMarketplaceSource,
	uninstallMarketplacePack,
	updateInstalledPack,
	type BrowsePackWire,
	type ConflictWire,
	type InstalledPackWire,
	type MarketplaceSource,
	type MarketScope,
} from "./api.js";

// ============================================================================
// MODULE STATE
// ============================================================================

/** Active sub-tab on the marketplace page. */
export type MarketTab = "installed" | "browse" | "sources";
let activeTab: MarketTab = "installed";

let loading = true;
let sourcesError = "";
let sources: MarketplaceSource[] = [];

let selectedSourceId: string | null = null;
let browsePacks: BrowsePackWire[] = [];
let browseError = "";
let browseLoading = false;

let installed: InstalledPackWire[] = [];
let installedError = "";
let conflicts: ConflictWire[] = [];

let newSourceUrl = "";
let newSourceRef = "";
let addingSource = false;

/** Shared scope target for installs in the browse panel. */
let installScope: MarketScope = "server";
let installProjectId: string | undefined = undefined;

/** The project the marketplace currently operates on for the *project* scope
 *  segment. Set whenever the user picks a "Project: X" install target (or
 *  installs into one) so the Installed-list query, update, uninstall and
 *  pack-order all address the SAME project the install targeted — never the
 *  active/first project (finding #2). Defaults (when unset) to the active
 *  project, then the first registered project. */
let focusProjectId: string | undefined = undefined;

/** Per-pack busy flags keyed by `${scope}:${packName}` or `dirName`. */
const busy = new Set<string>();

/** Expanded conflict details keyed by `${scope}:${packName}`. */
const expandedConflicts = new Set<string>();

// Drag-reorder state (market packs within one scope).
let dragScope: MarketScope | null = null;
let dragFromIndex: number | null = null;
let dragOverIndex: number | null = null;

const SCOPE_ORDER: MarketScope[] = ["server", "global-user", "project"];

export function clearMarketplaceState(): void {
	activeTab = "installed";
	loading = true;
	sourcesError = "";
	sources = [];
	selectedSourceId = null;
	browsePacks = [];
	browseError = "";
	browseLoading = false;
	installed = [];
	installedError = "";
	conflicts = [];
	newSourceUrl = "";
	newSourceRef = "";
	addingSource = false;
	installScope = "server";
	installProjectId = undefined;
	focusProjectId = undefined;
	busy.clear();
	expandedConflicts.clear();
}

// ============================================================================
// DATA LOADING
// ============================================================================

function currentProjectId(): string | undefined {
	// The project the marketplace addresses for the *project* scope segment.
	// Prefer the explicitly focused project (set by the install scope picker so
	// install + Installed-list + update/uninstall never diverge — finding #2),
	// else the active project, else the first registered project.
	return focusProjectId || state.activeProjectId || state.projects[0]?.id || undefined;
}

/** The ACTIVE CHAT SESSION's project — the project the GLOBAL tool-renderer
 *  registry must follow (extension-host §4c), NOT the marketplace's focused
 *  project ({@link currentProjectId}). Mirrors what session-manager threads into
 *  `reconcilePackRenderersForProject` on session connect: the active session's
 *  own `projectId`, falling back to the active project, else undefined. Using the
 *  marketplace focus here would let a project-scope install/uninstall for a
 *  NON-active project clobber the renderers the still-active session uses. */
export function activeSessionProjectId(): string | undefined {
	const sid = state.selectedSessionId || state.remoteAgent?.gatewaySessionId;
	const session = sid ? state.gatewaySessions.find((s) => s.id === sid) : undefined;
	return session?.projectId || state.activeProjectId || undefined;
}

/** Re-drive pack-contributed tool-renderer registration after a marketplace
 *  mutation (install/update/uninstall/reorder), extension-host §4a/§4c.
 *
 *  The renderer registry is GLOBAL and must follow the ACTIVE CHAT SESSION's
 *  project ({@link activeSessionProjectId}), NOT the marketplace's focused
 *  project — else a project-scope mutation for a non-active project would clobber
 *  the renderers the still-active session uses (finding #2). We FORCE a re-fetch
 *  + re-register here (the mutation changed the pack set, so the dedupe-guarded
 *  `reconcilePackRenderersForProject` alone would skip it) but ALWAYS scope it to
 *  the active session's project, reconciling the registry back to that project.
 *  `registerPackRenderers` also tears down renderers no longer present — the
 *  uninstall reconciliation path (§4a). Best-effort; never throws. */
export async function reconcileRenderersForActiveSession(): Promise<void> {
	const [{ fetchTools }, { registerPackRenderers }] = await Promise.all([
		import("./api.js"),
		import("./pack-renderers.js"),
	]);
	const projectId = activeSessionProjectId();
	registerPackRenderers(await fetchTools(projectId), projectId);
}

export async function loadMarketplaceData(showLoading = true): Promise<void> {
	if (showLoading) {
		loading = true;
		renderApp();
	}
	const projectId = currentProjectId();

	const [srcRes, instRes, confRes] = await Promise.all([
		listMarketplaceSources(),
		listInstalledPacks(projectId),
		getPackConflicts(projectId),
	]);

	if (srcRes.ok) {
		sources = srcRes.data.sources || [];
		sourcesError = "";
		if (!selectedSourceId && sources.length > 0) selectedSourceId = sources[0].id;
	} else {
		sources = [];
		sourcesError = srcRes.error;
	}

	if (instRes.ok) {
		installed = instRes.data.installed || [];
		installedError = "";
	} else {
		installed = [];
		installedError = instRes.error;
	}

	conflicts = confRes.ok ? confRes.data.conflicts || [] : [];

	loading = false;
	renderApp();

	if (selectedSourceId) await loadBrowse(selectedSourceId);
}

async function loadBrowse(sourceId: string): Promise<void> {
	selectedSourceId = sourceId;
	browseLoading = true;
	browseError = "";
	renderApp();
	const res = await browseMarketplacePacks(sourceId);
	if (res.ok) {
		browsePacks = res.data.packs || [];
	} else {
		browsePacks = [];
		browseError = res.error;
	}
	browseLoading = false;
	renderApp();
}

/** Refresh the Roles/Tools/Skills config pages' data so installed entities
 *  appear (or disappear) with their pack origin. Best-effort. */
async function refreshConfigPages(): Promise<void> {
	await Promise.allSettled([
		import("./role-manager-page.js").then((m) => m.loadRolePageData()).catch(() => {}),
		import("./tool-manager-page.js").then((m) => m.loadToolPageData()).catch(() => {}),
		import("./skills-page.js").then((m) => m.loadSkillsPageData(false)).catch(() => {}),
		// Re-drive pack-contributed tool-renderer registration (extension-host
		// §4a/§4c) so an installed/uninstalled pack's renderer appears/updates
		// without a reload — scoped to the ACTIVE CHAT SESSION's project, not the
		// marketplace's focused project (finding #2). Idempotent + best-effort.
		reconcileRenderersForActiveSession().catch(() => {}),
	]);
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleAddSource(): Promise<void> {
	const url = newSourceUrl.trim();
	if (!url) return;
	addingSource = true;
	sourcesError = "";
	renderApp();
	const res = await addMarketplaceSource(url, newSourceRef.trim() || undefined);
	addingSource = false;
	if (res.ok) {
		newSourceUrl = "";
		newSourceRef = "";
		await loadMarketplaceData(false);
		if (res.data.source?.id) {
			activeTab = "browse";
			await loadBrowse(res.data.source.id);
		}
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleSyncSource(id: string): Promise<void> {
	const key = `sync:${id}`;
	busy.add(key);
	renderApp();
	const res = await syncMarketplaceSource(id);
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		if (selectedSourceId === id) await loadBrowse(id);
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleRemoveSource(id: string): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction("Remove source", "Remove this marketplace source and its cache? Installed packs are not affected.", "Remove", true);
	if (!ok) return;
	const res = await removeMarketplaceSource(id);
	if (res.ok) {
		if (selectedSourceId === id) {
			selectedSourceId = null;
			browsePacks = [];
		}
		await loadMarketplaceData(false);
	} else {
		sourcesError = res.error;
		renderApp();
	}
}

async function handleInstall(pack: BrowsePackWire): Promise<void> {
	const scope = installScope;
	const projectId = scope === "project" ? installProjectId : undefined;
	if (scope === "project" && !projectId) {
		browseError = "Select a project to install into the project scope.";
		renderApp();
		return;
	}
	// Bind the marketplace's project focus to the install target so the pack we
	// install appears in the Installed list and update/uninstall address the
	// same project we installed into (finding #2).
	if (scope === "project" && projectId) focusProjectId = projectId;

	const key = `install:${pack.dirName}`;
	busy.add(key);
	renderApp();
	const res = await installMarketplacePack({ sourceId: selectedSourceId!, dirName: pack.dirName, scope, projectId });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		if (selectedSourceId) await loadBrowse(selectedSourceId);
		await refreshConfigPages();
	} else {
		browseError = res.error;
		renderApp();
	}
}

async function handleUpdate(pack: InstalledPackWire): Promise<void> {
	const key = `${pack.scope}:${pack.packName}`;
	busy.add(key);
	renderApp();
	const res = await updateInstalledPack({ scope: pack.scope, packName: pack.packName, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

async function handleUninstall(pack: InstalledPackWire): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction("Uninstall pack", `Uninstall "${pack.packName}"? This deletes the pack directory and removes its entities.`, "Uninstall", true);
	if (!ok) return;
	const key = `${pack.scope}:${pack.packName}`;
	busy.add(key);
	renderApp();
	const res = await uninstallMarketplacePack({ scope: pack.scope, packName: pack.packName, projectId: pack.scope === "project" ? currentProjectId() : undefined });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

// ============================================================================
// DRAG REORDER (market packs within one scope) → PUT /api/marketplace/pack-order
// ============================================================================

function packsForScope(scope: MarketScope): InstalledPackWire[] {
	return installed.filter((p) => p.scope === scope);
}

function handleDragStart(e: DragEvent, scope: MarketScope, index: number): void {
	dragScope = scope;
	dragFromIndex = index;
	dragOverIndex = index;
	if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
	renderApp();
}

function handleDragOver(e: DragEvent, scope: MarketScope, index: number): void {
	if (dragScope !== scope || dragFromIndex === null) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	if (dragOverIndex !== index) {
		dragOverIndex = index;
		renderApp();
	}
}

async function handleDrop(scope: MarketScope): Promise<void> {
	if (dragScope !== scope || dragFromIndex === null || dragOverIndex === null) {
		resetDrag();
		return;
	}
	const scoped = packsForScope(scope).map((p) => p.packName);
	const from = dragFromIndex;
	const to = dragOverIndex;
	resetDrag();
	if (from === to) return;
	const next = [...scoped];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	await persistOrder(scope, next);
}

function resetDrag(): void {
	dragScope = null;
	dragFromIndex = null;
	dragOverIndex = null;
	renderApp();
}

/** Move a pack up/down within its scope (keyboard/click affordance that calls
 *  the same pack-order endpoint as drag). */
async function movePack(scope: MarketScope, packName: string, delta: number): Promise<void> {
	const order = packsForScope(scope).map((p) => p.packName);
	const idx = order.indexOf(packName);
	const target = idx + delta;
	if (idx < 0 || target < 0 || target >= order.length) return;
	const next = [...order];
	[next[idx], next[target]] = [next[target], next[idx]];
	await persistOrder(scope, next);
}

async function persistOrder(scope: MarketScope, order: string[]): Promise<void> {
	const res = await setPackOrder({ scope, projectId: scope === "project" ? currentProjectId() : undefined, order });
	if (res.ok) {
		await loadMarketplaceData(false);
		await refreshConfigPages();
	} else {
		installedError = res.error;
		renderApp();
	}
}

// ============================================================================
// RENDER HELPERS
// ============================================================================

function scopeLabel(scope: MarketScope): string {
	if (scope === "global-user") return "Global (user)";
	if (scope === "server") return "Server";
	return "Project";
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
				${icon(Store, "sm")}
				Marketplace
			</h1>
		</div>
	`;
}

function renderTabBar(): TemplateResult {
	const tab = (mode: MarketTab, label: string, tabIcon: IconNode, count?: number) => {
		const isActive = activeTab === mode;
		const cls = [
			"flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 transition-colors select-none whitespace-nowrap cursor-pointer",
			isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
		].join(" ");
		const badgeCls = isActive
			? "text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
			: "text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium";
		return html`
			<button
				type="button"
				data-testid="market-tab-${mode}"
				class=${cls}
				@click=${() => { activeTab = mode; renderApp(); }}
			>
				${icon(tabIcon, "xs")}
				<span>${label}</span>
				${typeof count === "number" ? html`<span class=${badgeCls}>${count}</span>` : ""}
			</button>
		`;
	};
	return html`
		<div class="flex border-b border-border shrink-0" role="tablist">
			${tab("installed", "Installed", Package, installed.length)}
			${tab("browse", "Browse", ShoppingCart)}
			${tab("sources", "Sources", Database, sources.length)}
		</div>
	`;
}

function entityChips(pack: BrowsePackWire | InstalledPackWire): TemplateResult {
	const contents = "contents" in pack ? pack.contents : (pack as InstalledPackWire).manifest.contents;
	const groups: Array<[string, string[]]> = [
		["role", contents?.roles || []],
		["tool", contents?.tools || []],
		["skill", contents?.skills || []],
	];
	const chips = groups.flatMap(([kind, names]) =>
		names.map((n) => html`<span class="market-entity-chip" data-kind=${kind}>${kind}: ${n}</span>`),
	);
	if (chips.length === 0) return html`<span class="text-[11px] text-muted-foreground italic">no declared entities</span>`;
	return html`<div class="flex flex-wrap gap-1">${chips}</div>`;
}

function renderSourcesPanel(): TemplateResult {
	return html`
		<section class="market-panel" data-testid="market-sources-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Sources</h2>
			${sourcesError ? html`<div class="market-error" data-testid="market-sources-error">${sourcesError}</div>` : ""}
			${sources.length === 0
				? html`<p class="text-sm text-muted-foreground italic">No marketplace sources registered yet.</p>`
				: html`<div class="flex flex-col gap-1.5">${sources.map(renderSourceRow)}</div>`}

			<div class="flex flex-col gap-2 mt-2 pt-3 border-t border-border">
				<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add source</div>
				<div class="market-trust-warning" data-testid="market-trust-warning">
					${icon(AlertTriangle, "xs")}
					<div class="flex flex-col gap-1.5">
						<span>Only add sources you trust. Installing any pack from a source can run code or instruct agents on your machine.</span>
						<details class="market-trust-why" data-testid="market-trust-why">
							<summary>Why?</summary>
							<div class="market-trust-why-body">
								<p data-kind="tool"><strong>Tools</strong> ship <code>extension.ts</code> / <code>_shared/</code> code that runs directly in the Bobbit server process on the host, deterministically, with no LLM and no sandbox in the loop. Highest, most immediate risk.</p>
								<p data-kind="skill"><strong>Skills</strong> are free-form instructions an agent tends to follow literally; an agent with shell access can be directed to do damage.</p>
								<p data-kind="role"><strong>Roles</strong> steer persona/behavior; influential but more diffuse. Still drives an LLM with tool access.</p>
							</div>
						</details>
					</div>
				</div>
				<input
					type="text"
					data-testid="market-source-url"
					class="market-input"
					placeholder="https://github.com/acme/bobbit-packs.git or /abs/local/path"
					.value=${newSourceUrl}
					@input=${(e: Event) => { newSourceUrl = (e.target as HTMLInputElement).value; renderApp(); }}
					@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newSourceUrl.trim()) handleAddSource(); }}
				/>
				<div class="flex items-center gap-2">
					<input
						type="text"
						data-testid="market-source-ref"
						class="market-input flex-1"
						placeholder="ref (branch/tag, optional)"
						.value=${newSourceRef}
						@input=${(e: Event) => { newSourceRef = (e.target as HTMLInputElement).value; renderApp(); }}
						@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newSourceUrl.trim()) handleAddSource(); }}
					/>
					<button
						class="market-btn market-btn--primary"
						data-testid="market-add-source"
						?disabled=${!newSourceUrl.trim() || addingSource}
						@click=${handleAddSource}
					>${icon(Plus, "xs")} ${addingSource ? "Adding…" : "Add"}</button>
				</div>
			</div>
		</section>
	`;
}

function renderSourceRow(src: MarketplaceSource): TemplateResult {
	const isSelected = selectedSourceId === src.id;
	const syncing = busy.has(`sync:${src.id}`);
	return html`
		<div class="market-source-row ${isSelected ? "market-source-row--selected" : ""}" data-testid="market-source-row">
			<button class="flex-1 min-w-0 text-left" @click=${() => { activeTab = "browse"; loadBrowse(src.id); }} title="Browse packs">
				<div class="text-sm font-medium truncate">${src.id}</div>
				<div class="text-[11px] text-muted-foreground truncate">${src.url}${src.ref ? html` <span class="opacity-70">@${src.ref}</span>` : ""}</div>
				${src.lastCommit ? html`<div class="text-[10px] text-muted-foreground/80">commit ${src.lastCommit.slice(0, 7)}</div>` : ""}
			</button>
			<button class="market-icon-btn" title="Re-sync" data-testid="market-sync-source" ?disabled=${syncing} @click=${() => handleSyncSource(src.id)}>
				${icon(RotateCw, "xs", syncing ? "animate-spin" : "")}
			</button>
			<button class="market-icon-btn market-icon-btn--danger" title="Remove source" data-testid="market-remove-source" @click=${() => handleRemoveSource(src.id)}>
				${icon(Trash2, "xs")}
			</button>
		</div>
	`;
}

function renderScopePicker(): TemplateResult {
	const projects = state.projects || [];
	return html`
		<label class="flex items-center gap-2 text-xs text-muted-foreground">
			<span>Install to</span>
			<select
				class="market-input"
				data-testid="market-install-scope"
				.value=${installScope === "project" && installProjectId ? `project:${installProjectId}` : installScope}
				@change=${(e: Event) => {
					const v = (e.target as HTMLSelectElement).value;
					if (v.startsWith("project:")) {
						installScope = "project";
						installProjectId = v.slice("project:".length);
						// Re-focus the marketplace on the chosen project and reload the
						// Installed list/conflicts for it so they match the install target.
						if (focusProjectId !== installProjectId) {
							focusProjectId = installProjectId;
							void loadMarketplaceData(false);
							return;
						}
					} else {
						installScope = v as MarketScope;
						installProjectId = undefined;
					}
					renderApp();
				}}
			>
				<option value="server">Server</option>
				<option value="global-user">Global (user)</option>
				${projects.map((p: any) => html`<option value="project:${p.id}">Project: ${p.name}</option>`)}
			</select>
		</label>
	`;
}

function renderBrowsePanel(): TemplateResult {
	return html`
		<section class="market-panel" data-testid="market-browse-panel">
			<div class="flex items-center justify-between gap-2 flex-wrap">
				<h2 class="market-panel-title">${icon(Download, "sm")} Browse${selectedSourceId ? html` <span class="text-xs font-normal text-muted-foreground">— ${selectedSourceId}</span>` : ""}</h2>
				${renderScopePicker()}
			</div>
			${!selectedSourceId
				? html`<p class="text-sm text-muted-foreground italic">Select a source to browse its packs.</p>`
				: browseLoading
					? html`<p class="text-sm text-muted-foreground">Loading packs…</p>`
					: browseError
						? html`<div class="market-error" data-testid="market-browse-error">${browseError}</div>`
						: browsePacks.length === 0
							? html`<p class="text-sm text-muted-foreground italic">This source has no packs.</p>`
							: html`<div class="flex flex-col gap-2">${browsePacks.map(renderBrowsePackCard)}</div>`}
		</section>
	`;
}

function renderBrowsePackCard(pack: BrowsePackWire): TemplateResult {
	const installing = busy.has(`install:${pack.dirName}`);
	return html`
		<div class="market-pack-card" data-testid="market-browse-pack" data-pack-name=${pack.name}>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.name}</span>
						<span class="text-[11px] text-muted-foreground">v${pack.version}</span>
					</div>
					<div class="text-xs text-muted-foreground mt-0.5">${pack.description}</div>
					<div class="mt-1.5">${entityChips(pack)}</div>
				</div>
				<button
					class="market-btn market-btn--primary shrink-0"
					data-testid="market-install-pack"
					?disabled=${installing}
					@click=${() => handleInstall(pack)}
				>${icon(Download, "xs")} ${installing ? "Installing…" : "Install"}</button>
			</div>
		</div>
	`;
}

/** A pack participates in a conflict if its market PackEntry id appears as the
 *  winner or among the shadowed entries of any conflict. */
function conflictsForPack(pack: InstalledPackWire): ConflictWire[] {
	const id = `market:${pack.scope}:${pack.packName}`;
	return conflicts.filter((c) =>
		c.winner.packEntryId === id || c.shadowed.some((s) => s.packEntryId === id),
	);
}

function renderInstalledPanel(): TemplateResult {
	const scopesWithPacks = SCOPE_ORDER.filter((s) => packsForScope(s).length > 0);
	return html`
		<section class="market-panel" data-testid="market-installed-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Installed</h2>
			${installedError ? html`<div class="market-error" data-testid="market-installed-error">${installedError}</div>` : ""}
			${scopesWithPacks.length === 0
				? html`<p class="text-sm text-muted-foreground italic">No packs installed.</p>`
				: scopesWithPacks.map(renderScopeGroup)}
		</section>
	`;
}

function renderScopeGroup(scope: MarketScope): TemplateResult {
	const packs = packsForScope(scope);
	return html`
		<div class="flex flex-col gap-1.5 mb-3" data-testid="market-scope-group" data-scope=${scope}>
			<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">${scopeLabel(scope)}</div>
			${packs.map((p, i) => renderInstalledPackCard(p, scope, i, packs.length))}
		</div>
	`;
}

function renderInstalledPackCard(pack: InstalledPackWire, scope: MarketScope, index: number, total: number): TemplateResult {
	const key = `${pack.scope}:${pack.packName}`;
	const isBusy = busy.has(key);
	const packConflicts = conflictsForPack(pack);
	const hasConflict = packConflicts.length > 0;
	const expanded = expandedConflicts.has(key);
	const isCorrupt = pack.status === "corrupt";
	const dragging = dragScope === scope && dragFromIndex === index;
	const dropTarget = dragScope === scope && dragOverIndex === index && dragFromIndex !== index;

	return html`
		<div
			class="market-pack-card ${dragging ? "opacity-50" : ""} ${dropTarget ? "market-pack-card--drop" : ""}"
			data-testid="market-installed-pack"
			data-pack-name=${pack.packName}
			data-scope=${scope}
			draggable="true"
			@dragstart=${(e: DragEvent) => handleDragStart(e, scope, index)}
			@dragover=${(e: DragEvent) => handleDragOver(e, scope, index)}
			@drop=${() => handleDrop(scope)}
			@dragend=${resetDrag}
		>
			<div class="flex items-start gap-2">
				<span class="market-grip" title="Drag to reorder (changes precedence)">${icon(GripVertical, "xs")}</span>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.packName}</span>
						<span class="text-[11px] text-muted-foreground">v${pack.meta?.version || pack.manifest?.version || "?"}</span>
						${isCorrupt ? html`<span class="market-corrupt" data-testid="market-pack-corrupt">${icon(AlertTriangle, "xs")} corrupt</span>` : ""}
						${hasConflict ? html`<button class="market-conflict-icon" data-testid="market-conflict-warning" title="Same-name conflict" @click=${() => { expanded ? expandedConflicts.delete(key) : expandedConflicts.add(key); renderApp(); }}>${icon(AlertTriangle, "xs")} conflict</button>` : ""}
					</div>
					${pack.manifest?.description ? html`<div class="text-xs text-muted-foreground mt-0.5">${pack.manifest.description}</div>` : ""}
					${renderProvenance(pack)}
					${expanded && hasConflict ? renderConflictDetails(packConflicts) : ""}
				</div>
				<div class="flex flex-col items-end gap-1 shrink-0">
					<div class="flex items-center gap-1">
						<button class="market-icon-btn" data-testid="market-move-up" title="Move up (lower precedence)" ?disabled=${index === 0} @click=${() => movePack(scope, pack.packName, -1)}>${icon(ChevronDown, "xs", "rotate-180")}</button>
						<button class="market-icon-btn" data-testid="market-move-down" title="Move down (higher precedence)" ?disabled=${index === total - 1} @click=${() => movePack(scope, pack.packName, 1)}>${icon(ChevronDown, "xs")}</button>
					</div>
					<div class="flex items-center gap-1">
						<button class="market-btn" data-testid="market-update-pack" ?disabled=${isBusy} @click=${() => handleUpdate(pack)}>${icon(RotateCw, "xs", isBusy ? "animate-spin" : "")} Update</button>
						<button class="market-btn market-btn--danger" data-testid="market-uninstall-pack" ?disabled=${isBusy} @click=${() => handleUninstall(pack)}>${icon(Trash2, "xs")} Uninstall</button>
					</div>
				</div>
			</div>
		</div>
	`;
}

function renderProvenance(pack: InstalledPackWire): TemplateResult {
	const m = pack.meta;
	if (!m) return html``;
	const installed = m.installedAt ? new Date(m.installedAt).toLocaleDateString() : "?";
	const updated = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : installed;
	return html`
		<div class="text-[10px] text-muted-foreground/90 mt-1 flex flex-wrap gap-x-3 gap-y-0.5" data-testid="market-provenance">
			<span title="Source">${m.sourceUrl}${m.sourceRef ? html`@${m.sourceRef}` : ""}</span>
			${m.commit ? html`<span title="Commit">commit ${m.commit.slice(0, 7)}</span>` : ""}
			<span title="Installed">installed ${installed}</span>
			${updated !== installed ? html`<span title="Updated">updated ${updated}</span>` : ""}
		</div>
	`;
}

function renderConflictDetails(packConflicts: ConflictWire[]): TemplateResult {
	return html`
		<div class="market-conflict-details" data-testid="market-conflict-details">
			${packConflicts.map((c) => html`
				<div class="text-[11px] py-0.5">
					<span class="font-medium">${c.type.replace(/s$/, "")}: ${c.name}</span>
					— winner <span class="market-conflict-winner">${c.winner.label}</span>
					${c.shadowed.length > 0 ? html`, shadows ${c.shadowed.map((s) => s.label).join(", ")}` : ""}
				</div>
			`)}
		</div>
	`;
}

// ============================================================================
// PAGE
// ============================================================================

export function renderMarketplacePage(): TemplateResult {
	if (loading) {
		return html`
			<div class="flex-1 flex flex-col h-full">
				${renderNavBar()}
				<div class="flex-1 flex items-center justify-center">
					<div class="text-sm text-muted-foreground">Loading marketplace…</div>
				</div>
			</div>
		`;
	}

	const panel =
		activeTab === "sources"
			? renderSourcesPanel()
			: activeTab === "browse"
				? renderBrowsePanel()
				: renderInstalledPanel();

	return html`
		<div class="flex-1 flex flex-col h-full">
			${renderNavBar()}
			${renderTabBar()}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					${panel}
				</div>
			</div>
		</div>
	`;
}
