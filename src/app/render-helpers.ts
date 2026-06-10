import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { Archive, ExternalLink, GitFork, Goal as GoalIcon, LayoutDashboard, Link, Menu, Pencil, RotateCcw, Trash2 } from "lucide";
import { buildNestedGoalForest } from "./sidebar-nesting.js";
import { selectSpawnedChildren, isAncestorCycle, extendAncestors, computeTitleSuffixes } from "./sidebar-spawned-children.js";
import { bucketTeamChildren } from "./team-archived-bucket.js";
import {
	state,
	renderApp,
	activeSessionId,
	expandedGoals,
	saveExpandedGoals,
	isDesktop,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	toggleArchivedParentExpanded,
	isArchivedParentExpanded,
	toggleFirstClassParentExpanded,
	isFirstClassParentExpanded,
	isArchivedSectionExpanded,
	setArchivedSectionExpanded,
	type GatewaySession,
	type Goal,
	type Project,
} from "./state.js";
import { statusBobbit } from "./session-colors.js";
import { shortcutHint } from "./shortcut-registry.js";
import { connectToSession, terminateSession, createAndConnectSession, startReattempt, forkSession } from "./session-manager.js";
import { showRenameDialog } from "./dialogs-lazy.js";
import { setHashRoute } from "./routing.js";
import { startTeam, deleteGoal, gatewayFetch, copySidebarLink, fetchGoalGithubLink, getCachedGoalGithubLink, goalDeepLink, sessionDeepLink, type GoalGithubLinkResponse } from "./api.js";
import { getActiveNavId } from "./sidebar-nav.js";
import { needsHumanAttention, needsImmediateHumanAttention } from "./notification-policy.js";
import "../ui/components/SidebarActionsPopover.js";
import type { SidebarActionsPopover, SidebarActionsPopoverItem } from "../ui/components/SidebarActionsPopover.js";
import { captureSidebarActionSourceRects, type SidebarActionsFlipRect } from "../ui/components/sidebar-actions-flip.js";

// ============================================================================
// FORMATTING
// ============================================================================

/**
 * Shared muted divider used to mark the boundary between active and archived
 * items inside a sidebar group. Render only when both classes are present in
 * the same group — callers gate on `activeCount > 0 && archivedCount > 0`,
 * typically via `bucketActiveArchived().needsDivider`.
 *
 * When `owner` is provided, the label renders as "ARCHIVED · <owner>" with
 * the owner name in normal case (the uppercase CSS class only applies to the
 * leading "Archived ·" span). The owner is also exposed as `data-owner` for
 * test selectors. Callers in `renderTeamGroup` pass the team-lead's title so
 * stacked archive sections in a multi-team-lead subtree have unambiguous
 * ownership; project-level and nested-goal callers omit the owner to keep
 * the plain "Archived" label (back-compat with existing tests).
 * See docs/design `Active-before-archived sidebar ordering`.
 */
export const archivedDivider = (owner?: string) => html`
	<div class="flex items-center gap-2 my-1 mx-2" data-testid="sidebar-archived-divider" data-owner="${owner ?? ""}">
		<div class="flex-1 border-t border-border/30"></div>
		<span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Archived${owner ? " ·" : ""}</span>
		${owner ? html`<span class="text-muted-foreground tracking-wider opacity-60 normal-case truncate" style="font-size: 0.75em;">${owner}</span>` : ""}
		<div class="flex-1 border-t border-border/30"></div>
	</div>
`;

/**
 * Pure helper: split `rows` into active vs archived buckets using `isArchived`.
 * `needsDivider` is true iff both buckets are non-empty — the canonical signal
 * for callers deciding whether to emit `archivedDivider()` between them.
 * Single source of truth for every active-before-archived render path.
 */
export function bucketActiveArchived<T>(
	rows: T[],
	isArchived: (r: T) => boolean,
): { active: T[]; archived: T[]; needsDivider: boolean } {
	const active: T[] = [];
	const archived: T[] = [];
	for (const r of rows) {
		if (isArchived(r)) archived.push(r); else active.push(r);
	}
	return { active, archived, needsDivider: active.length > 0 && archived.length > 0 };
}

/** Guard set to prevent repeated on-demand child fetches per goal. */
const _goalChildrenFetched = new Set<string>();

export function sessionParentId(session: GatewaySession): string | undefined {
	return session.parentSessionId || session.delegateOf;
}

export function isChildSession(session: GatewaySession): boolean {
	return !!sessionParentId(session);
}

function isFirstClassChildSession(session: GatewaySession): boolean {
	return !!session.parentSessionId && !session.delegateOf;
}

/** Clear the on-demand child fetch guard (called when archived state is reset). */
export function clearGoalChildrenFetchedCache(): void {
	_goalChildrenFetched.clear();
}

// ============================================================================
// SEARCH HIGHLIGHTING
// ============================================================================

