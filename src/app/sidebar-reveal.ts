// ============================================================================
// SIDEBAR REVEAL
//
// Route-driven reveals persistently force-expand only the resolved target path,
// overriding explicit collapses without disturbing unrelated tree state. The
// desktop target control reuses the same resolver/rAF pipeline in explicit mode:
// it also resets only the active view, restores the active keyboard row, scrolls
// smoothly, and replays a one-shot emphasis.
// ============================================================================

import { renderApp, state, activeSessionId, type GatewaySession, type Goal } from "./state.js";
import { getRouteFromHash, type AppRoute } from "./routing.js";
import {
	buildSidebarStatusSections,
	buildSidebarTreeModel,
	handleSidebarSearchClear,
	materializeExplicitSidebarSessionDepth,
} from "./sidebar.js";
import { expandSidebarTreeNode } from "./sidebar-tree-state.js";
import { sidebarTreeKey, type SidebarTreeNodeKey } from "./sidebar-tree-builder.js";
import {
	archivedGoalsLoaded,
	archivedSessionsLoaded,
	fetchArchivedGoalsPaginated,
	fetchArchivedSessions,
	gatewayFetch,
} from "./api.js";
import {
	resetSidebarViewFilters,
	setSidebarStatusSectionExpanded,
	type SidebarSessionView,
	type SidebarStatusSectionKey,
} from "./sidebar-view-preferences.js";

const MAX_ATTEMPTS = 30;
const EMPHASIS_DURATION_MS = 680;
const REDUCED_EMPHASIS_DURATION_MS = 240;

type SidebarTreeModel = ReturnType<typeof buildSidebarTreeModel>;
type AncestorResolver = (model: SidebarTreeModel) => SidebarTreeNodeKey[] | null;

interface PendingReveal {
	navId: string;
	resolvers: AncestorResolver[];
	mode?: "automatic" | "explicit";
	sessionId?: string;
	view?: SidebarSessionView;
}

let pending: PendingReveal | null = null;
let revealToken = 0;
const activeEmphasisCleanups = new WeakMap<HTMLElement, () => void>();
let activeEmphasisCleanup: (() => void) | null = null;

function nextFrame(cb: () => void): void {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
	else setTimeout(cb, 16);
}

function ancestorsOf(model: SidebarTreeModel, startKey: string): SidebarTreeNodeKey[] | null {
	const node = model.flatByKey.get(startKey);
	if (!node) return null;
	const out: SidebarTreeNodeKey[] = [];
	const seen = new Set<string>();
	let pk = node.parentKey;
	while (pk && !seen.has(pk)) {
		seen.add(pk);
		const parent = model.flatByKey.get(pk);
		if (!parent) break;
		out.push(parent.nodeKey);
		pk = parent.parentKey;
	}
	return out;
}

function targetForSession(sessionId: string): PendingReveal {
	return {
		navId: `session:${sessionId}`,
		resolvers: [
			(model) => ancestorsOf(model, sidebarTreeKey({ kind: "session", sessionId })),
			(model) => ancestorsOf(model, sidebarTreeKey({ kind: "team-lead", sessionId })),
			() => resolveStaffAncestors(sessionId),
		],
	};
}

function targetForRoute(route: AppRoute): PendingReveal | null {
	if ((route.view === "goal" || route.view === "goal-dashboard") && route.goalId) {
		const goalId = route.goalId;
		return {
			navId: `goal:${goalId}`,
			resolvers: [(model) => ancestorsOf(model, sidebarTreeKey({ kind: "goal", goalId }))],
		};
	}
	if (route.view === "session" && route.sessionId) return targetForSession(route.sessionId);
	return null;
}

function resolveStaffAncestors(sessionId: string): SidebarTreeNodeKey[] | null {
	const staff = state.staffList.find((item) => item.currentSessionId === sessionId);
	if (!staff || !staff.projectId) return null;
	return [
		{ kind: "project", projectId: staff.projectId },
		{ kind: "project-staff", projectId: staff.projectId },
	];
}

/** Automatic route reveal persistently force-expands only the resolved target path. */
export function revealSidebarTargetForRoute(route: AppRoute = getRouteFromHash()): void {
	const target = targetForRoute(route);
	const token = ++revealToken;
	if (!target) {
		pending = null;
		return;
	}
	pending = target;
	attemptReveal(token, 0);
}

function isTerminalOrArchived(session: GatewaySession | undefined): boolean {
	return Boolean(session && (session.archived === true || session.status === "archived" || session.status === "terminated"));
}

function mergeSessionIntoCanonicalCache(session: GatewaySession): void {
	const terminal = isTerminalOrArchived(session);
	const target = terminal ? state.archivedSessions : state.gatewaySessions;
	const other = terminal ? state.gatewaySessions : state.archivedSessions;
	const index = target.findIndex(item => item.id === session.id);
	if (index >= 0) target[index] = { ...target[index], ...session };
	else target.push(session);
	const duplicate = other.findIndex(item => item.id === session.id);
	if (duplicate >= 0) other.splice(duplicate, 1);
}

