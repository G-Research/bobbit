// ============================================================================
// MARKET PAGE — Extension Pack marketplace (browse / install / update / uninstall)
//
// Implements the UI described in docs/design/marketplace-mvp.md §5 / §6 / §9 /
// §10.3-§10.4. The page reuses the shared config-scope model (System vs a
// project) so installed roles/tools/skills resolve through ConfigCascade /
// skill-discovery exactly like hand-authored config — same scope tabs.
//
// CSS lives in market-page.css, eagerly imported from main.ts so the lazy page
// chunk always renders styled.
// ============================================================================

import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, nothing, type TemplateResult } from "lit";
import {
	AlertCircle,
	AlertTriangle,
	ArrowLeft,
	Check,
	Download,
	FolderOpen,
	GitBranch,
	Package,
	Plus,
	RefreshCw,
	Trash2,
	Users,
	Wrench,
	Zap,
} from "lucide";
import {
	fetchMarketSources,
	fetchMarketPacks,
	fetchMarketPack,
	removeMarketSource,
	syncMarketSource,
	installPack,
	updatePack,
	uninstallPack,
	type MarketSource,
	type MarketPack,
	type MarketPackDetail,
	type MarketPackEntity,
	type MarketScope,
	type MarketInstallStatus,
} from "./api.js";
import { renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { getConfigScope, setConfigScope, getConfigProjectId, getCurrentProjectName, renderConfigScopeRow } from "./config-scope.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "pack";

let currentView: View = "list";
let sources: MarketSource[] = [];
let packs: MarketPack[] = [];
let selectedPack: MarketPackDetail | null = null;
let selectedSourceId = "";
let selectedPackId = "";
let loading = true;
let loadingPack = false;
// Per-source / per-pack busy flags keyed by id so spinners stay scoped.
let syncingSourceId: string | null = null;
let busyPackKey: string | null = null;

function packKey(sourceId: string, packId: string): string {
	return `${sourceId}::${packId}`;
}

function currentScope(): MarketScope {
	return getConfigScope() === "system" ? "system" : "project";
}

function scopeLabel(): string {
	return currentScope() === "system" ? "System" : (getCurrentProjectName() || "Project");
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function refreshPacks(): Promise<void> {
	packs = await fetchMarketPacks(currentScope(), getConfigProjectId());
}

async function refreshSelectedPack(): Promise<void> {
	if (!selectedSourceId || !selectedPackId) return;
	selectedPack = await fetchMarketPack(selectedSourceId, selectedPackId, currentScope(), getConfigProjectId());
}

export async function loadMarketPageData(): Promise<void> {
	currentView = "list";
	selectedPack = null;
	selectedSourceId = "";
	selectedPackId = "";
	loading = true;
	syncingSourceId = null;
	busyPackKey = null;
	renderApp();
	sources = await fetchMarketSources();
	await refreshPacks();
	loading = false;
	renderApp();
}

export function clearMarketPageState(): void {
	currentView = "list";
	selectedPack = null;
	sources = [];
	packs = [];
	loading = true;
}

/** Deep-link entry: ensure list data is present, then open a pack drill-down. */
export async function navigateToMarketPack(sourceId: string, packId: string): Promise<void> {
	selectedSourceId = sourceId;
	selectedPackId = packId;
	currentView = "pack";
	loadingPack = true;
	renderApp();
	if (sources.length === 0) sources = await fetchMarketSources();
	if (packs.length === 0) await refreshPacks();
	await refreshSelectedPack();
	loadingPack = false;
	renderApp();
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedPack = null;
	selectedSourceId = "";
	selectedPackId = "";
	setHashRoute("market");
}

async function showPack(pack: MarketPack): Promise<void> {
	currentView = "pack";
	selectedSourceId = pack.sourceId;
	selectedPackId = pack.packId;
	selectedPack = null;
	loadingPack = true;
	setHashRoute("market-pack", `${pack.sourceId}/${pack.packId}`);
	renderApp();
	await refreshSelectedPack();
	loadingPack = false;
	renderApp();
}

async function handleScopeChange(scope: string): Promise<void> {
	setConfigScope(scope);
	loading = true;
	renderApp();
	await refreshPacks();
	if (currentView === "pack") await refreshSelectedPack();
	loading = false;
	renderApp();
}

// ============================================================================
// SOURCE ACTIONS
// ============================================================================

async function handleAddSource(): Promise<void> {
	const { openAddSourceDialog } = await import("./market-source-dialog.js");
	const added = await openAddSourceDialog();
	if (!added) return;
	loading = true;
	renderApp();
	sources = await fetchMarketSources();
	await refreshPacks();
	loading = false;
	renderApp();
}

async function handleSyncSource(source: MarketSource): Promise<void> {
	syncingSourceId = source.id;
	renderApp();
	const result = await syncMarketSource(source.id);
	syncingSourceId = null;
	sources = await fetchMarketSources();
	await refreshPacks();
	if (currentView === "pack") await refreshSelectedPack();
	if (!result.ok) {
		const { showConnectionError } = await import("./dialogs.js");
		showConnectionError("Failed to sync source", result.error || "Unknown error");
	}
	renderApp();
}

async function handleRemoveSource(source: MarketSource): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction(
		"Remove source",
		`Remove "${sourceDisplayName(source)}" from the marketplace? Installed packs are independent copies and stay installed.`,
		"Remove",
		true,
	);
	if (!ok) return;
	const removed = await removeMarketSource(source.id);
	if (removed) {
		sources = await fetchMarketSources();
		await refreshPacks();
		renderApp();
	}
}

// ============================================================================
// INSTALL / UPDATE / UNINSTALL
// ============================================================================

const EXEC_CODE_WARNING =
	"This pack installs executable code (tools) that runs with your agent's privileges. " +
	"Bobbit does not sandbox or verify pack code. Only install packs from sources you trust.";

function entitiesCarryCode(entities: { type: string }[]): boolean {
	return entities.some((e) => e.type === "tool");
}

async function handleInstall(pack: MarketPack, entities?: MarketPackEntity[]): Promise<void> {
	const toInstall = entities ?? pack.entities;
	if (entitiesCarryCode(toInstall)) {
		const { confirmAction } = await import("./dialogs.js");
		const ok = await confirmAction("Install executable code", EXEC_CODE_WARNING, "Install", false);
		if (!ok) return;
	}
	await doInstall(pack, entities);
}

async function doInstall(pack: MarketPack, entities?: MarketPackEntity[], conflict?: "fail" | "overwrite" | "skip"): Promise<void> {
	busyPackKey = packKey(pack.sourceId, pack.packId);
	renderApp();
	const result = await installPack({
		sourceId: pack.sourceId,
		packId: pack.packId,
		scope: currentScope(),
		projectId: getConfigProjectId(),
		entities: entities ? entities.map((e) => ({ type: e.type, name: e.name })) : undefined,
		conflict,
	});
	busyPackKey = null;

	if (!result.ok && result.status === 409) {
		renderApp();
		const conflicting = Array.isArray(result.data?.conflicts)
			? result.data.conflicts.map((c: any) => c.name).join(", ")
			: "";
		const { confirmAction } = await import("./dialogs.js");
		const overwrite = await confirmAction(
			"Already installed at this scope",
			`Some entities already exist at ${scopeLabel()} scope${conflicting ? ` (${conflicting})` : ""}. Overwrite them?`,
			"Overwrite",
			true,
		);
		if (overwrite) await doInstall(pack, entities, "overwrite");
		return;
	}

	if (result.ok) {
		await reloadAfterChange();
	} else {
		const { showConnectionError } = await import("./dialogs.js");
		showConnectionError("Failed to install pack", result.error || "Unknown error");
		renderApp();
	}
}

async function handleUpdate(pack: MarketPack): Promise<void> {
	busyPackKey = packKey(pack.sourceId, pack.packId);
	renderApp();
	const result = await updatePack({
		sourceId: pack.sourceId,
		packId: pack.packId,
		scope: currentScope(),
		projectId: getConfigProjectId(),
	});
	busyPackKey = null;
	if (result.ok) {
		await reloadAfterChange();
	} else {
		const { showConnectionError } = await import("./dialogs.js");
		showConnectionError("Failed to update pack", result.error || "Unknown error");
		renderApp();
	}
}

async function handleUninstall(pack: MarketPack): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const ok = await confirmAction(
		"Uninstall pack",
		`Uninstall "${pack.name}" from ${scopeLabel()} scope? This removes exactly the entities it installed.`,
		"Uninstall",
		true,
	);
	if (!ok) return;
	busyPackKey = packKey(pack.sourceId, pack.packId);
	renderApp();
	const result = await uninstallPack({
		sourceId: pack.sourceId,
		packId: pack.packId,
		scope: currentScope(),
		projectId: getConfigProjectId(),
	});
	busyPackKey = null;
	if (result.ok) {
		await reloadAfterChange();
	} else {
		const { showConnectionError } = await import("./dialogs.js");
		showConnectionError("Failed to uninstall pack", result.error || "Unknown error");
		renderApp();
	}
}

