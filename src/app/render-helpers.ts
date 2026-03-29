import { icon } from "@mariozechner/mini-lit";
import { html, nothing, svg, type TemplateResult } from "lit";
import { Goal as GoalIcon, LayoutDashboard, Pencil, RotateCcw, Trash2 } from "lucide";
import {
	state,
	renderApp,
	activeSessionId,
	expandedGoals,
	saveExpandedGoals,
	isDesktop,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	toggleArchivedParentExpanded,
	isArchivedParentExpanded,
	type GatewaySession,
	type Goal,
	type GoalState,
} from "./state.js";
import { statusBobbit } from "./session-colors.js";
import { connectToSession, terminateSession, createAndConnectSession, startReattempt } from "./session-manager.js";
import { showRenameDialog } from "./dialogs.js";
import { setHashRoute } from "./routing.js";
import { startTeam, teardownTeam, refreshSessions, deleteGoal } from "./api.js";

// ============================================================================
// FORMATTING
// ============================================================================

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function shortenPath(fullPath: string): string {
	const parts = fullPath.split(/[/\\]/).filter(Boolean);
	if (parts.length <= 3) return parts.join("/");
	return "…/" + parts.slice(-3).join("/");
}

export function formatSessionAge(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "";
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Ultra-terse relative time: "now", "1m", "49m", "2h", "1d", etc. */
export function terseRelativeTime(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "";
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "now";
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(diff / 3_600_000);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(diff / 86_400_000);
	return `${days}d`;
}

// ============================================================================
// SESSION VISIT TRACKING
// ============================================================================

const VISITED_KEY = "bobbit-session-visited";

/** In-memory cache of session visit timestamps. */
let _visitedMap: Record<string, number> | null = null;

function loadVisitedMap(): Record<string, number> {
	if (!_visitedMap) {
		try {
			_visitedMap = JSON.parse(localStorage.getItem(VISITED_KEY) || "{}");
		} catch {
			_visitedMap = {};
		}
	}
	return _visitedMap!;
}

/** Record that the user visited a session right now. */
export function markSessionVisited(sessionId: string): void {
	const map = loadVisitedMap();
	map[sessionId] = Date.now();
	localStorage.setItem(VISITED_KEY, JSON.stringify(map));
}

/** Returns true if the session has activity the user hasn't seen yet.
 *  "Unseen" means: session is idle/terminated AND lastActivity > last visit time.
 *  For team agents (team leads and members), the dot only shows when the
 *  associated goal is complete — humans don't need to check on agents mid-work. */
export function hasUnseenActivity(session: GatewaySession): boolean {
	// Active sessions don't show unseen — user will see it when they connect
	if (session.status === "streaming" || session.status === "busy") return false;
	// Currently viewed session is never unseen
	if (activeSessionId() === session.id) return false;

	// Team agents: suppress the unseen dot unless the goal is complete
	const teamGoal = session.teamGoalId || (session.role === "team-lead" ? session.goalId : undefined);
	if (teamGoal) {
		const goal = state.goals.find(g => g.id === teamGoal);
		if (!goal || goal.state !== "complete") return false;
	}

	const map = loadVisitedMap();
	const lastVisit = map[session.id] || 0;
	return session.lastActivity > lastVisit;
}

// ============================================================================
// SIDEBAR TIME REFRESH
// ============================================================================

let _timeRefreshTimer: ReturnType<typeof setInterval> | null = null;

/** Start a 60s timer that re-renders the app to update relative times. */
export function startTimeRefresh(): void {
	if (_timeRefreshTimer) return;
	_timeRefreshTimer = setInterval(() => renderApp(), 60_000);
}

export function stopTimeRefresh(): void {
	if (_timeRefreshTimer) { clearInterval(_timeRefreshTimer); _timeRefreshTimer = null; }
}

// ============================================================================
// UNIFIED SESSION ROW
// ============================================================================

// ============================================================================
// SESSION TIME + UNSEEN BADGE
// ============================================================================

/** Render session title with a subtle rolling shadow when active. */
let _waveIndex = 0;
export function renderSessionTitle(title: string, isActive?: boolean) {
	// Emoji glyphs (e.g. ⚡) have built-in leading whitespace — pull a negative margin to compensate
	const emojiLead = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(title) ? "margin-left:-2px" : "";
	if (!isActive) { return emojiLead ? html`<span style="${emojiLead}">${title}</span>` : title; }
	const delay = -((_waveIndex++ % 7) * 0.6);
	return html`<span class="title-wave" style="animation-delay:${delay}s;${emojiLead}">${title}</span>`;
}

/** Render a pulsing dot with conic sweep to indicate active session. */
let _dotIndex = 0;
function renderActiveShimmer() {
	const delay = (_dotIndex++ % 5) * 1.8;
	return html`<span class="sidebar-active-dot" style="--dot-delay:${delay}s"></span>`;
}

/** Render terse relative time with optional unseen indicator dot. */
function renderSessionTime(session: GatewaySession, selected = false) {
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;
	if (isActive) return renderActiveShimmer();
	const time = terseRelativeTime(session.lastActivity);
	if (!time) return "";
	const unseen = hasUnseenActivity(session);
	return html`<span
		class="shrink-0 inline-flex items-center gap-0.5 text-[11px] tabular-nums ${selected ? (unseen ? "text-foreground font-medium" : "text-foreground/50") : (unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50")}"
		style="vertical-align:middle;"
		title="${formatSessionAge(session.lastActivity)}"
	>${time}${unseen ? html`<span class="text-primary" style="font-size:6px;line-height:1;">●</span>` : ""}</span>`;
}

/**
 * Compact one-line session row used by both desktop sidebar and mobile landing.
 *
 * Layout: [bobbit] [title] [rename] [terminate]
 *
 * Desktop: buttons hidden until hover (via group-hover), tooltip on mouseenter.
 * Mobile:  buttons always visible, no tooltip, slightly taller touch targets.
 */
export const SESSION_ROW_PY = "py-0.5";

/** Consistent indent per nesting level (px). */
export const INDENT = 5;
/** Width of the chevron/spacer slot (px) — same for all chevrons. */
export const CHEVRON_W = 14;
/** Wider chevron slot for level-0 section headers (extra right breathing room). */
export const HEADER_CHEVRON_W = 20;

export function renderSessionRow(session: GatewaySession) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;

	// Check for children (live delegates + archived delegates)
	const liveDelegates = state.gatewaySessions.filter(s => s.delegateOf === session.id && (state.showArchived || s.status !== "terminated"));
	const archivedDelegates = state.showArchived ? state.archivedSessions.filter(s => s.delegateOf === session.id) : [];
	const hasChildren = liveDelegates.length > 0 || archivedDelegates.length > 0;
	const childrenExpanded = hasChildren && isArchivedParentExpanded(session.id);

	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const isTeamLead = session.role === "team-lead";

	// Desktop: hover-revealed gradient overlay. Mobile: always-visible inline buttons.
	const buttons = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
			title="Modify">${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id); }}
			title="${isTeamLead ? "End team (Ctrl+Shift+D)" : "Terminate (Ctrl+Shift+D)"}">${icon(Trash2, "xs")}</button>
	`;

	return html`
		<div
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors text-sm
				${active ? `bg-secondary text-foreground sidebar-session-active${hasChildren ? "" : " sidebar-active-no-chevron"}` : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			${mobile ? "" : html``}
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			${hasChildren ? html`<span
				class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-sm text-muted-foreground select-none cursor-pointer"
				style="width:${CHEVRON_W}px;"
				@click=${(e: Event) => { e.stopPropagation(); toggleArchivedParentExpanded(session.id); renderApp(); }}
			>${childrenExpanded ? "▾" : "▸"}</span>` : ""}
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder", session.accessory)}
			</div>
			<div class="flex-1 min-w-0 flex flex-col justify-center">
				<div class="${mobile ? "flex items-center gap-1 min-w-0" : "text-xs"} font-normal"><span class="truncate ${mobile ? "text-base" : ""}">${renderSessionTitle(displayTitle, isActive)}</span>${mobile ? html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span>${renderSessionTime(session)}` : ""}</div>
				${session.personalities && session.personalities.length > 0 ? html`
					<div class="flex flex-wrap gap-0.5 mt-0.5">
						${session.personalities.map((t) => html`<span
							class="text-[9px] leading-none px-1 py-px rounded-md"
							class="bg-primary/15 text-primary"
							title=${t}
						>${t}</span>`)}
					</div>
				` : ""}
			</div>
			${mobile
				? buttons
				: html`<div class="absolute right-0 top-0 bottom-0 flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<span class="group-hover:hidden flex items-center">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions hidden group-hover:flex items-center gap-0">
						${buttons}
					</div>
				</div>`}
		</div>
		${childrenExpanded ? html`${renderLiveDelegates(session.id)}${renderArchivedDelegates(session.id)}` : ""}
	`;
}

/** Render live delegate sessions nested under a parent session. */
function renderLiveDelegates(parentSessionId: string): TemplateResult | string {
	const delegates = state.gatewaySessions.filter(s => s.delegateOf === parentSessionId && (state.showArchived || s.status !== "terminated"));
	if (delegates.length === 0) return "";
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
		${delegates.map(s => s.status === "terminated"
			? html`${renderArchivedSessionRow(s)}${renderArchivedDelegates(s.id)}`
			: renderSessionRow(s))}
	</div>`;
}

// Back-compat alias used by sidebar.ts
export { renderSessionRow as renderSidebarSession };

// ============================================================================
// ARCHIVED SESSION ROW
// ============================================================================

export function renderArchivedSessionRow(session: GatewaySession, extraChildren = false) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const delegates = state.archivedSessions.filter(s => s.delegateOf === session.id);
	const hasChildren = delegates.length > 0 || extraChildren;
	const expanded = hasChildren && isArchivedParentExpanded(session.id);
	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	return html`
		<div
			class="group relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors text-sm
				${active ? `bg-secondary text-foreground sidebar-session-active${hasChildren ? "" : " sidebar-active-no-chevron"}` : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px; filter:grayscale(1); opacity:0.75;"
			@click=${() => connectToSession(session.id, true, { readOnly: true })}
		>
			${hasChildren ? html`<span
				class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-sm text-muted-foreground select-none cursor-pointer"
				style="width:${CHEVRON_W}px;"
				@click=${(e: Event) => { e.stopPropagation(); toggleArchivedParentExpanded(session.id); renderApp(); }}
				title="${expanded ? "Collapse" : "Expand"}"
			>${expanded ? "▾" : "▸"}</span>` : ""}
			<div class="shrink-0 flex items-center justify-center">
				${statusBobbit("terminated", false, session.id, active, false, session.role === "team-lead", session.role === "coder", session.accessory)}
			</div>
			<div class="flex-1 min-w-0 font-normal truncate ${mobile ? "text-base" : "text-xs"}">${displayTitle}</div>
			${session.archivedAt ? html`<span class="shrink-0 ${mobile ? "text-xs" : "text-[10px]"} text-muted-foreground">${terseRelativeTime(session.archivedAt)}</span>` : ""}
		</div>
	`;
}

/** Render any archived delegate sessions nested under a parent session. */
export function renderArchivedDelegates(parentSessionId: string): TemplateResult | string {
	if (!isArchivedParentExpanded(parentSessionId)) return "";
	const delegates = state.archivedSessions.filter(s => s.delegateOf === parentSessionId);
	if (delegates.length === 0) return "";
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
		${delegates.map(s => html`
			${renderArchivedSessionRow(s)}
			${renderArchivedDelegates(s.id)}
		`)}
	</div>`;
}

// ============================================================================
// TEAM LEAD ROW (with collapsible team children)
// ============================================================================

/**
 * Renders the team-lead session as a collapsible parent row.
 * Shows a collapse/expand chevron and child count badge.
 */
function renderTeamLeadRow(session: GatewaySession, childCount: number, expanded: boolean) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;

	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const goalId = session.goalId || session.teamGoalId;
	const handleStopTeam = async (e: Event) => {
		e.stopPropagation();
		if (!goalId) return;
		teamLoading.add(goalId);
		renderApp();
		await teardownTeam(goalId);
		teamLoading.delete(goalId);
		await refreshSessions();
		renderApp();
	};

	const buttons = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
			title="Modify">${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${handleStopTeam}
			title="Stop Team">${icon(Trash2, "xs")}</button>
	`;

	const chevron = html`<span
		class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-sm text-muted-foreground select-none cursor-pointer"
		style="width:${CHEVRON_W}px;"
		@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(session.id); renderApp(); }}
		title="${expanded ? "Collapse agents" : "Expand agents"}"
	>${expanded ? "▾" : "▸"}</span>`;

	void childCount; // available if needed later

	return html`
		<div
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			${chevron}
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, true, false, session.accessory)}
			</div>
			<div class="flex-1 min-w-0 ${mobile ? "flex items-center gap-1 text-base" : "truncate text-xs"} font-normal"><span class="${mobile ? "truncate" : ""}">${renderSessionTitle(displayTitle, isActive)}</span>${mobile ? html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span>${renderSessionTime(session)}` : ""}</div>
			${mobile
				? buttons
				: html`<div class="absolute right-0 top-0 bottom-0 flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<span class="group-hover:hidden flex items-center">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions hidden group-hover:flex items-center gap-0">
						${buttons}
					</div>
				</div>`}
		</div>
	`;
}

