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
import { HEADQUARTERS_PROJECT_ID } from "./headquarters.js";
import { renderApp, state } from "./state.js";
import { setHashRoute } from "./routing.js";
import {
	addMarketplaceSource,
	browseMarketplace,
	getPackActivation,
	getPackConflicts,
	installMarketplacePack,
	listInstalledPacks,
	listMarketplaceSources,
	removeMarketplaceSource,
	setMcpOperationActivation,
	setPackActivation,
	setPackOrder,
	syncMarketplaceSource,
	uninstallMarketplacePack,
	updateInstalledPack,
	fetchContributions,
	fetchTools,
	fetchMcpServers,
	type BrowsePackWire,
	type ConflictWire,
	type DisabledRefs,
	type InstalledPackWire,
	type MarketplaceBrowseSourceState,
	type MarketplaceSource,
	type MarketplaceSourceType,
	type MarketScope,
	type McpServerInfo,
	type PackActivationMcpEntry,
	type PackActivationMcpOperationEntry,
	type PackActivationPiExtensionEntry,
	type PackActivationResponse,
	type PackEntityDescriptions,
	type PackMcpContributionWire,
	type PiExtensionDiagnostic,
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

let browseSources: MarketplaceBrowseSourceState[] = [];
let browsePacks: BrowsePackWire[] = [];
let enabledBrowseSourceIds = new Set<string>();
let browseSearch = "";
let browseError = "";
let browseLoading = false;
let browseSourceMenuOpen = false;

let installed: InstalledPackWire[] = [];
let installedError = "";
let conflicts: ConflictWire[] = [];

/** Per-installed-pack activation catalogue + disabled overrides, keyed by
 *  `${scope}:${packName}` (pack schema V1 §6.7/§9). This is the UNFILTERED
 *  authoritative source for the activation toggles — server-expanded from pack
 *  declarations (tool groups become concrete tool names), NOT from the runtime-
 *  filtered /api/tools or /api/ext/contributions — so a DISABLED entity stays
 *  visible + re-enableable. */
const activationByPack = new Map<string, PackActivationResponse>();

/** Runtime MCP status enriches activation rows; activation catalogue remains the
 *  source of truth for which MCP entries exist/toggle. Keyed by "default" or
 *  `project:${projectId}` and then by runtime server name. */
const mcpRuntimeByScope = new Map<string, Map<string, McpServerInfo>>();

let newSourceType: MarketplaceSourceType = "pack";
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
	browseSources = [];
	browsePacks = [];
	enabledBrowseSourceIds = new Set<string>();
	browseSearch = "";
	browseError = "";
	browseLoading = false;
	browseSourceMenuOpen = false;
	installed = [];
	installedError = "";
	conflicts = [];
	activationByPack.clear();
	mcpRuntimeByScope.clear();
	newSourceType = "pack";
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
	const [
		{ registerPackRenderers },
		{ registerPackPanels, panelInfosFromContributions },
		{ registerPackEntrypoints, entrypointInfosFromContributions },
	] = await Promise.all([
		import("./pack-renderers.js"),
		import("./pack-panels.js"),
		import("./pack-entrypoints.js"),
	]);
	const projectId = activeSessionProjectId();
	// Tool renderers stay TOOL-scoped — reconcile from /api/tools (pack schema V1 §8.3).
	const tools = await fetchTools(projectId);
	registerPackRenderers(tools, projectId);
	// Panels + entrypoints are PACK-scoped — reconcile from /api/ext/contributions
	// (pack schema V1 §8.1/§8.2). Force re-register directly from the freshly-fetched
	// metadata (the dedupe guard would skip an unchanged project); uninstall reconcile
	// drops removed panels/entrypoints/routes so a stale deep-link no longer resolves.
	// `invalidateLoaded` drops cached panel MODULES for surviving panels too: a
	// same-project UPDATE/reinstall re-registers the same {packId, panelId} behind the
	// same serving URL with fresh bytes, so without forcing it the stale module would
	// keep serving until a full reload (this path runs ONLY on real pack mutations /
	// activation toggles, never on a benign session-switch reconcile).
	const packs = await fetchContributions(projectId);
	registerPackPanels(panelInfosFromContributions(packs), projectId, { invalidateLoaded: true });
	registerPackEntrypoints(entrypointInfosFromContributions(packs), projectId);
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

	// Activation catalogues/runtime statuses are fetched in the background so the
	// page paints immediately; toggles/statuses appear once they resolve.
	void loadActivationForInstalled();
	void loadMcpRuntimeForInstalled();

	await loadBrowse();
}

/** Fetch the UNFILTERED activation catalogue + disabled overrides for every
 *  installed pack (pack schema V1 §6.7/§9). The catalogue is the SINGLE source
 *  for the toggle UI — never the runtime-filtered /api/tools or
 *  /api/ext/contributions, which would hide a disabled entity and make it
 *  impossible to re-enable. Best-effort; repaints when done. */
async function loadActivationForInstalled(): Promise<void> {
	const snapshot = installed.slice();
	const results = await Promise.all(snapshot.map(async (p) => {
		const projectId = p.scope === "project" ? currentProjectId() : undefined;
		const res = await getPackActivation(p.scope, p.packName, projectId);
		return { key: `${p.scope}:${p.packName}`, res };
	}));
	let changed = false;
	for (const { key, res } of results) {
		if (res.ok) { activationByPack.set(key, res.data); changed = true; }
	}
	if (changed) renderApp();
}

function mcpRuntimeScopeKeyForPack(pack: InstalledPackWire): string {
	return pack.scope === "project" ? `project:${currentProjectId() || ""}` : "default";
}

async function loadMcpRuntimeForInstalled(): Promise<void> {
	const needsDefault = installed.some((p) => p.scope !== "project" && packHasMcp(p));
	const projectId = currentProjectId();
	const needsProject = !!projectId && installed.some((p) => p.scope === "project" && packHasMcp(p));
	const jobs: Array<Promise<void>> = [];
	if (needsDefault) {
		jobs.push(fetchMcpServers({ projectId: HEADQUARTERS_PROJECT_ID }).then((servers) => {
			mcpRuntimeByScope.set("default", new Map(servers.map((s) => [s.name, s])));
		}).catch(() => {}));
	}
	if (needsProject && projectId) {
		jobs.push(fetchMcpServers({ projectId }).then((servers) => {
			mcpRuntimeByScope.set(`project:${projectId}`, new Map(servers.map((s) => [s.name, s])));
		}).catch(() => {}));
	}
	if (jobs.length === 0) return;
	await Promise.all(jobs);
	renderApp();
}

type ActivationArrayKey = "roles" | "tools" | "skills" | "entrypoints" | "mcp" | "piExtensions";

/** Maps the singular testid kind → the `DisabledRefs` array key. */
const ACTIVATION_KIND_KEY: Record<"role" | "tool" | "skill" | "entrypoint" | "mcp" | "pi-extension", ActivationArrayKey> = {
	role: "roles",
	tool: "tools",
	skill: "skills",
	entrypoint: "entrypoints",
	mcp: "mcp",
	"pi-extension": "piExtensions",
};

/** Toggle a user-facing pack entity's activation. Computes the new `disabled`
 *  set, PUTs it (the response carries the refreshed catalogue + normalized
 *  disabled — no follow-up GET), then re-runs the marketplace reconcile so a
 *  disabled entrypoint disappears from launchers/deep-links WITHOUT a reload
 *  (pack schema V1 §9). Entrypoints are keyed by `listName`. */
async function handleToggleActivation(
	pack: InstalledPackWire,
	kind: "role" | "tool" | "skill" | "entrypoint" | "mcp" | "pi-extension",
	name: string,
	enable: boolean,
): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const current = activationByPack.get(cacheKey);
	const kindKey = ACTIVATION_KIND_KEY[kind];
	const set = new Set(current?.disabled?.[kindKey] ?? []);
	if (enable) set.delete(name); else set.add(name);
	const disabled: DisabledRefs = { ...(current?.disabled ?? {}), [kindKey]: [...set] };
	await savePackActivation(pack, disabled, `activation:${cacheKey}:${kind}:${name}`);
}

async function handleToggleAllActivation(pack: InstalledPackWire, enable: boolean): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const current = activationByPack.get(cacheKey);
	if (!current) return;
	const cat = current.catalogue;
	const disabled: DisabledRefs = enable
		? { roles: [], tools: [], skills: [], entrypoints: [], mcp: [], mcpOperations: current.disabled?.mcpOperations ?? {}, piExtensions: [] }
		: {
			roles: [...cat.roles],
			tools: [...cat.tools],
			skills: [...cat.skills],
			entrypoints: cat.entrypoints.map((e) => e.listName),
			mcp: normalizedActivationMcp(cat.mcp).map((e) => mcpContributionKey(e)),
			mcpOperations: current.disabled?.mcpOperations ?? {},
			piExtensions: normalizedActivationPiExtensions(cat.piExtensions).map((e) => e.ref),
		};
	await savePackActivation(pack, disabled, `activation:${cacheKey}:all`);
}

