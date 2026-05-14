// ============================================================================
// SIDEBAR KEYBOARD NAVIGATION
//
// `Ctrl+↑` / `Ctrl+↓` walk every row currently rendered in the sidebar (in
// DOM order, wrapping at ends) and auto-open the matching destination on
// every step. `Ctrl+→` / `Ctrl+←` expand/collapse the active group header
// without moving the cursor.
//
// The "active" row is derived from the current hash route + selected session,
// with a thin override (`state.keyboardNavActiveId`) used for header kinds
// (ungrouped / archived / staff / project) whose route alone cannot
// disambiguate which sidebar row was last touched. The override is cleared
// automatically when the URL changes to something that doesn't correspond to
// it (e.g. the user clicks elsewhere).
//
// Tagging contract: every selectable sidebar row carries
//   data-nav-id="<kind>:<id>"
// where `<kind>` ∈ project | goal | session | ungrouped-header |
// staff-header | archived-header. The active row also carries
// `data-nav-active="true"` so the existing CSS highlight + E2E tests can
// identify it uniformly.
// ============================================================================

import { state, renderApp, expandedGoals, saveExpandedGoals, isUngroupedExpanded, setUngroupedExpanded, isStaffExpanded, setStaffSectionExpanded, isArchivedSectionExpanded, setArchivedSectionExpanded } from "./state.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { mark as perfMark, startSpan as perfStartSpan } from "./perf-trace.js";
// sidebar.ts also imports from this module — ES modules handle the cycle
// fine because we only reference these as function bindings at call time.
import { isProjectExpanded as _isProjectExpanded, toggleProjectExpanded as _toggleProjectExpanded } from "./sidebar.js";

export type NavKind = "project" | "goal" | "session" | "ungrouped-header" | "staff-header" | "archived-header";

export interface NavItem { kind: NavKind; id: string; }

export function parseNavId(navId: string): NavItem | null {
	const idx = navId.indexOf(":");
	if (idx < 0) return null;
	const kind = navId.slice(0, idx) as NavKind;
	const id = navId.slice(idx + 1);
	if (
		kind !== "project" && kind !== "goal" && kind !== "session" &&
		kind !== "ungrouped-header" && kind !== "staff-header" && kind !== "archived-header"
	) return null;
	return { kind, id };
}

export function navIdFor(kind: NavKind, id: string): string {
	return `${kind}:${id}`;
}

// ============================================================================
// ROUTE ↔ NAV ID MAPPING
// ============================================================================

/** Expected URL hash for a nav id, used to validate the keyboard override. */
export function navIdToHash(navId: string): string | null {
	const item = parseNavId(navId);
	if (!item) return null;
	switch (item.kind) {
		case "session": return `#/session/${item.id}`;
		case "goal": return `#/goal/${item.id}`;
		case "project": return `#/settings/${item.id}/general`;
		case "staff-header": return "#/staff";
		case "ungrouped-header":
		case "archived-header": return "#/";
	}
}

/** Compute the active nav id from the current route + selected session.
 *  The keyboard override (set synchronously by `openForNavItem`) ALWAYS
 *  wins when present, even if the URL hash hasn't caught up yet. This
 *  matters for rapid Ctrl+↑/↓ keystrokes: session navigation goes through
 *  an async dynamic import + `connectToSession`, so the second keystroke
 *  fires before the first nav's `setHashRoute` has committed. Trusting
 *  the override here lets `navigateSidebar` advance off the in-flight
 *  destination instead of re-deriving from a stale URL/`selectedSessionId`
 *  and looping back to the same row (the dropped-keystroke bug noted in
 *  docs/perf/sidebar-nav-baseline.md §5.6).
 *
 *  Staleness of the override (e.g. user clicks elsewhere) is handled by
 *  `installKeyboardNavOverrideClearListener` which clears it on any
 *  hashchange whose final URL doesn't match the override's expected hash. */
export function getActiveNavId(): string | null {
	const override = state.keyboardNavActiveId;
	if (override) return override;
	const route = getRouteFromHash();
	if (route.view === "session" && route.sessionId) return navIdFor("session", route.sessionId);
	if (route.view === "goal-dashboard" && route.goalId) return navIdFor("goal", route.goalId);
	if (route.view === "settings" && route.settingsScope && route.settingsScope !== "system") {
		return navIdFor("project", route.settingsScope);
	}
	// staff / staff-edit and landing have no inherent project context, so they
	// only stay highlighted via the override.
	if (state.selectedSessionId) return navIdFor("session", state.selectedSessionId);
	return null;
}

// ============================================================================
// EXPANSION
// ============================================================================

/** Is this nav kind a group header whose expand/collapse state we manage? */
export function isExpandableKind(kind: NavKind): boolean {
	return kind === "project" || kind === "goal" || kind === "ungrouped-header" || kind === "staff-header" || kind === "archived-header";
}

export function isNavItemExpanded(navId: string): boolean | null {
	const item = parseNavId(navId);
	if (!item) return null;
	switch (item.kind) {
		case "project": return _isProjectExpanded(item.id);
		case "goal": return expandedGoals.has(item.id);
		case "ungrouped-header": return isUngroupedExpanded(item.id);
		case "staff-header": return isStaffExpanded(item.id);
		case "archived-header": return isArchivedSectionExpanded(item.id);
		case "session": return null;
	}
}

