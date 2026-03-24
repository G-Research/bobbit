import { icon } from "@mariozechner/mini-lit";
import { html, svg } from "lit";
import { Goal as GoalIcon, LayoutDashboard, Pencil, Shield, Trash2 } from "lucide";
import {
	state,
	renderApp,
	activeSessionId,
	expandedGoals,
	saveExpandedGoals,
	isDesktop,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	type GatewaySession,
	type Goal,
	type GoalState,
} from "./state.js";
import { statusBobbit } from "./session-colors.js";
import { connectToSession, terminateSession, createAndConnectSession } from "./session-manager.js";
import { showRenameDialog, showAssignRoleDialog } from "./dialogs.js";
import { setHashRoute } from "./routing.js";
import { startTeam, teardownTeam, refreshSessions } from "./api.js";

// ============================================================================
// TOOLTIP (desktop only — mouse hover)
// ============================================================================

let _tooltipEl: HTMLDivElement | null = null;
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;

function getTooltipEl(): HTMLDivElement {
	if (!_tooltipEl) {
		_tooltipEl = document.createElement("div");
		_tooltipEl.className = "sidebar-tooltip";
		document.body.appendChild(_tooltipEl);
	}
	return _tooltipEl;
}

export function showSessionTooltip(e: MouseEvent, session: GatewaySession, displayTitle: string): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	const el = getTooltipEl();
	const roleLabel = session.assistantType === "goal" ? "Goal Assistant" : (session.role && session.role !== "general" ? session.role : "");
	el.innerHTML = `
		<div class="tt-title">${escapeHtml(displayTitle)}</div>
		<div class="tt-cwd">${escapeHtml(session.cwd)}</div>
		${roleLabel ? `<div class="tt-meta" style="color:var(--primary);opacity:0.8">${escapeHtml(roleLabel)}</div>` : ""}
		<div class="tt-meta">${escapeHtml(formatSessionAge(session.lastActivity))}</div>
	`;
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	el.style.left = `${rect.right + 8}px`;
	el.style.top = `${rect.top + rect.height / 2}px`;
	el.style.transform = "translateY(-50%)";
	el.classList.add("visible");
}

export function hideSessionTooltip(): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	_tooltipTimer = setTimeout(() => {
		getTooltipEl().classList.remove("visible");
	}, 80);
}

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
 *  "Unseen" means: session is idle/terminated AND lastActivity > last visit time. */
export function hasUnseenActivity(session: GatewaySession): boolean {
	// Active sessions don't show unseen — user will see it when they connect
	if (session.status === "streaming" || session.status === "busy") return false;
	// Currently viewed session is never unseen
	if (activeSessionId() === session.id) return false;
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

/** Render "active" with a subtle shimmer wave across each letter. */
function renderActiveShimmer() {
	const letters = "active".split("");
	return html`<span class="shrink-0 inline-flex items-center text-[11px] text-muted-foreground/50" style="letter-spacing:0.01em;vertical-align:middle;">${letters.map((ch, i) =>
		html`<span class="sidebar-shimmer-letter" style="animation-delay:${i * 0.18}s">${ch}</span>`
	)}</span>`;
}

/** Render terse relative time with optional unseen indicator dot. */
function renderSessionTime(session: GatewaySession) {
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;
	if (isActive) return renderActiveShimmer();
	const time = terseRelativeTime(session.lastActivity);
	if (!time) return "";
	const unseen = hasUnseenActivity(session);
	return html`<span
		class="shrink-0 inline-flex items-center gap-0.5 text-[11px] tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}"
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

export function renderSessionRow(session: GatewaySession) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;

	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const btnPad = mobile ? "p-1.5" : "p-0.5";

	// Desktop: hover-revealed gradient overlay. Mobile: always-visible inline buttons.
	const isTeamAgent = !!session.teamGoalId;
	const buttons = html`
		${isTeamAgent ? "" : html`<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showAssignRoleDialog(session.id); }}
			title="Assign Role">${icon(Shield, "xs")}</button>`}
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
			title="Rename">${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id); }}
			title="Terminate">${icon(Trash2, "xs")}</button>
	`;

	return html`
		<div
			class="${mobile ? "" : "group relative"} flex items-center gap-1 pl-2 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			${mobile ? "" : html``}
			@mouseenter=${mobile ? null : (e: MouseEvent) => showSessionTooltip(e, session, displayTitle)}
			@mouseleave=${mobile ? null : hideSessionTooltip}
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder", session.accessory)}
			</div>
			<div class="flex-1 min-w-0 flex flex-col justify-center">
				<div class="${mobile ? "flex items-baseline gap-1 min-w-0" : "text-xs"} ${isActive ? "font-semibold" : "font-normal"}"><span class="truncate ${mobile ? "text-base" : ""}">${displayTitle}</span>${mobile ? html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span>${renderSessionTime(session)}` : ""}</div>
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
			${!mobile ? renderSessionTime(session) : ""}
			${mobile
				? buttons
				: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					${buttons}
				</div>`}
		</div>
	`;
}

// Back-compat alias used by sidebar.ts
export { renderSessionRow as renderSidebarSession };

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

	const buttons = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
			title="Rename">${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id); }}
			title="Terminate">${icon(Trash2, "xs")}</button>
	`;

	const chevron = html`<span
		class="text-[11px] text-muted-foreground shrink-0 select-none cursor-pointer"
		style="width:12px;text-align:center;"
		@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(session.id); renderApp(); }}
		title="${expanded ? "Collapse agents" : "Expand agents"}"
	>${expanded ? "▾" : "▸"}</span>`;

	const childBadge = childCount > 0 ? html`<span class="text-[9px] text-muted-foreground/70 tabular-nums shrink-0" title="${childCount} agent${childCount !== 1 ? "s" : ""}">${childCount}</span>` : "";

	return html`
		<div
			class="${mobile ? "" : "group relative"} flex items-center gap-1 pl-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			@mouseenter=${mobile ? null : (e: MouseEvent) => showSessionTooltip(e, session, displayTitle)}
			@mouseleave=${mobile ? null : hideSessionTooltip}
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			${chevron}
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, true, false, session.accessory)}
			</div>
			<div class="flex-1 min-w-0 ${mobile ? "flex items-baseline gap-1 text-base" : "truncate text-xs"} ${isActive ? "font-semibold" : "font-normal"}"><span class="${mobile ? "truncate" : ""}">${displayTitle}</span>${mobile ? html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span>${renderSessionTime(session)}` : ""}</div>
			${childBadge}
			${!mobile ? renderSessionTime(session) : ""}
			${mobile
				? buttons
				: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					${buttons}
				</div>`}
		</div>
	`;
}

