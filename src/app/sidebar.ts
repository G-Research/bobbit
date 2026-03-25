import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Archive, Bot, ChevronDown, ChevronRight, Drama, Goal as GoalIcon, List, MessagesSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Users, Workflow, Wrench } from "lucide";
import {
	state,
	renderApp,
	activeSessionId,
	isDesktop,
	expandedGoals,
	ungroupedExpanded,
	setUngroupedExpanded,
	staffSectionExpanded,
	setStaffSectionExpanded,
	saveExpandedGoals,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	type Goal,
	type GoalState,
} from "./state.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { showGoalDialog } from "./dialogs.js";
import { refreshSessions, fetchRoles, fetchPersonalities, fetchStaff, wakeStaffAgent, fetchArchivedSessions, type PersonalityData } from "./api.js";
import { statusBobbit, sessionAcronym } from "./session-colors.js";
import { renderGoalGroup, renderSessionRow, renderArchivedSessionRow, renderArchivedDelegates, showSessionTooltip, hideSessionTooltip, SESSION_ROW_PY, INDENT, CHEVRON_W, terseRelativeTime, hasUnseenActivity, formatSessionAge } from "./render-helpers.js";
import type { GatewaySession } from "./state.js";

// ============================================================================
// ROLE + PERSONALITY PICKER
// ============================================================================

/** Cached personality definitions. */
let _cachedPersonalities: PersonalityData[] = [];
let _personalitiesLoaded = false;
/** Currently selected role in the picker. */
let _pickerRole = "";
/** Currently selected personalities in the picker. */
let _pickerPersonalities = new Set<string>();
/** Goal ID context for the picker (if launched from a goal). */
let _pickerGoalId: string | undefined;

async function ensurePersonalitiesLoaded(): Promise<void> {
	if (_personalitiesLoaded) return;
	_personalitiesLoaded = true;
	_cachedPersonalities = await fetchPersonalities();
}

/** Toggle role picker dropdown, fetching roles and personalities if needed. */
export async function toggleRolePicker(e: Event, goalId?: string): Promise<void> {
	e.stopPropagation();
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
		return;
	}
	_pickerRole = "";
	_pickerPersonalities = new Set();
	_pickerGoalId = goalId;
	if (state.roles.length === 0) await fetchRoles();
	await ensurePersonalitiesLoaded();
	state.rolePickerOpen = true;
	renderApp();
}

/** Exported for use in edit-session dialog and other places. */
export { _cachedPersonalities as cachedPersonalities, ensurePersonalitiesLoaded };

export function renderRolePickerDropdown() {
	if (!state.rolePickerOpen) return "";

	const selectRole = (roleName: string) => {
		_pickerRole = _pickerRole === roleName ? "" : roleName;
		renderApp();
	};
	const togglePersonality = (personalityName: string) => {
		if (_pickerPersonalities.has(personalityName)) _pickerPersonalities.delete(personalityName);
		else _pickerPersonalities.add(personalityName);
		renderApp();
	};
	const doCreate = () => {
		state.rolePickerOpen = false;
		const personalities = [..._pickerPersonalities];
		createAndConnectSession(_pickerGoalId, _pickerRole || undefined, personalities.length > 0 ? personalities : undefined);
	};

	return html`
		<div class="absolute right-0 top-full mt-1 z-50 rounded-md shadow-lg py-1 min-w-[200px] max-w-[280px]"
			style="background: var(--popover); border: 1px solid var(--border);"
			@click=${(e: Event) => e.stopPropagation()}>
			<!-- Personalities -->
			${_cachedPersonalities.length > 0 ? html`
				<div class="px-3 pt-1 pb-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Personalities</div>
				<div class="px-3 pb-2 flex flex-wrap gap-1">
					${_cachedPersonalities.map(personality => {
						const selected = _pickerPersonalities.has(personality.name);
						return html`<button
							class="px-2 py-0.5 text-[11px] rounded-xl border transition-colors cursor-pointer ${selected
								? "bg-primary/15 text-primary border-primary/30"
								: "bg-muted/60 text-foreground/70 border-border"}"
							title=${personality.description}
							@click=${() => togglePersonality(personality.name)}
						>${personality.label}</button>`;
					})}
				</div>
			` : ""}
			<!-- Roles -->
			<div class="${_cachedPersonalities.length > 0 ? "border-t border-border/50 mt-1 pt-1" : ""}">
				<div class="px-3 pt-1 pb-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Role</div>
				${state.roles.filter(r => r.name !== "general").length === 0
					? html`<div class="px-3 py-1 text-xs text-muted-foreground">No roles defined</div>`
					: state.roles.filter(r => r.name !== "general").map(role => html`
						<button class="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/50 active:bg-secondary text-foreground flex items-center gap-2 ${_pickerRole === role.name ? "bg-primary/10" : ""}"
							@click=${() => selectRole(role.name)}
							title="Select ${role.label} role">
							<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
							<span class="flex-1 ${_pickerRole === role.name ? "text-primary font-medium" : ""}">${role.label}</span>
							${_pickerRole === role.name ? html`<span class="text-primary text-xs">✓</span>` : ""}
						</button>
					`)}
			</div>
			<!-- Create button -->
			<div class="border-t border-border/50 px-3 py-2">
				<button
					class="w-full text-center px-3 py-1.5 text-sm rounded-md font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90"
					@click=${doCreate}
					title="Create session with selected role"
				>Create Session</button>
			</div>
		</div>
	`;
}