/** Escape regex special characters so `query` is matched literally. */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` into alternating matched/unmatched segments for case-insensitive
 * occurrences of `query`. Pure function — no DOM — used by
 * `renderHighlightedText` and tested directly in unit tests.
 */
export function splitByQuery(text: string, query: string | null | undefined): Array<{ text: string; matched: boolean }> {
	if (!text) return text ? [{ text, matched: false }] : [];
	if (!query) return [{ text, matched: false }];
	const q = String(query);
	if (!q) return [{ text, matched: false }];
	const re = new RegExp(escapeRegex(q), "gi");
	const out: Array<{ text: string; matched: boolean }> = [];
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > lastIndex) out.push({ text: text.slice(lastIndex, m.index), matched: false });
		out.push({ text: m[0], matched: true });
		lastIndex = m.index + m[0].length;
		if (m[0].length === 0) re.lastIndex++; // avoid infinite loops on zero-width matches
	}
	if (out.length === 0) return [{ text, matched: false }];
	if (lastIndex < text.length) out.push({ text: text.slice(lastIndex), matched: false });
	return out;
}

/**
 * Render `text` with every case-insensitive occurrence of `query` wrapped in
 * a `<strong class="font-semibold">` span. When `query` is empty/falsy the
 * original text is returned unchanged (no spans, no layout shift).
 * Preserves the original casing of the matched substrings.
 */
export function renderHighlightedText(text: string, query: string | null | undefined): TemplateResult | string {
	if (!text) return text || "";
	if (!query) return text;
	const segments = splitByQuery(text, query);
	if (segments.length <= 1 && !segments.some(s => s.matched)) return text;
	return html`${segments.map(s => s.matched ? html`<strong class="font-semibold">${s.text}</strong>` : s.text)}`;
}

// ============================================================================
// SEARCH FILTER PREDICATES
// ============================================================================

/** Filter archived goals by title match OR affiliated (non-delegate) session title/role match.
 *  Shared between desktop and mobile sidebar renderers. */
export function filterArchivedGoalsByQuery(
	archivedGoals: Goal[],
	liveSessions: GatewaySession[],
	archivedSessions: GatewaySession[],
	query: string | null | undefined,
): Goal[] {
	if (!query) return archivedGoals;
	const q = String(query).toLowerCase();
	if (!q) return archivedGoals;
	const combined = [...liveSessions, ...archivedSessions];
	return archivedGoals.filter(goal => {
		if (goal.title.toLowerCase().includes(q)) return true;
		const affiliated = combined.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s));
		return affiliated.some(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
	});
}

/** Filter standalone archived sessions by title or role (case-insensitive). */
export function filterArchivedSessionsByQuery(
	archivedSessions: GatewaySession[],
	query: string | null | undefined,
): GatewaySession[] {
	if (!query) return archivedSessions;
	const q = String(query).toLowerCase();
	if (!q) return archivedSessions;
	return archivedSessions.filter(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
}

/** Get the appropriate project accent color for the current theme mode. */
export function getProjectAccentColor(project: Project): string {
	const isDark = document.documentElement.classList.contains("dark");
	return isDark
		? (project.colorDark || project.color || "var(--muted-foreground)")
		: (project.colorLight || project.color || "var(--muted-foreground)");
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
// SESSION VISIT TRACKING — server-backed
// ============================================================================

const LEGACY_VISITED_KEY = "bobbit-session-visited";

/** In-memory mirror of server-side lastReadAt for instant UI feedback. */
const _readMirror: Map<string, number> = new Map();

/** Record that the user visited a session right now. Optimistic: updates UI
 *  immediately, then POSTs to server. POST failure is non-fatal — the next
 *  sessions-list refresh will reconcile. */
export function markSessionVisited(sessionId: string): void {
	const now = Date.now();
	_readMirror.set(sessionId, now);
	// Optimistic mirror — also patch the in-memory GatewaySession so
	// hasUnseenActivity returns false on the very next render.
	const s = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	if (s) s.lastReadAt = now;
	gatewayFetch(`/api/sessions/${sessionId}/mark-read`, { method: "POST" })
		.catch(() => { /* non-fatal */ });
}

/** Returns true if the session has activity the user hasn't seen yet.
 *  "Unseen" means: session is idle/terminated AND lastActivity > lastReadAt
 *  AND the session warrants human attention (see `needsHumanAttention` —
 *  team members never surface, team leads only when goal is complete or stuck).
 *
 *  Read-filter split (see `notification-policy.ts`):
 *  — `needsImmediateHumanAttention` (pending sign-off, errored-and-parked)
 *    bypasses the read-state filter — these states demand attention until
 *    the user explicitly resolves them.
 *  — `needsHumanAttention` (goal complete, idle stuck) is subject to the
 *    normal read-state filter — once the user has visited the session, the
 *    dot clears.
 */
export function hasUnseenActivity(session: GatewaySession): boolean {
	// Active sessions don't show unseen — user will see it when they connect
	if (session.status === "streaming" || session.status === "busy") return false;
	// Currently viewed session is never unseen
	if (activeSessionId() === session.id) return false;

	// Persistent attention predicate — beeps use the idle-transition variant.
	const goalId = session.teamGoalId || session.goalId;
	const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;

	// Immediate predicate — short-circuits the read-state filter for states that
	// require explicit user action (pending sign-off, errored-and-parked).
	if (needsImmediateHumanAttention(session, state.gateStatusCache)) return true;

	if (!needsHumanAttention(session, goal, state.gatewaySessions, state.gateStatusCache)) return false;

	const mirror = _readMirror.get(session.id) ?? 0;
	const lastRead = Math.max(session.lastReadAt ?? 0, mirror);
	return session.lastActivity > lastRead;
}

/**
 * Apply sidebar visibility filters (Busy / Read).
 * Active session is exempt — it always passes.
 * Archived filtering is handled separately via `state.showArchived` flags
 * already threaded through render-helpers.
 * Search bypasses filters entirely — pass `bypass=true` when searchQuery is non-empty.
 */
export function passesSidebarFilters(
	session: GatewaySession,
	isActive: boolean,
	bypass: boolean,
): boolean {
	if (bypass || isActive) return true;
	if (!state.showBusy) {
		const busy = session.status === "streaming"
			|| session.status === "aborting"
			|| session.status === "preparing"
			|| session.status === "starting"
			|| session.isCompacting;
		if (busy) return false;
	}
	if (!state.showRead) {
		// Only filter out idle/done sessions with no unread activity.
		// Busy sessions (if not already filtered above) always remain visible.
		const idleLike = session.status === "idle" || session.status === "terminated";
		if (idleLike && !hasUnseenActivity(session)) return false;
	}
	return true;
}

/** One-shot migration: read the legacy localStorage map, POST mark-read for
 *  each entry to seed lastReadAt server-side, then delete the key.
 *  Idempotent — guarded by key existence. Call once at app boot. */
export async function migrateLegacyVisitedMap(): Promise<void> {
	let raw: string | null;
	try { raw = localStorage.getItem(LEGACY_VISITED_KEY); } catch { return; }
	if (!raw) return;
	let map: Record<string, number>;
	try { map = JSON.parse(raw); } catch {
		try { localStorage.removeItem(LEGACY_VISITED_KEY); } catch { /* noop */ }
		return;
	}
	const entries = Object.entries(map).filter(([, ts]) => typeof ts === "number" && ts > 0);
	await Promise.allSettled(
		entries.map(([id, ts]) => {
			_readMirror.set(id, ts);
			return gatewayFetch(`/api/sessions/${id}/mark-read`, { method: "POST" });
		}),
	);
	try { localStorage.removeItem(LEGACY_VISITED_KEY); } catch { /* noop */ }
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

// ============================================================================
// UNIFIED SESSION ROW
// ============================================================================

// ============================================================================
// SESSION TIME + UNSEEN BADGE
// ============================================================================

/** Render session title with a subtle rolling shadow when active. */
let _waveIndex = 0;
export function renderSessionTitle(title: string, isActive?: boolean, query?: string | null) {
	// Emoji glyphs (e.g. ⚡) have built-in leading whitespace — pull a negative margin to compensate
	const emojiLead = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(title) ? "margin-left:-2px" : "";
	const content = query ? renderHighlightedText(title, query) : title;
	if (!isActive) { return emojiLead ? html`<span style="${emojiLead}">${content}</span>` : content; }
	const delay = -((_waveIndex++ % 7) * 0.6);
	return html`<span class="title-wave" style="animation-delay:${delay}s;${emojiLead}">${content}</span>`;
}

/** Render a pulsing dot with conic sweep to indicate active session. */
let _dotIndex = 0;
function renderActiveShimmer() {
	const delay = (_dotIndex++ % 5) * 1.8;
	return html`<span class="sidebar-active-dot" style="--dot-delay:${delay}s"></span>`;
}

/** Render a small container icon with a status dot for sandboxed sessions. */
export function renderSandboxIndicator(status: string) {
	const isActive = status === "streaming" || status === "busy";
	return html`<span class="shrink-0 inline-flex items-center" style="margin-left:3px;position:relative;" title="Sandboxed (Docker)">
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted-foreground);opacity:0.6;">
			<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
			<path d="m3.3 7 8.7 5 8.7-5"/>
			<path d="M12 22V12"/>
		</svg>
		<span style="position:absolute;bottom:-1px;right:-1px;width:5px;height:5px;border-radius:50%;background:${isActive ? "#22c55e" : "var(--muted-foreground)"};opacity:${isActive ? "1" : "0.5"};"></span>
	</span>`;
}

/** Render terse relative time with optional unseen indicator dot. */
function renderSessionTime(session: GatewaySession, selected = false) {
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;
	if (isActive) return renderActiveShimmer();
	const time = terseRelativeTime(session.lastActivity);
	if (!time) return "";
	const unseen = hasUnseenActivity(session);
	return html`<span
		class="shrink-0 inline-flex items-center gap-0.5 tabular-nums ${selected ? (unseen ? "text-foreground font-medium" : "text-foreground/50") : (unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50")}"
		style="vertical-align:middle;font-size: 0.9167em;"
		title="${formatSessionAge(session.lastActivity)}"
	>${time}${unseen ? html`<span class="unseen-dot" aria-label="unread"></span>` : ""}</span>`;
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

/** Consistent indent per nesting level (px). */
export const INDENT = 5;
/** Width of the chevron/spacer slot (px) — same for all chevrons. */
export const CHEVRON_W = 14;
/** Wider chevron slot for level-0 section headers (extra right breathing room). */
export const HEADER_CHEVRON_W = 20;

// ============================================================================
// SIDEBAR ACTIONS MENU
// ============================================================================

export type SidebarActionEntityKind = "session" | "goal";

export interface SidebarActionTrailingToggle {
	id: string;
	checked: boolean;
	ariaLabel: string;
	label?: string;
	onToggle: () => void;
}

export interface SidebarActionItem {
	id: string;
	label: string;
	title?: string;
	icon: TemplateResult;
	tone?: "default" | "danger";
	quick: boolean;
	run: (event: Event) => void | Promise<void>;
	trailingToggle?: SidebarActionTrailingToggle;
}

// Fork's "New worktree" choice. Module-level so the popover checkbox toggle and
// the Fork run handler share one source of truth; reset to the default (checked)
// each time a session actions menu opens.
let _forkNewWorktree = true;

interface OpenSidebarActionsPopover {
	kind: SidebarActionEntityKind;
	entityId: string;
	element: SidebarActionsPopover;
	actions: SidebarActionItem[];
	refresh: () => SidebarActionItem[];
}

let _openSidebarActionsPopover: OpenSidebarActionsPopover | null = null;

function isSidebarActionsPopoverOpen(kind: SidebarActionEntityKind, entityId: string): boolean {
	return _openSidebarActionsPopover?.kind === kind
		&& _openSidebarActionsPopover.entityId === entityId
		&& _openSidebarActionsPopover.element.open;
}

function sidebarActionPopoverItems(actions: SidebarActionItem[]): SidebarActionsPopoverItem[] {
	// Quick actions render left→right in the hover strip, so the right-most quick
	// action is the LAST quick item. In the popover we surface quick actions in
	// reverse strip order (right-most first/top), followed by menu-only actions in
	// their existing order. FLIP stays keyed by action id, so reordering is safe.
	const quick = actions.filter((a) => a.quick).reverse();
	const menuOnly = actions.filter((a) => !a.quick);
	return [...quick, ...menuOnly].map(({ id, label, icon, tone, quick, trailingToggle }) => ({ id, label, icon, tone, quick, trailingToggle }));
}

function closeSidebarActionsPopover(render = true): void {
	const current = _openSidebarActionsPopover;
	if (!current) return;
	_openSidebarActionsPopover = null;
	current.element.open = false;
	if (render) renderApp();
}

function removeSidebarActionsPopoverElement(element: SidebarActionsPopover): void {
	if (_openSidebarActionsPopover?.element === element) _openSidebarActionsPopover = null;
	try { element.remove(); } catch { /* ignore */ }
	renderApp();
}

function refreshOpenSidebarActionsPopover(): void {
	const current = _openSidebarActionsPopover;
	if (!current) return;
	current.actions = current.refresh();
	current.element.items = sidebarActionPopoverItems(current.actions);
}

function openSidebarActionsPopover(input: {
	kind: SidebarActionEntityKind;
	entityId: string;
	trigger: HTMLElement;
	actions: SidebarActionItem[];
	refresh: () => SidebarActionItem[];
	sourceRects: SidebarActionsFlipRect[];
}): void {
	if (isSidebarActionsPopoverOpen(input.kind, input.entityId)) {
		closeSidebarActionsPopover();
		return;
	}
	closeSidebarActionsPopover(false);
	const element = document.createElement("sidebar-actions-popover") as SidebarActionsPopover;
	element.anchorEl = input.trigger;
	element.items = sidebarActionPopoverItems(input.actions);
	element.sourceRects = input.sourceRects;
	element.open = true;
	element.addEventListener("sidebar-action-select", ((event: CustomEvent<{ actionId: string }>) => {
		event.stopPropagation();
		const current = _openSidebarActionsPopover;
		const action = current?.actions.find((item) => item.id === event.detail.actionId);
		void action?.run(event);
	}) as EventListener);
	element.addEventListener("close", () => removeSidebarActionsPopoverElement(element));
	document.body.appendChild(element);
	_openSidebarActionsPopover = {
		kind: input.kind,
		entityId: input.entityId,
		element,
		actions: input.actions,
		refresh: input.refresh,
	};
	renderApp();
}

function renderSidebarQuickActions(actions: SidebarActionItem[], opts: { mobile: boolean; btnPad: string }): TemplateResult {
	return html`${actions.filter((action) => action.quick).map((action) => {
		const danger = action.tone === "danger";
		const colorClass = opts.mobile
			? `text-muted-foreground ${danger ? "active:bg-destructive/10" : "active:bg-secondary/80"}`
			: danger
				? "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
				: "hover:bg-secondary/80 text-muted-foreground hover:text-foreground";
		return html`
			<button
				class="${opts.btnPad} rounded ${colorClass}"
				data-sidebar-action-id=${action.id}
				data-sidebar-action-quick="true"
				@click=${action.run}
				title=${action.title || action.label}
				aria-label=${action.label}
			>${action.icon}</button>
		`;
	})}`;
}

function renderSidebarActionsTrigger(input: {
	kind: SidebarActionEntityKind;
	entityId: string;
	actions: SidebarActionItem[];
	mobile: boolean;
	btnPad: string;
	refresh: () => SidebarActionItem[];
	onBeforeOpen?: () => void;
}): TemplateResult | typeof nothing {
	if (input.mobile) return nothing;
	const expanded = isSidebarActionsPopoverOpen(input.kind, input.entityId);
	const label = input.kind === "session" ? "Session actions" : "Goal actions";
	const openFromTrigger = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		const trigger = event.currentTarget as HTMLElement;
		const row = trigger.closest<HTMLElement>("[data-sidebar-actions-row-root]");
		input.onBeforeOpen?.();
		const actions = input.refresh();
		openSidebarActionsPopover({
			kind: input.kind,
			entityId: input.entityId,
			trigger,
			actions,
			refresh: input.refresh,
			sourceRects: row ? captureSidebarActionSourceRects(row) : [],
		});
	};
	return html`
		<button
			class="${input.btnPad} rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
			data-testid="sidebar-actions-trigger"
			data-sidebar-actions-kind=${input.kind}
			data-sidebar-actions-id=${input.entityId}
			aria-haspopup="menu"
			aria-expanded=${expanded ? "true" : "false"}
			aria-label=${label}
			title=${label}
			@click=${openFromTrigger}
			@keydown=${(event: KeyboardEvent) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") openFromTrigger(event);
				else event.stopPropagation();
			}}
		>${icon(Menu, "xs")}</button>
	`;
}

function buildSessionSidebarActions(session: GatewaySession, displayTitle: string): SidebarActionItem[] {
	const staffId = session.staffId;
	const modifyLabel = staffId ? "Edit staff" : "Modify";
	const actions: SidebarActionItem[] = [
		{
			id: "modify",
			label: modifyLabel,
			title: modifyLabel,
			icon: icon(Pencil, "xs"),
			quick: true,
			run: staffId
				? (e: Event) => { e.stopPropagation(); window.location.hash = `#/staff/${staffId}`; }
				: (e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); },
		},
		{
			id: "terminate",
			label: session.role === "team-lead" ? "End team" : "Terminate",
			title: `${session.role === "team-lead" ? "End team" : "Terminate"}${shortcutHint("terminate-session")}`,
			icon: icon(Trash2, "xs"),
			tone: "danger",
			quick: true,
			run: (e: Event) => { e.stopPropagation(); terminateSession(session.id); },
		},
		{
			id: "copy-link",
			label: "Copy link",
			icon: icon(Link, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); void copySidebarLink(sessionDeepLink(session.id), "Copy session link"); },
		},
		{
			id: "open-new-window",
			label: "Open in new window",
			icon: icon(ExternalLink, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); openSessionInNewWindow(session.id); },
		},
	];
	if (canForkSidebarSession(session)) {
		actions.push({
			id: "fork",
			label: "Fork",
			icon: icon(GitFork, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); void forkSession(session, { newWorktree: _forkNewWorktree }); },
			trailingToggle: {
				id: "fork-new-worktree",
				checked: _forkNewWorktree,
				ariaLabel: _forkNewWorktree ? "New worktree (on) — fork into a fresh worktree" : "New worktree (off) — reuse the source worktree",
				label: "New worktree",
				onToggle: () => { _forkNewWorktree = !_forkNewWorktree; refreshOpenSidebarActionsPopover(); },
			},
		});
	}
	return actions;
}

