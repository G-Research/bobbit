import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "../ui/components/BellToggle.js";
import "../ui/components/CommentableMarkdown.js";
import { renderFiltersButton } from "../ui/components/sidebar-filters.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, render, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type Sortable from "sortablejs";
import { shortcutHint } from "./shortcut-registry.js";
import { AlertTriangle, Archive, ArrowLeft, ExternalLink, FolderPlus, MessageCircleQuestion, Menu, MessagesSquare, ChevronDown, Goal as GoalIcon, PanelRightClose, PanelRightOpen, Plus, QrCode, RotateCw, Server, Settings, Store, Unplug, Users, Workflow as WorkflowIcon, Wrench, X, Zap } from "lucide";
import {
	state,
	renderApp,
	setProjects,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	getSidebarData,
	setRenderSuppressed,
	type GatewaySession,
	type Project,
} from "./state.js";
import { fetchAppInfo, fetchProjects, gatewayFetch, retryLoadSessions, resumeGoalWithDialog, isGoalPauseResumeActionPending, type AppInfo } from "./api.js";
import { headerToast, showHeaderToast } from "./header-toast.js";
export { showHeaderToast } from "./header-toast.js";
import { clearAllAnnotations, getDocumentAnnotationCount, markReviewSubmitted, flushPendingWrites } from "../ui/components/review/AnnotationStore.js";
import { loadReviewSources } from "./review-sources-lazy.js";
import { backToSessions, createAndConnectSession } from "./session-manager.js";
import { buildArchivedSessionActions, buildSessionActions, isArchivedSessionActionSource, resetSessionForkNewWorktree, type SessionActionDescriptor } from "./session-actions.js";
import type { SidebarActionsPopover, SidebarActionsPopoverItem } from "../ui/components/SidebarActionsPopover.js";
import { captureHeaderSessionActionSourceRects, type SidebarActionsFlipRect } from "../ui/components/sidebar-actions-flip.js";
// Lazy wrapper for the proposal-panels chunk. Static import here keeps
// the wrapper itself in the entry bundle while the ~80 kB body of
// goal/role/tool/staff/project preview panels lands on first view.
import * as lazyProposalPanels from "./proposal-panels-lazy.js";
// Re-export functions whose home moved during the proposal-panels extraction
// (see docs/design/shrink-initial-bundle.md, Task G). Test fixtures and a few
// external entry points still import from `render.ts` — keep them working.
export { setSelectedWorkflowId } from "./proposal-panels-lazy.js";

// Route every dialog open through the lazy wrappers so the ~66 kB
// `dialogs.ts` chunk stays out of the entry bundle. Each wrapper
// fires the same shared `import("./dialogs.js")` on first use; the
// chunk is shared across all UI surfaces that open dialogs.
import { openGatewayDialog, showQrCodeDialog, showSupportDialog, showGoalDialog, showProjectDialog } from "./dialogs-lazy.js";
import { startNewGoalFlow } from "./goal-entry.js";
import { HEADQUARTERS_ACCENT_COLOR, HEADQUARTERS_HELPER_TEXT, HEADQUARTERS_PROJECT_ID, defaultCwdForProjectSession, isHeadquartersProject, projectIconComponent, projectIconKind, projectIconTestId } from "./headquarters.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown, filterStaffByQuery, renderStaffSidebarSection, isProjectReordering, projectOrderForRender, renderProjectReorderHandle, renderProjectReorderLiveRegion, handleSidebarSearchInput, handleSidebarSearchClear, renderArchivedSearchControls, filterSidebarTreeModelGoalsForSearch, collectSidebarSearchSessionRetention } from "./sidebar.js";
import { buildSidebarTree, type GoalContext, type SidebarProjectTree, type SidebarTreeNode } from "./sidebar-tree-builder.js";
import { loadSidebarTreeLayoutPreference, sidebarTreeBaseIndentStyle, sidebarTreeHalfIndentStyle, sidebarTreeNodeIndentStyle } from "./sidebar-tree-layout.js";
import { isClientDebugEnabled, dumpClientDebugToComposer, registerDebugSection } from "./client-debug.js";
import { fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated } from "./api.js";
import { setArchivedSectionExpanded, setUngroupedExpanded, sidebarTreeExpansionInput, toggleProjectExpanded } from "./sidebar-tree-state.js";
// Register search web components
// <search-box> + <search-results> appear in the mobile landing + search
// route. Lazy-load via the shared widgets registrar so their combined
// ~9 kB stays out of entry; Lit upgrades the unknown tag once the
// chunk lands. The mobile landing's first render shows an unupgraded
// `<search-box>` for ~50 ms which is visually identical (the element
// is empty until properties are applied anyway).
import { ensureSearchBox } from "./lazy-widgets.js";
void ensureSearchBox();
// Register review pane web components. <review-pane> and
// <commentable-markdown> are cheap shells; their connectedCallback
// lazy-loads <review-document> + <annotation-popover> + the
// @recogito/text-annotator chain. Keep this import static so the
// shell elements upgrade synchronously on first render.
import "../ui/components/review/ReviewPane.js";
// Register inbox panel web components
import "../ui/inbox/InboxPanel.js";

import { renderGoalGroup, renderTreeSessionNode, renderSandboxIndicator, getProjectAccentColor, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery, passesSidebarFilters, isChildSession, isStandaloneArchivedSession, effectiveArchivedTeamGoalId, archivedDivider, bucketActiveArchived } from "./render-helpers.js";
import { PROPOSAL_TYPES, type ProposalType } from "./proposal-registry.js";
import {
	CHAT_PANEL_TAB_ID,
	activeSidePanelTabIdForSession,
	assistantProposalType,
	buildPanelWorkspaceTabs,
	findPanelTab,
	isHistoricalPreviewTab,
	isHistoricalProposalTab,
	isLivePreviewTab,
	isPinnedPanelTab,
	nextActivePanelTabId,
	normalizePreviewContentHash,
	normalizeSidePanelTabs,
	panelContentTabs,
	panelTabsForSession,
	panelWorkspaceSessionKey,
	previewContentHashFromTab,
	previewTabDisplayTitle,
	previewTabVersion,
	previewVersionRecordFor,
	reviewDocumentIdFromPanelTab,
	reviewPanelTabId,
	reviewTitleFromPanelTab,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	packPanelRefFromTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import { openInboxPanel } from "./inbox-panel.js";
import { renderPackPanelContent } from "./pack-panels.js";
import {
	closeSidePanelTab as closeServerSidePanelTab,
	getSidePanelWorkspace,
	reorderSidePanelTabs,
	setActiveSidePanelTab as setServerActiveSidePanelTab,
	setSidePanelSizeMode as setServerSidePanelSizeMode,
} from "./side-panel-workspace.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

let settingsAppInfo: AppInfo | null = null;
let settingsAppInfoLoadStarted = false;

function loadSettingsAppInfo(): void {
	if (settingsAppInfoLoadStarted) return;
	settingsAppInfoLoadStarted = true;
	fetchAppInfo().then(info => {
		settingsAppInfo = info;
		renderApp();
	});
}

function settingsAppVersionLabel(info: AppInfo): string {
	return `Bobbit v${info.version}${info.buildType === "source" ? ` [${info.commitSha || "source"}]` : ""}`;
}

function renderSettingsAppVersionHeaderSlot() {
	if (!settingsAppInfo) return html``;
	return html`
		<div class="flex items-center px-3" data-testid="settings-version-header-slot">
			<span
				class="text-xs text-muted-foreground whitespace-nowrap"
				data-testid="settings-app-version"
				title=${settingsAppInfo.buildType === "source" ? "Running from source" : "Running from an installed build"}
			>${settingsAppVersionLabel(settingsAppInfo)}</span>
		</div>
	`;
}

// ──────────────────────────────────────────────────────────────────────
// Splash-screen new-session gating
//
// 0 projects → button label becomes "New Project" → showProjectDialog().
// 1 project  → "New Session" creates a session bound to that project.
// ≥2 projects → "New Session" opens a small project picker popover.
//
// All paths always pass an explicit projectId so the server's
// resolveProjectForRequest() never 400s with "projectId required".
// ──────────────────────────────────────────────────────────────────────
let _splashPickerAnchorRect: DOMRect | null = null;

function _headquartersHiddenWithNoVisibleProjects(): boolean {
	return state.projects.length === 0 && state.showHeadquartersInProjectLists === false;
}

function _splashSessionLabel(): string {
	if (_headquartersHiddenWithNoVisibleProjects()) return "Quick Session";
	return state.projects.length === 0 ? "New Project" : "Quick Session";
}

function _splashSessionIcon() {
	return state.projects.length === 0 && !_headquartersHiddenWithNoVisibleProjects() ? icon(FolderPlus, "sm") : icon(Plus, "sm");
}

async function _showHeadquartersInProjectLists(): Promise<void> {
	state.showHeadquartersInProjectLists = true;
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showHeadquartersInProjectLists: true }),
		});
		setProjects(await fetchProjects());
		showHeaderToast("Headquarters shown in project lists.");
	} catch {
		state.showHeadquartersInProjectLists = false;
		showHeaderToast("Failed to show Headquarters.");
	} finally {
		renderApp();
	}
}

function _quickSessionInHeadquarters(): void {
	createAndConnectSession(undefined, undefined, undefined, undefined, undefined, HEADQUARTERS_PROJECT_ID);
}

function _onSplashSessionClick(e: Event): void {
	// Prevent bubble-to-document so the global outside-click handler below
	// doesn't immediately close the picker we're about to open.
	e.stopPropagation();
	const projects = state.projects;
	if (projects.length === 0) {
		if (_headquartersHiddenWithNoVisibleProjects()) _quickSessionInHeadquarters();
		else showProjectDialog();
		return;
	}
	if (projects.length === 1) {
		const p = projects[0];
		createAndConnectSession(undefined, undefined, defaultCwdForProjectSession(p), undefined, undefined, p.id);
		return;
	}
	// ≥2 projects — open the splash project picker, anchored at the button.
	const btn = e.currentTarget as HTMLElement | null;
	_splashPickerAnchorRect = btn ? btn.getBoundingClientRect() : null;
	state.splashProjectPickerOpen = true;
	renderApp();
}

function _hiddenHeadquartersFallback() {
	if (!_headquartersHiddenWithNoVisibleProjects()) return "";
	return html`
		<div class="flex flex-col items-center justify-center gap-3 text-center" data-testid="headquarters-hidden-fallback">
			<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
			<div class="flex flex-col gap-1">
				<p class="text-sm font-medium text-foreground">Headquarters is hidden from project lists.</p>
				<p class="text-xs text-muted-foreground max-w-md">Hiding only removes the shortcut. Headquarters sessions, staff, goals, and server configuration are kept.</p>
			</div>
			<div class="flex flex-wrap items-center justify-center gap-2">
				${Button({
					variant: "default",
					size: "sm",
					disabled: state.creatingSession,
					onClick: () => _quickSessionInHeadquarters(),
					children: state.creatingSession ? "Creating…" : "Quick Session in Headquarters",
				})}
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => { void _showHeadquartersInProjectLists(); },
					children: "Show Headquarters",
				})}
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => showProjectDialog(),
					children: "Add Project",
				})}
			</div>
		</div>
	`;
}

function _splashProjectPicker() {
	if (!state.splashProjectPickerOpen) return "";
	const projects = state.projects;
	const MARGIN = 8;
	const width = Math.min(280, window.innerWidth - MARGIN * 2);
	const rect = _splashPickerAnchorRect;
	const top = rect ? rect.bottom + 4 : 80;
	// Center horizontally on the anchor when possible, else on viewport.
	const anchorCx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
	let left = anchorCx - width / 2;
	left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
	return html`
		<div
			data-testid="splash-project-picker"
			class="fixed z-50 rounded-md shadow-lg py-1"
			style="background: var(--popover); border: 1px solid var(--border); width:${width}px; top:${top}px; left:${left}px; max-height:60vh; overflow-y:auto;"
			@click=${(e: Event) => e.stopPropagation()}
		>
			<div class="px-3 pt-2 pb-1.5 text-xs font-semibold text-foreground">New session in…</div>
			${projects.map(p => {
				const isDark = document.documentElement.classList.contains("dark");
				const color = isHeadquartersProject(p)
					? HEADQUARTERS_ACCENT_COLOR
					: isDark
						? (p.colorDark || p.color || "var(--muted-foreground)")
						: (p.colorLight || p.color || "var(--muted-foreground)");
				return html`
					<button
						class="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/50 active:bg-secondary text-foreground flex items-center gap-2"
						data-testid="splash-project-picker-item"
						@click=${() => {
							state.splashProjectPickerOpen = false;
							createAndConnectSession(undefined, undefined, defaultCwdForProjectSession(p), undefined, undefined, p.id);
						}}
					>
						<span class="shrink-0 inline-flex items-center" data-testid=${projectIconTestId(p)} data-project-icon=${projectIconKind(p)} style="color:${color};">${icon(projectIconComponent(p), "sm")}</span>
						<span class="flex-1 min-w-0 flex flex-col">
							<span class="truncate">${p.name}</span>
							${isHeadquartersProject(p) ? html`<span class="text-xs text-muted-foreground leading-tight">${HEADQUARTERS_HELPER_TEXT}</span>` : nothing}
						</span>
					</button>
				`;
			})}
		</div>
	`;
}

// Close splash picker on outside click / Escape.
document.addEventListener("click", () => {
	if (state.splashProjectPickerOpen) {
		state.splashProjectPickerOpen = false;
		renderApp();
	}
});
document.addEventListener("keydown", (e: KeyboardEvent) => {
	if (state.splashProjectPickerOpen && e.key === "Escape") {
		state.splashProjectPickerOpen = false;
		renderApp();
	}
});

window.addEventListener("bobbit-open-review-document", (e: Event) => {
	void (async () => {
		try {
			const { openReviewDocumentFromEvent } = await loadReviewSources();
			const doc = openReviewDocumentFromEvent((e as CustomEvent).detail, activeSessionId() || "");
			if (!doc) showHeaderToast("Could not open review document");
		} catch {
			showHeaderToast("Could not open review document");
		}
	})();
});

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute, isRouteActive, toggleConfigPage } from "./routing.js";
import { getActiveNavId } from "./sidebar-nav.js";
import { lookupPackRoute } from "./pack-entrypoints.js";
import { bobbitLoadingAnimation } from "../ui/components/BobbitLoadingAnimation.js";
import "./config-scope.css";

// ---------------------------------------------------------------------------
// Lazy route page loader — see docs/design/ui-bundle-size-reduction.md (Task A)
// ---------------------------------------------------------------------------
const _pageCache: Record<string, ((...args: unknown[]) => unknown)> = {};
const _pageLoading: Record<string, boolean> = {};

/** Centred placeholder while a route chunk is in-flight. */
function loadingPlaceholder() {
	return html`<div class="flex-1 min-h-0 flex items-center justify-center">${bobbitLoadingAnimation()}</div>`;
}

/**
 * Dynamic-import a route page module on first access. Caches the named export
 * in module scope and triggers `renderApp()` once the chunk lands so the
 * placeholder is replaced with the real page on the next paint.
 */
function lazyPage(
	key: string,
	importer: () => Promise<Record<string, unknown>>,
	exportName: string,
) {
	const fn = _pageCache[key];
	if (fn) return fn();
	if (!_pageLoading[key]) {
		_pageLoading[key] = true;
		importer().then((m) => {
			const exp = m[exportName];
			if (typeof exp === "function") {
				_pageCache[key] = exp as (...args: unknown[]) => unknown;
			}
			renderApp();
		}).catch((err) => {
			_pageLoading[key] = false;
			console.error(`Failed to load page chunk "${key}":`, err);
		});
	}
	return loadingPlaceholder();
}

/**
 * Call a named export on a lazy-loaded page module. If `loadIfMissing` is
 * true (default), the chunk is fetched and the export is invoked on arrival.
 * If false, this is a no-op when the chunk hasn't been loaded yet — used for
 * "cleanup on leave" hooks like `resetSearchPage` where there's nothing to
 * clean up if the page was never visited.
 */
function lazyPageCall(
	key: string,
	importer: () => Promise<Record<string, unknown>>,
	exportName: string,
	loadIfMissing = true,
): void {
	const cacheKey = `${key}:${exportName}`;
	const fn = _pageCache[cacheKey];
	if (fn) {
		fn();
		return;
	}
	if (!loadIfMissing) return;
	if (_pageLoading[cacheKey]) return;
	_pageLoading[cacheKey] = true;
	importer().then((m) => {
		const exp = m[exportName];
		if (typeof exp === "function") {
			_pageCache[cacheKey] = exp as (...args: unknown[]) => unknown;
			(exp as () => void)();
		}
	}).catch(() => { _pageLoading[cacheKey] = false; });
}

// ============================================================================
// CLIENT DEBUG (flag-gated diagnostics — see client-debug.ts)
// ============================================================================

// Register an "App state" section for the client-debug report (client-debug.ts
// stays generic / DOM-only; render.ts has access to app state + routing). Add
// more sections here or from other modules via registerDebugSection().
registerDebugSection("App state", () => {
	const route = getRouteFromHash();
	const activeSid = activeSessionId();
	return [
		`route=${JSON.stringify(route)}`,
		`appView=${state.appView}  connection=${state.connectionStatus}`,
		`activeSessionId=${activeSid ?? "(none)"}  remoteAgent=${state.remoteAgent ? state.remoteAgent.gatewaySessionId : "(none)"}`,
		`goals=${state.goals.length}  gatewaySessions=${state.gatewaySessions.length}  archivedSessions=${state.archivedSessions.length}`,
		`activeProjectId=${state.activeProjectId ?? "(none)"}  projects=${state.projects.length}`,
		`sessionsLoading=${state.sessionsLoading}  sessionsError=${state.sessionsError ?? "(none)"}`,
		`theme=${document.documentElement.classList.contains("dark") ? "dark" : "light"}  palette=${document.documentElement.dataset.palette || "(default)"}`,
		`subgoalsEnabled=${document.documentElement.dataset.subgoalsEnabled === "true"}`,
	].join("\n");
});