// ============================================================================
// UNIFIED GOAL GROUP
// ============================================================================

/** Track in-flight team start/stop (shared across desktop and mobile). */
const teamLoading = new Set<string>();

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
	const goalSessions = state.gatewaySessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf);
	const isCreatingHere = state.creatingSessionForGoalId === goal.id;
	const isTeamGoal = !!(goal as any).team;
	const hasActiveTeam = isTeamGoal && goalSessions.some((s) => s.role === "team-lead" && s.status !== "terminated");
	const isLoading = teamLoading.has(goal.id);

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

	const handleEndTeam = async (e?: Event) => {
		e?.stopPropagation();
		teamLoading.add(goal.id);
		renderApp();
		await teardownTeam(goal.id);
		teamLoading.delete(goal.id);
		await refreshSessions();
		renderApp();
	};

	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const dashboardBtn = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); }}
			title="Goal dashboard">${icon(LayoutDashboard, "xs")}</button>
	`;

	const emptyState = html`
		<div class="pl-2 py-1 ${mobile ? "text-xs" : "text-[10px]"} text-muted-foreground">
			${isTeamGoal
				? html`No agents — <button class="text-primary ${mobile ? "" : "hover:underline"}" @click=${handleStartTeam}>${isLoading ? "starting\u2026" : "start team"}</button>`
				: html`No sessions — <button class="text-primary ${mobile ? "" : "hover:underline"}" @click=${() => createAndConnectSession(goal.id)}>start one</button>`}
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
		return html`
			${renderTeamLeadRow(teamLead, teamChildren.length, tlExpanded)}
			${tlExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:12px;">
					${teamChildren.map(renderSessionRow)}
				</div>
			` : ""}
			${nonTeamSessions.map(renderSessionRow)}
		`;
	};

	return html`
		<div class="flex flex-col ${goal.state === "shelved" ? "opacity-60" : ""}">
			<div class="${mobile ? "" : "group relative"} flex items-center gap-1 pl-0 pr-1 ${mobile ? "py-1" : "py-0.5"} rounded-md cursor-pointer ${mobile ? "active:bg-secondary/50" : "hover:bg-secondary/50"} transition-colors"
				@click=${toggleExpand}
				@dblclick=${!mobile ? () => { if (goal.team) { const tl = goalSessions.find(s => s.role === "team-lead"); if (tl) connectToSession(tl.id, true); } } : null}>
				<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${isExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground">${icon(GoalIcon, "xs")}</span>
				<span class="flex-1 min-w-0 truncate ${mobile ? "text-sm" : "text-[10px]"} text-muted-foreground uppercase tracking-wider font-medium">${goal.title}</span>
				${mobile
					? dashboardBtn
					: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
						${dashboardBtn}
					</div>`}
			</div>
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5">
					${goalSessions.length === 0 && !isCreatingHere ? emptyState : (isTeamGoal ? renderTeamGroup() : goalSessions.map(renderSessionRow))}
					${isCreatingHere ? html`<div class="pl-2 py-1 ${mobile ? "text-xs" : "text-[10px]"} text-muted-foreground flex items-center gap-1">
						<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
						Creating…
					</div>` : ""}
					${teamControls}
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