function buildTeamLeadSidebarActions(session: GatewaySession, displayTitle: string, goalId?: string): SidebarActionItem[] {
	return [
		{
			id: "modify",
			label: "Modify",
			title: "Modify",
			icon: icon(Pencil, "xs"),
			quick: true,
			run: (e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); },
		},
		{
			id: "terminate",
			label: "End team",
			title: `End team${shortcutHint("terminate-session")}`,
			icon: icon(Trash2, "xs"),
			tone: "danger",
			quick: true,
			run: (e: Event) => { e.stopPropagation(); terminateSession(session.id, { goalId: goalId || undefined, isTeamLead: true }); },
		},
		{
			id: "copy-link",
			label: "Copy link",
			icon: icon(Link, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); void copySidebarLink(sessionDeepLink(session.id), "Copy session link"); },
		},
		{
			id: "open-new-window",
			label: "Open in new window",
			icon: icon(ExternalLink, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); openSessionInNewWindow(session.id); },
		},
	];
}

function buildGoalSidebarActions(goal: Goal, input: { hasActiveSession: boolean; showArchive: boolean }): SidebarActionItem[] {
	const actions: SidebarActionItem[] = [];
	if (!input.hasActiveSession) {
		actions.push({
			id: "reattempt",
			label: "Re-attempt",
			title: "Re-attempt goal",
			icon: icon(RotateCcw, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); startReattempt(goal.id); },
		});
	}
	if (input.showArchive) {
		actions.push({
			id: "archive",
			label: "Archive",
			title: "Archive goal",
			icon: icon(Trash2, "xs"),
			tone: "danger",
			quick: true,
			run: (e: Event) => { e.stopPropagation(); deleteGoal(goal.id); },
		});
	}
	actions.push(
		{
			id: "dashboard",
			label: "Goal dashboard",
			title: "Goal dashboard",
			icon: icon(LayoutDashboard, "xs"),
			quick: true,
			run: (e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); },
		},
		{
			id: "copy-link",
			label: "Copy link",
			icon: icon(Link, "xs"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); void copySidebarLink(goalDeepLink(goal.id), "Copy goal link"); },
		},
	);
	// Mirror the goal-row PR badge exactly: only offer "Open on GitHub" when that
	// coloured PR icon is actually rendered (PR present, and for workflow goals
	// all gates passed) and a PR url exists to link to. Branch-only goals show no
	// badge, so they get no menu item either.
	const prBadge = resolveGoalPrBadge(goal);
	if (prBadge.show && prBadge.url) {
		const url = prBadge.url;
		actions.push({
			id: "open-github",
			label: "Open on GitHub",
			icon: goalPrIconSvg(prBadge.color, "1.2em"),
			quick: false,
			run: (e: Event) => { e.stopPropagation(); openExternalUrl(url); },
		});
	}
	return actions;
}

