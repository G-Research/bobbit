import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "../ui/components/CommentableMarkdown.js";
import { renderFiltersButton } from "../ui/components/sidebar-filters.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { PrWalkthroughCard, PrWalkthroughChangesetRef } from "../ui/components/pr-walkthrough/types.js";
import Sortable from "sortablejs";
import { shortcutHint } from "./shortcut-registry.js";
import { Archive, ArrowLeft, ExternalLink, FileText, FolderOpen, FolderPlus, Link, MessagesSquare, ChevronDown, Goal as GoalIcon, PanelRightClose, PanelRightOpen, Pencil, Plus, QrCode, RotateCw, Server, Settings, Store, Trash2, Unplug, Users, Workflow as WorkflowIcon, Wrench, X, Zap } from "lucide";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	isUngroupedExpanded,
	setUngroupedExpanded,

	getSidebarData,
	setRenderSuppressed,
} from "./state.js";
import { gatewayFetch, refreshSessions } from "./api.js";
import { clearAllAnnotations, clearAnnotations, getDocumentAnnotationCount, markReviewSubmitted, flushPendingWrites } from "../ui/components/review/AnnotationStore.js";
import {
	clearPersistedReviewDocuments,
	openReviewDocumentFromEvent,
	removePersistedReviewDocument,
	reviewDecisionPayloadFromDetail,
	reviewDocumentFromDecisionDetail,
	submitReviewDecision,
} from "./review-sources.js";
import { backToSessions, createAndConnectSession, terminateSession } from "./session-manager.js";
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
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog, showProjectDialog } from "./dialogs-lazy.js";
import { startNewGoalFlow } from "./goal-entry.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown, isProjectExpanded, toggleProjectExpanded, filterStaffByQuery, renderStaffSidebarSection, isProjectReordering, projectOrderForRender, renderProjectReorderHandle, renderProjectReorderLiveRegion } from "./sidebar.js";
import { computeSpawnedClaim } from "./sidebar-spawned-children.js";
import { isClientDebugEnabled, dumpClientDebugToComposer, registerDebugSection } from "./client-debug.js";
import { fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated } from "./api.js";
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

import { renderGoalGroup, renderSessionRow, renderSandboxIndicator, INDENT, getProjectAccentColor, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery, bucketArchivedByProject, renderProjectArchivedSection, passesSidebarFilters, isChildSession } from "./render-helpers.js";
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
	markPreviewContentDismissed,
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
	reviewPanelTabId,
	reviewTitleFromPanelTab,
	setActivePanelTabIdForSession,
	walkthroughChangesetIdFromPanelTabId,
	walkthroughPanelTabId,
	setPanelTabsForSession,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import type { OpenPrWalkthroughInput } from "./pr-walkthrough.js";
import { restorePrWalkthroughJobForSession, restorePrWalkthroughPanel, upsertPrWalkthroughJobPanel } from "./pr-walkthrough.js";
import { ensurePrWalkthroughPanel } from "./pr-walkthrough-lazy.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

function prWalkthroughStandaloneHref(sessionId: string, tabId: string): string {
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	params.set("tab", tabId);
	return `/walkthrough?${params.toString()}`;
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

function _splashSessionLabel(): string {
	return state.projects.length === 0 ? "New Project" : "New Session";
}

function _splashSessionIcon() {
	return state.projects.length === 0 ? icon(FolderPlus, "sm") : icon(Plus, "sm");
}

function _onSplashSessionClick(e: Event): void {
	// Prevent bubble-to-document so the global outside-click handler below
	// doesn't immediately close the picker we're about to open.
	e.stopPropagation();
	const projects = state.projects;
	if (projects.length === 0) {
		showProjectDialog();
		return;
	}
	if (projects.length === 1) {
		const p = projects[0];
		createAndConnectSession(undefined, undefined, p.rootPath, undefined, undefined, p.id);
		return;
	}
	// ≥2 projects — open the splash project picker, anchored at the button.
	const btn = e.currentTarget as HTMLElement | null;
	_splashPickerAnchorRect = btn ? btn.getBoundingClientRect() : null;
	state.splashProjectPickerOpen = true;
	renderApp();
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
				const color = isDark
					? (p.colorDark || p.color || "var(--muted-foreground)")
					: (p.colorLight || p.color || "var(--muted-foreground)");
				return html`
					<button
						class="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/50 active:bg-secondary text-foreground flex items-center gap-2"
						data-testid="splash-project-picker-item"
						@click=${() => {
							state.splashProjectPickerOpen = false;
							createAndConnectSession(undefined, undefined, p.rootPath, undefined, undefined, p.id);
						}}
					>
						<span class="shrink-0" style="color:${color};">${icon(FolderOpen, "sm")}</span>
						<span class="flex-1 truncate">${p.name}</span>
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
	const doc = openReviewDocumentFromEvent((e as CustomEvent).detail, activeSessionId() || "");
	if (!doc) showHeaderToast("Could not open review document");
});

document.addEventListener("open-pr-walkthrough", (e: Event) => {
	const detail = ((e as CustomEvent).detail || {}) as Record<string, unknown>;
	const eventSource = (typeof (e as Event).composedPath === "function" ? (e as Event).composedPath()[0] : e.target) as Record<string, unknown> | null;
	const stringDetail = (...keys: string[]) => {
		for (const key of keys) {
			const value = detail[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		return undefined;
	};
	const numberDetail = (...keys: string[]) => {
		for (const key of keys) {
			const value = detail[key];
			if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
		}
		return undefined;
	};
	const filesFromDetail = () => {
		const explicit = numberDetail("filesChanged", "fileCount", "changedFiles");
		if (explicit != null) return explicit;
		for (const source of [detail, eventSource]) {
			if (!source) continue;
			for (const key of ["statusFiles", "status"]) {
				const value = source[key];
				if (Array.isArray(value)) return value.length;
			}
		}
		return undefined;
	};
	const input = {
		baseSha: stringDetail("baseSha", "base", "baseRef", "baseBranch"),
		headSha: stringDetail("headSha", "head", "headRef", "headBranch"),
		prNumber: typeof detail.prNumber === "string" || typeof detail.prNumber === "number"
			? detail.prNumber
			: typeof detail.number === "string" || typeof detail.number === "number"
				? detail.number
				: undefined,
		url: stringDetail("url", "prUrl"),
		prUrl: stringDetail("prUrl", "url"),
		title: stringDetail("title", "prTitle"),
		prTitle: stringDetail("prTitle", "title"),
		prBody: stringDetail("prBody", "body"),
		provider: stringDetail("provider"),
		filesChanged: filesFromDetail(),
		additions: numberDetail("additions", "insertions", "insertionsVsPrimary"),
		deletions: numberDetail("deletions", "deletionsVsPrimary"),
	} satisfies OpenPrWalkthroughInput;
	void import("./pr-walkthrough.js").then(({ openPrWalkthroughPanel }) => {
		void openPrWalkthroughPanel(state, activeSessionId() || "", input);
		renderApp();
	});
});

function handlePrWalkthroughJobUpdated(detail: unknown): void {
	const record = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
	const job = (record?.job && typeof record.job === "object" ? record.job : record) as any;
	if (!job?.jobId || !job?.childSessionId || !job?.changesetId || !job?.status) return;
	const active = activeSessionId();
	upsertPrWalkthroughJobPanel(state, job, { select: active === job.childSessionId });
	renderApp();
}

let prWalkthroughViewerWs: WebSocket | null = null;
let prWalkthroughViewerReconnect: ReturnType<typeof setTimeout> | null = null;

function connectPrWalkthroughViewerEvents(): void {
	if (prWalkthroughViewerWs && (prWalkthroughViewerWs.readyState === WebSocket.OPEN || prWalkthroughViewerWs.readyState === WebSocket.CONNECTING)) return;
	const token = localStorage.getItem("gateway.token");
	if (!token) {
		if (prWalkthroughViewerReconnect) clearTimeout(prWalkthroughViewerReconnect);
		prWalkthroughViewerReconnect = setTimeout(connectPrWalkthroughViewerEvents, 3_000);
		return;
	}
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${protocol}//${location.host}/ws/viewer`);
	prWalkthroughViewerWs = ws;
	ws.addEventListener("open", () => {
		ws.send(JSON.stringify({ type: "auth", token }));
	});
	ws.addEventListener("message", (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (msg?.type === "pr_walkthrough_job_updated" || msg?.type === "pr-walkthrough-job-updated") handlePrWalkthroughJobUpdated(msg);
		} catch { /* ignore */ }
	});
	ws.addEventListener("close", () => {
		if (prWalkthroughViewerWs === ws) prWalkthroughViewerWs = null;
		if (prWalkthroughViewerReconnect) clearTimeout(prWalkthroughViewerReconnect);
		prWalkthroughViewerReconnect = setTimeout(connectPrWalkthroughViewerEvents, 3_000);
	});
}