async function savePackActivation(pack: InstalledPackWire, disabled: DisabledRefs, busyKey: string): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	busy.add(busyKey);
	renderApp();
	const res = await setPackActivation({ scope: pack.scope, projectId, packName: pack.packName, disabled });
	busy.delete(busyKey);
	if (res.ok) {
		// The PUT returns the refreshed UNFILTERED catalogue + normalized disabled.
		activationByPack.set(cacheKey, res.data);
		// Re-run the same reconcile a marketplace mutation triggers so the runtime
		// registries (renderers/panels/entrypoints) drop/restore the toggled entity
		// without a reload (the catalogue source above is unaffected).
		await refreshConfigPages();
		await loadMcpRuntimeForInstalled();
		renderApp();
	} else {
		installedError = res.error;
		renderApp();
	}
}

async function handleToggleMcpOperation(pack: InstalledPackWire, entry: PackActivationMcpEntry, operationName: string, enable: boolean): Promise<void> {
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const current = activationByPack.get(cacheKey);
	const contributionId = mcpContributionKey(entry);
	const busyKey = `activation:${cacheKey}:mcp-op:${contributionId}:${operationName}`;
	const projectId = pack.scope === "project" ? currentProjectId() : undefined;
	busy.add(busyKey);
	renderApp();
	const res = await setMcpOperationActivation({
		scope: pack.scope,
		projectId,
		contributionId,
		operationName,
		disabled: !enable,
		...(current?.revision ? { expectedRevision: current.revision } : {}),
	});
	busy.delete(busyKey);
	if (res.ok) {
		activationByPack.set(cacheKey, res.data);
		await refreshConfigPages();
		await loadMcpRuntimeForInstalled();
		renderApp();
	} else {
		installedError = res.error;
		renderApp();
	}
}