// Close role picker on outside click
document.addEventListener("click", () => {
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
	}
});

// ============================================================================
// SIDEBAR TOGGLE
// ============================================================================

export function toggleSidebar(): void {
	state.sidebarCollapsed = !state.sidebarCollapsed;
	localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
	renderApp();
}

// ============================================================================
// SIDEBAR GOAL — uses unified renderGoalGroup from render-helpers.ts
// ============================================================================

// ============================================================================
// STAFF SIDEBAR
// ============================================================================

/** Ensure staff list is loaded (called once). */
let _staffLoaded = false;
function ensureStaffLoaded(): void {
	if (_staffLoaded) return;
	_staffLoaded = true;
	fetchStaff().then((list) => {
		state.staffList = list.map((s) => ({
			id: s.id, name: s.name, description: s.description, state: s.state,
			lastWakeAt: s.lastWakeAt, currentSessionId: s.currentSessionId, triggers: s.triggers,
		}));
		renderApp();
	});
}

/** Reload staff list (e.g. after creating one). */
export function reloadStaffList(): Promise<void> {
	return fetchStaff().then((list) => {
		state.staffList = list.map((s) => ({
			id: s.id, name: s.name, description: s.description, state: s.state,
			lastWakeAt: s.lastWakeAt, currentSessionId: s.currentSessionId, triggers: s.triggers,
		}));
		renderApp();
	});
}

function relativeTime(ts?: number): string {
	if (!ts) return "";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	return `${Math.floor(diff / 86_400_000)}d`;
}

async function createStaffAssistantSession(e: Event): Promise<void> {
	e.stopPropagation();
	const { gatewayFetch } = await import("./api.js");
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "staff" }),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		const { id } = await res.json();
		await connectToSession(id, false, { isStaffAssistant: true, assistantType: "staff" });
	} catch (err) {
		console.error("[staff] Failed to create staff assistant session:", err);
	}
}

async function handleStaffClick(agent: typeof state.staffList[0]): Promise<void> {
	// Staff agents always have a permanent session — just connect to it
	if (agent.currentSessionId) {
		const sessionExists = state.gatewaySessions.some((s) => s.id === agent.currentSessionId);
		if (sessionExists) {
			await connectToSession(agent.currentSessionId, true);
			return;
		}
		// Session was deleted — fall through to wake (creates a new one)
	}
	// Fallback for legacy staff without a session
	const result = await wakeStaffAgent(agent.id, "Manual wake from sidebar");
	if (result?.sessionId) {
		await reloadStaffList();
		await refreshSessions();
		await connectToSession(result.sessionId, false);
	}
}