async function reloadAfterChange(): Promise<void> {
	await refreshPacks();
	if (currentView === "pack") await refreshSelectedPack();
	renderApp();
}

// ============================================================================
// HELPERS
// ============================================================================

function sourceDisplayName(source: MarketSource): string {
	if (source.label) return source.label;
	if (source.kind === "git" && source.url) {
		const m = source.url.replace(/\.git$/, "").split("/").filter(Boolean);
		return m[m.length - 1] || source.url;
	}
	if (source.kind === "local" && source.path) {
		const parts = source.path.replace(/[\\/]+$/, "").split(/[\\/]/);
		return parts[parts.length - 1] || source.path;
	}
	return source.id;
}

function entityIcon(type: string): typeof Users {
	switch (type) {
		case "role": return Users;
		case "tool": return Wrench;
		case "skill": return Zap;
		default: return Package;
	}
}

const STATUS_LABELS: Record<MarketInstallStatus, string> = {
	"not-installed": "Not installed",
	installed: "Installed",
	"update-available": "Update available",
	drifted: "Modified locally",
};

function renderStatusBadge(status: MarketInstallStatus): TemplateResult {
	return html`<span class="market-status-badge market-status-${status}" data-testid="market-install-status" data-status="${status}">${STATUS_LABELS[status]}</span>`;
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "pack") {
		const title = selectedPack?.name || selectedPackId || "Pack";
		return html`
			<div class="market-nav">
				<div class="market-nav-left">
					<button class="market-back" @click=${showList} title="Back to marketplace">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="market-title-group">
						<span class="market-breadcrumb" @click=${showList}>Market</span>
						<span class="market-breadcrumb-sep">/</span>
						<h1 class="market-title">${title}</h1>
					</div>
				</div>
			</div>
		`;
	}
	return html`
		<div class="market-nav">
			<div class="market-nav-left">
				<button class="market-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="market-title">Market</h1>
			</div>
			<div class="market-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: handleAddSource,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold" data-testid="market-add-source">${icon(Plus, "sm")} Add source</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: SOURCES
// ============================================================================

function renderSourceRow(source: MarketSource): TemplateResult {
	const syncing = syncingSourceId === source.id;
	const subtitle = source.kind === "git" ? (source.url || "") : (source.path || "");
	return html`
		<div class="market-source-row" data-testid="market-source-row">
			<span class="market-source-icon">${icon(source.kind === "git" ? GitBranch : FolderOpen, "sm")}</span>
			<div class="market-source-info">
				<span class="market-source-name">${sourceDisplayName(source)}</span>
				<span class="market-source-sub" title=${subtitle}>${subtitle}</span>
				${source.lastSyncError
					? html`<span class="market-source-error" data-testid="market-source-sync-error">${icon(AlertCircle, "sm")} ${source.lastSyncError}</span>`
					: nothing}
			</div>
			<div class="market-source-actions">
				<button class="market-action-btn" title="Re-sync source" ?disabled=${syncing}
					@click=${() => handleSyncSource(source)}>
					<span class=${syncing ? "market-spin" : ""}>${icon(RefreshCw, "sm")}</span>
				</button>
				<button class="market-action-btn delete" title="Remove source"
					@click=${() => handleRemoveSource(source)}>${icon(Trash2, "sm")}</button>
			</div>
		</div>
	`;
}

function renderSourcesSection(): TemplateResult {
	return html`
		<div class="market-section">
			<div class="market-section-head">
				<h2 class="market-section-title">Sources</h2>
			</div>
			${sources.length === 0
				? html`<p class="market-section-empty">No sources yet. Add a git repo or local directory that contains extension packs.</p>`
				: html`<div class="market-source-list">${sources.map(renderSourceRow)}</div>`}
		</div>
	`;
}

// ============================================================================
// RENDER: PACK LIST
// ============================================================================

function renderEntityChips(entities: MarketPackEntity[]): TemplateResult {
	return html`
		<div class="market-entity-chips">
			${entities.map((e) => html`
				<span class="market-entity-chip" title="${e.type}: ${e.name}">
					${icon(entityIcon(e.type), "sm")}<span>${e.name}</span>
				</span>
			`)}
		</div>
	`;
}

function renderPackCard(pack: MarketPack): TemplateResult {
	const busy = busyPackKey === packKey(pack.sourceId, pack.packId);
	if (!pack.valid) {
		return html`
			<div class="market-pack-card market-pack-invalid" data-testid="market-pack-card" data-pack-id="${pack.packId}" data-valid="false">
				<div class="market-pack-head">
					<span class="market-pack-name">${pack.name || pack.packId}</span>
					<span class="market-pack-invalid-badge" data-testid="market-pack-invalid">${icon(AlertTriangle, "sm")} invalid</span>
				</div>
				<p class="market-pack-error" data-testid="market-pack-error">${pack.error || "This pack has errors and cannot be installed."}</p>
				<div class="market-pack-source">${pack.sourceLabel || pack.sourceId}</div>
			</div>
		`;
	}
	return html`
		<div class="market-pack-card" data-testid="market-pack-card" data-pack-id="${pack.packId}" data-valid="true"
			tabindex="0" role="button"
			@click=${() => showPack(pack)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showPack(pack); } }}>
			<div class="market-pack-head">
				<span class="market-pack-name">${pack.name}</span>
				<span class="market-pack-version">v${pack.version}</span>
				${pack.hasTools ? html`<span class="market-code-badge" data-testid="market-exec-code-badge" title=${EXEC_CODE_WARNING}>${icon(AlertTriangle, "sm")} executable code</span>` : nothing}
			</div>
			<p class="market-pack-desc">${pack.description}</p>
			${renderEntityChips(pack.entities)}
			<div class="market-pack-foot">
				<span class="market-pack-source">${pack.sourceLabel || pack.sourceId}</span>
				<div class="market-pack-foot-right">
					${renderStatusBadge(pack.installStatus)}
					${renderPackPrimaryAction(pack, busy, true)}
				</div>
			</div>
		</div>
	`;
}

/** Primary install/update/uninstall control for a pack, used on cards + detail. */
function renderPackPrimaryAction(pack: MarketPack, busy: boolean, compact: boolean): TemplateResult {
	const stop = (fn: () => void) => (e: Event) => { e.stopPropagation(); fn(); };
	const size = compact ? "sm" : undefined;
	if (pack.installStatus === "not-installed") {
		return Button({
			variant: "default",
			size: size as any,
			disabled: busy,
			onClick: stop(() => handleInstall(pack)),
			children: html`<span class="inline-flex items-center gap-1.5" data-testid="market-install-btn">${icon(Download, "sm")} ${busy ? "Installing\u2026" : `Install`}</span>`,
		});
	}
	// installed / update-available / drifted → offer update (when available) + uninstall
	return html`
		<div class="inline-flex items-center gap-1.5" @click=${(e: Event) => e.stopPropagation()}>
			${pack.installStatus === "update-available" || pack.installStatus === "drifted"
				? Button({
					variant: "secondary" as any,
					size: size as any,
					disabled: busy,
					onClick: () => handleUpdate(pack),
					children: html`<span class="inline-flex items-center gap-1.5" data-testid="market-update-btn">${icon(RefreshCw, "sm")} Update</span>`,
				})
				: html`<span class="market-installed-check" data-testid="market-installed-check">${icon(Check, "sm")} Installed</span>`}
			${Button({
				variant: "ghost",
				size: size as any,
				disabled: busy,
				onClick: () => handleUninstall(pack),
				children: html`<span class="inline-flex items-center gap-1.5" data-testid="market-uninstall-btn">${icon(Trash2, "sm")} Uninstall</span>`,
			})}
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="market-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading marketplace\u2026</span>
			</div>
		`;
	}
	return html`
		<div class="market-body-inner">
			${renderSourcesSection()}
			<div class="market-section">
				<div class="market-section-head">
					<h2 class="market-section-title">Extension Packs</h2>
				</div>
				${sources.length === 0
					? html`<p class="market-section-empty">Add a source to browse the extension packs it contains.</p>`
					: packs.length === 0
						? html`<p class="market-section-empty" data-testid="market-no-packs">No packs found in the configured sources. A directory is a pack only if it contains a <code>pack.yaml</code>.</p>`
						: html`<div class="market-pack-grid">${packs.map(renderPackCard)}</div>`}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: PACK DETAIL