// ============================================================================
// UNIFIED GOAL GROUP
// ============================================================================

/** Track in-flight team start/stop (shared across desktop and mobile). */
const teamLoading = new Set<string>();

/** Render a PR icon or gate status badge next to a goal in the sidebar. */
function renderGoalBadge(goalId: string) {
	// PR status takes priority over gate counts
	const pr = state.prStatusCache.get(goalId);
	if (pr) {
		let color: string;
		if (pr.state === "MERGED") color = "#a87fd4";
		else if (pr.state === "CLOSED") color = "#c47070";
		else if (pr.reviewDecision === "APPROVED") color = "#6bc485";
		else if (pr.reviewDecision === "CHANGES_REQUESTED") color = "#c47070";
		else if (pr.reviewDecision === "REVIEW_REQUIRED") color = "#d4a04a";
		else color = "#6bc485";
		const reviewLabel = pr.state === "OPEN" && pr.reviewDecision === "REVIEW_REQUIRED" ? " — awaiting review"
			: pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED" ? " — changes requested"
			: pr.state === "OPEN" && pr.reviewDecision === "APPROVED" ? " — approved"
			: "";
		const hasConflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
		const label = (pr.number ? `PR #${pr.number} ${pr.state.toLowerCase()}` : `PR ${pr.state.toLowerCase()}`) + reviewLabel + (hasConflicts ? " — has conflicts" : "");
		const prIcon = html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>`;
		if (pr.url) {
			return html`<a class="shrink-0 flex items-center ${hasConflicts ? "pr-conflict-pulse" : ""}" href=${pr.url} target="_blank" rel="noopener" title=${label} @click=${(e: Event) => e.stopPropagation()}>${prIcon}</a>`;
		}
		return html`<span class="shrink-0 flex items-center ${hasConflicts ? "pr-conflict-pulse" : ""}" title=${label}>${prIcon}</span>`;
	}

	// Fall back to gate status
	const gs = state.gateStatusCache.get(goalId);
	if (!gs) return "";
	const hasTeam = state.gatewaySessions.some(s => (s.goalId === goalId || s.teamGoalId === goalId) && s.role === "team-lead" && s.status !== "terminated");
	const allPassed = gs.passed === gs.total;
	const color = !hasTeam ? "#6b7280" : allPassed ? "#22c55e" : "#3b82f6";
	const label = `(${gs.passed}/${gs.total})`;
	if (gs.verifying) {
		// Mexican wave: each character gets a staggered animation
		const chars = label.split("");
		const totalDur = 1.2; // seconds for full wave cycle
		const stagger = totalDur / chars.length;
		return html`<span class="shrink-0 gate-wave" style="font-size:9px;color:${color};font-weight:600;letter-spacing:-0.02em;white-space:nowrap;" title="${gs.passed} of ${gs.total} gates passed — verifying">${chars.map((ch, i) =>
			html`<span style="animation-delay:${(i * stagger).toFixed(2)}s">${ch}</span>`
		)}</span>`;
	}
	return html`<span class="shrink-0" style="font-size:9px;color:${color};font-weight:600;letter-spacing:-0.02em;white-space:nowrap;" title="${gs.passed} of ${gs.total} gates passed">${label}</span>`;
}

/**
 * Expandable goal group used by both desktop sidebar and mobile landing.
 *
 * Layout: [▾/▸] [TITLE] [dashboard btn]
 * Expanded: child session rows + empty state + team controls
 *
 * Desktop: dashboard button hidden until hover. Double-click opens team-lead.
 * Mobile:  dashboard button always visible. No double-click (no hover hint).
 */
export function renderGoalGroup(goal: Goal) {
	const mobile = !isDesktop();
	const isExpanded = expandedGoals.has(goal.id);
	const goalSessions = state.gatewaySessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf).sort((a, b) => a.createdAt - b.createdAt);
	const isCreatingHere = state.creatingSessionForGoalId === goal.id;
	const isTeamGoal = !!(goal as any).team;
	const hasActiveTeam = isTeamGoal && goalSessions.some((s) => s.role === "team-lead" && s.status !== "terminated");
	const isLoading = teamLoading.has(goal.id);
	const isPreparing = goal.setupStatus === "preparing";

	const toggleExpand = () => {
		if (isExpanded) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id);
		saveExpandedGoals();
		renderApp();
	};

	const handleStartTeam = async (e?: Event) => {
		e?.stopPropagation();
		teamLoading.add(goal.id);
		renderApp();
		const sid = await startTeam(goal.id);
		teamLoading.delete(goal.id);
		if (sid) connectToSession(sid, false); else renderApp();
	};

	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const dashboardBtn = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); }}
			title="Goal dashboard">${icon(LayoutDashboard, "xs")}</button>
	`;

	const pr = state.prStatusCache.get(goal.id);
	const canArchive = !goal.archived && pr?.state === "MERGED" && !hasActiveTeam;
	const reattemptBtn = (goal.archived || canArchive) ? html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary" : "hover:bg-secondary text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); startReattempt(goal.id); }}
			title="Re-attempt goal">${icon(RotateCcw, "xs")}</button>
	` : nothing;

	const archiveBtn = canArchive ? html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary" : "hover:bg-secondary text-muted-foreground hover:text-secondary-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); deleteGoal(goal.id); }}
			title="Archive goal">${icon(Trash2, "xs")}</button>
	` : nothing;

	const emptyState = html`
		<div class="pl-2 py-1 ${mobile ? "text-xs" : "text-[11px]"} text-muted-foreground">
			${goal.archived
				? html`<span style="color:var(--text-tertiary)">Archived</span>`
				: canArchive
				? html`<span style="vertical-align:middle">Work merged —</span> <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-secondary/50 text-muted-foreground text-[10px] font-normal hover:bg-secondary/80 hover:text-foreground transition-colors align-middle" title="Archive goal" @click=${(e: Event) => { e.stopPropagation(); deleteGoal(goal.id); }}>${icon(Trash2, "xs")}Archive</button>`
				: isTeamGoal
				? html`<span style="vertical-align:middle">No agents —</span> <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-primary/10 text-primary text-[10px] font-semibold hover:bg-primary/20 transition-colors align-middle ${isPreparing ? "opacity-60 pointer-events-none" : ""}" title="${isPreparing ? "Setting up worktree\u2026" : "Start team"}" @click=${handleStartTeam} ?disabled=${isLoading || isPreparing}>${isPreparing ? html`<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>` : html`<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12h12v1.5H2V12zm0-1L1 4l4 3 3-5 3 5 4-3-1 7H2z"/></svg>`}${isLoading ? "Starting\u2026" : isPreparing ? "Setting up\u2026" : "Start Team"}</button>`
				: html`No sessions — <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-primary/10 text-primary font-semibold hover:bg-primary/20 transition-colors" title="Start a session" @click=${() => createAndConnectSession(goal.id)}><svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3l8 5-8 5V3z"/></svg>start one</button>`}
		</div>
	`;

	const teamControls = "";

	// Separate team lead from team children for nested rendering
	const teamLead = isTeamGoal ? goalSessions.find(s => s.role === "team-lead") : null;
	const teamChildren = isTeamGoal && teamLead ? goalSessions.filter(s => s.id !== teamLead.id) : [];
	const nonTeamSessions = isTeamGoal ? goalSessions.filter(s => !teamLead || (s.id !== teamLead.id && !teamChildren.includes(s))) : goalSessions;

	const renderTeamGroup = () => {
		if (!teamLead) return goalSessions.map(renderSessionRow);
		const tlExpanded = isTeamLeadExpanded(teamLead.id);
		// Archived members belonging to the live lead
		const archivedLeadIds = new Set(state.archivedSessions.filter(s => s.teamGoalId === goal.id && s.role === "team-lead").map(s => s.id));
		const archivedForLiveLead = state.showArchived
			? state.archivedSessions.filter(s => s.teamGoalId === goal.id && !s.delegateOf && s.role !== "team-lead" && (s.teamLeadSessionId === teamLead.id || !s.teamLeadSessionId || !archivedLeadIds.has(s.teamLeadSessionId)))
			: [];
		return html`
			${renderTeamLeadRow(teamLead, teamChildren.length + archivedForLiveLead.length, tlExpanded)}
			${tlExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${teamChildren.map(renderSessionRow)}
					${archivedForLiveLead.map(s => html`
						${renderArchivedSessionRow(s)}
						${renderArchivedDelegates(s.id)}
					`)}
				</div>
			` : ""}
			${nonTeamSessions.map(renderSessionRow)}
		`;
	};

	return html`
		<div class="flex flex-col ${goal.state === "shelved" ? "opacity-60" : ""}">
			<div class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${mobile ? "py-1" : "py-0.5"} rounded-md cursor-pointer ${mobile ? "active:bg-secondary/50" : "hover:bg-secondary/50"} transition-colors"
				style="padding-left:${HEADER_CHEVRON_W}px;"
				@click=${toggleExpand}
				@dblclick=${!mobile ? () => { if (goal.team) { const tl = goalSessions.find(s => s.role === "team-lead"); if (tl) connectToSession(tl.id, true); } } : null}>
				<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-sm text-muted-foreground select-none" style="width:${HEADER_CHEVRON_W}px;" title="${isExpanded ? "Collapse goal" : "Expand goal"}">${isExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(GoalIcon, "xs")}</span>
				${goal.setupStatus === "preparing" ? html`<svg class="animate-spin shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>` : goal.setupStatus === "error" ? html`<span class="shrink-0" style="color:var(--destructive);font-size:10px;line-height:1;" title="Worktree setup failed">⚠</span>` : ""}
				<span class="flex-1 min-w-0 truncate ${mobile ? "text-sm" : "text-[10px]"} text-muted-foreground uppercase tracking-wider font-medium">${goal.title}</span>
				${renderGoalBadge(goal.id)}
				${mobile
					? html`${reattemptBtn}${archiveBtn}${dashboardBtn}`
					: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
						${reattemptBtn}${archiveBtn}${dashboardBtn}
					</div>`}
			</div>
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${goalSessions.length === 0 && !isCreatingHere ? (goal.archived ? nothing : emptyState) : (isTeamGoal ? renderTeamGroup() : goalSessions.map(renderSessionRow))}
					${isCreatingHere ? html`<div style="padding-left:${CHEVRON_W}px;" class="py-1 ${mobile ? "text-xs" : "text-[10px]"} text-muted-foreground flex items-center gap-1">
						<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
						Creating…
					</div>` : ""}
					${teamControls}
					${state.showArchived ? (() => {
						const archivedForGoal = state.archivedSessions.filter(s => s.teamGoalId === goal.id && !s.delegateOf);
						const archivedLeads = archivedForGoal.filter(s => s.role === "team-lead");
						const archivedMembers = archivedForGoal.filter(s => s.role !== "team-lead");

						// Map each member to its lead (live or archived) via teamLeadSessionId.
						// All leads: live lead first (if any), then archived leads.
						const allLeads = [...(teamLead ? [teamLead.id] : []), ...archivedLeads.map(s => s.id)];
						const membersOf = (leadId: string) => archivedMembers.filter(m => m.teamLeadSessionId === leadId);
						const mappedIds = new Set(archivedMembers.filter(m => m.teamLeadSessionId && allLeads.includes(m.teamLeadSessionId)).map(m => m.id));
						const unmapped = archivedMembers.filter(m => !mappedIds.has(m.id));

						// Render archived leads, each with their own members
						const renderLeadWithMembers = (lead: GatewaySession, isLast: boolean) => {
							const myMembers = [...membersOf(lead.id), ...(isLast ? unmapped : [])];
							const expanded = isArchivedParentExpanded(lead.id);
							return html`
								${renderArchivedSessionRow(lead, myMembers.length > 0)}
								${renderArchivedDelegates(lead.id)}
								${expanded && myMembers.length > 0 ? html`
									<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
										${myMembers.map(m => html`
											${renderArchivedSessionRow(m)}
											${renderArchivedDelegates(m.id)}
										`)}
									</div>
								` : ""}
							`;
						};

						return html`
							${archivedLeads.map((s, i) => renderLeadWithMembers(s, i === archivedLeads.length - 1 && !teamLead))}
							${!teamLead && unmapped.length > 0 ? unmapped.map(m => html`
								${renderArchivedSessionRow(m)}
								${renderArchivedDelegates(m.id)}
							`) : ""}
						`;
					})() : ""}
				</div>
			` : ""}
		</div>
	`;
}

// ============================================================================
// GOAL STATE ICON
// ============================================================================

export function goalStateIcon(goalState: GoalState, size = 14) {
	const C = 2 * Math.PI * 10;
	const blue = "#3b82f6";
	const green = "#22c55e";
	const grey = "#6b7280";

	let circleContent: ReturnType<typeof svg>;
	if (goalState === "complete") {
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${green}" stroke-width="2"/>`;
	} else if (goalState === "in-progress") {
		const progress = (240 / 360) * C;
		circleContent = svg`
			<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="0.4"/>
			<circle cx="12" cy="12" r="10" fill="none" stroke="${blue}" stroke-width="2"
				stroke-dasharray="${progress} ${C}"
				stroke-dashoffset="0"
				transform="rotate(-90 12 12)"/>
		`;
	} else {
		const opacity = goalState === "shelved" ? "0.3" : "0.5";
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="${opacity}"/>`;
	}

	const lineColor = goalState === "complete" ? green : goalState === "in-progress" ? blue : grey;
	const lineOpacity = goalState === "shelved" ? "0.3" : goalState === "todo" ? "0.5" : "1";

	return html`
		<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="display:block;flex-shrink:0;">
			${circleContent}
			${svg`<line x1="22" x2="18" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="6" x2="2" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="6" y2="2" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="22" y2="18" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
		</svg>
	`;
}