function canForkSidebarSession(session: GatewaySession): boolean {
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

function openExternalUrl(url: string): void {
	const opened = window.open(url, "_blank", "noopener");
	try { if (opened) opened.opener = null; } catch { /* ignore */ }
}

function openSessionInNewWindow(sessionId: string): void {
	openExternalUrl(sessionDeepLink(sessionId));
}

function prefetchGoalGithubLink(goalId: string): void {
	const cached = getCachedGoalGithubLink(goalId);
	if (cached?.available) return;
	void fetchGoalGithubLink(goalId, { skipRender: true, force: cached?.available === false })
		.then(() => {
			if (_openSidebarActionsPopover?.kind === "goal" && _openSidebarActionsPopover.entityId === goalId) {
				refreshOpenSidebarActionsPopover();
				renderApp();
			}
		})
		.catch(() => undefined);
}

// Keep the imported response type pinned to this module's action cache contract.
void (undefined as GoalGithubLinkResponse | undefined);

// ============================================================================
// ARCHIVED BUCKETING (shared between desktop sidebar and mobile landing)
// ============================================================================

export interface ArchivedBucket {
	archivedGoals: Goal[];
	standaloneArchivedSessions: GatewaySession[];
}

/**
 * Bucket filtered archived goals + standalone archived sessions by project id.
 * Items without a projectId, or with a projectId that doesn't match any registered
 * project, are skipped with a console.warn — there is no silent fallback bucket.
 * Returns a Map keyed by project id.
 */
export function bucketArchivedByProject(
	archivedGoals: Goal[],
	standaloneArchivedSessions: GatewaySession[],
	projects: Project[],
): Map<string, ArchivedBucket> {
	const map = new Map<string, ArchivedBucket>();
	for (const p of projects) map.set(p.id, { archivedGoals: [], standaloneArchivedSessions: [] });
	for (const g of archivedGoals) {
		if (!g.projectId) { console.warn("[sidebar] archived goal with no projectId — skipping", g.id); continue; }
		const bucket = map.get(g.projectId);
		if (!bucket) { console.warn("[sidebar] archived goal has no matching project bucket — skipping", g.id, g.projectId); continue; }
		bucket.archivedGoals.push(g);
	}
	for (const s of standaloneArchivedSessions) {
		if (!s.projectId) { console.warn("[sidebar] archived session with no projectId — skipping", s.id); continue; }
		const bucket = map.get(s.projectId);
		if (!bucket) { console.warn("[sidebar] archived session has no matching project bucket — skipping", s.id, s.projectId); continue; }
		bucket.standaloneArchivedSessions.push(s);
	}
	return map;
}

/**
 * Render the collapsible per-project Archived subsection.
 *
 * Shared between desktop (`renderSidebar` in sidebar.ts) and mobile
 * (`renderMobileLanding` in render.ts). Collapse state is persisted via
 * `isArchivedSectionExpanded` / `setArchivedSectionExpanded` under the
 * shared localStorage key `bobbit-archived-collapsed-projects`.
 *
 * Returns "" when showArchived is off OR the project has no archived items.
 *
 * `variant: "desktop"` matches the original tight desktop styling.
 * `variant: "mobile"` uses larger touch targets and typography.
 */
/**
 * Render a sub-goal under its spawning team-lead session. Recursive — the
 * sub-goal may itself be a parent of further sub-goals (a team-lead it
 * spawned could spawn its own sub-goals). Reuses `renderGoalGroup` so the
 * row, chevron, descendant badge, and team rendering match the rest of the
 * sidebar. Indent is one INDENT step relative to the parent's
 * tlExpanded container.
 *
 * `renderedAncestors` is the set of goal ids that have already rendered as
 * an ancestor of this row. If `child.id` is already in the set we render a
 * compact "(loop)" placeholder instead of recursing — defensive guard
 * against any data anomaly that could let a descendant point back at an
 * ancestor (createGoal rejects true id-cycles, but the render path
 * shouldn't trust the data layer to be perfect).
 */
function renderSpawnedChildGoalRow(
	child: Goal,
	renderedAncestors?: Set<string>,
	displayTitleSuffix?: string,
): TemplateResult {
	if (isAncestorCycle(child.id, renderedAncestors)) {
		return html`
			<div class="text-[10px] text-muted-foreground/70 italic px-1 py-0.5"
				data-testid="sidebar-spawned-child-row-loop"
				data-goal-id="${child.id}"
				title="${child.title} appears earlier in this tree — loop detected.">
				↺ ${child.title} (already shown above)
			</div>
		`;
	}
	const descendantCount = state.goals.filter(g => !g.archived && g.parentGoalId === child.id).length;
	return html`
		<div data-testid="sidebar-spawned-child-row" data-goal-id="${child.id}" data-spawned-by="${child.spawnedBySessionId ?? ""}">
			${renderGoalGroup(child, { descendantCount, renderedAncestors, displayTitleSuffix })}
		</div>
	`;
}

/**
 * Render the bottom Archived-section's goal list with hierarchy preserved.
 * Pure intra-archived nesting: goals whose parent is also archived nest
 * under that parent; truly orphaned (parent missing or non-archived) goals
 * surface at the top via the helper's orphan-promotion. Indentation uses
 * the same 16px-per-level scheme as the live forest.
 */
function renderArchivedGoalsForest(archivedGoals: Goal[], isMobile: boolean): TemplateResult {
	// Symmetric to the live forest filter in sidebar.ts: exclude archived
	// goals whose `spawnedBySessionId` points at an archived team-lead
	// session in this same tree. Without this filter the same goal renders
	// TWICE — once as a child node in the archived forest, and again under
	// its team-lead's expanded block via renderLeadWithMembers's
	// `spawnedSubGoalsOf`. The user's image #43 was that exact symptom: 19
	// real children of REAL-TASKS appeared once via the forest's nested
	// rendering AND a second time under Team Lead Al Truist's spawned-
	// children block, producing visually-identical "duplicates".
	const archivedTeamLeadIds = new Set(
		state.archivedSessions
			.filter(s => s.role === "team-lead")
			.map(s => s.id),
	);
	const filteredArchivedGoals = archivedGoals.filter(g =>
		!g.spawnedBySessionId || !archivedTeamLeadIds.has(g.spawnedBySessionId),
	);
	const forest = buildNestedGoalForest(filteredArchivedGoals as any, { maxDepth: 5, includeArchived: true });
	// Same collapse-hides-children behaviour as the live forest in
	// sidebar.ts::renderNestedNode. Archived parents must hide their
	// archived children when their chevron is collapsed — symmetric with
	// how live parents hide live children. The user reported sub-goal
	// rows still showing under a collapsed archived parent.
	const renderArcNode = (node: { goal: any; depth: number; descendantCount: number; children: any[]; displayTitleSuffix?: string }): TemplateResult => {
		const indentPx = node.depth * 16;
		const goal = node.goal as Goal;
		const isExpanded = expandedGoals.has(goal.id);
		return html`
			<div data-testid="sidebar-archived-row" data-depth="${node.depth}" data-goal-id="${goal.id}" style="padding-left:${indentPx}px;">
				${isMobile
					? html`<div class="opacity-60">${renderGoalGroup(goal, { descendantCount: node.descendantCount, displayTitleSuffix: node.displayTitleSuffix })}</div>`
					: renderGoalGroup(goal, { descendantCount: node.descendantCount, displayTitleSuffix: node.displayTitleSuffix })}
			</div>
			${isExpanded ? node.children.map((c: any) => renderArcNode(c)) : nothing}
		`;
	};
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT / 2}px;">
		${forest.map(node => renderArcNode(node))}
	</div>`;
}

export function renderProjectArchivedSection(
	project: Project,
	archivedGoals: Goal[],
	standaloneArchivedSessions: GatewaySession[],
	variant: "desktop" | "mobile" = "desktop",
): TemplateResult | string {
	if (!state.showArchived) return "";
	if (archivedGoals.length === 0 && standaloneArchivedSessions.length === 0) return "";
	const expanded = isArchivedSectionExpanded(project.id);
	const archHeaderNavId = `archived-header:${project.id}`;
	const archHeaderActive = getActiveNavId() === archHeaderNavId;
	const isMobile = variant === "mobile";
	const headerSize = isMobile ? "sm" : "xs";
	const headerPy = isMobile ? "py-1.5" : "py-0.5";
	const labelClass = "flex-1 text-muted-foreground uppercase tracking-wider font-medium opacity-60";
	const labelStyle = isMobile ? "font-size: 1.1667em;" : "font-size: 0.75em;";
	return html`
		<div class="border-t border-border/30 my-1 mx-2"></div>
		<div class="flex flex-col gap-0.5">
			<button
				data-nav-id=${archHeaderNavId}
				data-nav-active=${archHeaderActive ? "true" : "false"}
				class="relative flex items-center gap-1 pr-1 ${headerPy} w-full text-left ${archHeaderActive ? "bg-secondary text-foreground sidebar-session-active" : (isMobile ? "active:bg-secondary/50" : "hover:bg-secondary/30")} rounded-md transition-colors"
				style="padding-left:${HEADER_CHEVRON_W}px;"
				@click=${() => { setArchivedSectionExpanded(project.id, !expanded); renderApp(); }}
			>
				<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none opacity-60" style="width:${HEADER_CHEVRON_W}px;font-size: 1.1667em;">${expanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground opacity-60">${icon(Archive, headerSize)}</span>
				<span class="${labelClass}" style="${labelStyle}">Archived</span>
			</button>
			${expanded ? html`
				${archivedGoals.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Goals</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${archivedGoals.length > 0 ? renderArchivedGoalsForest(archivedGoals, isMobile) : ""}
				${archivedGoals.length > 0 && standaloneArchivedSessions.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Sessions</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${standaloneArchivedSessions.length > 0 ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${standaloneArchivedSessions.map(s => html`
						${renderArchivedSessionRow(s)}
						${renderArchivedDelegates(s.id)}
					`)}
				</div>` : ""}
			` : ""}
		</div>
	`;
}