// ============================================================================

function renderMetaRow(label: string, value: string | TemplateResult): TemplateResult {
	return html`<div class="market-meta-row"><span class="market-meta-label">${label}</span><span class="market-meta-value">${value}</span></div>`;
}

function renderEntityDetailRow(pack: MarketPackDetail, entity: MarketPackEntity): TemplateResult {
	const status = entity.installStatus;
	const busy = busyPackKey === packKey(pack.sourceId, pack.packId);
	return html`
		<div class="market-entity-row" data-testid="market-entity-row" data-entity-type="${entity.type}" data-entity-name="${entity.name}">
			<span class="market-entity-icon">${icon(entityIcon(entity.type), "sm")}</span>
			<span class="market-entity-type">${entity.type}</span>
			<span class="market-entity-name">${entity.name}</span>
			${entity.type === "tool" ? html`<span class="market-code-badge market-code-badge--sm" title=${EXEC_CODE_WARNING}>${icon(AlertTriangle, "sm")} code</span>` : nothing}
			<span class="market-entity-spacer"></span>
			${status && status !== "not-installed"
				? html`<span class="market-installed-check" data-testid="market-entity-installed">${icon(Check, "sm")} ${STATUS_LABELS[status]}</span>`
				: Button({
					variant: "ghost",
					size: "sm" as any,
					disabled: busy,
					onClick: () => handleInstall(pack, [entity]),
					children: html`<span class="inline-flex items-center gap-1" data-testid="market-entity-install">${icon(Download, "sm")} Install</span>`,
				})}
		</div>
	`;
}

