// ============================================================================
// SIDEBAR REVEAL ON NAV
//
// Bridges *route navigation* to the sidebar tree: when the app navigates to a
// session or goal route — on initial deep-links AND in-app hash/route changes
// (clicks, keyboard-nav landings, browser back/forward) — this module
//   (1) expands every collapsed ancestor of the target row so it is rendered,
//   (2) scrolls the row into view with `scrollIntoView({ block: "nearest" })`.
//
// Expansion is *ephemeral*: it only ever calls
// `expandSidebarTreeNode(key, { explicit: false })`, which no-ops when the node
// already has a stored preference (so an explicit user *collapse* is never
// overwritten) and when the node's default is already expanded. Only ancestors
// on the path to the target are touched — unrelated collapsed nodes stay put.
//
// The keyboard-nav model (`state.keyboardNavActiveId`, `data-nav-active`,
// `getVisibleNavOrder`, the override-clear listener) is never mutated here — we
// only read the DOM and flip ephemeral expansion prefs. A monotonic
// `revealToken` guarantees a superseded navigation's in-flight rAF callbacks
// no-op, so exactly one reveal runs per navigation.
//
// A session route can point at THREE different sidebar row kinds, all of which
// carry `data-nav-id="session:<id>"` but resolve to different tree shapes:
//   1. a `session/<id>` tree node       — team members, delegates, verifiers…
//   2. a `team-lead/<id>` tree node      — team-lead sessions (no session node)
//   3. a staff row under `project-staff` — staff sessions (NO tree node at all;
//      excluded from the tree via `liveSessionsNoStaff`)
// Resolution is therefore an ordered set of *ancestor resolvers*: each takes the
// current tree model and returns the list of ancestor node-keys to expand
// ephemerally, or null when it cannot resolve the target. `attemptReveal` runs
// them in order and uses the first non-null result; if all return null it
// retries (data still loading) and eventually no-ops gracefully.
// ============================================================================

import { renderApp, state } from "./state.js";
import { getRouteFromHash, type AppRoute } from "./routing.js";
import { buildSidebarTreeModel } from "./sidebar.js";
import { expandSidebarTreeNode } from "./sidebar-tree-state.js";
import { sidebarTreeKey, type SidebarTreeNodeKey } from "./sidebar-tree-builder.js";

/** Max retry attempts for both the model-lookup and the DOM-scroll polls.
 *
 * Each call site invokes the reveal only AFTER awaiting the relevant data load
 * (`refreshSessions` / `loadDashboardData` / `connectToSession`), so the target
 * node is normally present on the very first attempt and the row commits within
 * a frame or two. The generous bound (~0.5s at 60fps) only matters for the rare
 * deep-link case where session/goal data streams in slightly after the reveal
 * fires; it stays bounded (`revealToken` still guarantees exactly-once). */
const MAX_ATTEMPTS = 30;

/** The tree model shape the resolvers read (from `buildSidebarTreeModel`). */
type SidebarTreeModel = ReturnType<typeof buildSidebarTreeModel>;

/** Resolve a route target to the ordered list of ancestor node-keys that must
 *  be expanded ephemerally for the target row to render, or null when the
 *  target cannot be resolved against this model (e.g. data not loaded yet, or
 *  the route is a different row kind). */
type AncestorResolver = (model: SidebarTreeModel) => SidebarTreeNodeKey[] | null;

interface PendingReveal {
	/** DOM `data-nav-id` of the target row (`session:<id>` / `goal:<id>`). */
	navId: string;
	/** Ordered ancestor resolvers; first non-null result wins. */
	resolvers: AncestorResolver[];
}

let pending: PendingReveal | null = null;
let revealToken = 0;

/** Schedule a callback on the next animation frame (falls back to setTimeout
 *  in non-DOM / test environments without `requestAnimationFrame`). */
function nextFrame(cb: () => void): void {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
	else setTimeout(cb, 16);
}

/** Walk a node's `parentKey` chain, returning the ordered list of ancestor
 *  node-keys (nearest-first). A `seen` guard defends against any pathological
 *  cycle in `parentKey`. Returns null when the starting node is absent. */
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