/** Flag-gated floating "DBG" button (desktop + mobile). Dumps the client-debug
 *  report into the composer. Fixed-position so it's layout-independent; hidden
 *  unless Debug mode is on (Settings → dev-harness footer). Shows a short build
 *  id so you can confirm at a glance which build the device is actually running
 *  (the #1 question when iterating on a hard-to-reload installed PWA). */
function renderClientDebugButton() {
	if (!isClientDebugEnabled()) return "";
	const rawBuild = (globalThis as { __BOBBIT_BUILD_ID__?: string }).__BOBBIT_BUILD_ID__;
	const build = rawBuild ? rawBuild.slice(-6) : "dev";
	return html`
		<button
			data-testid="client-debug-button"
			@click=${() => dumpClientDebugToComposer()}
			style="position:fixed;left:8px;top:50%;transform:translateY(-50%);z-index:2147483646;background:color-mix(in oklch, var(--primary) 88%, black);color:var(--primary-foreground);font-size:10px;font-weight:700;letter-spacing:0.03em;padding:6px 8px;border:none;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.4);opacity:0.85;line-height:1.15;text-align:center;"
			title="Dump client debug report into the composer (build ${build})">DBG<br><span style="font-weight:500;opacity:0.85;">${build}</span></button>
	`;
}

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */

type RenderGoalGroupOptionsWithTree = NonNullable<Parameters<typeof renderGoalGroup>[1]> & { treeNode?: SidebarTreeNode<GoalContext> };
const renderGoalGroupWithTreeNode = renderGoalGroup as (
	goal: Parameters<typeof renderGoalGroup>[0],
	opts?: RenderGoalGroupOptionsWithTree,
) => ReturnType<typeof renderGoalGroup>;

function renderMobileGoalTreeNode(node: SidebarTreeNode<GoalContext>, archived = false): ReturnType<typeof html> {
	const goal = node.context.goal as Parameters<typeof renderGoalGroup>[0];
	const goalBody = renderGoalGroupWithTreeNode(goal, {
		descendantCount: node.context.descendantCount,
		displayTitleSuffix: node.context.displayTitleSuffix,
		treeNode: node,
	});
	const nestedGoalChildren = node.children.filter((child): child is SidebarTreeNode<GoalContext> =>
		child.kind === "goal"
		&& (child.context as GoalContext).renderPlacement === node.context.renderPlacement,
	);
	const { active: activeChildren, archived: archivedChildren, needsDivider } =
		bucketActiveArchived(nestedGoalChildren, child => child.context.archived);
	return html`
		<div
			data-testid=${archived ? "sidebar-archived-row" : nothing}
			data-tree-key=${node.key}
			data-goal-id=${goal.id}
			style="${sidebarTreeNodeIndentStyle(node)}"
		>
			${archived ? html`<div class="opacity-60">${goalBody}</div>` : goalBody}
		</div>
		${node.expanded ? html`
			${activeChildren.map(child => renderMobileGoalTreeNode(child, archived))}
			${needsDivider ? archivedDivider() : ""}
			${archivedChildren.map(child => renderMobileGoalTreeNode(child, archived))}
		` : ""}
	`;
}

function renderMobileGoalForest(nodes: readonly SidebarTreeNode<GoalContext>[], archived = false): ReturnType<typeof html> {
	const { active: activeNodes, archived: archivedNodes, needsDivider } =
		bucketActiveArchived([...nodes], node => node.context.archived);
	return html`
		${activeNodes.map((node, index) => html`
			${index > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
			${renderMobileGoalTreeNode(node, archived)}
		`)}
		${needsDivider ? archivedDivider() : ""}
		${archivedNodes.map((node, index) => html`
			${index > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
			${renderMobileGoalTreeNode(node, archived)}
		`)}
	`;
}

function renderMobileArchivedTreeSection(projectTree: SidebarProjectTree): ReturnType<typeof html> | string {
	if (!state.showArchived || !projectTree.archivedSectionNode) return "";
	const project = projectTree.project;
	const expanded = projectTree.archivedSectionNode.expanded;
	const archHeaderNavId = `archived-header:${project.id}`;
	const archHeaderActive = getActiveNavId() === archHeaderNavId;
	const dividerMy = "my-0.5";
	return html`
		<div class="border-t border-border/30 ${dividerMy} mx-2"></div>
		<div class="flex flex-col gap-0.5" data-tree-key=${projectTree.archivedSectionNode.key}>
			<button
				data-nav-id=${archHeaderNavId}
				data-nav-active=${archHeaderActive ? "true" : "false"}
				data-tree-key=${projectTree.archivedSectionNode.key}
				class="relative flex items-center gap-1 pr-1 py-0.5 w-full text-left ${archHeaderActive ? "bg-secondary text-foreground sidebar-session-active" : "active:bg-secondary/50"} rounded-md transition-colors"
				style="padding-left:var(--sidebar-header-chevron-w);"
				@click=${() => { setArchivedSectionExpanded(project.id, !expanded); renderApp(); }}
			>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none opacity-60"><span class="sidebar-chevron-glyph">${expanded ? "▾" : "▸"}</span></span>
				<span class="shrink-0 text-muted-foreground opacity-60">${icon(Archive, "sm")}</span>
				<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium opacity-60" style="font-size: 1.1667em;">Archived</span>
			</button>
			${expanded ? html`
				${projectTree.archivedGoalForest.length > 0 ? html`<div class="flex items-center gap-2 ${dividerMy} mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Goals</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${projectTree.archivedGoalForest.length > 0 ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeHalfIndentStyle()}">${renderMobileGoalForest(projectTree.archivedGoalForest, true)}</div>` : ""}
				${projectTree.archivedGoalForest.length > 0 && projectTree.archivedSessionNodes.length > 0 ? html`<div class="flex items-center gap-2 ${dividerMy} mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Sessions</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${projectTree.archivedSessionNodes.length > 0 ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
					${projectTree.archivedSessionNodes.map(node => renderTreeSessionNode(node))}
				</div>` : ""}
			` : ""}
		</div>
	`;
}

function renderMobileLanding() {
	const sidebarData = getSidebarData();
	const { liveGoals, archivedGoals } = sidebarData;

	const bypassFilters = !!state.searchQuery.trim();
	const query = state.searchQuery.trim();
	const queryLower = query.toLowerCase();
	const sessionMatchesQuery = (session: GatewaySession) =>
		(session.title?.toLowerCase().includes(queryLower) || session.role?.toLowerCase().includes(queryLower)) ?? false;
	const matchingLiveGoals = query
		? liveGoals.filter(goal => {
			const goalMatches = goal.title.toLowerCase().includes(queryLower);
			const goalSessions = state.gatewaySessions.filter(s => (s.goalId === goal.id || effectiveArchivedTeamGoalId(s) === goal.id) && !isChildSession(s));
			const hasMatchingSession = goalSessions.some(sessionMatchesQuery);
			return goalMatches || hasMatchingSession;
		})
		: liveGoals;
	const matchingArchivedGoals = query
		? filterArchivedGoalsByQuery(archivedGoals, state.gatewaySessions, state.archivedSessions, state.searchQuery)
		: archivedGoals;
	const searchRetention = query
		? collectSidebarSearchSessionRetention({
			visibleGoalIds: [...matchingLiveGoals, ...matchingArchivedGoals].map(goal => goal.id),
			goals: state.goals as any,
			liveSessions: state.gatewaySessions,
			archivedSessions: state.archivedSessions,
			sessionMatchesQuery,
		})
		: null;
	const visibleSearchGoalIds = searchRetention?.visibleGoalIds ?? null;
	const retainedSearchSessionIds = searchRetention?.retainedSessionIds ?? null;

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto sidebar-root" data-project-reordering=${isProjectReordering() ? "true" : "false"}>
			${renderProjectReorderLiveRegion()}
			<div class="w-full max-w-xl mx-auto px-2 py-2 pb-16 flex flex-col gap-0.5">
				<div class="flex flex-col gap-1 px-1 pb-2 mb-1 border-b border-border/30">
					${(() => {
						const isRolesActive = isRouteActive("roles", "role-edit");
						const isToolsActive = isRouteActive("tools", "tool-edit");
						const route = getRouteFromHash();
						const isWorkflowsActive = isRouteActive("workflows", "workflow-edit")
							|| (route.view === "settings" && (route as any).settingsTab === "workflows");
						const isSkillsActive = isRouteActive("skills");
						const isMarketActive = isRouteActive("market");
						return html`
					<div class="sidebar-top-action-row">
						<button class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage roles"
							@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); })}>
							<span class="sidebar-scale-icon">${icon(Users, "xs")}</span><span class="sidebar-top-action-label">Roles</span>
						</button>
						<button class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${isToolsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage tools"
							@click=${() => toggleConfigPage(["tools", "tool-edit"], () => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); })}>
							<span class="sidebar-scale-icon">${icon(Wrench, "xs")}</span><span class="sidebar-top-action-label">Tools</span>
						</button>
						<button class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="View skills"
							@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); setHashRoute("skills"); })}>
							<span class="sidebar-scale-icon">${icon(Zap, "xs")}</span><span class="sidebar-top-action-label">Skills</span>
						</button>
					</div>
					<div class="sidebar-top-action-row">
						<button class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${isWorkflowsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage workflows"
							@click=${() => {
								const projectId = state.activeProjectId || (state.projects[0]?.id ?? null);
								if (!projectId) { showProjectDialog(); return; }
								import("./workflow-page.js").then((m) => m.loadWorkflowPageData());
								setHashRoute("settings", `${projectId}/workflows`, true);
							}}>
							<span class="sidebar-scale-icon">${icon(WorkflowIcon, "xs")}</span><span class="sidebar-top-action-label">Workflows</span>
						</button>
						<button class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${isMarketActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							data-testid="market-nav-button-mobile"
							title="Marketplace"
							@click=${() => toggleConfigPage(["market"], () => { import("./marketplace-page.js").then((m) => m.loadMarketplaceData()); setHashRoute("market"); })}>
							<span class="sidebar-scale-icon">${icon(Store, "xs")}</span><span class="sidebar-top-action-label">Market</span>
						</button>
						<button
							data-new-goal-trigger
							class="sidebar-top-action-btn px-1.5 py-1 rounded transition-colors flex items-center justify-center ${state.projects.length === 0 ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							?disabled=${state.projects.length === 0}
							@click=${(e: Event) => {
								if (state.projects.length === 0) { showProjectDialog(); return; }
								startNewGoalFlow(e.currentTarget as HTMLElement);
							}}
							title=${state.projects.length === 0 ? "Add a project first" : `New goal${shortcutHint("new-goal")}`}>
							<span class="sidebar-scale-icon" data-testid="sidebar-new-goal-icon">${icon(GoalIcon, "xs")}</span><span class="sidebar-top-action-label">New Goal</span>
						</button>
					</div>
					`;
					})()}
				</div>
				<search-box
					.query=${state.searchQuery}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { handleSidebarSearchInput(e.detail.query); }}
					@search-clear=${() => { handleSidebarSearchClear(); }}
					@full-search-click=${(e: CustomEvent) => { setHashRoute("search", e.detail.query); }}
				></search-box>
				${state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-muted-foreground underline" title="Retry" @click=${retryLoadSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? html`<div class="text-center py-12 px-4">
									${_headquartersHiddenWithNoVisibleProjects() ? _hiddenHeadquartersFallback() : html`
										<div class="text-muted-foreground mb-3 empty-state-icon flex justify-center">${icon(Server, "lg")}</div>
										<p class="text-muted-foreground mb-4" style="font-size: 1.3333em;">No goals or sessions yet</p>
										<div class="flex items-center justify-center gap-2">
											${Button({
												variant: "default",
												onClick: (e?: Event) => startNewGoalFlow((e?.currentTarget as HTMLElement | null) ?? null),
												children: html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create a Goal</span>`,
											})}
											${Button({
												variant: "ghost",
												disabled: state.creatingSession,
												onClick: (e?: Event) => _onSplashSessionClick(e ?? new Event("click")),
												children: html`<span class="inline-flex items-center gap-1.5" data-testid="splash-quick-session-label">${_splashSessionIcon()} ${state.projects.length === 0 ? _splashSessionLabel() : "Quick Session"}</span>`,
											})}
											${_splashProjectPicker()}
										</div>
									`}
								</div>`
							: html`
								${(() => {
									// Build the mobile project/goal/session hierarchy through the shared tree model.
									let staffList = (state.staffList || []).filter(s => s.state !== "retired");
									if (query) staffList = filterStaffByQuery(staffList, queryLower);
									const projectsForRender = projectOrderForRender();
									const filteredStandaloneArchivedSessionIds = new Set(
										filterArchivedSessionsByQuery(state.archivedSessions.filter(isStandaloneArchivedSession), state.searchQuery).map(s => s.id),
									);
									const liveSessionInput = state.gatewaySessions.filter(session => {
										if (sidebarData.staffSessionIds.has(session.id)) return false;
										if (!query) return true;
										if (retainedSearchSessionIds!.has(session.id)) return true;
										if (isChildSession(session)) return false;
										const owningGoalId = session.goalId || effectiveArchivedTeamGoalId(session);
										if (owningGoalId) return visibleSearchGoalIds!.has(owningGoalId);
										return sessionMatchesQuery(session);
									});
									const archivedSessionInput = state.showArchived
										? state.archivedSessions.filter(session => {
											if (!query) return true;
											if (retainedSearchSessionIds!.has(session.id)) return true;
											if (isChildSession(session)) return false;
											const owningGoalId = session.goalId || session.teamGoalId || effectiveArchivedTeamGoalId(session);
											if (owningGoalId) return visibleSearchGoalIds!.has(owningGoalId);
											return isStandaloneArchivedSession(session) && filteredStandaloneArchivedSessionIds.has(session.id);
										})
										: [];
									const builtTreeModel = buildSidebarTree({
										projects: projectsForRender,
										goals: state.goals as any,
										sessions: liveSessionInput,
										archivedSessions: archivedSessionInput,
										staff: staffList,
										showArchived: state.showArchived,
										filters: {
											searchQuery: state.searchQuery,
											bypassBusyReadFilters: bypassFilters,
											activeSessionId: activeSessionId(),
											passesSessionFilters: (session, active, bypass) => retainedSearchSessionIds?.has((session as GatewaySession).id) || passesSidebarFilters(session as GatewaySession, active, bypass),
										},
										projectOrder: projectsForRender.map(project => project.id),
										viewport: "mobile",
										layout: loadSidebarTreeLayoutPreference(),
										expansion: sidebarTreeExpansionInput(),
									});
									const treeModel = visibleSearchGoalIds
										? filterSidebarTreeModelGoalsForSearch(builtTreeModel, visibleSearchGoalIds)
										: builtTreeModel;
									return html`<div data-project-reorder-list>${treeModel.projects.map((projectTree, i) => {
											const project = projectTree.project as Project;
											const expanded = projectTree.projectNode.expanded;
											const effectiveExpanded = isProjectReordering() ? false : expanded;
											const color = getProjectAccentColor(project);
											const projectSettingsTarget = isHeadquartersProject(project) ? "system/general" : `${project.id}/general`;
											return html`
												${i > 0 ? html`<div class="border-t border-border/30 my-0.5 mx-2"></div>` : ""}
												<div data-project-reorder-id=${project.id} data-project-id=${project.id} data-tree-key=${projectTree.projectNode.key}>
													<div
														data-testid="project-header"
														data-project-id=${project.id}
														data-tree-key=${projectTree.projectNode.key}
														class="flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
														@click=${() => { if (isProjectReordering()) return; toggleProjectExpanded(project.id); renderApp(); }}>
														<span class="sidebar-chevron-slot sidebar-chevron-slot--inline text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${effectiveExpanded ? "▾" : "▸"}</span></span>
														${renderProjectReorderHandle(project)}
														<span class="shrink-0 inline-flex items-center" data-testid=${projectIconTestId(project)} data-project-icon=${projectIconKind(project)} style="color:${color};">${icon(projectIconComponent(project), "sm")}</span>
													<span class="flex-1 min-w-0 flex flex-col leading-tight">
														<span class="truncate text-muted-foreground uppercase tracking-wider font-medium" style="color:${color};font-size: 1.1667em;">${project.name}</span>
													</span>
													<div class="flex items-center gap-2 shrink-0">
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", projectSettingsTarget); }}
															title=${isHeadquartersProject(project) ? "Headquarters settings" : "Project settings"}
														>${icon(Settings, "sm")}</button>
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors relative flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(undefined, project.id); }}
															title="New goal in ${project.name}"
														>
															<span class="sidebar-compound-icon sidebar-compound-icon--lg" data-testid="sidebar-add-goal-icon">
																${icon(GoalIcon, "sm", "sidebar-compound-base")}
																<svg data-testid="sidebar-add-goal-plus" class="sidebar-compound-plus" viewBox="0 0 10 10">
																	<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
																</svg>
															</span>
														</button>
													</div>
												</div>
												${effectiveExpanded ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
													${renderMobileGoalForest(projectTree.goalForest)}
													${projectTree.goalForest.length > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
													<div class="flex flex-col gap-0.5">
														${(() => { const _mobileUngroupedExp = projectTree.sessionsSectionNode.expanded; return html`<div class="flex items-center gap-1 pl-0 pr-2 py-0.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
															data-testid="sidebar-sessions-header"
															data-tree-key=${projectTree.sessionsSectionNode.key}
															@click=${() => { setUngroupedExpanded(project.id, !_mobileUngroupedExp); renderApp(); }}>
															<span class="sidebar-chevron-slot sidebar-chevron-slot--header text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${_mobileUngroupedExp ? "▾" : "▸"}</span></span>
															<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;margin-right:2px;">${icon(MessagesSquare, "sm")}</span>
															<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 1.1667em;">Sessions</span>
															<div class="flex items-center relative">
																<button
																	class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors relative shrink-0"
																	style="line-height:0;"
																	@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, defaultCwdForProjectSession(project), undefined, undefined, project.id); }}
																	title="New session in ${project.name}"
																>
																	<span class="sidebar-compound-icon sidebar-compound-icon--lg" data-testid="sidebar-add-session-icon">
																							${icon(MessagesSquare, "sm", "sidebar-compound-base")}
																							<svg data-testid="sidebar-add-session-plus" class="sidebar-compound-plus" viewBox="0 0 10 10">
																								<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
																							</svg>
																						</span>
																</button>
																<button
																	class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	style="line-height:0;"
																	@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e, undefined, { projectId: project.id, projectName: project.name, projectCwd: defaultCwdForProjectSession(project) }); }}
																	title="New session with role"
																><span class="sidebar-scale-icon">${icon(ChevronDown, "sm")}</span></button>
																${renderRolePickerDropdown()}
															</div>
														</div>
														${_mobileUngroupedExp && projectTree.ungroupedSessionNodes.length > 0 ? html`
															<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
																${projectTree.ungroupedSessionNodes.map(node => renderTreeSessionNode(node))}
															</div>
														` : ""}
													</div>`; })()}
													${renderStaffSidebarSection(projectTree.staffRows as typeof state.staffList, project.id, projectTree.staffSectionNode?.key, projectTree.staffSectionNode?.expanded)}
													${renderMobileArchivedTreeSection(projectTree)}
												</div>` : ""}
												</div>
											`;
										})}
										${renderArchivedSearchControls()}
										${state.showArchived && !state.searchQuery && (state.archivedGoalsHasMore || state.archivedSessionsHasMore) ? html`
											<div class="border-t border-border/30 my-0.5 mx-2"></div>
											<div class="flex flex-col gap-0.5 px-2">
												${state.archivedGoalsHasMore ? html`<button class="text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedGoalsPaginated(50, state.archivedGoalsCursor ?? undefined); }}>Load more archived goals…</button>` : ""}
												${state.archivedSessionsHasMore ? html`<button class="text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedSessionsPaginated(50, state.archivedSessionsCursor ?? undefined); }}>Load more archived sessions…</button>` : ""}
											</div>
										` : ""}</div>`;
								})()}
							`}
			</div>
		</div>
		<div class="fixed bottom-0 left-0 right-0 flex items-center justify-between px-4 py-2 border-t border-border bg-background z-10">
			${(() => { const isSettings = isRouteActive("settings"); return html`<button class="flex items-center gap-1.5 px-2 py-2.5 text-xs rounded transition-colors ${isSettings ? "text-primary bg-primary/10 font-medium" : "text-muted-foreground active:bg-secondary/50"}"
				@click=${() => { import("./settings-page.js").then((m) => m.toggleSettings()); }}
				title="Settings">
				${icon(Settings, "sm")}
				<span>Settings</span>
			</button>`; })()}
			${state.projects.length >= 1 ? html`<button class="flex items-center gap-1.5 px-2 py-2.5 text-xs text-muted-foreground active:bg-secondary/50 rounded transition-colors"
				@click=${() => showProjectDialog()}
				title="Add project">
				${icon(FolderPlus, "sm")}
				<span>Add Project</span>
			</button>` : ""}
			${renderFiltersButton("mobile")}
		</div>
	`;
}