/** Set expansion state for an expandable group header. No-op on leaves. */
export function setNavItemExpanded(navId: string, expanded: boolean): void {
	const item = parseNavId(navId);
	if (!item) return;
	switch (item.kind) {
		case "project": {
			if (_isProjectExpanded(item.id) !== expanded) _toggleProjectExpanded(item.id);
			break;
		}
		case "goal": {
			if (expanded) expandedGoals.add(item.id); else expandedGoals.delete(item.id);
			saveExpandedGoals();
			break;
		}
		case "ungrouped-header": setUngroupedExpanded(item.id, expanded); break;
		case "staff-header": setStaffSectionExpanded(item.id, expanded); break;
		case "archived-header": setArchivedSectionExpanded(item.id, expanded); break;
		case "session": /* not expandable here */ break;
	}
}

// ============================================================================
// DOM-DRIVEN ORDER
// ============================================================================

/** Visible nav ids in DOM (= render) order, scoped to the expanded sidebar. */
export function getVisibleNavOrder(): string[] {
	if (typeof document === "undefined") return [];
	const sidebar = document.querySelector(".sidebar-edge");
	if (!sidebar) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const el of sidebar.querySelectorAll("[data-nav-id]")) {
		const id = el.getAttribute("data-nav-id");
		if (id && !seen.has(id)) { seen.add(id); out.push(id); }
	}
	return out;
}

// ============================================================================
// OPEN / NAVIGATE
// ============================================================================

/** Route to (or otherwise open) the destination for a nav item, and remember
 *  it as the keyboard-active row so the sidebar can highlight it. */
export function openForNavItem(item: NavItem): void {
	const navId = navIdFor(item.kind, item.id);
	// Set the override BEFORE mutating the route, so the hashchange listener
	// always sees a matching hash + override pair and never spuriously clears.
	state.keyboardNavActiveId = navId;

	// Perf: instrument click → view-ready. The click span closes when the
	// hash actually changes (routing.ts hashchange listener). The view-ready
	// span closes on the first doRenderApp committing the destination view
	// (render.ts). Cheap when perf-trace is disabled — startSpan returns a
	// shared no-op handle.
	perfMark("nav.click");
	(state as any)._navClickSpan = perfStartSpan("nav.click", { kind: item.kind, id: item.id });
	if (item.kind === "session") {
		state.pendingNavSpan?.span.end({ aborted: true });
		state.pendingNavSpan = {
			span: perfStartSpan("nav.session.ready", { sessionId: item.id }),
			view: "session",
			id: item.id,
		};
	} else if (item.kind === "goal") {
		state.pendingNavSpan?.span.end({ aborted: true });
		state.pendingNavSpan = {
			span: perfStartSpan("nav.goal.ready", { goalId: item.id }),
			view: "goal-dashboard",
			id: item.id,
		};
	}

	switch (item.kind) {
		case "session":
			// Fire-and-forget. selectSession (sync) sets hash + selectedSessionId;
			// the async tail is just hydration. We don't await so the keyboard
			// shortcut handler returns immediately and the next press finds the
			// updated active row.
			void import("./session-manager.js").then(m => m.connectToSession(item.id, true));
			break;
		case "goal":
			setHashRoute("goal-dashboard", item.id);
			break;
		case "project":
			setHashRoute("settings", `${item.id}/general`);
			break;
		case "staff-header":
			void import("./staff-page.js").then(m => m.loadStaffPageData());
			setHashRoute("staff");
			break;
		case "ungrouped-header":
		case "archived-header":
			setHashRoute("landing");
			break;
	}
	renderApp();
}

/** Walk one step through the currently rendered sidebar order. Wraps at ends.
 *  Cold-start (no active row yet) picks the first visible row. */
export function navigateSidebar(direction: "up" | "down"): void {
	const order = getVisibleNavOrder();
	if (order.length === 0) return;
	const currentId = getActiveNavId();
	let nextIndex: number;
	if (!currentId || !order.includes(currentId)) {
		nextIndex = direction === "down" ? 0 : order.length - 1;
	} else {
		const currentIndex = order.indexOf(currentId);
		if (direction === "down") {
			nextIndex = currentIndex >= order.length - 1 ? 0 : currentIndex + 1;
		} else {
			nextIndex = currentIndex <= 0 ? order.length - 1 : currentIndex - 1;
		}
	}
	const nextId = order[nextIndex];
	const item = parseNavId(nextId);
	if (item) openForNavItem(item);
}

/** Ctrl+→ / Ctrl+← — expand or collapse the active group header without
 *  moving the cursor. No-op on leaves or when already in the requested state. */
export function expandActiveSidebarItem(expand: boolean): void {
	const order = getVisibleNavOrder();
	const activeId = getActiveNavId();
	if (!activeId || !order.includes(activeId)) {
		// Cold start: pick the first visible row, open it (per the goal spec),
		// but do NOT then toggle its expansion — the user is just landing.
		if (order.length === 0) return;
		const first = parseNavId(order[0]);
		if (first) openForNavItem(first);
		return;
	}
	const item = parseNavId(activeId);
	if (!item || !isExpandableKind(item.kind)) return;
	const expanded = isNavItemExpanded(activeId);
	if (expanded === null) return;
	if (expanded === expand) return; // already in requested state
	setNavItemExpanded(activeId, expand);
	renderApp();
}

// ============================================================================
// OVERRIDE LIFECYCLE
// ============================================================================

/** Clear the keyboard override whenever the URL no longer corresponds to it
 *  (e.g. the user clicked a different row, opened settings, etc.). */
export function installKeyboardNavOverrideClearListener(): void {
	if (typeof window === "undefined") return;
	window.addEventListener("hashchange", () => {
		const o = state.keyboardNavActiveId;
		if (!o) return;
		const expected = navIdToHash(o);
		if (expected && window.location.hash !== expected) {
			state.keyboardNavActiveId = null;
			renderApp();
		}
	});
}
