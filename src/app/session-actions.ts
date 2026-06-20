import { icon } from "@mariozechner/mini-lit";
import { ExternalLink, FileText, GitFork, Link, Pencil, RotateCcw, Trash2, Zap } from "lucide";
import type { TemplateResult } from "lit";
import { copySidebarLink, refreshAgentSession, sessionPathDeepLink, type SidebarCopyLinkTitle } from "./api.js";
import { listLauncherEntrypoints, runLauncherEntrypoint, type LauncherDispatchResult, type SpawnLaunchTarget } from "./pack-entrypoints.js";
import { confirmAction, showRenameDialog } from "./dialogs-lazy.js";
import { setHashRoute } from "./routing.js";
import { shortcutHint } from "./shortcut-registry.js";
import { forkSession, terminateSession } from "./session-manager.js";
import type { GatewaySession } from "./state.js";

export type SessionActionId =
	| "modify"
	| "terminate"
	| "refresh-agent"
	| "fork"
	| "copy-link"
	| "view-system-prompt"
	| "open-new-window";

export interface SessionActionTrailingToggle {
	id: string;
	checked: boolean;
	ariaLabel: string;
	label?: string;
	onToggle: () => void;
}

export interface SessionActionDescriptor {
	id: SessionActionId | string;
	label: string;
	title?: string;
	icon: TemplateResult;
	priority: number;
	tone?: "default" | "danger";
	quick?: boolean;
	visible?: boolean;
	run: (event: Event) => void | Promise<void>;
	trailingToggle?: SessionActionTrailingToggle;
}

export interface BuildSessionActionsInput {
	session: GatewaySession;
	displayTitle: string;
	staffId?: string;
	staffName?: string;
	goalId?: string;
	copyLink?: (url: string, title: SidebarCopyLinkTitle) => Promise<void>;
	onRefreshStateChanged?: () => void;
}

const BUILTIN_PRIORITIES: Record<SessionActionId, number> = {
	"modify": 10,
	"terminate": 20,
	"refresh-agent": 30,
	"fork": 40,
	"copy-link": 50,
	"view-system-prompt": 60,
	"open-new-window": 70,
};

// Fork's "New worktree" choice is shared across surfaces. Reset to the default
// each time a session actions menu opens so the row and trailing toggle read
// from the same source of truth.
let _forkNewWorktree = true;

/** Session ids with an in-flight Refresh agent request. */
const _refreshingAgentSessionIds = new Set<string>();

export function resetSessionForkNewWorktree(): void {
	_forkNewWorktree = true;
}

export function isRefreshingAgentSession(sessionId: string): boolean {
	return _refreshingAgentSessionIds.has(sessionId);
}

export function canRefreshAgentSession(session: GatewaySession): boolean {
	return !session.archived
		&& !session.readOnly
		&& !session.nonInteractive
		&& session.status !== "terminated"
		&& session.status !== "archived";
}

export function canForkSession(session: GatewaySession): boolean {
	return session.status !== "terminated"
		&& !session.archived
		&& !session.readOnly
		&& !session.nonInteractive
		&& !isChildSession(session)
		// Mirror the server guard isUnsupportedForkSource() in src/server/server.ts:
		// among role-based sessions, only "team-lead" is non-forkable; "general" and
		// "assistant" are forkable. Keep client and server consistent.
		&& session.role !== "team-lead"
		&& !session.teamGoalId
		&& !session.teamLeadSessionId;
}

export function buildSessionActions(input: BuildSessionActionsInput): SessionActionDescriptor[] {
	const { session, displayTitle, goalId, onRefreshStateChanged } = input;
	const staffId = input.staffId ?? session.staffId;
	const isTeamLead = session.role === "team-lead";
	const copyLink = input.copyLink ?? defaultCopySidebarLink;
	const launcherActions = buildSessionMenuLauncherActions(onRefreshStateChanged);
	const actions: SessionActionDescriptor[] = [
		{
			id: "modify",
			label: staffId ? "Edit staff" : "Modify",
			title: staffId ? "Open this staff agent's settings" : isTeamLead ? "Rename this team lead session" : "Rename this session",
			icon: icon(Pencil, "xs"),
			priority: BUILTIN_PRIORITIES["modify"],
			quick: true,
			run: staffId
				? (event: Event) => {
					event.stopPropagation();
					setHashRoute("staff-edit", staffId);
				}
				: (event: Event) => {
					event.stopPropagation();
					showRenameDialog(session.id, displayTitle);
				},
		},
		{
			id: "terminate",
			label: isTeamLead ? "End team" : "Terminate",
			title: `${isTeamLead ? "Stop this team and its agents" : "Terminate this session"}${shortcutHint("terminate-session")}`,
			icon: icon(Trash2, "xs"),
			priority: BUILTIN_PRIORITIES["terminate"],
			tone: "danger",
			quick: true,
			run: (event: Event) => {
				event.stopPropagation();
				void (isTeamLead
					? terminateSession(session.id, { goalId: goalId || undefined, isTeamLead: true })
					: terminateSession(session.id));
			},
		},
		{
			id: "refresh-agent",
			label: isRefreshingAgentSession(session.id) ? "Refreshing agent…" : "Refresh agent",
			title: isRefreshingAgentSession(session.id) ? "Agent refresh is already running" : "Restart this agent with the latest prompt, tools, and auth state",
			icon: icon(RotateCcw, "xs"),
			priority: BUILTIN_PRIORITIES["refresh-agent"],
			quick: false,
			visible: canRefreshAgentSession(session),
			run: (event: Event) => {
				event.stopPropagation();
				void runRefreshAgentSession(session, onRefreshStateChanged);
			},
		},
		{
			id: "fork",
			label: "Fork",
			title: "Create a new session from this session's history",
			icon: icon(GitFork, "xs"),
			priority: BUILTIN_PRIORITIES["fork"],
			quick: false,
			visible: canForkSession(session),
			run: (event: Event) => {
				event.stopPropagation();
				void forkSession(session, { newWorktree: _forkNewWorktree });
			},
			trailingToggle: {
				id: "fork-new-worktree",
				checked: _forkNewWorktree,
				ariaLabel: _forkNewWorktree ? "New worktree (on) — fork into a fresh worktree" : "New worktree (off) — reuse the source worktree",
				label: "New worktree",
				onToggle: () => {
					_forkNewWorktree = !_forkNewWorktree;
					onRefreshStateChanged?.();
				},
			},
		},
		{
			id: "copy-link",
			label: "Copy link",
			title: isTeamLead ? "Copy a link to this team lead session" : "Copy a link to this session",
			icon: icon(Link, "xs"),
			priority: BUILTIN_PRIORITIES["copy-link"],
			quick: false,
			run: (event: Event) => {
				event.stopPropagation();
				void copyLink(sessionPathDeepLink(session.id), "Copy session link");
			},
		},
		{
			id: "view-system-prompt",
			label: "View System Prompt",
			title: "View System Prompt",
			icon: icon(FileText, "xs"),
			priority: BUILTIN_PRIORITIES["view-system-prompt"],
			quick: false,
			run: (event: Event) => {
				event.stopPropagation();
				void import("../ui/dialogs/SystemPromptDialog.js").then(({ SystemPromptDialog }) => SystemPromptDialog.show(session.id));
			},
		},
		{
			id: "open-new-window",
			label: "Open in new window",
			title: isTeamLead ? "Open this team lead session in a new browser window" : "Open this session in a new browser window",
			icon: icon(ExternalLink, "xs"),
			priority: BUILTIN_PRIORITIES["open-new-window"],
			quick: false,
			run: (event: Event) => {
				event.stopPropagation();
				openSessionInNewWindow(session.id);
			},
		},
	];
	actions.push(...launcherActions);
	return actions
		.filter((action) => action.visible !== false)
		.sort((a, b) => a.priority - b.priority);
}