document.addEventListener("pr-walkthrough-job-updated", (e: Event) => handlePrWalkthroughJobUpdated((e as CustomEvent).detail));
window.addEventListener("bobbit-pr-walkthrough-job-updated", (e: Event) => handlePrWalkthroughJobUpdated((e as CustomEvent).detail));
connectPrWalkthroughViewerEvents();

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute, isRouteActive, toggleConfigPage } from "./routing.js";
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

// Mobile search handlers (shared logic with sidebar but separate scope)
function _handleMobileSearchInput(query: string): void {
	state.searchQuery = query;
	renderApp();
}

function _handleMobileSearchClear(): void {
	state.searchQuery = "";
	renderApp();
}

function renderMobileLanding() {
	const sidebarData = getSidebarData();
	let { ungroupedSessions, liveGoals } = sidebarData;
	let { archivedGoals } = sidebarData;

	const bypassFilters = !!state.searchQuery.trim();

	// Client-side title filtering for mobile
	if (state.searchQuery) {
		const q = state.searchQuery.toLowerCase();
		liveGoals = liveGoals.filter(goal => {
			const goalMatches = goal.title.toLowerCase().includes(q);
			const goalSessions = state.gatewaySessions.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s));
			const hasMatchingSession = goalSessions.some(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
			return goalMatches || hasMatchingSession;
		});
		ungroupedSessions = ungroupedSessions.filter(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
		archivedGoals = filterArchivedGoalsByQuery(archivedGoals, state.gatewaySessions, state.archivedSessions, state.searchQuery);
	}

	// Apply Show Busy / Show Read filters to standalone live sessions.
	ungroupedSessions = ungroupedSessions.filter(s =>
		passesSidebarFilters(s, s.id === activeSessionId(), bypassFilters));

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto sidebar-root" data-project-reordering=${isProjectReordering() ? "true" : "false"}>
			${renderProjectReorderLiveRegion()}
			<div class="w-full max-w-xl mx-auto px-2 py-4 pb-16 flex flex-col gap-1">
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
					<div class="flex items-center gap-1">
						<button class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage roles"
							@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); })}>
							${icon(Users, "xs")} Roles
						</button>
						<button class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isToolsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage tools"
							@click=${() => toggleConfigPage(["tools", "tool-edit"], () => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); })}>
							${icon(Wrench, "xs")} Tools
						</button>
						<button class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="View skills"
							@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); setHashRoute("skills"); })}>
							${icon(Zap, "xs")} Skills
						</button>
					</div>
					<div class="flex items-center gap-1">
						<button class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isWorkflowsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							title="Manage workflows"
							@click=${() => {
								const projectId = state.activeProjectId || (state.projects[0]?.id ?? null);
								if (!projectId) { showProjectDialog(); return; }
								import("./workflow-page.js").then((m) => m.loadWorkflowPageData());
								setHashRoute("settings", `${projectId}/workflows`, true);
							}}>
							${icon(WorkflowIcon, "xs")} Workflows
						</button>
						<button class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isMarketActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							data-testid="market-nav-button-mobile"
							title="Marketplace"
							@click=${() => toggleConfigPage(["market"], () => { import("./marketplace-page.js").then((m) => m.loadMarketplaceData()); setHashRoute("market"); })}>
							${icon(Store, "xs")} Market
						</button>
						<button
							data-new-goal-trigger
							class="flex-1 px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${state.projects.length === 0 ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-muted-foreground active:bg-secondary/50'}" style="font-size: 1.1667em;"
							?disabled=${state.projects.length === 0}
							@click=${(e: Event) => {
								if (state.projects.length === 0) { showProjectDialog(); return; }
								startNewGoalFlow(e.currentTarget as HTMLElement);
							}}
							title=${state.projects.length === 0 ? "Add a project first" : `New goal${shortcutHint("new-goal")}`}>
							${icon(GoalIcon, "xs")} New Goal
						</button>
					</div>
					`;
					})()}
				</div>
				<search-box
					.query=${state.searchQuery}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { _handleMobileSearchInput(e.detail.query); }}
					@search-clear=${() => { _handleMobileSearchClear(); }}
					@full-search-click=${(e: CustomEvent) => { setHashRoute("search", e.detail.query); }}
				></search-box>
				${state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-muted-foreground underline" title="Retry" @click=${refreshSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? html`<div class="text-center py-12">
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
											children: html`<span class="inline-flex items-center gap-1.5" data-testid="splash-quick-session-label">${_splashSessionIcon()} ${state.projects.length === 0 ? "New Project" : "Quick Session"}</span>`,
										})}
										${_splashProjectPicker()}
									</div>
								</div>`
							: html`
								${(() => {
									// Group goals, sessions, and staff by project
									let staffList = (state.staffList || []).filter(s => s.state !== "retired");
									if (state.searchQuery) {
										const q = state.searchQuery.toLowerCase();
										staffList = filterStaffByQuery(staffList, q);
									}
									const projectsForRender = projectOrderForRender();
									// Sub-goals spawned by a team-lead are rendered NESTED under that
									// team-lead inside renderGoalGroup (Path A — renderSpawnedChildGoalRow).
									// They must therefore be excluded from the flat top-level goal list
									// here, or they'd render in two places at once (nested AND top-level).
									// Mirrors the desktop sidebar's `computeSpawnedClaim` exclusion in
									// renderProjectContent. See docs/nested-goals.md.
									const claimedGoalIds = computeSpawnedClaim(
										[...liveGoals, ...(state.showArchived ? archivedGoals : [])] as any,
										state.gatewaySessions,
										state.archivedSessions,
										state.showArchived,
									);
									const topLevelGoals = liveGoals.filter(g => !claimedGoalIds.has(g.id));
									const projectMap = new Map<string, { goals: typeof liveGoals; sessions: typeof ungroupedSessions; staff: typeof staffList }>();
										for (const p of projectsForRender) projectMap.set(p.id, { goals: [], sessions: [], staff: [] });
										for (const g of topLevelGoals) {
											if (!g.projectId) { console.warn("[mobile] orphaned goal with no projectId — skipping", g.id); continue; }
											const bucket = projectMap.get(g.projectId);
											if (!bucket) { console.warn("[mobile] goal has no matching project bucket — skipping", g.id, g.projectId); continue; }
											bucket.goals.push(g);
										}
										for (const s of ungroupedSessions) {
											if (!s.projectId) { console.warn("[mobile] orphaned session with no projectId — skipping", s.id); continue; }
											const bucket = projectMap.get(s.projectId);
											if (!bucket) { console.warn("[mobile] session has no matching project bucket — skipping", s.id, s.projectId); continue; }
											bucket.sessions.push(s);
										}
										// Bucket staff per project for the dedicated Staff sub-section
										// (rendered via renderStaffSidebarSection in the project's expanded
										// body) — staff are NOT merged into the Sessions list.
										for (const s of staffList) {
											if (!s.projectId) continue;
											const bucket = projectMap.get(s.projectId);
											if (!bucket) continue;
											bucket.staff.push(s);
										}
										// Bucket archived goals + standalone archived sessions per project.
										const allStandaloneArchivedAll = state.showArchived ? state.archivedSessions.filter(s => !s.teamGoalId && !isChildSession(s)) : [];
										const filteredStandaloneArchivedAll = filterArchivedSessionsByQuery(allStandaloneArchivedAll, state.searchQuery);
										const archivedByProject = bucketArchivedByProject(archivedGoals, filteredStandaloneArchivedAll, projectsForRender);
										return html`<div data-project-reorder-list>${projectsForRender.map((project, i) => {
											const data = projectMap.get(project.id) || { goals: [], sessions: [], staff: [] };
											const expanded = isProjectExpanded(project.id);
											const effectiveExpanded = isProjectReordering() ? false : expanded;
											const color = getProjectAccentColor(project);
											return html`
												${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
												<div data-project-reorder-id=${project.id} data-project-id=${project.id}>
													<div
														data-testid="project-header"
														data-project-id=${project.id}
														class="flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
														@click=${() => { if (isProjectReordering()) return; toggleProjectExpanded(project.id); renderApp(); }}>
														<span class="text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;font-size: 1.1667em;">${effectiveExpanded ? "▾" : "▸"}</span>
														${renderProjectReorderHandle(project)}
														<span class="shrink-0" style="color:${color};">${icon(FolderOpen, "sm")}</span>
													<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium" style="color:${color};font-size: 1.1667em;">${project.name}</span>
													<div class="flex items-center gap-2 shrink-0">
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", `${project.id}/general`); }}
															title="Project settings"
														>${icon(Settings, "sm")}</button>
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors relative flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(undefined, project.id); }}
															title="New goal in ${project.name}"
														>
															<span class="relative inline-flex items-center justify-center" style="width:16px;height:16px;">
																${icon(GoalIcon, "sm")}
																<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:9px;height:9px;filter:drop-shadow(0 0 1.5px var(--background));">
																	<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
																</svg>
															</span>
														</button>
													</div>
												</div>
												${effectiveExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
													${data.goals.map((goal, gi) => html`
														${gi > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
														${renderGoalGroup(goal)}
													`)}
													${data.goals.length > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
													<div class="flex flex-col gap-0.5">
														${(() => { const _mobileUngroupedExp = isUngroupedExpanded(project.id); return html`<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
															@click=${() => { setUngroupedExpanded(project.id, !_mobileUngroupedExp); renderApp(); }}>
															<span class="text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;font-size: 1.1667em;">${_mobileUngroupedExp ? "▾" : "▸"}</span>
															<span class="shrink-0 text-muted-foreground">${icon(MessagesSquare, "sm")}</span>
															<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 1.1667em;">Sessions</span>
															<div class="flex items-center relative">
																<button
																	class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors relative shrink-0"
																	style="line-height:0;"
																	@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, project.rootPath, undefined, undefined, project.id); }}
																	title="New session in ${project.name}"
																>
																	<span class="relative inline-flex items-center justify-center" style="width:16px;height:16px;">
																		${icon(MessagesSquare, "sm")}
																		<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:9px;height:9px;filter:drop-shadow(0 0 1.5px var(--background));">
																			<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
																		</svg>
																	</span>
																</button>
																<button
																	class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e, undefined, { projectId: project.id, projectName: project.name, projectCwd: project.rootPath }); }}
																	title="New session with role"
																>${icon(ChevronDown, "sm")}</button>
																${renderRolePickerDropdown()}
															</div>
														</div>
														${_mobileUngroupedExp && data.sessions.length > 0 ? html`
															<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
																${data.sessions.map(renderSessionRow)}
															</div>
														` : ""}
													</div>`; })()}
													${renderStaffSidebarSection(data.staff, project.id)}
													${(() => {
														const ab = archivedByProject.get(project.id);
														if (!ab) return "";
														return renderProjectArchivedSection(project, ab.archivedGoals, ab.standaloneArchivedSessions, "mobile");
													})()}
												</div>` : ""}
												</div>
											`;
										})}
										${state.showArchived && !state.searchQuery && (state.archivedGoalsHasMore || state.archivedSessionsHasMore) ? html`
											<div class="border-t border-border/30 my-1 mx-2"></div>
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

// Header-only "Link copied" toast — separate state + testid so it doesn't
// collide with the proposal-toast testid used by the proposal panels' own
// toast (the session header is rendered alongside open proposal panels).
let _headerToastText = "";
let _headerToastTimer: ReturnType<typeof setTimeout> | null = null;
export function showHeaderToast(text: string): void {
	_headerToastText = text;
	if (_headerToastTimer) clearTimeout(_headerToastTimer);
	_headerToastTimer = setTimeout(() => {
		_headerToastText = "";
		_headerToastTimer = null;
		renderApp();
	}, 2500);
	renderApp();
}
function headerToast() {
	if (!_headerToastText) return "";
	return html`<div class="review-toast" data-testid="header-toast">${_headerToastText}</div>`;
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
	// On the standalone `/walkthrough` route there is no connected session
	// (`activeSessionId()` is undefined), but the walkthrough's owning session
	// is carried in the URL. The standalone panel content (e.g. the lazy payload
	// restore in `walkthroughPanelContent`) must key off the SAME session id the
	// panel tab is stored under — otherwise it reads a key the renderer never
	// sees and the walkthrough never hydrates.
	const route = getRouteFromHash();
	if (route.view === "walkthrough" && route.walkthroughSessionId) {
		return panelWorkspaceSessionKey(route.walkthroughSessionId);
	}
	return panelWorkspaceSessionKey(activeSessionId());
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
// SortableJS itself is split into its own vendor chunk (see vite.config.ts
// manualChunks) so the ~46 kB / ~13 kB gz body lands outside the entry chunk.
let panelSortable: Sortable | null = null;
let panelSortableContainer: HTMLElement | null = null;
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
		const ghost = (Sortable as unknown as { ghost: HTMLElement | null }).ghost;
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
		body = { html: snapshotHtml };
		if (entry && !entry.includes("/") && !entry.includes("\\")) body.entry = entry;
	} else if (snapshotKind === "file" && snapshotFile) {
		body = { file: snapshotFile };
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

export function setUnifiedActiveTab(tab: PanelWorkspaceTab): void {
	if ((tab as any).kind === "chat" || tab.id === CHAT_PANEL_TAB_ID) return;
	const sid = workspaceSessionId();
	setActivePanelTabIdForSession(state, sid, tab.id);
	(state as any).previewPanelTab = tab.legacyTab;
	(state as any).previewPanelActiveTab = tab.kind === "preview" ? "preview" : tab.legacyTab;
	if (state.assistantType) state.assistantTab = "preview";
	if (tab.kind === "preview") {
		state.isPreviewSession = true;
		restoreHistoricalPreviewTab(tab);
	}
	if (tab.kind === "review") {
		state.reviewActiveTab = reviewTitleFromPanelTab(tab);
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

/** Ordered list of available unified panel tabs for the current session. */
export function unifiedPanelTabs(): UnifiedPanelTab[] {
	const sessionId = workspaceSessionId();
	const activeGatewaySession = state.gatewaySessions.find((session) => session.id === sessionId) as any;
	if (activeGatewaySession?.walkthroughJobId || activeGatewaySession?.childKind === "pr-walkthrough") {
		restorePrWalkthroughJobForSession(state, sessionId);
	}
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

/** Whether the unified panel is active for the current session. */
function hasUnifiedPanel(): boolean {
	return unifiedPanelContentTabs().length > 0;
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

	const getTrack = () => document.querySelector(".preview-slider__track") as HTMLElement | null;

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
		if (panelSortable) {
			panelSortable.destroy();
			panelSortable = null;
			panelSortableContainer = null;
		}
		return;
	}
	if (panelSortableContainer === container && panelSortable) return;
	if (panelSortable) {
		panelSortable.destroy();
		panelSortable = null;
	}
	panelSortableContainer = container;

	panelSortable = Sortable.create(container, {
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
			const ghost = (Sortable as unknown as { ghost: HTMLElement | null }).ghost;
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
					setPanelTabsForSession(state, sid, reordered);
				}
			} finally {
				setRenderSuppressed(false);
				// Always trigger a render: when we took an early `return` above
				// (pinned-blocked or invariant-violation revert), state was not
				// mutated and lit-html will restore the canonical DOM order.
				// When we committed setPanelTabsForSession, it already triggers a
				// render — an extra one here is harmless.
				renderApp();
			}
		},
	});
}



// ============================================================================
// RENDER APP
// ============================================================================

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
	const sessionTitle = connected && state.remoteAgent ? (state.remoteAgent.title || "New session") : "";
	const activeSid = activeSessionId();
	const activeStaffAgent = activeSid ? state.staffList.find(s => s.currentSessionId === activeSid) : undefined;
	const headerTitle = activeStaffAgent?.name ?? sessionTitle;
	const editLabel = activeStaffAgent ? "Edit" : "Modify";
	const activeSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
	const isTeamLead = activeSession?.role === "team-lead";
	const editDeleteBtns = (connected && state.remoteAgent && activeSid) ? html`
		<div class="flex items-center gap-1 shrink-0 relative">
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					import("../ui/dialogs/SystemPromptDialog.js").then(m => m.SystemPromptDialog.show(activeSid!));
				},
				children: html`<span class="inline-flex items-center gap-1">${icon(FileText, "xs")}<span class="text-xs hidden sm:inline">Prompt</span></span>`,
				className: "h-7 px-2 text-muted-foreground",
				title: "View System Prompt",
			})}
			<span data-testid="copy-session-link">${Button({
				variant: "ghost",
				size: "sm",
				onClick: async () => {
					const url = `${location.origin}/session/${activeSid}`;
					try {
						await navigator.clipboard.writeText(url);
						showHeaderToast("Link copied");
					} catch {
						const m = await import("../ui/dialogs/CopyLinkFallbackDialog.js");
						m.CopyLinkFallbackDialog.show(url);
					}
				},
				children: html`<span class="inline-flex items-center gap-1">${icon(Link, "xs")}<span class="text-xs hidden sm:inline">Link</span></span>`,
				className: "h-7 px-2 text-muted-foreground",
				title: "Copy session link",
			})}</span>
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					if (activeStaffAgent) {
						setHashRoute("staff-edit", activeStaffAgent.id);
					} else {
						showRenameDialog(activeSid, sessionTitle);
					}
				},
				children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "xs")}<span class="text-xs hidden sm:inline">${editLabel}</span></span>`,
				className: "h-7 px-2 text-muted-foreground",
				title: activeStaffAgent ? "Edit staff agent" : "Modify session",
			})}
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => terminateSession(activeSid),
				children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "xs")}<span class="text-xs hidden sm:inline">${isTeamLead ? "End Team" : "Terminate"}</span></span>`,
				className: "h-7 px-2 text-muted-foreground hover:text-destructive",
				title: (isTeamLead ? "End team" : "Terminate session") + shortcutHint("terminate-session"),
			})}
		</div>
	` : "";

	const headerLeft = () => {
		if (connected && state.remoteAgent) {
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
				const activeSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
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
						<div class="shrink-0">${editDeleteBtns}</div>
					</div>
				`;
			}
			const deskSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
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
			return editDeleteBtns ? html`<div class="flex items-center gap-1 px-2">${editDeleteBtns}</div>` : html``;
		}
		const settingsBtn = Button({
			variant: "ghost",
			size: "sm",
			children: html`${icon(Settings, "sm")}`,
			onClick: () => { import("./settings-page.js").then((m) => m.toggleSettings()); },
			title: "Settings",
		});
		if (connected && state.remoteAgent) {
			return html``;
		}
		return html`
			<div class="flex items-center gap-1 px-2">
				${settingsBtn}
				${Button({
					variant: "ghost",
					size: "sm",
					children: html`${icon(QrCode, "sm")}`,
					onClick: showQrCodeDialog,
					title: "Show QR code",
				})}
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
		if ((tab as any).kind === "chat" || isPinnedPanelTab(tab)) return;
		const sid = workspaceSessionId();
		const activeId = activeSidePanelTabIdForSession(state, sid);
		const wasActive = activeId === tab.id;
		const tabsBefore = unifiedPanelTabs();
		const nextId = nextActivePanelTabId(tabsBefore, tab.id);
		const nextCandidate = nextId ? findPanelTab(tabsBefore, nextId) : undefined;

		if (tab.kind === "proposal" && tab.source.type === "proposal" && !isHistoricalProposalTab(tab)) {
			lazyProposalPanels.dismissTypedProposal(tab.source.proposalType);
			setPanelTabsForSession(state, sid, panelTabsForSession(state, sid).filter((candidate) => candidate.id !== tab.id));
			if (wasActive) {
				if (nextCandidate) setUnifiedActiveTab(nextCandidate);
				else setActivePanelTabIdForSession(state, sid, "");
			}
			renderApp();
			return;
		}
		if (tab.kind === "review") {
			const title = reviewTitleFromPanelTab(tab);
			if (title) {
				const sid = activeSessionId() || "";
				if (event?.type !== "review-close-tab") {
					const count = reviewPaneUnsentCountForDocument(sid, title);
					if (count > 0 && !confirm(`Close "${title}"? ${count} unsent comment${count !== 1 ? "s" : ""} will be lost.`)) return;
				}
				clearAnnotations(sid, title);
				removePersistedReviewDocument(sid, title);
				state.reviewDocuments = new Map(state.reviewDocuments);
				state.reviewDocuments.delete(title);
				if (state.reviewActiveTab === title) {
					const nextReview = nextCandidate?.kind === "review" ? reviewTitleFromPanelTab(nextCandidate) : "";
					state.reviewActiveTab = nextReview || [...state.reviewDocuments.keys()][0] || "";
				}
				state.reviewPanelOpen = state.reviewDocuments.size > 0;
			}
		}
		if (tab.kind === "preview") {
			if (!isHistoricalPreviewTab(tab)) markPreviewContentDismissed(sid, previewEntryFromTab(tab), previewContentHashFromTab(tab));
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

		setPanelTabsForSession(state, sid, panelTabsForSession(state, sid).filter((candidate) => candidate.id !== tab.id));
		if (wasActive) {
			if (nextCandidate) setUnifiedActiveTab(nextCandidate);
			else setActivePanelTabIdForSession(state, sid, "");
		}
		renderApp();
	};

	const panelTabHasDot = (tab: UnifiedPanelTab): boolean => {
		if (tab.kind === "inbox") return state.inboxEntries.some((e) => e.state === "pending");
		if (tab.kind !== "proposal" || tab.source.type !== "proposal") return false;
		const type = tab.source.proposalType;
		return state.activeProposals[type] != null || (type === currentAssistantProposalType() && state.assistantHasProposal);
	};

	const walkthroughTabButtonLabel = (tab: UnifiedPanelTab): string | undefined => {
		if (tab.kind !== "walkthrough") return undefined;
		const record = { ...((tab.state || {}) as Record<string, unknown>), ...((tab.source || {}) as Record<string, unknown>) };
		const rawNumber = record.prNumber;
		const number = typeof rawNumber === "number" && Number.isFinite(rawNumber)
			? String(Math.trunc(rawNumber))
			: typeof rawNumber === "string" && rawNumber.trim()
				? rawNumber.trim().replace(/^#/, "")
				: "";
		return number ? `PR: #${number}` : undefined;
	};

	const panelTabButtonLabel = (tab: UnifiedPanelTab): string => (
		walkthroughTabButtonLabel(tab) || tab.label || tab.title || (tab.kind === "preview" ? "Preview" : "")
	);

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
			data-testid=${testId}
			@click=${() => { setUnifiedMobileTab(tab); renderApp(); }}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setUnifiedMobileTab(tab); renderApp(); } }}
		><span class="goal-tab-pill-label">${label}</span>${panelTabHasDot(tab) ? html`<span class="goal-tab-dot"></span>` : ""}${closable ? html`<span
				class="goal-tab-close"
				role="button"
				aria-label=${`Dismiss ${label}`}
				title=${`Dismiss ${label}`}
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

	const previewCollapseKey = () => `bobbit-preview-collapsed-${workspaceSessionId()}`;
	const isPreviewCollapsed = () => localStorage.getItem(previewCollapseKey()) === "true";
	const togglePreviewCollapse = () => {
		const next = !isPreviewCollapsed();
		localStorage.setItem(previewCollapseKey(), String(next));
		renderApp();
	};

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
		const v = state.previewPanelMtime || 0;
		// Derive artifactId and entry from the active panel tab rather than
		// mirroring them in global state. Many code paths (SSE preview-changed,
		// bootstrap fetch, PreviewRenderer, session-manager) update
		// `previewPanelEntry` without knowing about artifactId; reading directly
		// from the active tab keeps entry+artifactId always paired.
		const activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
		const panelTabs = unifiedPanelContentTabs();
		const activeTab = panelTabs.find((t) => t.id === activeId);
		let artifactId = "";
		let entry = state.previewPanelEntry || "inline.html";
		if (activeTab && activeTab.kind === "preview") {
			const tabState = (activeTab.state || {}) as Record<string, unknown>;
			const source = activeTab.source as Record<string, unknown>;
			const isLiveTab = isLivePreviewTab(activeTab);
			if (!isLiveTab) {
				artifactId = recordValue(tabState, "artifactId") || recordValue(source, "artifactId");
				const tabEntry = previewEntryFromTab(activeTab);
				if (tabEntry) entry = tabEntry;
			}
		}
		if (!sid || !state.previewPanelEntry) {
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
					const tab = findPanelTab(unifiedPanelTabs(), reviewPanelTabId(title));
					if (tab) setUnifiedActiveTab(tab);
					renderApp();
				}}
				@review-submit=${async (e: CustomEvent) => {
					const agent = state.remoteAgent;
					if (agent) {
						agent.prompt(e.detail.feedback);
						const sid = activeSessionId() || "";
						clearAllAnnotations(sid);
						clearPersistedReviewDocuments(sid);
						markReviewSubmitted(sid);
						await flushPendingWrites();
						state.reviewDocuments = new Map();
						state.reviewPanelOpen = false;
						state.reviewActiveTab = "";
						renderApp();
					}
				}}
				@review-decision=${async (e: CustomEvent) => {
					e.preventDefault();
					const sid = activeSessionId() || "";
					const doc = reviewDocumentFromDecisionDetail(e.detail);
					const payload = reviewDecisionPayloadFromDetail(e.detail, sid, doc);
					if (!doc || !payload) {
						showHeaderToast("Could not submit review decision");
						return;
					}
					try {
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
					const tab = findPanelTab(unifiedPanelTabs(), reviewPanelTabId(title));
					if (tab) closeUnifiedPanelTab(tab, e);
					else {
						const sid = activeSessionId() || "";
						clearAnnotations(sid, title);
						removePersistedReviewDocument(sid, title);
						state.reviewDocuments = new Map(state.reviewDocuments);
						state.reviewDocuments.delete(title);
						if (state.reviewActiveTab === title) {
							const keys = [...state.reviewDocuments.keys()];
							state.reviewActiveTab = keys[0] || "";
						}
						state.reviewPanelOpen = state.reviewDocuments.size > 0;
						renderApp();
					}
				}}
				@review-dismiss=${() => {
					const sid = activeSessionId() || "";
					const hasMarkdownReview = [...state.reviewDocuments.values()].some((doc) => !doc.source || doc.source.kind === "markdown-review");
					clearAllAnnotations(sid);
					clearPersistedReviewDocuments(sid);
					if (hasMarkdownReview) markReviewSubmitted(sid);
					state.reviewDocuments = new Map();
					state.reviewPanelOpen = false;
					state.reviewActiveTab = "";
					renderApp();
				}}
			></review-pane>
		</div>
	`;

	const previewControlButtons = () => {
		const sid = activeSessionId() || "";
		const entry = state.previewPanelEntry || "";
		return html`
			<a
				href=${`/preview/${encodeURIComponent(sid)}/${encodeURIComponent(entry)}`}
				target="_blank"
				rel="noopener noreferrer"
				class="text-muted-foreground hover:text-foreground"
				style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;display:inline-flex;align-items:center;"
				title="Open preview in new tab"
			>${icon(ExternalLink, "sm")}</a>
			<button @click=${() => { state.previewPanelMtime = Date.now(); renderApp(); }} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title="Refresh preview">
				${icon(RotateCw, "sm")}
			</button>
		`;
	};

	const walkthroughControlButtons = (tab: UnifiedContentTab) => {
		const sid = recordValue((tab.source || {}) as Record<string, unknown>, "sessionId") || activeSessionId() || workspaceSessionId();
		const standaloneUrl = prWalkthroughStandaloneHref(sid, tab.id);
		return html`
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground"
				style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;display:inline-flex;align-items:center;"
				title="Open walkthrough in new tab"
				data-testid="pr-walkthrough-open-in-new-tab"
				@click=${() => window.open(`${window.location.origin}${standaloneUrl}`, "_blank", "noopener")}
			>${icon(ExternalLink, "sm")}</button>
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

	const walkthroughChangesetFromTab = (tab: UnifiedContentTab): PrWalkthroughChangesetRef => {
		const source = (tab.source || {}) as Record<string, unknown>;
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const stored = tabState.changeset;
		if (stored && typeof stored === "object") return stored as PrWalkthroughChangesetRef;
		return {
			baseSha: typeof source.baseSha === "string" && source.baseSha ? source.baseSha : "fixture-base",
			headSha: typeof source.headSha === "string" && source.headSha ? source.headSha : "fixture-head",
			provider: typeof source.provider === "string" ? source.provider : undefined,
			externalUrl: typeof source.externalUrl === "string" ? source.externalUrl : typeof source.prUrl === "string" ? source.prUrl : undefined,
			prUrl: typeof source.prUrl === "string" ? source.prUrl : typeof source.externalUrl === "string" ? source.externalUrl : undefined,
			prNumber: typeof source.prNumber === "string" || typeof source.prNumber === "number" ? source.prNumber : undefined,
			prTitle: typeof source.prTitle === "string" ? source.prTitle : undefined,
			prBody: typeof source.prBody === "string" ? source.prBody : undefined,
			title: typeof source.title === "string" ? source.title : tab.title,
			filesChanged: typeof source.filesChanged === "number" ? source.filesChanged : undefined,
			additions: typeof source.additions === "number" ? source.additions : undefined,
			deletions: typeof source.deletions === "number" ? source.deletions : undefined,
		};
	};

	const walkthroughPanelContent = (tab: UnifiedContentTab) => {
		if (tab.kind !== "walkthrough") return "";
		void ensurePrWalkthroughPanel();
		const changeset = walkthroughChangesetFromTab(tab);
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const cards = Array.isArray(tabState.cards) ? tabState.cards as PrWalkthroughCard[] : undefined;
		const status = typeof tabState.status === "string" ? tabState.status : "fixture";
		const warnings = Array.isArray(tabState.warnings) ? tabState.warnings : [];
		const error = typeof tabState.error === "string" ? tabState.error : undefined;
		const exportCapability = tabState.exportCapability;
		const validationError = tabState.validationError || tabState.lastValidationError;
		const jobId = typeof tabState.jobId === "string" ? tabState.jobId : undefined;
		if (status === "ready" && !cards?.length) {
			queueMicrotask(() => restorePrWalkthroughPanel(state, workspaceSessionId(), tab.id));
		}
		return html`
			<div class="flex-1 min-h-0 overflow-hidden" data-testid="pr-walkthrough-panel-root" data-panel-tab-id=${tab.id} data-walkthrough-status=${status}>
				<pr-walkthrough-panel
					.changeset=${changeset}
					.cards=${cards ?? []}
					.status=${status}
					.warnings=${warnings}
					.error=${error}
					.exportCapability=${exportCapability}
					.validationError=${validationError}
					.jobId=${jobId}
					.persistenceKey=${tab.id}
				></pr-walkthrough-panel>
			</div>
		`;
	};

	const standaloneWalkthroughPanel = () => {
		const route = getRouteFromHash();
		const sid = route.walkthroughSessionId || workspaceSessionId();
		const rawTabId = route.walkthroughTabId || activeSidePanelTabIdForSession(state, sid);
		const tabId = rawTabId && rawTabId.startsWith("walkthrough:") && !rawTabId.includes("%")
			? walkthroughPanelTabId(rawTabId.slice("walkthrough:".length))
			: rawTabId;
		const tabCandidates = [tabId, rawTabId].filter(Boolean);
		const storedTab = panelTabsForSession(state, sid).find((candidate) => tabCandidates.includes(candidate.id) && candidate.kind === "walkthrough") as UnifiedContentTab | undefined;
		const fallbackTabId = tabId && tabId.startsWith("walkthrough:") ? tabId : "walkthrough:fixture";
		const fallbackChangesetId = walkthroughChangesetIdFromPanelTabId(fallbackTabId);
		const tab = storedTab
			? (tabId && storedTab.id !== tabId ? { ...storedTab, id: tabId } as UnifiedContentTab : storedTab)
			: {
				id: fallbackTabId,
				kind: "walkthrough" as const,
				title: "PR Walkthrough",
				label: "Walkthrough",
				legacyTab: "walkthrough" as const,
				source: { type: "walkthrough" as const, sessionId: sid, title: "PR Walkthrough", changesetId: fallbackChangesetId },
				state: { changesetId: fallbackChangesetId },
			} as UnifiedContentTab;
		if (route.walkthroughSessionId) restorePrWalkthroughJobForSession(state, sid);
		if (storedTab) {
			restorePrWalkthroughPanel(state, sid, storedTab.id);
		} else if (fallbackChangesetId && fallbackChangesetId !== "fixture") {
			setPanelTabsForSession(state, sid, [...panelTabsForSession(state, sid), tab as PanelWorkspaceTab]);
			restorePrWalkthroughPanel(state, sid, tab.id);
		}
		// A popped-out standalone walkthrough IS the whole window — there is no
		// adjacent chat pane to hide — so it carries no panel-level fullscreen /
		// collapse chrome. It simply fills the window. The component's own internal
		// rail toggle (rendered inside <pr-walkthrough-panel>) still works.
		return html`
			<div class="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="pr-walkthrough-standalone" data-panel-tab-id=${tab.id}>
				${walkthroughPanelContent(tab)}
			</div>
		`;
	};

	const unifiedPanelContent = (tab: UnifiedContentTab) => {
		if (tab.kind === "preview") return previewRestoreError(tab) ? previewRestoreErrorContent(tab) : htmlPreviewContent();
		if (tab.kind === "review" && state.reviewPanelOpen) {
			const reviewTitle = reviewTitleFromPanelTab(tab);
			if (reviewTitle && state.reviewActiveTab !== reviewTitle) {
				state.reviewActiveTab = reviewTitle;
			}
			return reviewPaneContent();
		}
		if (tab.kind === "inbox" && state.inboxPanelOpen) return inboxPaneContent();
		if (tab.kind === "proposal" && tab.source.type === "proposal") {
			return proposalPanelContent(tab);
		}
		if (tab.kind === "walkthrough") return walkthroughPanelContent(tab);
		return "";
	};

	const unifiedDesktopTabButton = (tab: UnifiedContentTab) => panelTabButton(
		tab,
		tab.kind === "inbox" ? "inbox-tab-unified" : "",
	);

	const unifiedPreviewPanel = () => {
		const contentTabs = unifiedPanelContentTabs();
		if (contentTabs.length === 0) return "";

		let activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
		let activeTab = contentTabs.find((tab) => tab.id === activeId) ?? contentTabs[0];
		if (activeId !== activeTab.id) {
			setUnifiedDesktopTab(activeTab);
			activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
			activeTab = contentTabs.find((tab) => tab.id === activeId) ?? activeTab;
		}
		const activeTabCanFullscreen = activeTab.kind === "preview" || activeTab.kind === "walkthrough";

		return html`
			<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0" data-panel-workspace="content">
				<!-- Chrome-style tab strip: muted bg distinct from the panel below.
				     Tabs sit flush at the strip's bottom via items-end + no pb.
				     The active tab's background matches the panel so it visually
				     bridges the color boundary (curve pseudo-elements in CSS do
				     the outward-curve flourish at the bottom corners). */ -->
				<div class="flex items-end justify-between px-3 pt-1 shrink-0 min-w-0" style="background: var(--muted, var(--color-muted));">
					<div class="flex-1 min-w-0">
						<div class="flex items-end gap-1" data-panel-tab-bar="true">
							${repeat(contentTabs, (tab) => tab.id, (tab) => unifiedDesktopTabButton(tab))}
						</div>
					</div>
					<div class="flex items-center gap-0.5 shrink-0 pl-2 pb-1">
						${activeTab.kind === "preview" && state.previewPanelEntry ? previewControlButtons() : ""}
						${activeTab.kind === "walkthrough" ? walkthroughControlButtons(activeTab) : ""}
						${activeTabCanFullscreen ? html`
						<button @click=${() => { state.previewPanelFullscreen = true; renderApp(); }} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title=${`${activeTab.kind === "walkthrough" ? "Fullscreen walkthrough" : "Fullscreen preview"}${shortcutHint("toggle-sidebar")}`} data-testid=${activeTab.kind === "walkthrough" ? "pr-walkthrough-fullscreen" : "preview-fullscreen"}>
							${icon(PanelRightOpen, "sm")}
						</button>` : ""}
						<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title=${`Collapse preview${shortcutHint("toggle-preview")}`}>
							${icon(PanelRightClose, "sm")}
						</button>
					</div>
				</div>
				<!-- Tab content -->
				${unifiedPanelContent(activeTab)}
			</div>
		`;
	};

	const previewExpandButton = () => html`
		<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:6px 4px;border-left:1px solid var(--border);align-self:stretch;display:flex;align-items:center;" title=${`Expand preview${shortcutHint("toggle-sidebar")}`}>
			${icon(PanelRightOpen, "sm")}
		</button>
	`;
	/** Render individual pane content for mobile slider. */
	const mobilePaneContent = (tab: MobilePaneTab) => {
		if (tab.kind === "chat") return state.chatPanel;
		const content = unifiedPanelContent(tab);
		return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0" data-panel-tab-id=${tab.id}>${content}</div>`;
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
		if (route.view === "walkthrough") {
			return standaloneWalkthroughPanel();
		}
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

		if (connected && hasUnifiedPanel()) {
			const fullscreenTabs = unifiedPanelContentTabs();
			const fullscreenActiveId = activeSidePanelTabIdForSession(state, workspaceSessionId());
			const fullscreenTab = fullscreenTabs.find((tab) => tab.id === fullscreenActiveId) ?? fullscreenTabs[0];
			const fullscreenContent = fullscreenTab?.kind === "walkthrough"
				? walkthroughPanelContent(fullscreenTab)
				: htmlPreviewContent();
			if (desktop && state.previewPanelFullscreen && (fullscreenTab?.kind === "preview" || fullscreenTab?.kind === "walkthrough")) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
						<!-- Fullscreen preview header -->
						<div class="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0" style="background:var(--color-background, hsl(var(--background)));">
							<span class="text-xs font-medium text-muted-foreground">${fullscreenTab.kind === "walkthrough" ? "Walkthrough" : "Preview"}</span>
							<div class="flex items-center gap-0.5">
								${fullscreenTab.kind === "preview" && state.previewPanelEntry ? previewControlButtons() : ""}
								${fullscreenTab.kind === "walkthrough" ? walkthroughControlButtons(fullscreenTab) : ""}
								<button @click=${() => { state.previewPanelFullscreen = false; renderApp(); }} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;" title=${`Collapse preview${shortcutHint("toggle-preview")}`}>
									${icon(PanelRightClose, "sm")}
								</button>
							</div>
						</div>
						<!-- Preview content fills available space -->
						${fullscreenContent}
						<!-- Compact prompt bar at bottom -->
						<div class="preview-fullscreen-prompt shrink-0 border-t border-border">
							${state.chatPanel}
						</div>
					</div>
				`;
			}
			if (desktop) {
				const collapsed = isPreviewCollapsed();
				return html`
					${reconnectBanner()}
					<div class="goal-split-layout flex-1 flex min-h-0 overflow-hidden">
						<div class="${collapsed ? 'flex-1' : 'goal-chat-panel flex-1'} min-w-0 flex flex-col">${state.chatPanel}</div>
						${collapsed ? previewExpandButton() : unifiedPreviewPanel()}
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
				<div class="preview-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
					<div class="preview-slider__track" style="display:flex;width:${trackW}%;height:100%;transform:translateX(${slideX}%);transition:transform 0.3s ease-out;will-change:transform;">
						${panes.map(tab => html`<div style="width:${paneW}%;height:100%;min-width:0;display:flex;flex-direction:column;">${mobilePaneContent(tab)}</div>`)}
					</div>
				</div>
			`;
		}
		if (connected) return html`${reconnectBanner()}${renderArchivedBanner()}${state.chatPanel}`;

		if (desktop) {
			return html`
				${orphanTranscriptsBanner()}
				<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
					<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
					<p class="text-sm text-muted-foreground">Select a session from the sidebar or create a new one</p>
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
				</div>
			`;
		}
		return renderMobileLanding();
	};

	if (desktop) {
		teardownMobileScrollTracking();
		if (getRouteFromHash().view === "walkthrough") {
			render(html`
				<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
					<div class="flex items-center justify-between border-b border-border shrink-0 header-shadow px-3 py-1.5" data-testid="pr-walkthrough-standalone-topbar">
						<div class="flex items-center gap-2 min-w-0">
							${bobbitIcon}
							<span class="text-sm font-semibold text-foreground">Bobbit</span>
							<span class="text-xs text-muted-foreground">PR Walkthrough</span>
						</div>
						<theme-toggle></theme-toggle>
					</div>
					<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">${mainArea()}</div>
				</div>
			`, app);
			return;
		}
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative">
				${headerToast()}
				${renderClientDebugButton()}
				<div class="flex items-center border-b border-border shrink-0 header-shadow">
					${state.sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center self-stretch" style="background: var(--sidebar);">
						${bobbitIcon}
					</div>
					` : html`
					<div class="shrink-0 flex items-center justify-between px-3 self-stretch" style="background: var(--sidebar); width: var(--sidebar-w, 240px);">
						<div class="flex items-center gap-2">
							${bobbitIcon}
							<span class="text-base font-semibold text-foreground">Bobbit</span>
						</div>
						<div class="flex items-center" style="gap:1px;margin-right:-4px">
							${Button({
								variant: "ghost",
								size: "sm",
								children: html`${icon(QrCode, "xs")}`,
								onClick: showQrCodeDialog,
								title: "Show QR code",
								className: "h-6 w-6 text-muted-foreground",
							})}
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
				${renderClientDebugButton()}
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background flex flex-col">
					<div class="flex items-center justify-between border-b border-border">
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
				<div class="flex items-center justify-between border-b border-border shrink-0 header-shadow">
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
