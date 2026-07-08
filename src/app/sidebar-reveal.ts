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
// ============================================================================

import { renderApp } from "./state.js";
import { getRouteFromHash, type AppRoute } from "./routing.js";
import { buildSidebarTreeModel } from "./sidebar.js";
import { expandSidebarTreeNode } from "./sidebar-tree-state.js";
import { sidebarTreeKey } from "./sidebar-tree-builder.js";

/** Max retry attempts for both the model-lookup and the DOM-scroll polls.
 *
 * Each call site invokes the reveal only AFTER awaiting the relevant data load
 * (`refreshSessions` / `loadDashboardData` / `connectToSession`), so the target
 * node is normally present on the very first attempt and the row commits within
 * a frame or two. The generous bound (~0.5s at 60fps) only matters for the rare
 * deep-link case where session/goal data streams in slightly after the reveal
 * fires; it stays bounded (`revealToken` still guarantees exactly-once). */
const MAX_ATTEMPTS = 30;

interface PendingReveal {
	/** Canonical sidebar-tree key of the target node (session or goal). */
	key: string;
	/** DOM `data-nav-id` of the target row (`session:<id>` / `goal:<id>`). */
	navId: string;
}

let pending: PendingReveal | null = null;
let revealToken = 0;

/** Schedule a callback on the next animation frame (falls back to setTimeout
 *  in non-DOM / test environments without `requestAnimationFrame`). */
function nextFrame(cb: () => void): void {
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
	else setTimeout(cb, 16);
}

/** Resolve the reveal target for a route, or null when the route is not a
 *  session / goal destination. */
function targetForRoute(route: AppRoute): PendingReveal | null {
	if ((route.view === "goal" || route.view === "goal-dashboard") && route.goalId) {
		return { key: sidebarTreeKey({ kind: "goal", goalId: route.goalId }), navId: `goal:${route.goalId}` };
	}
	if (route.view === "session" && route.sessionId) {
		return { key: sidebarTreeKey({ kind: "session", sessionId: route.sessionId }), navId: `session:${route.sessionId}` };
	}
	return null;
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

/** Bounded rAF poll: find the target node in the (unfiltered) tree model,
 *  expand its ancestor chain, then hand off to the scroll poll. Retries while
 *  the node is still absent (data loading async on a deep-link). */
function attemptReveal(token: number, attempt: number): void {
	if (token !== revealToken || !pending) return;
	const current = pending;
	const model = buildSidebarTreeModel();
	const node = model.flatByKey.get(current.key);
	if (!node) {
		if (attempt < MAX_ATTEMPTS) nextFrame(() => attemptReveal(token, attempt + 1));
		return;
	}
	// Walk the parent chain, expanding each ancestor ephemerally. A `seen`
	// guard defends against any pathological cycle in `parentKey`.
	const seen = new Set<string>();
	let pk = node.parentKey;
	while (pk && !seen.has(pk)) {
		seen.add(pk);
		const parent = model.flatByKey.get(pk);
		if (!parent) break;
		expandSidebarTreeNode(parent.nodeKey, { explicit: false });
		pk = parent.parentKey;
	}
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