export function renderSessionRow(session: GatewaySession) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const preparing = session.status === "preparing" || session.status === "starting";
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;

	// Check for children (live delegates + first-class child sessions + archived children)
	const liveChildren = visibleLiveChildrenForParent(session.id);
	const archivedChildren = state.showArchived ? archivedChildrenForParent(session.id) : [];
	const hasChildren = liveChildren.length > 0 || archivedChildren.length > 0;
	const hasFirstClassChild = liveChildren.some(isFirstClassChildSession);
	const childrenExpanded = hasChildren && (hasFirstClassChild
		? isFirstClassParentExpanded(session.id)
		: isArchivedParentExpanded(session.id));

	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const actions = buildSessionSidebarActions(session, displayTitle);
	const actionRefresh = () => buildSessionSidebarActions(session, displayTitle);
	const buttons = html`${renderSidebarQuickActions(actions, { mobile, btnPad })}${renderSidebarActionsTrigger({ kind: "session", entityId: session.id, actions, mobile, btnPad, refresh: actionRefresh, onBeforeOpen: () => { _forkNewWorktree = true; } })}`;

	const navId = `session:${session.id}`;
	// Keyboard nav can have moved the active row away from this session even
	// while `state.selectedSessionId` (and thus `activeSessionId()`) still
	// reports it as active — the route mutations that clear it run async via
	// `handleHashChange`. The `sidebar-session-active` class and `data-nav-active`
	// attribute are the single source of truth for "which row is currently the
	// keyboard cursor / E2E active row", so they MUST respect a non-matching
	// keyboard-nav override. Without this, two rows can carry the active class
	// for a few ms after Ctrl+↓ off a session row, and any DOM-order based
	// active-row query (incl. the sidebar-keyboard-nav E2E) reads the stale
	// session row instead of the new target. Pinned by
	// tests/e2e/ui/sidebar-keyboard-nav.spec.ts.
	const kbOverride = getActiveNavId();
	const navActive = kbOverride ? kbOverride === navId : active;
	return html`
		<div
			data-session-id="${session.id}"
			data-sidebar-actions-row-root
			data-nav-id=${navId}
			data-nav-active=${navActive ? "true" : "false"}
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
				${navActive ? `bg-secondary text-foreground sidebar-session-active${hasChildren ? "" : " sidebar-active-no-chevron"}` : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			${mobile ? "" : html``}
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
			@auxclick=${(e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); openSessionInNewWindow(session.id); } }}
		>
			${hasChildren ? html`<span
				class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none cursor-pointer"
				style="width:${CHEVRON_W}px;font-size: 1em;"
				@click=${(e: Event) => { e.stopPropagation(); if (hasFirstClassChild) toggleFirstClassParentExpanded(session.id); else toggleArchivedParentExpanded(session.id); renderApp(); }}
			>${childrenExpanded ? "▾" : "▸"}</span>` : ""}
			<div class="shrink-0 flex items-center justify-center ${!active && hasUnseenActivity(session) ? "bobbit-unread-pulse" : ""}">
				${connecting || preparing
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder", session.accessory, false, !active && hasUnseenActivity(session))}
			</div>
			<div class="flex-1 min-w-0 flex flex-col justify-center">
				<div class="${mobile ? "flex items-center gap-1 min-w-0" : "truncate min-w-0"} font-normal"><span class="truncate" style="${mobile ? "font-size: 1.3333em;" : ""}">${renderSessionTitle(displayTitle, isActive, state.searchQuery)}</span>${preparing ? html`<span class="shrink-0 text-muted-foreground/60 italic ml-1" style="font-size: 0.8333em;">preparing…</span>` : ""}${mobile ? html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span>${renderSessionTime(session)}` : ""}</div>
			</div>
			${mobile
				? buttons
				: html`
					<span class="group-hover:hidden group-focus-within:hidden absolute right-0 top-0 bottom-0 flex items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions absolute right-0 top-0 bottom-0 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
						${buttons}
					</div>`}
		</div>
		${childrenExpanded ? html`${renderLiveDelegates(session.id)}${state.showArchived ? renderArchivedDelegates(session.id, true) : ""}` : ""}
	`;
}

function isArchivedOrTerminalSession(session: GatewaySession): boolean {
	return session.archived === true || session.status === "terminated" || session.status === "archived";
}

function visibleLiveChildrenForParent(parentSessionId: string): GatewaySession[] {
	const bypassFilters = !!state.searchQuery.trim();
	return state.gatewaySessions.filter(s =>
		sessionParentId(s) === parentSessionId
		&& (state.showArchived || !isArchivedOrTerminalSession(s))
		&& (isFirstClassChildSession(s) || passesSidebarFilters(s, s.id === activeSessionId(), bypassFilters)));
}

function archivedChildrenForParent(parentSessionId: string): GatewaySession[] {
	const gatewayChildIds = new Set(state.gatewaySessions
		.filter(s => sessionParentId(s) === parentSessionId)
		.map(s => s.id));
	return state.archivedSessions.filter(s => sessionParentId(s) === parentSessionId && !gatewayChildIds.has(s.id));
}

/** Render live delegate sessions nested under a parent session. */
function renderLiveDelegates(parentSessionId: string): TemplateResult | string {
	const children = visibleLiveChildrenForParent(parentSessionId);
	if (children.length === 0) return "";
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
		${children.map(s => isArchivedOrTerminalSession(s)
			? html`${renderArchivedSessionRow(s)}${state.showArchived ? renderArchivedDelegates(s.id) : ""}`
			: renderSessionRow(s))}
	</div>`;
}

// ============================================================================
// ARCHIVED SESSION ROW
// ============================================================================

export function renderArchivedSessionRow(session: GatewaySession, extraChildren = false) {
	const mobile = !isDesktop();
	const active = activeSessionId() === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const delegates = archivedChildrenForParent(session.id);
	const hasChildren = delegates.length > 0 || extraChildren;
	const expanded = hasChildren && isArchivedParentExpanded(session.id);
	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const archivedNavId = `session:${session.id}`;
	return html`
		<div
			data-session-id="${session.id}"
			data-nav-id=${archivedNavId}
			data-nav-active=${active ? "true" : "false"}
			class="group relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
				${active ? `bg-secondary text-foreground sidebar-session-active${hasChildren ? "" : " sidebar-active-no-chevron"}` : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px; filter:grayscale(1); opacity:0.75;"
			@click=${() => connectToSession(session.id, true, { readOnly: true })}
		>
			${hasChildren ? html`<span
				class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none cursor-pointer"
				style="width:${CHEVRON_W}px;font-size: 1em;"
				@click=${(e: Event) => { e.stopPropagation(); toggleArchivedParentExpanded(session.id); renderApp(); }}
				title="${expanded ? "Collapse" : "Expand"}"
			>${expanded ? "▾" : "▸"}</span>` : ""}
			<div class="shrink-0 flex items-center justify-center">
				${statusBobbit("terminated", false, session.id, active, false, session.role === "team-lead", session.role === "coder", session.accessory)}
			</div>
			<div class="flex-1 min-w-0 font-normal truncate" style="${mobile ? "font-size: 1.3333em;" : ""}">${renderHighlightedText(displayTitle, state.searchQuery)}</div>
			${session.archivedAt ? html`<span class="shrink-0 text-muted-foreground" style="${mobile ? "font-size: 1em;" : "font-size: 0.8333em;"}">${terseRelativeTime(session.archivedAt)}</span>` : ""}
		</div>
	`;
}