/** Resolve the reveal target for a route, or null when the route is not a
 *  session / goal destination. Session routes carry an ordered set of
 *  resolvers (session node → team-lead node → staff row); goal routes resolve
 *  via the single `goal/<id>` node walk. */
function targetForRoute(route: AppRoute): PendingReveal | null {
	if ((route.view === "goal" || route.view === "goal-dashboard") && route.goalId) {
		const goalId = route.goalId;
		return {
			navId: `goal:${goalId}`,
			resolvers: [(model) => ancestorsOf(model, sidebarTreeKey({ kind: "goal", goalId }))],
		};
	}
	if (route.view === "session" && route.sessionId) {
		const sessionId = route.sessionId;
		return {
			navId: `session:${sessionId}`,
			resolvers: [
				// 1. Regular session node (members, delegates, verifiers, children…).
				(model) => ancestorsOf(model, sidebarTreeKey({ kind: "session", sessionId })),
				// 2. Team-lead node — same walk, different tree key.
				(model) => ancestorsOf(model, sidebarTreeKey({ kind: "team-lead", sessionId })),
				// 3. Staff row — no tree node exists; map the session id to its staff
				//    entry and return the project + project-staff section ancestors.
				() => resolveStaffAncestors(sessionId),
			],
		};
	}
	return null;
}

/** Resolve a staff session id to the ancestor node-keys of its staff row. Staff
 *  sessions are excluded from the tree, so we locate the staff entry whose
 *  `currentSessionId` matches and return its `project` + `project-staff`
 *  section keys directly. Null when it is not a (project-scoped) staff session. */
function resolveStaffAncestors(sessionId: string): SidebarTreeNodeKey[] | null {
	const staff = state.staffList.find((s) => s.currentSessionId === sessionId);
	if (!staff || !staff.projectId) return null;
	return [
		{ kind: "project", projectId: staff.projectId },
		{ kind: "project-staff", projectId: staff.projectId },
	];
}

/**
 * Public entry point. Expand the collapsed ancestor tree for the route's
 * target row and scroll it into view. Safe to call from any route branch and
 * from cold-start boot; a no-op for non-session/goal routes.
 */
export function revealSidebarTargetForRoute(route: AppRoute = getRouteFromHash()): void {
	const target = targetForRoute(route);
	// Bump the token on every call so any earlier in-flight reveal is cancelled
	// (guards "exactly once per navigation").
	const token = ++revealToken;
	if (!target) {
		pending = null;
		return;
	}
	pending = target;
	attemptReveal(token, 0);
}

/** Bounded rAF poll: run the target's ancestor resolvers against the
 *  (unfiltered) tree model, expand the resolved ancestor chain ephemerally,
 *  then hand off to the scroll poll. Retries while every resolver returns null
 *  (data loading async on a deep-link, or not a staff session either). */
function attemptReveal(token: number, attempt: number): void {
	if (token !== revealToken || !pending) return;
	const current = pending;
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
	// Expand each resolved ancestor ephemerally (never overwrites an explicit
	// collapse; no-ops when the node's default is already expanded).
	for (const key of ancestors) expandSidebarTreeNode(key, { explicit: false });
	renderApp();
	attemptScroll(current.navId, token, 0);
}

/** Bounded rAF poll: locate the target row in the DOM and scroll it into
 *  view. Retries because lit commits the DOM asynchronously after `renderApp`. */
function attemptScroll(navId: string, token: number, attempt: number): void {
	if (token !== revealToken) return;
	const row = navRowForId(navId);
	if (row) {
		row.scrollIntoView({ block: "nearest" });
		if (pending && pending.navId === navId) pending = null;
		return;
	}
	if (attempt < MAX_ATTEMPTS) nextFrame(() => attemptScroll(navId, token, attempt + 1));
}

/** Locate a sidebar row by its `data-nav-id`. Scans (rather than using a CSS
 *  selector) to avoid escaping bugs with ids containing special characters —
 *  mirrors `navRowForId` in `sidebar-nav.ts`. */
function navRowForId(navId: string): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const sidebar = document.querySelector(".sidebar-edge");
	if (!sidebar) return null;
	for (const el of sidebar.querySelectorAll<HTMLElement>("[data-nav-id]")) {
		if (el.getAttribute("data-nav-id") === navId) return el;
	}
	return null;
}