function mergeGoalIntoCanonicalCache(goal: Goal): void {
	const index = state.goals.findIndex(item => item.id === goal.id);
	if (index >= 0) state.goals[index] = { ...state.goals[index], ...goal };
	else state.goals.push(goal);
}

function explicitRevealIsCurrent(token: number, sessionId: string, view: SidebarSessionView): boolean {
	return token === revealToken && activeSessionId() === sessionId && state.sidebarSessionView === view;
}

async function fetchExactSession(sessionId: string): Promise<GatewaySession | null> {
	try {
		const response = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
		if (!response.ok) return null;
		const value = await response.json().catch(() => null) as GatewaySession | null;
		return value?.id === sessionId ? value : null;
	} catch {
		return null;
	}
}

async function fetchExactGoal(goalId: string): Promise<Goal | null> {
	try {
		const response = await gatewayFetch(`/api/goals/${encodeURIComponent(goalId)}`);
		if (!response.ok) return null;
		const value = await response.json().catch(() => null) as Goal | null;
		return value?.id === goalId ? value : null;
	} catch {
		return null;
	}
}

/** Hydrate cold terminal/archive placement without introducing another cache owner. */
async function hydrateExplicitTarget(token: number, sessionId: string, view: SidebarSessionView): Promise<boolean> {
	let session = state.gatewaySessions.find(item => item.id === sessionId)
		?? state.archivedSessions.find(item => item.id === sessionId);
	let fetched: GatewaySession | null = null;
	if (!session || isTerminalOrArchived(session)) fetched = await fetchExactSession(sessionId);
	if (!explicitRevealIsCurrent(token, sessionId, view)) return false;
	if (fetched) session = fetched;
	if (!session) return false;

	if (isTerminalOrArchived(session)) {
		await Promise.all([
			archivedSessionsLoaded() ? Promise.resolve() : fetchArchivedSessions(),
			archivedGoalsLoaded() ? Promise.resolve() : fetchArchivedGoalsPaginated(),
		]);
		if (!explicitRevealIsCurrent(token, sessionId, view)) return false;
	}
	// Normalize the known target too: its exact endpoint may be temporarily
	// unavailable even though the route's canonical cache still has placement.
	mergeSessionIntoCanonicalCache(session);

	// Walk only placement references. Missing parents/leads and goal ancestors
	// are hydrated by their exact endpoints, then merged into the same caches.
	const seenSessions = new Set<string>();
	const seenGoals = new Set<string>();
	const sessionQueue = [sessionId];
	const goalQueue: string[] = [];
	while (sessionQueue.length > 0 || goalQueue.length > 0) {
		while (sessionQueue.length > 0) {
			const relatedId = sessionQueue.pop()!;
			if (seenSessions.has(relatedId)) continue;
			seenSessions.add(relatedId);
			let related = state.gatewaySessions.find(item => item.id === relatedId)
				?? state.archivedSessions.find(item => item.id === relatedId);
			if (!related) {
				related = await fetchExactSession(relatedId) ?? undefined;
				if (!explicitRevealIsCurrent(token, sessionId, view)) return false;
				if (!related) continue;
				mergeSessionIntoCanonicalCache(related);
			} else if (isTerminalOrArchived(related)) {
				// This queue walks stable ids rather than either cache array, so moving a
				// terminal relationship record between caches cannot invalidate traversal.
				mergeSessionIntoCanonicalCache(related);
			}
			for (const parentId of [related.parentSessionId, related.delegateOf, related.teamLeadSessionId]) {
				if (parentId && !seenSessions.has(parentId)) sessionQueue.push(parentId);
			}
			for (const relatedGoalId of [related.goalId, related.teamGoalId]) {
				if (relatedGoalId && !seenGoals.has(relatedGoalId)) goalQueue.push(relatedGoalId);
			}
		}
		while (goalQueue.length > 0) {
			const relatedGoalId = goalQueue.pop()!;
			if (seenGoals.has(relatedGoalId)) continue;
			seenGoals.add(relatedGoalId);
			let goal = state.goals.find(item => item.id === relatedGoalId);
			if (!goal) {
				goal = await fetchExactGoal(relatedGoalId) ?? undefined;
				if (!explicitRevealIsCurrent(token, sessionId, view)) return false;
				if (!goal) continue;
				mergeGoalIntoCanonicalCache(goal);
			}
			if (goal.parentGoalId && !seenGoals.has(goal.parentGoalId)) goalQueue.push(goal.parentGoalId);
			if (goal.spawnedBySessionId && !seenSessions.has(goal.spawnedBySessionId)) sessionQueue.push(goal.spawnedBySessionId);
		}
	}
	return explicitRevealIsCurrent(token, sessionId, view);
}

function statusSectionForSession(sessionId: string): SidebarStatusSectionKey | null {
	const sections = buildSidebarStatusSections();
	if (sections.pinned.some(candidate => candidate.session.id === sessionId)) return "pinned";
	if (sections.unread.some(candidate => candidate.session.id === sessionId)) return "unread";
	if (sections.read.some(candidate => candidate.session.id === sessionId)) return "read";
	return null;
}