/** Render any archived delegate sessions nested under a parent session. */
export function renderArchivedDelegates(parentSessionId: string, forceExpanded = false): TemplateResult | string {
	if (!state.showArchived) return "";
	if (!forceExpanded && !isArchivedParentExpanded(parentSessionId)) return "";
	const delegates = archivedChildrenForParent(parentSessionId);
	if (delegates.length === 0) return "";
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
		${delegates.map(s => html`
			${renderArchivedSessionRow(s)}
			${renderArchivedDelegates(s.id)}
		`)}
	</div>`;
}

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

	const goalId = session.goalId || session.teamGoalId;

	const actions = buildTeamLeadSidebarActions(session, displayTitle, goalId);
	const actionRefresh = () => buildTeamLeadSidebarActions(session, displayTitle, goalId);
	const buttons = html`${renderSidebarQuickActions(actions, { mobile, btnPad })}${renderSidebarActionsTrigger({ kind: "session", entityId: session.id, actions, mobile, btnPad, refresh: actionRefresh })}`;

	const chevron = html`<span
		class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none cursor-pointer"
		style="width:${CHEVRON_W}px;font-size: 1.1667em;"
		@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(session.id); renderApp(); }}
		title="${expanded ? "Collapse agents" : "Expand agents"}"
	>${expanded ? "▾" : "▸"}</span>`;

	void childCount; // available if needed later

	const tlNavId = `session:${session.id}`;
	return html`
		<div
			data-session-id="${session.id}"
			data-sidebar-actions-row-root
			data-nav-id=${tlNavId}
			data-nav-active=${active ? "true" : "false"}
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
			@auxclick=${(e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); openSessionInNewWindow(session.id); } }}
		>
			${chevron}
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, true, false, session.accessory)}
			</div>
			<div class="flex-1 min-w-0 ${mobile ? "flex items-center gap-1" : "truncate"} font-normal" style="${mobile ? "font-size: 1.3333em;" : ""}"><span class="${mobile ? "truncate" : ""}">${renderSessionTitle(displayTitle, isActive, state.searchQuery)}</span>${mobile ? html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span>${renderSessionTime(session)}` : ""}</div>
			${mobile
				? buttons
				: html`
					<span class="group-hover:hidden group-focus-within:hidden absolute right-0 top-0 bottom-0 flex items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions absolute right-0 top-0 bottom-0 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
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
 * Render the goal's `(passed/total)` gate-progress badge.
 *
 * Reads `state.gateStatusCache` + the live goal sessions exactly like the
 * sidebar's `renderGoalBadge` did — extracted so the chat-header
 * `<goal-status-widget>` can render the same badge with the same visual
 * vocabulary. Returns "" when no gate-status entry is cached for the goal.
 *
 * Pinned by sidebar visual tests — the output here must stay byte-identical
 * to the previous inline implementation when invoked from `renderGoalBadge`.
 */
export function renderGateProgressBadge(goalId: string): TemplateResult | string {
	const gs = state.gateStatusCache.get(goalId);
	if (!gs) return "";
	const bypassed = gs.bypassed ?? 0;
	// A human bypass means ≥1 gate was forced past verification. The numerator
	// counts bypassed gates as resolved (so a fully-resolved goal reads N/N), the
	// badge gets a trailing `!`, and every state is tinted red to flag that this
	// is NOT a clean pass. The wave/blink animations are preserved — only the
	// colour changes — so a working/verifying team still reads as live.
	const isBypass = bypassed > 0;
	const RED = "#dc2626";
	const suffix = isBypass ? "!" : "";

	const goalAgents = state.gatewaySessions.filter(s => (s.goalId === goalId || s.teamGoalId === goalId) && !isChildSession(s));
	const hasTeam = goalAgents.some(s => s.role === "team-lead" && s.status !== "terminated");
	const anyAgentWorking = goalAgents.some(s => s.status === "streaming" || s.status === "busy" || s.isCompacting);
	const numerator = gs.passed + bypassed;
	const allPassed = numerator === gs.total;
	const color = isBypass ? RED : (!hasTeam ? "#6b7280" : allPassed ? "#22c55e" : anyAgentWorking ? "#3b82f6" : "#7a8ea8");
	const baseStyle = `font-size:0.75em;color:${color};font-weight:600;letter-spacing:-0.02em;white-space:nowrap;`;
	const resolvedTitle = isBypass
		? `${numerator} of ${gs.total} gates resolved — ${bypassed} bypassed (NOT a clean pass)`
		: `${gs.passed} of ${gs.total} gates passed`;
	if (gs.verifying && gs.verifyingCount > 0) {
		// Verifying state is blue (red when a bypass is in play) — override the base
		// colour which may be muted when agents are idle.
		// Clamp the animated numerator because an already-passed gate can be re-signaled
		// and running while the stored pass count is still true in server history.
		const verifyStyle = `font-size:0.75em;color:${isBypass ? RED : "#3b82f6"};font-weight:600;letter-spacing:-0.02em;white-space:nowrap;`;
		const displayed = Math.min(gs.total, numerator + gs.verifyingCount);
		const verifyTitle = isBypass
			? `${numerator} of ${gs.total} gates resolved (${bypassed} bypassed) — verifying ${gs.verifyingCount}`
			: `${gs.passed} of ${gs.total} gates passed — verifying ${gs.verifyingCount}`;
		return html`<span class="shrink-0" style="${verifyStyle}" title="${verifyTitle}"><span style="opacity:0.7">(</span><span class="gate-blink" style="animation: gate-blink 1.2s ease-in-out infinite">${displayed}</span><span style="opacity:0.7">/${gs.total})${suffix}</span></span>`;
	}
	if (!allPassed && hasTeam && anyAgentWorking) {
		// Wave animation only when agents are actively working.
		const label = `(${numerator}/${gs.total})${suffix}`;
		const chars = label.split("");
		const totalDur = 1.2;
		const stagger = totalDur / chars.length;
		return html`<span class="shrink-0 gate-wave" style="${baseStyle}" title="${resolvedTitle}">${chars.map((ch, i) =>
			html`<span style="animation-delay:${(i * stagger).toFixed(2)}s">${ch}</span>`
		)}</span>`;
	}
	return html`<span class="shrink-0" style="${baseStyle}" title="${resolvedTitle}">(${numerator}/${gs.total})${suffix}</span>`;
}

/**
 * Render a small per-gate status icon (check/dot/cross/spinner). Shared
 * between the chat-header `<goal-status-widget>` popover and any other
 * surfaces that need a compact per-gate indicator. Colors mirror the
 * palette used by `renderGateProgressBadge` — green for passed, red for
 * failed, blue for running, muted-foreground for pending.
 */
export function renderGateStatusIcon(status: "pending" | "passed" | "failed" | "running" | "bypassed"): TemplateResult {
	switch (status) {
		case "passed":
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="passed"><polyline points="20 6 9 17 4 12"/></svg>`;
		case "bypassed":
			// Warning/exclamation triangle in red — a human forced this gate past
			// verification; it is NOT a clean pass.
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-label="bypassed"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
		case "failed":
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c47070" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="failed"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		case "running":
			return html`<svg class="shrink-0 animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="running"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
		case "pending":
		default:
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-label="pending" style="color:var(--muted-foreground);opacity:0.6"><circle cx="12" cy="12" r="4"/></svg>`;
	}
}

interface GoalPrBadge {
	show: boolean;
	color: string;
	url: string | null;
	label: string;
	hasConflicts: boolean;
}

/**
 * Resolve whether the goal-row PR badge should render, and its derived color,
 * url, and label. Single source of truth shared by `renderGoalBadge` (the
 * sidebar row icon) and `buildGoalSidebarActions` (the "Open on GitHub" menu
 * item) so the two never drift. Workflow progress is primary: PR status is
 * only surfaced after a positive, fully-passed gate summary exists; before
 * that, PR state must not mask incomplete/verifying/uncached workflow
 * progress. Non-workflow goals have no gate summary to wait for, so they
 * preserve the PR badge fallback.
 */
function resolveGoalPrBadge(goal: Goal): GoalPrBadge {
	const hidden: GoalPrBadge = { show: false, color: "", url: null, label: "", hasConflicts: false };
	const gs = state.gateStatusCache.get(goal.id);
	const pr = state.prStatusCache.get(goal.id);
	const hasWorkflowGates = !!goal.workflowId || (goal.workflow?.gates?.length ?? 0) > 0;
	if (!pr || (hasWorkflowGates && (!gs || gs.total <= 0 || gs.passed !== gs.total))) return hidden;

	let color: string;
	if (pr.state === "MERGED") color = "#a87fd4";
	else if (pr.state === "CLOSED") color = "#c47070";
	else if (pr.reviewDecision === "APPROVED") color = "#6bc485";
	else if (pr.reviewDecision === "CHANGES_REQUESTED") color = "#c47070";
	else if (pr.reviewDecision === "REVIEW_REQUIRED") color = "#d4a04a";
	else color = "#6bc485";
	const reviewLabel = pr.state === "OPEN" && pr.reviewDecision === "REVIEW_REQUIRED" ? " — awaiting review"
		: pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED" ? " — changes requested"
		: pr.state === "OPEN" && pr.reviewDecision === "APPROVED" ? " — approved"
		: "";
	const hasConflicts = pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
	const label = (pr.number ? `PR #${pr.number} ${pr.state.toLowerCase()}` : `PR ${pr.state.toLowerCase()}`) + reviewLabel + (hasConflicts ? " — has conflicts" : "");
	return { show: true, color, url: pr.url ?? null, label, hasConflicts };
}

/** The goal-row pull-request SVG, in the state-derived stroke color. */
function goalPrIconSvg(color: string, size = "12"): TemplateResult {
	return html`<svg class="shrink-0" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>`;
}

/** Render a PR icon or gate status badge next to a goal in the sidebar. */
function renderGoalBadge(goal: Goal) {
	const gateBadge = renderGateProgressBadge(goal.id);
	const badge = resolveGoalPrBadge(goal);
	if (!badge.show) return gateBadge;
	const prIcon = goalPrIconSvg(badge.color);
	if (badge.url) {
		return html`<a class="shrink-0 flex items-center ${badge.hasConflicts ? "pr-conflict-pulse" : ""}" href=${badge.url} target="_blank" rel="noopener" title=${badge.label} @click=${(e: Event) => e.stopPropagation()}>${prIcon}</a>`;
	}
	return html`<span class="shrink-0 flex items-center ${badge.hasConflicts ? "pr-conflict-pulse" : ""}" title=${badge.label}>${prIcon}</span>`;
}

/**
 * Expandable goal group used by both desktop sidebar and mobile landing.
 *
 * Layout: [▾/▸] [TITLE] [dashboard btn]
 * Expanded: child session rows + empty state + team controls
 *
 * Desktop: dashboard button hidden until hover. Double-click opens team-lead.
 * Mobile:  dashboard button always visible. No double-click (no hover hint).
 */
export function renderGoalGroup(goal: Goal, opts?: { descendantCount?: number; renderedAncestors?: Set<string>; displayTitleSuffix?: string }) {
	const mobile = !isDesktop();
	const isExpanded = expandedGoals.has(goal.id);
	// `goalSessions` is the full, unfiltered roster of sessions belonging to this
	// goal. It drives badges, gate counts, `hasActiveTeam`, `isWorkMerged`,
	// `hasActiveSession`, and the on-demand team-agents fetch below — all of
	// which must reflect REAL goal state, not the user's current filter view.
	const goalSessions = state.gatewaySessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s)).sort((a, b) => a.createdAt - b.createdAt);
	const isCreatingHere = state.creatingSessionForGoalId === goal.id;
	const isTeamGoal = !!(goal as any).team;
	const hasActiveTeam = isTeamGoal && goalSessions.some((s) => s.role === "team-lead" && s.status !== "terminated");

	// `displaySessions` is the FILTERED subset used for actually rendering rows.
	// Mirrors the Show Busy / Show Read handling at sidebar.ts:964,
	// render.ts:272, and the delegate-child paths in renderSessionRow (~line 445)
	// and renderLiveDelegates. Active session is exempt (handled inside
	// `passesSidebarFilters`). A non-empty search bypasses filters entirely.
	// Team-lead-sticky: if the natural team-lead would be filtered out but any
	// team child still passes, keep the lead so it can host the child row
	// (mirrors how delegate parents stay visible when a delegate survives the
	// filter). Lead is re-inserted at its natural createdAt position.
	const bypassFilters = !!state.searchQuery.trim();
	const filteredGoalSessions = goalSessions.filter((s) =>
		passesSidebarFilters(s, s.id === activeSessionId(), bypassFilters));
	let displaySessions = filteredGoalSessions;
	if (isTeamGoal) {
		const naturalLead = goalSessions.find((s) => s.role === "team-lead");
		if (naturalLead && !filteredGoalSessions.includes(naturalLead) && filteredGoalSessions.length > 0) {
			displaySessions = [naturalLead, ...filteredGoalSessions].sort((a, b) => a.createdAt - b.createdAt);
		}
	}
	const isLoading = teamLoading.has(goal.id);
	const isPreparing = goal.setupStatus === "preparing";

	// On-demand fetch for expanded goals with no visible children
	if (isExpanded && isTeamGoal && goalSessions.length === 0 && !_goalChildrenFetched.has(goal.id)) {
		const archivedChildren = state.archivedSessions.filter(s => s.teamGoalId === goal.id);
		if (archivedChildren.length === 0) {
			_goalChildrenFetched.add(goal.id);
			gatewayFetch(`/api/goals/${goal.id}/team/agents?include=archived`)
				.then(r => r.ok ? r.json() : null)
				.then(data => {
					if (data?.agents?.length > 0) {
						const existingIds = new Set(state.archivedSessions.map(s => s.id));
						for (const agent of data.agents) {
							if (!existingIds.has(agent.sessionId)) {
								state.archivedSessions.push({
									id: agent.sessionId,
									title: agent.title || agent.role,
									role: agent.role,
									status: "archived",
									teamGoalId: goal.id,
									teamLeadSessionId: agent.teamLeadSessionId,
									createdAt: agent.createdAt || Date.now(),
									archivedAt: agent.archivedAt,
								} as any);
							}
						}
						renderApp();
					}
				})
				.catch(() => {});
		}
	}

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

	const btnPad = mobile ? "p-1.5" : "p-0.5";
	const pr = state.prStatusCache.get(goal.id);
	const showArchive = !goal.archived;
	const isWorkMerged = !goal.archived && pr?.state === "MERGED" && !hasActiveTeam;
	const hasActiveSession = goalSessions.some((s) => s.status !== "terminated");
	const goalActions = buildGoalSidebarActions(goal, { hasActiveSession, showArchive });
	const goalActionRefresh = () => buildGoalSidebarActions(goal, { hasActiveSession, showArchive });
	const goalButtons = html`${renderSidebarQuickActions(goalActions, { mobile, btnPad })}${renderSidebarActionsTrigger({ kind: "goal", entityId: goal.id, actions: goalActions, mobile, btnPad, refresh: goalActionRefresh, onBeforeOpen: () => prefetchGoalGithubLink(goal.id) })}`;

	const emptyState = html`
		<div class="pl-2 py-1 text-muted-foreground" style="${mobile ? "" : "font-size: 0.9167em;"}">
			${goal.archived
				? html`<span style="color:var(--text-tertiary)">Archived</span>`
				: isWorkMerged
				? html`<span style="vertical-align:middle">Work merged —</span> <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-secondary/50 text-muted-foreground font-normal hover:bg-secondary/80 hover:text-foreground transition-colors align-middle" style="font-size: 0.8333em;" title="Archive goal" @click=${(e: Event) => { e.stopPropagation(); deleteGoal(goal.id); }}>${icon(Trash2, "xs")}Archive</button>`
				: isTeamGoal
				? html`<span style="vertical-align:middle">No agents —</span> <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-primary/10 text-primary font-semibold hover:bg-primary/20 transition-colors align-middle ${isPreparing ? "opacity-60 pointer-events-none" : ""}" style="font-size: 0.8333em;" title="${isPreparing ? "Setting up worktree\u2026" : "Start team"}" @click=${handleStartTeam} ?disabled=${isLoading || isPreparing}>${isPreparing ? html`<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>` : html`<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12h12v1.5H2V12zm0-1L1 4l4 3 3-5 3 5 4-3-1 7H2z"/></svg>`}${isLoading ? "Starting\u2026" : isPreparing ? "Setting up\u2026" : "Start Team"}</button>`
				: html`No sessions — <button class="inline-flex items-center gap-1 px-1.5 py-px rounded bg-primary/10 text-primary font-semibold hover:bg-primary/20 transition-colors" title="Start a session" @click=${() => createAndConnectSession(goal.id)}><svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3l8 5-8 5V3z"/></svg>start one</button>`}
		</div>
	`;

	const teamControls = "";

	// Separate team lead from team children for nested rendering. Partitions are
	// computed from `displaySessions` (the filtered view), NOT `goalSessions`,
	// so the Show Busy / Show Read toggles actually affect what gets rendered.
	const teamLead = isTeamGoal ? displaySessions.find(s => s.role === "team-lead") : null;
	const teamChildren = isTeamGoal && teamLead ? displaySessions.filter(s => s.id !== teamLead.id) : [];
	const nonTeamSessions = isTeamGoal ? displaySessions.filter(s => !teamLead || (s.id !== teamLead.id && !teamChildren.includes(s))) : displaySessions;

	const renderTeamGroup = () => {
		if (!teamLead) return displaySessions.map(renderSessionRow);
		const tlExpanded = isTeamLeadExpanded(teamLead.id);
		// Archived members belonging to the live lead. Includes:
		//  (a) explicit link: `teamLeadSessionId === teamLead.id`
		//  (b) legacy fallback: `teamLeadSessionId` undefined — the live lead
		//      is the safest receiver because it's the agent the user is
		//      most likely watching. Without this, legacy reviewer/QA
		//      sessions (which never stamped the field) vanish entirely
		//      under a live team-lead. The boot-time backfill in
		//      SessionStore stamps most of these via heuristic; this
		//      render-side fallback covers ambiguous remainders.
		const archivedForLiveLead = state.showArchived
			? state.archivedSessions.filter(s =>
				s.teamGoalId === goal.id
				&& !isChildSession(s)
				&& s.role !== "team-lead"
				&& (s.teamLeadSessionId === teamLead.id || !s.teamLeadSessionId)
			)
			: [];
		// Delegate sessions of this lead are rendered separately (renderLiveDelegates /
		// renderArchivedDelegates); keep their counts for the team-lead row badge.
		const liveLeadChildren = visibleLiveChildrenForParent(teamLead.id);
		const archivedLeadChildren = state.showArchived ? archivedChildrenForParent(teamLead.id) : [];
		// Sub-goals this team-lead spawned (via goal_spawn_child).
		// They render INSIDE this team-lead's expanded block so collapsing
		// the team-lead also hides them — matches the user's mental model
		// that the team-lead "owns" the sub-goals it created. The badge on
		// the team-lead row counts agents+archived but NOT spawned sub-goals
		// (sub-goals already advertise themselves via the parent goal's
		// descendant-count badge).
		//
		// Defensive shaping (filter, dedupe by id, deterministic sort) lives
		// in the pure helper so it's unit-testable. See sidebar-spawned-children.ts.
		// `parentLeadId === teamLead.id` here: by construction this branch is
		// rendering THIS goal's own live team-lead, so unstamped children of
		// `goal` should attribute to it. The strict-parent fallback in
		// selectSpawnedChildren prevents an unstamped orphan from being
		// pulled under a sibling team-lead.
		const spawnedChildren = selectSpawnedChildren(
			state.goals,
			goal.id,
			teamLead.id,
			state.showArchived,
			teamLead.id,
		);
		// Cycle guard: build the visited-ancestors set we'll thread through
		// each child's renderGoalGroup call. Includes this goal's id so any
		// descendant that — via a data anomaly — points back at this goal as
		// a child won't recurse infinitely.
		const ancestors = extendAncestors(opts?.renderedAncestors, goal.id);
		// Disambiguator suffixes for same-titled spawned siblings — same
		// pattern as buildNestedGoalForest's sibling-title pass so the live
		// and archived paths render identical "(<suffix>)" tags.
		const liveSuffixes = computeTitleSuffixes(spawnedChildren);

		// Active-before-archived ordering: emit live team children + active
		// spawned-child goals first, then a single muted "Archived · <lead>"
		// divider, then archived team workers + archived spawned-child goals.
		// Owner label disambiguates dividers when multiple team-leads stack in
		// the same expanded subtree (Bugs Bunny → Otis → Zoidberg repro).
		const { active: activeSpawned, archived: archivedSpawned } = bucketActiveArchived(
			spawnedChildren,
			g => !!g.archived,
		);
		// Split teamChildren by status: live members render above the
		// "Archived" divider, terminated/archived ones merge into the
		// archived bucket below (deduped against archivedForLiveLead — a
		// session can appear in both gatewaySessions with
		// status="terminated" AND in archivedSessions after the purge).
		// See team-archived-bucket.ts for the pure helper + tests.
		const { liveTeamChildren, archivedBelow } = bucketTeamChildren(
			teamChildren,
			archivedForLiveLead,
			state.showArchived,
		);
		const hasArchivedBelow = archivedBelow.length > 0 || archivedSpawned.length > 0;
		const hasActiveAbove = liveTeamChildren.length > 0 || activeSpawned.length > 0;
		return html`
			${renderTeamLeadRow(teamLead, liveTeamChildren.length + archivedBelow.length + liveLeadChildren.length + archivedLeadChildren.length, tlExpanded)}
			${tlExpanded ? html`${renderLiveDelegates(teamLead.id)}${state.showArchived ? renderArchivedDelegates(teamLead.id, true) : ""}` : ""}
			${tlExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${liveTeamChildren.map(renderSessionRow)}
					${activeSpawned.map(child => renderSpawnedChildGoalRow(child, ancestors, liveSuffixes.get(child.id)))}
					${hasActiveAbove && hasArchivedBelow ? archivedDivider(teamLead.title) : ""}
					${archivedBelow.map(s => html`
						${renderArchivedSessionRow(s)}
						${renderArchivedDelegates(s.id)}
					`)}
					${archivedSpawned.map(child => renderSpawnedChildGoalRow(child, ancestors, liveSuffixes.get(child.id)))}
				</div>
			` : ""}
			${nonTeamSessions.map(renderSessionRow)}
		`;
	};

	const goalNavId = `goal:${goal.id}`;
	const goalNavActive = getActiveNavId() === goalNavId;
	return html`
		<div class="flex flex-col ${goal.state === "shelved" ? "opacity-60" : ""}">
			<div class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${mobile ? "py-1" : "py-0.5"} rounded-md cursor-pointer ${goalNavActive ? "bg-secondary text-foreground sidebar-session-active" : (mobile ? "active:bg-secondary/50" : "hover:bg-secondary/50")} transition-colors"
				data-sidebar-actions-row-root
				data-nav-id=${goalNavId}
				data-nav-active=${goalNavActive ? "true" : "false"}
				style="padding-left:${HEADER_CHEVRON_W}px;"
				@click=${toggleExpand}
				@dblclick=${!mobile ? () => { if (goal.team) { const tl = goalSessions.find(s => s.role === "team-lead"); if (tl) connectToSession(tl.id, true); } } : null}>
				<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none" style="width:${HEADER_CHEVRON_W}px;font-size: 1.1667em;" title="${isExpanded ? "Collapse goal" : "Expand goal"}">${isExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(GoalIcon, "xs")}</span>
				${goal.setupStatus === "preparing" ? html`<svg class="animate-spin shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>` : goal.setupStatus === "error" ? html`<span class="shrink-0" style="color:var(--destructive);font-size:0.8333em;line-height:1;" title="Worktree setup failed">⚠</span>` : ""}
				<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="${mobile ? "font-size: 1.1667em;" : "font-size: 0.8333em;"}">${renderHighlightedText(goal.title, state.searchQuery)}${opts?.displayTitleSuffix ? html`<span class="ml-1 text-muted-foreground/60 font-mono normal-case tracking-normal" data-testid="sidebar-goal-title-suffix" title="Disambiguator: this goal shares its title with a sibling.">(${opts.displayTitleSuffix})</span>` : ""}</span>
				${(opts?.descendantCount ?? 0) > 0 ? html`
					<span
						class="shrink-0 font-semibold text-muted-foreground"
						data-testid="sidebar-descendant-badge"
						style="background:var(--secondary);padding:0 0.3333em;border-radius:0.5em;line-height:1.1667em;font-size:0.75em;"
						title="${opts!.descendantCount} descendant goal${opts!.descendantCount === 1 ? "" : "s"}">
						${opts!.descendantCount}
					</span>
				` : nothing}
				${renderGoalBadge(goal)}
				${mobile
					? goalButtons
					: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 flex opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
						${goalButtons}
					</div>`}
			</div>
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${displaySessions.length === 0 && !isCreatingHere
						? (goal.archived
							? nothing
							/* Suppress "No agents — Start Team" when the team IS active but its
							   members have all been filtered out by the sidebar filters
							   (Show Busy / Show Read / Show Archived). The active team is
							   still alive — it would be misleading to offer Start Team. */
							: (isTeamGoal && hasActiveTeam ? nothing : emptyState))
						: (isTeamGoal ? renderTeamGroup() : displaySessions.map(renderSessionRow))}
					${isCreatingHere ? html`<div style="padding-left:${CHEVRON_W}px;${mobile ? "" : "font-size: 0.8333em;"}" class="py-1 text-muted-foreground flex items-center gap-1">
						<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
						Creating…
					</div>` : ""}
					${teamControls}
					${state.showArchived ? (() => {
						const archivedForGoal = state.archivedSessions.filter(s => s.teamGoalId === goal.id && !isChildSession(s));
						const archivedLeads = archivedForGoal.filter(s => s.role === "team-lead");
						const archivedMembers = archivedForGoal.filter(s => s.role !== "team-lead");

						// Map each member to its lead (live or archived) via teamLeadSessionId.
						// All leads: live lead first (if any), then archived leads.
						const allLeads = [...(teamLead ? [teamLead.id] : []), ...archivedLeads.map(s => s.id)];
						const membersOf = (leadId: string) => archivedMembers.filter(m => m.teamLeadSessionId === leadId);
						const mappedIds = new Set(archivedMembers.filter(m => m.teamLeadSessionId && allLeads.includes(m.teamLeadSessionId)).map(m => m.id));
						const unmapped = archivedMembers.filter(m => !mappedIds.has(m.id));

						// Sub-goals spawned by an archived team-lead — surfaced
						// inside the archived lead's expanded block. The chevron
						// only renders when there's something to expand, so we
						// roll spawned sub-goals into the hasChildren signal.
						// Same defensive shaping as live spawnedChildren via the
						// shared pure helper. Note we pass `true` for showArchived
						// here since the archived-leads branch is itself gated on
						// `state.showArchived` upstream — we want to include
						// archived sub-goals when this branch runs.
						// Strict-parent attribution: pass leadId itself as parentLeadId
						// because this branch iterates leads that belong to `goal`
						// (live + archived team-leads of THIS goal). An unstamped
						// child of `goal` therefore only attaches to its own parent's
						// lead, never a sibling's.
						const spawnedSubGoalsOf = (leadId: string) =>
							selectSpawnedChildren(state.goals, goal.id, leadId, true, leadId);
						// Cycle guard for the archived-lead branch — same shape as
						// the live branch above.
						const archivedAncestors = extendAncestors(opts?.renderedAncestors, goal.id);

						// Render archived leads, each with their own members + spawned sub-goals
						const renderLeadWithMembers = (lead: GatewaySession, isLast: boolean) => {
							const myMembers = [...membersOf(lead.id), ...(isLast ? unmapped : [])];
							const mySubGoals = spawnedSubGoalsOf(lead.id);
							const hasContent = myMembers.length > 0 || mySubGoals.length > 0;
							const expanded = isArchivedParentExpanded(lead.id);
							// Same disambiguator pass as the live branch.
							const archivedSuffixes = computeTitleSuffixes(mySubGoals);
							return html`
								${renderArchivedSessionRow(lead, hasContent)}
								${renderArchivedDelegates(lead.id)}
								${expanded && hasContent ? html`
									<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
										${myMembers.map(m => html`
											${renderArchivedSessionRow(m)}
											${renderArchivedDelegates(m.id)}
										`)}
										${mySubGoals.map(child => renderSpawnedChildGoalRow(child, archivedAncestors, archivedSuffixes.get(child.id)))}
									</div>
								` : ""}
							`;
						};

						return html`
							${archivedLeads.map((s, i) => renderLeadWithMembers(s, i === archivedLeads.length - 1 && !teamLead))}
						`;
					})() : ""}
				</div>
			` : ""}
		</div>
	`;
}