function renderPackDetailView(): TemplateResult {
	if (loadingPack) {
		return html`
			<div class="market-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading pack\u2026</span>
			</div>
		`;
	}
	const pack = selectedPack;
	if (!pack) {
		return html`
			<div class="market-empty">
				<p class="market-empty-title">Pack not found</p>
				<p class="market-empty-desc">This pack is no longer available. It may have been removed from its source.</p>
				<button class="underline text-sm" @click=${showList}>Back to marketplace</button>
			</div>
		`;
	}
	const busy = busyPackKey === packKey(pack.sourceId, pack.packId);
	return html`
		<div class="market-detail">
			<div class="market-detail-head">
				<div class="market-detail-title-row">
					<h1 class="market-detail-name">${pack.name}</h1>
					<span class="market-pack-version">v${pack.version}</span>
					${renderStatusBadge(pack.installStatus)}
				</div>
				<p class="market-detail-desc">${pack.description}</p>
				<div class="market-detail-actions">
					${renderPackPrimaryAction(pack, busy, false)}
				</div>
			</div>

			${pack.hasTools ? html`
				<div class="market-code-notice" data-testid="market-code-notice" role="note">
					${icon(AlertTriangle, "sm")}
					<span>${EXEC_CODE_WARNING}</span>
				</div>
			` : nothing}

			<div class="market-detail-grid">
				<div class="market-section">
					<div class="market-section-head"><h2 class="market-section-title">Contents</h2></div>
					<div class="market-entity-rows">
						${pack.entities.map((e) => renderEntityDetailRow(pack, e))}
					</div>
				</div>

				<div class="market-section">
					<div class="market-section-head"><h2 class="market-section-title">Details</h2></div>
					<div class="market-meta">
						${renderMetaRow("Source", pack.sourceLabel || pack.sourceId)}
						${renderMetaRow("Pack ID", pack.packId)}
						${pack.author ? renderMetaRow("Author", pack.author) : nothing}
						${pack.homepage ? renderMetaRow("Homepage", html`<a class="market-link" href=${pack.homepage} target="_blank" rel="noreferrer noopener">${pack.homepage}</a>`) : nothing}
						${pack.license ? renderMetaRow("License", pack.license) : nothing}
						${pack.minBobbit ? renderMetaRow("Min Bobbit", pack.minBobbit) : nothing}
						${pack.installedVersion ? renderMetaRow("Installed version", pack.installedVersion) : nothing}
						${pack.installedCommit ? renderMetaRow("Installed commit", pack.installedCommit.slice(0, 10)) : nothing}
					</div>
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderMarketPage(): TemplateResult {
	return html`
		<div class="market-container">
			${renderNavBar()}
			${currentView === "list" ? renderConfigScopeRow(getConfigScope(), handleScopeChange) : ""}
			<div class="market-body">
				${currentView === "list" ? renderListView() : renderPackDetailView()}
			</div>
		</div>
	`;
}