/** Explicit desktop-control transaction for the currently open session. */
export async function revealCurrentSidebarSession(): Promise<void> {
	const sessionId = activeSessionId();
	if (!sessionId) return;
	const view = state.sidebarSessionView;
	const token = ++revealToken;
	pending = null;

	handleSidebarSearchClear(false);
	resetSidebarViewFilters(state, view);
	// Install the categorical exception only after the reset setters have
	// cleared any prior action, and before this transaction's first render.
	state.sidebarRevealSessionId = sessionId;
	state.keyboardNavActiveId = `session:${sessionId}`;
	renderApp();

	if (!await hydrateExplicitTarget(token, sessionId, view)) {
		if (state.sidebarRevealSessionId === sessionId && explicitRevealIsCurrent(token, sessionId, view)) {
			state.sidebarRevealSessionId = null;
			renderApp();
		}
		return;
	}
	materializeExplicitSidebarSessionDepth(sessionId);
	const target: PendingReveal = { ...targetForSession(sessionId), mode: "explicit", sessionId, view };
	pending = target;

	if (view === "status") {
		const section = statusSectionForSession(sessionId);
		if (!section || !explicitRevealIsCurrent(token, sessionId, view)) return;
		setSidebarStatusSectionExpanded(state, section, true);
		renderApp();
		attemptScroll(target.navId, token, 0);
		return;
	}
	attemptReveal(token, 0);
}

function pendingIsCurrent(token: number, current: PendingReveal): boolean {
	if (token !== revealToken) return false;
	if (current.mode !== "explicit") return true;
	return Boolean(current.sessionId && current.view && explicitRevealIsCurrent(token, current.sessionId, current.view));
}

function attemptReveal(token: number, attempt: number): void {
	if (token !== revealToken || !pending) return;
	const current = pending;
	if (!pendingIsCurrent(token, current)) return;
	const model = buildSidebarTreeModel();
	let ancestors: SidebarTreeNodeKey[] | null = null;
	for (const resolve of current.resolvers) {
		ancestors = resolve(model);
		if (ancestors) break;
	}
	if (!ancestors) {
		if (attempt < MAX_ATTEMPTS) nextFrame(() => attemptReveal(token, attempt + 1));
		return;
	}
	// Both route navigation and the desktop control are explicit reveal intent:
	// force-expand and persist only the resolved path, including nodes the user
	// previously collapsed. The ancestor resolver keeps unrelated state intact.
	for (const key of ancestors) {
		expandSidebarTreeNode(key, { explicit: true });
	}
	renderApp();
	attemptScroll(current.navId, token, 0);
}

function reducedMotionPreferred(): boolean {
	return typeof window !== "undefined"
		&& typeof window.matchMedia === "function"
		&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function replayEmphasis(row: HTMLElement, reducedMotion: boolean): void {
	activeEmphasisCleanup?.();
	row.classList.remove("sidebar-reveal-emphasis", "sidebar-reveal-emphasis--reduced");
	void row.offsetWidth;
	row.classList.add("sidebar-reveal-emphasis");
	if (reducedMotion) row.classList.add("sidebar-reveal-emphasis--reduced");

	const cleanup = () => {
		row.removeEventListener("animationend", onAnimationEnd);
		if (activeEmphasisCleanups.get(row) === cleanup) {
			activeEmphasisCleanups.delete(row);
			row.classList.remove("sidebar-reveal-emphasis", "sidebar-reveal-emphasis--reduced");
		}
		if (activeEmphasisCleanup === cleanup) activeEmphasisCleanup = null;
	};
	const onAnimationEnd = (event: AnimationEvent) => {
		if (event.target === row) cleanup();
	};
	activeEmphasisCleanups.set(row, cleanup);
	activeEmphasisCleanup = cleanup;
	row.addEventListener("animationend", onAnimationEnd);
	setTimeout(cleanup, reducedMotion ? REDUCED_EMPHASIS_DURATION_MS : EMPHASIS_DURATION_MS + 80);
}

function attemptScroll(navId: string, token: number, attempt: number): void {
	if (token !== revealToken) return;
	const current = pending;
	if (current?.navId === navId && !pendingIsCurrent(token, current)) return;
	const row = navRowForId(navId);
	if (row) {
		if (current?.mode === "explicit") {
			const reducedMotion = reducedMotionPreferred();
			row.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
			replayEmphasis(row, reducedMotion);
		} else {
			row.scrollIntoView({ block: "nearest" });
		}
		if (pending && pending.navId === navId) pending = null;
		return;
	}
	if (attempt < MAX_ATTEMPTS) nextFrame(() => attemptScroll(navId, token, attempt + 1));
}

function navRowForId(navId: string): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const sidebar = document.querySelector(".sidebar-edge");
	if (!sidebar) return null;
	for (const element of sidebar.querySelectorAll<HTMLElement>("[data-nav-id]")) {
		if (element.getAttribute("data-nav-id") === navId) return element;
	}
	return null;
}