export function renderStaffSidebarSection() {
	ensureStaffLoaded();
	const list = state.staffList.filter((s) => s.state !== "retired");
	const mobile = !isDesktop();
	// Always show the Staff section so users can create their first staff agent

	return html`
		<div class="border-t border-border/30 my-1 mx-2"></div>
		<div class="flex flex-col gap-0.5">
			<div class="relative flex items-center ${mobile ? "gap-1.5 pl-0 pr-2 py-1.5" : "gap-1 pr-1 py-0.5"} rounded-md cursor-pointer ${mobile ? "active:bg-secondary/50" : "hover:bg-secondary/30"} transition-colors"
				style="${mobile ? "" : `padding-left:${CHEVRON_W}px;`}"
				@click=${() => { setStaffSectionExpanded(!staffSectionExpanded); renderApp(); }}>
				<span class="${mobile ? "" : "absolute left-0 top-0 bottom-0 flex items-center justify-center"} ${mobile ? "text-sm" : "text-[11px]"} text-muted-foreground shrink-0 select-none" style="${mobile ? "width:14px;text-align:center;" : `width:${CHEVRON_W}px;`}">${staffSectionExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(Bot, mobile ? "sm" : "xs")}</span>
				<span class="flex-1 ${mobile ? "text-sm" : "text-[10px]"} text-muted-foreground uppercase tracking-wider font-medium">Staff</span>
				<div class="flex items-center" @click=${(e: Event) => e.stopPropagation()}>
					<button
						class="${mobile ? "p-2 rounded" : "p-0.5 rounded-md"} text-muted-foreground active:bg-secondary/50 hover:bg-secondary/50 transition-colors"
						@click=${() => { import("./staff-page.js").then((m) => m.loadStaffPageData()); import("./routing.js").then((m) => m.setHashRoute("staff")); }}
						title="Manage staff agents"
					>${icon(List, mobile ? "sm" : "xs")}</button>
					<button
						class="${mobile ? "p-2 rounded" : "p-0.5 rounded-md"} text-muted-foreground active:bg-secondary/50 hover:bg-secondary/50 transition-colors"
						@click=${createStaffAssistantSession}
						title="New staff agent"
					>${icon(Plus, mobile ? "sm" : "xs")}</button>
				</div>
			</div>
			${staffSectionExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">${list.filter((agent) => {
				// Hide staff agents whose current session is archived and belongs to a goal
				// — those show under their goal's archived section instead
				if (agent.currentSessionId) {
					const archivedSession = state.archivedSessions.find(s => s.id === agent.currentSessionId);
					if (archivedSession?.teamGoalId) return false;
				}
				return true;
			}).map((agent) => {
				const mobile = !isDesktop();
				const session = agent.currentSessionId
					? state.gatewaySessions.find((s) => s.id === agent.currentSessionId)
					: undefined;
				const active = activeSessionId() === agent.currentSessionId;
				const sessionStatus = session?.status || "terminated";
				const isCompacting = session?.isCompacting || false;
				const isAborting = session?.isAborting || false;
				const accessory = session?.accessory;
				const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
				const btnPad = mobile ? "p-1.5" : "p-0.5";
				const editBtn = html`<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
					@click=${(e: Event) => { e.stopPropagation(); window.location.hash = `#/staff/${agent.id}`; }}
					title="Edit">${icon(Pencil, "xs")}</button>`;
				return html`
				<div class="${mobile ? "" : "group relative"} flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
					${active ? "bg-secondary text-foreground sidebar-session-active" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
					style="padding-left:${CHEVRON_W}px;"
					@click=${() => handleStaffClick(agent)}>
					${statusBobbit(sessionStatus, isCompacting, agent.currentSessionId, active, isAborting, false, false, accessory)}
					<div class="flex-1 min-w-0 ${mobile ? "flex items-baseline gap-1" : "text-xs"} ${active ? "font-medium" : "font-normal"}"><span class="truncate ${mobile ? "text-base" : ""}">${agent.name}</span>${mobile && session ? (() => {
							const isActiveSession = sessionStatus === "streaming" || sessionStatus === "busy" || isCompacting;
							if (isActiveSession) { const _d = (agent.id.charCodeAt(0) % 5) * 1.8; return html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span><span class="sidebar-active-dot" style="--dot-delay:${_d}s"></span>`; }
							const time = terseRelativeTime(session.lastActivity);
							if (!time) return "";
							const unseen = hasUnseenActivity(session);
							return html`<span class="shrink-0 text-[11px] text-muted-foreground/40">·</span><span class="shrink-0 inline-flex items-center gap-0.5 text-[11px] tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" style="vertical-align:middle;" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="text-primary" style="font-size:6px;line-height:1;">●</span>` : ""}</span>`;
						})() : ""}</div>
					${!mobile && session ? (() => {
						const time = terseRelativeTime(session.lastActivity);
						if (!time) return "";
						const unseen = hasUnseenActivity(session);
						return html`<span class="shrink-0 flex items-center gap-0.5 text-[10px] tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="text-primary" style="font-size:6px;line-height:1;">●</span>` : ""}</span>`;
					})() : ""}
					${mobile
						? editBtn
						: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
							${editBtn}
						</div>`}
				</div>
			`; })}</div>` : ""}
	`;
}

// renderArchivedSessionRow is now in render-helpers.ts

// ============================================================================
// RENDER SIDEBAR
// ============================================================================

export function renderSidebar() {
	const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.teamGoalId && !s.delegateOf && !staffSessionIds.has(s.id)).sort((a, b) => a.createdAt - b.createdAt);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

	if (state.sidebarCollapsed) {
		return renderCollapsedSidebar(sortedGoals, ungroupedSessions);
	}

	return html`
		<div class="w-[240px] shrink-0 h-full flex flex-col sidebar-edge" style="background: var(--sidebar);">
			<div class="flex flex-col border-b border-border/50 px-0.5 py-1 gap-0.5">
				<div class="flex items-center">
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
						@click=${() => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); import("./routing.js").then((m) => m.setHashRoute("roles")); }}
						title="Manage roles"
					>
						${icon(Users, "sm")}
						<span>Roles</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
						@click=${() => { import("./personality-manager-page.js").then((m) => m.loadPersonalityPageData()); import("./routing.js").then((m) => m.setHashRoute("personalities")); }}
						title="Manage personalities"
					>
						${icon(Drama, "sm")}
						<span>Personalities</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
						@click=${() => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); import("./routing.js").then((m) => m.setHashRoute("tools")); }}
						title="Manage tools"
					>
						${icon(Wrench, "sm")}
						<span>Tools</span>
					</button>
				</div>
				<div class="flex items-center">
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
						@click=${() => { import("./workflow-page.js").then((m) => m.loadWorkflowPageData()); import("./routing.js").then((m) => m.setHashRoute("workflows")); }}
						title="Manage workflows"
					>
						${icon(Workflow, "sm")}
						<span>Workflows</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
						@click=${() => showGoalDialog()}
						title="New goal (Alt+G)"
					>
						${icon(GoalIcon, "sm")}
						<span>New Goal</span>
					</button>
				</div>
			</div>
			<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 py-2 px-0.5">
				${state.sessionsLoading
					? html`<div class="text-center py-6 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-6">
								<p class="text-xs text-red-500 mb-2">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground hover:text-foreground underline" title="Retry loading sessions" @click=${refreshSessions}>Retry</button>
							</div>`
						: html`
							${sortedGoals.map((goal, i) => html`
								${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
								${renderGoalGroup(goal)}
							`)}
							${sortedGoals.length > 0 ? html`
								<div class="border-t border-border/30 my-1 mx-2"></div>
								<div class="flex flex-col gap-0.5">
									<div class="relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/30 transition-colors"
										style="padding-left:${CHEVRON_W}px;"
										@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
										<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-[11px] text-muted-foreground select-none" style="width:${CHEVRON_W}px;">${ungroupedExpanded ? "▾" : "▸"}</span>
										<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(MessagesSquare, "xs")}</span>
										<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
										<div class="flex items-center relative">
											<button
												class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
												@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
												title="New session"
												?disabled=${state.creatingSession}
											>
												${state.creatingSession && !state.creatingSessionForGoalId
													? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
													: icon(Plus, "xs")}
											</button>
											<button
												class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
												@click=${toggleRolePicker}
												title="New session with role"
											>${icon(ChevronDown, "xs")}</button>
											${renderRolePickerDropdown()}
										</div>
									</div>
									${ungroupedExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">${ungroupedSessions.map(renderSessionRow)}</div>` : ""}
								</div>
							` : html`
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-1 pl-0 pr-1 py-0.5">
										<span class="flex-1 flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:${CHEVRON_W}px;"><span class="shrink-0" style="margin-right:-3px;">${icon(MessagesSquare, "xs")}</span> Sessions</span>
										<div class="flex items-center relative">
											<button
												class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
												@click=${() => createAndConnectSession()}
												title="New session"
												?disabled=${state.creatingSession}
											>
												${state.creatingSession && !state.creatingSessionForGoalId
													? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
													: icon(Plus, "xs")}
											</button>
											<button
												class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
												@click=${toggleRolePicker}
												title="New session with role"
											>${icon(ChevronDown, "sm")}</button>
											${renderRolePickerDropdown()}
										</div>
									</div>
									<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
									${ungroupedSessions.length === 0
										? html`<div class="text-center py-6">
												<p class="text-xs text-muted-foreground mb-2">No sessions</p>
												<button class="text-xs text-primary hover:underline" title="Create a new session" @click=${() => createAndConnectSession()}>Create one</button>
											</div>`
										: ungroupedSessions.map(renderSessionRow)}
								</div>
								</div>
							`}
							${renderStaffSidebarSection()}
							${(() => {
								// Archived section: standalone archived sessions (no goal, not a delegate)
								// Goal-affiliated archived sessions render inside their goal groups.
								// Delegates render nested under their parent (live or archived).
								const standaloneArchived = state.showArchived ? state.archivedSessions.filter(s => !s.teamGoalId && !s.delegateOf) : [];

								return html`
									<div class="border-t border-border/30 my-1 mx-2"></div>
									<div class="flex flex-col gap-0.5">
										<button
											class="relative flex items-center gap-1 pr-1 py-0.5 w-full text-left hover:bg-secondary/30 rounded-md transition-colors"
											style="padding-left:${CHEVRON_W}px;"
											@click=${() => { state.archivedSectionExpanded = !state.archivedSectionExpanded; renderApp(); }}
										>
											<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-[11px] text-muted-foreground select-none opacity-60" style="width:${CHEVRON_W}px;">${state.archivedSectionExpanded ? "▾" : "▸"}</span>
											<span class="shrink-0 text-muted-foreground opacity-60">${icon(Archive, "xs")}</span>
											<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium opacity-60">Archived</span>
										</button>
										${state.archivedSectionExpanded ? html`
											<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
												${standaloneArchived.map(s => html`
													${renderArchivedSessionRow(s)}
													${renderArchivedDelegates(s.id)}
												`)}
											</div>
										` : ""}
									</div>
								`;
							})()}
						`
				}
			</div>
			<div class="flex items-center border-t border-border/50">
				<button
					class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
					@click=${() => { import("./settings-page.js").then((m) => m.toggleSettings()); }}
					title="Settings (Ctrl+,)"
				>
					${icon(Settings, "sm")}
					<span>Settings</span>
				</button>
				<button
					class="flex items-center gap-1.5 px-2 py-2 text-xs ${state.showArchived ? "text-primary" : "text-muted-foreground"} hover:text-foreground hover:bg-secondary/50 transition-colors"
					@click=${() => {
						state.showArchived = !state.showArchived;
						localStorage.setItem("bobbit-show-archived", String(state.showArchived));
						if (state.showArchived) {
							state.archivedSectionExpanded = true;
							import("./api.js").then(m => m.fetchArchivedSessions());
						} else {
							state.archivedSectionExpanded = false;
						}
						renderApp();
					}}
					title="${state.showArchived ? "Hide archived sessions" : "Show archived sessions"}"
				>
					${icon(Archive, "sm")}
					<span>See Archived</span>
				</button>
				<span class="flex-1"></span>
				<button
					class="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
					@click=${toggleSidebar}
					title="Collapse sidebar (Ctrl+[)"
				>
					${icon(PanelLeftClose, "sm")}
				</button>
			</div>
		</div>
	`;
}

// ============================================================================
// COLLAPSED SIDEBAR
// ============================================================================

function renderCollapsedSidebar(sortedGoals: Goal[], ungroupedSessions: GatewaySession[]) {
	const allSessions = state.gatewaySessions;
	const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
	const ungrouped = allSessions.filter((s) => !s.goalId && !s.teamGoalId && !s.delegateOf && !staffSessionIds.has(s.id)).sort((a, b) => a.createdAt - b.createdAt);

	const renderCollapsedSession = (s: GatewaySession) => {
		const active = activeSessionId() === s.id;
		const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : s.title;
		return html`
			<button
				class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, s, displayTitle)}
				@mouseleave=${hideSessionTooltip}
				@click=${() => { if (!active) connectToSession(s.id, true); }}
				title=${displayTitle}
			>
				${statusBobbit(s.status, s.isCompacting, s.id, active, s.isAborting, s.role === "team-lead", s.role === "coder", s.accessory)}
				<span class="text-[8px] font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(displayTitle)}</span>
			</button>
		`;
	};

	const renderCollapsedGoalSessions = (goalSessions: GatewaySession[], goal: Goal) => {
		const isTeam = !!(goal as any).team;
		const teamLead = isTeam ? goalSessions.find(s => s.role === "team-lead") : null;
		if (!teamLead) return goalSessions.map(s => renderCollapsedSession(s));

		const children = goalSessions.filter(s => s.id !== teamLead.id);
		const tlExpanded = isTeamLeadExpanded(teamLead.id);
		const tlActive = activeSessionId() === teamLead.id;
		const tlTitle = tlActive && state.remoteAgent ? state.remoteAgent.title : teamLead.title;

		return html`
			<button
				class="flex items-center gap-0.5 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${tlActive ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, teamLead, tlTitle)}
				@mouseleave=${hideSessionTooltip}
				@click=${() => { if (!tlActive) connectToSession(teamLead.id, true); }}
				title=${tlTitle}
			>
				<span class="text-[9px] text-muted-foreground shrink-0 select-none" style="width:8px;text-align:center;cursor:pointer;"
					@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(teamLead.id); renderApp(); }}
				>${children.length > 0 ? (tlExpanded ? "▾" : "▸") : ""}</span>
				${statusBobbit(teamLead.status, teamLead.isCompacting, teamLead.id, tlActive, teamLead.isAborting, true, false, teamLead.accessory)}
				<span class="text-[8px] font-bold tracking-wide ${tlActive ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(tlTitle)}</span>
			</button>
			${tlExpanded ? children.map(s => html`<div style="padding-left:6px;">${renderCollapsedSession(s)}</div>`) : ""}
		`;
	};

	return html`
		<div class="w-14 shrink-0 h-full flex flex-col items-center sidebar-edge" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
				${sortedGoals.map((goal, i) => {
					const goalSessions = allSessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf).sort((a, b) => a.createdAt - b.createdAt);
					const expanded = expandedGoals.has(goal.id);
					return html`
						${i > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						<button
							class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
							title=${goal.title}
							@click=${(e: Event) => { e.stopPropagation(); if (expandedGoals.has(goal.id)) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}
						>
							<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;">${expanded ? "▾" : "▸"}</span>
							<span class="text-[10px] font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(goal.title)}</span>
						</button>
						${expanded ? renderCollapsedGoalSessions(goalSessions, goal) : ""}
					`;
				})}
				${sortedGoals.length > 0 ? html`
					<div class="w-7 border-t border-border/50 my-1.5"></div>
					<button
						class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
						title="Ungrouped sessions"
						@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}
					>
						<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;">${ungroupedExpanded ? "▾" : "▸"}</span>
						<span class="text-[10px] font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1;">SES</span>
					</button>
					${ungroupedExpanded ? ungrouped.map(renderCollapsedSession) : ""}
				` : ungrouped.map(renderCollapsedSession)}
				<div class="w-7 border-t border-border/50 my-1.5"></div>
				${state.staffList.filter(s => s.state !== "retired").map((agent) => {
					const session = agent.currentSessionId ? state.gatewaySessions.find(s => s.id === agent.currentSessionId) : undefined;
					const active = activeSessionId() === agent.currentSessionId;
					const sessionStatus = session?.status || "terminated";
					const isCompacting = session?.isCompacting || false;
					const isAborting = session?.isAborting || false;
					const accessory = session?.accessory;
					return html`
						<button
							class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
							title=${agent.name}
							@click=${() => handleStaffClick(agent)}
						>
							${statusBobbit(sessionStatus, isCompacting, agent.currentSessionId, active, isAborting, false, false, accessory)}
							<span class="text-[8px] font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(agent.name)}</span>
						</button>
					`;
				})}
			</div>
			<button
				class="p-2 mb-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
				@click=${toggleSidebar}
				title="Expand sidebar (Ctrl+[)"
			>
				${icon(PanelLeftOpen, "sm")}
			</button>
		</div>
	`;
}