async function loadBrowse(): Promise<void> {
	browseLoading = true;
	browseError = "";
	renderApp();
	const before = new Set(enabledBrowseSourceIds);
	const knownBefore = new Set(browseSources.map((src) => src.sourceId));
	const res = await browseMarketplace(currentProjectId());
	if (res.ok) {
		browseSources = res.data.sources || [];
		browsePacks = res.data.packs || [];
		const enabled = new Set<string>();
		const hadPriorSelection = before.size > 0;
		for (const src of browseSources) {
			if (src.status === "unsupported") continue;
			if (!hadPriorSelection || before.has(src.sourceId) || !knownBefore.has(src.sourceId)) enabled.add(src.sourceId);
		}
		enabledBrowseSourceIds = enabled;
	} else {
		browseSources = [];
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
	const res = await addMarketplaceSource(url, newSourceType === "pack" ? (newSourceRef.trim() || undefined) : undefined, newSourceType);
	addingSource = false;
	if (res.ok) {
		newSourceUrl = "";
		newSourceRef = "";
		newSourceType = "pack";
		await loadMarketplaceData(false);
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
		enabledBrowseSourceIds.delete(id);
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

	const key = `install:${pack.browseKey || `${pack.source?.id || "unknown"}:${pack.dirName}`}`;
	busy.add(key);
	renderApp();
	const sourceId = pack.source?.id;
	if (!sourceId) {
		busy.delete(key);
		browseError = "This package row is missing source provenance. Refresh Browse and try again.";
		renderApp();
		return;
	}
	const res = await installMarketplacePack({ sourceId, dirName: pack.dirName, scope, projectId });
	busy.delete(key);
	if (res.ok) {
		await loadMarketplaceData(false);
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
	const uninstallCopy = packHasMcp(pack)
		? `Uninstall "${pack.packName}"? This deletes the pack directory, disconnects its MCP server, and unregisters its MCP tools. Tool policy settings are not deleted.`
		: `Uninstall "${pack.packName}"? This deletes the pack directory and removes its entities.`;
	const ok = await confirmAction("Uninstall pack", uninstallCopy, "Uninstall", true);
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
	// Built-in first-party packs (§7.4) render in their OWN top group and are NOT
	// in pack_order — exclude them from the per-scope (reorderable) groups.
	return installed.filter((p) => p.scope === scope && !p.builtin);
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

type MarketplaceSourceKind = MarketplaceSourceType | "mcp-registry";

function sourceType(src: MarketplaceSource | undefined): MarketplaceSourceKind {
	if (src?.type === "mcp-gateway") return "mcp-gateway";
	if (src?.type === "mcp-registry") return "mcp-registry";
	return "pack";
}

function sourceDisplayLabel(src: MarketplaceSource | MarketplaceBrowseSourceState | undefined): string {
	if (!src) return "unknown source";
	if ("sourceName" in src) return src.sourceName || src.sourceId;
	return src.displayName || src.normalizedName || src.id;
}

function sourceMcpCount(src: MarketplaceSource): number | undefined {
	if (typeof src.mcpProviderCount === "number") return src.mcpProviderCount;
	if (typeof src.discoveredMcpProviders === "number") return src.discoveredMcpProviders;
	if (typeof src.gatewayProviderCount === "number") return src.gatewayProviderCount;
	if (typeof src.mcpServerCount === "number") return src.mcpServerCount;
	if (typeof src.discoveredMcpServers === "number") return src.discoveredMcpServers;
	return undefined;
}

function packMcpRefs(pack: BrowsePackWire | InstalledPackWire): string[] {
	const contents = "contents" in pack ? pack.contents : (pack as InstalledPackWire).manifest.contents;
	return contents?.mcp ?? [];
}

function packPiExtensionRefs(pack: BrowsePackWire | InstalledPackWire): string[] {
	const contents = "contents" in pack ? pack.contents : (pack as InstalledPackWire).manifest.contents;
	return contents?.piExtensions ?? [];
}

function packHasMcp(pack: BrowsePackWire | InstalledPackWire): boolean {
	return packMcpRefs(pack).length > 0 || normalizedBrowseMcp(pack as BrowsePackWire).length > 0;
}

function normalizedBrowseMcp(pack: BrowsePackWire): PackMcpContributionWire[] {
	const refs = pack.contents?.mcp ?? [];
	const rich = pack.mcp ?? pack.mcpServers ?? [];
	if (rich.length) {
		return rich.map((entry, index) => ({
			...entry,
			ref: entry.ref || entry.listName || refs[index] || entry.serverName,
		}));
	}
	return refs.map((ref) => ({ ref, serverName: ref, description: pack.descriptions?.mcp?.[ref] }));
}

function normalizedActivationMcp(entries: PackActivationResponse["catalogue"]["mcp"] | undefined): PackActivationMcpEntry[] {
	return (entries ?? []).map((entry) => {
		if (typeof entry === "string") return { ref: entry, serverName: entry };
		return {
			...entry,
			ref: entry.ref || entry.listName || entry.serverName || "mcp",
			serverName: entry.serverName || entry.ref || entry.listName,
		};
	});
}

function normalizedActivationPiExtensions(entries: PackActivationResponse["catalogue"]["piExtensions"] | undefined): PackActivationPiExtensionEntry[] {
	return (entries ?? []).map((entry) => {
		if (typeof entry === "string") return { ref: entry, listName: entry, label: entry };
		const ref = entry.ref || entry.listName || entry.label || "pi-extension";
		return { ...entry, ref, listName: entry.listName || ref, label: entry.label || ref };
	});
}

function piExtensionLabel(entry: PackActivationPiExtensionEntry): string {
	return entry.label && entry.label !== entry.ref ? `${entry.label} · ${entry.ref}` : entry.ref;
}

function mcpEntryLabel(entry: PackActivationMcpEntry | PackMcpContributionWire): string {
	const ref = entry.ref || entry.listName || entry.serverName || "mcp";
	const server = entry.serverName || ref;
	const base = entry.subNamespace ? `${server} / ${entry.subNamespace}` : server;
	return entry.label && entry.label !== base ? `${entry.label} · ${base}` : base;
}

function mcpContributionKey(entry: PackActivationMcpEntry): string {
	return entry.contributionId || entry.ref;
}

function disabledMcpContribution(disabled: DisabledRefs, entry: PackActivationMcpEntry): boolean {
	const refs = disabled.mcp ?? [];
	return refs.includes(mcpContributionKey(entry)) || refs.includes(entry.ref);
}

function disabledOperationNames(activation: PackActivationResponse, entry: PackActivationMcpEntry): Set<string> {
	const key = mcpContributionKey(entry);
	return new Set([...(activation.disabled?.mcpOperations?.[key] ?? []), ...(entry.disabledOperations ?? [])]);
}

function mcpOperationRows(activation: PackActivationResponse, entry: PackActivationMcpEntry): PackActivationMcpOperationEntry[] {
	const disabled = disabledOperationNames(activation, entry);
	const rows = [...(entry.operations ?? [])].map((op) => ({
		...op,
		selected: op.selected ?? !disabled.has(op.name),
		disabledByActivation: op.disabledByActivation ?? disabled.has(op.name),
	}));
	const existing = new Set(rows.map((op) => op.name));
	for (const name of entry.staleDisabledOperations ?? []) {
		if (!existing.has(name)) {
			rows.push({ name, selected: false, disabledByActivation: true, stale: true, description: "No longer provided by this source" });
			existing.add(name);
		}
	}
	for (const name of disabled) {
		if (!existing.has(name)) {
			rows.push({ name, selected: false, disabledByActivation: true, stale: true, description: "Disabled by name" });
			existing.add(name);
		}
	}
	return rows;
}

function keyNames(value: string[] | Record<string, unknown> | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : Object.keys(value);
}

function renderMcpTransportPreview(pack: BrowsePackWire): TemplateResult {
	const entries = normalizedBrowseMcp(pack);
	if (entries.length === 0) return html``;
	return html`
		<div class="market-mcp-transport-list">
			${entries.map((entry) => {
				const transport = entry.transport || (entry.url ? "http" : entry.command ? "stdio" : undefined);
				const envNames = keyNames(entry.env);
				const headerNames = keyNames(entry.headers);
				const preview = transport === "http"
					? `Endpoint: ${entry.url || entry.serverName || entry.ref || "MCP server"}`
					: transport === "stdio"
						? `Command: ${[entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ") || entry.serverName || entry.ref || "MCP server"}`
						: `MCP server: ${entry.serverName || entry.ref || "unknown"}`;
				return html`
					<div class="market-mcp-transport" data-testid="market-mcp-transport">
						<span class="market-lozenge market-lozenge--mcp" data-testid="market-mcp-transport-kind">${transport === "http" ? "HTTP" : transport === "stdio" ? "stdio" : "MCP"}</span>
						<span class="market-mcp-transport-preview">${preview}</span>
						<details class="market-mcp-transport-details" data-testid="market-mcp-transport-details">
							<summary>Transport details</summary>
							<div>
								${entry.command ? html`<div><strong>Command</strong> ${entry.command}</div>` : ""}
								${entry.args?.length ? html`<div><strong>Args</strong> ${entry.args.join(" ")}</div>` : ""}
								${entry.cwd ? html`<div><strong>Cwd</strong> ${entry.cwd}</div>` : ""}
								${entry.url ? html`<div><strong>URL</strong> ${entry.url}</div>` : ""}
								${envNames.length ? html`<div><strong>Env keys</strong> ${envNames.join(", ")}</div>` : ""}
								${headerNames.length ? html`<div><strong>Header keys</strong> ${headerNames.join(", ")}</div>` : ""}
							</div>
						</details>
					</div>
				`;
			})}
		</div>
	`;
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

function renderResearchPreviewBanner(): TemplateResult {
	return html`
		<div class="market-research-preview-banner" data-testid="market-research-preview-banner">
			<div class="market-research-preview-icon">${icon(AlertTriangle, "sm")}</div>
			<div>
				<div class="market-research-preview-title">Research Preview</div>
				<div class="market-research-preview-copy">
					The extension API is still subject to change. Bobbit extensions may need to be re-written against the final extension API in the next release.
				</div>
			</div>
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
				@click=${() => {
					activeTab = mode;
					if (mode !== "browse") closeBrowseSourceMenu(false);
					renderApp();
				}}
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
		["mcp", contents?.mcp || []],
		["pi-extension", contents?.piExtensions || []],
	];
	const chips = groups.flatMap(([kind, names]) =>
		names.map((n) => html`<span class="market-entity-chip" data-kind=${kind}>${kind}: ${n}</span>`),
	);
	const transportChips: TemplateResult[] = "contents" in pack
		? normalizedBrowseMcp(pack).map((entry) => {
			const transport = entry.transport || (entry.url ? "http" : entry.command ? "stdio" : undefined);
			return transport ? html`<span class="market-lozenge market-lozenge--mcp">${transport === "http" ? "HTTP" : "stdio"}</span>` : null;
		}).filter(Boolean) as TemplateResult[]
		: [];
	if (chips.length === 0 && transportChips.length === 0) return html`<span class="text-[11px] text-muted-foreground italic">no declared entities</span>`;
	return html`<div class="flex flex-wrap gap-1">${chips}${transportChips}</div>`;
}

/** Declared-entity name lists for the description disclosure, across all four
 *  kinds. Entry points carry an optional display `label`. */
interface EntityNameLists {
	roles: string[];
	tools: string[];
	skills: string[];
	entrypoints: Array<{ listName: string; label?: string }>;
	mcp?: Array<{ ref: string; label?: string }>;
	piExtensions?: Array<{ ref: string; label?: string }>;
}

/** Shared collapsed "Show details" disclosure (R3) — one row per declared
 *  entity that HAS a one-line description, across roles/tools/skills/entry
 *  points. Used by BOTH the Installed activation list and the Browse pack card.
 *  Rows with no description are omitted; the disclosure is omitted entirely when
 *  no row would render. Tool keys follow the provided entity list (manifest groups
 *  for browse chips, concrete tool names for activation); entrypoints use `listName`
 *  (kind `entrypoint`). */
function renderEntityDetails(packName: string, descriptions: PackEntityDescriptions | undefined, entities: EntityNameLists): TemplateResult {
	if (!descriptions) return html``;
	const rows: TemplateResult[] = [];
	const pushRows = (
		kind: "role" | "tool" | "skill" | "entrypoint" | "mcp" | "pi-extension",
		map: Record<string, string> | undefined,
		names: string[],
		labelFor?: (n: string) => string,
	): void => {
		if (!map) return;
		for (const name of names) {
			const desc = map[name];
			if (!desc) continue;
			rows.push(html`
				<div class="market-entity-desc" data-testid="market-entity-desc-${kind}-${name}">
					<span class="market-entity-desc-name">${labelFor ? labelFor(name) : name}</span>
					<span class="market-entity-desc-text">${desc}</span>
				</div>
			`);
		}
	};
	pushRows("role", descriptions.roles, entities.roles);
	pushRows("tool", descriptions.tools, entities.tools);
	pushRows("skill", descriptions.skills, entities.skills);
	const epLabel = new Map(entities.entrypoints.map((e) => [e.listName, e.label || e.listName]));
	pushRows("entrypoint", descriptions.entrypoints, entities.entrypoints.map((e) => e.listName), (n) => epLabel.get(n) || n);
	const mcpLabel = new Map((entities.mcp ?? []).map((e) => [e.ref, e.label || e.ref]));
	pushRows("mcp", descriptions.mcp, (entities.mcp ?? []).map((e) => e.ref), (n) => mcpLabel.get(n) || n);
	const piExtensionLabel = new Map((entities.piExtensions ?? []).map((e) => [e.ref, e.label || e.ref]));
	pushRows("pi-extension", descriptions.piExtensions, (entities.piExtensions ?? []).map((e) => e.ref), (n) => piExtensionLabel.get(n) || n);
	if (rows.length === 0) return html``;
	return html`
		<details class="market-entity-details" data-testid="market-entity-details-${packName}">
			<summary>Show details</summary>
			<div class="market-entity-desc-list">${rows}</div>
		</details>
	`;
}

function renderSourcesPanel(): TemplateResult {
	const isGateway = newSourceType === "mcp-gateway";
	const urlInput = html`
		<input
			type="text"
			data-testid="market-source-url"
			class="market-input ${isGateway ? "flex-1" : ""}"
			placeholder=${isGateway ? "http://mcp-local.t3.zone/readonly/mcp" : "https://github.com/acme/bobbit-packs.git or /abs/local/path"}
			.value=${newSourceUrl}
			@input=${(e: Event) => { newSourceUrl = (e.target as HTMLInputElement).value; renderApp(); }}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && newSourceUrl.trim()) handleAddSource(); }}
		/>
	`;
	const addButton = html`
		<button
			class="market-btn market-btn--primary"
			data-testid="market-add-source"
			?disabled=${!newSourceUrl.trim() || addingSource}
			@click=${handleAddSource}
		>${icon(Plus, "xs")} ${addingSource ? "Adding…" : "Add"}</button>
	`;
	return html`
		<section class="market-panel" data-testid="market-sources-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Sources</h2>
			${sourcesError ? html`<div class="market-error" data-testid="market-sources-error">${sourcesError}</div>` : ""}
			${sources.length === 0
				? html`<p class="text-sm text-muted-foreground italic">No marketplace sources registered yet.</p>`
				: html`<div class="flex flex-col gap-1.5">${sources.map(renderSourceRow)}</div>`}

			<div class="flex flex-col gap-2 mt-2 pt-3 border-t border-border">
				<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add source</div>
				<div class="market-source-kind" role="group" aria-label="Source type">
					<button
						type="button"
						class="market-source-kind-option ${newSourceType === "pack" ? "market-source-kind-option--active" : ""}"
						data-testid="market-source-kind-pack"
						@click=${() => { newSourceType = "pack"; renderApp(); }}
					>Pack repo / local dir</button>
					<button
						type="button"
						class="market-source-kind-option ${isGateway ? "market-source-kind-option--active" : ""}"
						data-testid="market-source-kind-mcp-gateway"
						@click=${() => { newSourceType = "mcp-gateway"; newSourceRef = ""; renderApp(); }}
					>MCP Gateways</button>
				</div>
				<div class="market-trust-warning" data-testid="market-trust-warning">
					${icon(AlertTriangle, "xs")}
					<div class="flex flex-col gap-1.5">
						<span>Only add sources you trust. Packs, MCP gateway providers, MCP servers, and pi extensions can run code, connect to remote services, or instruct agents on your machine.</span>
						<details class="market-trust-why" data-testid="market-trust-why">
							<summary>Why?</summary>
							<div class="market-trust-why-body">
								<p data-kind="tool"><strong>Tools</strong> ship <code>extension.ts</code> / <code>_shared/</code> code that runs directly in the Bobbit server process on the host, deterministically, with no LLM and no sandbox in the loop. Highest, most immediate risk.</p>
								<p data-kind="skill"><strong>Skills</strong> are free-form instructions an agent tends to follow literally; an agent with shell access can be directed to do damage.</p>
								<p data-kind="role"><strong>Roles</strong> steer persona/behavior; influential but more diffuse. Still drives an LLM with tool access.</p>
								<p data-kind="mcp"><strong>MCP servers</strong> run trusted stdio commands on the host or call trusted remote HTTP endpoints that may receive prompts, tool arguments, headers, and project-derived data.</p>
								<p data-kind="pi-extension"><strong>Pi extensions</strong> are host-code/runtime extensions loaded into matching agent sessions. They can register model-facing tools. Before trust is accepted Bobbit only does static/path discovery; executable probing runs later in a bounded child process.</p>
							</div>
						</details>
					</div>
				</div>
				${isGateway
					? html`
						<div class="flex items-center gap-2">${urlInput}${addButton}</div>
						<div class="market-source-helper" data-testid="market-mcp-source-helper">Bobbit discovers providers from an MCP gateway and installs one provider pack per namespace. Fine-grained operation policy is managed on the Tools page.</div>
					`
					: html`
						${urlInput}
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
							${addButton}
						</div>
					`}
			</div>
		</section>
	`;
}

function renderSourceRow(src: MarketplaceSource): TemplateResult {
	const syncing = busy.has(`sync:${src.id}`);
	const isBuiltin = src.builtin === true;
	const kind = sourceType(src);
	const mcpCount = sourceMcpCount(src);
	const chip = kind === "mcp-gateway" ? "MCP gateway" : kind === "mcp-registry" ? "Legacy MCP registry" : "Pack source";
	const urlPrefix = kind === "mcp-gateway" ? "Gateway URL: " : kind === "mcp-registry" ? "Legacy registry URL: " : "";
	const syncedSuffix = src.lastSyncedAt ? ` · synced ${new Date(src.lastSyncedAt).toLocaleString()}` : "";
	return html`
		<div
			class="market-source-row"
			data-testid="market-source-row"
			data-builtin=${isBuiltin ? "true" : "false"}
		>
			<div class="flex-1 min-w-0 text-left">
				<div class="flex items-center gap-1.5">
					<span class="text-sm font-medium truncate">${sourceDisplayLabel(src)}</span>
					<span class="market-source-type-chip" data-kind=${kind} data-testid="market-source-type-chip">${chip}</span>
					${isBuiltin ? html`<span class="market-builtin-badge" data-testid="market-source-builtin-badge">Built-in</span>` : ""}
				</div>
				<div class="text-[11px] text-muted-foreground truncate">${urlPrefix}${src.url}${src.ref ? html` <span class="opacity-70">@${src.ref}</span>` : ""}</div>
				${isBuiltin
					? html`<div class="text-[10px] text-muted-foreground/80">Shipped core features — always available, enable/disable per pack.</div>`
					: kind === "mcp-gateway"
						? html`<div class="text-[10px] text-muted-foreground/80">${mcpCount === undefined ? "MCP gateway source" : `${mcpCount} provider${mcpCount === 1 ? "" : "s"} discovered`}${syncedSuffix}</div>`
						: kind === "mcp-registry"
							? html`<div class="text-[10px] text-muted-foreground/80">${src.unsupportedReason || "Legacy MCP registry sources are unsupported. Remove and re-add as an MCP Gateway source."}</div>`
							: src.lastCommit ? html`<div class="text-[10px] text-muted-foreground/80">commit ${src.lastCommit.slice(0, 7)}</div>` : ""}
			</div>
			${isBuiltin
				? ""
				: html`
					<button class="market-icon-btn" title="Re-sync" data-testid="market-sync-source" ?disabled=${syncing} @click=${() => handleSyncSource(src.id)}>
						${icon(RotateCw, "xs", syncing ? "animate-spin" : "")}
					</button>
					<button class="market-icon-btn market-icon-btn--danger" title="Remove source" data-testid="market-remove-source" @click=${() => handleRemoveSource(src.id)}>
						${icon(Trash2, "xs")}
					</button>
				`}
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

function browsePackSourceId(pack: BrowsePackWire): string {
	return pack.source?.id || (pack.builtin ? "builtin" : "");
}

function browsePackSearchText(pack: BrowsePackWire): string {
	const mcp = normalizedBrowseMcp(pack);
	const parts: unknown[] = [
		pack.name,
		pack.description,
		pack.version,
		pack.source?.name,
		pack.source?.id,
		pack.source?.type,
		pack.gatewayProviderId,
		pack.contents?.roles,
		pack.contents?.tools,
		pack.contents?.skills,
		pack.contents?.entrypoints,
		pack.contents?.mcp,
		pack.contents?.piExtensions,
		pack.descriptions,
		mcp.map((entry) => [
			entry.ref,
			entry.listName,
			entry.serverName,
			entry.subNamespace,
			entry.label,
			entry.description,
			entry.operations?.map((op) => [op.name, op.label, op.description, op.toolName, op.policyKey]),
		]),
	];
	return parts.flat(Infinity).filter((v): v is string => typeof v === "string").join(" ").toLowerCase();
}

function filteredBrowsePacks(): BrowsePackWire[] {
	const query = browseSearch.trim().toLowerCase();
	return browsePacks.filter((pack) => {
		const sourceId = browsePackSourceId(pack);
		if (!sourceId || !enabledBrowseSourceIds.has(sourceId)) return false;
		return !query || browsePackSearchText(pack).includes(query);
	});
}

function browseSourceCountById(): Map<string, number> {
	const countBySource = new Map<string, number>();
	for (const pack of browsePacks) {
		const id = browsePackSourceId(pack);
		if (id) countBySource.set(id, (countBySource.get(id) ?? 0) + 1);
	}
	return countBySource;
}

function browseSourceSummary(visiblePackCount: number, selectedSupportedCount: number, _supportedCount: number): string {
	if (browseLoading && browseSources.length === 0) return "Loading sources…";
	if (selectedSupportedCount === 0) return "No sources selected";
	if (visiblePackCount === 0) return "No packages match the current filters";
	return `Showing ${visiblePackCount} package${visiblePackCount === 1 ? "" : "s"} from ${selectedSupportedCount} source${selectedSupportedCount === 1 ? "" : "s"}`;
}

function browseSourceStatusLabel(src: MarketplaceBrowseSourceState): string {
	if (src.status === "loading") return "Loading…";
	if (src.status === "error") return "Error";
	if (src.status === "unsupported") return "Unsupported";
	return "";
}

function toggleBrowseSourceMenu(): void {
	browseSourceMenuOpen = !browseSourceMenuOpen;
	renderApp();
}

function closeBrowseSourceMenu(render = true): void {
	if (!browseSourceMenuOpen) return;
	browseSourceMenuOpen = false;
	if (render) renderApp();
}

function handleBrowseSourceMenuKeydown(event: KeyboardEvent): void {
	if (event.key !== "Escape" || !browseSourceMenuOpen) return;
	event.stopPropagation();
	closeBrowseSourceMenu();
}

function toggleBrowseSource(sourceId: string): void {
	const source = browseSources.find((src) => src.sourceId === sourceId);
	if (source?.status === "unsupported") return;
	const next = new Set(enabledBrowseSourceIds);
	if (next.has(sourceId)) next.delete(sourceId);
	else next.add(sourceId);
	enabledBrowseSourceIds = next;
	renderApp();
}

function setAllBrowseSources(enabled: boolean): void {
	enabledBrowseSourceIds = enabled
		? new Set(browseSources.filter((src) => src.status !== "unsupported").map((src) => src.sourceId))
		: new Set<string>();
	renderApp();
}

function renderBrowseControls(): TemplateResult {
	const countBySource = browseSourceCountById();
	const visiblePackCount = filteredBrowsePacks().length;
	const supported = browseSources.filter((src) => src.status !== "unsupported");
	const supportedCount = supported.length;
	const selectedSupportedCount = supported.filter((src) => enabledBrowseSourceIds.has(src.sourceId)).length;
	const summary = browseSourceSummary(visiblePackCount, selectedSupportedCount, supportedCount);
	return html`
		<div class="market-browse-controls" data-testid="market-browse-controls">
			<div class="market-search-wrap">
				<input
					type="text"
					class="market-input market-search-input"
					data-testid="market-browse-search"
					placeholder="Search packages, descriptions, sources, operations…"
					.value=${browseSearch}
					@input=${(e: Event) => { browseSearch = (e.target as HTMLInputElement).value; renderApp(); }}
				/>
				${browseSearch ? html`<button class="market-search-clear" data-testid="market-browse-search-clear" title="Clear search" @click=${() => { browseSearch = ""; renderApp(); }}>×</button>` : ""}
			</div>
			<div
				class="market-source-filter"
				data-testid="market-browse-source-filter"
				@click=${(e: Event) => e.stopPropagation()}
				@keydown=${handleBrowseSourceMenuKeydown}
			>
				<button
					type="button"
					class="market-source-menu-trigger"
					data-testid="market-source-menu-trigger"
					aria-label="Filter packages by source"
					aria-haspopup="dialog"
					aria-expanded=${browseSourceMenuOpen ? "true" : "false"}
					aria-controls="market-source-menu"
					@click=${toggleBrowseSourceMenu}
				>
					<span>Sources</span>
					<span class="market-source-summary" data-testid="market-source-summary">${summary}</span>
					${icon(ChevronDown, "xs")}
				</button>
				${browseSourceMenuOpen ? html`
					<div
						id="market-source-menu"
						class="market-source-menu"
						data-testid="market-source-menu"
						role="dialog"
						aria-label="Browse package sources"
					>
						<div class="market-source-menu-actions" role="group" aria-label="Source filter actions">
							<button type="button" class="market-source-menu-action" data-testid="market-source-select-all" @click=${() => setAllBrowseSources(true)}>Select all</button>
							<button type="button" class="market-source-menu-action" data-testid="market-source-clear" @click=${() => setAllBrowseSources(false)}>Clear</button>
						</div>
						<fieldset class="market-source-menu-list">
							<legend class="sr-only">Sources</legend>
							${browseSources.map((src) => {
								const unsupported = src.status === "unsupported";
								const enabled = !unsupported && enabledBrowseSourceIds.has(src.sourceId);
								const count = countBySource.get(src.sourceId) ?? 0;
								const status = browseSourceStatusLabel(src);
								const classes = [
									"market-source-option",
									enabled ? "market-source-option--selected" : "",
									src.status === "error" ? "market-source-option--error" : "",
									unsupported ? "market-source-option--disabled" : "",
								].filter(Boolean).join(" ");
								return html`
									<label class=${classes} data-testid="market-source-option" data-source-id=${src.sourceId} title=${src.error || src.sourceId}>
										<input
											type="checkbox"
											data-testid="market-source-checkbox"
											data-source-id=${src.sourceId}
											.checked=${enabled}
											?disabled=${unsupported}
											@change=${() => toggleBrowseSource(src.sourceId)}
										/>
										<span class="market-source-option-main">
											<span class="market-source-option-name">${src.sourceName}</span>
											<span class="market-source-option-meta" data-testid="market-source-count">${count} package${count === 1 ? "" : "s"}</span>
										</span>
										${status ? html`<span class="market-source-status" data-testid="market-source-status">${status}</span>` : ""}
									</label>
								`;
							})}
						</fieldset>
					</div>
				` : ""}
			</div>
		</div>
	`;
}

function renderBrowseWarnings(): TemplateResult {
	const selected = browseSources.filter((src) => enabledBrowseSourceIds.has(src.sourceId));
	const warnings = selected.filter((src) => src.status === "error" || src.status === "unsupported");
	if (!warnings.length) return html``;
	return html`
		<div class="market-source-warning" data-testid="market-browse-source-warnings">
			<div class="font-medium">${warnings.length} selected source${warnings.length === 1 ? "" : "s"} could not load.</div>
			${warnings.map((src) => html`<div><span class="font-medium">${src.sourceName}</span>: ${src.error || (src.status === "unsupported" ? "Unsupported source" : "Load failed")}</div>`)}
		</div>
	`;
}

function renderBrowseEmptyState(visible: BrowsePackWire[]): TemplateResult {
	if (browseLoading && browsePacks.length === 0) return html`<p class="text-sm text-muted-foreground">Loading browse catalogue…</p>`;
	if (browseError) return html`<div class="market-error" data-testid="market-browse-error">${browseError}</div>`;
	if (browseSources.length === 0) return html`<p class="text-sm text-muted-foreground italic">No marketplace sources yet. Add a source in Sources, then return to Browse.</p>`;
	const selected = browseSources.filter((src) => enabledBrowseSourceIds.has(src.sourceId));
	if (selected.length === 0) return html`<p class="text-sm text-muted-foreground italic">No sources selected. Open Sources and select at least one source to browse packages.</p>`;
	const selectedIds = new Set(selected.map((src) => src.sourceId));
	const selectedPacks = browsePacks.filter((pack) => selectedIds.has(browsePackSourceId(pack)));
	const allSelectedFailed = selected.every((src) => src.status === "error" || src.status === "unsupported");
	if (allSelectedFailed) return html`<div class="market-error" data-testid="market-browse-error">Could not load selected sources.</div>`;
	if (selectedPacks.length === 0) {
		const okSelected = selected.filter((src) => src.status === "ok");
		return html`<p class="text-sm text-muted-foreground italic">${okSelected.length === 1 ? `${okSelected[0].sourceName} returned no supported packages.` : "Selected sources returned no supported packages."}</p>`;
	}
	if (visible.length === 0) return html`<p class="text-sm text-muted-foreground italic">${browseSearch.trim() ? `No packages match “${browseSearch.trim()}” in the selected sources.` : "No packages match the current source filter."}</p>`;
	return html``;
}

function renderBrowsePanel(): TemplateResult {
	const visible = filteredBrowsePacks();
	return html`
		<section class="market-panel" data-testid="market-browse-panel">
			<div class="flex items-center justify-between gap-2 flex-wrap">
				<h2 class="market-panel-title">${icon(Download, "sm")} Browse</h2>
				${renderScopePicker()}
			</div>
			${renderBrowseControls()}
			${renderBrowseWarnings()}
			${renderBrowseEmptyState(visible)}
			${visible.length ? html`<div class="flex flex-col gap-2">${visible.map(renderBrowsePackCard)}</div>` : ""}
		</section>
	`;
}

/** Find the installed copy of a browse pack AT THE CURRENTLY-SELECTED install
 *  scope (R4). For project scope the Installed list must be loaded for the
 *  picked project — if `installProjectId` and `currentProjectId()` diverge we
 *  treat the pack as not-installed for that project (avoids a wrong-project
 *  false positive; preserves finding #2). */
function installedMatchForBrowse(pack: BrowsePackWire): InstalledPackWire | undefined {
	if (installScope === "project") {
		if (!installProjectId || installProjectId !== currentProjectId()) return undefined;
		return installed.find((p) => p.scope === "project" && p.packName === pack.name);
	}
	return installed.find((p) => p.scope === installScope && p.packName === pack.name);
}

function mcpGatewayDiagnosticsSkippedCount(pack: BrowsePackWire): number {
	const diag = pack.mcpGatewayDiagnostics;
	if (Array.isArray(diag)) return diag.length;
	return diag?.skippedEntries?.length ?? 0;
}

function renderBrowsePackCard(pack: BrowsePackWire): TemplateResult {
	const installing = busy.has(`install:${pack.browseKey || `${pack.source?.id || "unknown"}:${pack.dirName}`}`);
	const match = installedMatchForBrowse(pack);
	const sourceName = pack.source?.name || (pack.builtin ? "Built-in" : "Unknown source");
	const sourceType = pack.source?.type || pack.sourceType || (pack.builtin ? "builtin" : "pack");
	const skippedDiagnostics = mcpGatewayDiagnosticsSkippedCount(pack);
	let action: TemplateResult;
	if (pack.builtin) {
		// Built-in (first-party) packs are resolved in place — provided, not
		// installable; manage them from the Installed tab's toggles (§4.4/§7.4).
		action = html`<span class="market-builtin-badge shrink-0" data-testid="market-browse-provided" title="Shipped with Bobbit — manage it from the Installed tab's toggles">Provided (built-in)</span>`;
	} else if (!match) {
		action = html`
			<button
				class="market-btn market-btn--primary shrink-0"
				data-testid="market-install-pack"
				?disabled=${installing}
				@click=${() => handleInstall(pack)}
			>${icon(Download, "xs")} ${installing ? "Installing…" : "Install"}</button>`;
	} else if (pack.version !== match.meta.version) {
		// Installed but behind the source's latest version → offer an update.
		const isBusy = busy.has(`${match.scope}:${match.packName}`);
		action = html`
			<button
				class="market-btn shrink-0"
				data-testid="market-browse-update-pack"
				?disabled=${isBusy}
				@click=${() => handleUpdate(match)}
			>${icon(RotateCw, "xs", isBusy ? "animate-spin" : "")} Update</button>`;
	} else {
		action = html`<span class="market-lozenge shrink-0" data-testid="market-browse-installed">${icon(Package, "xs")} Installed</span>`;
	}
	const entrypointNames = (pack.contents?.entrypoints ?? []).map((listName) => ({ listName }));
	return html`
		<div class="market-pack-card" data-testid="market-browse-pack" data-pack-name=${pack.name} data-browse-key=${pack.browseKey || ""}>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.name}</span>
						${pack.version ? html`<span class="text-[11px] text-muted-foreground">v${pack.version}</span>` : ""}
					</div>
					<div class="text-xs text-muted-foreground mt-0.5">${pack.description}</div>
					<div class="market-browse-provenance" data-testid="market-browse-provenance">
						<span class="market-lozenge market-lozenge--muted">source: ${sourceName}</span>
						<span class="market-source-type-chip" data-kind=${sourceType}>${sourceType}</span>
						${skippedDiagnostics ? html`<span class="market-lozenge market-lozenge--warning" title="Some gateway entries were skipped">${skippedDiagnostics} skipped</span>` : ""}
					</div>
					<div class="mt-1.5">${entityChips(pack)}</div>
					${renderEntityDetails(pack.name, pack.descriptions, {
						roles: pack.contents?.roles ?? [],
						tools: pack.contents?.tools ?? [],
						skills: pack.contents?.skills ?? [],
						entrypoints: entrypointNames,
						mcp: normalizedBrowseMcp(pack).map((e) => ({ ref: e.ref || e.listName || e.serverName || "mcp", label: e.label || e.serverName })),
						piExtensions: packPiExtensionRefs(pack).map((ref) => ({ ref })),
					})}
					${renderMcpTransportPreview(pack)}
				</div>
				${action}
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

/** §6.4/§7.4 — is the built-in row shadowed by a same-name user install?
 *
 *  The built-in band sits BELOW every user scope band, and the resolver /
 *  contribution registry collapse to ONE winning pack per packId by list position
 *  — so a same-name pack installed at ANY user scope (server/global-user/project)
 *  ALWAYS wins over the built-in, regardless of which entity kinds it ships. We
 *  therefore detect the shadow by the presence of a non-corrupt same-name install,
 *  NOT via `/api/packs/conflicts`: that endpoint only reports role/tool/skill
 *  conflicts, so an ENTRYPOINT/panel/route-only pack with empty role/tool/skill
 *  declarations would never appear there and the built-in row would wrongly stay
 *  live (the winner-owns-the-toggle rule broken).
 *  A `corrupt` install is excluded from resolution, so it never wins and never
 *  suppresses the built-in toggle. With no non-corrupt same-name install, the
 *  built-in row owns the live (server, packName) toggle. */
function builtinRowShadowed(packName: string): boolean {
	return installed.some(
		(p) => !p.builtin && p.packName === packName && p.status !== "corrupt",
	);
}

function renderInstalledPanel(): TemplateResult {
	const builtinPacks = installed.filter((p) => p.builtin);
	const scopesWithPacks = SCOPE_ORDER.filter((s) => packsForScope(s).length > 0);
	const isEmpty = builtinPacks.length === 0 && scopesWithPacks.length === 0;
	return html`
		<section class="market-panel" data-testid="market-installed-panel">
			<h2 class="market-panel-title">${icon(Package, "sm")} Installed</h2>
			${installedError ? html`<div class="market-error" data-testid="market-installed-error">${installedError}</div>` : ""}
			${isEmpty
				? html`<p class="text-sm text-muted-foreground italic">No packs installed.</p>`
				: html`
					${builtinPacks.length > 0 ? renderBuiltinGroup(builtinPacks) : ""}
					${scopesWithPacks.map(renderScopeGroup)}
				`}
		</section>
	`;
}

/** Built-in first-party packs (§7.4) — their own top group. Shipped/core, so the
 *  cards offer enable/disable toggles only (no Uninstall/Update/reorder). */
function renderBuiltinGroup(packs: InstalledPackWire[]): TemplateResult {
	return html`
		<div class="flex flex-col gap-1.5 mb-3" data-testid="market-builtin-group">
			<div class="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
				Built-in (shipped)
			</div>
			<div class="text-[10px] text-muted-foreground/80 -mt-0.5">Core features that ship with Bobbit. Disable to remove a feature; re-enable any time.</div>
			${packs.map(renderBuiltinPackCard)}
		</div>
	`;
}

/** A built-in first-party pack card (§7.4): toggle-only. No Uninstall/Update/
 *  reorder (not in `pack_order`, no install ledger). When a user-installed pack of
 *  the same name wins resolution (§6.4), the built-in row is SHADOWED — its server
 *  activation entry is moot, so the live toggles are suppressed and the winning
 *  installed row keeps its toggles. */
function renderBuiltinPackCard(pack: InstalledPackWire): TemplateResult {
	const isCorrupt = pack.status === "corrupt";
	const shadowed = builtinRowShadowed(pack.packName);
	return html`
		<div
			class="market-pack-card"
			data-testid="market-installed-pack"
			data-pack-name=${pack.packName}
			data-scope=${pack.scope}
			data-builtin="true"
		>
			<div class="flex items-start justify-between gap-3">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${pack.packName}</span>
						<span class="market-builtin-badge" data-testid="market-pack-builtin-badge">Built-in</span>
						<span class="text-[11px] text-muted-foreground">v${pack.meta?.version || pack.manifest?.version || "?"}</span>
						${isCorrupt ? html`<span class="market-corrupt" data-testid="market-pack-corrupt">${icon(AlertTriangle, "xs")} corrupt</span>` : ""}
					</div>
					${pack.manifest?.description ? html`<div class="text-xs text-muted-foreground mt-0.5">${pack.manifest.description}</div>` : ""}
					<div class="mt-1.5">${entityChips(pack)}</div>
				</div>
				${shadowed ? "" : renderPackActivationSummary(pack)}
			</div>
			${shadowed
				? html`<div class="market-activation-help text-[11px] text-muted-foreground/70 italic mt-2" data-testid="market-builtin-shadowed">Shadowed by an installed pack — manage activation on the installed copy.</div>`
				: html`${renderActivationControls(pack)}${renderActivationEntityDetails(pack)}`}
		</div>
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
					<div class="mt-1.5">${entityChips(pack)}</div>
					${renderProvenance(pack)}
					${expanded && hasConflict ? renderConflictDetails(packConflicts) : ""}
					${renderActivationControls(pack)}
					${renderActivationEntityDetails(pack)}
				</div>
				<div class="flex flex-col items-end gap-1 shrink-0">
					<div class="flex items-center gap-1">
						<button class="market-icon-btn" data-testid="market-move-up" title="Move up (lower precedence)" ?disabled=${index === 0} @click=${() => movePack(scope, pack.packName, -1)}>${icon(ChevronDown, "xs", "rotate-180")}</button>
						<button class="market-icon-btn" data-testid="market-move-down" title="Move down (higher precedence)" ?disabled=${index === total - 1} @click=${() => movePack(scope, pack.packName, 1)}>${icon(ChevronDown, "xs")}</button>
					</div>
					<div class="flex items-center gap-1">
						${pack.updateAvailable
							? html`<button class="market-btn" data-testid="market-update-pack" ?disabled=${isBusy} @click=${() => handleUpdate(pack)}>${icon(RotateCw, "xs", isBusy ? "animate-spin" : "")} Update</button>`
							: pack.sourceStatus === "unknown"
								? html`<span class="market-lozenge market-lozenge--warning" data-testid="market-source-unknown" title="The originating source is not registered or has not been synced — can't check for updates">${icon(AlertTriangle, "xs")} Source not found</span>`
								: ""}
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

/** Per-pack activation controls (pack schema V1 §9). Toggles ONLY user-facing
 *  entities — roles, tools, skills, entrypoints. Panels/routes/stores/renderers/
 *  actions/lib are support surfaces and are NOT toggleable (not shown as
 *  switches). Rendered SOLELY from the UNFILTERED `catalogue` returned by
 *  `GET /api/marketplace/pack-activation` (never from /api/tools or
 *  /api/ext/contributions), so a disabled entity stays visible + re-enableable;
 *  each toggle's checked state = `name ∉ disabled[kind]`. */
function renderPackActivationSummary(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation || activationEntityTotal(activation) === 0) return html``;
	const total = activationEntityTotal(activation);
	const enabled = activationEntityEnabledCount(activation);
	const label = enabled === total ? "Enabled" : enabled === 0 ? "Disabled" : "Partially enabled";
	const cacheKey = `${pack.scope}:${pack.packName}`;
	const busyKey = `activation:${cacheKey}:all`;
	return html`
		<label class="market-pack-activation-toggle" title="Enable or disable all pack entries">
			<span>${label}</span>
			<span class="market-toggle-switch market-toggle-switch--master">
				<input
					type="checkbox"
					data-testid="market-toggle-pack-${pack.packName}"
					.checked=${enabled > 0}
					?disabled=${busy.has(busyKey)}
					@change=${(e: Event) => handleToggleAllActivation(pack, (e.target as HTMLInputElement).checked)}
				/>
				<span class="market-toggle-slider"></span>
			</span>
		</label>
	`;
}

function activationEntityTotal(activation: PackActivationResponse): number {
	const cat = activation.catalogue;
	return cat.roles.length + cat.tools.length + cat.skills.length + cat.entrypoints.length + normalizedActivationMcp(cat.mcp).length + normalizedActivationPiExtensions(cat.piExtensions).length;
}

function activationEntityEnabledCount(activation: PackActivationResponse): number {
	const disabled = activation.disabled || {};
	const mcpEntries = normalizedActivationMcp(activation.catalogue.mcp);
	const disabledMcpCount = mcpEntries.filter((entry) => disabledMcpContribution(disabled, entry)).length;
	const disabledCount =
		(disabled.roles ?? []).length +
		(disabled.tools ?? []).length +
		(disabled.skills ?? []).length +
		(disabled.entrypoints ?? []).length +
		disabledMcpCount +
		(disabled.piExtensions ?? []).length;
	return Math.max(0, activationEntityTotal(activation) - disabledCount);
}

function entrypointKindLabel(kind: PackActivationResponse["catalogue"]["entrypoints"][number]["kind"]): string {
	switch (kind) {
		case "composer-slash": return "Slash";
		case "session-menu": return "Session menu";
		case "route": return "Route";
		default: return "Entry point";
	}
}

function entrypointDisplayLabel(entrypoint: PackActivationResponse["catalogue"]["entrypoints"][number]): string {
	if (entrypoint.kind === "route" && entrypoint.routeId) return `#/ext/${entrypoint.routeId}`;
	return entrypoint.label || entrypoint.listName;
}

function renderActivationEntityDetails(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation) return html``;
	const cat = activation.catalogue;
	return renderEntityDetails(pack.packName, cat.descriptions, {
		roles: cat.roles,
		tools: cat.tools,
		skills: cat.skills,
		entrypoints: cat.entrypoints.map((e) => ({ listName: e.listName, label: entrypointDisplayLabel(e) })),
		mcp: normalizedActivationMcp(cat.mcp).map((e) => ({ ref: e.ref, label: mcpEntryLabel(e) })),
		piExtensions: normalizedActivationPiExtensions(cat.piExtensions).map((e) => ({ ref: e.ref, label: piExtensionLabel(e) })),
	});
}

function mcpStatusText(status: string | undefined): string | undefined {
	switch (status) {
		case "overridden-by-manual": return "Manual config active";
		case "overridden-by-marketplace": return "Overridden";
		case "active-owner": return undefined;
		case "connected": return undefined;
		case "reconnecting": return "Reconnecting…";
		case "error": return "Error";
		case "disabled": return "Disabled";
		default: return undefined;
	}
}

function renderMcpRuntimeStatus(pack: InstalledPackWire, entry: PackActivationMcpEntry, checked: boolean, isBusy: boolean): TemplateResult {
	if (!checked) {
		return html`<span class="market-lozenge market-lozenge--muted" data-testid="market-mcp-status-${entry.ref}">Disabled</span>`;
	}
	if (isBusy) {
		return html`<span class="market-lozenge market-lozenge--warning" data-testid="market-mcp-status-${entry.ref}">Reconnecting…</span>`;
	}
	const ownerStatus = entry.ownerStatus || entry.status;
	const ownerText = mcpStatusText(ownerStatus);
	if (ownerText === "Manual config active" || ownerText === "Overridden") {
		const detail = entry.overriddenBy || entry.winningPack;
		return html`<span class="market-lozenge market-lozenge--info" data-testid="market-mcp-status-${entry.ref}" title=${detail ? `Winner: ${detail}` : ownerText}>${ownerText}</span>`;
	}
	const serverName = entry.serverName || entry.ref;
	const runtime = mcpRuntimeByScope.get(mcpRuntimeScopeKeyForPack(pack))?.get(serverName)
		|| (pack.scope === "project" ? undefined : mcpRuntimeByScope.get("default")?.get(serverName));
	const runtimeError = entry.error || runtime?.error;
	if (ownerText === "Error" || runtime?.status === "error" || runtimeError) {
		return html`
			<span class="market-lozenge market-lozenge--error" data-testid="market-mcp-status-${entry.ref}">Error</span>
			${runtimeError ? html`<span class="market-mcp-error" data-testid="market-mcp-error-${entry.ref}" title=${runtimeError}>${runtimeError}</span>` : ""}
		`;
	}
	if (runtime?.status === "connected" || ownerStatus === "connected") {
		const totalOps = entry.totalOperationCount ?? entry.operations?.length ?? runtime?.toolCount ?? entry.toolCount;
		const selectedOps = entry.selectedOperationCount ?? (typeof totalOps === "number" ? Math.max(0, totalOps - (entry.disabledOperations?.length ?? 0)) : undefined);
		const opSummary = typeof totalOps === "number"
			? (typeof selectedOps === "number" && selectedOps !== totalOps ? ` · ${selectedOps}/${totalOps} ops enabled` : ` · ${totalOps} ops`)
			: "";
		return html`
			<span class="market-lozenge market-lozenge--positive" data-testid="market-mcp-status-${entry.ref}">Connected${opSummary}</span>
			<span class="market-mcp-policy-link" data-testid="market-mcp-policy-link-${entry.ref}">Policy in Tools</span>
		`;
	}
	return html`<span class="market-lozenge market-lozenge--warning" data-testid="market-mcp-status-${entry.ref}">${ownerText || "Not loaded"}</span>`;
}

function piExtensionStatusLabel(status: PiExtensionDiagnostic["status"] | undefined): string {
	switch (status) {
		case "ok": return "Ready";
		case "disabled": return "Disabled";
		case "unresolved": return "Unresolved";
		case "discovery-failed": return "Discovery failed";
		case "runtime-load-failed": return "Runtime load failed";
		case "remap-failed": return "Sandbox remap failed";
		default: return "Pending discovery";
	}
}

function piExtensionStatusClass(status: PiExtensionDiagnostic["status"] | undefined): string {
	switch (status) {
		case "ok": return "market-lozenge--positive";
		case "disabled": return "market-lozenge--muted";
		case "unresolved":
		case "discovery-failed":
		case "runtime-load-failed":
		case "remap-failed": return "market-lozenge--error";
		default: return "market-lozenge--warning";
	}
}

function renderMcpOperationPolicy(op: PackActivationMcpOperationEntry): string {
	if (op.disabledByActivation || op.selected === false) return "Disabled";
	if (op.policy === "never") return "Never in Tools";
	if (op.policy === "allow") return "Allow in Tools";
	if (op.policy === "ask") return "Ask in Tools";
	return op.policyKey ? "Policy in Tools" : "Policy in Tools";
}

function renderMcpOperationSection(pack: InstalledPackWire, activation: PackActivationResponse, entry: PackActivationMcpEntry): TemplateResult {
	const rows = mcpOperationRows(activation, entry);
	const key = mcpContributionKey(entry);
	if (rows.length === 0) {
		if (!entry.contributionId && !entry.gatewayProviderId && !entry.sourceId) return html``;
		return html`<div class="market-activation-help" data-testid="market-operation-empty-${key}">Operation list unavailable until the server connects.</div>`;
	}
	return html`
		<div class="market-mcp-operation-list" data-testid="market-operation-list-${key}">
			${rows.map((op) => {
				const checked = op.selected !== false && !op.disabledByActivation;
				const busyKey = `activation:${pack.scope}:${pack.packName}:mcp-op:${key}:${op.name}`;
				return html`
					<label class="market-mcp-operation-row ${checked ? "" : "market-mcp-operation-row--disabled"} ${op.stale ? "market-mcp-operation-row--stale" : ""}" data-testid="market-operation-row-${op.name}">
						<span class="market-toggle-switch">
							<input
								type="checkbox"
								data-testid="market-toggle-operation-${op.name}"
								.checked=${checked}
								?disabled=${busy.has(busyKey)}
								@change=${(e: Event) => handleToggleMcpOperation(pack, entry, op.name, (e.target as HTMLInputElement).checked)}
							/>
							<span class="market-toggle-slider"></span>
						</span>
						<span class="market-mcp-operation-main">
							<span class="market-mcp-operation-name">${op.label && op.label !== op.name ? html`${op.label} · ` : ""}<code>${op.name}</code></span>
							${op.description ? html`<span class="market-mcp-operation-desc">${op.description}</span>` : ""}
						</span>
						<span class="market-mcp-operation-policy" data-testid="market-operation-policy-link-${op.name}" title=${op.policyKey || "Tools policy"}>${op.stale ? "No longer provided" : renderMcpOperationPolicy(op)}</span>
						${busy.has(busyKey) ? html`<span class="market-lozenge market-lozenge--warning">Saving…</span>` : ""}
					</label>
				`;
			})}
		</div>
	`;
}

function renderPiExtensionRuntimeStatus(entry: PackActivationPiExtensionEntry, checked: boolean): TemplateResult {
	if (!checked) return html`<span class="market-lozenge market-lozenge--muted" data-testid="market-pi-extension-status-${entry.ref}">Disabled</span>`;
	const diagnostic = entry.diagnostic;
	const tools = entry.tools ?? [];
	return html`
		<span class="market-lozenge ${piExtensionStatusClass(diagnostic?.status)}" data-testid="market-pi-extension-status-${entry.ref}" title=${diagnostic?.message ?? "Pi extension runtime status"}>${piExtensionStatusLabel(diagnostic?.status)}</span>
		${entry.entryRelativePath ? html`<span class="market-pi-extension-path" title=${entry.entryRelativePath}>${entry.entryRelativePath}</span>` : ""}
		${tools.length ? html`<span class="market-mcp-policy-link" data-testid="market-pi-extension-tools-${entry.ref}">${tools.length} discovered tool${tools.length === 1 ? "" : "s"} · Policy in Tools</span>` : ""}
		${diagnostic?.message && diagnostic.status !== "ok" ? html`<span class="market-pi-extension-diagnostic" data-testid="market-pi-extension-diagnostic-${entry.ref}" title=${diagnostic.message}>${diagnostic.message}</span>` : ""}
	`;
}

function renderActivationControls(pack: InstalledPackWire): TemplateResult {
	const activation = activationByPack.get(`${pack.scope}:${pack.packName}`);
	if (!activation) return html``;
	const cat = activation.catalogue;
	const disabled = activation.disabled || {};
	const isEnabled = (kindKey: ActivationArrayKey, name: string) => !(disabled[kindKey] ?? []).includes(name);

	const toggle = (
		kind: "role" | "tool" | "skill" | "entrypoint" | "mcp" | "pi-extension",
		name: string,
		label: string,
		kindLabel?: string,
		afterLabel?: TemplateResult,
	): TemplateResult => {
		const kindKey = ACTIVATION_KIND_KEY[kind];
		const checked = isEnabled(kindKey, name);
		const busyKey = `activation:${pack.scope}:${pack.packName}:${kind}:${name}`;
		return html`
			<label class="market-activation-toggle ${checked ? "" : "market-activation-toggle--off"}" title=${kindLabel ? `${kindLabel}: ${name}` : `${kind}: ${name}`}>
				<span class="market-toggle-switch">
					<input
						type="checkbox"
						data-testid="market-toggle-${kind}-${name}"
						.checked=${checked}
						?disabled=${busy.has(busyKey)}
						@change=${(e: Event) => handleToggleActivation(pack, kind, name, (e.target as HTMLInputElement).checked)}
					/>
					<span class="market-toggle-slider"></span>
				</span>
				${kindLabel ? html`<span class="market-entrypoint-kind">${kindLabel}</span>` : ""}
				<span class="market-activation-label">${label}</span>
				${afterLabel ?? ""}
			</label>
		`;
	};

	const group = (title: string, toggles: TemplateResult[], testId?: string, help?: TemplateResult): TemplateResult => html`
		<div class="market-activation-group">
			<div class="market-activation-group-title">${title}</div>
			<div data-testid=${testId || ""}>
				<div class="market-activation-toggles">${toggles}</div>
				${help ?? ""}
			</div>
		</div>
	`;

	const groups: TemplateResult[] = [];
	if (cat.roles.length) groups.push(group("Roles", cat.roles.map((n) => toggle("role", n, n))));
	if (cat.tools.length) groups.push(group("Tools", cat.tools.map((n) => toggle("tool", n, n))));
	if (cat.skills.length) groups.push(group("Skills", cat.skills.map((n) => toggle("skill", n, n))));
	if (cat.entrypoints.length) {
		groups.push(group("Entry points", cat.entrypoints.map((e) => toggle("entrypoint", e.listName, entrypointDisplayLabel(e), entrypointKindLabel(e.kind)))));
	}
	const mcpEntries = normalizedActivationMcp(cat.mcp);
	if (mcpEntries.length) {
		groups.push(group(
			"MCP servers",
			mcpEntries.map((entry) => {
				const key = mcpContributionKey(entry);
				const checked = !disabledMcpContribution(disabled, entry);
				const busyKey = `activation:${pack.scope}:${pack.packName}:mcp:${key}`;
				const rows = mcpOperationRows(activation, entry);
				const totalOps = entry.totalOperationCount ?? rows.filter((op) => !op.stale).length;
				const selectedOps = entry.selectedOperationCount ?? rows.filter((op) => !op.stale && op.selected !== false && !op.disabledByActivation).length;
				return html`
					<div class="market-mcp-contribution" data-testid="market-installed-operation-section-${pack.packName}" data-contribution-id=${key}>
						${toggle("mcp", key, mcpEntryLabel(entry), undefined, renderMcpRuntimeStatus(pack, entry, checked, busy.has(busyKey)))}
						${typeof totalOps === "number" && totalOps > 0
							? html`<div class="market-mcp-operation-summary" data-testid="market-mcp-operation-summary-${key}">${selectedOps}/${totalOps} operations enabled</div>`
							: ""}
						${renderMcpOperationSection(pack, activation, entry)}
					</div>
				`;
			}),
			"market-activation-mcp-group",
			html`<div class="market-activation-help">Activation controls whether this MCP server is installed into Bobbit. Operation selection controls which gateway operations exist; allow/ask/never policy is managed on the Tools page.</div>`,
		));
	}
	const piExtensionEntries = normalizedActivationPiExtensions(cat.piExtensions);
	if (piExtensionEntries.length) {
		groups.push(group(
			"Pi extensions",
			piExtensionEntries.map((entry) => {
				const checked = isEnabled("piExtensions", entry.ref);
				return toggle("pi-extension", entry.ref, piExtensionLabel(entry), undefined, renderPiExtensionRuntimeStatus(entry, checked));
			}),
			"market-activation-pi-extension-group",
			html`<div class="market-activation-help">Pi extensions are host-code/runtime extensions loaded into every matching agent session when enabled. Discovered tools appear on the Tools page for allow/ask/never policy.</div>`,
		));
	}
	if (groups.length === 0) return html``;

	return html`
		<div class="market-activation" data-testid="market-activation-${pack.packName}">
			${groups}
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
				${renderResearchPreviewBanner()}
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
		<div class="flex-1 flex flex-col h-full" @click=${() => closeBrowseSourceMenu()}>
			${renderNavBar()}
			${renderResearchPreviewBanner()}
			${renderTabBar()}
			<div class="flex-1 overflow-y-auto">
				<div class="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
					${panel}
				</div>
			</div>
		</div>
	`;
}
