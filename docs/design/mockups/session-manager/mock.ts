import "../../../../src/app/app.css";
import "./mock.css";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "../../../../src/ui/components/SearchBox.js";
import "../../../../src/ui/components/SidebarActionsPopover.js";

import { html, nothing, render, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import {
	Archive,
	Bell,
	Bot,
	Check,
	Circle,
	CircleDot,
	Copy,
	Ellipsis,
	ExternalLink,
	Eye,
	FileText,
	Filter,
	FolderGit2,
	FolderTree,
	GitFork,
	Goal as GoalIcon,
	Inbox,
	List,
	ListFilter,
	Link,
	Menu,
	MessageCircleQuestion,
	MessagesSquare,
	PanelLeftClose,
	Pencil,
	Pin,
	PinOff,
	Plus,
	QrCode,
	RotateCcw,
	Settings,
	Store,
	Tags,
	Trash2,
	Users,
	Workflow,
	Wrench,
	Zap,
} from "lucide";
import {
	BOBBIT_HUE_ROTATIONS,
	getAccessoryDef,
	renderSidebarBobbitCanvas,
} from "../../../../src/ui/bobbit-render.js";
import type {
	SidebarActionsPopover,
	SidebarActionsPopoverItem,
} from "../../../../src/ui/components/SidebarActionsPopover.js";
import bobbitIconUrl from "../../../../public/favicon.svg?url";

type SidebarMode = "project" | "activity";

type MockSession = {
	id: string;
	title: string;
	status: "idle" | "busy" | "streaming" | "preparing" | "archived";
	lastActivity: number;
	createdAt: number;
	colorIndex: number;
	accessory?: string;
	goalId?: string;
	projectId: string;
	role?: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
	archived?: boolean;
	server_tags: string[];
	user_tags: string[];
};

type ViewFilters = {
	showArchived: boolean;
	showBusy: boolean;
	showRead: boolean;
	showTeams?: boolean;
};

type MockGoal = {
	id: string;
	title: string;
	projectId: string;
	expanded: boolean;
	state: "todo" | "in-progress" | "complete";
	sessionIds: string[];
	gateProgress?: string;
};

type MockProject = {
	id: string;
	name: string;
	accent: string;
	expanded: boolean;
	goalIds: string[];
};

const now = Date.now();
const minutes = (value: number) => now - value * 60_000;
const hours = (value: number) => now - value * 3_600_000;

let sessions: MockSession[] = [
	{
		id: "session-sidebar-mocks",
		title: "Secondary sidebar session manager",
		status: "idle",
		lastActivity: minutes(1),
		createdAt: hours(5),
		colorIndex: 2,
		accessory: "palette",
		goalId: "goal-sidebar-discovery",
		projectId: "headquarters",
		role: "team-lead",
		teamGoalId: "goal-sidebar-discovery",
		server_tags: ["read-state=unread", "awaiting-response=true", "project-id=headquarters", "goal-id=goal-sidebar-discovery"],
		user_tags: ["pinned=true", "type=frontend"],
	},
	{
		id: "session-review-sorting",
		title: "Review session sorting rules",
		status: "busy",
		lastActivity: minutes(3),
		createdAt: hours(4),
		colorIndex: 5,
		accessory: "magnifier",
		goalId: "goal-sidebar-discovery",
		projectId: "headquarters",
		role: "reviewer",
		teamGoalId: "goal-sidebar-discovery",
		teamLeadSessionId: "session-sidebar-mocks",
		server_tags: ["read-state=unread", "awaiting-response=false", "project-id=headquarters", "goal-id=goal-sidebar-discovery"],
		user_tags: ["research=true"],
	},
	{
		id: "session-preview-reconnect",
		title: "Preview reconnect issue",
		status: "idle",
		lastActivity: minutes(8),
		createdAt: hours(8),
		colorIndex: 1,
		accessory: "headset",
		projectId: "headquarters",
		server_tags: ["read-state=unread", "awaiting-response=true", "project-id=headquarters"],
		user_tags: ["pinned=true", "type=frontend"],
	},
	{
		id: "session-provider-auth",
		title: "Provider authentication research",
		status: "idle",
		lastActivity: minutes(18),
		createdAt: hours(12),
		colorIndex: 7,
		accessory: "flask",
		goalId: "goal-provider-setup",
		projectId: "headquarters",
		server_tags: ["read-state=unread", "awaiting-response=false", "project-id=headquarters", "goal-id=goal-provider-setup"],
		user_tags: ["research=true"],
	},
	{
		id: "session-landing-copy",
		title: "Landing page copy polish",
		status: "idle",
		lastActivity: minutes(42),
		createdAt: hours(18),
		colorIndex: 4,
		accessory: "pencil",
		goalId: "goal-website-refresh",
		projectId: "website",
		server_tags: ["read-state=read", "awaiting-response=false", "project-id=website", "goal-id=goal-website-refresh"],
		user_tags: ["pinned=true", "type=frontend"],
	},
	{
		id: "session-release",
		title: "Release 0.17.0",
		status: "streaming",
		lastActivity: minutes(2),
		createdAt: hours(20),
		colorIndex: 10,
		accessory: "crown",
		projectId: "headquarters",
		server_tags: ["read-state=read", "awaiting-response=false", "project-id=headquarters"],
		user_tags: ["release=true"],
	},
	{
		id: "session-pricing-qa",
		title: "Pricing page QA",
		status: "idle",
		lastActivity: hours(3),
		createdAt: hours(28),
		colorIndex: 8,
		accessory: "clipboard",
		projectId: "website",
		server_tags: ["read-state=read", "awaiting-response=false", "project-id=website"],
		user_tags: ["type=frontend"],
	},
	{
		id: "session-api-reference",
		title: "API reference cleanup",
		status: "idle",
		lastActivity: hours(7),
		createdAt: hours(36),
		colorIndex: 11,
		accessory: "set-square",
		projectId: "docs",
		server_tags: ["read-state=read", "awaiting-response=false", "project-id=docs"],
		user_tags: [],
	},
	{
		id: "session-old-docs-audit",
		title: "Old documentation audit",
		status: "archived",
		lastActivity: hours(26),
		createdAt: hours(72),
		colorIndex: 6,
		accessory: "clipboard",
		projectId: "docs",
		archived: true,
		server_tags: ["read-state=read", "awaiting-response=false", "project-id=docs", "archived=true"],
		user_tags: [],
	},
];

const goals: MockGoal[] = [
	{
		id: "goal-sidebar-discovery",
		title: "Sidebar session discovery",
		projectId: "headquarters",
		expanded: true,
		state: "in-progress",
		sessionIds: ["session-sidebar-mocks", "session-review-sorting"],
		gateProgress: "2/4",
	},
	{
		id: "goal-provider-setup",
		title: "Improve provider setup",
		projectId: "headquarters",
		expanded: false,
		state: "in-progress",
		sessionIds: ["session-provider-auth"],
		gateProgress: "1/3",
	},
	{
		id: "goal-website-refresh",
		title: "Website refresh",
		projectId: "website",
		expanded: true,
		state: "in-progress",
		sessionIds: ["session-landing-copy"],
	},
];

const projects: MockProject[] = [
	{
		id: "headquarters",
		name: "Headquarters",
		accent: "color-mix(in oklch, var(--foreground) 75%, var(--muted-foreground))",
		expanded: true,
		goalIds: ["goal-sidebar-discovery", "goal-provider-setup"],
	},
	{
		id: "website",
		name: "Website",
		accent: "var(--chart-4)",
		expanded: true,
		goalIds: ["goal-website-refresh"],
	},
	{
		id: "docs",
		name: "Docs",
		accent: "var(--chart-2)",
		expanded: true,
		goalIds: [],
	},
];

const state = {
	mode: "activity" as SidebarMode,
	selectedSessionId: "session-sidebar-mocks",
	query: "",
	filters: {
		project: { showArchived: false, showBusy: true, showRead: true },
		activity: { showArchived: false, showBusy: true, showRead: true, showTeams: false },
	} satisfies Record<SidebarMode, ViewFilters>,
	filterOpen: false,
	toast: "",
	dialog: null as null | { kind: "rename"; sessionId: string; value: string },
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function getTag(tags: string[], key: string): string | undefined {
	const prefix = `${key}=`;
	return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function setTag(tags: string[], key: string, value: string | null): string[] {
	const prefix = `${key}=`;
	const next = tags.filter((tag) => !tag.startsWith(prefix));
	if (value !== null) next.push(`${key}=${value}`);
	return next;
}

function isUnread(session: MockSession): boolean {
	return getTag(session.server_tags, "read-state") === "unread";
}

function isAwaitingResponse(session: MockSession): boolean {
	return getTag(session.server_tags, "awaiting-response") === "true";
}

function isPinned(session: MockSession): boolean {
	return getTag(session.user_tags, "pinned") === "true";
}

function projectName(projectId: string): string {
	return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function terseRelativeTime(timestamp: number): string {
	const delta = Math.max(0, now - timestamp);
	if (delta < 90_000) return "now";
	const minutesAgo = Math.floor(delta / 60_000);
	if (minutesAgo < 60) return `${minutesAgo}m`;
	const hoursAgo = Math.floor(minutesAgo / 60);
	if (hoursAgo < 24) return `${hoursAgo}h`;
	return `${Math.floor(hoursAgo / 24)}d`;
}

function showToast(message: string): void {
	state.toast = message;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		state.toast = "";
		renderApp();
	}, 1800);
	renderApp();
}

function sessionBobbit(session: MockSession, selected: boolean): TemplateResult {
	return renderSidebarBobbitCanvas({
		status: session.status,
		isCompacting: false,
		hueRotate: BOBBIT_HUE_ROTATIONS[session.colorIndex % BOBBIT_HUE_ROTATIONS.length],
		isSelected: selected,
		isAborting: false,
		accessory: getAccessoryDef(session.accessory),
		noDesaturate: false,
		unread: !selected && isUnread(session),
		disableIdleBreathing: true,
	});
}

function menuItem(id: string, label: string, itemIcon: Parameters<typeof icon>[0], quick = false, tone?: "danger"): SidebarActionsPopoverItem {
	return { id, label, icon: icon(itemIcon, "sm"), quick, ...(tone ? { tone } : {}) };
}

function openSessionMenu(trigger: HTMLElement, session: MockSession): void {
	// Mirrors the real session action ordering. Pin/Unpin is the sole addition:
	// third item, after the existing Modify and Terminate actions.
	const items: SidebarActionsPopoverItem[] = [
		menuItem("rename", "Modify", Pencil, true),
		menuItem("terminate", "Terminate", Trash2, true, "danger"),
		menuItem(isPinned(session) ? "unpin" : "pin", isPinned(session) ? "Unpin session" : "Pin session", isPinned(session) ? PinOff : Pin),
		menuItem("refresh-agent", "Refresh agent", RotateCcw),
		menuItem("fork", "Fork", GitFork),
		menuItem("copy-link", "Copy link", Link),
		menuItem("view-system-prompt", "View System Prompt", FileText),
		menuItem("open-new-window", "Open in new window", ExternalLink),
	];
	openActionsMenu(trigger, items, (actionId) => runSessionAction(session.id, actionId));
}

function openGoalMenu(trigger: HTMLElement, goal: MockGoal): void {
	const items: SidebarActionsPopoverItem[] = [
		menuItem("dashboard", "Open dashboard", ExternalLink, true),
		menuItem("new-session", "New session", MessagesSquare, true),
		menuItem("rename-goal", "Rename goal", Pencil),
		menuItem("copy-goal", "Copy goal link", Copy),
		menuItem("archive-goal", "Archive goal", Archive, false, "danger"),
	];
	openActionsMenu(trigger, items, (actionId) => {
		if (actionId === "dashboard") showToast(`Opened dashboard for “${goal.title}”`);
		else if (actionId === "new-session") showToast(`Started a new session in “${goal.title}”`);
		else if (actionId === "copy-goal") showToast("Goal link copied");
		else if (actionId === "archive-goal") showToast(`Archived “${goal.title}”`);
		else showToast(`Goal action: ${actionId}`);
	});
}

function openActionsMenu(
	trigger: HTMLElement,
	items: SidebarActionsPopoverItem[],
	onSelect: (actionId: string) => void,
): void {
	document.querySelectorAll("sidebar-actions-popover").forEach((node) => node.remove());
	const popover = document.createElement("sidebar-actions-popover") as SidebarActionsPopover;
	popover.anchorEl = trigger;
	popover.items = items;
	popover.sourceRects = [];
	popover.addEventListener("sidebar-action-select", ((event: CustomEvent<{ actionId: string }>) => {
		onSelect(event.detail.actionId);
	}) as EventListener);
	popover.addEventListener("close", () => popover.remove(), { once: true });
	document.body.appendChild(popover);
	popover.open = true;
}

function runSessionAction(sessionId: string, actionId: string): void {
	const session = sessions.find((entry) => entry.id === sessionId);
	if (!session) return;
	if (actionId === "pin" || actionId === "unpin") {
		const pinned = actionId === "pin";
		session.user_tags = setTag(session.user_tags, "pinned", pinned ? "true" : null);
		showToast(pinned ? "Session pinned" : "Session unpinned");
		return;
	}
	if (actionId === "mark-read" || actionId === "mark-unread") {
		const unread = actionId === "mark-unread";
		session.server_tags = setTag(session.server_tags, "read-state", unread ? "unread" : "read");
		showToast(unread ? "Marked unread" : "Marked read");
		return;
	}
	if (actionId === "rename") {
		state.dialog = { kind: "rename", sessionId, value: session.title };
		renderApp();
		requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-rename-input]")?.select());
		return;
	}
	if (actionId === "terminate") {
		sessions = sessions.filter((entry) => entry.id !== sessionId);
		if (state.selectedSessionId === sessionId) state.selectedSessionId = sessions[0]?.id ?? "";
		showToast("Session terminated");
		return;
	}
	if (actionId === "refresh-agent") {
		showToast(`Refreshing agent for “${session.title}”`);
		return;
	}
	if (actionId === "fork") {
		showToast(`Forked “${session.title}”`);
		return;
	}
	if (actionId === "copy-link") {
		void navigator.clipboard?.writeText(`https://bobbit.local/session/${session.id}`).catch(() => undefined);
		showToast("Session link copied");
		return;
	}
	if (actionId === "view-system-prompt") {
		showToast("System Prompt opened");
		return;
	}
	if (actionId === "open-new-window") showToast("Session opened in a new window");
}

function selectSession(session: MockSession): void {
	state.selectedSessionId = session.id;
	if (isUnread(session)) session.server_tags = setTag(session.server_tags, "read-state", "read");
	state.filterOpen = false;
	renderApp();
}

function visibleForSearch(session: MockSession): boolean {
	const query = state.query.trim().toLowerCase();
	return !query || session.title.toLowerCase().includes(query) || projectName(session.projectId).toLowerCase().includes(query);
}

function currentFilters(): ViewFilters {
	return state.filters[state.mode];
}

function matchesFilters(session: MockSession): boolean {
	if (!visibleForSearch(session)) return false;
	// Match production: an active search bypasses sidebar visibility filters.
	if (state.query.trim()) return true;
	const filters = currentFilters();
	if (session.archived && !filters.showArchived) return false;
	if (state.mode === "activity" && !filters.showTeams && session.teamLeadSessionId) return false;
	if (session.id === state.selectedSessionId) return true;
	if (!filters.showBusy) {
		const busy = session.status === "streaming" || session.status === "preparing";
		if (busy) return false;
	}
	if (!filters.showRead) {
		const idleLike = session.status === "idle" || session.status === "archived";
		if (idleLike && !isUnread(session)) return false;
	}
	return true;
}

function anyFilterActive(): boolean {
	const filters = currentFilters();
	return filters.showArchived || !filters.showBusy || !filters.showRead
		|| (state.mode === "activity" && filters.showTeams === true);
}

function activitySessions(): MockSession[] {
	return sessions.filter(matchesFilters).sort((a, b) => b.lastActivity - a.lastActivity);
}

let activeDotIndex = 0;
function renderSessionTime(session: MockSession, selected: boolean): TemplateResult {
	const active = session.status === "busy" || session.status === "streaming";
	if (active) {
		const delay = (activeDotIndex++ % 5) * 1.8;
		return html`<span class="sidebar-active-dot" style="--dot-delay:${delay}s"></span>`;
	}
	return html`<span
		class="shrink-0 inline-flex items-center gap-0.5 tabular-nums ${selected ? "text-foreground/50" : isUnread(session) ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}"
		style="vertical-align:middle;font-size:.9167em;"
		title="Last activity"
	>${terseRelativeTime(session.lastActivity)}${isUnread(session) ? html`<span class="unseen-dot" aria-label="unread"></span>` : nothing}</span>`;
}

function renderSessionRow(session: MockSession): TemplateResult {
	const selected = state.selectedSessionId === session.id;
	return html`
		<div
			class="group relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer transition-colors ${selected ? "bg-secondary text-foreground sidebar-session-active sidebar-active-no-chevron" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:var(--sidebar-chevron-w);"
			data-session-id=${session.id}
			@click=${() => selectSession(session)}
		>
			<div class="shrink-0 flex items-center justify-center ${!selected && isUnread(session) ? "bobbit-unread-pulse" : ""}">
				${sessionBobbit(session, selected)}
			</div>
			<div class="flex-1 min-w-0 flex flex-col justify-center">
				<div class="flex items-center gap-1 min-w-0 font-normal">
					<span class="flex-1 min-w-0 truncate" data-testid="sidebar-session-title-text">${session.title}</span>
				</div>
			</div>
			<span class="group-hover:hidden group-focus-within:hidden absolute right-0 top-0 bottom-0 flex items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right,transparent 0%,var(--sidebar) 50%);">${renderSessionTime(session, selected)}</span>
			<div class="sidebar-actions sidebar-action-cluster absolute right-0 top-0 bottom-0 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right,transparent 0%,var(--sidebar) 50%);">
				<button
					class="p-0.5 rounded transition-colors hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
					title="Modify session. Edit the name, colour, and Role"
					aria-label="Modify"
					@click=${(event: Event) => { event.stopPropagation(); runSessionAction(session.id, "rename"); }}
				><span class="sidebar-scale-icon">${icon(Pencil, "xs")}</span></button>
				<button
					class="p-0.5 rounded transition-colors hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
					title="Terminate this session"
					aria-label="Terminate"
					@click=${(event: Event) => { event.stopPropagation(); runSessionAction(session.id, "terminate"); }}
				><span class="sidebar-scale-icon">${icon(Trash2, "xs")}</span></button>
				<button
					class="p-0.5 rounded transition-colors hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
					title="More actions"
					aria-label="Session actions"
					aria-haspopup="menu"
					@click=${(event: Event) => { event.stopPropagation(); openSessionMenu(event.currentTarget as HTMLElement, session); }}
				><span class="sidebar-scale-icon">${icon(Menu, "xs")}</span></button>
			</div>
		</div>
	`;
}

function renderGoalRow(goal: MockGoal): TemplateResult {
	const goalSessions = goal.sessionIds.map((id) => sessions.find((session) => session.id === id)).filter(Boolean) as MockSession[];
	const filteredGoalSessions = goalSessions.filter(matchesFilters);
	const matches = !state.query || goal.title.toLowerCase().includes(state.query.toLowerCase()) || filteredGoalSessions.length > 0;
	if (!matches) return html``;
	return html`
		<div class="flex flex-col">
			<div
				class="group relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/50 transition-colors"
				style="padding-left:var(--sidebar-header-chevron-w);"
				@click=${() => { goal.expanded = !goal.expanded; renderApp(); }}
			>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none"><span class="sidebar-chevron-glyph">${goal.expanded ? "▾" : "▸"}</span></span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(GoalIcon, "xs")}</span>
				<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="font-size:.8333em;">${goal.title}</span>
				${goal.gateProgress ? html`<span class="shrink-0 font-semibold text-muted-foreground" style="background:var(--secondary);padding:0 .3333em;border-radius:.5em;line-height:1.1667em;font-size:.75em;" title="Workflow gates passed">${goal.gateProgress}</span>` : nothing}
				<div class="sidebar-actions sidebar-action-cluster absolute right-0 top-0 bottom-0 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right,transparent 0%,var(--sidebar) 50%);">
					<button class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary" title="New session" @click=${(event: Event) => { event.stopPropagation(); showToast(`Started a new session in “${goal.title}”`); }}>${icon(Plus, "xs")}</button>
					<button class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary" title="Goal actions" @click=${(event: Event) => { event.stopPropagation(); openGoalMenu(event.currentTarget as HTMLElement, goal); }}>${icon(Menu, "xs")}</button>
				</div>
			</div>
			${goal.expanded ? html`<div class="flex flex-col gap-0.5" style="padding-inline-start:var(--sidebar-tree-base-indent,var(--sidebar-tree-base-indent-default));">${filteredGoalSessions.map(renderSessionRow)}</div>` : nothing}
		</div>
	`;
}

function renderProjectHeader(project: MockProject): TemplateResult {
	return html`
		<div
			class="group project-header relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/30 transition-colors"
			style="padding-left:var(--sidebar-header-chevron-w);"
			@click=${() => { project.expanded = !project.expanded; renderApp(); }}
		>
			<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none"><span class="sidebar-chevron-glyph">${project.expanded ? "▾" : "▸"}</span></span>
			<span class="project-reorder-slot"></span>
			<span class="shrink-0 inline-flex items-center" style="color:${project.accent};">${icon(project.id === "headquarters" ? Bot : FolderGit2, "xs")}</span>
			<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="color:${project.accent};font-size:.75em;">${project.name}</span>
			<button class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100" style="padding:0;line-height:0;" title="Project settings" @click=${(event: Event) => { event.stopPropagation(); showToast(`${project.name} settings`); }}>${icon(Settings, "xs")}</button>
			<button class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors relative shrink-0" style="padding:0 2px;line-height:0;" title="New goal" @click=${(event: Event) => { event.stopPropagation(); showToast(`New goal in ${project.name}`); }}>
				<span class="sidebar-compound-icon">${icon(GoalIcon, "xs", "sidebar-compound-base")}<svg class="sidebar-compound-plus" viewBox="0 0 10 10"><path d="M5 1V9M1 5H9" stroke=${project.accent} stroke-width="2.5" stroke-linecap="round"/></svg></span>
			</button>
		</div>
	`;
}

function renderBrowseMode(): TemplateResult {
	return html`
		<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 pt-0 pb-2 px-0.5">
			${projects.map((project, index) => {
				const projectGoals = project.goalIds.map((id) => goals.find((goal) => goal.id === id)).filter(Boolean) as MockGoal[];
				const ungrouped = sessions.filter((session) => session.projectId === project.id && !session.goalId && matchesFilters(session));
				return html`
					${index > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : nothing}
					<div>${renderProjectHeader(project)}${project.expanded ? html`
						<div class="flex flex-col gap-0.5" style="padding-inline-start:var(--sidebar-tree-base-indent,var(--sidebar-tree-base-indent-default));">
							${projectGoals.map(renderGoalRow)}
							<div class="border-t border-border/30 mx-2"></div>
							<div class="relative flex items-center gap-1 pr-1 py-0.5 rounded-md text-muted-foreground hover:bg-secondary/50" style="padding-left:var(--sidebar-header-chevron-w);">
								<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute"><span class="sidebar-chevron-glyph">▾</span></span>
								<span style="margin-left:-3px;">${icon(MessagesSquare, "xs")}</span>
								<span class="flex-1 uppercase tracking-wider font-medium" style="font-size:.8333em;">Sessions</span>
								<button class="p-0.5 rounded hover:bg-secondary" title="New session" @click=${() => showToast(`New session in ${project.name}`)}>${icon(Plus, "xs")}</button>
							</div>
							<div class="flex flex-col gap-0.5" style="padding-inline-start:var(--sidebar-tree-base-indent,var(--sidebar-tree-base-indent-default));">${ungrouped.map(renderSessionRow)}</div>
						</div>` : nothing}</div>
				`;
			})}
		</div>
	`;
}

function toggleViewFilter(key: keyof ViewFilters): void {
	const filters = currentFilters();
	filters[key] = !filters[key];
	renderApp();
}

function renderFilterToggle(
	key: keyof ViewFilters,
	label: string,
	itemIcon: Parameters<typeof icon>[0],
	shortcut = "",
): TemplateResult {
	const checked = Boolean(currentFilters()[key]);
	return html`
		<label class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-colors">
			<input
				type="checkbox"
				class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
				.checked=${checked}
				@change=${(event: Event) => { event.stopPropagation(); toggleViewFilter(key); }}
				@click=${(event: Event) => event.stopPropagation()}
			/>
			<span class="shrink-0 text-muted-foreground">${icon(itemIcon, "sm")}</span>
			<span class="flex-1 text-sm font-medium text-foreground">${label}</span>
			${shortcut ? html`<span class="text-xs text-muted-foreground/70 font-mono">${shortcut}</span>` : nothing}
		</label>
	`;
}

function renderFilterPopover(): TemplateResult | typeof nothing {
	if (!state.filterOpen) return nothing;
	return html`
		<div class="mock-filter-popover" role="dialog" aria-label="Sidebar filters" @click=${(event: Event) => event.stopPropagation()}>
			<div class="mock-filter-title">${state.mode === "project" ? "By Project" : "By Status"} filters</div>
			${renderFilterToggle("showArchived", "Show Archived", Archive, "Alt+Shift+A")}
			${renderFilterToggle("showBusy", "Show Busy", Zap, "Alt+Shift+B")}
			${renderFilterToggle("showRead", "Show Read", Eye, "Alt+Shift+R")}
			${state.mode === "activity" ? renderFilterToggle("showTeams", "Show teams", Users) : nothing}
		</div>
	`;
}

function renderActivityMode(): TemplateResult {
	const result = activitySessions();
	// Sections are mutually exclusive. A pinned unread session appears only in
	// Pinned; the remaining unread/read buckets preserve the same row renderer.
	const pinned = result.filter(isPinned);
	const unread = result.filter((session) => !isPinned(session) && isUnread(session));
	const read = result.filter((session) => !isPinned(session) && !isUnread(session));
	return html`
		<div class="relative flex-1 min-h-0 flex flex-col">
			<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 px-0.5 pb-2">
				${result.length === 0 ? html`<div class="mock-empty">No sessions match this search and filter.</div>` : html`
					${pinned.length ? html`<div class="mock-group-heading"><span>${icon(Pin, "xs")}</span><span>Pinned</span><span class="group-count">${pinned.length}</span></div>${pinned.map(renderSessionRow)}` : nothing}
					${unread.length ? html`<div class="mock-group-heading"><span>Unread</span><span class="group-count">${unread.length}</span></div>${unread.map(renderSessionRow)}` : nothing}
					${read.length ? html`<div class="mock-group-heading"><span>Read</span><span class="group-count">${read.length}</span></div>${read.map(renderSessionRow)}` : nothing}
				`}
			</div>
		</div>
	`;
}

function renderTopActions(): TemplateResult {
	const action = (label: string, itemIcon: Parameters<typeof icon>[0]) => html`
		<button class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors" title=${label} @click=${() => showToast(`${label} opened`)}>
			<span class="sidebar-scale-icon">${icon(itemIcon, "xs")}</span><span class="sidebar-top-action-label">${label}</span>
		</button>`;
	return html`
		<div class="flex flex-col border-b border-border/50 px-0.5 py-1 gap-0.5">
			<div class="sidebar-top-action-row">${action("Roles", Users)}${action("Tools", Wrench)}${action("Skills", Zap)}</div>
			<div class="sidebar-top-action-row">${action("Workflows", Workflow)}${action("Market", Store)}${action("New Goal", GoalIcon)}</div>
		</div>
	`;
}

function renderSidebar(): TemplateResult {
	return html`
		<div class="shrink-0 h-full flex flex-col sidebar-edge sidebar-root relative" style="background:var(--sidebar);width:var(--sidebar-w,318px);">
			<div class="sidebar-resize-handle" title="Drag to resize"></div>
			${renderTopActions()}
			<div class="flex flex-col gap-0 px-1 pt-1">
				<search-box
					.query=${state.query}
					.showControls=${Boolean(state.query)}
					@search-input=${(event: CustomEvent<{ query: string }>) => { state.query = event.detail.query; renderApp(); }}
					@search-clear=${() => { state.query = ""; renderApp(); }}
					@full-search-click=${() => showToast("Full search opened")}
				></search-box>
			</div>
			<div class="mock-view-controls">
				<div class="mock-session-mode-switch" aria-label="Session grouping">
					<button data-active=${state.mode === "project"} @click=${() => { state.mode = "project"; state.filterOpen = false; renderApp(); }}>${icon(FolderTree, "xs")} By Project</button>
					<button data-active=${state.mode === "activity"} @click=${() => { state.mode = "activity"; state.filterOpen = false; renderApp(); }}>${icon(ListFilter, "xs")} By Status</button>
				</div>
				<button class="mock-mode-filter" data-active=${state.filterOpen || anyFilterActive()} @click=${(event: Event) => { event.stopPropagation(); state.filterOpen = !state.filterOpen; renderApp(); }}>${icon(Filter, "xs")} Filters</button>
				${renderFilterPopover()}
			</div>
			${state.mode === "project" ? renderBrowseMode() : renderActivityMode()}
			<div class="sidebar-bottom-actions flex items-center border-t border-border/50">
				<button class="flex items-center px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors" title="Settings" @click=${() => showToast("Settings opened")}>${icon(Settings, "sm")}<span class="sidebar-bottom-action-text">Settings</span></button>
				<span class="flex-1"></span>
				<button class="flex items-center gap-1.5 px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50" title="Collapse sidebar">${icon(PanelLeftClose, "sm")}</button>
			</div>
		</div>
	`;
}

function selectedSession(): MockSession | undefined {
	return sessions.find((session) => session.id === state.selectedSessionId);
}

function renderMainArea(): TemplateResult {
	const session = selectedSession();
	if (!session) return html`<div class="flex-1 grid place-items-center text-muted-foreground">No session selected</div>`;
	return html`
		<div class="flex-1 min-w-0 min-h-0 flex flex-col mock-chat-area">
			<div class="flex-1 overflow-y-auto mock-chat-scroll px-5 py-6 flex flex-col items-center gap-6">
				<div class="mock-message mock-message-user">
					<div class="mock-message-role">${icon(Users, "xs")}</div>
					<div class="mock-message-body">Keep the production filters in By Project, and let By Status hide team members by default.</div>
				</div>
				<div class="mock-message">
					<div class="mock-message-role">${sessionBobbit(session, true)}</div>
					<div class="mock-message-body"><span class="author">Bobbit</span>Each view owns its filter state. Both include the production Archived, Busy, and Read toggles; <strong>By Status</strong> adds “Show teams”, off by default so only team leads appear. Search still bypasses visibility filters in either view.</div>
				</div>
				<div class="mock-message">
					<div class="mock-message-role">${icon(Tags, "xs")}</div>
					<div class="mock-message-body"><span class="author">Session model</span><code class="text-xs">server_tags</code> remain server-controlled. In v1, the only exposed <code class="text-xs">user_tags</code> mutation is Pin / Unpin.</div>
				</div>
			</div>
			<div class="px-4 pb-3">
				<div class="mock-composer p-3 flex flex-col gap-2">
					<textarea class="flex-1 w-full bg-transparent text-sm placeholder:text-muted-foreground" placeholder="Message Bobbit…"></textarea>
					<div class="flex items-center"><button class="p-1 text-muted-foreground hover:text-foreground" title="Attach">${icon(Plus, "sm")}</button><span class="flex-1"></span><button class="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium" @click=${() => showToast("Mock message sent")}>Send</button></div>
				</div>
			</div>
		</div>
	`;
}

function renderDialog(): TemplateResult | typeof nothing {
	if (!state.dialog) return nothing;
	const dialog = state.dialog;
	return html`
		<div class="mock-dialog-backdrop" @click=${() => { state.dialog = null; renderApp(); }}>
			<form class="mock-dialog" @click=${(event: Event) => event.stopPropagation()} @submit=${(event: Event) => {
				event.preventDefault();
				const session = sessions.find((entry) => entry.id === dialog.sessionId);
				if (session && dialog.value.trim()) session.title = dialog.value.trim();
				state.dialog = null;
				showToast("Session renamed");
			}}>
				<h2>Rename session</h2>
				<p>Give this session a clear, memorable title.</p>
				<input data-rename-input .value=${dialog.value} @input=${(event: Event) => { dialog.value = (event.target as HTMLInputElement).value; }} />
				<div class="flex justify-end gap-2 mt-4">
					<button type="button" class="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-secondary" @click=${() => { state.dialog = null; renderApp(); }}>Cancel</button>
					<button type="submit" class="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground">Rename</button>
				</div>
			</form>
		</div>
	`;
}

function renderApp(): void {
	const session = selectedSession();
	render(html`
		<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative">
			${state.toast ? html`<div class="mock-toast" role="status">${state.toast}</div>` : nothing}
			<div class="flex items-center border-b border-border shrink-0 header-shadow" data-testid="app-header-row">
				<div class="sidebar-header-shell shrink-0 flex items-center justify-between px-3 self-stretch" style="background:var(--sidebar);width:var(--sidebar-w,318px);">
					<div class="sidebar-header-brand flex items-center gap-2"><img src=${bobbitIconUrl} alt="" style="width:20px;height:18px;image-rendering:pixelated;"/><span class="text-base font-semibold text-foreground truncate">Bobbit</span></div>
					<div class="sidebar-header-actions" aria-label="Sidebar shortcuts">
						<button class="sidebar-header-icon-btn h-6 w-6 text-muted-foreground" title="Open support" @click=${() => showToast("Support session opened")}>${icon(MessageCircleQuestion, "xs")}</button>
						<button class="sidebar-header-icon-btn h-6 w-6 text-muted-foreground" title="Show QR code" @click=${() => showToast("QR code opened")}>${icon(QrCode, "xs")}</button>
						<button class="sidebar-header-icon-btn h-6 w-6 text-muted-foreground" title="Notifications" @click=${() => showToast("Notifications toggled")}>${icon(Bell, "xs")}</button>
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 min-w-0 flex items-center justify-between px-3 py-2">
					<div class="flex items-center min-w-0 gap-2">${session ? html`<span class="shrink-0">${sessionBobbit(session, true)}</span><span class="font-medium truncate">${session.title}</span>` : nothing}</div>
					<div class="flex items-center gap-1"><button class="h-7 px-2 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground" title="Session menu" @click=${(event: Event) => session && openSessionMenu(event.currentTarget as HTMLElement, session)}>${icon(Ellipsis, "sm")}</button></div>
				</div>
			</div>
			<div class="flex-1 flex min-h-0">${renderSidebar()}${renderMainArea()}</div>
			${renderDialog()}
		</div>
	`, document.getElementById("app")!);
}

document.addEventListener("click", (event) => {
	if (!state.filterOpen) return;
	const target = event.target as HTMLElement;
	if (target.closest(".mock-filter-popover") || target.closest(".mock-session-list-header")) return;
	state.filterOpen = false;
	renderApp();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && state.dialog) {
		state.dialog = null;
		renderApp();
	}
});

renderApp();
