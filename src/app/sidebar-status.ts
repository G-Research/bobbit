import { isSessionReadFilterable } from "../shared/session-tags.js";
import type { GatewaySession } from "./state.js";
import type {
	SessionContext,
	SidebarTreeModel,
	SidebarTreeNode,
	TeamLeadContext,
} from "./sidebar-tree-builder.js";
import type { SidebarViewFilters } from "./sidebar-view-preferences.js";

export interface StatusSession extends GatewaySession {
	server_tags?: string[];
	user_tags?: string[];
}

export interface StatusCandidate<TSession extends StatusSession = StatusSession> {
	session: TSession;
	/** Archived-safe presentation, including terminal records and archived child placement. */
	archived: boolean;
	staff: boolean;
}

export interface StatusStaffLike {
	currentSessionId?: string;
}

export interface SelectSidebarStatusSectionsInput<TSession extends StatusSession = StatusSession> {
	candidates: readonly StatusCandidate<TSession>[];
	filters: Readonly<SidebarViewFilters>;
	searchQuery?: string;
	activeSessionId?: string | null;
	isPinned: (session: TSession) => boolean;
	isUnread: (session: TSession) => boolean;
	isBusy: (session: TSession) => boolean;
	isTeamMember: (session: TSession) => boolean;
}

export interface SidebarStatusSections<TSession extends StatusSession = StatusSession> {
	pinned: StatusCandidate<TSession>[];
	unread: StatusCandidate<TSession>[];
	read: StatusCandidate<TSession>[];
}

function isArchivedCandidate(session: StatusSession, node?: SidebarTreeNode): boolean {
	if (session.archived === true || session.status === "terminated" || session.status === "archived") return true;
	if (node?.kind === "session") {
		return (node.context as SessionContext).childClass === "archived-delegate";
	}
	return false;
}

/**
 * Flatten the already-eligible tree population without consulting expansion.
 * The supplied staff synthesizer is the existing production adapter; injecting
 * it keeps this collection helper pure and avoids a second staff-row policy.
 */
export function collectEligibleStatusSessions<TSession extends StatusSession = StatusSession, TStaff extends StatusStaffLike = StatusStaffLike>(
	model: Pick<SidebarTreeModel, "flatByKey">,
	staff: readonly TStaff[],
	synthesizeStaffSession: (staff: TStaff) => TSession | null,
): StatusCandidate<TSession>[] {
	const byId = new Map<string, StatusCandidate<TSession>>();

	const add = (candidate: StatusCandidate<TSession>) => {
		const existing = byId.get(candidate.session.id);
		if (!existing || (existing.archived && !candidate.archived) || (candidate.staff && !existing.staff && existing.archived === candidate.archived)) {
			byId.set(candidate.session.id, candidate);
		}
	};

	for (const node of model.flatByKey.values()) {
		if (node.kind !== "session" && node.kind !== "team-lead") continue;
		const context = node.context as SessionContext | TeamLeadContext;
		const session = context.session as TSession;
		if (!session?.id) continue;
		add({ session, archived: isArchivedCandidate(session, node), staff: false });
	}

	for (const staffAgent of staff) {
		const session = synthesizeStaffSession(staffAgent);
		if (!session?.id) continue;
		add({ session, archived: isArchivedCandidate(session), staff: true });
	}

	return [...byId.values()];
}

function finiteTimestamp(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function compareStatusCandidatesNewestFirst<TSession extends StatusSession>(
	a: StatusCandidate<TSession>,
	b: StatusCandidate<TSession>,
): number {
	return finiteTimestamp(b.session.lastActivity) - finiteTimestamp(a.session.lastActivity)
		|| finiteTimestamp(b.session.createdAt) - finiteTimestamp(a.session.createdAt)
		|| a.session.id.localeCompare(b.session.id);
}

/** Apply categorical/visibility gates, classify exactly once, then sort each exclusive section. */
export function selectSidebarStatusSections<TSession extends StatusSession = StatusSession>(
	input: SelectSidebarStatusSectionsInput<TSession>,
): SidebarStatusSections<TSession> {
	const sections: SidebarStatusSections<TSession> = { pinned: [], unread: [], read: [] };
	const bypassFilters = Boolean(input.searchQuery?.trim());
	const seen = new Set<string>();

	for (const candidate of input.candidates) {
		const session = candidate.session;
		if (seen.has(session.id)) continue;
		seen.add(session.id);
		const active = session.id === input.activeSessionId;
		let busy = false;
		let unread: boolean | undefined;

		if (!bypassFilters) {
			// Filter order is normative: Archived, teams, Busy, Read.
			if (!input.filters.showArchived && candidate.archived) continue;
			if (!input.filters.showTeams && input.isTeamMember(session)) continue;
			busy = input.isBusy(session);
			if (!input.filters.showBusy && busy && !active) continue;
			unread = input.isUnread(session);
			if (!input.filters.showRead && !unread && isSessionReadFilterable(session) && !active) continue;
		}

		if (input.isPinned(session)) {
			sections.pinned.push(candidate);
			continue;
		}
		unread ??= input.isUnread(session);
		sections[unread ? "unread" : "read"].push(candidate);
	}

	sections.pinned.sort(compareStatusCandidatesNewestFirst);
	sections.unread.sort(compareStatusCandidatesNewestFirst);
	sections.read.sort(compareStatusCandidatesNewestFirst);
	return sections;
}