function isChildSession(session: GatewaySession): boolean {
	return !!(session.parentSessionId || session.delegateOf);
}

function buildSessionMenuLauncherActions(onRefreshStateChanged?: () => void): SessionActionDescriptor[] {
	let launchers: ReturnType<typeof listLauncherEntrypoints> = [];
	try {
		launchers = listLauncherEntrypoints("session-menu");
	} catch {
		return [];
	}
	return launchers.map((launcher, index) => {
		const isSpawn = isSpawnLaunchTarget(launcher.target);
		return {
			id: launcher.key,
			label: launcher.label,
			title: isSpawn ? `Start ${launcher.label}` : launcher.label,
			icon: icon(Zap, "xs"),
			priority: 80 + index,
			quick: false,
			run: (event: Event) => {
				event.preventDefault();
				event.stopPropagation();
				if (isSpawn) emitLauncherFeedback("pending", `Starting ${launcher.label}…`);
				try {
					runLauncherEntrypoint(launcher.key, (result) => {
						if (result.ok) return;
						emitLauncherFeedback("error", launcherFailureMessage(launcher.label, result));
						onRefreshStateChanged?.();
					});
				} catch (error) {
					emitLauncherFeedback("error", error instanceof Error ? error.message : `Could not run ${launcher.label}.`);
				}
			},
		} satisfies SessionActionDescriptor;
	});
}

function isSpawnLaunchTarget(target: unknown): target is SpawnLaunchTarget {
	return !!target
		&& (target as SpawnLaunchTarget).action === "spawn"
		&& typeof (target as SpawnLaunchTarget).route === "string"
		&& typeof (target as SpawnLaunchTarget).panelId === "string";
}

function launcherFailureMessage(label: string, result: LauncherDispatchResult): string {
	if (result.error) return result.error;
	if (result.code === "NO_PR") return "No pull request found for this branch.";
	return `Could not start ${label}.`;
}

function emitLauncherFeedback(kind: "pending" | "error", message: string): void {
	try {
		window.dispatchEvent(new CustomEvent("bobbit-launcher-feedback", { detail: { kind, message } }));
	} catch {
		// Non-DOM tests / SSR: feedback is best-effort.
	}
}

function refreshAgentNeedsConfirmation(session: GatewaySession): boolean {
	return session.status === "streaming" || session.status === "busy" || session.isCompacting === true;
}

async function runRefreshAgentSession(session: GatewaySession, onRefreshStateChanged?: () => void): Promise<void> {
	if (_refreshingAgentSessionIds.has(session.id)) return;
	const force = refreshAgentNeedsConfirmation(session);
	if (force) {
		const confirmed = await confirmAction(
			"Refresh agent",
			"This will interrupt the current agent process and restart it with the latest prompt, tools, MCP configuration, and auth state. Transcript and history remain intact.",
			"Refresh agent",
			false,
		);
		if (!confirmed) return;
	}
	_refreshingAgentSessionIds.add(session.id);
	onRefreshStateChanged?.();
	try {
		await refreshAgentSession(session.id, { force });
	} finally {
		_refreshingAgentSessionIds.delete(session.id);
		onRefreshStateChanged?.();
	}
}

async function defaultCopySidebarLink(url: string, title: SidebarCopyLinkTitle): Promise<void> {
	await copySidebarLink(url, title);
}

function openExternalUrl(url: string): void {
	const opened = window.open(url, "_blank", "noopener");
	try { if (opened) opened.opener = null; } catch { /* ignore */ }
}

export function openSessionInNewWindow(sessionId: string): void {
	openExternalUrl(sessionPathDeepLink(sessionId));
}
