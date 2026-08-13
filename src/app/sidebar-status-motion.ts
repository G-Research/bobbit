const STATUS_MOTION_ROW_SELECTOR = "[data-status-motion-row='true'][data-session-id]";
const STATUS_MOTION_MOVING_ATTRIBUTE = "data-status-moving";
const STATUS_MOTION_TRACE_ATTRIBUTE = "data-status-change-tracing";

export const SIDEBAR_STATUS_MOVE_DURATION_MS = 280;
export const SIDEBAR_STATUS_TRACE_DURATION_MS = 650;
export const SIDEBAR_STATUS_MOVE_EASING = "cubic-bezier(.2,.8,.2,1)";

interface StatusMotionEntry {
	rect: DOMRectReadOnly;
	signature: string;
}

export interface SidebarStatusMotionSnapshot {
	rows: Map<string, StatusMotionEntry>;
	viewportWidth: number;
	viewportHeight: number;
}

function statusMotionRows(root: ParentNode): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(STATUS_MOTION_ROW_SELECTOR)];
}

function sessionIdForRow(row: HTMLElement): string | undefined {
	return row.dataset.sessionId || undefined;
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Capture the visible Status-row geometry immediately before Lit updates the DOM. */
export function captureSidebarStatusMotion(root: ParentNode = document): SidebarStatusMotionSnapshot | null {
	const rows = statusMotionRows(root);
	if (rows.length === 0) return null;
	const entries = new Map<string, StatusMotionEntry>();
	for (const row of rows) {
		const sessionId = sessionIdForRow(row);
		if (!sessionId) continue;
		entries.set(sessionId, {
			rect: row.getBoundingClientRect(),
			signature: row.dataset.statusMotionSignature || "",
		});
	}
	return {
		rows: entries,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	};
}

function clearRowMotion(row: HTMLElement): void {
	for (const animation of row.getAnimations()) animation.cancel();
	row.removeAttribute(STATUS_MOTION_MOVING_ATTRIBUTE);
	row.removeAttribute(STATUS_MOTION_TRACE_ATTRIBUTE);
	const trace = row.querySelector<HTMLElement>(".sidebar-status-change-trace");
	if (trace) for (const animation of trace.getAnimations()) animation.cancel();
}

function animateChangeTrace(row: HTMLElement): void {
	const trace = row.querySelector<HTMLElement>(".sidebar-status-change-trace");
	if (!trace || typeof trace.animate !== "function") return;
	row.setAttribute(STATUS_MOTION_TRACE_ATTRIBUTE, "true");
	const animation = trace.animate([
		{ opacity: 1 },
		{ opacity: 0 },
	], {
		duration: SIDEBAR_STATUS_TRACE_DURATION_MS,
		easing: "ease-out",
		fill: "forwards",
	});
	const clear = () => {
		if (row.isConnected) row.removeAttribute(STATUS_MOTION_TRACE_ATTRIBUTE);
	};
	animation.addEventListener("finish", clear, { once: true });
	animation.addEventListener("cancel", clear, { once: true });
}

function animateMovement(row: HTMLElement, dx: number, dy: number): void {
	if (typeof row.animate !== "function") return;
	row.setAttribute(STATUS_MOTION_MOVING_ATTRIBUTE, "true");
	const animation = row.animate([
		{ transform: `translate(${dx}px, ${dy}px)` },
		{ transform: "translate(0, 0)" },
	], {
		duration: SIDEBAR_STATUS_MOVE_DURATION_MS,
		easing: SIDEBAR_STATUS_MOVE_EASING,
		fill: "backwards",
	});
	const clear = () => {
		if (row.isConnected) row.removeAttribute(STATUS_MOTION_MOVING_ATTRIBUTE);
	};
	animation.addEventListener("finish", clear, { once: true });
	animation.addEventListener("cancel", clear, { once: true });
}

/**
 * Apply FLIP motion after Lit renders the next Status ordering. Rows whose
 * presentation signature changed receive a deliberately subtle identity trace.
 */
export function animateSidebarStatusChanges(
	snapshot: SidebarStatusMotionSnapshot | null,
	root: ParentNode = document,
): void {
	if (!snapshot) return;
	const rows = statusMotionRows(root);
	for (const row of rows) clearRowMotion(row);
	if (prefersReducedMotion()) return;
	if (snapshot.viewportWidth !== window.innerWidth || snapshot.viewportHeight !== window.innerHeight) return;

	for (const row of rows) {
		const sessionId = sessionIdForRow(row);
		const previous = sessionId ? snapshot.rows.get(sessionId) : undefined;
		if (!previous) continue;
		const nextRect = row.getBoundingClientRect();
		const dx = previous.rect.left - nextRect.left;
		const dy = previous.rect.top - nextRect.top;
		if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) animateMovement(row, dx, dy);
		if (previous.signature !== (row.dataset.statusMotionSignature || "")) animateChangeTrace(row);
	}
}

function movingStatusRowFromEvent(event: Event): HTMLElement | null {
	if (!(event instanceof MouseEvent) || event.detail === 0) return null;
	for (const target of event.composedPath()) {
		if (!(target instanceof HTMLElement)) continue;
		const row = target.closest<HTMLElement>(STATUS_MOTION_ROW_SELECTOR);
		if (row?.getAttribute(STATUS_MOTION_MOVING_ATTRIBUTE) === "true") return row;
	}
	return null;
}

/** Block pointer-generated click/auxclick events on rows while FLIP is moving them. */
export function guardMovingSidebarStatusClick(event: Event): boolean {
	if (!movingStatusRowFromEvent(event)) return false;
	event.preventDefault();
	event.stopImmediatePropagation();
	return true;
}

const clickGuardDocuments = new WeakSet<Document>();

export function installSidebarStatusMotionClickGuard(target: Document = document): void {
	if (clickGuardDocuments.has(target)) return;
	clickGuardDocuments.add(target);
	target.addEventListener("click", guardMovingSidebarStatusClick, true);
	target.addEventListener("auxclick", guardMovingSidebarStatusClick, true);
}