interface OpenHeaderSessionActionsPopover {
	sessionId: string;
	element: SidebarActionsPopover;
	actions: SessionActionDescriptor[];
	refresh: () => SessionActionDescriptor[];
	cleanup?: () => void;
}

let _openHeaderSessionActionsPopover: OpenHeaderSessionActionsPopover | null = null;
let _headerSessionActionsPopoverRequestId = 0;

function headerDirectSessionActionLimit(): number {
	const width = window.innerWidth || document.documentElement.clientWidth || 1024;
	if (width < 760) return 1;
	if (width < 980) return 2;
	if (width < 1180) return 3;
	return 4;
}

function partitionHeaderSessionActions(actions: SessionActionDescriptor[], mobile: boolean): {
	directActions: SessionActionDescriptor[];
	overflowActions: SessionActionDescriptor[];
} {
	const firstTrailingActionIndex = actions.findIndex((action) => !!action.trailingToggle);
	const directLimit = firstTrailingActionIndex >= 0
		? Math.min(headerDirectSessionActionLimit(), firstTrailingActionIndex)
		: headerDirectSessionActionLimit();
	if (mobile) {
		return {
			directActions: actions.filter((action) => action.quick),
			overflowActions: actions,
		};
	}
	const directCount = Math.min(actions.length, directLimit);
	return {
		directActions: actions.slice(0, directCount),
		overflowActions: actions.slice(directCount),
	};
}

function toHeaderPopoverItems(actions: SessionActionDescriptor[]): SidebarActionsPopoverItem[] {
	return actions.map(({ id, label, title, icon: actionIcon, tone, quick, trailingToggle }) => ({
		id: String(id),
		label,
		title,
		icon: actionIcon,
		tone,
		quick: quick === true,
		trailingToggle,
	}));
}

function isHeaderSessionActionsPopoverOpen(sessionId: string): boolean {
	return _openHeaderSessionActionsPopover?.sessionId === sessionId
		&& _openHeaderSessionActionsPopover.element.open;
}

function closeHeaderSessionActionsPopover(renderAfterClose = true): void {
	_headerSessionActionsPopoverRequestId++;
	const current = _openHeaderSessionActionsPopover;
	if (!current) return;
	_openHeaderSessionActionsPopover = null;
	current.cleanup?.();
	current.element.open = false;
	try { current.element.remove(); } catch { /* ignore */ }
	if (renderAfterClose) renderApp();
}

function refreshOpenHeaderSessionActionsPopover(): void {
	const current = _openHeaderSessionActionsPopover;
	if (current) {
		current.actions = current.refresh();
		current.element.items = toHeaderPopoverItems(current.actions);
		return;
	}
	renderApp();
}

async function openHeaderSessionActionsPopover(input: {
	sessionId: string;
	trigger: HTMLElement;
	actions: SessionActionDescriptor[];
	refresh: () => SessionActionDescriptor[];
	sourceRects: SidebarActionsFlipRect[];
}): Promise<void> {
	if (isHeaderSessionActionsPopoverOpen(input.sessionId)) {
		closeHeaderSessionActionsPopover();
		return;
	}
	closeHeaderSessionActionsPopover(false);
	const requestId = ++_headerSessionActionsPopoverRequestId;
	await import("../ui/components/SidebarActionsPopover.js");
	if (requestId !== _headerSessionActionsPopoverRequestId || !input.trigger.isConnected) return;
	const element = document.createElement("sidebar-actions-popover") as SidebarActionsPopover;
	element.anchorEl = input.trigger;
	element.items = toHeaderPopoverItems(input.actions);
	element.sourceRects = input.sourceRects;
	element.open = true;
	const handleResize = () => refreshOpenHeaderSessionActionsPopover();
	window.addEventListener("resize", handleResize);
	const cleanup = () => window.removeEventListener("resize", handleResize);
	element.addEventListener("sidebar-action-select", ((event: CustomEvent<{ actionId: string }>) => {
		event.stopPropagation();
		const current = _openHeaderSessionActionsPopover;
		const action = current?.actions.find((item) => String(item.id) === event.detail.actionId);
		closeHeaderSessionActionsPopover(false);
		void action?.run(event);
	}) as EventListener);
	element.addEventListener("close", () => {
		if (_openHeaderSessionActionsPopover?.element === element) {
			_openHeaderSessionActionsPopover.cleanup?.();
			_openHeaderSessionActionsPopover = null;
		} else {
			cleanup();
		}
		try { element.remove(); } catch { /* ignore */ }
		renderApp();
	});
	document.body.appendChild(element);
	_openHeaderSessionActionsPopover = {
		sessionId: input.sessionId,
		element,
		actions: input.actions,
		refresh: input.refresh,
		cleanup,
	};
	renderApp();
}

function renderHeaderSessionActionButton(action: SessionActionDescriptor, mobile = false) {
	const danger = action.tone === "danger";
	return html`
		<button
			type="button"
			class="${mobile ? "h-10 w-10 p-0" : "h-7 px-2"} rounded-md transition-colors inline-flex items-center justify-center text-muted-foreground hover:bg-secondary/80 hover:text-foreground ${danger ? "hover:text-destructive" : ""}"
			data-session-action-surface="header"
			data-session-action-id=${String(action.id)}
			data-sidebar-action-id=${String(action.id)}
			data-sidebar-action-quick=${action.quick ? "true" : "false"}
			@click=${(event: Event) => {
				event.preventDefault();
				event.stopPropagation();
				closeHeaderSessionActionsPopover(false);
				void action.run(event);
			}}
			title=${action.title || action.label}
			aria-label=${action.label}
		>
			<span class="inline-flex items-center gap-1">${action.icon}${mobile ? html`` : html`<span class="text-xs hidden md:inline">${action.label}</span>`}</span>
		</button>
	`;
}

function renderHeaderSessionActions(input: {
	session: GatewaySession;
	displayTitle: string;
	staffId?: string;
	staffName?: string;
	mobile: boolean;
}) {
	const archivedActions = isArchivedSessionActionSource(input.session);
	const buildActions = () => (archivedActions
		? buildArchivedSessionActions({
			session: input.session,
			displayTitle: input.displayTitle,
		})
		: buildSessionActions({
			session: input.session,
			displayTitle: input.displayTitle,
			staffId: input.staffId,
			staffName: input.staffName,
			goalId: input.session.goalId || input.session.teamGoalId,
			onRefreshStateChanged: refreshOpenHeaderSessionActionsPopover,
		})).slice().sort((a, b) => a.priority - b.priority);
	const actions = buildActions();
	if (!actions.length) return html``;
	const { directActions, overflowActions } = partitionHeaderSessionActions(actions, input.mobile);
	const showOverflow = input.mobile || archivedActions || overflowActions.length > 0;
	const openFromTrigger = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		const trigger = event.currentTarget as HTMLElement;
		const row = trigger.closest<HTMLElement>("[data-sidebar-actions-row-root]");
		if (!archivedActions) resetSessionForkNewWorktree();
		const currentMenuActions = () => buildActions();
		void openHeaderSessionActionsPopover({
			sessionId: input.session.id,
			trigger,
			actions: currentMenuActions(),
			refresh: currentMenuActions,
			sourceRects: row ? captureHeaderSessionActionSourceRects(row) : [],
		});
	};
	return html`
		<div class="flex items-center gap-1 shrink-0 relative" data-session-action-surface="header" data-sidebar-actions-row-root>
			<div class="sidebar-actions flex items-center gap-1">
				${directActions.map((action) => renderHeaderSessionActionButton(action, input.mobile))}
				${showOverflow ? html`
					<button
						type="button"
						class="${input.mobile ? "h-10 w-10 p-0" : "h-7 px-2"} rounded-md transition-colors inline-flex items-center justify-center text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
						data-testid="session-actions-trigger"
						aria-label="Session actions"
						aria-haspopup="menu"
						aria-expanded=${isHeaderSessionActionsPopoverOpen(input.session.id) ? "true" : "false"}
						title="Session actions"
						@click=${openFromTrigger}
					>${icon(Menu, "xs")}</button>
				` : html``}
			</div>
		</div>
	`;
}

// ── Disabled `#/ext/<routeId>` deep-link empty state (built-in-first-party-packs
// §7.3). A deep-link to an extension whose owning pack is disabled/uninstalled
// resolves to no registered route. Rather than silently no-op (blank panel), we
// surface a dismissible "feature unavailable" empty state so a bookmarked
// `#/ext/<routeId>` degrades cleanly — no crash, no dangling surface.
//
// RENDER-DERIVED (built-in-first-party-packs §7.3): the overlay is computed
// SYNCHRONOUSLY in the render path from (a) the current `#/ext/<routeId>` hash
// route and (b) the CURRENT pack-route registry (`lookupPackRoute`, a sync map
// read). It is NOT a one-shot imperative flag set during an async reconcile —
// that dance raced the reconcile and could strand the overlay out of the DOM.
// A re-render is driven whenever the entrypoint registry rebuilds (the
// `setRoutesChangedListener` hook in main.ts calls renderApp), so a
// disable/enable flips the deep-link between its panel and this empty state.
//
// `dismiss` records the dismissed routeId so the overlay stays hidden for that
// deep-link until the user navigates to a different `#/ext/<routeId>` (a new
// routeId is not dismissed → overlay can re-surface).
let _dismissedExtRouteId = "";
export function dismissExtRouteUnavailable(): void {
	const route = getRouteFromHash();
	const routeId = route.view === "ext" ? (route.extRouteId ?? "") : "";
	if (_dismissedExtRouteId === routeId) return;
	_dismissedExtRouteId = routeId;
	try { renderApp(); } catch { /* non-DOM */ }
}
function extRouteUnavailable() {
	const route = getRouteFromHash();
	// Only on an `#/ext/<routeId>` deep-link.
	if (route.view !== "ext" || !route.extRouteId) return "";
	// User dismissed THIS deep-link's overlay — stay hidden until they navigate
	// to a different routeId.
	if (route.extRouteId === _dismissedExtRouteId) return "";
	// The routeId resolves to a registered (enabled) pack route → the panel owns
	// the surface; no empty state.
	if (lookupPackRoute(route.extRouteId)) return "";
	return html`
		<div class="ext-unavailable-overlay" data-testid="ext-route-unavailable" role="alert">
			<div class="ext-unavailable-card">
				<div class="ext-unavailable-title">${icon(AlertTriangle, "sm")} Feature unavailable</div>
				<div class="ext-unavailable-body">
					This extension is unavailable — it may be disabled or not installed.
				</div>
				<button class="market-btn" data-testid="ext-route-unavailable-dismiss" @click=${dismissExtRouteUnavailable}>Dismiss</button>
			</div>
		</div>
	`;
}

// ============================================================================
// PREVIEW THEME BRIDGE
// ============================================================================

/** Theme-bridge + swipe scripts injected into preview iframes. Source of
 *  truth: `src/shared/preview-bridge-scripts.ts` (also imported by the
 *  server's preview content route so client and server emit byte-equal
 *  payloads). Local aliases preserved to avoid churning call sites. */
// WP-E: theme-bridge / swipe-script constants previously concatenated into
// the inline `srcdoc=` iframe are gone. The gateway now injects them
// server-side on text/html responses through the `/preview/<sid>/` mount.

type UnifiedPanelTab = PanelWorkspaceTab;
type UnifiedContentTab = PanelWorkspaceTab;
type MobilePaneTab = UnifiedPanelTab | {
	id: "__mobile_chat_pane__";
	kind: "chat";
	title: "Chat";
	label: "Chat";
	legacyTab: "chat";
	source: { type: "chat"; sessionId?: string };
};

function activeProposalTypes(): ProposalType[] {
	const sid = activeSessionId();
	return PROPOSAL_TYPES.filter((type) => {
		const slot = state.activeProposals[type];
		return slot != null && (!sid || slot.sessionId === sid);
	});
}

function currentAssistantProposalType(): ProposalType | null {
	return assistantProposalType(state.assistantType);
}

export function workspaceSessionId(): string {
	return panelWorkspaceSessionKey(activeSessionId());
}

type SidePanelSizeMode = "collapsed" | "split" | "fullscreen";

function sidePanelSizeModeBySession(): Record<string, SidePanelSizeMode> {
	const holder = state as any;
	if (!holder.sidePanelSizeModeBySession || typeof holder.sidePanelSizeModeBySession !== "object") {
		holder.sidePanelSizeModeBySession = {};
	}
	return holder.sidePanelSizeModeBySession as Record<string, SidePanelSizeMode>;
}

export function getSidePanelSizeMode(sessionId: string = workspaceSessionId()): SidePanelSizeMode {
	const sid = panelWorkspaceSessionKey(sessionId);
	const workspace = state.sidePanelWorkspaceBySession?.[sid];
	if (workspace?.sizeMode === "collapsed" || workspace?.sizeMode === "split" || workspace?.sizeMode === "fullscreen") return workspace.sizeMode;
	const stored = sidePanelSizeModeBySession()[sid];
	if (stored === "collapsed" || stored === "split" || stored === "fullscreen") return stored;
	return state.previewPanelFullscreen ? "fullscreen" : "split";
}

export async function setSidePanelSizeMode(mode: SidePanelSizeMode, sessionId: string = workspaceSessionId()): Promise<void> {
	const sid = panelWorkspaceSessionKey(sessionId);
	sidePanelSizeModeBySession()[sid] = mode;
	// Compatibility mirror until the server-backed controller owns all callers.
	state.previewPanelFullscreen = mode === "fullscreen";
	if (!sid || sid === "__no-session__") return;
	try {
		await setServerSidePanelSizeMode(mode, { sessionId: sid });
	} catch (err) {
		console.warn("[side-panel] resize mutation failed", err);
	}
}

let mountedPreviewTabId = "";
const previewRestoreInFlight = new Set<string>();
let mobileSelectedPaneIndex = 0;
let mobileSelectedSideTabId = "";
// SortableJS instance attached to the unified tab bar inner container. We
// recreate it whenever the container DOM node changes (which happens when the
// workspace switches sessions). During a drag, renderApp is suppressed so
// lit-html doesn't fight Sortable's DOM mutations; on drop we read the new
// DOM order and commit it back to state.
//
// SortableJS itself is loaded on first tab-bar render so the ~70 kB raw drag
// library stays out of the eager app-shell SCC pinned by tests/bundle-size.test.ts.
type SortableConstructor = typeof Sortable;
let SortableCtor: SortableConstructor | null = null;
let sortableLoadStarted = false;
let panelSortable: Sortable | null = null;
let panelSortableContainer: HTMLElement | null = null;
let panelSortablePendingContainer: HTMLElement | null = null;
let draggingPanelTabId = "";
// When true, the current drag at any point tried to land on/before a pinned
// tab. SortableJS's onMove returns false for that single candidate target, but
// earlier non-pinned candidates in the same drag may have already swapped the
// DOM. To honour the pinned invariant strictly, we cancel the entire drag on
// drop and let lit-html restore the canonical order from state.
let panelSortablePinnedBlocked = false;
// Initial DOM order of tab ids captured at onStart. When a drag is cancelled
// (e.g. pinned-blocked at any point), we restore this order manually because
// SortableJS's DOM mutations during the drag have already diverged from state,
// and lit-html's `repeat` reconciliation does not always restore element
// positions after external DOM moves.
let panelSortableStartIds: string[] = [];
// rAF handle for the Y-axis lock loop that keeps the dragged clone glued to
// its original vertical position (Chrome-style tab drag).
let panelDragLockRaf = 0;

