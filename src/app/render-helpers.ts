import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { Archive, Goal as GoalIcon, LayoutDashboard, Pencil, RotateCcw, Trash2 } from "lucide";
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
	isArchivedSectionExpanded,
	setArchivedSectionExpanded,
	type GatewaySession,
	type Goal,
	type Project,
} from "./state.js";
import { statusBobbit } from "./session-colors.js";
import { shortcutHint } from "./shortcut-registry.js";
import { connectToSession, terminateSession, createAndConnectSession, startReattempt } from "./session-manager.js";
import { showRenameDialog } from "./dialogs-lazy.js";
import { setHashRoute } from "./routing.js";
import { startTeam, deleteGoal, gatewayFetch } from "./api.js";
import { getActiveNavId } from "./sidebar-nav.js";
import { needsHumanAttention, needsImmediateHumanAttention } from "./notification-policy.js";

// ============================================================================
// FORMATTING
// ============================================================================

/** Guard set to prevent repeated on-demand child fetches per goal. */
const _goalChildrenFetched = new Set<string>();

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
		const affiliated = combined.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf);
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

	// Shared predicate — keeps polling beep, agent_end beep, and unread dot aligned.
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
				${archivedGoals.length > 0 ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT / 2}px;">
					${archivedGoals.map(goal => isMobile ? html`<div class="opacity-60">${renderGoalGroup(goal)}</div>` : renderGoalGroup(goal))}
				</div>` : ""}
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

	// Check for children (live delegates + archived delegates)
	const _bypassFilters = !!state.searchQuery.trim();
	const liveDelegates = state.gatewaySessions.filter(s =>
		s.delegateOf === session.id
		&& (state.showArchived || s.status !== "terminated")
		&& passesSidebarFilters(s, s.id === activeSessionId(), _bypassFilters));
	const archivedDelegates = state.showArchived ? state.archivedSessions.filter(s => s.delegateOf === session.id) : [];
	const hasChildren = liveDelegates.length > 0 || archivedDelegates.length > 0;
	const childrenExpanded = hasChildren && isArchivedParentExpanded(session.id);

	const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
	const btnPad = mobile ? "p-1.5" : "p-0.5";

	const isTeamLead = session.role === "team-lead";

	// Desktop: hover-revealed gradient overlay. Mobile: always-visible inline buttons.
	// Staff-backed sessions: route pencil to the staff editor instead of the
	// rename dialog (per surface-staff-in-sessions design).
	const staffId = session.staffId;
	const pencilTitle = staffId ? "Edit staff" : "Modify";
	const pencilHandler = staffId
		? (e: Event) => { e.stopPropagation(); window.location.hash = `#/staff/${staffId}`; }
		: (e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); };
	const buttons = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${pencilHandler}
			title=${pencilTitle}>${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id); }}
			title=${(isTeamLead ? "End team" : "Terminate") + shortcutHint("terminate-session")}>${icon(Trash2, "xs")}</button>
	`;

	const navId = `session:${session.id}`;
	return html`
		<div
			data-session-id="${session.id}"
			data-nav-id=${navId}
			data-nav-active=${active ? "true" : "false"}
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
				${active ? `bg-secondary text-foreground sidebar-session-active${hasChildren ? "" : " sidebar-active-no-chevron"}` : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			${mobile ? "" : html``}
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			${hasChildren ? html`<span
				class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none cursor-pointer"
				style="width:${CHEVRON_W}px;font-size: 1em;"
				@click=${(e: Event) => { e.stopPropagation(); toggleArchivedParentExpanded(session.id); renderApp(); }}
			>${childrenExpanded ? "▾" : "▸"}</span>` : ""}
			<div class="shrink-0 flex items-center justify-center ${!active && hasUnseenActivity(session) ? "bobbit-unread-pulse" : ""}">
				${connecting || preparing
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder", session.accessory, false, !active && hasUnseenActivity(session))}
			</div>
			<div class="flex-1 min-w-0 flex flex-col justify-center">
				<div class="${mobile ? "flex items-center gap-1 min-w-0" : ""} font-normal"><span class="truncate" style="${mobile ? "font-size: 1.3333em;" : ""}">${renderSessionTitle(displayTitle, isActive, state.searchQuery)}</span>${preparing ? html`<span class="shrink-0 text-muted-foreground/60 italic ml-1" style="font-size: 0.8333em;">preparing…</span>` : ""}${mobile ? html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span>${renderSessionTime(session)}` : ""}</div>
			</div>
			${mobile
				? buttons
				: html`<div class="absolute right-0 top-0 bottom-0 flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<span class="group-hover:hidden flex items-center">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions hidden group-hover:flex items-center gap-0">
						${buttons}
					</div>
				</div>`}
		</div>
		${childrenExpanded ? html`${renderLiveDelegates(session.id)}${renderArchivedDelegates(session.id)}` : ""}
	`;
}

/** Render live delegate sessions nested under a parent session. */
function renderLiveDelegates(parentSessionId: string): TemplateResult | string {
	const bypassFilters = !!state.searchQuery.trim();
	const delegates = state.gatewaySessions.filter(s =>
		s.delegateOf === parentSessionId
		&& (state.showArchived || s.status !== "terminated")
		&& passesSidebarFilters(s, s.id === activeSessionId(), bypassFilters));
	if (delegates.length === 0) return "";
	return html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
		${delegates.map(s => s.status === "terminated"
			? html`${renderArchivedSessionRow(s)}${renderArchivedDelegates(s.id)}`
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
	const delegates = state.archivedSessions.filter(s => s.delegateOf === session.id);
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
export function renderArchivedDelegates(parentSessionId: string): TemplateResult | string {
	if (!isArchivedParentExpanded(parentSessionId)) return "";
	const delegates = state.archivedSessions.filter(s => s.delegateOf === parentSessionId);
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

	const buttons = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
			title="Modify">${icon(Pencil, "xs")}</button>
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-destructive/10" : "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"}"
			@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id, { goalId: goalId || undefined, isTeamLead: true }); }}
			title=${`End team${shortcutHint("terminate-session")}`}>${icon(Trash2, "xs")}</button>
	`;

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
			data-nav-id=${tlNavId}
			data-nav-active=${active ? "true" : "false"}
			class="${mobile ? "" : "group relative"} relative flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			style="padding-left:${CHEVRON_W}px;"
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
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
				: html`<div class="absolute right-0 top-0 bottom-0 flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<span class="group-hover:hidden flex items-center">${renderSessionTime(session, active)}</span>
					<div class="sidebar-actions hidden group-hover:flex items-center gap-0">
						${buttons}
					</div>
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
	const goalAgents = state.gatewaySessions.filter(s => (s.goalId === goalId || s.teamGoalId === goalId) && !s.delegateOf);
	const hasTeam = goalAgents.some(s => s.role === "team-lead" && s.status !== "terminated");
	const anyAgentWorking = goalAgents.some(s => s.status === "streaming" || s.status === "busy" || s.isCompacting);
	const allPassed = gs.passed === gs.total;
	const color = !hasTeam ? "#6b7280" : allPassed ? "#22c55e" : anyAgentWorking ? "#3b82f6" : "#7a8ea8";
	const baseStyle = `font-size:0.75em;color:${color};font-weight:600;letter-spacing:-0.02em;white-space:nowrap;`;
	if (gs.verifying && gs.verifyingCount > 0) {
		// Verifying state is always blue — override the base color which may be muted when agents are idle.
		// Clamp the animated numerator because an already-passed gate can be re-signaled
		// and running while the stored pass count is still true in server history.
		const verifyStyle = `font-size:0.75em;color:#3b82f6;font-weight:600;letter-spacing:-0.02em;white-space:nowrap;`;
		const displayed = Math.min(gs.total, gs.passed + gs.verifyingCount);
		return html`<span class="shrink-0" style="${verifyStyle}" title="${gs.passed} of ${gs.total} gates passed — verifying ${gs.verifyingCount}"><span style="opacity:0.7">(</span><span class="gate-blink" style="animation: gate-blink 1.2s ease-in-out infinite">${displayed}</span><span style="opacity:0.7">/${gs.total})</span></span>`;
	}
	if (!allPassed && hasTeam) {
		// Wave animation only when agents are actively working or verifications are running
		if (anyAgentWorking) {
			const label = `(${gs.passed}/${gs.total})`;
			const chars = label.split("");
			const totalDur = 1.2;
			const stagger = totalDur / chars.length;
			return html`<span class="shrink-0 gate-wave" style="${baseStyle}" title="${gs.passed} of ${gs.total} gates passed">${chars.map((ch, i) =>
				html`<span style="animation-delay:${(i * stagger).toFixed(2)}s">${ch}</span>`
			)}</span>`;
		}
		return html`<span class="shrink-0" style="${baseStyle}" title="${gs.passed} of ${gs.total} gates passed">(${gs.passed}/${gs.total})</span>`;
	}
	return html`<span class="shrink-0" style="${baseStyle}" title="${gs.passed} of ${gs.total} gates passed">(${gs.passed}/${gs.total})</span>`;
}

/**
 * Render a small per-gate status icon (check/dot/cross/spinner). Shared
 * between the chat-header `<goal-status-widget>` popover and any other
 * surfaces that need a compact per-gate indicator. Colors mirror the
 * palette used by `renderGateProgressBadge` — green for passed, red for
 * failed, blue for running, muted-foreground for pending.
 */
export function renderGateStatusIcon(status: "pending" | "passed" | "failed" | "running"): TemplateResult {
	switch (status) {
		case "passed":
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="passed"><polyline points="20 6 9 17 4 12"/></svg>`;
		case "failed":
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c47070" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="failed"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		case "running":
			return html`<svg class="shrink-0 animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="running"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
		case "pending":
		default:
			return html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-label="pending" style="color:var(--muted-foreground);opacity:0.6"><circle cx="12" cy="12" r="4"/></svg>`;
	}
}

/** Render a PR icon or gate status badge next to a goal in the sidebar. */
function renderGoalBadge(goalId: string) {
	const gs = state.gateStatusCache.get(goalId);
	const gateBadge = renderGateProgressBadge(goalId);
	const pr = state.prStatusCache.get(goalId);
	// Workflow progress remains the primary status until all gates pass. PR status
	// may replace it only after completion, or for goals with no gate summary.
	if (!pr || (gs && gs.passed !== gs.total)) return gateBadge;

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
	const prIcon = html`<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>`;
	if (pr.url) {
		return html`<a class="shrink-0 flex items-center ${hasConflicts ? "pr-conflict-pulse" : ""}" href=${pr.url} target="_blank" rel="noopener" title=${label} @click=${(e: Event) => e.stopPropagation()}>${prIcon}</a>`;
	}
	return html`<span class="shrink-0 flex items-center ${hasConflicts ? "pr-conflict-pulse" : ""}" title=${label}>${prIcon}</span>`;
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
export function renderGoalGroup(goal: Goal) {
	const mobile = !isDesktop();
	const isExpanded = expandedGoals.has(goal.id);
	// `goalSessions` is the full, unfiltered roster of sessions belonging to this
	// goal. It drives badges, gate counts, `hasActiveTeam`, `isWorkMerged`,
	// `hasActiveSession`, and the on-demand team-agents fetch below — all of
	// which must reflect REAL goal state, not the user's current filter view.
	const goalSessions = state.gatewaySessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf).sort((a, b) => a.createdAt - b.createdAt);
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

	const dashboardBtn = html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); }}
			title="Goal dashboard">${icon(LayoutDashboard, "xs")}</button>
	`;

	const pr = state.prStatusCache.get(goal.id);
	const showArchive = !goal.archived;
	const isWorkMerged = !goal.archived && pr?.state === "MERGED" && !hasActiveTeam;
	const hasActiveSession = goalSessions.some((s) => s.status !== "terminated");
	const reattemptBtn = !hasActiveSession ? html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary" : "hover:bg-secondary text-muted-foreground hover:text-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); startReattempt(goal.id); }}
			title="Re-attempt goal">${icon(RotateCcw, "xs")}</button>
	` : nothing;

	const archiveBtn = showArchive ? html`
		<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary" : "hover:bg-secondary text-muted-foreground hover:text-secondary-foreground"}"
			@click=${(e: Event) => { e.stopPropagation(); deleteGoal(goal.id); }}
			title="Archive goal">${icon(Trash2, "xs")}</button>
	` : nothing;

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
		// Archived members belonging to the live lead
		const archivedForLiveLead = state.showArchived
			? state.archivedSessions.filter(s => s.teamGoalId === goal.id && !s.delegateOf && s.role !== "team-lead" && s.teamLeadSessionId === teamLead.id)
			: [];
		return html`
			${renderTeamLeadRow(teamLead, teamChildren.length + archivedForLiveLead.length, tlExpanded)}
			${tlExpanded ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${teamChildren.map(renderSessionRow)}
					${archivedForLiveLead.map(s => html`
						${renderArchivedSessionRow(s)}
						${renderArchivedDelegates(s.id)}
					`)}
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
				data-nav-id=${goalNavId}
				data-nav-active=${goalNavActive ? "true" : "false"}
				style="padding-left:${HEADER_CHEVRON_W}px;"
				@click=${toggleExpand}
				@dblclick=${!mobile ? () => { if (goal.team) { const tl = goalSessions.find(s => s.role === "team-lead"); if (tl) connectToSession(tl.id, true); } } : null}>
				<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none" style="width:${HEADER_CHEVRON_W}px;font-size: 1.1667em;" title="${isExpanded ? "Collapse goal" : "Expand goal"}">${isExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(GoalIcon, "xs")}</span>
				${goal.setupStatus === "preparing" ? html`<svg class="animate-spin shrink-0" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>` : goal.setupStatus === "error" ? html`<span class="shrink-0" style="color:var(--destructive);font-size:0.8333em;line-height:1;" title="Worktree setup failed">⚠</span>` : ""}
				<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="${mobile ? "font-size: 1.1667em;" : "font-size: 0.8333em;"}">${renderHighlightedText(goal.title, state.searchQuery)}</span>
				${renderGoalBadge(goal.id)}
				${mobile
					? html`${reattemptBtn}${archiveBtn}${dashboardBtn}`
					: html`<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
						${reattemptBtn}${archiveBtn}${dashboardBtn}
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
						const archivedForGoal = state.archivedSessions.filter(s => s.teamGoalId === goal.id && !s.delegateOf);
						const archivedLeads = archivedForGoal.filter(s => s.role === "team-lead");
						const archivedMembers = archivedForGoal.filter(s => s.role !== "team-lead");

						// Map each member to its lead (live or archived) via teamLeadSessionId.
						// All leads: live lead first (if any), then archived leads.
						const allLeads = [...(teamLead ? [teamLead.id] : []), ...archivedLeads.map(s => s.id)];
						const membersOf = (leadId: string) => archivedMembers.filter(m => m.teamLeadSessionId === leadId);
						const mappedIds = new Set(archivedMembers.filter(m => m.teamLeadSessionId && allLeads.includes(m.teamLeadSessionId)).map(m => m.id));
						const unmapped = archivedMembers.filter(m => !mappedIds.has(m.id));

						// Render archived leads, each with their own members
						const renderLeadWithMembers = (lead: GatewaySession, isLast: boolean) => {
							const myMembers = [...membersOf(lead.id), ...(isLast ? unmapped : [])];
							const expanded = isArchivedParentExpanded(lead.id);
							return html`
								${renderArchivedSessionRow(lead, myMembers.length > 0)}
								${renderArchivedDelegates(lead.id)}
								${expanded && myMembers.length > 0 ? html`
									<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
										${myMembers.map(m => html`
											${renderArchivedSessionRow(m)}
											${renderArchivedDelegates(m.id)}
										`)}
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