// Chrome-style axis lock: while the user drags a tab, SortableJS positions the
// floating clone (Sortable.ghost) via `transform: matrix(a,b,c,d,e,f)` where
// `e` is translateX and `f` is translateY. We run a requestAnimationFrame loop
// that, each frame, zeroes out `f` so the clone only ever slides horizontally
// regardless of how the cursor moves vertically. Sortable.ghost is the static
// property SortableJS exposes for the active drag clone.
function startPanelDragYLock(): void {
	cancelAnimationFrame(panelDragLockRaf);
	const tick = () => {
		const ghost = (SortableCtor as unknown as { ghost: HTMLElement | null } | null)?.ghost;
		if (ghost && ghost.style.transform) {
			const t = ghost.style.transform;
			const m = /matrix\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(t);
			if (m && m[6] !== "0") {
				ghost.style.transform = `matrix(${m[1]},${m[2]},${m[3]},${m[4]},${m[5]},0)`;
			}
		}
		panelDragLockRaf = requestAnimationFrame(tick);
	};
	panelDragLockRaf = requestAnimationFrame(tick);
}

function stopPanelDragYLock(): void {
	cancelAnimationFrame(panelDragLockRaf);
	panelDragLockRaf = 0;
}

function recordValue(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function safeDecode(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

function previewEntryFromTab(tab: PanelWorkspaceTab): string {
	const source = tab.source as Record<string, unknown>;
	const tabState = (tab.state || {}) as Record<string, unknown>;
	const direct = recordValue(tabState, "entry") || recordValue(source, "entry");
	if (direct) return direct;
	const url = recordValue(tabState, "url") || recordValue(source, "url");
	const match = /^\/preview\/[^/]+\/(.+)$/.exec(url);
	return match ? safeDecode(match[1]) : "";
}

function previewSessionIdFromTab(tab: PanelWorkspaceTab): string {
	const source = tab.source as Record<string, unknown>;
	const tabState = (tab.state || {}) as Record<string, unknown>;
	const direct = recordValue(source, "sessionId") || recordValue(tabState, "sessionId");
	if (direct) return direct;
	const url = recordValue(tabState, "url") || recordValue(source, "url");
	const match = /^\/preview\/([^/]+)\//.exec(url);
	return match ? safeDecode(match[1]) : "";
}

function previewSourceTitle(tab: PanelWorkspaceTab): string {
	if (tab.kind !== "preview") return tab.title || tab.label || "";
	const entry = previewEntryFromTab(tab);
	return previewTabDisplayTitle(entry || tab.title || tab.label || "inline.html", previewTabVersion(tab), isHistoricalPreviewTab(tab));
}

function currentMountedPreviewTabId(): string {
	return typeof (state as any).previewPanelMountedTabId === "string" ? (state as any).previewPanelMountedTabId : mountedPreviewTabId;
}

type PreviewRestoreError = { message?: string; detail?: string; status?: number; retryable?: boolean };

function previewRestoreError(tab: PanelWorkspaceTab | undefined | null): PreviewRestoreError | null {
	const error = tab?.state?.restoreError;
	return error && typeof error === "object" ? error as PreviewRestoreError : null;
}

function setPreviewTabRestoreError(sessionId: string, tabId: string, restoreError: PreviewRestoreError | null): PanelWorkspaceTab | undefined {
	const tabs = panelTabsForSession(state, sessionId);
	let updated: PanelWorkspaceTab | undefined;
	const next = tabs.map((candidate) => {
		if (candidate.id !== tabId) return candidate;
		const nextState = { ...(candidate.state || {}) } as Record<string, unknown>;
		if (restoreError) nextState.restoreError = restoreError;
		else delete nextState.restoreError;
		updated = { ...candidate, state: nextState };
		return updated;
	});
	setPanelTabsForSession(state, sessionId, next);
	return updated;
}

function clearPreviewTabRestoreError(sessionId: string, tabId: string): PanelWorkspaceTab | undefined {
	return setPreviewTabRestoreError(sessionId, tabId, null);
}

function markPreviewTabMounted(tab: PanelWorkspaceTab): void {
	if (tab.kind !== "preview") return;
	mountedPreviewTabId = tab.id;
	(state as any).previewPanelMountedTabId = tab.id;
}

function archiveLivePreviewBeforeHistoricalRestore(_sessionId: string, _nextContentHash: string): void {
	// Current preview tabs are keyed by filename and keep their own restore
	// metadata. Do not synthesize extra snapshot tabs merely because the user
	// switches to another preview; versioned tabs are created only when a user
	// explicitly opens an older preview_open card.
}

function markPreviewTabLiveForSession(sessionId: string, tab: PanelWorkspaceTab): void {
	if (!sessionId || tab.kind !== "preview") return;
	const tabs = panelTabsForSession(state, sessionId);
	let changed = false;
	const nextTabs = tabs.map((candidate) => {
		if (candidate.kind !== "preview") return candidate;
		const shouldBeLive = candidate.id === tab.id && !isHistoricalPreviewTab(tab);
		const source = candidate.source as Record<string, unknown>;
		if (source.live === shouldBeLive) return candidate;
		changed = true;
		return { ...candidate, source: { ...source, live: shouldBeLive } as PanelWorkspaceTab["source"] };
	});
	if (changed) setPanelTabsForSession(state, sessionId, nextTabs);
}

function restoreHistoricalPreviewTab(tab: PanelWorkspaceTab): void {
	if (tab.kind !== "preview") return;
	const sessionId = activeSessionId() || previewSessionIdFromTab(tab);
	if (!sessionId) return;
	if (previewRestoreError(tab)) return;
	const tabState = (tab.state || {}) as Record<string, unknown>;
	const source = tab.source as Record<string, unknown>;
	const entry = previewEntryFromTab(tab) || state.previewPanelEntry || "inline.html";
	const contentHash = normalizePreviewContentHash(recordValue(tabState, "contentHash") || recordValue(source, "contentHash"));
	const tabArtifactIdEarly = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");

	// Fast path: any preview tab that has a persisted artifact is served
	// directly from `/preview/<sid>/_artifact/<artifactId>/...`. This bypasses
	// the single-slot live mount entirely so switching between artifact-backed
	// preview tabs is instant (no POST restore round-trip, no iframe blanking).
	// We skip this only for the canonical live tab id, which intentionally
	// follows the live mount slot's changing bytes.
	const isLiveTab = isLivePreviewTab(tab);
	if (!isLiveTab && tabArtifactIdEarly) {
		if (state.previewPanelEntry === entry && state.previewPanelArtifactId === tabArtifactIdEarly && currentMountedPreviewTabId() === tab.id) {
			clearPreviewTabRestoreError(sessionId, tab.id);
			markPreviewTabMounted(tab);
			return;
		}
		state.isPreviewSession = true;
		state.previewPanelEntry = entry;
		state.previewPanelArtifactId = tabArtifactIdEarly;
		state.previewPanelMtime = typeof tabState.mtime === "number" ? tabState.mtime : Date.now();
		(state as any).previewPanelContentHash = contentHash;
		clearPreviewTabRestoreError(sessionId, tab.id);
		markPreviewTabMounted(tab);
		renderApp();
		return;
	}

	if (isLiveTab || !isHistoricalPreviewTab(tab)) {
		const liveEntry = previewEntryFromTab(tab);
		const liveHash = previewContentHashFromTab(tab);
		// Coming back to the live tab from an artifact-served tab — clear the
		// artifact id so the iframe URL falls back to the live mount slot.
		state.previewPanelArtifactId = "";
		// IMPORTANT: setUnifiedActiveTab runs on every render via ensureUnifiedActiveTab,
		// which calls this function. If this tab is already the mounted live preview and
		// state.previewPanelEntry already matches, skip the state.previewPanelMtime/Entry/
		// ContentHash assignment so an out-of-band refresh (which bumps previewPanelMtime)
		// is not clobbered by stale tabState values on the next render. Pinned by
		// tests/e2e/ui/preview-refresh.spec.ts and preview-happy-path.spec.ts.
		const alreadyMounted = currentMountedPreviewTabId() === tab.id
			&& !!liveEntry
			&& state.previewPanelEntry === liveEntry;
		if (alreadyMounted) {
			clearPreviewTabRestoreError(sessionId, tab.id);
			markPreviewTabMounted(tab);
			return;
		}
		const liveMountHash = normalizePreviewContentHash((state as any).previewPanelContentHash);
		const tabArtifactId = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");
		// If the live server mount currently holds bytes for a DIFFERENT version
		// than this current/filename tab represents (e.g. user just viewed a
		// historical tab which rehydrated older bytes into the live mount), we
		// must re-mount this tab's own artifact so the iframe shows the correct
		// content. Otherwise just refresh state metadata.
		if (liveHash && liveMountHash && liveHash !== liveMountHash && tabArtifactId && !previewRestoreInFlight.has(tab.id)) {
			state.isPreviewSession = true;
			state.previewPanelEntry = "";
			state.previewPanelMtime = 0;
			(state as any).previewPanelContentHash = liveHash;
			try {
				document.querySelectorAll<HTMLIFrameElement>(".goal-preview-panel iframe")
					.forEach((iframe) => { iframe.src = "about:blank"; });
			} catch { /* best-effort stale-content guard while the remount POST is in flight */ }
			previewRestoreInFlight.add(tab.id);
			void (async () => {
				try {
					const response = await gatewayFetch(
						`/api/preview/artifacts/${encodeURIComponent(tabArtifactId)}/restore?sessionId=${encodeURIComponent(sessionId)}`,
						{ method: "POST", body: JSON.stringify({ artifactId: tabArtifactId }) },
					);
					if (!response.ok) throw new Error(`preview restore failed: ${response.status}`);
					const data = await response.json().catch(() => ({} as any));
					if (state.selectedSessionId !== sessionId || activeSessionId() !== sessionId || activeSidePanelTabIdForSession(state, sessionId) !== tab.id) return;
					state.previewPanelEntry = typeof data?.entry === "string" && data.entry ? data.entry : (liveEntry || state.previewPanelEntry || "inline.html");
					state.previewPanelMtime = typeof data?.mtime === "number" ? data.mtime : Date.now();
					(state as any).previewPanelContentHash = normalizePreviewContentHash(data?.contentHash) || liveHash;
					clearPreviewTabRestoreError(sessionId, tab.id);
					markPreviewTabMounted(tab);
					renderApp();
				} catch (err) {
					console.error("[panel-workspace] current preview tab restore failed", err);
					setPreviewTabRestoreError(sessionId, tab.id, {
						message: "Preview artifact unavailable",
						detail: err instanceof Error ? err.message : String(err),
						retryable: true,
					});
					renderApp();
				} finally {
					previewRestoreInFlight.delete(tab.id);
				}
			})();
			return;
		}
		if (liveEntry) state.previewPanelEntry = liveEntry;
		if (liveHash) (state as any).previewPanelContentHash = liveHash;
		state.previewPanelMtime = typeof tabState.mtime === "number" ? tabState.mtime : (state.previewPanelMtime || Date.now());
		clearPreviewTabRestoreError(sessionId, tab.id);
		markPreviewTabMounted(tab);
		return;
	}

	const snapshotKind = recordValue(tabState, "snapshotKind") || recordValue(source, "snapshotKind");
	const snapshotHtml = recordValue(tabState, "snapshotHtml");
	const snapshotFile = recordValue(tabState, "snapshotFile") || recordValue(source, "path");
	const artifactId = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");
	markPreviewTabLiveForSession(sessionId, tab);
	if (currentMountedPreviewTabId() === tab.id && state.previewPanelEntry === entry && state.previewPanelArtifactId === (artifactId || "")) return;

	// Fast path: artifact-backed tabs are served directly from
	// `/preview/<sid>/_artifact/<artifactId>/...` so there's no mount/restore
	// round-trip. Just point the iframe at the artifact URL and we're done.
	if (artifactId) {
		state.isPreviewSession = true;
		state.previewPanelEntry = entry;
		state.previewPanelArtifactId = artifactId;
		state.previewPanelMtime = typeof tabState.mtime === "number" ? tabState.mtime : Date.now();
		(state as any).previewPanelContentHash = contentHash;
		clearPreviewTabRestoreError(sessionId, tab.id);
		markPreviewTabMounted(tab);
		renderApp();
		return;
	}

	archiveLivePreviewBeforeHistoricalRestore(sessionId, contentHash);

	state.isPreviewSession = true;
	if (previewRestoreInFlight.has(tab.id)) return;

	let body: Record<string, unknown> | null = null;
	let restoreUrl = `/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`;
	if (artifactId) {
		restoreUrl = `/api/preview/artifacts/${encodeURIComponent(artifactId)}/restore?sessionId=${encodeURIComponent(sessionId)}`;
		body = { artifactId };
	} else if (snapshotKind === "inline" && snapshotHtml) {
		body = { html: snapshotHtml, workspaceTab: false, internalRestore: true };
		if (entry && !entry.includes("/") && !entry.includes("\\")) body.entry = entry;
	} else if (snapshotKind === "file" && snapshotFile) {
		body = { file: snapshotFile, workspaceTab: false, internalRestore: true };
	}

	if (!body) {
		setPreviewTabRestoreError(sessionId, tab.id, {
			message: "Preview artifact unavailable",
			detail: "This preview tab has no immutable restore source.",
			retryable: false,
		});
		try {
			document.querySelectorAll<HTMLIFrameElement>(".goal-preview-panel iframe")
				.forEach((iframe) => { iframe.src = "about:blank"; });
		} catch { /* best-effort stale-content guard */ }
		renderApp();
		return;
	}

	state.previewPanelEntry = "";
	state.previewPanelMtime = 0;
	state.previewPanelArtifactId = "";
	(state as any).previewPanelContentHash = contentHash;
	try {
		document.querySelectorAll<HTMLIFrameElement>(".goal-preview-panel iframe")
			.forEach((iframe) => { iframe.src = "about:blank"; });
	} catch { /* best-effort stale-content guard while the remount POST is in flight */ }
	previewRestoreInFlight.add(tab.id);
	void (async () => {
		try {
			const response = await gatewayFetch(restoreUrl, {
				method: "POST",
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(`preview restore failed: ${response.status}`);
			const data = await response.json().catch(() => ({} as any));
			if (state.selectedSessionId !== sessionId || activeSessionId() !== sessionId || activeSidePanelTabIdForSession(state, sessionId) !== tab.id) return;
			state.previewPanelEntry = typeof data?.entry === "string" && data.entry ? data.entry : entry;
			state.previewPanelMtime = typeof data?.mtime === "number" ? data.mtime : Date.now();
			state.previewPanelArtifactId = "";
			(state as any).previewPanelContentHash = normalizePreviewContentHash(data?.contentHash) || contentHash;
			const updatedTab = clearPreviewTabRestoreError(sessionId, tab.id) ?? tab;
			markPreviewTabMounted(updatedTab);
			renderApp();
		} catch (err) {
			console.error("[panel-workspace] preview tab restore failed", err);
			setPreviewTabRestoreError(sessionId, tab.id, {
				message: "Preview artifact unavailable",
				detail: err instanceof Error ? err.message : String(err),
				retryable: true,
			});
			renderApp();
		} finally {
			previewRestoreInFlight.delete(tab.id);
		}
	})();
}

function reviewDocumentKeyFromPanelTab(tab: PanelWorkspaceTab | undefined | null): string {
	const documentId = reviewDocumentIdFromPanelTab(tab);
	if (documentId && state.reviewDocuments.has(documentId)) return documentId;
	return reviewTitleFromPanelTab(tab) || documentId;
}

export function setUnifiedActiveTab(tab: PanelWorkspaceTab): void {
	if ((tab as any).kind === "chat" || tab.id === CHAT_PANEL_TAB_ID) return;
	const sid = workspaceSessionId();
	setActivePanelTabIdForSession(state, sid, tab.id);
	const workspace = getSidePanelWorkspace(sid);
	if (sid !== "__no-session__" && workspace.tabs.some((candidate) => candidate.id === tab.id) && workspace.activeTabId !== tab.id) {
		void setServerActiveSidePanelTab(tab.id, { sessionId: sid });
	}
	(state as any).previewPanelTab = tab.legacyTab;
	(state as any).previewPanelActiveTab = tab.kind === "preview" ? "preview" : tab.legacyTab;
	if (state.assistantType) state.assistantTab = "preview";
	if (tab.kind === "preview") {
		state.isPreviewSession = true;
		restoreHistoricalPreviewTab(tab);
	}
	if (tab.kind === "review") {
		state.reviewActiveTab = reviewDocumentKeyFromPanelTab(tab);
	}
}

function ensureUnifiedActiveTab(tabs: PanelWorkspaceTab[]): void {
	const sid = workspaceSessionId();
	const storedId = activeSidePanelTabIdForSession(state, sid);
	const storedTab = findPanelTab(tabs, storedId);
	if (storedTab) {
		setUnifiedActiveTab(storedTab);
		return;
	}
	const fallback = tabs[0];
	if (fallback) {
		setUnifiedActiveTab(fallback);
		return;
	}
	setActivePanelTabIdForSession(state, sid, "");
}

export function shouldDerivePanelTabsInRender(protocol = typeof window !== "undefined" ? window.location.protocol : ""): boolean {
	// file:// browser fixtures have no gateway REST API and intentionally exercise
	// legacy cache-derived panel setup. The real gateway render path is server-
	// authoritative: missing workspace state means "not hydrated yet", never
	// "recreate tabs from proposal/review/preview/inbox caches".
	return protocol === "file:";
}

/** Ordered list of available unified panel tabs for the current session. */
export function unifiedPanelTabs(): UnifiedPanelTab[] {
	const sessionId = workspaceSessionId();
	const serverWorkspace = state.sidePanelWorkspaceBySession?.[sessionId];
	if (serverWorkspace) return panelContentTabs(panelTabsForSession(state, sessionId));
	if (!shouldDerivePanelTabsInRender()) return [];
	const derivedTabs = buildPanelWorkspaceTabs({
		sessionId,
		isPreviewSession: state.isPreviewSession,
		previewEntry: state.previewPanelEntry,
		// Use the registry's latest registered contentHash as the source of truth
		// for the current/filename tab. The transient `state.previewPanelContentHash`
		// may briefly hold older bytes while a historical artifact is mounted, and
		// using it here would clobber the stored filename tab's v2 metadata when
		// `mergeDerivedMetadata` merges the derived tab over it.
		previewContentHash: (state.previewPanelEntry ? previewVersionRecordFor(state, sessionId, state.previewPanelEntry)?.latestContentHash : undefined)
			|| (state as any).previewPanelContentHash,
		activeProposalTypes: activeProposalTypes(),
		assistantProposalType: currentAssistantProposalType(),
		reviewTitles: [...state.reviewDocuments.keys()],
		reviewPanelOpen: state.reviewPanelOpen,
		inboxPanelOpen: state.inboxPanelOpen,
		inboxHasPending: state.inboxEntries.some((e) => e.state === "pending"),
	});
	const tabs = normalizeSidePanelTabs(state, sessionId, derivedTabs);
	setPanelTabsForSession(state, sessionId, tabs);
	ensureUnifiedActiveTab(tabs);
	return tabs;
}

function findReviewPanelTabByTitle(title: string): UnifiedPanelTab | undefined {
	const doc = state.reviewDocuments.get(title);
	const candidateIds = [doc?.documentId, title]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map((documentId) => reviewPanelTabId(documentId));
	const tabs = unifiedPanelTabs();
	for (const id of candidateIds) {
		const tab = findPanelTab(tabs, id);
		if (tab?.kind === "review") return tab;
	}
	return tabs.find((tab) => tab.kind === "review" && reviewTitleFromPanelTab(tab) === title);
}

function unifiedPanelContentTabs(): UnifiedContentTab[] {
	return panelContentTabs(unifiedPanelTabs());
}

function setUnifiedMobileTab(tab: UnifiedPanelTab): void {
	setUnifiedActiveTab(tab);
	const tabs = unifiedPanelTabs();
	const idx = tabs.findIndex((candidate) => candidate.id === tab.id);
	mobileSelectedPaneIndex = idx >= 0 ? idx + 1 : 0;
	mobileSelectedSideTabId = idx >= 0 ? tab.id : mobileSelectedSideTabId;
}

function setUnifiedDesktopTab(tab: UnifiedContentTab): void {
	setUnifiedActiveTab(tab);
}

/** Whether the unified side-panel workspace is active for the current session. */
export function hasActiveSidePanel(): boolean {
	return unifiedPanelContentTabs().length > 0;
}

/** Whether the unified panel is active for the current session. */
function hasUnifiedPanel(): boolean {
	return hasActiveSidePanel();
}

function mobileChatPaneTab(): MobilePaneTab {
	return {
		id: "__mobile_chat_pane__",
		kind: "chat",
		title: "Chat",
		label: "Chat",
		legacyTab: "chat",
		source: { type: "chat", sessionId: workspaceSessionId() },
	};
}

function unifiedMobilePanes(): MobilePaneTab[] {
	return [mobileChatPaneTab(), ...unifiedPanelTabs()];
}

function unifiedMobilePaneIndex(): number {
	const sideTabs = unifiedPanelTabs();
	if (sideTabs.length === 0) {
		mobileSelectedPaneIndex = 0;
		return 0;
	}
	const activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
	if (activeId && activeId !== mobileSelectedSideTabId) {
		const activeIndex = sideTabs.findIndex((tab) => tab.id === activeId);
		if (activeIndex >= 0) {
			mobileSelectedPaneIndex = activeIndex + 1;
			mobileSelectedSideTabId = activeId;
		}
	}
	if (mobileSelectedPaneIndex < 0 || mobileSelectedPaneIndex > sideTabs.length) mobileSelectedPaneIndex = activeId ? Math.max(1, sideTabs.findIndex((tab) => tab.id === activeId) + 1) : 0;
	return mobileSelectedPaneIndex;
}

function setUnifiedMobilePaneByIndex(index: number): void {
	const sideTabs = unifiedPanelTabs();
	if (index <= 0) {
		mobileSelectedPaneIndex = 0;
		renderApp();
		return;
	}
	const tab = sideTabs[index - 1];
	if (tab) setUnifiedMobileTab(tab);
}

/** Compute slider translateX% for the given tab index and pane count. */
function unifiedSlideX(index: number, count: number): number {
	if (count <= 1) return 0;
	return -(index * 100) / count;
}

/** Listen for postMessage from the preview iframe and drive the slider track.
 *  Also handles touch swipes on the chat / content panes. */
function setupPreviewSwipe(): void {
	if ((window as any).__previewSwipeListening) return;
	(window as any).__previewSwipeListening = true;

	const getTrack = () => document.querySelector(".side-panel-slider__track, .preview-slider__track") as HTMLElement | null;

	// === iframe -> parent: swipe on preview pane ===
	window.addEventListener("message", (e: MessageEvent) => {
		if (!hasUnifiedPanel()) return;
		const panes = unifiedMobilePanes();
		const curIdx = unifiedMobilePaneIndex();
		const activeTab = panes[curIdx];
		if (activeTab?.kind !== "preview") return;
		const track = getTrack();
		if (!track) return;

		const paneW = track.parentElement!.clientWidth;
		const count = panes.length;
		const baseX = unifiedSlideX(curIdx, count);

		if (e.data?.type === "preview-swipe-start") {
			track.style.transition = "none";
		} else if (e.data?.type === "preview-swipe-move") {
			const dx: number = e.data.dx;
			const dragPercent = (dx / paneW) * (100 / count);
			const target = Math.max(unifiedSlideX(count - 1, count), Math.min(0, baseX + dragPercent));
			track.style.transform = `translateX(${target}%)`;
		} else if (e.data?.type === "preview-swipe-end") {
			track.style.transition = "transform 0.3s ease-out";
			const dx: number = e.data.dx;
			const threshold = paneW * 0.2;
			let newIdx = curIdx;
			if (dx > threshold && curIdx > 0) newIdx = curIdx - 1;
			else if (dx < -threshold && curIdx < count - 1) newIdx = curIdx + 1;
			setUnifiedMobilePaneByIndex(newIdx);
			track.style.transform = `translateX(${unifiedSlideX(newIdx, count)}%)`;
		}
	});

	// === touch swipe on non-iframe panes (chat, proposals, reviews, inbox) ===
	let startX = 0, startY = 0, captured = false, decided = false;
	const el = document.getElementById("app")!;

	el.addEventListener("touchstart", (e: TouchEvent) => {
		if (!hasUnifiedPanel()) return;
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, { passive: true });

	el.addEventListener("touchmove", (e: TouchEvent) => {
		if (!hasUnifiedPanel()) return;
		if (decided && !captured) return;
		const dx = e.touches[0].clientX - startX;
		const dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			const panes = unifiedMobilePanes();
			const curIdx = unifiedMobilePaneIndex();
			if (dx < 0 && Math.abs(dx) > Math.abs(dy) && curIdx < panes.length - 1) {
				captured = true;
			} else if (dx > 0 && Math.abs(dx) > Math.abs(dy) && curIdx > 0) {
				captured = true;
			}
			if (captured) {
				const track = getTrack();
				if (track) track.style.transition = "none";
			}
		}
		if (captured) {
			const track = getTrack();
			if (track) {
				const panes = unifiedMobilePanes();
				const count = panes.length;
				const curIdx = unifiedMobilePaneIndex();
				const baseX = unifiedSlideX(curIdx, count);
				const dragPercent = (dx / track.parentElement!.clientWidth) * (100 / count);
				const target = Math.max(unifiedSlideX(count - 1, count), Math.min(0, baseX + dragPercent));
				track.style.transform = `translateX(${target}%)`;
			}
		}
	}, { passive: true });

	el.addEventListener("touchend", (e: TouchEvent) => {
		if (!captured) return;
		const track = getTrack();
		if (track) {
			track.style.transition = "transform 0.3s ease-out";
			const dx = e.changedTouches[0].clientX - startX;
			const panes = unifiedMobilePanes();
			const count = panes.length;
			const curIdx = unifiedMobilePaneIndex();
			const threshold = track.parentElement!.clientWidth * 0.2;
			let newIdx = curIdx;
			if (dx < -threshold && curIdx < count - 1) newIdx = curIdx + 1;
			else if (dx > threshold && curIdx > 0) newIdx = curIdx - 1;
			setUnifiedMobilePaneByIndex(newIdx);
			track.style.transform = `translateX(${unifiedSlideX(newIdx, count)}%)`;
		}
		captured = false;
		decided = false;
		renderApp();
	}, { passive: true });
}

function samePanelTabOrder(a: PanelWorkspaceTab[], b: PanelWorkspaceTab[]): boolean {
	return a.length === b.length && a.every((tab, index) => tab.id === b[index]?.id);
}

// Restore the DOM order of `.goal-tab-pill` children inside `host` to match
// `expectedIds`. Used to revert SortableJS's drag DOM mutations when the
// drop is rejected (e.g. pinned-blocked). Appending an already-attached node
// moves it without re-creating it, so this is cheap and leaves event listeners
// intact. Any pills not in `expectedIds` keep their relative tail position.
function revertPanelTabDomOrder(host: HTMLElement, expectedIds: string[]): void {
	if (!host || expectedIds.length === 0) return;
	const pillsById = new Map<string, HTMLElement>();
	for (const pill of Array.from(host.querySelectorAll<HTMLElement>(".goal-tab-pill"))) {
		const id = pill.getAttribute("data-panel-tab-id") || "";
		if (id) pillsById.set(id, pill);
	}
	for (const id of expectedIds) {
		const pill = pillsById.get(id);
		if (pill) host.appendChild(pill);
	}
}

function loadPanelSortable(): void {
	if (SortableCtor || sortableLoadStarted) return;
	sortableLoadStarted = true;
	void import("sortablejs")
		.then((mod) => {
			SortableCtor = (mod as unknown as { default?: SortableConstructor }).default ?? (mod as unknown as SortableConstructor);
			const pending = panelSortablePendingContainer;
			panelSortablePendingContainer = null;
			if (pending?.isConnected) ensurePanelSortable(pending);
		})
		.catch((err) => {
			sortableLoadStarted = false;
			console.warn("[render] failed to load SortableJS", err);
		});
}

// Attach a SortableJS instance to the unified tab bar's inner container. Idempotent:
// if the container DOM node is the same as last time, we keep the existing instance.
// If the container was replaced (e.g. workspace switched sessions), we destroy the
// old instance and rebuild.
//
// SortableJS handles all the hard parts of Chrome-style tab dragging — dragged item
// follows cursor 1:1, siblings slide via CSS, midpoint hysteresis to prevent flicker,
// touch and accessibility support, edge cases like fast sweeps. We integrate by:
//   - filter: pinned tabs can't be picked up
//   - onMove: forbid drops in front of pinned tabs (returns false to cancel)
//   - onStart: suppress lit-html renders so Sortable owns the DOM during the drag
//   - onEnd: read the new DOM order, commit to state, resume renders
function ensurePanelSortable(container: HTMLElement | null): void {
	if (!container) {
		panelSortablePendingContainer = null;
		if (panelSortable) {
			panelSortable.destroy();
			panelSortable = null;
			panelSortableContainer = null;
		}
		return;
	}
	if (!SortableCtor) {
		panelSortablePendingContainer = container;
		loadPanelSortable();
		return;
	}
	if (panelSortableContainer === container && panelSortable) return;
	if (panelSortable) {
		panelSortable.destroy();
		panelSortable = null;
	}
	panelSortableContainer = container;

	panelSortable = SortableCtor.create(container, {
		animation: 180,
		easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
		draggable: ".goal-tab-pill",
		filter: ".goal-tab-pill--pinned, .goal-tab-close",
		preventOnFilter: false,
		ghostClass: "goal-tab-pill--ghost",
		chosenClass: "goal-tab-pill--chosen",
		dragClass: "goal-tab-pill--drag",
		forceFallback: true,
		fallbackTolerance: 4,
		delay: 0,
		onChoose: (evt) => {
			const id = (evt.item as HTMLElement).getAttribute("data-panel-tab-id") || "";
			const tab = findPanelTab(panelTabsForSession(state, workspaceSessionId()), id);
			if (tab && !isPinnedPanelTab(tab)) setUnifiedActiveTab(tab);
		},
		onMove: (evt) => {
			// Forbid dropping in front of (or onto) a pinned tab. Returning false
			// cancels this candidate move; SortableJS keeps trying as the cursor
			// moves. We also remember that the user *attempted* a pinned-blocked
			// move so onEnd can cancel the whole drag — otherwise an earlier
			// non-pinned swap during the same drag would silently commit.
			const relatedRaw = evt.related as HTMLElement | null;
			const related = relatedRaw?.closest(".goal-tab-pill") as HTMLElement | null;
			if (!related) return true;
			if (related.classList.contains("goal-tab-pill--pinned")) {
				panelSortablePinnedBlocked = true;
				return false;
			}
			return true;
		},
		onStart: (evt) => {
			draggingPanelTabId = (evt.item as HTMLElement).getAttribute("data-panel-tab-id") || "";
			panelSortablePinnedBlocked = false;
			panelSortableStartIds = Array.from(
				(evt.from as HTMLElement).querySelectorAll<HTMLElement>(".goal-tab-pill"),
			)
				.map((el) => el.getAttribute("data-panel-tab-id") || "")
				.filter((id) => id.length > 0);
			document.documentElement.classList.add("dragging-panel-tab");
			setRenderSuppressed(true);
			startPanelDragYLock();
			// Tag the floating clone so CSS can override SortableJS's inline
			// opacity: 0.8 (we want it to look like a real tab, not a ghost),
			// while the source tab (.goal-tab-pill--ghost) becomes invisible —
			// the user should perceive the tab itself moving, not a clone.
			const ghost = (SortableCtor as unknown as { ghost: HTMLElement | null } | null)?.ghost;
			if (ghost) ghost.classList.add("goal-tab-pill--floating");
		},
		onEnd: (evt) => {
			draggingPanelTabId = "";
			document.documentElement.classList.remove("dragging-panel-tab");
			stopPanelDragYLock();
			const pinnedBlocked = panelSortablePinnedBlocked;
			const startIds = panelSortableStartIds;
			panelSortablePinnedBlocked = false;
			panelSortableStartIds = [];
			try {
				const host = evt.from as HTMLElement;
				const sid = workspaceSessionId();
				const currentTabs = panelTabsForSession(state, sid);

				// If the drag attempted a pinned-blocked move at any point,
				// cancel the entire drag — otherwise an earlier non-pinned swap
				// during the same drag would silently commit and the user would
				// see tabs reorder despite SortableJS rejecting the final drop.
				// Manually restore the DOM order from the snapshot captured at
				// onStart: lit-html's `repeat` does not always reconcile element
				// positions back to canonical when SortableJS has shuffled them.
				if (pinnedBlocked) {
					revertPanelTabDomOrder(host, startIds);
					return;
				}

				// Read the new tab id order directly off the DOM children.
				const newIds = Array.from(host.querySelectorAll<HTMLElement>(".goal-tab-pill"))
					.map((el) => el.getAttribute("data-panel-tab-id") || "")
					.filter((id) => id.length > 0);
				const byId = new Map(currentTabs.map((tab) => [tab.id, tab]));
				const reordered: PanelWorkspaceTab[] = [];
				for (const id of newIds) {
					const tab = byId.get(id);
					if (tab) reordered.push(tab);
				}
				// Append any tabs that weren't in the DOM order (defensive).
				for (const tab of currentTabs) {
					if (!newIds.includes(tab.id)) reordered.push(tab);
				}

				// Defense-in-depth: refuse to commit a reordering that places any
				// non-pinned tab before any pinned tab. onMove should already have
				// flagged such an attempt via panelSortablePinnedBlocked, but if a
				// future change to SortableJS or our predicate misses an edge
				// case, this guard ensures the pinned invariant still holds.
				let seenNonPinned = false;
				let pinnedAfterNonPinned = false;
				for (const tab of reordered) {
					if (isPinnedPanelTab(tab)) {
						if (seenNonPinned) {
							pinnedAfterNonPinned = true;
							break;
						}
					} else {
						seenNonPinned = true;
					}
				}
				if (pinnedAfterNonPinned) {
					revertPanelTabDomOrder(host, startIds);
					return;
				}

				if (!samePanelTabOrder(currentTabs, reordered)) {
					const orderedIds = reordered.map((tab) => tab.id);
					void reorderSidePanelTabs(orderedIds, undefined, { sessionId: sid }).catch((err) => {
						console.warn("[side-panel] failed to persist tab reorder", err);
					});
				}
			} finally {
				setRenderSuppressed(false);
				// Always trigger a render: when we took an early `return` above
				// (pinned-blocked or invariant-violation revert), state was not
				// mutated and lit-html will restore the canonical DOM order.
				// When we commit through reorderSidePanelTabs, its optimistic mirror
				// update may have rendered while suppression was active — an extra
				// render here is harmless and makes the committed order visible.
				renderApp();
			}
		},
	});
}



// ============================================================================
// RENDER APP
// ============================================================================

function renderGoalPausedBannerIfNeeded(activeSession: import("./state.js").GatewaySession | undefined) {
	if (!activeSession) return "";
	const activeGoalId = activeSession.goalId ?? activeSession.teamGoalId;
	if (!activeGoalId) return "";
	const goal = state.goals.find(g => g.id === activeGoalId);
	if (!goal?.paused) return "";
	const resumePending = isGoalPauseResumeActionPending(activeGoalId, "resume");
	return html`
		<div class="shrink-0 flex items-center justify-between gap-3 px-4 py-2 text-sm"
		     style="background: color-mix(in oklch, var(--warning) 12%, transparent); border-bottom: 1px solid color-mix(in oklch, var(--warning) 30%, transparent);"
		     data-testid="goal-paused-banner">
			<span style="color: var(--warning);">This goal is paused.</span>
			<button
				class="shrink-0 rounded border px-2 py-1 text-xs font-medium hover:opacity-80 transition-opacity"
				style="border-color: color-mix(in oklch, var(--warning) 40%, transparent); color: var(--warning);"
				data-testid="goal-paused-banner-resume-btn"
				?disabled=${resumePending}
				aria-busy=${resumePending ? "true" : "false"}
				@click=${() => resumeGoalWithDialog(activeGoalId)}>
				${resumePending ? "Resuming…" : "Resume"}
			</button>
		</div>
	`;
}

function renderArchivedBanner() {
	const agent = state.remoteAgent;
	if (!agent?.state?.isArchived) return "";
	const archivedAt = agent.state.archivedAt;
	const dateStr = archivedAt ? new Date(archivedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "unknown date";
	return html`
		<div class="flex items-center justify-center gap-2 px-4 py-2 text-sm text-muted-foreground" style="background: var(--muted); border-bottom: 1px solid var(--border);">
			${icon(Archive, "sm")}
			<span>This session was archived on ${dateStr}</span>
		</div>
	`;
}

export function doRenderApp(): void {
	const app = document.getElementById("app");
	if (!app) return;

	// Dynamic page title.
	// In a regular browser tab, suffix with " · Bobbit" so the tab tells you which app.
	// As an installed PWA, the OS already shows "Bobbit" from manifest.name — adding it
	// to document.title produces a doubled "Bobbit - ScoutPost · Bobbit" taskbar entry.
	const activeProject = state.projects.find(p => p.id === state.activeProjectId);
	const isStandalone = typeof window !== "undefined"
		&& typeof window.matchMedia === "function"
		&& window.matchMedia("(display-mode: standalone)").matches;
	if (activeProject) {
		document.title = isStandalone ? activeProject.name : `${activeProject.name} · Bobbit`;
	} else {
		document.title = "Bobbit";
	}


	// Disconnected state
	if (state.appView === "disconnected") {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="inline-flex items-center gap-1">${icon(Server, "sm")} <span class="text-xs">Connect</span></span>`,
							onClick: openGatewayDialog,
							title: "Connect to gateway",
						})}
						<bell-toggle></bell-toggle>
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
					<div class="flex flex-col items-center gap-3 text-center">
						<div class="text-muted-foreground empty-state-icon">${icon(Unplug, "lg")}</div>
						<h2 class="text-lg font-medium text-foreground">Not connected</h2>
						<p class="text-sm text-muted-foreground max-w-sm">
							Connect to a Bobbit gateway to start working with the coding agent.
						</p>
					</div>
					${Button({
						variant: "default",
						onClick: openGatewayDialog,
						children: html`<span class="inline-flex items-center gap-2">${icon(Server, "sm")} Connect to Gateway</span>`,
					})}
				</div>
			</div>
		`, app);
		return;
	}

	// Gateway starting — server not yet responsive, polling until ready.
	// Always expose a Connect escape hatch: the saved gateway URL/token can be
	// stale (gateway address or token changed since the last QR scan), in which
	// case waitForGateway() polls a dead address for up to 120s. Without a
	// visible action the user is stuck staring at the loader (mobile repro:
	// "bouncing bobbit forever, re-scanning the QR fixes it"). The button lets
	// them reconnect / re-scan immediately instead of waiting for the timeout.
	if (state.appView === "gateway-starting") {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="inline-flex items-center gap-1">${icon(Server, "sm")} <span class="text-xs">Connect</span></span>`,
							onClick: openGatewayDialog,
							title: "Connect to a different gateway",
						})}
						<bell-toggle></bell-toggle>
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 min-h-0 flex flex-col">
					<div class="flex-1 min-h-0">${bobbitLoadingAnimation()}</div>
					<div class="shrink-0 flex flex-col items-center gap-3 px-8 pb-10 text-center">
						<p class="text-sm text-muted-foreground max-w-sm">
							Connecting to the gateway… If this doesn't resolve, the gateway
							address may have changed — reconnect or re-scan the QR code.
						</p>
						${Button({
							variant: "outline",
							size: "sm",
							onClick: openGatewayDialog,
							children: html`<span class="inline-flex items-center gap-2">${icon(Server, "sm")} Reconnect</span>`,
						})}
					</div>
				</div>
			</div>
		`, app);
		return;
	}

	// Authenticated state
	const desktop = isDesktop();
	const connected = hasActiveSession();

	// Session action buttons (shared between headerLeft mobile and headerRight desktop)
	const route = getRouteFromHash();
	if (route.view === "settings") loadSettingsAppInfo();
	const routeSessionId = route.view === "session" ? route.sessionId : undefined;
	const routeCachedSession = routeSessionId
		? state.gatewaySessions.find(s => s.id === routeSessionId) ?? state.archivedSessions.find(s => s.id === routeSessionId)
		: undefined;
	const routeArchivedSession = routeCachedSession ? isArchivedSessionActionSource(routeCachedSession) : false;
	const panelAgentInterface = state.chatPanel?.agentInterface as any;
	const panelSessionId = typeof panelAgentInterface?.session?.sessionId === "string" ? panelAgentInterface.session.sessionId : undefined;
	// Archived read-only panel agents may not expose `session.sessionId`; when
	// the current route is archived or not yet cached, the route id is the only
	// stable action source. Keep this read-only-only so live routes don't get
	// normal live session actions until their session binding is explicit.
	const routeHasReadOnlyPanel = Boolean(routeSessionId && panelAgentInterface?.readOnly && (
		panelSessionId === routeSessionId
		|| (!panelSessionId && (routeArchivedSession || !routeCachedSession))
	));
	const routeIsCurrentSession = Boolean(routeSessionId && (
		state.selectedSessionId === routeSessionId
		|| state.connectingSessionId === routeSessionId
		|| state.remoteAgent?.gatewaySessionId === routeSessionId
		|| routeArchivedSession
		|| routeHasReadOnlyPanel
	));
	const activeSid = (routeSessionId && routeIsCurrentSession) ? routeSessionId : activeSessionId();
	const sessionTitle = connected && state.remoteAgent ? (state.remoteAgent.title || "New session") : "";
	const activeStaffAgent = activeSid ? state.staffList.find(s => s.currentSessionId === activeSid) : undefined;
	const activeSession: GatewaySession | undefined = activeSid ? (() => {
		const cached = activeSid === routeSessionId && routeCachedSession
			? routeCachedSession
			: state.gatewaySessions.find(s => s.id === activeSid) ?? state.archivedSessions.find(s => s.id === activeSid);
		if (cached) return cached;
		const ai = panelAgentInterface;
		const aiSessionId = typeof ai?.session?.sessionId === "string" ? ai.session.sessionId : undefined;
		const routeReadOnlyPanelSource = activeSid === routeSessionId && routeHasReadOnlyPanel;
		if (!ai?.readOnly || (state.selectedSessionId !== activeSid && state.remoteAgent?.gatewaySessionId !== activeSid && aiSessionId !== activeSid && !routeReadOnlyPanelSource)) return undefined;
		return {
			id: activeSid,
			title: sessionTitle || "New session",
			cwd: ai.cwd || "",
			projectId: ai.projectId,
			status: "archived",
			createdAt: 0,
			lastActivity: 0,
			clientCount: 0,
			goalId: ai.goalId,
			delegateOf: ai.delegateOf,
			teamGoalId: ai.teamGoalId,
			assistantType: ai.assistantType,
			readOnly: true,
			archived: true,
		} as GatewaySession;
	})() : undefined;
	const activeSessionArchived = activeSession ? isArchivedSessionActionSource(activeSession) : false;
	const showingSessionHeader = Boolean((connected && state.remoteAgent) || (activeSessionArchived && activeSession));
	const headerTitle = activeStaffAgent?.name ?? (sessionTitle || activeSession?.title || "New session");
	const hasHeaderSessionActions = Boolean(activeSession && ((connected && state.remoteAgent) || activeSessionArchived));
	const headerSessionActions = hasHeaderSessionActions && activeSession ? renderHeaderSessionActions({
		session: activeSession,
		displayTitle: sessionTitle || activeSession.title,
		staffId: activeStaffAgent?.id ?? activeSession.staffId,
		staffName: activeStaffAgent?.name,
		mobile: !desktop,
	}) : html``;

	const headerLeft = () => {
		if (showingSessionHeader) {
			const backBtn = !desktop ? Button({
				variant: "ghost",
				size: "sm",
				// Arrow-only back button (native mobile convention) — frees up
				// horizontal space for the session title between the back button
				// and the edit/delete action buttons on the right.
				children: html`${icon(ArrowLeft, "sm")}`,
				onClick: backToSessions,
				title: "Back to session list",
				className: "h-10 w-10 p-0",
			}) : "";

			if (!desktop) {
				const goalId = activeSession?.goalId || activeSession?.teamGoalId;
				const goalTitle = goalId ? state.goals.find(g => g.id === goalId)?.title : undefined;
				// Left-aligned title layout (flex row, not absolute-centered) so
				// the title claims every pixel between the back button and the
				// right-hand action buttons. On very narrow screens we drop one
				// step down in font size as a last-resort fallback.
				return html`
					<div class="flex items-center w-full pr-0.5 gap-1" style="min-height:40px;">
						<div class="shrink-0">${backBtn}</div>
						<div class="flex-1 min-w-0 flex flex-col justify-center">
							<span class="mobile-header-title font-medium text-foreground inline-flex items-center gap-1 min-w-0" title=${headerTitle}><span class="truncate">${headerTitle}</span>${activeSession?.sandboxed ? renderSandboxIndicator(activeSession.status) : ""}${(activeSession?.status === "preparing" || activeSession?.status === "starting") ? html`<span class="shrink-0 text-muted-foreground/70 italic" style="font-size:0.75em;">preparing…</span>` : ""}</span>
							${goalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate uppercase tracking-wider">${goalTitle}</span>` : ""}
						</div>
						<div class="shrink-0">${headerSessionActions}</div>
					</div>
				`;
			}
			const deskSession = activeSession;
			const deskGoalId = deskSession?.goalId || deskSession?.teamGoalId;
			const deskGoalTitle = deskGoalId ? state.goals.find(g => g.id === deskGoalId)?.title : undefined;
			return html`
				<div class="flex items-center gap-2 px-3 min-w-0 flex-1">
					<div class="flex flex-col min-w-0 py-1">
						<span class="text-sm font-medium text-foreground inline-flex items-center gap-1 min-w-0" title=${headerTitle}><span class="truncate">${headerTitle}</span>${deskSession?.sandboxed ? renderSandboxIndicator(deskSession.status) : ""}${(deskSession?.status === "preparing" || deskSession?.status === "starting") ? html`<span class="shrink-0 text-muted-foreground/70 italic" style="font-size:0.85em;">preparing…</span>` : ""}</span>
						${deskGoalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate uppercase tracking-wider">${deskGoalTitle}</span>` : ""}
					</div>
				</div>
			`;
		}

		if (!desktop) {
			return html`<div class="flex items-center gap-2 px-4 py-1">
				${bobbitIcon}
				<span class="text-base font-semibold text-foreground">Bobbit</span>
			</div>`;
		}
		return html`<div></div>`;
	};

	const headerRight = () => {
		if (desktop) {
			if (route.view === "settings" && settingsAppInfo) return renderSettingsAppVersionHeaderSlot();
			return hasHeaderSessionActions ? html`<div class="flex items-center gap-1 px-2">${headerSessionActions}</div>` : html``;
		}
		if (route.view === "settings" && settingsAppInfo) return renderSettingsAppVersionHeaderSlot();
		const settingsBtn = Button({
			variant: "ghost",
			size: "sm",
			children: html`${icon(Settings, "sm")}`,
			onClick: () => { import("./settings-page.js").then((m) => m.toggleSettings()); },
			title: "Settings",
		});
		if (showingSessionHeader) {
			return html``;
		}
		return html`
			<div class="flex items-center gap-1 px-2">
				${settingsBtn}
				${state.showHeadquartersInProjectLists !== false
					? html`<span data-testid="support-launcher" style="display:contents">${Button({
						variant: "ghost",
						size: "sm",
						children: html`${icon(MessageCircleQuestion, "sm")}`,
						onClick: () => { showSupportDialog(); },
						title: "Open a new support agent session",
					})}</span>`
					: nothing}
				${Button({
					variant: "ghost",
					size: "sm",
					children: html`${icon(QrCode, "sm")}`,
					onClick: showQrCodeDialog,
					title: "Show QR code",
				})}
				<bell-toggle></bell-toggle>
				<theme-toggle></theme-toggle>
			</div>
		`;
	};

	const orphanTranscriptsBanner = () => {
		const n = state.orphanedTranscriptsCount;
		if (!n || n <= 0) return "";
		return html`
			<div
				class="shrink-0 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
				data-testid="orphan-transcripts-banner"
				title="Agent transcripts exist on disk that are not tracked in sessions.json. See gateway logs for paths."
			>
				<span>${n} agent transcript${n === 1 ? "" : "s"} on disk are not tracked — see logs</span>
			</div>
		`;
	};

	const reconnectBanner = () => {
		if (!connected || state.connectionStatus === "connected") return "";
		return html`
			<div class="reconnect-banner shrink-0 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium
				${state.connectionStatus === "reconnecting"
					? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
					: "bg-red-500/15 text-red-700 dark:text-red-400"}">
				${state.connectionStatus === "reconnecting"
					? html`
						<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
						</svg>
						<span>Reconnecting to server…</span>`
					: html`<span>Disconnected from server</span>`}
			</div>
		`;
	};

	const reviewPaneUnsentCountForDocument = (sessionId: string, title: string): number => {
		const pane = document.querySelector("review-pane") as (HTMLElement & { _unsentCommentCountForDocument?: (title: string) => number }) | null;
		if (pane && typeof pane._unsentCommentCountForDocument === "function") {
			const count = Number(pane._unsentCommentCountForDocument(title));
			if (Number.isFinite(count)) return count;
		}
		return getDocumentAnnotationCount(sessionId, title);
	};

	const closeUnifiedPanelTab = (tab: UnifiedPanelTab, event?: Event): void => {
		event?.preventDefault();
		event?.stopPropagation();
		if ((tab as any).kind === "chat") return;
		const sid = workspaceSessionId();
		const activeId = activeSidePanelTabIdForSession(state, sid);
		const wasActive = activeId === tab.id;
		const tabsBefore = unifiedPanelTabs();
		const nextId = nextActivePanelTabId(tabsBefore, tab.id);
		const nextCandidate = nextId ? findPanelTab(tabsBefore, nextId) : undefined;
		const closeServerTab = () => {
			void (async () => {
				if (wasActive) setActivePanelTabIdForSession(state, sid, nextId || "");
				await closeServerSidePanelTab(tab.id, { sessionId: sid });
				// The user can close a locally-active tab before the prior active-tab REST
				// mutation settles. Commit the Chrome-style successor from the UI order so
				// the server and other browser contexts converge on the same active tab.
				if (wasActive && nextId) await setServerActiveSidePanelTab(nextId, { sessionId: sid });
			})().catch((err) => {
				console.warn("[side-panel] close mutation failed", err);
				// Fallback for no-session/test harnesses that do not have the server workspace API.
				setPanelTabsForSession(state, sid, panelTabsForSession(state, sid).filter((candidate) => candidate.id !== tab.id));
				if (wasActive) {
					if (nextCandidate) setUnifiedActiveTab(nextCandidate);
					else setActivePanelTabIdForSession(state, sid, "");
				}
				renderApp();
			});
		};

		if (tab.kind === "proposal" && tab.source.type === "proposal" && !isHistoricalProposalTab(tab)) {
			lazyProposalPanels.dismissTypedProposal(tab.source.proposalType);
			closeServerTab();
			return;
		}
		if (tab.kind === "review") {
			const title = reviewTitleFromPanelTab(tab);
			const key = reviewDocumentKeyFromPanelTab(tab);
			if (key) {
				const sid = activeSessionId() || "";
				if (event?.type !== "review-close-tab") {
					const count = reviewPaneUnsentCountForDocument(sid, key);
					if (count > 0 && !confirm(`Close "${title || key}"? ${count} unsent comment${count !== 1 ? "s" : ""} will be hidden until reopened.`)) return;
				}
				if (state.reviewActiveTab === key) {
					const nextReview = nextCandidate?.kind === "review" ? reviewDocumentKeyFromPanelTab(nextCandidate) : "";
					if (nextReview) state.reviewActiveTab = nextReview;
				}
			}
		}
		if (tab.kind === "inbox") {
			state.inboxPanelOpen = false;
			state.inboxAddDialogOpen = false;
		}
		if (tab.kind === "preview") {
			const remainingPreviewTabs = tabsBefore.filter((candidate) => candidate.id !== tab.id && candidate.kind === "preview");
			if (remainingPreviewTabs.length === 0) {
				state.isPreviewSession = false;
				state.previewPanelEntry = "";
				state.previewPanelMtime = 0;
				(state as any).previewPanelContentHash = "";
				(state as any).previewPanelMountedTabId = "";
				mountedPreviewTabId = "";
			} else {
				// `buildPanelWorkspaceTabs` derives a current preview tab from
				// `state.previewPanelEntry`. If we just closed the tab for that
				// entry, point `previewPanelEntry` at a remaining preview so the
				// builder doesn't re-emit the closed tab on the next render. The
				// closed tab might be the historical version of an entry whose
				// current/filename tab still exists — preserve that case.
				const closedEntry = previewEntryFromTab(tab);
				const remainingEntryStillPresent = remainingPreviewTabs.some((candidate) => previewEntryFromTab(candidate) === closedEntry);
				if (!remainingEntryStillPresent && state.previewPanelEntry && previewEntryFromTab(tab) === state.previewPanelEntry) {
					const fallback = remainingPreviewTabs.find((candidate) => !!previewEntryFromTab(candidate));
					const fallbackEntry = fallback ? previewEntryFromTab(fallback) : "";
					const fallbackHash = fallback ? previewContentHashFromTab(fallback) : "";
					state.previewPanelEntry = fallbackEntry || "";
					(state as any).previewPanelContentHash = fallbackHash || "";
					state.previewPanelMtime = fallback && typeof (fallback.state as any)?.mtime === "number"
						? (fallback.state as any).mtime
						: state.previewPanelMtime;
				}
			}
		}

		closeServerTab();
	};

	const panelTabHasDot = (tab: UnifiedPanelTab): boolean => {
		if (tab.kind === "inbox") return state.inboxEntries.some((e) => e.state === "pending");
		if (tab.kind !== "proposal" || tab.source.type !== "proposal") return false;
		const type = tab.source.proposalType;
		return state.activeProposals[type] != null || (type === currentAssistantProposalType() && state.assistantHasProposal);
	};

	const panelTabButtonLabel = (tab: UnifiedPanelTab): string => {
		if (tab.kind === "review") return tab.title || tab.label || "Review";
		return tab.label || tab.title || (tab.kind === "preview" ? "Preview" : "");
	};

	const panelTabButton = (tab: UnifiedPanelTab, testId: string) => {
		const label = panelTabButtonLabel(tab);
		const sourceTitle = tab.kind === "preview" ? previewSourceTitle(tab) : "";
		const tooltip = sourceTitle || label;
		const dataTitle = sourceTitle || tab.title;
		const closable = !isPinnedPanelTab(tab);
		const draggable = isDesktop() && !isPinnedPanelTab(tab);
		const activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
		// On mobile, when the slider is on the chat pane (index 0) no panel tab
		// should be highlighted — the pinned chat pill owns the active state.
		const mobileChatActive = !isDesktop() && mobileSelectedPaneIndex === 0;
		const tabIsActive = !mobileChatActive && activeId === tab.id;
		return html`
		<div
			role="button"
			tabindex="0"
			class="goal-tab-pill ${tabIsActive ? "goal-tab-pill--active" : ""} ${draggable ? "goal-tab-pill--draggable" : "goal-tab-pill--pinned"} ${draggingPanelTabId === tab.id ? "goal-tab-pill--dragging" : ""}"
			title=${tooltip}
			data-panel-tab-id=${tab.id}
			data-panel-tab-kind=${tab.kind}
			data-panel-tab-title=${dataTitle}
			data-panel-tab-pinned=${isPinnedPanelTab(tab) ? "true" : "false"}
			data-testid="side-panel-tab"
			@mousedown=${(e: MouseEvent) => { if ((e.target as Element | null)?.closest?.(".goal-tab-close")) return; setUnifiedMobileTab(tab); }}
			@pointerup=${(e: PointerEvent) => { if ((e.target as Element | null)?.closest?.(".goal-tab-close")) return; setUnifiedMobileTab(tab); }}
			@click=${() => { setUnifiedMobileTab(tab); renderApp(); }}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setUnifiedMobileTab(tab); renderApp(); } }}
		>${testId ? html`<span class="goal-tab-pill-label" data-testid=${testId}>${label}</span>` : html`<span class="goal-tab-pill-label">${label}</span>`}${panelTabHasDot(tab) ? html`<span class="goal-tab-dot"></span>` : ""}${closable ? html`<span
				class="goal-tab-close"
				role="button"
				aria-label=${`Dismiss ${label}`}
				title=${`Dismiss ${label}`}
				data-testid="side-panel-close"
				@click=${(event: Event) => closeUnifiedPanelTab(tab, event)}
			>${icon(X, "xs")}</span>` : ""}</div>
	`;
	};

	const unifiedMobileTabButton = (tab: UnifiedPanelTab) => panelTabButton(
		tab,
		tab.kind === "inbox" ? "inbox-tab-pill" : "",
	);

	const mobileChatTabPill = () => {
		const isChatActive = mobileSelectedPaneIndex === 0;
		return html`
			<div
				role="button"
				tabindex="0"
				class="goal-tab-pill goal-tab-pill--pinned ${isChatActive ? "goal-tab-pill--active" : ""}"
				title="Chat"
				data-panel-tab-id="__mobile_chat_pane__"
				data-panel-tab-kind="chat"
				data-panel-tab-pinned="true"
				@click=${() => { setUnifiedMobilePaneByIndex(0); }}
				@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setUnifiedMobilePaneByIndex(0); } }}
			><span class="goal-tab-pill-label">Chat</span></div>
		`;
	};

	const unifiedTabBar = () => {
		if (!hasUnifiedPanel()) return "";
		// Refresh mobileSelectedPaneIndex BEFORE rendering the tab bar so both
		// the chat pill and the panel pills see the same value. Otherwise on
		// first load the bar renders with paneIndex=0 (chat highlighted) while
		// the slider then advances to the active panel tab — leaving both
		// visually highlighted until the next render.
		void unifiedMobilePaneIndex();
		// Mirror the desktop tab strip: muted background, tabs flush at the
		// bottom via items-end + pt-1 (no bottom padding), no border-b. The
		// active tab's background matches the content panel below so the two
		// merge seamlessly (Chrome-style), with the curve pseudo-elements
		// providing the outward flare at the bottom corners.
		return html`
			<div class="goal-tab-bar goal-tab-bar--mobile shrink-0 overflow-x-auto" style="scrollbar-width:thin; background: var(--muted, var(--color-muted));">
				<div
					class="flex items-end gap-1 px-3 pt-1 min-w-max"
					data-panel-tab-bar="true"
				>
					${mobileChatTabPill()}
					${repeat(unifiedPanelTabs(), (tab) => tab.id, (tab) => unifiedMobileTabButton(tab))}
				</div>
			</div>
		`;
	};

	const sidePanelSizeMode = () => getSidePanelSizeMode(workspaceSessionId());
	const setSidePanelModeAndRender = (mode: SidePanelSizeMode) => {
		void setSidePanelSizeMode(mode, workspaceSessionId());
	};
	const isSidePanelCollapsed = () => sidePanelSizeMode() === "collapsed";

	const previewRestoreErrorContent = (tab: UnifiedContentTab) => {
		const restoreError = previewRestoreError(tab);
		if (!restoreError) return "";
		const retry = () => {
			const sid = activeSessionId() || previewSessionIdFromTab(tab);
			const nextTab = sid ? clearPreviewTabRestoreError(sid, tab.id) ?? tab : tab;
			restoreHistoricalPreviewTab(nextTab);
			renderApp();
		};
		return html`
			<div class="preview-restore-error flex-1 min-h-0 flex items-center justify-center p-6" data-testid="preview-restore-error" data-panel-tab-id=${tab.id}>
				<div class="preview-restore-error-card">
					<div class="preview-restore-error-title">Preview artifact unavailable</div>
					<div class="preview-restore-error-body">${restoreError.detail || restoreError.message || "This preview could not be restored."}</div>
					<div class="preview-restore-error-actions">
						${restoreError.retryable !== false ? html`<button class="preview-restore-error-button" @click=${retry}>Retry</button>` : ""}
						<button class="preview-restore-error-button" @click=${(event: Event) => closeUnifiedPanelTab(tab, event)}>Close tab</button>
					</div>
				</div>
			</div>
		`;
	};

	/** Render the HTML preview iframe content (no header — unified panel provides it). */
	//
	// WP-E: single iframe pointing at the per-session preview mount. The agent
	// writes into <stateDir>/preview/<sid>/, the gateway serves from
	// `/preview/<sid>/<rel-path>` with cookie auth + theme-bridge injection on
	// text/html responses. Hot reloads come via SSE bumping `previewPanelMtime`,
	// which forces the iframe to reload via the `#mtime=<n>` hash.
	const htmlPreviewContent = () => {
		const sid = activeSessionId() || "";
		// Derive artifactId, entry, and mtime from the active panel tab rather than
		// requiring global preview mirrors to be populated. After a gateway restart,
		// the server-persisted workspace tab can be restored before the session's
		// transient previewPanelEntry mirror is repopulated.
		const activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
		const panelTabs = unifiedPanelContentTabs();
		const activeTab = panelTabs.find((t) => t.id === activeId);
		let artifactId = "";
		let entry = state.previewPanelEntry || "";
		let tabMtime = 0;
		if (activeTab && activeTab.kind === "preview") {
			const tabState = (activeTab.state || {}) as Record<string, unknown>;
			const source = activeTab.source as Record<string, unknown>;
			const tabEntry = previewEntryFromTab(activeTab);
			if (tabEntry) entry = tabEntry;
			if (typeof tabState.mtime === "number" && Number.isFinite(tabState.mtime)) tabMtime = tabState.mtime;
			const isLiveTab = isLivePreviewTab(activeTab);
			if (!isLiveTab) artifactId = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");
		}
		const v = state.previewPanelMtime || tabMtime || 0;
		if (!sid || !entry) {
			// Empty-state until the first SSE `preview-changed` event lands.
			return html`
				<div class="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm">
					No preview yet.
				</div>
			`;
		}
		// When the active tab is backed by a persisted artifact, serve directly
		// from `/preview/<sid>/_artifact/<artifactId>/<entry>` — each artifact's
		// bytes live at a stable URL, so switching tabs requires no mount POST
		// (just an iframe src change, which the browser caches across switches).
		const src = artifactId
			? `/preview/${encodeURIComponent(sid)}/_artifact/${encodeURIComponent(artifactId)}/${encodeURIComponent(entry)}?mtime=${v}`
			: `/preview/${encodeURIComponent(sid)}/${encodeURIComponent(entry)}?mtime=${v}`;
		return html`
			<div style="position:relative;flex:1;min-height:0;">
				<iframe
					class="w-full border-0"
					style="position:absolute;inset:0;height:100%;"
					sandbox="allow-scripts allow-same-origin"
					src=${src}
				></iframe>
			</div>
		`;
	};

	/** Unified preview panel with tab header + content dispatch.
	 *  Used on desktop for non-assistant sessions that have preview or goal proposal. */
	const reviewPaneContent = () => html`
		<div class="flex-1 min-h-0 overflow-auto">
			<review-pane
				.documents=${state.reviewDocuments}
				.activeTab=${state.reviewActiveTab}
				.sessionId=${activeSessionId() || ""}
				@review-tab-change=${(e: CustomEvent) => {
					const title = e.detail.title as string;
					state.reviewActiveTab = title;
					const tab = findReviewPanelTabByTitle(title);
					if (tab) setUnifiedActiveTab(tab);
					renderApp();
				}}
				@review-submit=${async (e: CustomEvent) => {
					const agent = state.remoteAgent;
					if (agent) {
						agent.prompt(e.detail.feedback);
						const sid = activeSessionId() || "";
						const reviewTabIds = [...new Set([
							...unifiedPanelTabs().filter((tab) => tab.kind === "review").map((tab) => tab.id),
							...getSidePanelWorkspace(sid).tabs.filter((tab) => tab.kind === "review").map((tab) => tab.id),
						])];
						const remainingLegacyTabs = panelTabsForSession(state, sid).filter((tab) => tab.kind !== "review");
						setPanelTabsForSession(state, sid, remainingLegacyTabs);
						setActivePanelTabIdForSession(state, sid, remainingLegacyTabs[0]?.id || "");
						const { clearPersistedReviewDocuments } = await loadReviewSources();
						clearAllAnnotations(sid);
						clearPersistedReviewDocuments(sid);
						markReviewSubmitted(sid);
						await gatewayFetch(`/api/sessions/${encodeURIComponent(sid)}/review/submitted`, {
							method: "PUT",
							body: JSON.stringify({ submitted: true }),
						}).catch(() => undefined);
						await flushPendingWrites();
						state.reviewDocuments = new Map();
						state.reviewPanelOpen = false;
						state.reviewActiveTab = "";
						for (const tabId of reviewTabIds) {
							try { await closeServerSidePanelTab(tabId, { sessionId: sid }); }
							catch { /* best-effort */ }
						}
						renderApp();
					}
				}}
				@review-decision=${async (e: CustomEvent) => {
					e.preventDefault();
					const sid = activeSessionId() || "";
					try {
						const {
							reviewDecisionPayloadFromDetail,
							reviewDocumentFromDecisionDetail,
							submitReviewDecision,
						} = await loadReviewSources();
						const doc = reviewDocumentFromDecisionDetail(e.detail);
						const payload = reviewDecisionPayloadFromDetail(e.detail, sid, doc);
						if (!doc || !payload) {
							showHeaderToast("Could not submit review decision");
							return;
						}
						await submitReviewDecision(doc, payload, {
							sessionId: sid,
							prompt: async (feedback) => {
								const agent = state.remoteAgent;
								if (!agent) throw new Error("No active agent is available for this review.");
								agent.prompt(feedback);
							},
						});
					} catch (err) {
						showHeaderToast(err instanceof Error ? err.message : "Review decision failed");
					}
				}}
				@review-close-tab=${(e: CustomEvent) => {
					const title = e.detail.title as string;
					const tab = findReviewPanelTabByTitle(title);
					if (tab) closeUnifiedPanelTab(tab, e);
					else {
						const keys = [...state.reviewDocuments.keys()].filter((key) => key !== title);
						if (state.reviewActiveTab === title) state.reviewActiveTab = keys[0] || title;
						renderApp();
					}
				}}
				@review-dismiss=${async () => {
					const sid = activeSessionId() || "";
					const reviewTabIds = [...new Set([
						...unifiedPanelTabs().filter((tab) => tab.kind === "review").map((tab) => tab.id),
						...getSidePanelWorkspace(sid).tabs.filter((tab) => tab.kind === "review").map((tab) => tab.id),
					])];
					const hasMarkdownReview = [...state.reviewDocuments.values()].some((doc) => !doc.source || doc.source.kind === "markdown-review");
					const remainingLegacyTabs = panelTabsForSession(state, sid).filter((tab) => tab.kind !== "review");
					setPanelTabsForSession(state, sid, remainingLegacyTabs);
					setActivePanelTabIdForSession(state, sid, remainingLegacyTabs[0]?.id || "");
					const { clearPersistedReviewDocuments } = await loadReviewSources();
					clearAllAnnotations(sid);
					clearPersistedReviewDocuments(sid);
					if (hasMarkdownReview) {
						markReviewSubmitted(sid);
						await gatewayFetch(`/api/sessions/${encodeURIComponent(sid)}/review/submitted`, {
							method: "PUT",
							body: JSON.stringify({ submitted: true }),
						}).catch(() => undefined);
					}
					state.reviewDocuments = new Map();
					state.reviewPanelOpen = false;
					state.reviewActiveTab = "";
					for (const tabId of reviewTabIds) {
						try { await closeServerSidePanelTab(tabId, { sessionId: sid }); }
						catch { /* best-effort */ }
					}
					renderApp();
				}}
			></review-pane>
		</div>
	`;

	const sidePanelChromeButtonClass = "text-muted-foreground hover:text-foreground";
	const sidePanelChromeButtonStyle = "background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;display:inline-flex;align-items:center;";

	const previewUrlForTab = (tab?: UnifiedContentTab | null) => {
		const sid = activeSessionId() || workspaceSessionId();
		let entry = state.previewPanelEntry || "inline.html";
		let artifactId = "";
		if (tab?.kind === "preview") {
			const tabState = (tab.state || {}) as Record<string, unknown>;
			const source = tab.source as Record<string, unknown>;
			const tabEntry = previewEntryFromTab(tab);
			if (tabEntry) entry = tabEntry;
			if (!isLivePreviewTab(tab)) artifactId = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");
		}
		return artifactId
			? `/preview/${encodeURIComponent(sid)}/_artifact/${encodeURIComponent(artifactId)}/${encodeURIComponent(entry)}`
			: `/preview/${encodeURIComponent(sid)}/${encodeURIComponent(entry)}`;
	};

	const sidePanelPopoutUrl = (tab: UnifiedContentTab) => {
		if (tab.kind === "preview") return previewUrlForTab(tab);
		const sid = ((tab.source as Record<string, unknown> | undefined)?.sessionId as string | undefined) || activeSessionId() || workspaceSessionId();
		return `#/session/${encodeURIComponent(sid)}/panel/${encodeURIComponent(tab.id)}`;
	};

	const sidePanelPopoutButton = (tab: UnifiedContentTab) => tab.kind === "preview" ? html`
		<a
			href=${previewUrlForTab(tab)}
			target="_blank"
			rel="noopener noreferrer"
			class=${sidePanelChromeButtonClass}
			style=${sidePanelChromeButtonStyle}
			title="Open preview in new tab"
		>${icon(ExternalLink, "sm")}</a>
	` : html`<a
			href=${sidePanelPopoutUrl(tab)}
			target="_blank"
			rel="noopener noreferrer"
			class=${sidePanelChromeButtonClass}
			style=${sidePanelChromeButtonStyle}
			title="Open side panel in new tab"
			data-testid="side-panel-popout"
		>${icon(ExternalLink, "sm")}</a>`;

	const sidePanelActionButtons = (tab: UnifiedContentTab) => html`
		${tab.kind === "preview" && (previewEntryFromTab(tab) || state.previewPanelEntry) ? html`
			<button @click=${() => { state.previewPanelMtime = Date.now(); renderApp(); }} class=${sidePanelChromeButtonClass} style=${sidePanelChromeButtonStyle} title="Refresh preview">
				${icon(RotateCw, "sm")}
			</button>
		` : ""}
		${tab.kind === "preview" && !(previewEntryFromTab(tab) || state.previewPanelEntry) ? "" : sidePanelPopoutButton(tab)}
	`;

	const sidePanelWindowControls = (tab: UnifiedContentTab, mode: SidePanelSizeMode) => {
		const fullscreenTitle = tab.kind === "preview"
			? `Expand preview to fullscreen${shortcutHint("toggle-sidebar")}`
			: `Expand side panel to fullscreen${shortcutHint("toggle-sidebar")}`;
		const collapseTarget: SidePanelSizeMode = mode === "fullscreen" ? "split" : "collapsed";
		const collapseTitle = mode === "fullscreen"
			? `Collapse to split view${shortcutHint("toggle-preview")}`
			: `Collapse side panel${shortcutHint("toggle-preview")}`;
		return html`
		${mode === "fullscreen" ? "" : html`
			<button @click=${() => setSidePanelModeAndRender("fullscreen")} class=${sidePanelChromeButtonClass} style=${sidePanelChromeButtonStyle} title=${fullscreenTitle} data-testid="side-panel-fullscreen">
				${icon(PanelRightOpen, "sm")}
			</button>
		`}
		<button @click=${() => setSidePanelModeAndRender(collapseTarget)} class=${sidePanelChromeButtonClass} style=${sidePanelChromeButtonStyle} title=${collapseTitle} data-testid="side-panel-collapse">
			${icon(PanelRightClose, "sm")}
		</button>
	`;
	};

	const inboxPaneContent = () => {
		const sid = activeSessionId() || "";
		const sess = sid ? state.gatewaySessions.find((s) => s.id === sid) : undefined;
		const staffId = sess?.staffId || "";
		return html`
			<div class="flex-1 min-h-0 overflow-hidden" data-testid="inbox-panel-root">
				<inbox-panel
					.entries=${state.inboxEntries}
					.staffId=${staffId}
					.sessionId=${sid}
					.addDialogOpen=${state.inboxAddDialogOpen}
					@inbox-open-add=${() => { state.inboxAddDialogOpen = true; renderApp(); }}
					@inbox-add-close=${() => { state.inboxAddDialogOpen = false; renderApp(); }}
					@inbox-add-submitted=${() => { state.inboxAddDialogOpen = false; renderApp(); }}
				></inbox-panel>
			</div>
		`;
	};

	const proposalPanelContent = (tab: UnifiedContentTab) => {
		if (tab.kind !== "proposal" || tab.source.type !== "proposal") return "";
		const type = tab.source.proposalType;
		// Skip lazy-loading the proposal-panels chunk when there's nothing to
		// render. Historical tabs always have content (the field snapshot),
		// so they proceed regardless of the live activeProposals slot.
		if (!isHistoricalProposalTab(tab) && state.activeProposals[type] == null && type !== currentAssistantProposalType()) return "";
		return lazyProposalPanels.proposalPanelContent(tab, currentAssistantProposalType);
	};

	// Slice B4 — content of a pack-contributed side panel. The lazy module load is
	// kicked off by openPackPanel; this is a PURE projection of the tab's typed
	// params onto the loaded panel's render() (or a loading placeholder). No
	// auto-invoke on mount (design extension-host-phase2.md §6).
	const packPanelContent = (tab: UnifiedContentTab) => {
		if (tab.kind !== "pack") return "";
		const source = (tab.source || {}) as Record<string, unknown>;
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const ref = packPanelRefFromTabId(tab.id);
		const packId = ref?.packId
			|| (typeof source.packId === "string" ? source.packId : "")
			|| (typeof tabState.packId === "string" ? tabState.packId : "");
		const panelId = ref?.panelId
			|| (typeof source.panelId === "string" ? source.panelId : "")
			|| (typeof tabState.panelId === "string" ? tabState.panelId : "");
		if (!packId || !panelId) return "";
		const params = (source.params as Record<string, unknown> | undefined)
			|| (tabState.params as Record<string, unknown> | undefined);
		// Bind the panel's host to the SESSION THE TAB BELONGS TO (its source.sessionId),
		// not the currently-selected session. A reviewer-child pane lives beside the
		// child session while the user may still view the parent; binding the host to
		// the child keeps host.callRoute carrying the child's x-bobbit-session-id so the
		// server resolves ctx.workingDir against the child's worktree (avoids "Invalid
		// baseSha" when recover/publish recompute the live diff).
		const boundSessionId = (typeof source.sessionId === "string" ? source.sessionId : "")
			|| (typeof tabState.sessionId === "string" ? tabState.sessionId : "")
			|| undefined;
		return html`
			<div class="flex-1 min-h-0 overflow-auto" data-testid="pack-panel-root" data-panel-tab-id=${tab.id} data-pack-panel-id=${panelId} data-pack-id=${packId}>
				${renderPackPanelContent(packId, panelId, params, boundSessionId)}
			</div>
		`;
	};

	const unifiedPanelContent = (tab: UnifiedContentTab) => {
		if (tab.kind === "preview") return previewRestoreError(tab) ? previewRestoreErrorContent(tab) : htmlPreviewContent();
		if (tab.kind === "review" && state.reviewPanelOpen) {
			const reviewKey = reviewDocumentKeyFromPanelTab(tab);
			if (reviewKey && state.reviewActiveTab !== reviewKey) {
				state.reviewActiveTab = reviewKey;
			}
			return reviewPaneContent();
		}
		if (tab.kind === "inbox" && state.inboxPanelOpen) return inboxPaneContent();
		if (tab.kind === "proposal" && tab.source.type === "proposal") {
			return proposalPanelContent(tab);
		}
		if (tab.kind === "pack") return packPanelContent(tab);
		return "";
	};

	const unifiedDesktopTabButton = (tab: UnifiedContentTab) => panelTabButton(
		tab,
		tab.kind === "inbox" ? "inbox-tab-unified" : "",
	);

	const activeSidePanelContentTab = (): UnifiedContentTab | null => {
		const contentTabs = unifiedPanelContentTabs();
		if (contentTabs.length === 0) return null;

		let activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
		let activeTab = contentTabs.find((tab) => tab.id === activeId) ?? contentTabs[0];
		if (activeId !== activeTab.id) {
			setUnifiedDesktopTab(activeTab);
			activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
			activeTab = contentTabs.find((tab) => tab.id === activeId) ?? activeTab;
		}
		return activeTab;
	};

	const renderSidePanelWorkspace = (mode: SidePanelSizeMode = "split") => {
		const contentTabs = unifiedPanelContentTabs();
		const activeTab = activeSidePanelContentTab();
		if (!activeTab) return "";

		return html`
			<div class="side-panel-workspace goal-preview-panel flex-1 flex flex-col ${mode === "split" ? "border-l border-border" : ""} min-h-0" data-panel-workspace="content" data-side-panel-mode=${mode}>
				<!-- Chrome-style tab strip: muted bg distinct from the panel below.
				     Tabs sit flush at the strip's bottom via items-end + no pb.
				     The active tab's background matches the panel so it visually
				     bridges the color boundary (curve pseudo-elements in CSS do
				     the outward-curve flourish at the bottom corners). -->
				<div class="flex items-end justify-between px-3 pt-1 shrink-0 min-w-0" style="background: var(--muted, var(--color-muted));">
					<div class="flex-1 min-w-0">
						<div class="flex items-end gap-1" data-panel-tab-bar="true">
							${repeat(contentTabs, (tab) => tab.id, (tab) => unifiedDesktopTabButton(tab))}
						</div>
					</div>
					<div class="flex items-center gap-0.5 shrink-0 pl-2 pb-1">
						${sidePanelActionButtons(activeTab)}
						${sidePanelWindowControls(activeTab, mode)}
					</div>
				</div>
				<!-- Tab content -->
				${unifiedPanelContent(activeTab)}
			</div>
		`;
	};

	const sidePanelRestoreButton = () => html`
		<button @click=${() => setSidePanelModeAndRender("split")} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:6px 4px;border-left:1px solid var(--border);align-self:stretch;display:flex;align-items:center;" title=${`Expand side panel${shortcutHint("toggle-sidebar")}`} data-testid="side-panel-restore">
			${icon(PanelRightOpen, "sm")}
		</button>
	`;
	/** Render individual pane content for mobile slider. */
	const mobilePaneContent = (tab: MobilePaneTab) => {
		if (tab.kind === "chat") return html`${renderGoalPausedBannerIfNeeded(activeSession)}${state.chatPanel}`;
		const content = unifiedPanelContent(tab);
		return html`<div class="side-panel-pane goal-preview-panel flex-1 flex flex-col min-h-0" data-panel-tab-id=${tab.id}>${content}</div>`;
	};

	const mainArea = () => {
		// Instant-loader gate: show bouncing bobbit immediately when a session
		// is being created or connected, regardless of current route. This must
		// be the first check so clicks on session-creation entry points feel
		// responsive within one render frame.
		if (state.creatingSession || state.connectingSessionId) {
			return html`<div class="flex-1 min-h-0" data-testid="bobbit-loader">${bobbitLoadingAnimation()}</div>`;
		}
		// Goal dashboard route
		const route = getRouteFromHash();
		if (route.view === "goal-dashboard" && route.goalId) {
			return lazyPage("goal-dashboard", () => import("./goal-dashboard.js"), "renderGoalDashboard");
		}
		if (route.view === "roles" || route.view === "role-edit") {
			return lazyPage("role-manager", () => import("./role-manager-page.js"), "renderRoleManagerPage");
		}
		if (route.view === "tools" || route.view === "tool-edit") {
			return lazyPage("tool-manager", () => import("./tool-manager-page.js"), "renderToolManagerPage");
		}
		if (route.view === "workflows" || route.view === "workflow-edit") {
			return lazyPage("workflow", () => import("./workflow-page.js"), "renderWorkflowPage");
		}
		if (route.view === "staff" || route.view === "staff-edit") {
			return lazyPage("staff", () => import("./staff-page.js"), "renderStaffPage");
		}
		if (route.view === "skills") {
			return lazyPage("skills", () => import("./skills-page.js"), "renderSkillsPage");
		}
		if (route.view === "market") {
			return lazyPage("marketplace", () => import("./marketplace-page.js"), "renderMarketplacePage");
		}
		if (route.view === "settings") {
			return lazyPage("settings", () => import("./settings-page.js"), "renderSettingsPage");
		}
		if (route.view === "search") {
			lazyPageCall("search", () => import("./search-page.js"), "initSearchPage");
			return lazyPage("search", () => import("./search-page.js"), "renderSearchPage");
		} else {
			// resetSearchPage is a no-op when the chunk hasn't loaded yet.
			lazyPageCall("search", () => import("./search-page.js"), "resetSearchPage", false);
		}

		if (route.view === "session" && route.panelTabId) {
			if (!connected) return html`${reconnectBanner()}<div class="flex-1 min-h-0" data-testid="bobbit-loader">${bobbitLoadingAnimation()}</div>`;
			const sid = workspaceSessionId();
			const workspace = state.sidePanelWorkspaceBySession?.[sid];
			if (!workspace) return html`${reconnectBanner()}<div class="flex-1 min-h-0" data-testid="bobbit-loader">${bobbitLoadingAnimation()}</div>`;
			const tab = workspace.tabs.find((candidate) => candidate.id === route.panelTabId);
			if (!tab) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 min-h-0 flex items-center justify-center p-8 text-center" data-testid="side-panel-route-missing">
						<div class="max-w-sm rounded-lg border border-border bg-card p-5 shadow-sm">
							<div class="text-sm font-semibold text-foreground mb-2">Panel is closed</div>
							<div class="text-sm text-muted-foreground mb-4">This side-panel tab is not open for this session anymore.</div>
							<a class="text-sm text-primary hover:underline" href=${`#/session/${encodeURIComponent(sid)}`}>Back to session</a>
						</div>
					</div>
				`;
			}
			if (workspace.activeTabId !== tab.id) setActivePanelTabIdForSession(state, sid, tab.id);
			return html`${reconnectBanner()}<div class="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="side-panel-route-content">${renderSidePanelWorkspace("fullscreen")}</div>`;
		}

		const staffInboxOpenAffordance = () => {
			const sid = activeSessionId() || "";
			const sess = sid ? state.gatewaySessions.find((s) => s.id === sid) : undefined;
			const hasInboxTab = !!sid && getSidePanelWorkspace(sid).tabs.some((tab) => tab.id === "inbox" && tab.kind === "inbox");
			if (!sess?.staffId || hasInboxTab) return "";
			return html`
				<div class="shrink-0 border-b border-border bg-muted/30 px-3 py-2 flex items-center justify-between gap-3" style=${isDesktop() ? "" : "margin-top:var(--mobile-header-height,60px);"} data-testid="staff-inbox-reopen-bar">
					<span class="text-xs text-muted-foreground">Staff inbox is closed for this session.</span>
					<button class="text-xs rounded border border-border px-2 py-1 hover:bg-accent" data-testid="staff-inbox-open" @click=${() => openInboxPanel(sid, sess.staffId!)}>Open inbox</button>
				</div>
			`;
		};

		if (connected && hasUnifiedPanel()) {
			const mode = sidePanelSizeMode();
			if (desktop && mode === "fullscreen") {
				// Fullscreen: the panel fills to the bottom edge; the composer is hidden.
				// To use the prompt the user collapses to split (window controls / Ctrl+]).
				return html`
					${reconnectBanner()}
					${staffInboxOpenAffordance()}
					<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
						${renderSidePanelWorkspace("fullscreen")}
					</div>
				`;
			}
			if (desktop) {
				const collapsed = isSidePanelCollapsed();
				return html`
					${reconnectBanner()}
					${staffInboxOpenAffordance()}
					<div class="goal-split-layout side-panel-split-layout flex-1 flex min-h-0 overflow-hidden">
						<div class="${collapsed ? 'flex-1' : 'goal-chat-panel side-panel-chat-pane flex-1'} min-w-0 flex flex-col">${renderGoalPausedBannerIfNeeded(activeSession)}${state.chatPanel}</div>
						${collapsed ? sidePanelRestoreButton() : renderSidePanelWorkspace("split")}
					</div>
				`;
			}
			const panes = unifiedMobilePanes();
			const count = panes.length;
			const curIdx = unifiedMobilePaneIndex();
			const slideX = unifiedSlideX(curIdx, count);
			const trackW = count * 100;
			const paneW = 100 / count;
			return html`
				${reconnectBanner()}
				${staffInboxOpenAffordance()}
				<div class="side-panel-slider preview-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
					<div class="side-panel-slider__track preview-slider__track" style="display:flex;width:${trackW}%;height:100%;transform:translateX(${slideX}%);transition:transform 0.3s ease-out;will-change:transform;">
						${panes.map(tab => html`<div style="width:${paneW}%;height:100%;min-width:0;display:flex;flex-direction:column;">${mobilePaneContent(tab)}</div>`)}
					</div>
				</div>
			`;
		}
		if (connected) return html`${reconnectBanner()}${renderArchivedBanner()}${renderGoalPausedBannerIfNeeded(activeSession)}${staffInboxOpenAffordance()}${state.chatPanel}`;

		if (desktop) {
			return html`
				${orphanTranscriptsBanner()}
				<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
					${_headquartersHiddenWithNoVisibleProjects() ? _hiddenHeadquartersFallback() : html`
						<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
						<p class="text-sm text-muted-foreground">${state.projects.length === 1 && isHeadquartersProject(state.projects[0])
							? "Start in Headquarters to configure Bobbit, coordinate work, or explore the server workspace."
							: "Select a session from the sidebar or create a new one"}</p>
						${Button({
							variant: "default",
							size: "sm",
							disabled: state.creatingSession,
							onClick: (e?: Event) => _onSplashSessionClick(e ?? new Event("click")),
							children: state.creatingSession
								? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
								: html`<span class="inline-flex items-center gap-1.5" data-testid="splash-new-session-label">${_splashSessionIcon()} ${_splashSessionLabel()}</span>`,
						})}
						${_splashProjectPicker()}
					`}
				</div>
			`;
		}
		return renderMobileLanding();
	};

	if (desktop) {
		teardownMobileScrollTracking();
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative">
				${headerToast()}
				${extRouteUnavailable()}
				${renderClientDebugButton()}
				<div class="flex items-center border-b border-border shrink-0 header-shadow" data-testid="app-header-row">
					${state.sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center self-stretch" style="background: var(--sidebar);">
						${bobbitIcon}
					</div>
					` : html`
					<div class="sidebar-header-shell shrink-0 flex items-center justify-between px-3 self-stretch" style="background: var(--sidebar); width: var(--sidebar-w, 240px);">
						<div class="sidebar-header-brand flex items-center gap-2">
							${bobbitIcon}
							<span class="text-base font-semibold text-foreground truncate">Bobbit</span>
						</div>
						<div class="sidebar-header-actions" aria-label="Sidebar shortcuts">
							${state.showHeadquartersInProjectLists !== false
								? html`<span data-testid="support-launcher" style="display:contents">${Button({
									variant: "ghost",
									size: "sm",
									children: html`${icon(MessageCircleQuestion, "xs")}`,
									onClick: () => { showSupportDialog(); },
									title: "Open a new support agent session",
									className: "sidebar-header-icon-btn h-6 w-6 text-muted-foreground",
								})}</span>`
								: nothing}
							${Button({
								variant: "ghost",
								size: "sm",
								children: html`${icon(QrCode, "xs")}`,
								onClick: showQrCodeDialog,
								title: "Show QR code",
								className: "sidebar-header-icon-btn h-6 w-6 text-muted-foreground",
							})}
							<bell-toggle></bell-toggle>
							<theme-toggle></theme-toggle>
						</div>
					</div>
					`}
					<div class="flex-1 flex items-center justify-between min-w-0">
						${headerLeft()}
						${headerRight()}
					</div>
				</div>
				<div class="flex-1 flex min-h-0">
					${renderSidebar()}
					<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">
						${mainArea()}
					</div>
				</div>
			</div>
		`, app);
	} else if (connected) {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative"
				data-mobile-header>
				${headerToast()}
				${extRouteUnavailable()}
				${renderClientDebugButton()}
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background flex flex-col">
					<div class="flex items-center justify-between border-b border-border" data-testid="app-header-row">
						${headerLeft()}
						${headerRight()}
					</div>
					${hasUnifiedPanel() ? unifiedTabBar() : ""}
				</div>
				<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
		ensureMobileScrollTracking();
		setupPreviewSwipe();
		requestAnimationFrame(() => {
			const headerEl = document.getElementById("app-header");
			if (headerEl) {
				const h = headerEl.offsetHeight;
				document.documentElement.style.setProperty("--mobile-header-height", `${h + 8}px`);
			}
		});
	} else {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative">
				${headerToast()}
				${extRouteUnavailable()}
				<div class="flex items-center justify-between border-b border-border shrink-0 header-shadow" data-testid="app-header-row">
					${headerLeft()}
					${headerRight()}
				</div>
				<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
	}

	// Attach SortableJS to the panel tab bar (if present). We look up the
	// element after each render rather than relying on lit's ref directive
	// (which proved unreliable with the no-name attribute placement on a
	// multi-line tag). ensurePanelSortable is idempotent — it no-ops if the
	// container is unchanged.
	const tabBar = document.querySelector<HTMLElement>("[data-panel-tab-bar]");
	ensurePanelSortable(tabBar);
}
